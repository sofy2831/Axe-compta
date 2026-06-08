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

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const { uid, closureId, plan, email } = req.body || {};

      if (!uid || !plan || !email) return res.status(400).json({ error: "Paramètres manquants." });
      if (plan === "one-shot" && !closureId) return res.status(400).json({ error: "closureId manquant." });

      const price = plan === "monthly" ? PRICE_MONTHLY : PRICE_ONE_SHOT;

      const session = await stripe.checkout.sessions.create({
        mode: plan === "monthly" ? "subscription" : "payment",
        payment_method_types: ["card"],
        customer_email: email,
        line_items: [{ price, quantity: 1 }],
        success_url: "https://compta.axe-dossier.fr/merci.html",
        cancel_url: `https://compta.axe-dossier.fr/cloture-resultat.html?id=${closureId || ""}`,
        metadata: { uid, closureId: closureId || "", plan },
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
      event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
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

function getCompte(row) {
  return String(row.Compte || row.compte || "").replace(/\s/g, "");
}

function getLibelle(row) {
  return String(row.Libellé || row.libelle || row.Libelle || "ligne grand livre").trim();
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
    const raw = String(row[key] ?? "").replace(",", ".").replace(/\s/g, "");
    const n = Number(raw);

    if (!Number.isNaN(n) && n !== 0 && Math.abs(n) > 100) return Math.abs(n);
  }

  return 0;
}

function accountStarts(row, prefixes) {
  const compte = getCompte(row);
  return prefixes.some(prefix => compte.startsWith(prefix));
}

function findBalanceRow(balanceRows, prefixes) {
  return balanceRows.find(row => accountStarts(row, prefixes));
}

function cleanEntryLabel(prefix, row) {
  const raw = getLibelle(row);

  let label = raw
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
    .replace(/provision/gi, "")
    .replace(/dépréciation/gi, "")
    .replace(/depreciation/gi, "")
    .replace(/extourne/gi, "")
    .replace(/période suivante/gi, "")
    .replace(/periode suivante/gi, "")
    .replace(/période 2023/gi, "")
    .replace(/periode 2023/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[-–—:\s]+/, "")
    .trim();

  if (!label) label = getLibelle(row);

  return `${prefix} - ${label}`;
}

function makeEntryFromRow(row, config) {
  return {
    journal: "OD",
    label: cleanEntryLabel(config.label, row),
    debit: config.debit,
    credit: config.credit,
    amount: getAmount(row) || "À contrôler",
    justification: config.justification,
    confidence: config.confidence || 0.9,
    source: config.source || "grandLivre",
    status: "À valider"
  };
}

function makeLedgerEntries(rows, config) {
  return rows.map(row => makeEntryFromRow(row, config));
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

function detectAccountingEntries(balanceRows, grandLivreRows, closure = {}) {
  const entries = [];
  const controls = [];
  const anomalies = [];

  const answers = closure.answers || {};
  const activity = normalizeText(closure.activity || "");

  const hasAccount = prefixes =>
    [...balanceRows, ...grandLivreRows].some(row => accountStarts(row, prefixes));

  const getBalanceAmount = prefixes => {
    const row = findBalanceRow(balanceRows, prefixes);
    return row ? getAmount(row) : 0;
  };

  if (hasAccount(["21", "28"])) {
    controls.push({ type: "immobilisation_detected", label: "Immobilisation ou amortissement détecté", level: "info" });
  }

  if (hasAccount(["164", "661"])) {
    controls.push({ type: "loan_detected", label: "Emprunt ou intérêts détectés", level: "info" });
  }

  if (hasAccount(["706", "707"])) {
    controls.push({ type: "revenue_detected", label: "Chiffre d'affaires détecté", level: "info" });
  }

  // FNP : factures non parvenues, lecture multi-lignes côté charges
  if (hasAccount(["408"]) && answers.fournisseurs === "yes") {
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
      entries.push(...makeLedgerEntries(fnpRows, {
        label: "FNP",
        debit: "607000",
        credit: "408100",
        justification: "Facture fournisseur non parvenue détectée dans le grand livre.",
        confidence: 0.9
      }));
    } else {
      entries.push({
        journal: "OD",
        label: "FNP",
        debit: "607000",
        credit: "408100",
        amount: getBalanceAmount(["408"]) || "À contrôler",
        justification: "Compte 408 détecté : facture fournisseur non parvenue à vérifier.",
        confidence: 0.85,
        source: "balance",
        status: "À valider"
      });
    }
  }

  // CCA : charges constatées d'avance
  if (hasAccount(["486"]) && answers.cca === "yes") {
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
      entries.push(...makeLedgerEntries(ccaRows, {
        label: "CCA",
        debit: "486000",
        credit: "616000",
        justification: "Charge constatée d'avance détectée dans le grand livre.",
        confidence: 0.9
      }));
    } else {
      entries.push({
        journal: "OD",
        label: "CCA",
        debit: "486000",
        credit: "616000",
        amount: getBalanceAmount(["486"]) || "À contrôler",
        justification: "Compte 486 détecté : charge couvrant une période postérieure à la clôture.",
        confidence: 0.85,
        source: "balance",
        status: "À valider"
      });
    }
  }

  // PCA : produits constatés d'avance
  if (hasAccount(["487"]) && answers.cca === "yes") {
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
        .forEach(row => {
          entries.push(makeEntryFromRow(row, {
            label: "PCA",
            debit: "706000",
            credit: "487000",
            justification: "Produit constaté d'avance détecté dans le grand livre.",
            confidence: 0.9
          }));
        });
    } else {
      entries.push({
        journal: "OD",
        label: "PCA",
        debit: "706000",
        credit: "487000",
        amount: getBalanceAmount(["487"]) || "À contrôler",
        justification: "Compte 487 détecté : produit rattaché à l'exercice suivant.",
        confidence: 0.85,
        source: "balance",
        status: "À valider"
      });
    }
  }

  // FAE : factures à établir
