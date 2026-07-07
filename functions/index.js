const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const XLSX = require("xlsx");

admin.initializeApp();
setGlobalOptions({ region: "europe-west9", maxInstances: 10 });

const PRICE_SOLO_99 = "price_1TiAwkRDM80msH4WqJAFRL8K";
const PRICE_EXPERT_149 = "price_1TiAzmRDM80msH4WG6H7FTAI";
const PRICE_CABINET_399 = "price_1TiB1KRDM80msH4WmQO4gh7K";
const PRICE_EXTRA_COLLAB_129 = "price_1TiB2DRDM80msH4Wu6rhGaVv";
const ALLOWED_ORIGIN = "https://compta.axe-dossier.fr";

function setCors(res, headers = "Content-Type, Authorization") {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", headers);
}

exports.createCheckoutSession = onRequest(
  { secrets: ["STRIPE_SECRET_KEY"] },
  async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const { uid, closureId, plan, email } = req.body || {};

      if (!uid || !plan || !email) {
        return res.status(400).json({ error: "Paramètres manquants." });
      }

      const allowedPlans = ["solo", "expert", "cabinet", "extra-collab"];
      if (!allowedPlans.includes(plan)) {
        return res.status(400).json({ error: "Plan invalide." });
      }

      if (plan === "solo" && !closureId) {
        return res.status(400).json({ error: "closureId manquant." });
      }

      const priceMap = {
        solo: PRICE_SOLO_99,
        expert: PRICE_EXPERT_149,
        cabinet: PRICE_CABINET_399,
        "extra-collab": PRICE_EXTRA_COLLAB_129,
      };

      const mode = plan === "solo" ? "payment" : "subscription";

      const userSnap = await admin.firestore().collection("users").doc(uid).get();
      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const existingCustomerId = userData.stripeCustomerId || null;

      const session = await stripe.checkout.sessions.create({
        mode,
        payment_method_types: ["card"],
        customer: existingCustomerId || undefined,
        customer_email: existingCustomerId ? undefined : email,
        customer_creation: !existingCustomerId && plan === "solo" ? "always" : undefined,
        line_items: [{ price: priceMap[plan], quantity: 1 }],
        success_url: `${ALLOWED_ORIGIN}/merci.html`,
        cancel_url:
          plan === "solo"
            ? `${ALLOWED_ORIGIN}/cloture-resultat.html?id=${encodeURIComponent(closureId || "")}`
            : `${ALLOWED_ORIGIN}/tableau-de-bord.html`,
        metadata: {
          uid,
          closureId: closureId || "",
          plan,
        },
      });

      return res.json({ url: session.url });
    } catch (error) {
      console.error("createCheckoutSession error:", error);
      return res.status(500).json({ error: "Erreur création paiement Stripe." });
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
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    const db = admin.firestore();

    function planFromSubscription(subscription) {
      const items = subscription.items?.data || [];
      const priceIds = items.map(item => item.price?.id).filter(Boolean);

      if (priceIds.includes(PRICE_CABINET_399)) return "cabinet";
      if (priceIds.includes(PRICE_EXPERT_149)) return "expert";
      if (priceIds.includes(PRICE_EXTRA_COLLAB_129)) return "extra-collab";

      return "";
    }

async function findUserBySubscription(subscriptionId) {
  if (!subscriptionId) return null;

  let snap = await db
    .collection("users")
    .where("stripeSubscriptionId", "==", subscriptionId)
    .limit(1)
    .get();

  if (!snap.empty) return snap.docs[0];

  snap = await db
    .collection("users")
    .where("lastExtraCollabSubscriptionId", "==", subscriptionId)
    .limit(1)
    .get();

  if (!snap.empty) return snap.docs[0];

  return null;
}

    async function findUserByCustomer(customerId) {
      if (!customerId) return null;

      const snap = await db
        .collection("users")
        .where("stripeCustomerId", "==", customerId)
        .limit(1)
        .get();

      if (snap.empty) return null;
      return snap.docs[0];
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const uid = session.metadata?.uid;
          const closureId = session.metadata?.closureId;
          const plan = session.metadata?.plan;

          if (!uid || !plan) return res.status(400).send("Missing metadata");

          if (plan === "solo") {
            if (!closureId) return res.status(400).send("Missing closureId");

            await db.collection("users").doc(uid).collection("closures").doc(closureId).set(
              {
                paid: true,
                status: "paid",
                paidAt: admin.firestore.FieldValue.serverTimestamp(),
                stripeSessionId: session.id,
                paymentMode: "solo",
                plan: "solo",
              },
              { merge: true }
            );

            await db.collection("users").doc(uid).set(
              {
                active: true,
                plan: "solo",
                hasSoloPurchase: true,
                subscriptionActive: false,
                paymentStatus: "paid",
                cancelAtPeriodEnd: false,
                stripeCustomerId: session.customer || null,
                lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }

          if (["expert", "cabinet", "extra-collab"].includes(plan)) {
            const userRef = db.collection("users").doc(uid);
            const userSnap = await userRef.get();
            const userData = userSnap.exists ? userSnap.data() || {} : {};

            const updateData = {
              active: true,
              paymentStatus: "paid",
              stripeCustomerId: session.customer || userData.stripeCustomerId || null,
              lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
            };

            if (plan === "expert") {
              updateData.plan = "expert";
              updateData.subscriptionActive = true;
              updateData.stripeSubscriptionId = session.subscription || null;
            }

            if (plan === "cabinet") {
              updateData.plan = "cabinet";
              updateData.subscriptionActive = true;
              updateData.cabinetOwner = true;
              updateData.cabinetMember = false;
              updateData.role = "owner";
              updateData.stripeSubscriptionId = session.subscription || null;
              updateData["cabinetSetup.status"] = "active";
              updateData["cabinetSetup.includedLicenses"] = userData.cabinetSetup?.includedLicenses || 3;
            }

            if (plan === "extra-collab") {
  updateData.plan = "cabinet";
  updateData.subscriptionActive = true;
  updateData.active = true;
  updateData.cabinetOwner = true;
  updateData.extraCollabSubscriptionActive = true;
  updateData.cabinetExtraLicensesPaid = true;
  updateData.cabinetExtraLicenses = admin.firestore.FieldValue.increment(1);
  updateData.lastExtraCollabSubscriptionId = session.subscription || null;
}

            await userRef.set(updateData, { merge: true });
          }

          break;
        }

        case "customer.subscription.updated": {
  const subscription = event.data.object;
  const userDoc = await findUserBySubscription(subscription.id);

  if (!userDoc) {
    console.warn("No user found for subscription:", subscription.id);
    break;
  }

  const plan = planFromSubscription(subscription);
  const isActive = ["active", "trialing"].includes(subscription.status);
  const cancelAtPeriodEnd = subscription.cancel_at_period_end === true || !!subscription.cancel_at;
  const subscriptionEndsAt = subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null;
  const userData = userDoc.data() || {};

  const updatePayload = {
    paymentStatus: cancelAtPeriodEnd ? "cancel_at_period_end" : subscription.status,
    cancelAtPeriodEnd,
    subscriptionEndsAt,
    stripeCustomerId: subscription.customer || userData.stripeCustomerId || null,
    subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (plan === "extra-collab") {
    updatePayload.plan = "cabinet";
    updatePayload.cabinetOwner = true;
    updatePayload.extraCollabSubscriptionActive = isActive;
    updatePayload.cabinetExtraLicensesPaid = isActive;
    updatePayload.lastExtraCollabSubscriptionId = subscription.id;
  } else {
    updatePayload.active = isActive;
    updatePayload.subscriptionActive = isActive;
    updatePayload.plan = plan || userData.plan || "";
    updatePayload.cabinetOwner = (plan || userData.plan) === "cabinet" ? true : userData.cabinetOwner || false;
    updatePayload.stripeSubscriptionId = subscription.id;
  }

  await userDoc.ref.set(updatePayload, { merge: true });

  break;
}

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const userDoc = await findUserBySubscription(subscription.id);

          if (!userDoc) {
            console.warn("No user found for deleted subscription:", subscription.id);
            break;
          }

          const userData = userDoc.data() || {};
          const deletedPlan = planFromSubscription(subscription);

         if (deletedPlan === "extra-collab") {
  await userDoc.ref.set(
    {
      cabinetExtraLicenses: admin.firestore.FieldValue.increment(-1),
      extraCollabSubscriptionActive: false,
      cabinetExtraLicensesPaid: false,
      lastExtraCollabCanceledAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  break;
}

          const fallbackPlan = userData.hasSoloPurchase === true ? "solo" : "";

          await userDoc.ref.set(
            {
              active: fallbackPlan === "solo",
              subscriptionActive: false,
              paymentStatus: "canceled",
              plan: fallbackPlan,
              cabinetOwner: false,
              cancelAtPeriodEnd: false,
              subscriptionEndsAt: null,
              subscriptionCanceledAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;
          const customerId = invoice.customer;

          let userDoc = await findUserBySubscription(subscriptionId);
          if (!userDoc) userDoc = await findUserByCustomer(customerId);

          if (!userDoc) {
            console.warn("No user found for failed invoice:", invoice.id);
            break;
          }

          await userDoc.ref.set(
            {
              active: false,
              subscriptionActive: false,
              paymentStatus: "failed",
              paymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
              lastFailedInvoiceId: invoice.id || "",
            },
            { merge: true }
          );

          break;
        }

        default:
          console.log("Unhandled Stripe event:", event.type);
      }

      return res.status(200).send("ok");
    } catch (error) {
      console.error("Webhook processing error:", error);
      return res.status(500).send("Webhook processing error");
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
  return normalizeText(Object.values(row || {}).join(" "));
}

function getCompte(row) {
  return String(row?.Compte || row?.compte || row?.CompteNum || row?.compteNum || "").replace(/\s/g, "");
}

function getLibelle(row) {
  return String(row?.Libellé || row?.libelle || row?.Libelle || row?.Intitulé || row?.intitule || "ligne grand livre").trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;

  let raw = String(value)
    .replace(/\u00a0/g, " ")
    .trim();

  if (!raw) return 0;

  raw = raw.replace(/\s/g, "");

  if (raw.includes(",") && raw.includes(".")) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else if (raw.includes(",")) {
    raw = raw.replace(",", ".");
  }

  raw = raw.replace(/[^0-9.\-]/g, "");

  const n = Number(raw);
  return Number.isNaN(n) ? 0 : n;
}

function getAmount(row) {
  if (!row) return 0;

  const keys = Object.keys(row);

  const findKey = names => keys.find(k => {
    const nk = normalizeText(k);
    return names.some(name => nk === normalizeText(name) || nk.includes(normalizeText(name)));
  });

  const montantKey = findKey(["montant"]);
  if (montantKey) {
    const n = toNumber(row[montantKey]);
    if (n !== 0) return Math.abs(n);
  }

  const soldeKey = findKey(["solde"]);
  if (soldeKey) {
    const n = toNumber(row[soldeKey]);
    if (n !== 0) return Math.abs(n);
  }

  const debitKey = findKey(["debit", "débit"]);
  const creditKey = findKey(["credit", "crédit"]);

  const debit = debitKey ? toNumber(row[debitKey]) : 0;
  const credit = creditKey ? toNumber(row[creditKey]) : 0;

  if (debit || credit) return Math.abs(debit || credit);

  return 0;
}

function accountStarts(row, prefixes) {
  const compte = getCompte(row);
  return prefixes.some(prefix => compte.startsWith(prefix));
}

function hasAccount(rows, prefixes) {
  return rows.some(row => accountStarts(row, prefixes));
}

function findBalanceRow(balanceRows, prefixes) {
  return balanceRows.find(row => accountStarts(row, prefixes));
}

function findFirstRowByPrefixes(rows, prefixes) {
  return rows.find(row => accountStarts(row, prefixes));
}

function findLedgerRowsByPrefixes(rows, prefixes) {
  return rows.filter(row => accountStarts(row, prefixes));
}

function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = [getCompte(row), getLibelle(row), getAmount(row)].join("|").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function amountByPrefixes(rows, prefixes) {
  return rows.filter(row => accountStarts(row, prefixes)).reduce((sum, row) => sum + (getAmount(row) || 0), 0);
}

function cleanEntryLabel(prefix, row) {
  const raw = getLibelle(row);
  let label = raw
    .replace(/\bfnp\b/gi, "")
    .replace(/\bcca\b/gi, "")
    .replace(/\bpca\b/gi, "")
    .replace(/\bfae\b/gi, "")
    .replace(/\bpar\b/gi, "")
    .replace(/\bcap\b/gi, "")
    .replace(/facture non parvenue/gi, "")
    .replace(/facture non recue/gi, "")
    .replace(/facture à établir/gi, "")
    .replace(/facture a etablir/gi, "")
    .replace(/produit à recevoir/gi, "")
    .replace(/produit a recevoir/gi, "")
    .replace(/charge à payer/gi, "")
    .replace(/charge a payer/gi, "")
    .replace(/charges à payer/gi, "")
    .replace(/charges a payer/gi, "")
    .replace(/dotation amortissement/gi, "")
    .replace(/dotation aux amortissements/gi, "")
    .replace(/extourne/gi, "")
    .replace(/période suivante/gi, "")
    .replace(/periode suivante/gi, "")
    .replace(/période 2023/gi, "")
    .replace(/periode 2023/gi, "")
    .replace(/sortie immobilisation/gi, "")
    .replace(/sortie immo/gi, "")
    .replace(/cession immobilisation/gi, "")
    .replace(/vente immobilisation/gi, "")
    .replace(/mise au rebut/gi, "")
    .replace(/valeur nette comptable/gi, "")
    .replace(/vnc/gi, "")
    .replace(/variation stock matières premières/gi, "")
    .replace(/variation stock matieres premieres/gi, "")
    .replace(/variation stock marchandises/gi, "")
    .replace(/production stockée travaux en cours/gi, "")
    .replace(/production stockee travaux en cours/gi, "")
    .replace(/production stockée produits finis/gi, "")
    .replace(/production stockee produits finis/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[-–—:\s]+/, "")
    .trim();

  if (!label) label = raw || "ligne grand livre";
  return `${prefix} - ${label}`;
}

function makeEntryFromRow(row, config) {
  const entry = {
    journal: config.journal || "OD",
    label: cleanEntryLabel(config.label, row),
    debit: config.debit,
    credit: config.credit,
    amount: config.amount !== undefined ? config.amount : (getAmount(row) || "À contrôler"),
    justification: config.justification,
    confidence: config.confidence || 0.9,
    source: config.source || "grandLivre",
    status: config.status || "À valider",
  };

  if (config.details !== undefined) entry.details = config.details;
  return entry;
}

function makeAnalysisEntry(config) {
  const entry = {
    journal: "ANALYSE",
    label: config.label,
    debit: "—",
    credit: "—",
    amount: config.amount || "À contrôler",
    justification: config.justification,
    confidence: config.confidence || 0.75,
    source: config.source || "analyse",
    status: config.status || "À valider",
  };

  if (config.details !== undefined) entry.details = config.details;
  return entry;
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter(e => {
    const key = [e.journal || "OD", e.label || "", e.debit || "", e.credit || "", e.amount || ""].join("|").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanFirestoreObject(value) {
  if (Array.isArray(value)) return value.map(item => cleanFirestoreObject(item));
  if (value && typeof value === "object") {
    const clean = {};
    Object.keys(value).forEach(key => {
      if (value[key] !== undefined) clean[key] = cleanFirestoreObject(value[key]);
    });
    return clean;
  }
  return value;
}

function getCell(row, names) {
  const keys = Object.keys(row || {});
  for (const key of keys) {
    const normalizedKey = normalizeText(key);
    if (names.some(name => normalizedKey.includes(normalizeText(name)))) return row[key];
  }
  return "";
}

function parseExcelDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
  }

  const raw = String(value).trim();
  const fr = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (fr) return new Date(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]));

  const iso = new Date(raw);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function daysBetween(start, end) {
  const ms = end.getTime() - start.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function findLoanIcne(empruntRows, closureEndDate) {
  const endDate = parseExcelDate(closureEndDate);
  if (!endDate || !empruntRows.length) return null;

  for (const row of empruntRows) {
    const start = parseExcelDate(getCell(row, ["date début période", "date debut periode", "début période", "debut periode"]));
    const due = parseExcelDate(getCell(row, ["date échéance", "date echeance", "échéance", "echeance"]));
    const interest = getAmount({ Montant: getCell(row, ["intérêts", "interets", "intérêt", "interet"]) });

    if (!start || !due || !interest) continue;

    if (start <= endDate && due >= endDate) {
      const periodDays = daysBetween(start, due);
      const elapsedDaysRaw = daysBetween(start, endDate) + 1;
      const elapsedDays = Math.min(elapsedDaysRaw, periodDays);
      if (periodDays <= 0 || elapsedDays <= 0) return null;

      const prorata = Math.min(elapsedDays / periodDays, 1);
      const icne = +(interest * prorata).toFixed(2);

      return {
        icne,
        interest,
        start,
        due,
        periodDays,
        elapsedDays,
        bank: getCell(row, ["banque"]) || "",
        reference: getCell(row, ["référence", "reference"]) || "",
        capitalRemaining: getAmount({ Montant: getCell(row, ["capital restant dû", "capital restant du"]) }),
      };
    }
  }

  return null;
}

function getAssetNameFromText(row) {
  const raw = getLibelle(row);
  const label = raw
    .replace(/cession immobilisation/gi, "")
    .replace(/vente immobilisation/gi, "")
    .replace(/sortie immobilisation/gi, "")
    .replace(/vnc sortie immobilisation/gi, "")
    .replace(/vnc/gi, "")
    .replace(/mise au rebut/gi, "")
    .replace(/^[-–—:\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return label || "immobilisation à identifier";
}

function findAssetRow(amortissementRows, assetName) {
  const needle = normalizeText(assetName);
  return amortissementRows.find(row => needle && getRowText(row).includes(needle));
}

function getAssetValue(row, keywords) {
  if (!row) return 0;
  for (const key of Object.keys(row)) {
    const nk = normalizeText(key);
    if (keywords.some(k => nk.includes(normalizeText(k)))) {
      const n = toNumber(row[key]);
      if (!Number.isNaN(n) && n !== 0) return Math.abs(n);
    }
  }
  return 0;
}

function detectPayrollRate(balanceRows, grandLivreRows) {
  const rows = [...balanceRows, ...grandLivreRows];
  const salaries = amountByPrefixes(rows, ["641"]);
  const socialCharges = amountByPrefixes(rows, ["645"]);
  if (!salaries || !socialCharges) return null;
  const rate = socialCharges / salaries;
  return rate > 0 && rate <= 1 ? rate : null;
}

function formatEuro(value) {
  if (typeof value !== "number") return value || "?";
  return `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function getUserContext(details, usefulInfo, keys = []) {
  const parts = [];

  keys.forEach(key => {
    if (details[key] && details[key].trim()) {
      parts.push(`Précision utilisateur (${key}) :\n${details[key].trim()}`);
    }
  });

  if (!parts.length) return "";

  return "\n\nInformations fournies par l'utilisateur :\n\n" + parts.join("\n\n");
}
function answerYes(answers, key) {
  return answers?.[key] === "yes" || answers?.[key] === true;
}

function isLeasingRow(row) {
  const compte = getCompte(row);
  const text = getRowText(row);
  return (
    compte.startsWith("612") ||
    text.includes("credit bail") ||
    text.includes("crédit bail") ||
    text.includes("leasing") ||
    text.includes("loyer vehicule") ||
    text.includes("loyer véhicule") ||
    text.includes("photocopieur") ||
    text.includes("location materiel") ||
    text.includes("location matériel")
  );
}

function detectPayroll(balanceRows, grandLivreRows, entries, controls, answers = {}, details = {}) {
  const allRows = [...balanceRows, ...grandLivreRows];
  const hasPayrollAccounts = hasAccount(allRows, ["421", "428", "431", "437", "438", "641", "645"]);
  if (!hasPayrollAccounts && answers.paie !== "yes") return;

  const payrollRows = uniqueRows(allRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);
    return (
      compte.startsWith("421") || compte.startsWith("428") || compte.startsWith("431") ||
      compte.startsWith("437") || compte.startsWith("438") || compte.startsWith("641") ||
      compte.startsWith("645") || text.includes("paie") || text.includes("salaire") ||
      text.includes("conges payes") || text.includes("congés payés") || text.includes("urssaf")
    );
  }));

  const amount428 = amountByPrefixes(allRows, ["428"]);
  const amount438 = amountByPrefixes(allRows, ["438"]);
  const salaries = amountByPrefixes(allRows, ["641"]);
  const socialCharges = amountByPrefixes(allRows, ["645"]);
  const payrollRate = salaries && socialCharges ? socialCharges / salaries : null;

  if (amount428) {
    entries.push({
      journal: "OD",
      label: "Congés payés à payer - charge salariale",
      debit: "641000",
      credit: "428200",
      amount: amount428,
      justification: "Compte 428 détecté : congés payés ou éléments de paie à rattacher à l'exercice.",
      confidence: 0.85,
      source: "balance/grandLivre",
      status: "À valider",
    });
  }

  if (amount438) {
    entries.push({
      journal: "OD",
      label: "Charges sociales à payer",
      debit: "645000",
      credit: "438600",
      amount: amount438,
      justification: "Compte 438 détecté : charges sociales à payer à rattacher à la clôture.",
      confidence: 0.85,
      source: "balance/grandLivre",
      status: "À valider",
    });
  } else if (amount428 && payrollRate && payrollRate > 0 && payrollRate <= 1) {
    const socialAmount = Math.round(amount428 * payrollRate * 100) / 100;
    entries.push({
      journal: "OD",
      label: "Charges sociales sur congés payés",
      debit: "645000",
      credit: "438600",
      amount: socialAmount,
      justification: `Charges sociales estimées à partir du taux historique détecté : ${Math.round(payrollRate * 100)} %.`,
      confidence: 0.75,
      source: "balance/grandLivre",
      status: "À valider",
    });
  }

  entries.push(makeAnalysisEntry({
    label: "Analyse paie / charges sociales",
    amount: (amount428 || 0) + (amount438 || 0) + (socialCharges || 0) + (salaries || 0) || "À contrôler",
    justification:
`Paie et charges sociales détectées.

Salaires / compte 641 : ${formatEuro(salaries)}
Charges sociales / compte 645 : ${formatEuro(socialCharges)}
Personnel - charges à payer / compte 428 : ${formatEuro(amount428)}
Organismes sociaux - charges à payer / compte 438 : ${formatEuro(amount438)}

Contrôles à effectuer :
- rapprocher les montants du journal de paie ;
- contrôler les congés payés à payer ;
- vérifier les charges sociales rattachées ;
- vérifier les comptes 421, 428, 431, 437 et 438 avant validation définitive.`,
    confidence: 0.8,
    source: "balance/grandLivre",
    details: payrollRows.map(row => ({ compte: getCompte(row), libelle: getLibelle(row), amount: getAmount(row) || 0 })),
  }));

  controls.push({ type: "payroll_detected", label: "Paie et charges sociales détectées", level: "info" });
}

function detectSubventions(balanceRows, grandLivreRows, entries, controls, details = {}, usefulInfo = "") {
  const userContext = getUserContext(details, "", []);
  const allRows = [...balanceRows, ...grandLivreRows];
  if (!hasAccount(allRows, ["131", "139", "777"])) return;

  const subventionRows = uniqueRows(allRows.filter(row => accountStarts(row, ["131"])));
  const repriseRows = uniqueRows(allRows.filter(row => accountStarts(row, ["139"])));
  const quotePartRows = uniqueRows(allRows.filter(row => accountStarts(row, ["777"])));

  const subventionAmount = subventionRows.reduce((s, r) => s + getAmount(r), 0);
  const repriseAmount = repriseRows.reduce((s, r) => s + getAmount(r), 0);
  const quotePartAmount = quotePartRows.reduce((s, r) => s + getAmount(r), 0);
  const diff = Math.abs((repriseAmount || 0) - (quotePartAmount || 0));

  let statusText = "Subvention d'investissement détectée.";
  let recommendation = "Vérifier le plan de reprise de la subvention et la cohérence avec l'amortissement de l'immobilisation financée.";
  let retainedAmount = quotePartAmount || repriseAmount || "À calculer";
  let confidence = 0.75;

  if (repriseAmount && quotePartAmount && diff <= 1) {
    statusText = "Quote-part de subvention déjà comptabilisée et cohérente.";
    recommendation = "Aucune écriture automatique supplémentaire n'est proposée. Contrôler uniquement le plan de reprise et l'annexe si nécessaire.";
    confidence = 0.9;
  } else if (repriseAmount && !quotePartAmount) {
    statusText = "Compte 139 détecté sans compte 777 correspondant.";
    recommendation = "Une quote-part au résultat semble à compléter : écriture proposée 139 / 777.";
    entries.push({
      journal: "OD",
      label: "Quote-part subvention à virer au résultat",
      debit: "139000",
      credit: "777000",
      amount: repriseAmount,
      justification: `Compte 139 détecté sans compte 777 correspondant. Proposition de comptabilisation de la quote-part de subvention au résultat.${userContext}`,
      confidence: 0.75,
      source: "analyse",
      status: "À valider",
    });
  } else if (!repriseAmount && quotePartAmount) {
    statusText = "Compte 777 détecté sans reprise 139 correspondante.";
    recommendation = "Une reprise de subvention doit être rapprochée du compte 139. Écriture proposée 139 / 777 à valider avec le plan de reprise.";
    entries.push({
      journal: "OD",
      label: "Reprise subvention à rapprocher du 777",
      debit: "139000",
      credit: "777000",
      amount: quotePartAmount,
      justification: `Compte 777 détecté sans compte 139 correspondant. Proposition à valider avec le plan de reprise de la subvention.${userContext}`,
      confidence: 0.7,
      source: "analyse",
      status: "À valider",
    });
  } else if (subventionAmount && !repriseAmount && !quotePartAmount) {
    statusText = "Subvention inscrite en 131 sans quote-part détectée.";
    recommendation = "Aucune écriture chiffrée fiable ne peut être générée sans plan de reprise. Calculer la quote-part selon le rythme d'amortissement du bien financé.";
    confidence = 0.6;
  } else if (repriseAmount && quotePartAmount && diff > 1) {
    statusText = "Écart détecté entre 139 et 777.";
    recommendation = `Écart à contrôler : ${formatEuro(diff)}. Vérifier le plan de reprise et les mouvements comptabilisés.`;
    retainedAmount = Math.max(repriseAmount, quotePartAmount);
    confidence = 0.65;
  }

  entries.push(makeAnalysisEntry({
    label: "Analyse subvention d'investissement",
    amount: retainedAmount,
    justification:
`Subvention d'investissement détectée.

Compte 131 - Subvention d'investissement : ${formatEuro(subventionAmount)}
Compte 139 - Subvention inscrite au résultat : ${formatEuro(repriseAmount)}
Compte 777 - Quote-part virée au résultat : ${formatEuro(quotePartAmount)}

Diagnostic : ${statusText}

Recommandation : ${recommendation}${userContext}`,
    confidence,
    source: "balance/grandLivre",
    details: [
      ...subventionRows.map(r => ({ compte: getCompte(r), libelle: getLibelle(r), amount: getAmount(r) })),
      ...repriseRows.map(r => ({ compte: getCompte(r), libelle: getLibelle(r), amount: getAmount(r) })),
      ...quotePartRows.map(r => ({ compte: getCompte(r), libelle: getLibelle(r), amount: getAmount(r) })),
    ],
  }));

  controls.push({ type: "subvention_detected", label: "Subvention d'investissement détectée", level: "info" });
}

function detectLeasing(balanceRows, grandLivreRows, entries, controls, details = {}, usefulInfo = "") {
  const userContext = getUserContext(details, "", ["immo", "cca"]);
  const allRows = [...balanceRows, ...grandLivreRows];

  const leasingRows = uniqueRows(allRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);

 const leasingKeyword =
    text.includes("credit bail") ||
    text.includes("crédit bail") ||
    text.includes("leasing") ||
    text.includes("loyer vehicule") ||
    text.includes("loyer véhicule") ||
    text.includes("photocopieur") ||
    text.includes("location materiel") ||
    text.includes("location matériel") ||
    text.includes("levee option") ||
    text.includes("levée option") ||
    text.includes("rachat option");

     return leasingKeyword && (
    compte.startsWith("612") ||
    compte.startsWith("486") ||
    compte.startsWith("408") ||
    compte.startsWith("218") ||
    compte.startsWith("404")
  );
}));
   

  if (!leasingRows.length) return;

  const leasingDetails = [];

  leasingRows.forEach(row => {
    const compte = getCompte(row);
    const text = getRowText(row);
    const amount = getAmount(row) || "À contrôler";
    let caseLabel = "Loyer de crédit-bail / leasing constaté en charge";
    let recommendation = "Aucune écriture de clôture automatique n'est proposée si le loyer concerne uniquement l'exercice. Contrôler le contrat, la période couverte et l'annexe.";

    const hasCca = compte.startsWith("486") || text.includes("cca") || text.includes("charge constatee") || text.includes("periode suivante");
    const hasFnp = compte.startsWith("408") || text.includes("fnp") || text.includes("facture non parvenue") || text.includes("loyer non facture");
    const hasOption = text.includes("levee option") || text.includes("levée option") || text.includes("rachat option") || text.includes("option achat");

    if (hasCca) {
      caseLabel = "Crédit-bail avec charge constatée d'avance";
      recommendation = "Écriture proposée : débit 486 / crédit 612 pour la part de loyer concernant l'exercice suivant.";
      entries.push(makeEntryFromRow(row, {
        label: "CCA crédit-bail",
        debit: "486000",
        credit: "612000",
        justification: `Loyer de crédit-bail couvrant une période postérieure à la clôture : charge constatée d'avance à comptabiliser.${userContext}`,
        confidence: 0.85,
      }));
    } else if (hasFnp) {
      caseLabel = "Crédit-bail avec facture non parvenue";
      recommendation = "Écriture proposée : débit 612 / crédit 408 pour rattacher le loyer à l'exercice.";
      entries.push(makeEntryFromRow(row, {
        label: "FNP crédit-bail",
        debit: "612000",
        credit: "408100",
        justification: `Loyer de crédit-bail relatif à l'exercice, mais facture non parvenue : charge à rattacher à la clôture.${userContext}`,
        confidence: 0.85,
      }));
    } else if (hasOption) {
      caseLabel = "Levée d'option de crédit-bail";
      recommendation = "Écriture proposée : débit 218 / crédit 404 pour immobiliser le bien acquis à la levée d'option.";
      entries.push(makeEntryFromRow(row, {
        label: "Levée option crédit-bail",
        debit: "218000",
        credit: "404000",
        justification: `Levée d'option détectée : le bien doit être immobilisé au prix de rachat, sous réserve du justificatif.${userContext}`,
        confidence: 0.8,
      }));
    }

    leasingDetails.push({ compte, libelle: getLibelle(row), amount, caseLabel, recommendation });
  });

  entries.push(makeAnalysisEntry({
    label: "Analyse crédit-bail / leasing",
    amount: leasingDetails.reduce((s, d) => s + (typeof d.amount === "number" ? d.amount : 0), 0) || "À contrôler",
    justification:
`Crédit-bail / leasing détecté.

Diagnostic automatisé :
${leasingDetails.map(d => `- ${d.compte || "?"} | ${d.libelle} | ${formatEuro(d.amount)} | ${d.caseLabel}`).join("\n")}

Règles appliquées :
- loyer simple en 612 : aucune écriture de clôture si la période est correctement rattachée ;
- CCA : débit 486 / crédit 612 ;
- FNP : débit 612 / crédit 408 ;
- levée d'option : débit 218 / crédit 404.

Contrôler le contrat, la période couverte, l'option d'achat et les informations à mentionner en annexe.${userContext}`,
    confidence: 0.8,
    source: "balance/grandLivre",
    details: leasingDetails,
  }));

  controls.push({ type: "leasing_detected", label: "Crédit-bail ou leasing détecté", level: "info" });
}

function detectExchangeDifferences(balanceRows, grandLivreRows, entries, controls, details = {}, usefulInfo = "") {
  const userContext = "";
  const allRows = [...balanceRows, ...grandLivreRows];
  if (!hasAccount(allRows, ["476", "477", "666", "766"])) return;

  const rows476 = uniqueRows(allRows.filter(row => accountStarts(row, ["476"])));
  const rows477 = uniqueRows(allRows.filter(row => accountStarts(row, ["477"])));
  const rows666 = uniqueRows(allRows.filter(row => accountStarts(row, ["666"])));
  const rows766 = uniqueRows(allRows.filter(row => accountStarts(row, ["766"])));

  const amount476 = rows476.reduce((s, r) => s + getAmount(r), 0);
  const amount477 = rows477.reduce((s, r) => s + getAmount(r), 0);
  const amount666 = rows666.reduce((s, r) => s + getAmount(r), 0);
  const amount766 = rows766.reduce((s, r) => s + getAmount(r), 0);

  const hasProvisionExchangeLoss = hasAccount(allRows, ["1515", "6865"]);

  if (amount476 && !hasProvisionExchangeLoss) {
    entries.push({
      journal: "OD",
      label: "Provision pour perte de change latente",
      debit: "686500",
      credit: "151500",
      amount: amount476,
      justification: `Différence de conversion actif détectée en 476 : une provision pour perte de change latente doit être contrôlée et éventuellement comptabilisée.${userContext}`,
      confidence: 0.75,
      source: "analyse",
      status: "À valider",
    });
  }

  entries.push(makeAnalysisEntry({
    label: "Analyse écarts de change",
    amount: (amount476 || 0) + (amount477 || 0) + (amount666 || 0) + (amount766 || 0) || "À contrôler",
    justification:
`Écarts de change détectés.

Compte 476 - Différences de conversion actif : ${formatEuro(amount476)}
Compte 477 - Différences de conversion passif : ${formatEuro(amount477)}
Compte 666 - Pertes de change réalisées : ${formatEuro(amount666)}
Compte 766 - Gains de change réalisés : ${formatEuro(amount766)}

Analyse :
${amount476 ? "- Perte latente détectée : provision 6865 / 1515 à contrôler si elle n'est pas déjà comptabilisée.\n" : ""}${amount477 ? "- Gain latent détecté : en principe pas de produit à constater, contrôle de l'extourne N+1.\n" : ""}${amount666 || amount766 ? "- Écart de change réalisé détecté : contrôler le rattachement et les justificatifs bancaires/fournisseurs/clients.\n" : ""}
Axe Compta IA propose uniquement les écritures nécessaires lorsque l'information est suffisamment exploitable.${userContext}`,
    confidence: amount476 || amount477 ? 0.8 : 0.75,
    source: "balance/grandLivre",
    details: [
      ...rows476.map(r => ({ compte: getCompte(r), libelle: getLibelle(r), amount: getAmount(r) })),
      ...rows477.map(r => ({ compte: getCompte(r), libelle: getLibelle(r), amount: getAmount(r) })),
      ...rows666.map(r => ({ compte: getCompte(r), libelle: getLibelle(r), amount: getAmount(r) })),
      ...rows766.map(r => ({ compte: getCompte(r), libelle: getLibelle(r), amount: getAmount(r) })),
    ],
  }));

  controls.push({ type: "exchange_difference_detected", label: "Écart de change détecté", level: amount476 ? "warning" : "info" });
}

function detectAccountingEntries(balanceRows, grandLivreRows, amortissementRows = [], empruntRows = [], closure = {}) {
  const entries = [];
  const controls = [];
  const anomalies = [];
  const answers = closure.answers || {};
  const details = closure.details || {};
  const usefulInfo = closure.notes || "";
  const userContext = "";
  const activity = normalizeText(closure.activity || "");
  const allRows = [...balanceRows, ...grandLivreRows];

  const hasAcc = prefixes => hasAccount(allRows, prefixes);
  const getBalanceAmount = prefixes => {
    const row = findBalanceRow(balanceRows, prefixes);
    return row ? getAmount(row) : 0;
  };

  if (hasAcc(["21", "28"])) controls.push({ type: "immobilisation_detected", label: "Immobilisation ou amortissement détecté", level: "info" });
  if (hasAcc(["164", "661"])) controls.push({ type: "loan_detected", label: "Emprunt ou intérêts détectés", level: "info" });
  if (hasAcc(["706", "707"])) controls.push({ type: "revenue_detected", label: "Chiffre d'affaires détecté", level: "info" });

  // FNP
  if (hasAcc(["408"]) && (answerYes(answers, "fournisseurs") || hasAcc(["408"]))) {
    const fnpRows = grandLivreRows.filter(row => {
  const compte = getCompte(row);
  const text = getRowText(row);
  if (isLeasingRow(row)) return false;
  return compte.startsWith("6") && (text.includes("fnp") || text.includes("facture non parvenue") || text.includes("facture non recue"));
});

    if (fnpRows.length) {
      fnpRows.forEach(row => entries.push(makeEntryFromRow(row, {
        label: "FNP",
        debit: "607000",
        credit: "408100",
        justification: `Facture fournisseur non parvenue détectée dans le grand livre.${userContext}`,
        confidence: 0.9,
      })));
    } else {
      entries.push({ journal: "OD", label: "FNP", debit: "607000", credit: "408100", amount: getBalanceAmount(["408"]) || "À contrôler", justification: `Compte 408 détecté : facture fournisseur non parvenue à vérifier.${userContext}`, confidence: 0.85, source: "balance", status: "À valider" });
    }
  }


  // CCA
  if (hasAcc(["486"]) && (answerYes(answers, "cca") || hasAcc(["486"]))) {
    const ccaRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("486") && (text.includes("cca") || text.includes("charge constatee") || text.includes("charges constatees") || text.includes("periode suivante") || text.includes("periode 2023"));
    });

    if (ccaRows.length) {
      ccaRows.forEach(row => entries.push(makeEntryFromRow(row, { label: "CCA", debit: "486000", credit: "616000", justification: `Charge constatée d'avance détectée dans le grand livre.${userContext}`, confidence: 0.9 })));
    } else {
      entries.push({ journal: "OD", label: "CCA", debit: "486000", credit: "616000", amount: getBalanceAmount(["486"]) || "À contrôler", justification: `Compte 486 détecté : charge couvrant une période postérieure à la clôture.${userContext}`, confidence: 0.85, source: "balance", status: "À valider" });
    }
  }

  // PCA
  if (hasAcc(["487"]) && (answerYes(answers, "cca") || hasAcc(["487"]))) {
    const pcaRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("487") || text.includes("pca") || text.includes("produit constate") || text.includes("produits constates");
    });

    if (pcaRows.length) {
      pcaRows.filter(row => getCompte(row).startsWith("487")).forEach(row => entries.push(makeEntryFromRow(row, { label: "PCA", debit: "706000", credit: "487000", justification: `Produit constaté d'avance détecté dans le grand livre.${userContext}`, confidence: 0.9 })));
    } else {
      entries.push({ journal: "OD", label: "PCA", debit: "706000", credit: "487000", amount: getBalanceAmount(["487"]) || "À contrôler", justification: `Compte 487 détecté : produit rattaché à l'exercice suivant.${userContext}`, confidence: 0.85, source: "balance", status: "À valider" });
    }
  }

  // FAE
  if (hasAcc(["418"]) && (answerYes(answers, "clients") || hasAcc(["418"]))) {
    const faeRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("4181") || text.includes("fae") || text.includes("facture a etablir") || text.includes("facture à établir");
    });

    if (faeRows.length) {
      faeRows.forEach(row => entries.push(makeEntryFromRow(row, { label: "FAE", debit: "418100", credit: "706000", justification: `Facture à établir détectée dans le grand livre. Vérifier le montant et le rattachement à l'exercice.${userContext}`, confidence: 0.9 })));
    } else {
      entries.push({ journal: "OD", label: "FAE", debit: "418100", credit: "706000", amount: getBalanceAmount(["4181"]) || "À contrôler", justification: `Compte 418100 détecté : facture à établir à vérifier.${userContext}`, confidence: 0.85, source: "balance", status: "À valider" });
    }
  }

  // PAR
  if (hasAcc(["4187", "4687"]) && (answerYes(answers, "clients") || hasAcc(["4187", "4687"]))) {
    const parRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("4187") || compte.startsWith("4687") || text.includes("produit a recevoir") || text.includes("produits a recevoir") || text.includes("produit à recevoir") || text.includes("produits à recevoir");
    });

    if (parRows.length) {
      parRows.forEach(row => {
        const compte = getCompte(row);
        entries.push(makeEntryFromRow(row, { label: "PAR", debit: compte.startsWith("4687") ? "468700" : "418700", credit: "706000", justification: `Produit à recevoir détecté dans le grand livre. Vérifier le rattachement à l'exercice.${userContext}`, confidence: 0.9 }));
      });
    } else {
      entries.push({ journal: "OD", label: "PAR", debit: "418700", credit: "706000", amount: getBalanceAmount(["4187", "4687"]) || "À contrôler", justification: `Produit à recevoir détecté dans la balance. Vérifier le justificatif.${userContext}`, confidence: 0.85, source: "balance", status: "À valider" });
    }
  }

  // CAP hors FNP et paie
  if (answerYes(answers, "fournisseurs") || hasAcc(["448", "4686"])) {
   const capRows = grandLivreRows.filter(row => {
  const compte = getCompte(row);
  const text = getRowText(row);

  const isCapAccount = compte.startsWith("448") || compte.startsWith("4686");
  const isCapText =
    text.includes("cap") ||
    text.includes("charge a payer") ||
    text.includes("charge à payer") ||
    text.includes("charges a payer") ||
    text.includes("charges à payer");

  if (isLeasingRow(row)) return false;
  if (compte.startsWith("428") || compte.startsWith("438")) return false;

  return isCapAccount || isCapText;
}); 

    capRows.forEach(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      if (compte.startsWith("428") || compte.startsWith("438") || text.includes("conges payes") || text.includes("congés payés") || text.includes("cotisations conges") || text.includes("cotisations congés")) return;

      let debit = "628000";
      let credit = compte || "468600";
      if (text.includes("honoraire") || text.includes("avocat") || text.includes("comptable")) debit = "622600";
      if (text.includes("assurance")) debit = "616000";
      if (text.includes("edf") || text.includes("electricite") || text.includes("électricité")) debit = "606100";
      if (text.includes("urssaf") || text.includes("social")) debit = "645000";
      if (compte.startsWith("448") || text.includes("cfe") || text.includes("taxe") || text.includes("fonciere") || text.includes("foncière")) debit = "635000";

      entries.push(makeEntryFromRow(row, { label: "CAP", debit, credit, justification: `Charge à payer détectée dans le grand livre. Vérifier la facture ou l'avis correspondant.${userContext}`, confidence: 0.85 }));
    });
  }

  // Stocks
  if (answers.stocks === "yes") {
    const stockConfigs = [
      { prefixes: ["6031"], label: "Variation stock matières premières", debit: "310000", credit: "603100" },
      { prefixes: ["6037"], label: "Variation stock marchandises", debit: "370000", credit: "603700" },
      { prefixes: ["7133"], label: "Production stockée travaux en cours", debit: "330000", credit: "713300" },
      { prefixes: ["7135"], label: "Production stockée produits finis", debit: "350000", credit: "713500" },
    ];

    let stockFound = false;
    stockConfigs.forEach(config => {
      grandLivreRows.filter(row => config.prefixes.some(prefix => getCompte(row).startsWith(prefix))).forEach(row => {
        stockFound = true;
        entries.push({ journal: "OD", label: cleanEntryLabel(config.label, row), debit: config.debit, credit: config.credit, amount: getAmount(row) || "À contrôler", justification: `Variation de stock détectée dans le grand livre.${userContext}`, confidence: 0.9, source: "grandLivre", status: "À valider" });
      });
    });

    if (!stockFound) anomalies.push({ type: "stock_not_found", label: "Stock déclaré mais aucune variation de stock exploitable détectée", level: "warning" });
  }

  // Amortissements
  if (hasAcc(["281", "681"]) && answers.immo === "yes") {
    const amortRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("6811") || compte.startsWith("68112") || text.includes("dotation amortissement") || text.includes("dotation aux amortissements");
    });

    if (amortRows.length) {
      amortRows.filter(row => getCompte(row).startsWith("681")).forEach(row => {
        const credit = activity.includes("location meuble") ? "281300" : "281830";
        entries.push(makeEntryFromRow(row, { label: "Dotation amortissement", debit: "681120", credit, justification: `Dotation amortissement détectée dans le grand livre. Vérifier le tableau d'amortissement.${userContext}`, confidence: 0.9 }));
      });
    } else {
      const amortRow = findBalanceRow(balanceRows, ["681"]) || findBalanceRow(balanceRows, ["281"]);
      const amount = amortRow ? getAmount(amortRow) : 0;
      const credit = activity.includes("location meuble") ? "281300" : "281830";
      entries.push({ journal: "OD", label: "Dotation amortissement", debit: "681120", credit, amount: amount || "À contrôler", justification: `Amortissement détecté dans la balance. Vérifier le tableau d'amortissement.${userContext}`, confidence: amount ? 0.9 : 0.65, source: "balance", status: "À valider" });
    }
  }

  detectSubventions(balanceRows, grandLivreRows, entries, controls, details, usefulInfo);
  detectLeasing(balanceRows, grandLivreRows, entries, controls, details, usefulInfo);
  detectExchangeDifferences(balanceRows, grandLivreRows, entries, controls, details, usefulInfo);

  // Comptes courants 455
  if (hasAcc(["455"])) {
    const associateRows = uniqueRows(allRows.filter(row => getCompte(row).startsWith("455")));
    const totalAssociate = associateRows.reduce((s, r) => s + getAmount(r), 0);
    entries.push(makeAnalysisEntry({
      label: "Comptes courants d'associés",
      amount: totalAssociate || "À contrôler",
      justification:
`Comptes courants d'associés détectés.

Nombre de ligne(s) : ${associateRows.length}
Montant cumulé : ${formatEuro(totalAssociate)}

Contrôles à effectuer :
- vérifier que le solde est justifié ;
- contrôler les apports et remboursements ;
- vérifier les intérêts éventuellement comptabilisés ;
- documenter tout solde débiteur.${userContext}`,
      confidence: 0.75,
      source: "balance/grandLivre",
      details: associateRows.map(row => ({ compte: getCompte(row), libelle: getLibelle(row), amount: getAmount(row) || 0 })),
    }));
    controls.push({ type: "associate_current_account_detected", label: "Compte courant d'associé détecté", level: "info" });
  }

  // Comptes d'attente 471/472
  if (hasAcc(["471", "472"])) {
    const waitingRows = uniqueRows(allRows.filter(row => {
      const compte = getCompte(row);
      return compte.startsWith("471") || compte.startsWith("472");
    }));
    const totalWaiting = waitingRows.reduce((total, row) => total + (getAmount(row) || 0), 0);

    entries.push(makeAnalysisEntry({
      label: "Comptes d'attente",
      amount: totalWaiting || "À contrôler",
      justification:
`Comptes d'attente détectés.

Nombre de mouvements : ${waitingRows.length}
Montant cumulé : ${formatEuro(totalWaiting)}

Contrôles à effectuer :
- identifier l'origine des soldes ;
- régulariser avant clôture si possible ;
- vérifier l'absence d'anciens mouvements ;
- contrôler qu'il ne s'agit pas d'erreurs d'imputation.
Cliquer sur « Voir » pour afficher le détail des mouvements.`,
      confidence: 0.85,
      source: "balance/grandLivre",
      details: waitingRows.map(row => ({ compte: getCompte(row), libelle: getLibelle(row), amount: getAmount(row) || 0 })),
    }));
    controls.push({ type: "waiting_account_detected", label: "Compte d'attente détecté", level: "warning" });
  }

  // Immobilisations en cours 23
  if (hasAcc(["23"])) {
    const constructionRows = uniqueRows(allRows.filter(row => getCompte(row).startsWith("23")));
    const totalConstruction = constructionRows.reduce((total, row) => total + (getAmount(row) || 0), 0);

    entries.push(makeAnalysisEntry({
      label: "Immobilisations en cours",
      amount: totalConstruction || "À contrôler",
      justification:
`Immobilisations en cours détectées.

Nombre de ligne(s) : ${constructionRows.length}
Montant cumulé : ${formatEuro(totalConstruction)}

Contrôles à effectuer :
- vérifier si les immobilisations sont toujours en cours à la clôture ;
- transférer en compte 21 si le bien est mis en service ;
- vérifier l'absence d'amortissement avant mise en service ;
- rapprocher les montants des factures et situations de travaux.`,
      confidence: 0.85,
      source: "balance/grandLivre",
      details: constructionRows.map(row => ({ compte: getCompte(row), libelle: getLibelle(row), amount: getAmount(row) || 0 })),
    }));
    controls.push({ type: "construction_in_progress_detected", label: "Immobilisation en cours détectée", level: "info" });
  }

  // Sorties d'immobilisations
  if (answers.immo === "yes") {
    const cessionRows = findLedgerRowsByPrefixes(grandLivreRows, ["775"]);
    const vncRows = findLedgerRowsByPrefixes(grandLivreRows, ["675"]);

    cessionRows.forEach(cessionRow => {
      const assetName = getAssetNameFromText(cessionRow);
      const cessionAmount = getAmount(cessionRow);
      const relatedVncRow = vncRows.find(row => getRowText(row).includes(normalizeText(assetName))) || vncRows[0];
      const vncAmount = relatedVncRow ? getAmount(relatedVncRow) : 0;
      const assetRow = findAssetRow(amortissementRows, assetName);

      const bruteRow = balanceRows.find(row => accountStarts(row, ["21"]) && getRowText(row).includes(normalizeText(assetName))) || findBalanceRow(balanceRows, ["21"]);
      const amortRow = balanceRows.find(row => accountStarts(row, ["28"]) && getRowText(row).includes(normalizeText(assetName))) || findBalanceRow(balanceRows, ["28"]);

      const bruteAmount = getAssetValue(assetRow, ["brut", "valeur brute", "acquisition"]) || (bruteRow ? getAmount(bruteRow) : 0);
      const amortAmount = getAssetValue(assetRow, ["amortissement", "amortissements cumulés", "cumule"]) || (amortRow ? getAmount(amortRow) : 0);
      const calculatedVnc = getAssetValue(assetRow, ["vnc", "valeur nette"]) || (bruteAmount && amortAmount ? Math.max(0, bruteAmount - amortAmount) : 0);
      const retainedVnc = vncAmount || calculatedVnc || "À contrôler";

      let resultLabel = "Plus/Moins-value à contrôler";
      let disposalResultAmount = "À contrôler";
      let diff = null;
      if (cessionAmount && typeof retainedVnc === "number") {
        diff = cessionAmount - retainedVnc;
        disposalResultAmount = Math.abs(diff);
        resultLabel = diff >= 0 ? "PLUS-VALUE" : "MOINS-VALUE";
      }

      entries.push(makeAnalysisEntry({
        label: `Analyse cession - ${assetName}`,
        amount: disposalResultAmount,
        justification:
`Immobilisation : ${assetName}

Valeur brute : ${formatEuro(bruteAmount)}
Amortissements cumulés : ${formatEuro(amortAmount)}
VNC : ${formatEuro(retainedVnc)}
Prix de cession : ${formatEuro(cessionAmount)}

Calcul : Prix de cession - VNC = ${formatEuro(diff)}
${resultLabel} ESTIMÉE : ${formatEuro(disposalResultAmount)}`,
        confidence: diff !== null ? 0.95 : 0.55,
        source: "analyse",
      }));

      entries.push({ journal: "OD", label: `Sortie immobilisation - Reprise amortissements - ${assetName}`, debit: amortRow ? getCompte(amortRow) : "28xxxx", credit: bruteRow ? getCompte(bruteRow) : "21xxxx", amount: amortAmount || "À contrôler", justification: `Amortissements cumulés repris du tableau des immobilisations. La sortie d'actif nécessite l'annulation des amortissements constatés.${userContext}`, confidence: amortAmount ? 0.8 : 0.55, source: assetRow ? "tableau amortissements" : "balance", status: "À valider" });
      entries.push({ journal: "OD", label: `Sortie immobilisation - VNC - ${assetName}`, debit: "675000", credit: bruteRow ? getCompte(bruteRow) : "21xxxx", amount: retainedVnc, justification: `Valeur brute : ${formatEuro(bruteAmount)} / Amortissements cumulés : ${formatEuro(amortAmount)} / VNC retenue : ${formatEuro(retainedVnc)}. À rapprocher du tableau des immobilisations.${userContext}`, confidence: retainedVnc !== "À contrôler" ? 0.8 : 0.55, source: assetRow ? "tableau amortissements" : "balance/grandLivre", status: "À valider" });

      controls.push({ type: "fixed_asset_disposal_detected", label: "Sortie d'immobilisation détectée", level: "warning" });
    });
  }

  // Paie / charges sociales
