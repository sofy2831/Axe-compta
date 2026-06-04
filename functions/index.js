const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const XLSX = require("xlsx");

admin.initializeApp();

setGlobalOptions({
  region: "europe-west9",
  maxInstances: 10,
});

const PRICE_ONE_SHOT = "price_1TeDflRDM80msH4WHpXEAirL";
const PRICE_MONTHLY = "price_1TeDgZRDM80msH4W9UDDkMFd";

exports.createCheckoutSession = onRequest(
  { secrets: ["STRIPE_SECRET_KEY"] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "https://compta.axe-dossier.fr");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      const { uid, closureId, plan, email } = req.body || {};

      if (!uid || !plan || !email) {
        res.status(400).json({ error: "Paramètres manquants." });
        return;
      }

      if (plan === "one-shot" && !closureId) {
        res.status(400).json({ error: "closureId manquant." });
        return;
      }

      const price =
        plan === "monthly"
          ? PRICE_MONTHLY
          : PRICE_ONE_SHOT;

      const session = await stripe.checkout.sessions.create({
        mode: plan === "monthly" ? "subscription" : "payment",
        payment_method_types: ["card"],
        customer_email: email,
        line_items: [
          {
            price,
            quantity: 1,
          },
        ],
        success_url: "https://compta.axe-dossier.fr/merci.html",
        cancel_url: `https://compta.axe-dossier.fr/cloture-resultat.html?id=${closureId || ""}`,
        metadata: {
          uid,
          closureId: closureId || "",
          plan,
        },
      });

      res.json({ url: session.url });
    } catch (error) {
      console.error("createCheckoutSession error:", error);
      res.status(500).json({ error: "Erreur création paiement Stripe." });
    }
  }
);

exports.stripeWebhook = onRequest(
  { secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] },
  async (req, res) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook signature error:", error.message);
      res.status(400).send(`Webhook Error: ${error.message}`);
      return;
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const uid = session.metadata?.uid;
        const closureId = session.metadata?.closureId;
        const plan = session.metadata?.plan;

        if (!uid || !plan) {
          res.status(400).send("Missing metadata");
          return;
        }

        const db = admin.firestore();

        if (plan === "one-shot") {
          if (!closureId) {
            res.status(400).send("Missing closureId");
            return;
          }

          await db
            .collection("users")
            .doc(uid)
            .collection("closures")
            .doc(closureId)
            .set(
              {
                paid: true,
                status: "paid",
                paidAt: admin.firestore.FieldValue.serverTimestamp(),
                stripeSessionId: session.id,
                paymentMode: "one-shot",
              },
              { merge: true }
            );

          await db.collection("users").doc(uid).set(
            {
              plan: "one-shot",
              active: true,
              lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        if (plan === "monthly") {
          await db.collection("users").doc(uid).set(
            {
              plan: "monthly",
              active: true,
              subscriptionActive: true,
              stripeCustomerId: session.customer || null,
              stripeSubscriptionId: session.subscription || null,
              lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      }

      res.status(200).send("ok");
    } catch (error) {
      console.error("Webhook processing error:", error);
      res.status(500).send("Webhook processing error");
    }
  }
);
exports.parseClosureFiles = onRequest(
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "https://compta.axe-dossier.fr");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const { uid, closureId } = req.body || {};

      if (!uid || !closureId) {
        res.status(400).json({ error: "uid ou closureId manquant." });
        return;
      }

      const db = admin.firestore();
      const bucket = admin.storage().bucket();

      const closureRef = db
        .collection("users")
        .doc(uid)
        .collection("closures")
        .doc(closureId);

      const closureSnap = await closureRef.get();

      if (!closureSnap.exists) {
        res.status(404).json({ error: "Clôture introuvable." });
        return;
      }

      const closure = closureSnap.data();
      const balancePath = closure.files?.balance?.storagePath;
      const grandLivrePath = closure.files?.grandLivre?.storagePath;

      async function parseFile(storagePath) {
        if (!storagePath) return [];

        const [buffer] = await bucket.file(storagePath).download();
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        return rows.slice(0, 2000);
      }

      const balanceRows = await parseFile(balancePath);
      const grandLivreRows = await parseFile(grandLivrePath);

      const controls = [];
      const anomalies = [];

      if (balanceRows.length) {
        controls.push({
          type: "balance_loaded",
          label: "Balance chargée",
          count: balanceRows.length
        });
      } else {
        anomalies.push({
          type: "missing_balance",
          label: "Balance absente ou non exploitable",
          level: "warning"
        });
      }

      if (grandLivreRows.length) {
        controls.push({
          type: "grand_livre_loaded",
          label: "Grand livre chargé",
          count: grandLivreRows.length
        });
      } else {
        anomalies.push({
          type: "missing_grand_livre",
          label: "Grand livre absent ou non exploitable",
          level: "warning"
        });
      }

      await closureRef.set(
        {
          balance: balanceRows,
          grandLivre: grandLivreRows,
          controls,
          anomalies,
          aiAnalysis: {
            status: "parsed",
            model: null,
            generatedAt: admin.firestore.FieldValue.serverTimestamp(),
            summary: "Fichiers lus et convertis en données exploitables.",
            warnings: anomalies
          },
          status: "parsed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      res.json({
        ok: true,
        balanceRows: balanceRows.length,
        grandLivreRows: grandLivreRows.length
      });
    } catch (error) {
      console.error("parseClosureFiles error:", error);
      res.status(500).json({ error: "Erreur parsing fichiers." });
    }
  }
);