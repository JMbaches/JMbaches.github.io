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

// Dérivation des champs précis lus par le décompte stock legacy (stock.js) — jusqu'ici
// megaoAccessoires/megaoAccessoiresDetail étaient bien capturés et affichés dans la fiche, mais
// AUCUN champ structuré (d.telecommande, d.gestionSel, d.murHauteur...) n'était jamais rempli
// automatiquement (vérifié : 0/83 dossiers volets réels avaient un seul de ces champs renseigné,
// ni auto ni à la main) — le décompte auto de ces pièces "quick win legacy" restait donc inerte
// même si `decompteAutoActif` était réactivé. Codes vérifiés un par un sur CMDCLIB réel
// (2026-07-23) avant d'écrire cette table — voir mémoire projet pour le détail des échantillons.
// Reclasse ICI par préfixe de codeart plutôt que de se fier au bucket VM (megao_enrich_vm.py
// range par erreur ACVRCOFASSER sous 'passes_sangles' — sans conséquence ici puisqu'on regarde
// le codeart brut, peu importe sous quel bucket VM la ligne est arrivée).
const COULEUR_STRUCTURE_RE = /\b(Blanc|Gris|Sable)\b/i;
// Hauteur du mur immergé : code MU1<suffixe> → hauteur, vérifié sur les vrais codes CMDCLIB
// (MU14/15/16 = 1m, MU1254/55/56 = 1,25m, MU1504/05/06 = 1,50m — clé courte '1,5m' pour matcher
// exactement QUANTITES dans stock.js::stockDecompterMur, pas '1,50m'). Pas de code "2m" confirmé
// dans l'échantillon réel — volontairement absent de la table plutôt que deviné.
const MUR_HAUTEUR_PAR_CODE = {
  MU14: '1m', MU15: '1m', MU16: '1m',
  MU1254: '1,25m', MU1255: '1,25m', MU1256: '1,25m',
  MU1504: '1,5m', MU1505: '1,5m', MU1506: '1,5m',
};
function deriveChampsAccessoiresVolet(accessoires) {
  const lignes = Object.values(accessoires || {}).flat();
  const update = {};

  // Télécommande : ACVRTELECOMBL (bluetooth) vs ACVRTELECOM (classique) — un seul choix par
  // dossier en pratique, bluetooth testé en premier car préfixe plus spécifique.
  if (lignes.some(l => l.codeart.startsWith('ACVRTELECOMBL'))) update.telecommande = 'Bluetooth';
  else if (lignes.some(l => l.codeart.startsWith('ACVRTELECOM'))) update.telecommande = 'Classique';

  // Gestion sel : ACCOFASSEROXE = Oxeo, ACVRCOFASSER = Electrolyseur (confirmé par les vraies
  // désignations : "gestion autonome OXEO" vs "Asservissement pour électrolyseur").
  if (lignes.some(l => l.codeart.startsWith('ACCOFASSEROXE'))) update.gestionSel = 'Oxeo';
  else if (lignes.some(l => l.codeart.startsWith('ACVRCOFASSER'))) update.gestionSel = 'Electrolyseur';

  // Passes-sangles : somme des quantités ACVRPASSANG (champ numérique côté app).
  const passesSanglesQte = lignes.filter(l => l.codeart.startsWith('ACVRPASSANG')).reduce((s, l) => s + (l.qte || 0), 0);
  if (passesSanglesQte > 0) update.passesSangles = String(passesSanglesQte);

  // Flasque murale (Oui/Non côté app) : présence de ACVREQUFLASQ.
  if (lignes.some(l => l.codeart.startsWith('ACVREQUFLASQ'))) update.flasqueMurale = 'Oui';

  // Cornière 60x60 (Oui/Non) : présence de ACVRCORN.
  if (lignes.some(l => l.codeart.startsWith('ACVRCORN'))) update.corniere6060 = 'Oui';

  // Équerres de renfort (immergé simple, 1 à 3) : somme des quantités ACVREQUTELESC/ACVREQUROUL —
  // hors de la plage 1-3 (valeur legacy invalide), on ne force pas le champ, cf. stock.js.
  const equerresQte = lignes.filter(l => /^ACVREQU(TELESC|ROUL)/.test(l.codeart)).reduce((s, l) => s + (l.qte || 0), 0);
  if (equerresQte >= 1 && equerresQte <= 3) update.equerresRenfort = String(equerresQte);

  // Mur immergé : hauteur via la table code→hauteur ci-dessus, couleur en cherchant
  // Blanc/Gris/Sable dans la désignation (pas toujours présente sur le vrai texte Mégao — si
  // absente, le champ n'est juste pas rempli, le décompte mur ne se déclenchera pas, jamais de
  // valeur devinée à tort).
  const murLigne = lignes.find(l => MUR_HAUTEUR_PAR_CODE[l.codeart]);
  if (murLigne) {
    update.murHauteur = MUR_HAUTEUR_PAR_CODE[murLigne.codeart];
    const coul = murLigne.design.match(COULEUR_STRUCTURE_RE);
    if (coul) update.murCouleur = coul[1].charAt(0).toUpperCase() + coul[1].slice(1).toLowerCase();
  }

  // Poutre (immergé simple, ACVRPOUTR* hors ACVRPOUTRIN — couleur dans la désignation) / poutre
  // brute (immergé total, ACVRPOUTRIN — quantité 0/1/2, jamais un choix de couleur, cf. stock.js
  // stockDecompterPoutreBrute).
  const poutreLigne = lignes.find(l => l.codeart.startsWith('ACVRPOUTR') && !l.codeart.startsWith('ACVRPOUTRIN'));
  if (poutreLigne) {
    const coul = poutreLigne.design.match(COULEUR_STRUCTURE_RE);
    if (coul) update.poutreCouleur = coul[1].charAt(0).toUpperCase() + coul[1].slice(1).toLowerCase();
  }
  if (lignes.some(l => l.codeart.startsWith('ACVRPOUTRIN'))) {
    const poutreInQte = lignes.filter(l => l.codeart.startsWith('ACVRPOUTRIN')).reduce((s, l) => s + (l.qte || 0), 0);
    if (poutreInQte <= 2) update.nombrePoutres = String(poutreInQte);
  }

  return update;
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
  // Nom client corrigé (lu directement dans CMDCLI.Nomfac côté VM) : uniquement appliqué si le
  // nom ACTUELLEMENT enregistré est manifestement un placeholder d'enlèvement ("ENLEVEMENT",
  // "ENLEVEMENT LE ..."), jamais pour écraser un nom déjà correct (ex. corrigé manuellement) —
  // cf. audit réel 2026-07-22 : plusieurs dossiers avaient le nom du client remplacé par cette
  // instruction plutôt que le vrai nom (disponible via Nomfac, le revendeur).
  const clientCorrigeDisponible = payload.clientCorrige || '';
  const clientActuelPlaceholder = /^enl[eè]vement\b/i.test(prev.client || '');
  const applyClientFix = clientCorrigeDisponible && clientActuelPlaceholder;
  // Option couleur pieds sur ligne dédiée (rare — voir megao_enrich_vm.py::ACCESSORY_PREFIXES,
  // 'pieds_couleur') : signal Mégao explicite et sans ambiguïté quand présent, prioritaire sur
  // la couleur pieds déduite du texte de la ligne structure — appliqué seulement si différent
  // pour ne pas spammer l'historique à chaque passage d'enrichissement.
  const piedsCouleurOption = payload.piedsCouleurOption || '';
  const applyPiedsFix = piedsCouleurOption && piedsCouleurOption !== prev.pieds;

  // Champs précis pour le décompte stock (voir deriveChampsAccessoiresVolet ci-dessus) —
  // uniquement pour les dossiers volets (les bâches ont leur propre système d'accessoires,
  // bacheAccessoiresDetail dans megao-sync.js) et UNIQUEMENT si le champ est encore vide, pour
  // ne jamais écraser une valeur déjà saisie (auto une fois ici, ou manuellement par un admin).
  const isBacheDossier = (prev.type || 'volet') === 'bache';
  const champsDerives = isBacheDossier ? {} : deriveChampsAccessoiresVolet(payload.accessoires);
  const nouveauxChamps = {};
  for (const [k, v] of Object.entries(champsDerives)) {
    if (!prev[k]) nouveauxChamps[k] = v;
  }
  const applyChampsDerives = Object.keys(nouveauxChamps).length > 0;

  const inchange =
    JSON.stringify(prev.megaoAccessoires || {})       === JSON.stringify(megaoAccessoires) &&
    JSON.stringify(prev.megaoAccessoiresDetail || {}) === JSON.stringify(megaoAccessoiresDetail) &&
    JSON.stringify(prev.megaoNotes || [])              === JSON.stringify(megaoNotes) &&
    JSON.stringify(prev.megaoBouchonCouleurs || [])    === JSON.stringify(megaoBouchonCouleurs) &&
    !applyClientFix && !applyPiedsFix && !applyChampsDerives;

  if (inchange) {
    console.log(`  → dossier ${dosId} déjà à jour — rien à faire`);
    return 'inchange';
  }

  const update = { megaoAccessoires, megaoAccessoiresDetail, megaoNotes, megaoBouchonCouleurs, ...nouveauxChamps };
  if (applyChampsDerives) {
    console.log(`  → champs stock dérivés : ${Object.entries(nouveauxChamps).map(([k,v])=>`${k}=${v}`).join(', ')}`);
  }
  if (applyClientFix) {
    update.client = clientCorrigeDisponible;
    update.contact = clientCorrigeDisponible;
    console.log(`  → nom client corrigé : "${prev.client}" → "${clientCorrigeDisponible}"`);
  }
  if (applyPiedsFix) {
    update.pieds = piedsCouleurOption;
    console.log(`  → couleur pieds corrigée : "${prev.pieds || ''}" → "${piedsCouleurOption}"`);
  }
  const actions = ['Enrichissement Mégao (accessoires/notes)'];
  if (applyClientFix) actions.push(`nom client corrigé ("${prev.client}" → "${clientCorrigeDisponible}")`);
  if (applyPiedsFix) actions.push(`couleur pieds corrigée ("${prev.pieds || ''}" → "${piedsCouleurOption}")`);
  if (applyChampsDerives) actions.push(`champs stock renseignés automatiquement : ${Object.entries(nouveauxChamps).map(([k,v])=>`${k}=${v}`).join(', ')}`);
  update.history = [
    ...(prev.history || []),
    { id: Date.now(), type: 'megao', action: actions[0], detail: actions.slice(1).join(' | '), user: 'megao-enrich-sync', at: nowAt },
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