if (answers.paie === "yes" || hasAcc(["421", "428", "431", "437", "438", "641", "645"])) {
  detectPayroll(balanceRows, grandLivreRows, entries, controls, answers, details);
}

  // Provisions
if (answers.provisions === "yes") {
  const provisionRows = uniqueRows(allRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);
    return (
      compte.startsWith("151") ||
      compte.startsWith("6815") ||
      compte.startsWith("7815") ||
      text.includes("provision") ||
      text.includes("litige") ||
      text.includes("prudhom") ||
      text.includes("prud'hom") ||
      text.includes("risque")
    );
  }));

  const dotationRows = provisionRows.filter(row => getCompte(row).startsWith("6815"));
  const provisionBalanceRows = provisionRows.filter(row => getCompte(row).startsWith("151"));

  if (dotationRows.length) {
    dotationRows.forEach(row => {
      const text = getRowText(row);
      let credit = "151000";
      if (text.includes("prudhom") || text.includes("prud'hom")) credit = "151100";
      if (text.includes("commercial") || text.includes("autre risque")) credit = "151800";
     entries.push({
  journal: "OD",
  label: getLibelle(row),
  debit: getCompte(row) || "681500",
  credit,
  amount: getAmount(row) || "À contrôler",
  justification: "Dotation aux provisions détectée dans le grand livre. À rapprocher du dossier de justification du risque.",
  confidence: 0.85,
  source: "grandLivre",
  status: "À valider",
});
    });
  } else if (provisionBalanceRows.length) {
    entries.push(makeAnalysisEntry({
      label: "Analyse provisions",
      amount: provisionBalanceRows.reduce((s, r) => s + getAmount(r), 0) || "À contrôler",
      justification:
`Provision inscrite au bilan sans dotation 6815 détectée dans le grand livre.

Conclusion : aucune OD automatique 6815 / 151 n'est proposée.
Action : vérifier si la provision est antérieure, reprise, maintenue ou à compléter avec un justificatif de risque.`,
      confidence: 0.75,
      source: "balance/grandLivre",
      details: provisionBalanceRows.map(row => ({ compte: getCompte(row), libelle: getLibelle(row), amount: getAmount(row) || 0 })),
    }));
  } else {
    entries.push(makeAnalysisEntry({
      label: "Analyse provisions",
      amount: "À contrôler",
      justification:
`L'utilisateur a indiqué un point de provision, mais aucun compte 151, 6815 ou 7815 exploitable n'a été détecté.

Aucune écriture automatique n'est proposée.
À vérifier uniquement si un litige, risque ou engagement existe réellement à la clôture.`,
      confidence: 0.55,
      source: "questionnaire",
    }));
  }

  controls.push({ type: "provision_detected", label: "Provision ou risque contrôlé", level: provisionRows.length ? "info" : "warning" });
}

  // Dépréciations
  if (answers.provisions === "yes") {
    const depreciationRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("6816") || compte.startsWith("6817") || text.includes("depreciation") || text.includes("dépréciation") || text.includes("client douteux") || text.includes("stock obsolete") || text.includes("stock obsolète");
    });

    depreciationRows.forEach(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      let label = "Dépréciation à contrôler";
      let debit = compte || "681600";
      let credit = "491000";
      if (compte.startsWith("68174") || text.includes("client douteux")) { label = "Dépréciation client douteux"; debit = "681740"; credit = "491000"; }
      if (compte.startsWith("68173") || text.includes("stock obsolete") || text.includes("stock obsolète")) { label = "Dépréciation stock"; debit = "681730"; credit = "397000"; }
      if (compte.startsWith("68162") || text.includes("immobilisation")) { label = "Dépréciation immobilisation"; debit = "681620"; credit = "290000"; }
      entries.push(makeEntryFromRow(row, { label, debit, credit, justification: `Dépréciation détectée dans le grand livre.${userContext}`, confidence: 0.8 }));
    });
  }

  // TVA
  if (hasAcc(["44551"])) {
    controls.push({ type: "vat_due_detected", label: "TVA à décaisser détectée", level: "info" });
    entries.push({ journal: "OD", label: "TVA à décaisser à contrôler", debit: "445710", credit: "445510", amount: getBalanceAmount(["44551"]) || "À contrôler", justification: `Compte 445510 détecté : TVA à décaisser.${userContext}`, confidence: 0.85, source: "balance", status: "À valider" });
  }

  // Emprunts / ICNE
  if (hasAcc(["164", "661", "1688"]) && (answers.immo === "yes" || answers.emprunt === "yes" || answers.loans === "yes" || empruntRows.length)) {
    const loanRow = findFirstRowByPrefixes(balanceRows, ["164"]) || findFirstRowByPrefixes(grandLivreRows, ["164"]);
    const interestRow = findFirstRowByPrefixes(balanceRows, ["661"]) || findFirstRowByPrefixes(grandLivreRows, ["661"]);
    const icneRow = findFirstRowByPrefixes(balanceRows, ["1688"]) || findFirstRowByPrefixes(grandLivreRows, ["1688"]);

    const capitalAmount = loanRow ? getAmount(loanRow) : 0;
    const interestAmount = interestRow ? getAmount(interestRow) : 0;
    const icneAmount = icneRow ? getAmount(icneRow) : 0;
    const calculatedIcne = findLoanIcne(empruntRows, closure.endDate);
    const finalIcneAmount = icneAmount || calculatedIcne?.icne || 0;
    const loanEntryAmount = finalIcneAmount || "À calculer";

    entries.push({ journal: "OD", label: "Intérêts courus d'emprunt", debit: "661100", credit: "168800", amount: loanEntryAmount, justification: icneAmount ? `Compte 1688 détecté : intérêts courus non échus déjà identifiés dans la balance.${userContext}` : calculatedIcne ? `ICNE calculé depuis le tableau d'emprunt : ${calculatedIcne.elapsedDays} jours courus / ${calculatedIcne.periodDays} jours de période.${userContext}` : `Compte 1688 absent : ICNE à calculer avec le tableau d'emprunt.${userContext}`, confidence: icneAmount ? 0.85 : calculatedIcne ? 0.8 : 0.55, source: icneAmount ? "balance" : calculatedIcne ? "tableau emprunt" : "analyse", status: "À valider" });

    entries.push(makeAnalysisEntry({
      label: "Analyse emprunt",
      amount: loanEntryAmount,
      justification: icneAmount
        ? `Emprunt détecté.\n\nCapital restant dû / compte 164 : ${formatEuro(capitalAmount)}\nIntérêts comptabilisés / compte 661 : ${formatEuro(interestAmount)}\nICNE repris du compte 1688 : ${formatEuro(icneAmount)}\n\nLe compte 1688 étant présent dans la balance, ce montant est repris directement.`
        : calculatedIcne
          ? `Emprunt détecté.\n\nBanque : ${calculatedIcne.bank || "?"}\nRéférence : ${calculatedIcne.reference || "?"}\n\nPériode : ${calculatedIcne.start.toLocaleDateString("fr-FR")} → ${calculatedIcne.due.toLocaleDateString("fr-FR")}\nJours courus : ${calculatedIcne.elapsedDays}\nJours période : ${calculatedIcne.periodDays}\nIntérêts de l'échéance : ${formatEuro(calculatedIcne.interest)}\nICNE calculé : ${formatEuro(calculatedIcne.icne)}\n\nÉcriture proposée : débit 661100 / crédit 168800.${userContext}`
          : `Emprunt détecté.\n\nCapital restant dû / compte 164 : ${formatEuro(capitalAmount)}\nIntérêts comptabilisés / compte 661 : ${formatEuro(interestAmount)}\n\nImpossible de calculer les ICNE automatiquement. Le tableau d'emprunt est absent ou inexploitable.`,
      confidence: icneAmount ? 0.85 : calculatedIcne ? 0.8 : 0.55,
      source: icneAmount ? "balance" : calculatedIcne ? "tableau emprunt" : "analyse",
    }));

    controls.push({ type: "loan_analysis_detected", label: "Emprunt ou intérêts d'emprunt détectés", level: "info" });
  }

  if (entries.length === 0) anomalies.push({ type: "no_entries_generated", label: "Aucune écriture générée selon les réponses fournies", level: "info" });
  return { entries: dedupeEntries(entries), controls, anomalies };
}