if (hasAccount(["418"]) && answers.clients === "yes") {
  const faeRows = grandLivreRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);

    return (
      compte.startsWith("4181") ||
      text.includes("fae") ||
      text.includes("facture a etablir") ||
      text.includes("facture à établir")
    );
  });

  if (faeRows.length) {
    faeRows.forEach(row => {
      entries.push(makeEntryFromRow(row, {
        label: "FAE",
        debit: "418100",
        credit: "706000",
        justification: "Facture à établir détectée dans le grand livre.",
        confidence: 0.9
      }));
    });
  } else {
    entries.push({
      journal: "OD",
      label: "FAE",
      debit: "418100",
      credit: "706000",
      amount: getBalanceAmount(["4181"]) || "À contrôler",
      justification: "Compte 418100 détecté : prestation ou vente réalisée avant clôture à facturer.",
      confidence: 0.85,
      source: "balance",
      status: "À valider"
    });
  }
}

  // PAR : produits à recevoir
if (hasAccount(["4187", "4687"]) && answers.clients === "yes") {
  const parRows = grandLivreRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);

    return (
      compte.startsWith("4187") ||
      compte.startsWith("4687") ||
      text.includes("produit a recevoir") ||
      text.includes("produits a recevoir") ||
      text.includes("produit à recevoir") ||
      text.includes("produits à recevoir")
    );
  });

  if (parRows.length) {
    parRows.forEach(row => {
      const compte = getCompte(row);

      entries.push(makeEntryFromRow(row, {
        label: "PAR",
        debit: compte.startsWith("4687") ? "468700" : "418700",
        credit: "706000",
        justification: "Produit à recevoir détecté dans le grand livre.",
        confidence: 0.9
      }));
    });
  } else {
    entries.push({
      journal: "OD",
      label: "PAR",
      debit: "418700",
      credit: "706000",
      amount: getBalanceAmount(["4187", "4687"]) || "À contrôler",
      justification: "Produit à recevoir détecté dans la balance.",
      confidence: 0.85,
      source: "balance",
      status: "À valider"
    });
  }
}

 // CAP : charges à payer hors FNP et hors paie
