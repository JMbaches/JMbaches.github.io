// megao-sync.js — Sync automatique Mégao → Firestore
// Tourne via GitHub Actions toutes les 30 min

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse         = require('pdf-parse');
const admin            = require('firebase-admin');
const { randomUUID }   = require('crypto');

const { parseMegaoText, parseMegaoBacheText, classePose, refToId } = require('./megao-parser');
// ↑ Logique de parsing PDF (pure, zéro dépendance Firebase/IMAP) extraite dans
// megao-parser.js le 2026-08-03 — voir ce fichier pour le détail/l'historique des
// règles. AUCUN changement de comportement : copie exacte, vérifiée identique (diff JSON
// byte-à-byte) sur 2 vrais bons de commande avant/après l'extraction. Pas de fixture de
// test committée pour ces PDF : ils contiennent des données client réelles (nom, adresse,
// téléphone) — à ne jamais mettre dans ce repo (public, GitHub Pages).

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
const PD_DEFAULT_FOLDERS = ['Bon de commande', 'Facture', 'Fiche de côte', 'Fiche de fabrication', 'Photos'];

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

// Empêche de ré-uploader/ré-attacher le même PDF plusieurs fois quand un dossier existant
// est retraité (ex. plusieurs passages sur le même email avant sa suppression) — bug réel
// observé en production (jusqu'à 5 copies du même bon de commande sur un même dossier).
function hasSameDoc(existingDocuments, folder, filename) {
  return (existingDocuments || []).some(d => d.folder === folder && d.name === filename);
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

// ─── Créer ou mettre à jour le dossier ───────────────────────────────────────
async function upsertDossier(data, pdfBuffer = null, pdfFilename = '') {
  if (!data.ref) { console.warn('Ref absente — dossier ignoré'); return; }
  // Classement du secteur de pose (JM planifie / Azenco sous-traite / Akena → livraison seule).
  const pose = classePose(data.transport || 'liv_pose', data.cp, data.structure);

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
    // TOUS ces champs sont dérivés à 100% du texte du PDF de CETTE commande (chaque email traité
    // est un document complet, jamais un correctif partiel — l'email est supprimé une fois traité,
    // cf. imap.messageDelete plus bas, donc il n'y a pas de "nouvelle tentative sur les mêmes
    // données" à ménager). Donc TOUJOURS écrasés avec le résultat de ce parse, même redevenu
    // vide — pas de raison de garder une ancienne valeur si la commande a été révisée et ne la
    // contient plus. Mêmes valeurs de repli que la branche de création plus bas, pour que rééditer
    // un dossier existant se comporte comme en créer un nouveau à l'identique.
    // Bug réel trouvé sur le dossier 120470 (2026-07-28) : le PDF dit maintenant "escalier non
    // recouvert" et n'a plus qu'une ligne de lame, mais l'ancien code (qui n'écrasait un champ que
    // s'il avait une nouvelle valeur non vide) gardait l'ancienne ligne d'escalier obsolète pour
    // toujours dans `lamesDetail`.
    // N'est PAS concerné par cette règle (logique séparée, volontairement différente) : `ht` (ne se
    // met à jour que si jamais renseigné — protège un montant contre un recalcul silencieux) et
    // `caillebotisLargeurEstimee`/`statut`/`needPose`/etc. (enrichis par d'autres process que le
    // parse PDF, pas concernés par cette liste).
    const update = {
      client: data.client || '', tel: data.tel || '', email: data.email || '',
      contact: data.contact || '', adresse: data.adresse || '', cp: data.cp || '', ville: data.ville || '',
      structure: data.structure || '', lames: data.lames || '', couleurBouchon: data.couleurBouchon || '',
      typeLame: data.typeLame || '', lamesDetail: data.lamesDetail || null,
      decroche: !!data.decroche, lameEscalier: !!data.lameEscalier,
      pieds: data.pieds || '', alim: data.alim || '', moteur: data.moteur || '',
      escalier: data.escalier || '', decoupe: data.decoupe || '', options: data.options || '',
      remarques: data.remarques || '', autres: data.autres || '',
      transport: pose.transport, needPose: pose.needPose, poseSecteur: pose.poseSecteur,
      largeur: data.largeur || '', longueur: data.longueur || '',
      revendeur: data.revendeur || 'Client particulier', refCommande: data.ref,
      telecommande: data.telecommande || '', gestionSel: data.gestionSel || '',
      passesSangles: data.passesSangles || '', flasqueMurale: data.flasqueMurale || '',
      corniere6060: data.corniere6060 || '', equerresRenfort: data.equerresRenfort || '',
      murHauteur: data.murHauteur || '', murCouleur: data.murCouleur || '',
      poutreCouleur: data.poutreCouleur || '', nombrePoutres: data.nombrePoutres || '',
      caillebotisChoix: data.caillebotisChoix || '', caillebotisProfondeur: data.caillebotisProfondeur || '',
      caillebotisLargeur: data.caillebotisLargeur || '', typeAlimentation: data.typeAlimentation || '',
    };
    // Estimée uniquement quand la valeur qu'on vient d'écrire ci-dessus vient réellement de
    // l'estimation (pas d'un champ déjà rempli à la main resté inchangé par le for ci-dessus).
    if (data.caillebotisLargeur && data.caillebotisLargeurEstimee) update.caillebotisLargeurEstimee = true;
    if (data.ht > 0 && !prev.ht) update.ht = data.ht;
    if (pdfBuffer && pdfFilename && !hasSameDoc(prev.documents, 'Bon de commande', pdfFilename)) {
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
      escalier:    data.escalier   || '',
      decoupe:     data.decoupe    || '',
      options:     data.options    || '',
      lames:       data.lames      || '',
      couleurBouchon: data.couleurBouchon || '',
      typeLame:    data.typeLame   || '',
      lamesDetail: data.lamesDetail || null,
      decroche:    data.decroche   || false,
      lameEscalier: data.lameEscalier || false,
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
      // Volontairement vide à la création : "Date livraison prévue" est une date FUTURE décidée
      // par l'atelier/admin (délai de fabrication), jamais dérivable de la date de commande —
      // la remplir avec dateFrom faisait apparaître TOUT nouveau dossier comme "en retard" dès sa
      // création (bug confirmé par l'utilisateur, 2026-07-22 : d.dateLivraison < today déclenche
      // le badge retard, cf. index.html ligne ~2257). À définir manuellement (f-date-livraison).
      dateLivraison: '',
      transport:   pose.transport,
      poseSecteur: pose.poseSecteur,
      remarques:   data.remarques  || '',
      autres:      data.autres     || '',
      largeur:     data.largeur    || '',
      longueur:    data.longueur   || '',
      // Pas de revendeur détecté dans le bloc en-tête du PDF = vente en direct au client final,
      // pas une valeur manquante — confirmé par l'utilisateur (2026-07-27). "Client particulier"
      // reste compatible avec isParticulier() (substring "particulier"), sans modifier la valeur
      // brute utilisée par la réconciliation Dercya/pose (qui lit `data.revendeur` avant cet appel).
      revendeur:   data.revendeur  || 'Client particulier',
      // Accessoires volet lus directement dans le PDF (cf. deriveChampsAccessoiresVoletDepuisPdf)
      telecommande: data.telecommande || '',
      gestionSel:   data.gestionSel   || '',
      passesSangles: data.passesSangles || '',
      flasqueMurale: data.flasqueMurale || '',
      corniere6060:  data.corniere6060  || '',
      equerresRenfort: data.equerresRenfort || '',
      murHauteur:   data.murHauteur   || '',
      murCouleur:   data.murCouleur   || '',
      poutreCouleur: data.poutreCouleur || '',
      nombrePoutres: data.nombrePoutres || '',
      caillebotisChoix: data.caillebotisChoix || '',
      caillebotisProfondeur: data.caillebotisProfondeur || '',
      caillebotisLargeur: data.caillebotisLargeur || '',
      caillebotisLargeurEstimee: !!(data.caillebotisLargeur && data.caillebotisLargeurEstimee),
      typeAlimentation: data.typeAlimentation || '',
      needPose:    pose.needPose,
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

// Doit rester aligné avec VERIF_ROWS_BACHE dans index.html (dupliqué ici — script Node
// séparé, pas de module partagé avec le front).
const VERIF_ROWS_BACHE = ['Dimensions bâche conformes bassin','Coloris conforme commande','Découpes (aspi/escalier) conformes','Enrouleur conforme','Œillets/finitions','Contrôle qualité soudures','Emballage complet'];

// ─── Créer ou mettre à jour le dossier — bâches ──────────────────────────────
// Fonction sœur de upsertDossier plutôt que branches conditionnelles dedans : champs et
// page "verif" par défaut différents, et pas de logique liv_pose/needPose (jamais de pose
// sur une bâche, cf. index.html isBacheDossier).
async function upsertDossierBache(data, pdfBuffer = null, pdfFilename = '') {
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
                    'structure','bacheModele','bacheGamme','bacheDecoupeEscalier','bacheBarreCharge',
                    'bacheDecoupeAspi','bacheOeilletsSupp','bacheAccessoires','bacheAccessoiresDetail','remarques',
                    'bacheEnrouleur','bacheTransportZone','options','transport','revendeur','refCommande'];
    const update = {};
    for (const f of fields) {
      if (data[f]) update[f] = data[f];
    }
    if (data.ht > 0 && !prev.ht) update.ht = data.ht;
    if (pdfBuffer && pdfFilename && !hasSameDoc(prev.documents, 'Bon de commande', pdfFilename)) {
      const uploaded = await uploadPdfToStorage(pdfBuffer, dosId, pdfFilename);
      update.documents  = admin.firestore.FieldValue.arrayUnion(buildDocEntry(uploaded, pdfFilename, nowAt));
      update.docFolders = admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS);
    }
    update.history = [
      ...(prev.history || []),
      { id: Date.now(), type: 'megao', action: 'Mis à jour depuis Mégao', detail: '', user: 'megao-sync', at: nowAt }
    ];
    await docRef.update(update);
    console.log(`✓ Mis à jour (bâche) : ${dosId} (ref: ${data.ref})`);
  } else {
    let initialDocs = [];
    if (pdfBuffer && pdfFilename) {
      const uploaded = await uploadPdfToStorage(pdfBuffer, dosId, pdfFilename);
      initialDocs = [buildDocEntry(uploaded, pdfFilename, nowAt)];
    }
    await docRef.set({
      type:        'bache',
      client:      data.client     || '',
      tel:         data.tel        || '',
      email:       data.email      || '',
      contact:     data.contact    || '',
      adresse:     data.adresse    || '',
      cp:          data.cp         || '',
      ville:       data.ville      || '',
      contraintes: '',
      structure:   data.structure  || '',
      bacheModele:          data.bacheModele          || '',
      bacheGamme:           data.bacheGamme           || '',
      bacheDecoupeEscalier: data.bacheDecoupeEscalier || '',
      bacheBarreCharge:     data.bacheBarreCharge     || '',
      bacheDecoupeAspi:     data.bacheDecoupeAspi     || '',
      bacheOeilletsSupp:    data.bacheOeilletsSupp    || '',
      bacheAccessoires:     data.bacheAccessoires     || [],
      bacheAccessoiresDetail: data.bacheAccessoiresDetail || [],
      bacheEnrouleur:       data.bacheEnrouleur       || '',
      bacheTransportZone:   data.bacheTransportZone   || '',
      options:     data.options    || '',
      ht:          data.ht         || 0,
      tva:         20,
      ref:          data.ref,
      refCommande:  data.ref,
      devisStatut: 'accepte',
      dateFrom:      data.dateFrom   || today,
      dateTo:        '',
      // Volontairement vide à la création : "Date livraison prévue" est une date FUTURE décidée
      // par l'atelier/admin (délai de fabrication), jamais dérivable de la date de commande —
      // la remplir avec dateFrom faisait apparaître TOUT nouveau dossier comme "en retard" dès sa
      // création (bug confirmé par l'utilisateur, 2026-07-22 : d.dateLivraison < today déclenche
      // le badge retard, cf. index.html ligne ~2257). À définir manuellement (f-date-livraison).
      dateLivraison: '',
      transport:   data.transport  || 'livraison',
      remarques:   data.remarques  || '',
      autres:      '',
      revendeur:   data.revendeur  || 'Client particulier',
      needPose:    false,
      poseDate:    '',
      statut:      'admin',
      createdBy:   'megao-sync',
      pages: [
        { type: 'commande', label: 'Fiche commande', checks: {} },
        { type: 'verif', label: 'Vérification atelier', checks: {}, rows: [...VERIF_ROWS_BACHE] }
      ],
      documents:   initialDocs,
      docFolders:  PD_DEFAULT_FOLDERS,
      history:     [{ id: Date.now(), type: 'création', action: 'Créé automatiquement depuis Mégao', detail: '', user: 'megao-sync', at: nowAt }]
    });
    console.log(`✓ Créé (bâche) : ${dosId} (ref: ${data.ref}, client: ${data.client})`);
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

  // Upload les 2 PDFs (sauf si déjà attachés — évite les doublons en cas de retraitement)
  const existingDocuments = existingSnap.exists ? existingSnap.data().documents : null;
  const docs = [];
  for (const { buf, name } of [
    { buf: dercyaItem.pdfBuffer, name: dercyaItem.pdfFilename },
    { buf: poseItem.pdfBuffer,   name: poseItem.pdfFilename   },
  ]) {
    if (buf && !hasSameDoc(existingDocuments, 'Bon de commande', name)) {
      docs.push(buildDocEntry(await uploadPdfToStorage(buf, dosId, name), name, nowAt));
    }
  }

  if (existingDoc) {
    const prev = existingDoc.data();
    const update = { transport: 'liv_pose', needPose: true };
    if (docs.length > 0) {
      update.documents  = admin.firestore.FieldValue.arrayUnion(...docs);
      update.docFolders = admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS);
    }
    update.history = [...(prev.history || []), {
      id: Date.now(), type: 'megao',
      action: 'Fusionné paire Dercya → liv+pose',
      detail: `${dercyaItem.data.ref} + ${poseItem.data.ref}`,
      user: 'megao-sync', at: nowAt,
    }];
    await pairDocRef.update(update);
    console.log(`✓ Paire Dercya mise à jour : ${dosId}`);
  } else {
    await pairDocRef.set({
      client: data.client || '', tel: data.tel || '', email: data.email || '',
      contact: data.contact || '', adresse: data.adresse || '', cp: data.cp || '',
      ville: data.ville || '', contraintes: '', structure: data.structure || '',
      options: data.options || '', lames: data.lames || '', typeLame: data.typeLame || '', pieds: data.pieds || '',
      alim: data.alim || '', moteur: data.moteur || '', ht: data.ht || 0, tva: 20,
      ref: data.ref, refCommande: data.ref, devisStatut: 'accepte',
      // dateLivraison volontairement vide — voir commentaire détaillé dans upsertDossier/
      // upsertDossierBache ci-dessus (même bug, même fix).
      dateFrom: data.dateFrom || today, dateTo: '', dateLivraison: '',
      transport: 'liv_pose', remarques: data.remarques || '', autres: data.autres || '',
      largeur: data.largeur || '', longueur: data.longueur || '',
      revendeur: data.revendeur || 'Client particulier', needPose: true, poseDate: '', statut: 'admin',
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
    const items      = [];  // { uid, data, pdfBuffer, pdfFilename } — volets
    const bacheItems = [];  // { uid, data, pdfBuffer, pdfFilename } — bâches
    const skipUids   = []; // emails sans PDF ni commande reconnue → marquer lu seulement

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

      if (data.isVolet) {
        items.push({ uid, data, pdfBuffer: pdfAtt.content, pdfFilename: pdfAtt.filename || 'bon-de-commande.pdf' });
        continue;
      }

      const bData = parseMegaoBacheText(pdfData.text);
      if (bData.isBache) {
        console.log(`→ Bâche détectée : ${bData.bacheModele || '(modèle non identifié)'} (${bData.bacheGamme || 'gamme inconnue'})`);
        bacheItems.push({ uid, data: bData, pdfBuffer: pdfAtt.content, pdfFilename: pdfAtt.filename || 'bon-de-commande.pdf' });
        continue;
      }

      console.log(`→ Ni volet ni bâche reconnue — email ignoré`);
      skipUids.push(uid);
    }

    // Marquer lu les emails sans commande reconnue
    for (const uid of skipUids) {
      await imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
    }

    // ── Phase bâches : upsert direct (pas de logique de paire Dercya/pose) ────
    for (const { uid, data, pdfBuffer, pdfFilename } of bacheItems) {
      await upsertDossierBache(data, pdfBuffer, pdfFilename);
      await imap.messageDelete([uid], { uid: true });
      console.log(`Email supprimé`);
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
            if (pdfBuffer && !hasSameDoc(prev.documents, 'Bon de commande', pdfFilename)) {
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