function parseFecText(content) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .filter(line => line.trim());

  if (lines.length < 2) return [];

  const separator = lines[0].includes("|") ? "|" : "\t";
  const headers = lines[0].split(separator).map(h => h.trim());

  return lines.slice(1).map(line => {
    const values = line.split(separator);
    const row = {};

    headers.forEach((header, i) => {
      row[header] = values[i] || "";
    });

    return {
      ...row,
      Compte: row.CompteNum || row.compte || row.Compte || "",
      Libellé: row.EcritureLib || row.Libellé || row.Libelle || "",
      Débit: row.Debit || row.Débit || "",
      Crédit: row.Credit || row.Crédit || "",
      Montant: row.Montant || "",
      Date: row.EcritureDate || row.Date || "",
      Journal: row.JournalCode || row.Journal || "",
      Pièce: row.PieceRef || row.Pièce || ""
    };
  });
}

exports.parseClosureFiles = onRequest(async (req, res) => {
  setCors(res, "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { uid, closureId } = req.body || {};
    if (!uid || !closureId) return res.status(400).json({ error: "uid ou closureId manquant." });

    const db = admin.firestore();
    const bucket = admin.storage().bucket();
    const closureRef = db.collection("users").doc(uid).collection("closures").doc(closureId);
    const closureSnap = await closureRef.get();

    if (!closureSnap.exists) return res.status(404).json({ error: "Clôture introuvable." });

    const closure = closureSnap.data() || {};
    const balancePath = closure.files?.balance?.storagePath;
    const grandLivrePath = closure.files?.grandLivre?.storagePath;
    const amortissementsPath = closure.files?.amortissements?.storagePath;
    const empruntPath = closure.files?.emprunt?.storagePath;

   async function parseFile(storagePath) {
  if (!storagePath) return [];

  const [buffer] = await bucket.file(storagePath).download();
  const ext = String(storagePath).split(".").pop().toLowerCase();

  if (["xlsx", "xls", "csv"].includes(ext)) {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: "" }).slice(0, 2000);
  }

  if (["txt", "fec"].includes(ext)) {
    const content = buffer.toString("utf8");
    return parseFecText(content).slice(0, 2000);
  }

  if (ext === "pdf") {
    throw new Error("PDF non exploitable automatiquement pour l'instant. Merci de fournir Excel, CSV ou FEC.");
  }

  throw new Error("Format non pris en charge : " + ext);
} 

  if (["txt", "fec"].includes(ext)) {
    const content = buffer.toString("utf8");
    return parseFecText(content).slice(0, 2000);
  }

  if (ext === "pdf") {
    throw new Error("PDF non exploitable automatiquement pour l'instant. Merci de fournir Excel, CSV ou FEC.");
  }

  throw new Error("Format non pris en charge : " + ext);
}

    const balanceRows = await parseFile(balancePath);
    const grandLivreRows = await parseFile(grandLivrePath);
    const amortissementRows = await parseFile(amortissementsPath);
    const empruntRows = await parseFile(empruntPath);

    let controls = [];
    let anomalies = [];

    if (balanceRows.length) controls.push({ type: "balance_loaded", label: "Balance chargée", count: balanceRows.length });
    else anomalies.push({ type: "missing_balance", label: "Balance absente ou non exploitable", level: "warning" });

    if (grandLivreRows.length) controls.push({ type: "grand_livre_loaded", label: "Grand livre chargé", count: grandLivreRows.length });
    else anomalies.push({ type: "missing_grand_livre", label: "Grand livre absent ou non exploitable", level: "warning" });

    if (amortissementRows.length) controls.push({ type: "amortissements_loaded", label: "Tableau d'amortissement chargé", count: amortissementRows.length });
    if (empruntRows.length) controls.push({ type: "emprunt_loaded", label: "Tableau d'emprunt chargé", count: empruntRows.length });

    const detected = detectAccountingEntries(
  balanceRows,
  grandLivreRows,
  amortissementRows,
  empruntRows,
  closure
) || {};