if (answers.fournisseurs === "yes") {
  const capRows = grandLivreRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);

    return (
      compte.startsWith("448") ||
      compte.startsWith("4686") ||
      text.includes("cap") ||
      text.includes("charge a payer") ||
      text.includes("charge à payer") ||
      text.includes("charges a payer") ||
      text.includes("charges à payer")
    );
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
      justification: "Charge à payer détectée dans le grand livre.",
      confidence: 0.85
    }));
  });
}

   
  // Stocks multi-lignes
  if (answers.stocks === "yes") {
    const stockConfigs = [
      { prefixes: ["6031"], label: "Variation stock matières premières", debit: "310000", credit: "603100" },
      { prefixes: ["6037"], label: "Variation stock marchandises", debit: "370000", credit: "603700" },
      { prefixes: ["7133"], label: "Production stockée travaux en cours", debit: "330000", credit: "713300" },
      { prefixes: ["7135"], label: "Production stockée produits finis", debit: "350000", credit: "713500" }
    ];

    let stockFound = false;

    stockConfigs.forEach(config => {
      const rows = grandLivreRows.filter(row => {
        const compte = getCompte(row);
        return config.prefixes.some(prefix => compte.startsWith(prefix));
      });

      rows.forEach(row => {
        stockFound = true;
        entries.push({
          journal: "OD",
          label: cleanEntryLabel(config.label, row),
          debit: config.debit,
          credit: config.credit,
          amount: getAmount(row) || "À contrôler",
          justification: "Variation de stock détectée dans le grand livre.",
          confidence: 0.9,
          source: "grandLivre",
          status: "À valider"
        });
      });
    });

    if (!stockFound) {
      anomalies.push({
        type: "stock_not_found",
        label: "Stock déclaré mais aucune variation de stock exploitable détectée",
        level: "warning"
      });
    }
  }

  // Amortissements
