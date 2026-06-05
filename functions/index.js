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
function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getRowText(row) {
  return normalizeText(Object.values(row).join(" "));
}

function getAmount(row) {
  const keys = Object.keys(row);

  const preferredKeys = keys.filter(k =>
    normalizeText(k).includes("montant") ||
    normalizeText(k).includes("solde") ||
    normalizeText(k).includes("debit") ||
    normalizeText(k).includes("credit")
  );

  const searchKeys = preferredKeys.length ? preferredKeys : keys;

  for (const key of searchKeys) {
    const raw = String(row[key] ?? "")
      .replace(",", ".")
      .replace(/\s/g, "");

    const n = Number(raw);

    if (!Number.isNaN(n) && n !== 0 && Math.abs(n) > 100) {
      return Math.abs(n);
    }
  }

  return 0;
}

function detectLmnpEntries(balanceRows, grandLivreRows) {
  const entries = [];
  const controls = [];
  const anomalies = [];

  const allRows = [...balanceRows, ...grandLivreRows];
  const allText = normalizeText(allRows.map(getRowText).join(" "));

  const hasImmeuble = allText.includes("213") || allText.includes("immeuble");
  const hasAmort = allText.includes("2813") || allText.includes("amortissement");
  const hasEmprunt = allText.includes("164") || allText.includes("emprunt");
  const hasLoyers = allText.includes("706") || allText.includes("loyer");

  if (hasImmeuble) {
    controls.push({
      type: "immobilisation_detected",
      label: "Immobilisation détectée",
      level: "info"
    });
  }

  if (hasEmprunt) {
    controls.push({
      type: "loan_detected",
      label: "Emprunt détecté",
      level: "info"
    });
  }

  if (hasLoyers) {
    controls.push({
      type: "rental_income_detected",
      label: "Loyers détectés",
      level: "info"
    });
  }

  if (hasAmort) {
    const amortRow = balanceRows.find(row => getRowText(row).includes("2813") || getRowText(row).includes("amortissement"));
    const amount = amortRow ? getAmount(amortRow) : 0;

    entries.push({
      label: "Dotation amortissement immeuble",
      debit: "681120",
      credit: "281300",
      amount: amount || "À contrôler",
      justification: "Amortissement immeuble détecté dans la balance LMNP.",
      confidence: amount ? 0.9 : 0.65,
      source: "balance",
      status: "À valider"
    });
  } else if (hasImmeuble) {
    anomalies.push({
      type: "missing_amortissement",
      label: "Immeuble détecté mais aucun amortissement identifié",
      level: "warning"
    });
  }

  if (hasEmprunt) {
    entries.push({
      label: "Intérêts d’emprunt à contrôler",
      debit: "661100",
      credit: "512000",
      amount: "À contrôler",
      justification: "Emprunt détecté. Vérifier les intérêts courus ou charges financières de l’exercice.",
      confidence: 0.6,
      source: "balance/grandLivre",
      status: "À valider"
    });
  }

  return { entries, controls, anomalies };
}
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

      let controls = [];
let anomalies = [];
let entries = [];
      

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

      const detected = detectLmnpEntries(balanceRows, grandLivreRows);

controls = [...controls, ...detected.controls];
anomalies = [...anomalies, ...detected.anomalies];
entries = detected.entries;
      await closureRef.set(
        {
          balance: balanceRows,
grandLivre: grandLivreRows,
controls,
anomalies,
entries,
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