controls = [
  ...controls,
  ...(detected.controls || [])
];

anomalies = [
  ...anomalies,
  ...(detected.anomalies || [])
];

    await closureRef.set(
      cleanFirestoreObject({
        balance: balanceRows,
        grandLivre: grandLivreRows,
        amortissements: amortissementRows,
        emprunt: empruntRows,
        controls,
        anomalies,
       entries: detected.entries || [],
        aiAnalysis: {
          status: "parsed",
          model: null,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
          summary: "Fichiers lus et convertis en données exploitables.",
          warnings: anomalies,
        },
        status: "parsed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );

    return res.json({
      ok: true,
      balanceRows: balanceRows.length,
      grandLivreRows: grandLivreRows.length,
      amortissementRows: amortissementRows.length,
      empruntRows: empruntRows.length,
      entries: (detected.entries || []).length,
      controls: controls.length,
      anomalies: anomalies.length,
    });
  } catch (error) {
    console.error("parseClosureFiles error:", error);
    return res.status(500).json({ error: "Erreur parsing fichiers." });
  }
});

exports.parseScoreCorrectionFiles = onRequest(async (req, res) => {
  setCors(res, "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { uid, closureId, correctionKey } = req.body || {};
    if (!uid || !closureId) {
      return res.status(400).json({ error: "uid ou closureId manquant." });
    }

    const db = admin.firestore();
    const bucket = admin.storage().bucket();
    const closureRef = db.collection("users").doc(uid).collection("closures").doc(closureId);
    const closureSnap = await closureRef.get();

    if (!closureSnap.exists) {
      return res.status(404).json({ error: "Clôture introuvable." });
    }

    const closure = closureSnap.data() || {};

    async function parseFile(storagePath) {
      if (!storagePath) return [];
      const [buffer] = await bucket.file(storagePath).download();
      const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      return XLSX.utils.sheet_to_json(sheet, { defval: "" }).slice(0, 2000);
    }

    const balanceRows = await parseFile(closure.files?.balance?.storagePath);
    const grandLivreRows = await parseFile(closure.files?.grandLivre?.storagePath);

    const amortissementRowsFromFile = await parseFile(closure.files?.amortissements?.storagePath);
    const empruntRowsFromFile = await parseFile(closure.files?.emprunt?.storagePath);

    const amortissementRows = amortissementRowsFromFile.length
      ? amortissementRowsFromFile
      : Array.isArray(closure.amortissements)
        ? closure.amortissements
        : [];

    const empruntRows = empruntRowsFromFile.length
      ? empruntRowsFromFile
      : Array.isArray(closure.emprunt)
        ? closure.emprunt
        : [];

    let controls = [];
    let anomalies = [];

    if (balanceRows.length) controls.push({ type: "balance_loaded", label: "Balance chargée", count: balanceRows.length });
    else anomalies.push({ type: "missing_balance", label: "Balance absente ou non exploitable", level: "warning" });

    if (grandLivreRows.length) controls.push({ type: "grand_livre_loaded", label: "Grand livre chargé", count: grandLivreRows.length });
    else anomalies.push({ type: "missing_grand_livre", label: "Grand livre absent ou non exploitable", level: "warning" });

    if (amortissementRows.length) controls.push({ type: "amortissements_loaded", label: "Tableau d'amortissement chargé", count: amortissementRows.length });
    if (empruntRows.length) controls.push({ type: "emprunt_loaded", label: "Tableau d'emprunt chargé", count: empruntRows.length });

    const detected = detectAccountingEntries(
      balanceRows,
      grandLivreRows,
      amortissementRows,
      empruntRows,
      closure
    ) || {};

    controls = [
      ...controls,
      ...(detected.controls || [])
    ];

    anomalies = [
      ...anomalies,
      ...(detected.anomalies || [])
    ];

    const correctionId = correctionKey || "general";

    await closureRef.set(cleanFirestoreObject({
      balance: balanceRows,
      grandLivre: grandLivreRows,
      amortissements: amortissementRows,
      emprunt: empruntRows,
      controls,
      anomalies,
      scoreCorrections: {
        ...(closure.scoreCorrections || {}),
        [correctionId]: {
          status: "corrected",
          label: correctionId,
          correctedAt: new Date().toISOString()
        }
      },
      scoreQualite: null,
      scoreQuality: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }), { merge: true });

    return res.json({
      ok: true,
      correctionKey: correctionId,
      balanceRows: balanceRows.length,
      grandLivreRows: grandLivreRows.length,
      amortissementRows: amortissementRows.length,
      empruntRows: empruntRows.length,
      controls: controls.length,
      anomalies: anomalies.length,
      entriesDetectedButNotApplied: (detected.entries || []).length
    });

  } catch (error) {
    console.error("parseScoreCorrectionFiles error:", error);
    return res.status(500).json({ error: "Erreur correction score uniquement." });
  }
});

