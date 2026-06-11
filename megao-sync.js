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
// Reprend la même logique que le parser navigateur dans index.html
function parseMegaoText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Valeur après un label (même ligne ou ligne suivante si non-label)
  const after = (re) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      const rest = lines[i].slice(m.index + m[0].length).replace(/^\s*:?\s*/, '').trim();
      if (rest) return rest;
      const nxt = (lines[i + 1] || '').trim();
      if (nxt && !/^[A-ZÉÈÊÀÂÙÎÔË ]{3,}\s*:/.test(nxt)) return nxt;
    }
    return '';
  };

  // Ref : "COMMANDE N° 114308-01/1"
  const refM = text.match(/COMMANDE\s+N[°º]\s*([A-Z0-9\-\/]+)/i) ||
               text.match(/\b(\d{5,6}-\d{2}\/\d+)\b/);

  // Client : "0289.2 / Sheltom" → partie après "/"
  const clientRaw = after(/\bCLIENT\b/i);
  const client = clientRaw.includes('/') ? clientRaw.split('/').slice(1).join('/').trim() : clientRaw;

  // Bloc EXPÉDITION : contact, adresse, cp, ville, tel, email
  let contact = '', adresse = '', cp = '', ville = '', tel = '', email = '';
  const expIdx = lines.findIndex(l => /EXP[ÉE]DITION\s*:?/i.test(l));
  if (expIdx >= 0) {
    const expLines = [];
    for (let j = expIdx; j < Math.min(expIdx + 12, lines.length); j++) {
      const raw = j === expIdx
        ? lines[j].replace(/.*EXP[ÉE]DITION\s*:?\s*/i, '').trim()
        : lines[j].trim();
      if (!raw) continue;
      if (j > expIdx && /^(?:ALIM|LAMES|PIEDS|MOTEUR|PUISSANCE|REMARQUES|OPTIONS|AUTRES|V[ÉE]RIF)\s*:/i.test(raw)) break;
      expLines.push(raw);
    }
    for (const l of expLines) {
      if (/^T[ÉE]L\s*:/i.test(l))  { tel   = l.replace(/^T[ÉE]L\s*:?\s*/i, '').replace(/\s*\/\s*$/, '').trim(); continue; }
      if (/^E-?MAIL\s*:/i.test(l))  { email = l.replace(/^E-?MAIL\s*:?\s*/i, '').trim(); continue; }
      if (/[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i.test(l) && !email) { email = (l.match(/[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i) || [''])[0]; continue; }
      if (/^FRANCE$/i.test(l)) continue;
      const cpVm = l.match(/^(\d{5})\s+(.+)/);
      if (cpVm) { cp = cpVm[1]; ville = cpVm[2].trim(); continue; }
      if (!contact) { contact = l; continue; }
      if (!adresse) { adresse = l; continue; }
    }
  }
  if (!tel)   tel   = after(/\bT[ÉE]L(?:[ÉE]PHONE)?\b/i);
  if (!email) email = (text.match(/[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i) || [''])[0];
  if (!cp) {
    const cpV = text.match(/\b(\d{5})\s+((?:[A-ZÉÈÊÀÂÙÎÔË][A-Za-zéèêàâùîôëùü\-]+(?:\s|$))+)/);
    if (cpV) { cp = cpV[1]; if (!ville) ville = cpV[2].trim(); }
  }

  // Transport → code interne
  const trM = text.match(/\b(LIV(?:RAISON)?\s*\+\s*POSE|ENLV[ÈE]VEMENT|ENLVT|LIVRAISON)\b/i);
  const trRaw = trM ? trM[1].toUpperCase() : '';
  const transport = trRaw.includes('POSE') ? 'liv_pose'
    : trRaw.includes('ENLV') ? 'enlvt'
    : trRaw === 'LIVRAISON' ? 'livraison'
    : 'liv_pose';

  return {
    ref:       refM ? (refM[1] || '').trim() : '',
    client, tel, email, contact, adresse, cp, ville,
    structure: after(/TYPE\s+DE\s+STRUCTURE\b/i) || after(/\bSTRUCTURE\b/i),
    lames:     after(/\bLAMES?\b/i),
    pieds:     after(/\bPIEDS?\b/i),
    alim:      after(/\bALIM(?:ENTATION)?\b/i),
    moteur:    after(/PUISSANCE\s+MOTEUR\b/i) || after(/\bMOTEUR\b/i),
    transport,
    options:   after(/\bOPTIONS?\b/i),
    remarques: after(/\bREMARQUES?\b/i),
    autres:    after(/\bAUTRES?\b/i),
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
    // Mise à jour — ne touche pas au statut, devisStatut, dateFrom, dateLivraison, history existant
    const doc    = existing.docs[0];
    const prev   = doc.data();
    const fields = ['client','tel','email','contact','adresse','cp','ville',
                    'structure','lames','pieds','alim','moteur','options','remarques','autres','transport'];
    const update = {};
    for (const f of fields) {
      if (data[f]) update[f] = data[f];   // n'écrase que si la nouvelle valeur n'est pas vide
    }
    update.history = [
      ...(prev.history || []),
      { type: 'megao', action: 'Mis à jour depuis Mégao', date: now }
    ];
    await doc.ref.update(update);
    console.log(`✓ Mis à jour : ${doc.id} (ref: ${data.ref})`);
  } else {
    // Création
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
      ht:          0,
      tva:         20,
      ref:         data.ref,
      devisStatut: 'accepte',
      dateFrom:    today,
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
      // Télécharger le message complet
      const msg    = await imap.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);

      // Trouver la pièce jointe PDF
      const pdfAtt = parsed.attachments.find(a =>
        a.contentType === 'application/pdf' ||
        (a.filename || '').toLowerCase().endsWith('.pdf')
      );

      if (!pdfAtt) {
        console.log(`Aucun PDF dans : "${parsed.subject}" — email ignoré`);
        await imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        continue;
      }

      console.log(`PDF trouvé : ${pdfAtt.filename} (${Math.round(pdfAtt.size / 1024)}ko)`);

      // Parser le PDF
      const pdfData = await pdfParse(pdfAtt.content);
      console.log(`Texte extrait : ${pdfData.text.length} caractères`);

      const data = parseMegaoText(pdfData.text);
      console.log(`Ref: ${data.ref || '(non trouvée)'} | Client: ${data.client || '(non trouvé)'}`);

      // Créer ou mettre à jour le dossier
      await upsertDossier(data);

      // Supprimer l'email
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
