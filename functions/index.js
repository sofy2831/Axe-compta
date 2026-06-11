const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const XLSX = require("xlsx");

admin.initializeApp();

setGlobalOptions({ region: "europe-west9", maxInstances: 10 });

const PRICE_ONE_SHOT = "price_1TeDflRDM80msH4WHpXEAirL";
const PRICE_MONTHLY = "price_1TeDgZRDM80msH4W9UDDkMFd";
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

      if (!["one-shot", "monthly"].includes(plan)) {
        return res.status(400).json({ error: "Plan invalide." });
      }

      if (plan === "one-shot" && !closureId) {
        return res.status(400).json({ error: "closureId manquant." });
      }

      const price = plan === "monthly" ? PRICE_MONTHLY : PRICE_ONE_SHOT;

      const session = await stripe.checkout.sessions.create({
        mode: plan === "monthly" ? "subscription" : "payment",
        payment_method_types: ["card"],
        customer_email: email,
        line_items: [{ price, quantity: 1 }],
        success_url: `${ALLOWED_ORIGIN}/merci.html`,
        cancel_url: `${ALLOWED_ORIGIN}/cloture-resultat.html?id=${encodeURIComponent(closureId || "")}`,
        metadata: { uid, closureId: closureId || "", plan },
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
      event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
      console.error("Webhook signature error:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const uid = session.metadata?.uid;
        const closureId = session.metadata?.closureId;
        const plan = session.metadata?.plan;

        if (!uid || !plan) return res.status(400).send("Missing metadata");

        const db = admin.firestore();

        if (plan === "one-shot") {
          if (!closureId) return res.status(400).send("Missing closureId");

          await db.collection("users").doc(uid).collection("closures").doc(closureId).set(
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
  return String(
    row?.Compte ||
    row?.compte ||
    row?.CompteNum ||
    row?.compteNum ||
    row?.Numero ||
    row?.numero ||
    ""
  ).replace(/\s/g, "");
}

function getLibelle(row) {
  return String(
    row?.Libellé ||
    row?.libelle ||
    row?.Libelle ||
    row?.Intitulé ||
    row?.intitule ||
    row?.Description ||
    row?.description ||
    "ligne grand livre"
  ).trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;

  const raw = String(value)
    .replace(/\u00a0/g, "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^0-9.\-]/g, "");

  const n = Number(raw);
  return Number.isNaN(n) ? 0 : n;
}

function getAmount(row) {
  const keys = Object.keys(row || {});

  const preferredKeys = keys.filter(k => {
    const nk = normalizeText(k);
    return nk.includes("montant") || nk.includes("solde") || nk.includes("debit") || nk.includes("credit");
  });

  const searchKeys = preferredKeys.length ? preferredKeys : keys;

  for (const key of searchKeys) {
    const n = toNumber(row[key]);
    if (!Number.isNaN(n) && n !== 0 && Math.abs(n) > 0.01) return Math.abs(n);
  }

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
  return rows
    .filter(row => accountStarts(row, prefixes))
    .reduce((sum, row) => sum + (getAmount(row) || 0), 0);
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
    .replace(/\s+/g, " ")
    .replace(/^[-–—:\s]+/, "")
    .trim();

  if (!label) label = raw || "ligne grand livre";
  return `${prefix} - ${label}`;
}

function makeEntryFromRow(row, config) {
  const entry = {
    journal: config.journal || "OD",
    label: config.rawLabel || cleanEntryLabel(config.label, row),
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
    const key = [
      e.journal || "OD",
      e.label || "",
      e.debit || "",
      e.credit || "",
      e.amount || "",
    ].join("|").toLowerCase();

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanFirestoreObject(value) {
  if (Array.isArray(value)) return value.map(item => cleanFirestoreObject(item));

  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
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

  if (usefulInfo && usefulInfo.trim()) {
    parts.push(`Informations utiles du dossier :\n${usefulInfo.trim()}`);
  }

  keys.forEach(key => {
    if (details[key] && details[key].trim()) {
      parts.push(`Précision utilisateur (${key}) :\n${details[key].trim()}`);
    }
  });

  if (!parts.length) return "";
  return "\n\nInformations fournies par l'utilisateur :\n\n" + parts.join("\n\n");
}

function odJustification({ title, detection, rules, proposedEntry, controls = "", userContext = "" }) {
  return `${detection}

Règles appliquées :
${rules.map(rule => `- ${rule}`).join("\n")}

Écriture proposée :
${proposedEntry}

${controls ? `Contrôles à effectuer :\n${controls}` : ""}${userContext}`;
}

function detectSubventions(balanceRows, grandLivreRows, entries, controls, details = {}, usefulInfo = "") {
  const userContext = getUserContext(details, usefulInfo, ["immo", "provisions"]);
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
      justification: odJustification({
        detection: "Compte 139 détecté sans compte 777 correspondant.",
        rules: [
          "une subvention d'investissement doit être reprise au résultat au même rythme que l'amortissement du bien financé",
          "le compte 139 matérialise la quote-part de subvention inscrite au résultat",
          "le produit correspondant doit être comptabilisé en 777",
        ],
        proposedEntry: `Débit 139000 - Subvention inscrite au résultat\nCrédit 777000 - Quote-part de subvention virée au résultat\nMontant : ${formatEuro(repriseAmount)}`,
        controls: "Vérifier le plan de reprise, l'immobilisation financée et la cohérence avec la dotation aux amortissements.",
        userContext,
      }),
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
      justification: odJustification({
        detection: "Compte 777 détecté sans compte 139 correspondant.",
        rules: [
          "la quote-part de subvention virée au résultat doit être rattachée à une reprise du compte 139",
          "le compte 777 seul ne suffit pas à justifier la cohérence de la reprise",
          "le montant doit être validé avec le plan de reprise de la subvention",
        ],
        proposedEntry: `Débit 139000 - Subvention inscrite au résultat\nCrédit 777000 - Quote-part virée au résultat\nMontant : ${formatEuro(quotePartAmount)}`,
        controls: "Vérifier le plan de reprise, l'historique du compte 131 et l'amortissement du bien financé.",
        userContext,
      }),
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

Règles appliquées :
- la subvention d'investissement est maintenue en capitaux propres au compte 131 ;
- la quote-part rattachée à l'exercice est reprise par le compte 139 ;
- le produit correspondant est comptabilisé au compte 777 ;
- la reprise doit suivre le rythme d'amortissement du bien financé.

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
  const userContext = getUserContext(details, usefulInfo, ["immo", "cca", "fournisseurs"]);
  const allRows = [...balanceRows, ...grandLivreRows];

  const leasingRows = uniqueRows(allRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);
    return (
      compte.startsWith("612") ||
      compte.startsWith("486") ||
      compte.startsWith("408") ||
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
      text.includes("rachat option")
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
        justification: odJustification({
          detection: "Loyer de crédit-bail couvrant une période postérieure à la clôture.",
          rules: [
            "la charge payée d'avance ne doit pas rester intégralement en charge de l'exercice",
            "la quote-part concernant l'exercice suivant doit être transférée en 486",
            "l'écriture sera extournée en N+1",
          ],
          proposedEntry: `Débit 486000 - Charges constatées d'avance\nCrédit 612000 - Redevances de crédit-bail\nMontant : ${formatEuro(typeof amount === "number" ? amount : 0)}`,
          controls: "Vérifier le contrat, la période couverte et le calcul de prorata.",
          userContext,
        }),
        confidence: 0.85,
      }));
    } else if (hasFnp) {
      caseLabel = "Crédit-bail avec facture non parvenue";
      recommendation = "Écriture proposée : débit 612 / crédit 408 pour rattacher le loyer à l'exercice.";
      entries.push(makeEntryFromRow(row, {
        label: "FNP crédit-bail",
        debit: "612000",
        credit: "408100",
        justification: odJustification({
          detection: "Loyer de crédit-bail relatif à l'exercice, mais facture non parvenue.",
          rules: [
            "la charge concerne l'exercice clôturé",
            "la facture n'est pas encore comptabilisée à la clôture",
            "le rattachement se fait par le compte 408100",
            "l'écriture sera extournée en N+1 lors de la réception de la facture",
          ],
          proposedEntry: `Débit 612000 - Redevances de crédit-bail\nCrédit 408100 - Fournisseurs factures non parvenues\nMontant : ${formatEuro(typeof amount === "number" ? amount : 0)}`,
          controls: "Vérifier l'échéancier de crédit-bail et l'absence de facture comptabilisée.",
          userContext,
        }),
        confidence: 0.85,
      }));
    } else if (hasOption) {
      caseLabel = "Levée d'option de crédit-bail";
      recommendation = "Écriture proposée : débit 218 / crédit 404 pour immobiliser le bien acquis à la levée d'option.";
      entries.push(makeEntryFromRow(row, {
        label: "Levée option crédit-bail",
        debit: "218000",
        credit: "404000",
        justification: odJustification({
          detection: "Levée d'option de crédit-bail détectée.",
          rules: [
            "à la levée d'option, le bien devient une immobilisation de l'entreprise",
            "le prix de rachat doit être immobilisé",
            "un amortissement doit ensuite être calculé selon la durée d'utilisation résiduelle",
          ],
          proposedEntry: `Débit 218000 - Immobilisation corporelle\nCrédit 404000 - Fournisseurs d'immobilisations\nMontant : ${formatEuro(typeof amount === "number" ? amount : 0)}`,
          controls: "Vérifier le contrat, la facture de rachat et la date de mise en service.",
          userContext,
        }),
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
  const userContext = getUserContext(details, usefulInfo, ["clients", "fournisseurs", "provisions"]);
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
      justification: odJustification({
        detection: "Différence de conversion actif détectée en 476.",
        rules: [
          "une perte latente de change doit être provisionnée si elle n'est pas déjà couverte",
          "la provision est comptabilisée en charge financière",
          "le compte 1515 suit la provision pour perte de change",
        ],
        proposedEntry: `Débit 686500 - Dotations aux provisions financières\nCrédit 151500 - Provision pour perte de change\nMontant : ${formatEuro(amount476)}`,
        controls: "Vérifier les devises, le cours de clôture, la nature client/fournisseur et l'absence de provision déjà comptabilisée.",
        userContext,
      }),
      confidence: 0.75,
      source: "analyse",
      status: "À valider",
    });
  }

  entries.push(makeAnalysisEntry({
    label: "Analyse écarts de change",
    amount: amount476 || amount477 || amount666 || amount766 || "À contrôler",
    justification:
`Écarts de change détectés.

Compte 476 - Différences de conversion actif : ${formatEuro(amount476)}
Compte 477 - Différences de conversion passif : ${formatEuro(amount477)}
Compte 666 - Pertes de change réalisées : ${formatEuro(amount666)}
Compte 766 - Gains de change réalisés : ${formatEuro(amount766)}

Règles appliquées :
- 476 : perte latente de change à analyser, provision 6865 / 1515 possible ;
- 477 : gain latent de change, en principe aucun produit à comptabiliser à la clôture ;
- 666 : perte de change réalisée, contrôle du rattachement ;
- 766 : gain de change réalisé, contrôle du rattachement ;
- les écritures de conversion sont en principe extournées en N+1.

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
  const activity = normalizeText(closure.activity || "");
  const allRows = [...balanceRows, ...grandLivreRows];

  const ctxAll = getUserContext(details, usefulInfo, ["fournisseurs", "cca", "clients", "stocks", "immo", "paie", "provisions"]);
  const hasAcc = prefixes => hasAccount(allRows, prefixes);
  const getBalanceAmount = prefixes => {
    const row = findBalanceRow(balanceRows, prefixes);
    return row ? getAmount(row) : 0;
  };

  if (hasAcc(["21", "28"])) controls.push({ type: "immobilisation_detected", label: "Immobilisation ou amortissement détecté", level: "info" });
  if (hasAcc(["164", "661"])) controls.push({ type: "loan_detected", label: "Emprunt ou intérêts détectés", level: "info" });
  if (hasAcc(["706", "707"])) controls.push({ type: "revenue_detected", label: "Chiffre d'affaires détecté", level: "info" });

  // FNP
  if (hasAcc(["408"]) && answers.fournisseurs === "yes") {
    const fnpRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("6") && (
        text.includes("fnp") ||
        text.includes("facture non parvenue") ||
        text.includes("facture non recue")
      );
    });

    if (fnpRows.length) {
      fnpRows.forEach(row => entries.push(makeEntryFromRow(row, {
        label: "FNP",
        debit: getCompte(row) || "6xxxxx",
        credit: "408100",
        justification: odJustification({
          detection: "Facture fournisseur non parvenue détectée dans le grand livre.",
          rules: [
            "la charge concerne l'exercice clôturé",
            "la facture n'est pas encore comptabilisée à la date de clôture",
            "le rattachement se fait par le compte 408100",
            "l'écriture devra être extournée en N+1 lors de la réception de la facture",
          ],
          proposedEntry: `Débit ${getCompte(row) || "6xxxxx"} - Charge concernée\nCrédit 408100 - Fournisseurs factures non parvenues\nMontant : ${formatEuro(getAmount(row))}`,
          controls: "Vérifier la facture reçue après clôture, la date de prestation/livraison et l'absence de double comptabilisation.",
          userContext: getUserContext(details, usefulInfo, ["fournisseurs"]),
        }),
        confidence: 0.9,
      })));
    } else {
      const amount408 = getBalanceAmount(["408"]);
      entries.push({
        journal: "OD",
        label: "FNP",
        debit: "607000",
        credit: "408100",
        amount: amount408 || "À contrôler",
        justification: odJustification({
          detection: "Compte 408 détecté dans la balance.",
          rules: [
            "le compte 408 indique une facture fournisseur non parvenue",
            "la charge doit être rattachée à l'exercice clôturé",
            "le compte de charge doit être confirmé selon la nature de la dépense",
            "l'écriture devra être extournée en N+1",
          ],
          proposedEntry: `Débit 607000 ou 6xxxxx - Charge à identifier\nCrédit 408100 - Fournisseurs factures non parvenues\nMontant : ${formatEuro(amount408)}`,
          controls: "Identifier la nature exacte de la charge et rapprocher le montant avec les factures reçues après clôture.",
          userContext: getUserContext(details, usefulInfo, ["fournisseurs"]),
        }),
        confidence: 0.85,
        source: "balance",
        status: "À valider",
      });
    }
  }

  // CCA
  if (hasAcc(["486"]) && answers.cca === "yes") {
    const ccaRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("486") && (
        text.includes("cca") ||
        text.includes("charge constatee") ||
        text.includes("charges constatees") ||
        text.includes("periode suivante") ||
        text.includes("periode 2023")
      );
    });

    if (ccaRows.length) {
      ccaRows.forEach(row => entries.push(makeEntryFromRow(row, {
        label: "CCA",
        debit: "486000",
        credit: "616000",
        justification: odJustification({
          detection: "Charge constatée d'avance détectée dans le grand livre.",
          rules: [
            "une charge payée avant la clôture ne doit pas impacter l'exercice si elle concerne une période postérieure",
            "la quote-part postérieure est transférée en compte 486",
            "l'écriture sera extournée en N+1",
          ],
          proposedEntry: `Débit 486000 - Charges constatées d'avance\nCrédit ${getCompte(row) || "6xxxxx"} - Charge à extourner partiellement\nMontant : ${formatEuro(getAmount(row))}`,
          controls: "Vérifier la période couverte, le prorata et le compte de charge d'origine.",
          userContext: getUserContext(details, usefulInfo, ["cca"]),
        }),
        confidence: 0.9,
      })));
    } else {
      const amount486 = getBalanceAmount(["486"]);
      entries.push({
        journal: "OD",
        label: "CCA",
        debit: "486000",
        credit: "616000",
        amount: amount486 || "À contrôler",
        justification: odJustification({
          detection: "Compte 486 détecté dans la balance.",
          rules: [
            "le compte 486 correspond à des charges constatées d'avance",
            "la charge doit être neutralisée sur l'exercice clôturé pour sa part postérieure",
            "le compte de charge crédité doit être confirmé selon la nature de la dépense",
          ],
          proposedEntry: `Débit 486000 - Charges constatées d'avance\nCrédit 6xxxxx - Charge concernée\nMontant : ${formatEuro(amount486)}`,
          controls: "Vérifier la facture, les dates de couverture et le calcul du prorata.",
          userContext: getUserContext(details, usefulInfo, ["cca"]),
        }),
        confidence: 0.85,
        source: "balance",
        status: "À valider",
      });
    }
  }

  // PCA
  if (hasAcc(["487"]) && answers.cca === "yes") {
    const pcaRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("487") ||
        text.includes("pca") ||
        text.includes("produit constate") ||
        text.includes("produits constates");
    });

    if (pcaRows.length) {
      pcaRows
        .filter(row => getCompte(row).startsWith("487"))
        .forEach(row => entries.push(makeEntryFromRow(row, {
          label: "PCA",
          debit: "706000",
          credit: "487000",
          justification: odJustification({
            detection: "Produit constaté d'avance détecté dans le grand livre.",
            rules: [
              "un produit facturé avant la clôture ne doit pas être reconnu s'il concerne une période postérieure",
              "la quote-part non acquise est transférée en 487",
              "l'écriture sera extournée en N+1",
            ],
            proposedEntry: `Débit 706000 - Produit concerné\nCrédit 487000 - Produits constatés d'avance\nMontant : ${formatEuro(getAmount(row))}`,
            controls: "Vérifier la période de prestation, le prorata et le contrat/facture client.",
            userContext: getUserContext(details, usefulInfo, ["clients", "cca"]),
          }),
          confidence: 0.9,
        })));
    } else {
      const amount487 = getBalanceAmount(["487"]);
      entries.push({
        journal: "OD",
        label: "PCA",
        debit: "706000",
        credit: "487000",
        amount: amount487 || "À contrôler",
        justification: odJustification({
          detection: "Compte 487 détecté dans la balance.",
          rules: [
            "le compte 487 correspond à des produits constatés d'avance",
            "le produit doit être neutralisé si la prestation concerne l'exercice suivant",
            "le compte de produit débité doit être confirmé selon la nature du chiffre d'affaires",
          ],
          proposedEntry: `Débit 706000 ou 7xxxxx - Produit concerné\nCrédit 487000 - Produits constatés d'avance\nMontant : ${formatEuro(amount487)}`,
          controls: "Vérifier la facture, la période couverte et le calcul du prorata.",
          userContext: getUserContext(details, usefulInfo, ["clients", "cca"]),
        }),
        confidence: 0.85,
        source: "balance",
        status: "À valider",
      });
    }
  }

  // FAE
  if (hasAcc(["418"]) && answers.clients === "yes") {
    const faeRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("4181") ||
        text.includes("fae") ||
        text.includes("facture a etablir") ||
        text.includes("facture à établir");
    });

    if (faeRows.length) {
      faeRows.forEach(row => entries.push(makeEntryFromRow(row, {
        label: "FAE",
        debit: "418100",
        credit: "706000",
        justification: odJustification({
          detection: "Facture à établir détectée dans le grand livre.",
          rules: [
            "la prestation est réalisée avant la clôture",
            "la facture n'est pas encore émise à la date de clôture",
            "le produit doit être rattaché à l'exercice",
            "l'écriture sera extournée en N+1 lors de l'émission de la facture",
          ],
          proposedEntry: `Débit 418100 - Clients factures à établir\nCrédit 706000 ou 7xxxxx - Produit concerné\nMontant : ${formatEuro(getAmount(row))}`,
          controls: "Vérifier la livraison/prestation, le bon de commande ou contrat et la facture émise après clôture.",
          userContext: getUserContext(details, usefulInfo, ["clients"]),
        }),
        confidence: 0.9,
      })));
    } else {
      const amount418 = getBalanceAmount(["4181"]);
      entries.push({
        journal: "OD",
        label: "FAE",
        debit: "418100",
        credit: "706000",
        amount: amount418 || "À contrôler",
        justification: odJustification({
          detection: "Compte 418100 détecté dans la balance.",
          rules: [
            "le compte 418100 correspond aux factures à établir",
            "le produit doit être rattaché à l'exercice clôturé",
            "le compte de produit doit être confirmé selon la nature de la prestation",
          ],
          proposedEntry: `Débit 418100 - Clients factures à établir\nCrédit 706000 ou 7xxxxx - Produit concerné\nMontant : ${formatEuro(amount418)}`,
          controls: "Rapprocher le montant avec la facture émise après clôture et les justificatifs de prestation.",
          userContext: getUserContext(details, usefulInfo, ["clients"]),
        }),
        confidence: 0.85,
        source: "balance",
        status: "À valider",
      });
    }
  }

  // PAR
  if (hasAcc(["4187", "4687"]) && answers.clients === "yes") {
    const parRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("4187") ||
        compte.startsWith("4687") ||
        text.includes("produit a recevoir") ||
        text.includes("produits a recevoir") ||
        text.includes("produit à recevoir") ||
        text.includes("produits à recevoir");
    });

    if (parRows.length) {
      parRows.forEach(row => {
        const compte = getCompte(row);
        const debit = compte.startsWith("4687") ? "468700" : "418700";
        entries.push(makeEntryFromRow(row, {
          label: "PAR",
          debit,
          credit: "706000",
          justification: odJustification({
            detection: "Produit à recevoir détecté dans le grand livre.",
            rules: [
              "le produit est acquis à la clôture",
              "la pièce définitive n'est pas encore disponible",
              "le rattachement se fait par 4187 ou 4687 selon la nature du tiers",
              "l'écriture sera extournée en N+1",
            ],
            proposedEntry: `Débit ${debit} - Produit à recevoir\nCrédit 706000 ou 7xxxxx - Produit concerné\nMontant : ${formatEuro(getAmount(row))}`,
            controls: "Vérifier le contrat, le droit acquis au produit et la pièce justificative postérieure.",
            userContext: getUserContext(details, usefulInfo, ["clients"]),
          }),
          confidence: 0.9,
        }));
      });
    } else {
      const amountPar = getBalanceAmount(["4187", "4687"]);
      entries.push({
        journal: "OD",
        label: "PAR",
        debit: "418700",
        credit: "706000",
        amount: amountPar || "À contrôler",
        justification: odJustification({
          detection: "Produit à recevoir détecté dans la balance.",
          rules: [
            "le produit doit être rattaché à l'exercice s'il est acquis à la clôture",
            "le compte 4187 ou 4687 sert à constater le produit à recevoir",
            "le compte de produit doit être confirmé",
          ],
          proposedEntry: `Débit 418700 ou 468700 - Produit à recevoir\nCrédit 706000 ou 7xxxxx - Produit concerné\nMontant : ${formatEuro(amountPar)}`,
          controls: "Vérifier le justificatif, le contrat et la date d'acquisition du produit.",
          userContext: getUserContext(details, usefulInfo, ["clients"]),
        }),
        confidence: 0.85,
        source: "balance",
        status: "À valider",
      });
    }
  }

  // CAP hors FNP et paie
  if (answers.fournisseurs === "yes") {
    const capRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("448") ||
        compte.startsWith("4686") ||
        text.includes("cap") ||
        text.includes("charge a payer") ||
        text.includes("charge à payer") ||
        text.includes("charges a payer") ||
        text.includes("charges à payer");
    });

    capRows.forEach(row => {
      const compte = getCompte(row);
      const text = getRowText(row);

      if (
        compte.startsWith("428") ||
        compte.startsWith("438") ||
        text.includes("conges payes") ||
        text.includes("congés payés") ||
        text.includes("cotisations conges") ||
        text.includes("cotisations congés")
      ) {
        return;
      }

      let debit = "628000";
      let credit = compte || "468600";

      if (text.includes("honoraire") || text.includes("avocat") || text.includes("comptable")) debit = "622600";
      if (text.includes("assurance")) debit = "616000";
      if (text.includes("edf") || text.includes("electricite") || text.includes("électricité")) debit = "606100";
      if (text.includes("urssaf") || text.includes("social")) debit = "645000";
      if (compte.startsWith("448") || text.includes("cfe") || text.includes("taxe") || text.includes("fonciere") || text.includes("foncière")) debit = "635000";

      entries.push(makeEntryFromRow(row, {
        label: "CAP",
        debit,
        credit,
        justification: odJustification({
          detection: "Charge à payer détectée dans le grand livre.",
          rules: [
            "la charge concerne l'exercice clôturé",
            "le justificatif définitif peut être reçu ou calculé après la clôture",
            "le compte de tiers dépend de la nature de la charge : 448 pour fiscal, 4686 pour divers, 408 pour fournisseur",
            "l'écriture sera extournée en N+1",
          ],
          proposedEntry: `Débit ${debit} - Charge concernée\nCrédit ${credit} - Charge à payer\nMontant : ${formatEuro(getAmount(row))}`,
          controls: "Vérifier l'avis, le contrat, la facture ou le calcul interne correspondant.",
          userContext: getUserContext(details, usefulInfo, ["fournisseurs"]),
        }),
        confidence: 0.85,
      }));
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
      grandLivreRows
        .filter(row => config.prefixes.some(prefix => getCompte(row).startsWith(prefix)))
        .forEach(row => {
          stockFound = true;
          entries.push({
            journal: "OD",
            label: cleanEntryLabel(config.label, row),
            debit: config.debit,
            credit: config.credit,
            amount: getAmount(row) || "À contrôler",
            justification: odJustification({
              detection: "Variation de stock détectée dans le grand livre.",
              rules: [
                "le stock final doit être rapproché de l'inventaire physique",
                "la variation de stock corrige les achats ou la production de l'exercice",
                "le montant doit être justifié par un inventaire valorisé",
              ],
              proposedEntry: `Débit ${config.debit} - Stock final\nCrédit ${config.credit} - Variation de stock\nMontant : ${formatEuro(getAmount(row))}`,
              controls: "Vérifier l'inventaire physique, la méthode de valorisation et les mouvements après clôture.",
              userContext: getUserContext(details, usefulInfo, ["stocks"]),
            }),
            confidence: 0.9,
            source: "grandLivre",
            status: "À valider",
          });
        });
    });

    if (!stockFound) {
      anomalies.push({
        type: "stock_not_found",
        label: "Stock déclaré mais aucune variation de stock exploitable détectée",
        level: "warning",
      });
    }
  }

  // Amortissements
  if (hasAcc(["281", "681"]) && answers.immo === "yes") {
    const amortRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("6811") ||
        compte.startsWith("68112") ||
        text.includes("dotation amortissement") ||
        text.includes("dotation aux amortissements");
    });

    if (amortRows.length) {
      amortRows
        .filter(row => getCompte(row).startsWith("681"))
        .forEach(row => {
          const credit = activity.includes("location meuble") ? "281300" : "281830";
          entries.push(makeEntryFromRow(row, {
            label: "Dotation amortissement",
            debit: "681120",
            credit,
            justification: odJustification({
              detection: "Dotation aux amortissements détectée dans le grand livre.",
              rules: [
                "une immobilisation amortissable doit être consommée sur sa durée d'utilisation",
                "la dotation de l'exercice est comptabilisée en 68112",
                "l'amortissement cumulé est suivi en compte 28",
              ],
              proposedEntry: `Débit 681120 - Dotation aux amortissements\nCrédit ${credit} - Amortissement de l'immobilisation\nMontant : ${formatEuro(getAmount(row))}`,
              controls: "Vérifier le tableau d'amortissement, la date de mise en service et la durée retenue.",
              userContext: getUserContext(details, usefulInfo, ["immo"]),
            }),
            confidence: 0.9,
          }));
        });
    } else {
      const amortRow = findBalanceRow(balanceRows, ["681"]) || findBalanceRow(balanceRows, ["281"]);
      const amount = amortRow ? getAmount(amortRow) : 0;
      const credit = activity.includes("location meuble") ? "281300" : "281830";

      entries.push({
        journal: "OD",
        label: "Dotation amortissement",
        debit: "681120",
        credit,
        amount: amount || "À contrôler",
        justification: odJustification({
          detection: "Amortissement détecté dans la balance.",
          rules: [
            "les immobilisations amortissables doivent faire l'objet d'une dotation annuelle",
            "la dotation doit être rapprochée du tableau d'amortissement",
            "le compte 28 doit correspondre à la nature de l'immobilisation",
          ],
          proposedEntry: `Débit 681120 - Dotation aux amortissements\nCrédit ${credit} - Amortissement de l'immobilisation\nMontant : ${formatEuro(amount)}`,
          controls: "Vérifier le tableau d'amortissement, les acquisitions, sorties et mises en service de l'exercice.",
          userContext: getUserContext(details, usefulInfo, ["immo"]),
        }),
        confidence: amount ? 0.9 : 0.65,
        source: "balance",
        status: "À valider",
      });
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

Règles appliquées :
- le compte 455 doit être justifié par associé ;
- les apports et remboursements doivent être rapprochés de la banque ;
- les intérêts éventuels doivent être documentés ;
- un compte courant débiteur est une situation sensible à analyser.

Contrôles à effectuer :
- vérifier que le solde est justifié ;
- contrôler les apports et remboursements ;
- vérifier les intérêts éventuellement comptabilisés ;
- documenter tout solde débiteur.${getUserContext(details, usefulInfo, ["immo", "provisions"])}`,
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

Règles appliquées :
- les comptes 471/472 sont des comptes transitoires ;
- ils ne doivent pas rester non justifiés à la clôture ;
- les écritures anciennes ou sans libellé exploitable doivent être régularisées ;
- un solde significatif pénalise la qualité de clôture.

Contrôles à effectuer :
- identifier l'origine des soldes ;
- régulariser avant clôture si possible ;
- vérifier l'absence d'anciens mouvements ;
- contrôler qu'il ne s'agit pas d'erreurs d'imputation.

Cliquer sur « Voir » pour afficher le détail des mouvements.${ctxAll}`,
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

Règles appliquées :
- le compte 23 reçoit les immobilisations non terminées ou non mises en service ;
- aucune dotation aux amortissements ne doit être pratiquée tant que le bien n'est pas mis en service ;
- si le bien est achevé, il doit être transféré en compte 21 ;
- le transfert en 21 déclenche ensuite le plan d'amortissement.

Contrôles à effectuer :
- vérifier si les immobilisations sont toujours en cours à la clôture ;
- transférer en compte 21 si le bien est mis en service ;
- vérifier l'absence d'amortissement avant mise en service ;
- rapprocher les montants des factures et situations de travaux.${getUserContext(details, usefulInfo, ["immo"])}`,
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

      const bruteRow = balanceRows.find(row =>
        accountStarts(row, ["21"]) &&
        getRowText(row).includes(normalizeText(assetName))
      ) || findBalanceRow(balanceRows, ["21"]);

      const amortRow = balanceRows.find(row =>
        accountStarts(row, ["28"]) &&
        getRowText(row).includes(normalizeText(assetName))
      ) || findBalanceRow(balanceRows, ["28"]);

      const bruteAmount =
        getAssetValue(assetRow, ["brut", "valeur brute", "acquisition"]) ||
        (bruteRow ? getAmount(bruteRow) : 0);

      const amortAmount =
        getAssetValue(assetRow, ["amortissement", "amortissements cumulés", "cumule"]) ||
        (amortRow ? getAmount(amortRow) : 0);

      const calculatedVnc =
        getAssetValue(assetRow, ["vnc", "valeur nette"]) ||
        (bruteAmount && amortAmount ? Math.max(0, bruteAmount - amortAmount) : 0);

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
${resultLabel} ESTIMÉE : ${formatEuro(disposalResultAmount)}

Règles appliquées :
- une sortie d'immobilisation nécessite la sortie de la valeur brute ;
- les amortissements cumulés doivent être repris ;
- la VNC est constatée en 675 ;
- le prix de cession est comptabilisé en 775 ;
- la différence entre prix de cession et VNC permet d'identifier la plus ou moins-value.${getUserContext(details, usefulInfo, ["immo"])}`,
        confidence: diff !== null ? 0.95 : 0.55,
        source: "analyse",
      }));

      entries.push({
        journal: "OD",
        label: `Sortie immobilisation - Reprise amortissements - ${assetName}`,
        debit: amortRow ? getCompte(amortRow) : "28xxxx",
        credit: bruteRow ? getCompte(bruteRow) : "21xxxx",
        amount: amortAmount || "À contrôler",
        justification: odJustification({
          detection: "Sortie d'immobilisation : reprise des amortissements cumulés.",
          rules: [
            "les amortissements cumulés doivent être annulés à la sortie du bien",
            "le compte 28 est débité",
            "le compte 21 est crédité pour solder partiellement la valeur brute",
          ],
          proposedEntry: `Débit ${amortRow ? getCompte(amortRow) : "28xxxx"} - Amortissements cumulés\nCrédit ${bruteRow ? getCompte(bruteRow) : "21xxxx"} - Immobilisation brute\nMontant : ${formatEuro(amortAmount)}`,
          controls: "Rapprocher le montant avec le tableau des immobilisations.",
          userContext: getUserContext(details, usefulInfo, ["immo"]),
        }),
        confidence: amortAmount ? 0.8 : 0.55,
        source: assetRow ? "tableau amortissements" : "balance",
        status: "À valider",
      });

      entries.push({
        journal: "OD",
        label: `Sortie immobilisation - VNC - ${assetName}`,
        debit: "675000",
        credit: bruteRow ? getCompte(bruteRow) : "21xxxx",
        amount: retainedVnc,
        justification: odJustification({
          detection: "Sortie d'immobilisation : constatation de la valeur nette comptable.",
          rules: [
            "la VNC correspond à la valeur brute diminuée des amortissements cumulés",
            "la VNC est comptabilisée en charge au compte 675",
            "le compte 21 est soldé pour finaliser la sortie d'actif",
          ],
          proposedEntry: `Débit 675000 - Valeur nette comptable des éléments d'actif cédés\nCrédit ${bruteRow ? getCompte(bruteRow) : "21xxxx"} - Immobilisation brute\nMontant : ${formatEuro(retainedVnc)}`,
          controls: "Vérifier la facture de cession, la date de sortie et le tableau des immobilisations.",
          userContext: getUserContext(details, usefulInfo, ["immo"]),
        }),
        confidence: retainedVnc !== "À contrôler" ? 0.8 : 0.55,
        source: assetRow ? "tableau amortissements" : "balance/grandLivre",
        status: "À valider",
      });

      controls.push({ type: "fixed_asset_disposal_detected", label: "Sortie d'immobilisation détectée", level: "warning" });
    });
  }

  // Paie : congés payés
  if (hasAcc(["428"]) && answers.paie === "yes") {
    const amount428 = getBalanceAmount(["428"]) || 0;
    const payrollRate = detectPayrollRate(balanceRows, grandLivreRows);
    const socialAmount = payrollRate ? Math.round(amount428 * payrollRate) : "À contrôler";

    entries.push({
      journal: "OD",
      label: "Congés payés à payer - charge salariale",
      debit: "641000",
      credit: "428200",
      amount: amount428 || "À contrôler",
      justification: odJustification({
        detection: "Compte 428 détecté : congés payés ou éléments de paie à rattacher.",
        rules: [
          "les droits acquis par les salariés à la clôture doivent être provisionnés",
          "la charge salariale est comptabilisée en 641",
          "la dette envers le personnel est comptabilisée en 428",
          "les charges sociales associées doivent être estimées séparément",
        ],
        proposedEntry: `Débit 641000 - Congés payés à payer\nCrédit 428200 - Dettes provisionnées pour congés payés\nMontant : ${formatEuro(amount428)}`,
        controls: "Vérifier l'état des congés payés, le compteur salarié et la cohérence avec la paie.",
        userContext: getUserContext(details, usefulInfo, ["paie"]),
      }),
      confidence: 0.85,
      source: "balance",
      status: "À valider",
    });

    entries.push({
      journal: "OD",
      label: "Charges sociales sur congés payés",
      debit: "645000",
      credit: "438600",
      amount: socialAmount,
      justification: odJustification({
        detection: payrollRate
          ? `Charges sociales estimées à partir du taux historique détecté : ${Math.round(payrollRate * 100)} %.`
          : "Charges sociales sur congés payés à calculer : comptes 641/645 insuffisants.",
        rules: [
          "les congés payés provisionnés génèrent des charges sociales à payer",
          "la charge sociale est comptabilisée en 645",
          "la dette sociale est comptabilisée en 4386",
          "le montant peut être estimé à partir du taux historique ou du taux de charges applicable",
        ],
        proposedEntry: `Débit 645000 - Charges sociales sur congés payés\nCrédit 438600 - Charges sociales à payer\nMontant : ${formatEuro(socialAmount)}`,
        controls: "Vérifier le taux de charges sociales applicable et les états de paie.",
        userContext: getUserContext(details, usefulInfo, ["paie"]),
      }),
      confidence: payrollRate ? 0.8 : 0.55,
      source: payrollRate ? "balance/grandLivre" : "analyse",
      status: "À valider",
    });
  }

  // Provisions
  if (answers.provisions === "yes") {
    const provisionRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("6815") ||
        text.includes("provision") ||
        text.includes("litige") ||
        text.includes("prudhom") ||
        text.includes("prud'hom") ||
        text.includes("risque");
    });

    const dotationRows = provisionRows.filter(row => getCompte(row).startsWith("6815"));

    if (dotationRows.length) {
      dotationRows.forEach(row => {
        const text = getRowText(row);
        let credit = "151000";
        if (text.includes("prudhom") || text.includes("prud'hom")) credit = "151100";
        if (text.includes("commercial") || text.includes("autre risque")) credit = "151800";

        entries.push(makeEntryFromRow(row, {
          label: "Provision",
          debit: "681500",
          credit,
          justification: odJustification({
            detection: "Provision ou risque détecté dans le grand livre.",
            rules: [
              "un risque probable à la clôture doit être provisionné",
              "la provision est comptabilisée en dotation 6815",
              "le compte 15 dépend de la nature du risque",
              "le montant doit être documenté par une estimation sérieuse",
            ],
            proposedEntry: `Débit 681500 - Dotation aux provisions\nCrédit ${credit} - Provision pour risque\nMontant : ${formatEuro(getAmount(row))}`,
            controls: "Vérifier la probabilité du risque, le montant estimé, les courriers, contrats ou éléments juridiques.",
            userContext: getUserContext(details, usefulInfo, ["provisions"]),
          }),
          confidence: 0.8,
        }));
      });
    } else {
      entries.push({
        journal: "OD",
        label: "Provision à documenter",
        debit: "681500",
        credit: "151000",
        amount: "À documenter",
        justification: odJustification({
          detection: "Provision déclarée par l'utilisateur, mais aucune dotation 6815 exploitable n'a été détectée dans le grand livre.",
          rules: [
            "un risque probable à la clôture doit être provisionné",
            "le montant doit être justifié par une estimation fiable",
            "aucune écriture chiffrée automatique ne peut être générée sans montant exploitable",
          ],
          proposedEntry: "Débit 681500 - Dotation aux provisions\nCrédit 151000 - Provision pour risque\nMontant : à documenter",
          controls: "Documenter le risque, la probabilité, le mode de calcul et les pièces justificatives.",
          userContext: getUserContext(details, usefulInfo, ["provisions"]),
        }),
        confidence: 0.5,
        source: "questionnaire",
        status: "À valider",
      });
    }

    controls.push({ type: "provision_detected", label: "Provision ou risque détecté", level: "info" });
  }

  // Dépréciations
  if (answers.provisions === "yes") {
    const depreciationRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      return compte.startsWith("6816") ||
        compte.startsWith("6817") ||
        text.includes("depreciation") ||
        text.includes("dépréciation") ||
        text.includes("client douteux") ||
        text.includes("stock obsolete") ||
        text.includes("stock obsolète");
    });

    depreciationRows.forEach(row => {
      const compte = getCompte(row);
      const text = getRowText(row);
      let label = "Dépréciation à contrôler";
      let debit = compte || "681600";
      let credit = "491000";

      if (compte.startsWith("68174") || text.includes("client douteux")) {
        label = "Dépréciation client douteux";
        debit = "681740";
        credit = "491000";
      }

      if (compte.startsWith("68173") || text.includes("stock obsolete") || text.includes("stock obsolète")) {
        label = "Dépréciation stock";
        debit = "681730";
        credit = "397000";
      }

      if (compte.startsWith("68162") || text.includes("immobilisation")) {
        label = "Dépréciation immobilisation";
        debit = "681620";
        credit = "290000";
      }

      entries.push(makeEntryFromRow(row, {
        label,
        debit,
        credit,
        justification: odJustification({
          detection: "Dépréciation détectée dans le grand livre.",
          rules: [
            "un actif dont la valeur actuelle est inférieure à la valeur comptable doit être déprécié",
            "la dotation est comptabilisée en 6816/6817 selon la nature de l'actif",
            "le compte de dépréciation dépend de l'actif concerné : 491, 397 ou 29",
            "la dépréciation doit être documentée et revue à chaque clôture",
          ],
          proposedEntry: `Débit ${debit} - Dotation aux dépréciations\nCrédit ${credit} - Dépréciation de l'actif\nMontant : ${formatEuro(getAmount(row))}`,
          controls: "Vérifier la valeur actuelle, les justificatifs de perte de valeur et la méthode de calcul.",
          userContext: getUserContext(details, usefulInfo, ["provisions", "stocks", "clients", "immo"]),
        }),
        confidence: 0.8,
      }));
    });
  }

  // TVA
  if (hasAcc(["44551"])) {
    const vatAmount = getBalanceAmount(["44551"]);
    controls.push({ type: "vat_due_detected", label: "TVA à décaisser détectée", level: "info" });

    entries.push({
      journal: "OD",
      label: "TVA à décaisser à contrôler",
      debit: "445710",
      credit: "445510",
      amount: vatAmount || "À contrôler",
      justification: odJustification({
        detection: "Compte 445510 détecté : TVA à décaisser.",
        rules: [
          "la TVA collectée et la TVA déductible doivent être rapprochées de la déclaration",
          "le compte 445510 correspond à la TVA due à l'État",
          "l'écriture proposée est un contrôle de cohérence, pas une déclaration automatique",
        ],
        proposedEntry: `Débit 445710 - TVA collectée\nCrédit 445510 - TVA à décaisser\nMontant : ${formatEuro(vatAmount)}`,
        controls: "Rapprocher le solde avec la CA3/CA12, les comptes 44566/44571 et les paiements de TVA.",
        userContext: getUserContext(details, usefulInfo, ["fournisseurs", "clients"]),
      }),
      confidence: 0.85,
      source: "balance",
      status: "À valider",
    });
  }

  // Emprunts / ICNE
  if (hasAcc(["164", "661", "1688"]) && answers.immo === "yes") {
    const loanRow = findFirstRowByPrefixes(balanceRows, ["164"]) || findFirstRowByPrefixes(grandLivreRows, ["164"]);
    const interestRow = findFirstRowByPrefixes(balanceRows, ["661"]) || findFirstRowByPrefixes(grandLivreRows, ["661"]);
    const icneRow = findFirstRowByPrefixes(balanceRows, ["1688"]) || findFirstRowByPrefixes(grandLivreRows, ["1688"]);

    const capitalAmount = loanRow ? getAmount(loanRow) : 0;
    const interestAmount = interestRow ? getAmount(interestRow) : 0;
    const icneAmount = icneRow ? getAmount(icneRow) : 0;
    const calculatedIcne = findLoanIcne(empruntRows, closure.endDate);
    const finalIcneAmount = icneAmount || calculatedIcne?.icne || 0;
    const loanEntryAmount = finalIcneAmount || "À calculer";

    entries.push({
      journal: "OD",
      label: "Intérêts courus d'emprunt",
      debit: "661100",
      credit: "168800",
      amount: loanEntryAmount,
      justification: odJustification({
        detection: icneAmount
          ? "Compte 1688 détecté : intérêts courus non échus déjà identifiés dans la balance."
          : calculatedIcne
            ? `ICNE calculé depuis le tableau d'emprunt : ${calculatedIcne.elapsedDays} jours courus / ${calculatedIcne.periodDays} jours de période.`
            : "Compte 1688 absent : ICNE à calculer avec le tableau d'emprunt.",
        rules: [
          "les intérêts courus jusqu'à la date de clôture doivent être rattachés à l'exercice",
          "la charge d'intérêt est comptabilisée en 661100",
          "la dette d'intérêt non échue est comptabilisée en 168800",
          "l'écriture sera extournée en N+1 à l'échéance suivante",
        ],
        proposedEntry: `Débit 661100 - Intérêts courus\nCrédit 168800 - Intérêts courus non échus\nMontant : ${formatEuro(typeof loanEntryAmount === "number" ? loanEntryAmount : 0)}`,
        controls: "Vérifier le tableau d'emprunt, l'échéance suivante, le capital restant dû et les intérêts déjà comptabilisés.",
        userContext: getUserContext(details, usefulInfo, ["immo"]),
      }),
      confidence: icneAmount ? 0.85 : calculatedIcne ? 0.8 : 0.55,
      source: icneAmount ? "balance" : calculatedIcne ? "tableau emprunt" : "analyse",
      status: "À valider",
    });

    entries.push(makeAnalysisEntry({
      label: "Analyse emprunt",
      amount: loanEntryAmount,
      justification: icneAmount
        ? `Emprunt détecté.

Capital restant dû / compte 164 : ${formatEuro(capitalAmount)}
Intérêts comptabilisés / compte 661 : ${formatEuro(interestAmount)}
ICNE repris du compte 1688 : ${formatEuro(icneAmount)}

Règles appliquées :
- le compte 1688 étant présent dans la balance, ce montant est repris directement ;
- aucun recalcul n'est effectué à partir du tableau d'emprunt ;
- vérifier que l'écriture correspond bien aux intérêts courus non échus de l'exercice.${getUserContext(details, usefulInfo, ["immo"])}`
        : calculatedIcne
          ? `Emprunt détecté.

Banque : ${calculatedIcne.bank || "?"}
Référence : ${calculatedIcne.reference || "?"}

Période : ${calculatedIcne.start.toLocaleDateString("fr-FR")} → ${calculatedIcne.due.toLocaleDateString("fr-FR")}
Jours courus : ${calculatedIcne.elapsedDays}
Jours période : ${calculatedIcne.periodDays}
Intérêts de l'échéance : ${formatEuro(calculatedIcne.interest)}
ICNE calculé : ${formatEuro(calculatedIcne.icne)}

Règles appliquées :
- prorata temporis entre le début de période et la clôture ;
- débit 661100 / crédit 168800 ;
- extourne en N+1 à l'échéance suivante.${getUserContext(details, usefulInfo, ["immo"])}`
          : `Emprunt détecté.

Capital restant dû / compte 164 : ${formatEuro(capitalAmount)}
Intérêts comptabilisés / compte 661 : ${formatEuro(interestAmount)}

Impossible de calculer les ICNE automatiquement.
Le tableau d'emprunt est absent ou inexploitable.

Règles appliquées :
- les intérêts courus doivent être calculés au prorata jusqu'à la date de clôture ;
- sans échéancier exploitable, aucune écriture chiffrée fiable ne peut être proposée.${getUserContext(details, usefulInfo, ["immo"])}`,
      confidence: icneAmount ? 0.85 : calculatedIcne ? 0.8 : 0.55,
      source: icneAmount ? "balance" : calculatedIcne ? "tableau emprunt" : "analyse",
    }));

    controls.push({ type: "loan_analysis_detected", label: "Emprunt ou intérêts d'emprunt détectés", level: "info" });
  }

  if (entries.length === 0) {
    anomalies.push({
      type: "no_entries_generated",
      label: "Aucune écriture générée selon les réponses fournies",
      level: "info",
    });
  }

  return { entries: dedupeEntries(entries), controls, anomalies };
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
      const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      return rows.slice(0, 2000);
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

    const detected = detectAccountingEntries(balanceRows, grandLivreRows, amortissementRows, empruntRows, closure);
    controls = [...controls, ...detected.controls];
    anomalies = [...anomalies, ...detected.anomalies];

    await closureRef.set(
      cleanFirestoreObject({
        balance: balanceRows,
        grandLivre: grandLivreRows,
        amortissements: amortissementRows,
        emprunt: empruntRows,
        controls,
        anomalies,
        entries: detected.entries,
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
      entries: detected.entries.length,
      controls: controls.length,
      anomalies: anomalies.length,
    });
  } catch (error) {
    console.error("parseClosureFiles error:", error);
    return res.status(500).json({ error: "Erreur parsing fichiers." });
  }
});