function extractOpenAiText(data) {
  if (data.output_text) return data.output_text;

  const parts = [];

  (data.output || []).forEach(item => {
    (item.content || []).forEach(content => {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      } else if (typeof content.text === "string") {
        parts.push(content.text);
      }
    });
  });

  return parts.join("\n").trim();
}

function parseOpenAiJson(data) {
  const text = extractOpenAiText(data);

  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }

    throw e;
  }
}

function fallbackAffectation(resultType, resultAmount) {
  const amount = Number(resultAmount || 0);

  if (resultType === "loss") {
    return {
      recommendation: "loss",
      reserveAmount: 0,
      carryForwardAmount: 0,
      dividendAmount: 0,
      lossCarryForwardAmount: amount,
      explanation: "La perte doit être affectée en report à nouveau débiteur.",
      warnings: ["Contrôler l'existence éventuelle de pertes antérieures et la situation des capitaux propres."],
      pvJustification: "L'Assemblée Générale décide d'affecter la perte de l'exercice en report à nouveau débiteur."
    };
  }

  const reserve = Math.round(amount * 0.05 * 100) / 100;
  const carry = Math.round((amount - reserve) * 100) / 100;

  return {
    recommendation: "prudent",
    reserveAmount: reserve,
    carryForwardAmount: carry,
    dividendAmount: 0,
    lossCarryForwardAmount: 0,
    explanation: "Affectation prudente proposée : une part en réserve, le solde en report à nouveau afin de renforcer les capitaux propres.",
    warnings: ["Vérifier les statuts, les réserves obligatoires et la trésorerie avant toute distribution."],
    pvJustification: "L'Assemblée Générale décide d'affecter le bénéfice en réserve et en report à nouveau afin de renforcer la situation financière de la société."
  };
}

