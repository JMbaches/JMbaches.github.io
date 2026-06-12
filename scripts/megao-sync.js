// megao-sync.js — Sync automatique Mégao → Firestore
// Tourne via GitHub Actions toutes les 30 min

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse         = require('pdf-parse');
const admin            = require('firebase-admin');

// ─── Firebase ────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── Parser PDF Mégao ────────────────────────────────────────────────────────
// Format réel : tableau de codes produits (VRSIL80S, LAM350, TRSPVR5…)
// Infos client dans le bloc Contact (colonne gauche)
function parseMegaoText(text) {
  // pdf-parse colle le code et la désignation sans espace : VRSIL80SStucture...
  // Le client apparaît directement après COMMANDE N°

  const refM = text.match(/COMMANDE\s+N[°º]\s*([A-Z0-9\-\/]+)/i);
  const ref  = refM ? refM[1].trim() : '';

  const dateM    = text.match(/Date\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  const dateFrom = dateM ? `${dateM[3]}-${dateM[2]}-${dateM[1]}` : '';

  // Codes produits en début de ligne, collés à la désignation
  // Backtracking : VR[A-Z0-9]+ greedy, recule jusqu'à trouver [A-Z][a-zÀ-ÿ]
  const isVolet   = /^(VR[A-Z0-9]|LAM\d)/m.test(text);
  const vrM       = text.match(/^(VR[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  const lamM      = text.match(/^(LAM[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  const trspM     = text.match(/^(TRSP[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  const structure = vrM  ? vrM[2].replace(/\s*(UN|ML|M2|PCS)\s+.*$/i, '').trim() : '';
  const lames     = lamM ? lamM[2].replace(/\s*(UN|ML|M2|PCS)\s+.*$/i, '').trim() : '';

  let transport = 'liv_pose';
  if (trspM) {
    const d = trspM[2].toUpperCase();
    transport = d.includes('ENLV') ? 'enlvt' : d.includes('POSE') ? 'liv_pose' : 'livraison';
  }

  const telM   = text.match(/T[eé]l\s*:\s*([\d\s.\-\/]+?)(?=\s*\n)/im);
  const tel    = telM ? telM[1].replace(/\s*\/\s*$/, '').trim() : '';
  const emailM = text.match(/E-?mail\s*:\s*([\w.+\-]+@[\w.\-]+\.[a-z]{2,})/i)
              || text.match(/([\w.+\-]+@[\w.\-]+\.[a-z]{2,})/i);
  const email  = emailM ? emailM[1].trim() : '';

  // Client : bloc juste après COMMANDE N° (pdf-parse sort les lignes en colonnes)
  let client = '', contact = '', adresse = '', cp = '', ville = '';
  if (refM) {
    const afterRef = text.slice(refM.index + refM[0].length);
    for (const l of afterRef.split('\n').map(s => s.trim()).filter(Boolean)) {
      if (/^(page\s*:|code\s*client|repr[eé]sentant|r[eé]f[eé]rences|d[eé]lai|t[eé]l|e-?mail|contact\b|d[eé]signation|bulles)/i.test(l)) break;
      if (/^france$/i.test(l)) continue;
      const cpVm = l.match(/^(\d{5})\s+([A-ZÀ-Ÿ][^\n]+)/);
      if (cpVm) { cp = cpVm[1]; ville = cpVm[2].trim(); continue; }
      if (!client)  { client = l; contact = l; continue; }
      if (!adresse) { adresse = l; continue; }
    }
  }

  // HT : "Net HT\n 1 823,84" (valeur sur la ligne suivante dans pdf-parse)
  const htM = text.match(/Net\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i)
           || text.match(/Total\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i);
  const ht  = htM ? parseFloat(htM[1].replace(/\s/g, '').replace(',', '.')) : 0;

  return {
    ref, client, contact, tel, email, adresse, cp, ville,
    structure, lames, pieds: '', alim: '', moteur: '',
    options: '', remarques: '', autres: '',
    transport, ht, dateFrom, isVolet,
  };
}

// ─── Génération ID dossier ────────────────────────────────────────────────────
async function getNextDosId() {
  const year = new Date().getFullYear();
  const snap = await db.collection('dossiers')
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
    .limit(1)
    .get();
  if (snap.empty) return `D-${year}-001`;
  const match = snap.docs[0].id.match(/D-(\d{4})-(\d+)/);
  if (!match) return `D-${year}-001`;
  const [, lastYear, lastNum] = match;
  if (parseInt(lastYear) === year) return `D-${year}-${String(parseInt(lastNum) + 1).padStart(3, '0')}`;
  return `D-${year}-001`;
}

// ─── Créer ou mettre à jour le dossier ───────────────────────────────────────
async function upsertDossier(data) {
  if (!data.ref) { console.warn('Ref absente — dossier ignoré'); return; }

  const now   = new Date().toISOString();
  const today = now.split('T')[0];

  const existing = await db.collection('dossiers').where('ref', '==', data.ref).limit(1).get();

  if (!existing.empty) {
    const doc    = existing.docs[0];
    const prev   = doc.data();
    const fields = ['client','tel','email','contact','adresse','cp','ville',
                    'structure','lames','pieds','alim','moteur','options','remarques','autres','transport'];
    const update = {};
    for (const f of fields) {
      if (data[f]) update[f] = data[f];
    }
    if (data.ht > 0 && !prev.ht) update.ht = data.ht;
    update.history = [
      ...(prev.history || []),
      { type: 'megao', action: 'Mis à jour depuis Mégao', date: now }
    ];
    await doc.ref.update(update);
    console.log(`✓ Mis à jour : ${doc.id} (ref: ${data.ref})`);
  } else {
    const id = await getNextDosId();
    await db.collection('dossiers').doc(id).set({
      client:      data.client     || '',
      tel:         data.tel        || '',
      email:       data.email      || '',
      contact:     data.contact    || '',
      adresse:     data.adresse    || '',
      cp:          data.cp         || '',
      ville:       data.ville      || '',
      contraintes: '',
      structure:   data.structure  || '',
      options:     data.options    || '',
      lames:       data.lames      || '',
      pieds:       data.pieds      || '',
      alim:        data.alim       || '',
      moteur:      data.moteur     || '',
      ht:          data.ht         || 0,
      tva:         20,
      ref:         data.ref,
      devisStatut: 'accepte',
      dateFrom:    data.dateFrom   || today,
      dateTo:      '',
      dateLivraison: '',
      transport:   data.transport  || 'liv_pose',
      remarques:   data.remarques  || '',
      autres:      data.autres     || '',
      needPose:    data.transport  === 'liv_pose',
      poseDate:    '',
      statut:      'nouveau',
      createdBy:   'megao-sync',
      history:     [{ type: 'megao', action: 'Créé automatiquement depuis Mégao', date: now }]
    });
    console.log(`✓ Créé : ${id} (ref: ${data.ref}, client: ${data.client})`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Démarrage sync Mégao…`);

  const imap = new ImapFlow({
    host:   'imap.gmail.com',
    port:   993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
    logger: false,
  });

  await imap.connect();
  const lock = await imap.getMailboxLock('INBOX');

  try {
    const uids = await imap.search({ seen: false }, { uid: true });
    console.log(`${uids.length} email(s) non lu(s) trouvé(s)`);

    for (const uid of uids) {
      const msg    = await imap.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);

      const pdfAtt = parsed.attachments.find(a =>
        a.contentType === 'application/pdf' ||
        (a.filename || '').toLowerCase().endsWith('.pdf')
      );

      if (!pdfAtt) {
        console.log(`Aucun PDF dans : "${parsed.subject}" — email marqué lu`);
        await imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        continue;
      }

      console.log(`PDF trouvé : ${pdfAtt.filename} (${Math.round(pdfAtt.size / 1024)}ko)`);

      const pdfData = await pdfParse(pdfAtt.content);
      console.log(`Texte extrait : ${pdfData.text.length} caractères`);

      const data = parseMegaoText(pdfData.text);
      console.log(`Ref: ${data.ref || '(non trouvée)'} | Client: ${data.client || '(non trouvé)'} | Volet: ${data.isVolet}`);

      if (!data.isVolet) {
        console.log(`→ Pas un volet (aucun code LAM* ou VR*) — email ignoré`);
        await imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        continue;
      }

      await upsertDossier(data);
      await imap.messageDelete([uid], { uid: true });
      console.log(`Email supprimé`);
    }

    console.log(`[${new Date().toISOString()}] Sync terminée`);
  } finally {
    lock.release();
    await imap.logout();
  }
}

main().catch(e => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});
