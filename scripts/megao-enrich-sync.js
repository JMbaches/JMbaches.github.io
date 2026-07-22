// megao-enrich-sync.js — Enrichissement des dossiers existants avec les données
// lues directement dans la base Mégao (accessoires + notes), en plus de la sync
// PDF habituelle (megao-sync.js). Tourne dans le même workflow, AVANT
// megao-sync.js (voir megao-sync.yml) pour que les emails d'enrichissement
// soient consommés avant que megao-sync.js ne les ignore (pas de PJ PDF).
//
// Ce script ne CRÉE jamais de dossier — uniquement des dossiers déjà créés par
// la sync PDF habituelle (megao-sync.js), identifiés par le même ID
// (référence Mégao). Si un dossier n'existe pas encore, l'enrichissement de
// cette commande est ignoré (elle sera traitée au prochain passage, une fois
// le dossier créé par la sync PDF).
//
// Contrat de l'email envoyé par le script côté VM (scripts/megao_enrich_vm.py) :
//   - Sujet exact : "MEGAO-ENRICHISSEMENT"
//   - 1 pièce jointe .json au format :
//     {
//       "generatedAt": "2026-07-20T18:00:00.000Z",
//       "windowDays": 90,
//       "orders": {
//         "120779": {
//           "accessoires": { "<categorie>": [{ "codeart", "design", "qte" }, ...], ... },
//           "notes": [{ "numligne": 11, "texte": "..." }, ...]
//         }
//       }
//     }

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const admin            = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const SUBJECT_MARKER = 'MEGAO-ENRICHISSEMENT';

// Même normalisation d'ID que megao-sync.js — les refs Mégao ici sont de
// simples entiers (Numcmdc), donc no-op en pratique, gardé pour cohérence.
function refToId(ref) {
  return (ref || '').replace(/\//g, '-').replace(/\s+/g, '_').trim();
}

function summarizeAccessoires(accessoires) {
  const summary = {};
  for (const [categorie, lignes] of Object.entries(accessoires || {})) {
    summary[categorie] = lignes.reduce((sum, l) => sum + (l.qte || 0), 0);
  }
  return summary;
}

async function enrichirDossier(numcmdc, payload, nowAt) {
  const dosId  = refToId(String(numcmdc));
  const docRef = db.collection('dossiers').doc(dosId);
  const snap   = await docRef.get();

  if (!snap.exists) {
    console.log(`  → dossier ${dosId} introuvable — enrichissement reporté`);
    return 'absent';
  }

  const prev = snap.data();
  const megaoAccessoires = summarizeAccessoires(payload.accessoires);
  const megaoAccessoiresDetail = payload.accessoires || {};
  const megaoNotes = payload.notes || [];
  // Couleur(s) de bouchon lue(s) sur une ligne Mégao dédiée (peut différer de la couleur des
  // pieds — cf. megao_enrich_vm.py::parse_bouchon_couleur). Purement informatif pour l'instant :
  // ne remplace PAS la déduction existante côté stock.js (BOUCHON_COULEUR_TABLE), qui reste le
  // repli quand Mégao ne précise rien de plus fin.
  const megaoBouchonCouleurs = payload.bouchonCouleurs || [];

  const inchange =
    JSON.stringify(prev.megaoAccessoires || {})       === JSON.stringify(megaoAccessoires) &&
    JSON.stringify(prev.megaoAccessoiresDetail || {}) === JSON.stringify(megaoAccessoiresDetail) &&
    JSON.stringify(prev.megaoNotes || [])              === JSON.stringify(megaoNotes) &&
    JSON.stringify(prev.megaoBouchonCouleurs || [])    === JSON.stringify(megaoBouchonCouleurs);

  if (inchange) {
    console.log(`  → dossier ${dosId} déjà à jour — rien à faire`);
    return 'inchange';
  }

  const update = { megaoAccessoires, megaoAccessoiresDetail, megaoNotes, megaoBouchonCouleurs };
  update.history = [
    ...(prev.history || []),
    { id: Date.now(), type: 'megao', action: 'Enrichissement Mégao (accessoires/notes)', detail: '', user: 'megao-enrich-sync', at: nowAt },
  ];
  await docRef.update(update);
  console.log(`  ✓ dossier ${dosId} enrichi`);
  return 'enrichi';
}

async function main() {
  console.log(`[${new Date().toISOString()}] Démarrage enrichissement Mégao…`);

  const imap = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });

  await imap.connect();
  const lock = await imap.getMailboxLock('INBOX');

  try {
    const uids = await imap.search({ seen: false, subject: SUBJECT_MARKER }, { uid: true });
    console.log(`${uids.length} email(s) d'enrichissement trouvé(s)`);

    for (const uid of uids) {
      const msg    = await imap.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);

      const jsonAtt = parsed.attachments.find(a =>
        a.contentType === 'application/json' || (a.filename || '').toLowerCase().endsWith('.json')
      );
      if (!jsonAtt) {
        console.log(`Email "${parsed.subject}" sans pièce jointe JSON — marqué lu, ignoré`);
        await imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(jsonAtt.content.toString('utf8'));
      } catch (e) {
        console.warn(`JSON invalide dans "${parsed.subject}" — marqué lu, ignoré :`, e.message);
        await imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        continue;
      }

      const nbCommandes = Object.keys(payload.orders || {}).length;
      console.log(`Traitement de ${nbCommandes} commande(s) (généré le ${payload.generatedAt}, fenêtre ${payload.windowDays}j)`);

      const nowDate = new Date();
      const nowAt   = nowDate.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
                    + ' à ' + nowDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

      const stats = { enrichi: 0, inchange: 0, absent: 0 };
      for (const [numcmdc, commande] of Object.entries(payload.orders || {})) {
        const res = await enrichirDossier(numcmdc, commande, nowAt);
        stats[res]++;
      }
      console.log(`Bilan : ${stats.enrichi} enrichis, ${stats.inchange} déjà à jour, ${stats.absent} dossier(s) introuvable(s)`);

      await imap.messageDelete([uid], { uid: true });
      console.log(`Email d'enrichissement supprimé`);
    }

    console.log(`[${new Date().toISOString()}] Enrichissement terminé`);
  } finally {
    lock.release();
    await imap.logout();
  }
}

main().catch(e => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});