exports.aiAffectationResultat = onRequest(
  { secrets: ["OPENAI_API_KEY"] },
  async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
      const { uid, closureId, resultType, resultAmount, currentAllocation } = req.body || {};
      if (!uid || !closureId) return res.status(400).json({ error: "uid ou closureId manquant." });

      const db = admin.firestore();
      const snap = await db.collection("users").doc(uid).collection("closures").doc(closureId).get();
      if (!snap.exists) return res.status(404).json({ error: "Clôture introuvable." });

      const closure = snap.data() || {};
      const amount = Number(resultAmount || 0);

      const fallback = fallbackAffectation(resultType, amount);
      if (!amount) return res.json({ ok: true, ...fallback });

      const prompt = `
Tu es un assistant de clôture comptable français.

Objectif :
Proposer une affectation du résultat claire, prudente et exploitable.

Données :
- Société : ${closure.companyName || "Non renseignée"}
- Exercice : ${closure.startDate || "?"} au ${closure.endDate || "?"}
- Nature du résultat : ${resultType === "loss" ? "perte" : "bénéfice"}
- Montant : ${amount}
- Affectation actuelle : ${JSON.stringify(currentAllocation || {})}
- Activité : ${closure.activity || "Non renseignée"}
- Régime TVA : ${closure.vatRegime || closure.regimeTva || "Non renseigné"}

Contraintes :
- Réponds uniquement en JSON valide.
- Ne donne pas de conseil juridique définitif.
- Ne propose pas de dividendes si la prudence impose de renforcer les capitaux propres.
- Si perte : affectation en report à nouveau débiteur.
- Si bénéfice : privilégier une affectation prudente sauf indication contraire.
- Explique clairement l'impact de l'activité et du régime TVA uniquement si cela apporte une vraie valeur métier.

Format JSON attendu :
{
  "recommendation":"prudent|report|distribution|loss",
  "reserveAmount":0,
  "carryForwardAmount":0,
  "dividendAmount":0,
  "lossCarryForwardAmount":0,
  "explanation":"texte court",
  "warnings":["point 1","point 2"],
  "pvJustification":"phrase professionnelle pour le PV"
}
`;

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: prompt,
          text: {
            format: {
              type: "json_object"
            }
          }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error("OpenAI error:", data);
        return res.json({ ok: true, fallback: true, ...fallback });
      }

      let ai;
      try {
        ai = parseOpenAiJson(data);
      } catch (e) {
        console.error("AI JSON parse error:", e, data);
        return res.json({ ok: true, fallback: true, ...fallback });
      }

      return res.json({
        ok: true,
        recommendation: ai.recommendation || fallback.recommendation,
        reserveAmount: Number(ai.reserveAmount || 0),
        carryForwardAmount: Number(ai.carryForwardAmount || 0),
        dividendAmount: Number(ai.dividendAmount || 0),
        lossCarryForwardAmount: Number(ai.lossCarryForwardAmount || 0),
        explanation: ai.explanation || fallback.explanation,
        warnings: Array.isArray(ai.warnings) ? ai.warnings : fallback.warnings,
        pvJustification: ai.pvJustification || fallback.pvJustification
      });

    } catch (error) {
      console.error("aiAffectationResultat error:", error);
      return res.status(500).json({ error: "Erreur IA affectation du résultat." });
    }
  }
);