if (hasAccount(["281", "681"]) && answers.immo === "yes") {
  const amortRows = grandLivreRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);

    return (
      compte.startsWith("6811") ||
      compte.startsWith("68112") ||
      text.includes("dotation amortissement") ||
      text.includes("amortissement")
    );
  });

  if (amortRows.length) {
    amortRows
      .filter(row => getCompte(row).startsWith("681"))
      .forEach(row => {
        const text = getRowText(row);
        const credit = activity.includes("location meuble") ? "281300" : "281830";

        entries.push(makeEntryFromRow(row, {
          label: "Dotation amortissement",
          debit: "681120",
          credit,
          justification: "Dotation amortissement détectée dans le grand livre.",
          confidence: 0.9
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
      justification: "Amortissement détecté dans la balance.",
      confidence: amount ? 0.9 : 0.65,
      source: "balance",
      status: "À valider"
    });
  }
}
  // Paie : congés payés + charges sociales associées
  if (hasAccount(["428"]) && answers.paie === "yes") {
    const amount428 = getBalanceAmount(["428"]) || "À contrôler";

    entries.push({
      journal: "OD",
      label: "Congés payés à payer - charge salariale",
      debit: "641000",
      credit: "428200",
      amount: amount428,
      justification: "Compte 428 détecté : congés payés ou éléments de paie à rattacher à l'exercice.",
      confidence: 0.85,
      source: "balance",
      status: "À valider"
    });

    entries.push({
      journal: "OD",
      label: "Charges sociales sur congés payés à contrôler",
      debit: "645000",
      credit: "438600",
      amount: "À contrôler",
      justification: "Charges sociales afférentes aux congés payés à estimer ou vérifier.",
      confidence: 0.6,
      source: "analyse",
      status: "À valider"
    });
  }

  // Provisions multi-lignes
  if (answers.provisions === "yes") {
    const provisionRows = grandLivreRows.filter(row => {
      const compte = getCompte(row);
      const text = getRowText(row);

      return compte.startsWith("15") ||
        compte.startsWith("6815") ||
        text.includes("provision") ||
        text.includes("litige") ||
        text.includes("risque") ||
        text.includes("client douteux");
    });

    if (provisionRows.length) {
      provisionRows
        .filter(row => getCompte(row).startsWith("6815"))
        .forEach(row => {
          entries.push(makeEntryFromRow(row, {
            label: "Provision",
            debit: "681500",
            credit: "151000",
            justification: "Provision ou risque détecté dans le grand livre.",
            confidence: 0.8
          }));
        });
    } else {
      entries.push({
        journal: "OD",
        label: "Provision à documenter",
        debit: "681500",
        credit: "151000",
        amount: "À documenter",
        justification: "Provision déclarée par l'utilisateur, justificatif ou estimation à fournir.",
        confidence: 0.5,
        source: "questionnaire",
        status: "À valider"
      });
    }
  }

// Dépréciations : clients, stocks, immobilisations
if (answers.provisions === "yes") {
  const depreciationRows = grandLivreRows.filter(row => {
    const compte = getCompte(row);
    const text = getRowText(row);

    // On lit uniquement les comptes de dotation, pas les comptes crédit 491/397/29
    return (
      compte.startsWith("6816") ||
      compte.startsWith("6817") ||
      text.includes("depreciation") ||
      text.includes("dépréciation") ||
      text.includes("client douteux") ||
      text.includes("stock obsolete") ||
      text.includes("stock obsolète")
    );
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
      justification: "Dépréciation détectée dans le grand livre.",
      confidence: 0.8
    }));
  });
}
  
  // TVA
  if (hasAccount(["44551"])) {
    controls.push({ type: "vat_due_detected", label: "TVA à décaisser détectée", level: "info" });

    entries.push({
      journal: "OD",
      label: "TVA à décaisser à contrôler",
      debit: "445710",
      credit: "445510",
      amount: getBalanceAmount(["44551"]) || "À contrôler",
      justification: "Compte 445510 détecté : TVA à décaisser.",
      confidence: 0.85,
      source: "balance",
      status: "À valider"
    });
  }

  // Emprunts / intérêts courus
  if (hasAccount(["164", "661"]) && answers.immo === "yes") {
    entries.push({
      journal: "OD",
      label: "Intérêts d'emprunt à contrôler",
      debit: "661100",
      credit: "168800",
      amount: getBalanceAmount(["661"]) || "À contrôler",
      justification: "Emprunt détecté. Vérifier les intérêts courus non comptabilisés ou les charges financières de l'exercice.",
      confidence: 0.6,
      source: "balance/grandLivre",
      status: "À valider"
    });
  }

  if (entries.length === 0) {
    anomalies.push({
      type: "no_entries_generated",
      label: "Aucune écriture générée selon les réponses fournies",
      level: "info"
    });
  }

  return { entries: dedupeEntries(entries), controls, anomalies };
}

exports.parseClosureFiles = onRequest(
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "https://compta.axe-dossier.fr");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
      const { uid, closureId } = req.body || {};

      if (!uid || !closureId) {
        res.status(400).json({ error: "uid ou closureId manquant." });
        return;
      }

      const db = admin.firestore();
      const bucket = admin.storage().bucket();

      const closureRef = db.collection("users").doc(uid).collection("closures").doc(closureId);
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
        controls.push({ type: "balance_loaded", label: "Balance chargée", count: balanceRows.length });
      } else {
        anomalies.push({ type: "missing_balance", label: "Balance absente ou non exploitable", level: "warning" });
      }

      if (grandLivreRows.length) {
        controls.push({ type: "grand_livre_loaded", label: "Grand livre chargé", count: grandLivreRows.length });
      } else {
        anomalies.push({ type: "missing_grand_livre", label: "Grand livre absent ou non exploitable", level: "warning" });
      }

      const detected = detectAccountingEntries(balanceRows, grandLivreRows, closure);

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
