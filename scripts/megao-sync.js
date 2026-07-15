// megao-sync.js — Sync automatique Mégao → Firestore
// Tourne via GitHub Actions toutes les 30 min

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse         = require('pdf-parse');
const admin            = require('firebase-admin');
const { randomUUID }   = require('crypto');

// ─── Firebase ────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:    admin.credential.cert(serviceAccount),
  storageBucket: 'jm-baches.firebasestorage.app',
});
const db     = admin.firestore();
const bucket = admin.storage().bucket();

// ⚠ Doit rester aligné avec PD_DEFAULT_FOLDERS dans index.html (sans 'Général', que
// l'affichage préfixe déjà — cf. fix doublon b8e7995 — et avec le nom actuel
// 'Fiche de fabrication', renommé depuis 'Fiche produit' en 418b702).
const PD_DEFAULT_FOLDERS = ['Bon de commande', 'Facture', 'Fiche de côte', 'Fiche de fabrication'];

// ─── Parser PDF Mégao ────────────────────────────────────────────────────────
// Format réel : tableau de codes produits (VRSIL80S, LAM350, TRSPVR5…)
// Infos client dans le bloc Contact (colonne gauche)
function parseMegaoText(text) {
  // pdf-parse colle le code et la désignation sans espace : VRSIL80SStucture...
  // Le client apparaît directement après COMMANDE N°

  const refM = text.match(/COMMANDE\s+N[°º]\s*([A-Z0-9\-\/]+)/i);
  const ref  = refM ? refM[1].trim() : '';

  // Revendeur : bloc entre la Date et COMMANDE N° — première ligne tout-majuscules
  const revBlockM = text.match(/Date\s*:[^\n]*\n([\s\S]*?)COMMANDE\s+N[°º]/i);
  let revendeur = '';
  if (revBlockM) {
    const revLines = revBlockM[1].split('\n').map(l => l.trim()).filter(Boolean);
    revendeur = revLines.find(l => /^[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ\s\-&\.]+$/.test(l) && !/^\d+$/.test(l)) || '';
  }

  const dateM    = text.match(/Date\s*:\s*(?:[^\d\n]{0,30}\n\s*)?(\d{2})\/(\d{2})\/(\d{4})/i);
  const dateFrom = dateM ? `${dateM[3]}-${dateM[2]}-${dateM[1]}` : '';

  // Codes produits en début de ligne, collés à la désignation
  // Backtracking : VR[A-Z0-9]+ greedy, recule jusqu'à trouver [A-Z][a-zÀ-ÿ]
  const isVolet   = /^(VR[A-Z0-9]|LAM[A-Z]*\d)/m.test(text);
  const vrM       = text.match(/^(VR[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  const lamM      = text.match(/^(LAM[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  // Type de lame : le code produit distingue PVC (LAM…) et Polycarbonate (LAMPOL…)
  const typeLame  = lamM ? (/POL/i.test(lamM[1]) ? 'Polycarbonate' : 'PVC') : '';
  const trspM     = text.match(/^(TRSP[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  const instM     = text.match(/^(TRSP[A-Z0-9]*(?:PINST|INST)(\d{2,3})[A-Z0-9]*)/im);
  const enlevM    = text.match(/^(ENLEV[A-Z0-9]+)/im);
  const JM_COVER_DEPTS = new Set(['01','04','05','06','07','08','12','13','21','25','26','30','34','38','39','42','43','48','51','52','54','55','57','63','67','68','69','70','71','73','74','83','84','88','90']);
  // Structure : correspondance avec les options du select de l'app
  const vrDesig = vrM ? vrM[2].replace(/\s*(UN|ML|M2|PCS)\s+.*$/i, '').trim() : '';
  const vrCode  = vrM ? vrM[1] : '';
  const vrText  = (vrCode + ' ' + vrDesig).toLowerCase();
  const STRUCT_MAP = [
    { k: ['silver roll','vrsil'],           v: 'Volet hors-sol Silver Roll (2h30)' },
    { k: ['golden roll','solaire','vrsol'],  v: 'Volet hors-sol solaire Golden Roll (2h30)' },
    { k: ['coffre','vrcof'],                v: 'Volet hors-sol avec coffre (2h30)' },
    { k: ['x-trem','xtrem','vrxtr','grand bassin'], v: 'Volet hors-sol grand bassin X-Trem Roll (2h30)' },
    { k: ['mouv','mouv&roll','vrmouv'],     v: 'Volet déplaçable Mouv&Roll (3h)' },
    { k: ['subwater total','vrsubt'],       v: 'Volet immergé Subwater Total (6h30)' },
    { k: ['subwater','vrsub'],              v: 'Volet immergé Subwater (5h)' },
  ];
  const structure = STRUCT_MAP.find(m => m.k.some(k => vrText.includes(k)))?.v
                 || vrDesig
                 || (/tablier\s+seul/i.test(text) ? 'Tablier seul' : '');
  const lameRaw   = lamM ? lamM[2].replace(/\s*(UN|ML|M2|PCS)\s+.*$/i, '').trim() : '';
  const lameParenIdx = lameRaw.lastIndexOf(')');
  const lames     = lameParenIdx >= 0 ? lameRaw.slice(lameParenIdx + 1).trim() : lameRaw;

  // Moteur : suffixe du code VR après le préfixe de structure (VRSIL80S → 80S)
  const moteurM = vrCode.match(/^VR(?:SUBT|SUB|MOUV|XTR|COF|SOL|SIL)([A-Z0-9]+)$/i);
  const moteur  = moteurM ? moteurM[1] : '';

  // Alim + couleur pieds : extraits du bloc de la ligne VR (400 premiers caractères)
  const vrIdx   = vrM ? text.indexOf(vrM[0]) : -1;
  const vrBlock = vrIdx >= 0 ? text.slice(vrIdx, vrIdx + 400) : text;
  const alimM   = vrBlock.match(/\b(\d{2,3})\s*V\b/i);
  const alim    = alimM ? alimM[1] + 'V' : '';
  // Couleur pieds : code RAL 4 chiffres ou nom de couleur après "impultionnelle" ou "RAL"
  const COULEURS = 'blanc|noir|gris|anthracite|beige|marron|brun|ivoire|argent|bronze|bleu|vert|rouge';
  const piedM   = vrBlock.match(new RegExp(`impult\\w*\\s+(\\d{4}|${COULEURS})\\b`, 'i'))
               || vrBlock.match(/\bRAL\s*[-:]?\s*(\d{4})\b/i);
  const piedRaw = piedM ? piedM[1] : '';
  const pieds   = piedRaw ? ((/^\d{4}$/).test(piedRaw) ? `RAL ${piedRaw}` : piedRaw.charAt(0).toUpperCase() + piedRaw.slice(1).toLowerCase()) : '';

  // Largeur depuis le code LAM — chiffre(s) à la fin du code (LAM350→3.50m, LAM45→4.5m, LAM4→4m, LAMPOL4→4m)
  const lamCodeM = text.match(/^LAM[A-Z]*([0-9]+)/m);
  let largeur = '';
  if (lamCodeM) {
    const n = parseInt(lamCodeM[1]);
    largeur = String(lamCodeM[1].length >= 3 ? n / 100 : lamCodeM[1].length === 2 ? n / 10 : n);
  }

  // Longueur : somme des quantités ML de toutes les refs LAM
  // [\s\S]*? pour gérer le cas où ML est sur la ligne suivante (LAMPOL4, etc.)
  const lamLines = [...text.matchAll(/^LAM[A-Z0-9]+[\s\S]*?\bML\s+([\d,]+)/gm)];
  const longueur = lamLines.length
    ? String(lamLines.reduce((sum, m) => sum + parseFloat(m[1].replace(',', '.')), 0))
    : '';

  let transport = 'liv_pose';
  if (enlevM) {
    transport = 'enlvt';
  } else if (instM) {
    const dept = String(parseInt(instM[2])).padStart(2, '0');
    transport  = JM_COVER_DEPTS.has(dept) ? 'liv_pose' : 'livraison';
  } else if (trspM) {
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
    ref, refCommande: ref, client, contact, tel, email, adresse, cp, ville,
    structure, lames, pieds, alim, moteur, typeLame,
    options: '', remarques: '', autres: '',
    largeur, longueur, revendeur,
    transport, ht, dateFrom, isVolet,
  };
}

// ─── Upload PDF vers Firebase Storage ────────────────────────────────────────
async function uploadPdfToStorage(pdfBuffer, dosId, originalFilename) {
  const ts       = Date.now();
  const safeName = originalFilename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path     = `dossiers/${dosId}/${ts}_${safeName}`;
  const file     = bucket.file(path);

  await file.save(pdfBuffer, { metadata: { contentType: 'application/pdf' } });

  const token = randomUUID();
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  return { url, path, size: pdfBuffer.length };
}

function buildDocEntry(uploaded, filename, nowAt) {
  return {
    id:         `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name:       filename,
    url:        uploaded.url,
    path:       uploaded.path,
    type:       'application/pdf',
    size:       uploaded.size,
    folder:     'Bon de commande',
    uploadedBy: 'megao-sync',
    uploadedAt: nowAt,
  };
}

// ─── Helpers Dercya ──────────────────────────────────────────────────────────
const isDercya      = d => /dercya/i.test(d.revendeur || '');
const isParticulier = d => /particulier/i.test(d.revendeur || '');

// ─── Ref Mégao → ID Firestore (remplace "/" par "-") ─────────────────────────
function refToId(ref) {
  return (ref || '').replace(/\//g, '-').replace(/\s+/g, '_').trim();
}

// ─── Créer ou mettre à jour le dossier ───────────────────────────────────────
async function upsertDossier(data, pdfBuffer = null, pdfFilename = '') {
  if (!data.ref) { console.warn('Ref absente — dossier ignoré'); return; }

  const nowDate  = new Date();
  const now      = nowDate.toISOString();
  const today    = now.split('T')[0];
  const nowAt    = nowDate.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'})
                 + ' à ' + nowDate.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});

  const dosId    = refToId(data.ref);
  const docRef   = db.collection('dossiers').doc(dosId);
  const existing = await docRef.get();

  if (existing.exists) {
    const doc    = { id: dosId, ref: docRef };
    const prev   = existing.data();
    const fields = ['client','tel','email','contact','adresse','cp','ville',
                    'structure','lames','typeLame','pieds','alim','moteur','options','remarques','autres','transport',
                    'largeur','longueur','revendeur','refCommande'];
    const update = {};
    for (const f of fields) {
      if (data[f]) update[f] = data[f];
    }
    if (data.ht > 0 && !prev.ht) update.ht = data.ht;
    if (pdfBuffer && pdfFilename) {
      const uploaded = await uploadPdfToStorage(pdfBuffer, dosId, pdfFilename);
      update.documents  = admin.firestore.FieldValue.arrayUnion(buildDocEntry(uploaded, pdfFilename, nowAt));
      update.docFolders = admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS);
    }
    update.history = [
      ...(prev.history || []),
      { id: Date.now(), type: 'megao', action: 'Mis à jour depuis Mégao', detail: '', user: 'megao-sync', at: nowAt }
    ];
    await docRef.update(update);
    console.log(`✓ Mis à jour : ${dosId} (ref: ${data.ref})`);
  } else {
    let initialDocs = [];
    if (pdfBuffer && pdfFilename) {
      const uploaded = await uploadPdfToStorage(pdfBuffer, dosId, pdfFilename);
      initialDocs = [buildDocEntry(uploaded, pdfFilename, nowAt)];
    }
    await docRef.set({
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
      typeLame:    data.typeLame   || '',
      pieds:       data.pieds      || '',
      alim:        data.alim       || '',
      moteur:      data.moteur     || '',
      ht:          data.ht         || 0,
      tva:         20,
      ref:          data.ref,
      refCommande:  data.ref,
      devisStatut: 'accepte',
      dateFrom:      data.dateFrom   || today,
      dateTo:        '',
      dateLivraison: data.dateFrom   || today,
      transport:   data.transport  || 'liv_pose',
      remarques:   data.remarques  || '',
      autres:      data.autres     || '',
      largeur:     data.largeur    || '',
      longueur:    data.longueur   || '',
      revendeur:   data.revendeur  || '',
      needPose:    data.transport  === 'liv_pose',
      poseDate:    '',
      statut:      'admin',
      createdBy:   'megao-sync',
      pages: [
        { type: 'commande', label: 'Fiche commande', checks: {} },
        { type: 'verif', label: 'Vérification atelier', checks: {}, rows: ['Rayons','Pans coupés','Lames coupées','Lames finies','Axe','Contre axe + rails','Découpe ESC en équerre','Découpe ESC en lisse','Poutre + cornière','Cloison','Caillebotis'] }
      ],
      documents:   initialDocs,
      docFolders:  PD_DEFAULT_FOLDERS,
      history:     [{ id: Date.now(), type: 'création', action: 'Créé automatiquement depuis Mégao', detail: '', user: 'megao-sync', at: nowAt }]
    });
    console.log(`✓ Créé : ${dosId} (ref: ${data.ref}, client: ${data.client})`);
  }
}

// ─── Fusion paire Dercya (1 BDC livraison + 1 BDC pose → 1 dossier liv_pose) ──
async function upsertDercyaPair(dercyaItem, poseItem) {
  const nowDate = new Date();
  const today   = nowDate.toISOString().split('T')[0];
  const nowAt   = nowDate.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' })
                + ' à ' + nowDate.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });

  const data = { ...dercyaItem.data, transport: 'liv_pose', needPose: true };

  // L'ID = ref Mégao de la commande Dercya (source principale)
  const dosId      = refToId(dercyaItem.data.ref);
  const pairDocRef = db.collection('dossiers').doc(dosId);
  const existingSnap = await pairDocRef.get();
  const existingDoc  = existingSnap.exists ? { id: dosId, ref: pairDocRef, data: () => existingSnap.data() } : null;

  // Upload les 2 PDFs
  const docs = [];
  for (const { buf, name } of [
    { buf: dercyaItem.pdfBuffer, name: dercyaItem.pdfFilename },
    { buf: poseItem.pdfBuffer,   name: poseItem.pdfFilename   },
  ]) {
    if (buf) docs.push(buildDocEntry(await uploadPdfToStorage(buf, dosId, name), name, nowAt));
  }

  if (existingDoc) {
    const prev = existingDoc.data();
    await pairDocRef.update({
      transport: 'liv_pose', needPose: true,
      documents:  admin.firestore.FieldValue.arrayUnion(...docs),
      docFolders: admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS),
      history: [...(prev.history || []), {
        id: Date.now(), type: 'megao',
        action: 'Fusionné paire Dercya → liv+pose',
        detail: `${dercyaItem.data.ref} + ${poseItem.data.ref}`,
        user: 'megao-sync', at: nowAt,
      }],
    });
    console.log(`✓ Paire Dercya mise à jour : ${dosId}`);
  } else {
    await pairDocRef.set({
      client: data.client || '', tel: data.tel || '', email: data.email || '',
      contact: data.contact || '', adresse: data.adresse || '', cp: data.cp || '',
      ville: data.ville || '', contraintes: '', structure: data.structure || '',
      options: data.options || '', lames: data.lames || '', typeLame: data.typeLame || '', pieds: data.pieds || '',
      alim: data.alim || '', moteur: data.moteur || '', ht: data.ht || 0, tva: 20,
      ref: data.ref, refCommande: data.ref, devisStatut: 'accepte',
      dateFrom: data.dateFrom || today, dateTo: '', dateLivraison: data.dateFrom || today,
      transport: 'liv_pose', remarques: data.remarques || '', autres: data.autres || '',
      largeur: data.largeur || '', longueur: data.longueur || '',
      revendeur: data.revendeur || '', needPose: true, poseDate: '', statut: 'admin',
      createdBy: 'megao-sync',
      pages: [
        { type: 'commande', label: 'Fiche commande', checks: {} },
        { type: 'verif',    label: 'Vérification atelier', checks: {}, rows: ['Rayons','Pans coupés','Lames coupées','Lames finies','Axe','Contre axe + rails','Découpe ESC en équerre','Découpe ESC en lisse','Poutre + cornière','Cloison','Caillebotis'] },
      ],
      documents: docs, docFolders: PD_DEFAULT_FOLDERS,
      history: [{ id: Date.now(), type: 'création', action: 'Créé depuis Mégao — paire Dercya (liv+pose)', detail: `${dercyaItem.data.ref} + ${poseItem.data.ref}`, user: 'megao-sync', at: nowAt }],
    });
    console.log(`✓ Paire Dercya créée : ${dosId} (${dercyaItem.data.ref} + ${poseItem.data.ref})`);
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

    // ── Phase 1 : parser tous les PDFs ────────────────────────────────────────
    const items   = [];  // { uid, data, pdfBuffer, pdfFilename }
    const skipUids = []; // emails sans PDF ou sans volet → marquer lu seulement

    for (const uid of uids) {
      const msg    = await imap.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);

      const pdfAtt = parsed.attachments.find(a =>
        a.contentType === 'application/pdf' ||
        (a.filename || '').toLowerCase().endsWith('.pdf')
      );

      if (!pdfAtt) {
        console.log(`Aucun PDF dans : "${parsed.subject}" — email marqué lu`);
        skipUids.push(uid);
        continue;
      }

      console.log(`PDF trouvé : ${pdfAtt.filename} (${Math.round(pdfAtt.size / 1024)}ko)`);
      const pdfData = await pdfParse(pdfAtt.content);
      const data    = parseMegaoText(pdfData.text);
      console.log(`Ref: ${data.ref || '(non trouvée)'} | Client: ${data.client || '(non trouvé)'} | Revendeur: ${data.revendeur || '—'} | Volet: ${data.isVolet}`);

      if (!data.isVolet) {
        console.log(`→ Pas un volet — email ignoré`);
        skipUids.push(uid);
        continue;
      }

      items.push({ uid, data, pdfBuffer: pdfAtt.content, pdfFilename: pdfAtt.filename || 'bon-de-commande.pdf' });
    }

    // Marquer lu les emails sans volet
    for (const uid of skipUids) {
      await imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
    }

    // ── Phase 2 : détecter les paires Dercya dans ce batch ───────────────────
    const used   = new Set();
    const tasks  = []; // { type: 'pair'|'single', ... }

    for (let i = 0; i < items.length; i++) {
      if (used.has(i)) continue;
      const a = items[i];
      if (isDercya(a.data) || isParticulier(a.data)) {
        const j = items.findIndex((b, idx) =>
          idx !== i && !used.has(idx) &&
          a.data.client && b.data.client &&
          a.data.client.toLowerCase() === b.data.client.toLowerCase() &&
          ((isDercya(a.data) && isParticulier(b.data)) || (isParticulier(a.data) && isDercya(b.data)))
        );
        if (j !== -1) {
          const [dItem, pItem] = isDercya(a.data) ? [a, items[j]] : [items[j], a];
          tasks.push({ type: 'pair', dercya: dItem, pose: pItem });
          used.add(i); used.add(j);
          console.log(`→ Paire Dercya détectée : "${a.data.client}" (${a.data.ref} + ${items[j].data.ref})`);
          continue;
        }
      }
      tasks.push({ type: 'single', item: a });
      used.add(i);
    }

    // ── Phase 3 : upsert ──────────────────────────────────────────────────────
    for (const task of tasks) {
      if (task.type === 'pair') {
        await upsertDercyaPair(task.dercya, task.pose);
        await imap.messageDelete([task.dercya.uid, task.pose.uid], { uid: true });
        console.log(`Emails paire supprimés`);
      } else {
        const { uid, data, pdfBuffer, pdfFilename } = task.item;
        // Fallback cross-batch : si commande "particulier" sans partenaire dans ce batch,
        // chercher en Firestore un dossier Dercya créé aujourd'hui avec le même client.
        if (isParticulier(data) && data.client) {
          const today = new Date().toISOString().split('T')[0];
          const snap  = await db.collection('dossiers')
            .where('client',    '==', data.client)
            .where('dateFrom',  '==', today)
            .where('createdBy', '==', 'megao-sync')
            .limit(1).get();
          if (!snap.empty && isDercya(snap.docs[0].data())) {
            console.log(`→ Commande pose trouvée pour dossier Dercya existant : ${snap.docs[0].id}`);
            const nowDate = new Date();
            const nowAt   = nowDate.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' })
                          + ' à ' + nowDate.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
            const prev    = snap.docs[0].data();
            const update  = { transport: 'liv_pose', needPose: true };
            if (pdfBuffer) {
              const up = await uploadPdfToStorage(pdfBuffer, snap.docs[0].id, pdfFilename);
              update.documents  = admin.firestore.FieldValue.arrayUnion(buildDocEntry(up, pdfFilename, nowAt));
              update.docFolders = admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS);
            }
            update.history = [...(prev.history || []), {
              id: Date.now(), type: 'megao', action: 'Commande pose Dercya fusionnée',
              detail: data.ref, user: 'megao-sync', at: nowAt,
            }];
            await snap.docs[0].ref.update(update);
            await imap.messageDelete([uid], { uid: true });
            console.log(`Email supprimé`);
            continue;
          }
        }
        await upsertDossier(data, pdfBuffer, pdfFilename);
        await imap.messageDelete([uid], { uid: true });
        console.log(`Email supprimé`);
      }
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