function compactForAI(value, max = 25) {
  if (!Array.isArray(value)) return [];

  return value.slice(0, max).map(item => ({
    type: item.type || item.key || "",
    title: item.title || item.label || item.libelle || "",
    score: item.score ?? null,
    max: item.max ?? null,
    loss: item.loss ?? null,
    status: item.status || item.level || "",
    detail: item.detail || item.justification || "",
    debit: item.debit || "",
    credit: item.credit || "",
    amount: item.amount || "",
    files: Array.isArray(item.files) ? item.files : []
  }));
}

function fallbackScoreQuality(scoreItems = [], score = 0) {
  const losses = scoreItems
    .filter(i => Number(i.loss || 0) > 0)
    .sort((a, b) => Number(b.loss || 0) - Number(a.loss || 0));

  return {
    summary: score >= 96
      ? "Le dossier est presque finalisé. Les derniers points concernent des contrôles de justification."
      : "Le dossier doit être renforcé avant validation définitive.",
    priorityActions: losses.slice(0, 6).map(i => ({
      title: i.title || i.key || "Contrôle à améliorer",
      action: i.detail || "Contrôle à reprendre et documenter.",
      impact: Number(i.loss || 0),
      filesNeeded: Array.isArray(i.files) ? i.files : [],
      expectedResult: "Point documenté, justificatif ajouté ou écriture corrigée."
    })),
    warnings: [
      "Les recommandations IA doivent être validées avant comptabilisation définitive.",
      "Les justificatifs comptables restent indispensables."
    ],
    finalAdvice: score >= 96
      ? "Faire une revue finale des justificatifs, puis figer le dossier."
      : "Corriger les pertes de points les plus fortes, réimporter les fichiers corrigés si nécessaire, puis relancer le score."
  };
}

exports.aiScoreQualite = onRequest(
  { secrets: ["OPENAI_API_KEY"] },
  async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { uid, closureId, score, scoreItems } = req.body || {};

      if (!uid || !closureId) {
        return res.status(400).json({ error: "uid ou closureId manquant." });
      }

      const db = admin.firestore();
      const snap = await db.collection("users").doc(uid).collection("closures").doc(closureId).get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Clôture introuvable." });
      }

      const closure = snap.data() || {};
      const fallback = fallbackScoreQuality(scoreItems || [], score || 0);

      const importantPrefixes = [
  "408", "418", "4181", "4187", "4686", "4687", "486", "487", "448",
  "471", "472", "455", "23",
  "20", "21", "218", "28", "281", "6811", "675", "775",
  "164", "661", "1688",
  "131", "139", "777",
  "612", "404",
  "445", "44551", "44566", "44571",
  "476", "477", "666", "766",
  "151", "1515", "6815", "6816", "6817", "7815", "491", "397",
  "421", "428", "431", "437", "438", "641", "645"
];
      const relevantBalance = (closure.balance || []).filter(r =>
        importantPrefixes.some(p =>
          String(r.Compte || r.compte || r.CompteNum || r.compteNum || "").replace(/\s/g, "").startsWith(p)
        )
      );

      const relevantGrandLivre = (closure.grandLivre || []).filter(r =>
        importantPrefixes.some(p =>
          String(r.Compte || r.compte || r.CompteNum || r.compteNum || "").replace(/\s/g, "").startsWith(p)
        )
      ).slice(0, 120);

      const aiPayload = {
        companyName: closure.companyName || "",
        exercice: `${closure.startDate || "?"} au ${closure.endDate || "?"}`,
        activity: closure.activity || closure.activite || "",
        vatRegime: closure.vatRegime || closure.regimeTva || "",
        score: Number(score || 0),
        scoreItems: compactForAI(scoreItems || [], 40),
        controls: compactForAI(closure.controls || [], 50),
        anomalies: compactForAI(closure.anomalies || [], 50),
        entries: compactForAI(closure.entries || [], 80),
        balanceSensitiveRows: compactForAI(relevantBalance, 120),
        grandLivreSensitiveRows: compactForAI(relevantGrandLivre, 120),
        affectationResult: closure.affectationResult || null,
        extournesN1: closure.extournesN1 || null,
        dossierRevision: closure.dossierRevision || closure.revisionDossier || null
      };

      const prompt = `
Tu es un expert-comptable français spécialisé en clôture comptable.

Mission :
Aider l'utilisateur à récupérer les derniers points manquants du score qualité.

Données du dossier :
${JSON.stringify(aiPayload)}

Règles :
- Réponds uniquement en JSON valide.
- Ne fais pas de généralités.
- Appuie-toi sur les comptes, écritures, anomalies et lignes sensibles fournies.
- Pour chaque point perdu, donne une action concrète.
- Si un compte 471/472 existe, propose le reclassement ou la justification attendue.
- Si un compte 455 existe, demande la justification du solde et des mouvements.
- Si un compte 23 existe, demande mise en service, maintien justifié ou reclassement.
- Si une immobilisation sort, demande contrôle VNC, prix de cession et écriture de sortie.
- Si TVA, ICNE, provisions, crédit-bail ou écart de change : indique le contrôle métier à faire.
- Ne propose pas de refaire toute la clôture.
- Style direct, professionnel, exploitable.

Format JSON strict :
{
  "summary":"synthèse courte",
  "priorityActions":[
    {
      "title":"point à traiter",
      "action":"action concrète à faire",
      "impact":0,
      "filesNeeded":["Balance","Grand Livre"],
      "expectedResult":"résultat attendu"
    }
  ],
  "warnings":["alerte métier"],
  "finalAdvice":"conseil final opérationnel"
}
`;

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: prompt,
          text: {
            format: { type: "json_object" }
          }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error("OpenAI score error:", data);
        return res.json({ ok: true, fallback: true, ...fallback });
      }

      let ai;
      try {
        ai = parseOpenAiJson(data);
      } catch (e) {
        console.error("AI score JSON parse error:", e, data);
        return res.json({ ok: true, fallback: true, ...fallback });
      }

      return res.json({
        ok: true,
        summary: ai.summary || fallback.summary,
        priorityActions: Array.isArray(ai.priorityActions) ? ai.priorityActions : fallback.priorityActions,
        warnings: Array.isArray(ai.warnings) ? ai.warnings : fallback.warnings,
        finalAdvice: ai.finalAdvice || fallback.finalAdvice
      });

    } catch (error) {
      console.error("aiScoreQualite error:", error);
      return res.status(500).json({ error: "Erreur IA score qualité." });
    }
  }
);

exports.submitFeedback = onRequest(async (req, res) => {
  setCors(res, "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      uid,
      userEmail,
      type,
      category,
      title,
      message,
      closureId,
      page,
      screenshotName
    } = req.body || {};

    if (!uid || !userEmail || !type || !title || !message) {
      return res.status(400).json({ error: "Paramètres manquants." });
    }

    if (!["suggestion", "bug"].includes(type)) {
      return res.status(400).json({ error: "Type invalide." });
    }

    const status = type === "suggestion" ? "a_etudier" : "ouvert";

    const docRef = await admin.firestore().collection("feedback").add({
      uid,
      userEmail,
      type,
      category: category || "",
      title: String(title).trim(),
      message: String(message).trim(),
      closureId: closureId || "",
      page: page || "",
      screenshotName: screenshotName || "",
      status,
      statusLabel: type === "suggestion" ? "À l'étude" : "Ouvert",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      adminNote: "",
      source: "tableau-de-bord"
    });

    return res.json({
      ok: true,
      feedbackId: docRef.id,
      status,
      statusLabel: type === "suggestion" ? "À l'étude" : "Ouvert"
    });

  } catch (error) {
    console.error("submitFeedback error:", error);
    return res.status(500).json({ error: "Erreur lors de l’enregistrement du retour." });
  }
});

exports.syncStripeSubscription = onRequest(
  { secrets: ["STRIPE_SECRET_KEY"] },
  async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { uid } = req.body || {};
      if (!uid) return res.status(400).json({ error: "uid manquant." });

      const db = admin.firestore();
      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({ error: "Utilisateur introuvable." });
      }

      const user = userSnap.data() || {};
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      const customerId = user.stripeCustomerId;

      if (!customerId) {
        return res.json({ ok: true, synced: false, reason: "Aucun customer Stripe." });
      }

      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      });

      let hasCabinet = false;
      let hasExpert = false;
      let extraCollabCount = 0;
      let mainSubscriptionId = user.stripeSubscriptionId || null;

      for (const sub of subscriptions.data || []) {
        const isActive = ["active", "trialing"].includes(sub.status);
        if (!isActive) continue;

        const priceIds = (sub.items?.data || [])
          .map(item => item.price?.id)
          .filter(Boolean);

        if (priceIds.includes(PRICE_CABINET_399)) {
          hasCabinet = true;
          mainSubscriptionId = sub.id;
        }

        if (priceIds.includes(PRICE_EXPERT_149)) {
          hasExpert = true;
          mainSubscriptionId = sub.id;
        }

        if (priceIds.includes(PRICE_EXTRA_COLLAB_129)) {
          extraCollabCount += 1;
        }
      }

      const updateData = {
        active: hasCabinet || hasExpert || user.hasSoloPurchase === true,
        subscriptionActive: hasCabinet || hasExpert,
        cabinetExtraLicenses: extraCollabCount,
        subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (hasCabinet) {
        updateData.plan = "cabinet";
        updateData.cabinetOwner = true;
        updateData.cabinetMember = false;
        updateData.role = "owner";
        updateData.paymentStatus = "active";
        updateData.stripeSubscriptionId = mainSubscriptionId;
        updateData["cabinetSetup.status"] = "active";
        updateData["cabinetSetup.includedLicenses"] = user.cabinetSetup?.includedLicenses || 3;
      } else if (hasExpert) {
        updateData.plan = "expert";
        updateData.paymentStatus = "active";
        updateData.stripeSubscriptionId = mainSubscriptionId;
      } else if (user.hasSoloPurchase === true) {
        updateData.plan = "solo";
        updateData.paymentStatus = "paid";
        updateData.subscriptionActive = false;
      } else {
        updateData.plan = "";
        updateData.paymentStatus = "inactive";
        updateData.subscriptionActive = false;
        updateData.cabinetOwner = false;
      }

      await userRef.set(updateData, { merge: true });

      return res.json({
        ok: true,
        synced: true,
        hasCabinet,
        hasExpert,
        extraCollabCount,
      });

    } catch (error) {
      console.error("syncStripeSubscription error:", error);
      return res.status(500).json({ error: "Erreur synchronisation abonnement Stripe." });
    }
  }
);

exports.createCustomerPortalSession = onRequest(
  { secrets: ["STRIPE_SECRET_KEY"] },
  async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { uid, returnUrl } = req.body || {};
      if (!uid) return res.status(400).json({ error: "uid manquant." });

      const db = admin.firestore();
      const userSnap = await db.collection("users").doc(uid).get();

      if (!userSnap.exists) {
        return res.status(404).json({ error: "Utilisateur introuvable." });
      }

      const user = userSnap.data() || {};
      const customerId = user.stripeCustomerId;

      if (!customerId) {
        return res.status(400).json({
          error: "Aucun client Stripe trouvé pour ce compte.",
        });
      }

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl || `${ALLOWED_ORIGIN}/tableau-de-bord.html`,
      });

      return res.json({ ok: true, url: session.url });

    } catch (error) {
      console.error("createCustomerPortalSession error:", error);
      return res.status(500).json({
        error: "Erreur création portail Stripe.",
      });
    }
  }
);
