#!/usr/bin/env node
/* ================================================================
   MISE À JOUR PONCTUELLE — quantités réelles de pièces détachées volet
   ----------------------------------------------------------------
   Même démarche que update-lame-quantites.js, pour les catégories
   "pièces" (aluminium/autre/pied/moteur), à partir d'INVENTAIRE 2025.xlsx
   (feuille "INVENTAIRE VOLETS", fourni par l'utilisateur le 2026-07-22).

   Toutes ces réfs sont aujourd'hui à quantite=0 (ou proche) en production —
   ce script les rafraîchit avec de vraies quantités là où une correspondance
   FIABLE existe avec le libellé déjà utilisé par stock.js (comparaison
   categorie+label, celle utilisée par stockFindPieceRef — jamais modifiée
   ici, seule la quantité change).

   UPDATE-ONLY, volontairement conservateur : seules les lignes où la
   correspondance est sans ambiguïté sont incluses. Beaucoup de lignes de
   l'inventaire n'ont PAS d'équivalent clair dans le catalogue actuel
   (nommage différent, variantes non modélisées) — elles sont laissées de
   côté plutôt que devinées, listées en commentaire ci-dessous pour
   référence future :
     - Moteurs sans réf existante : 120 B, C80, 120 U, 120 S, 300 Cable
       long, 200 XL, 300 S, 300 S + (aucun ne correspond aux codes courts
       déjà en base : 80S, 300, 200 Xtrem).
     - Bouchons lame gauche/droite (ACVRBOUCHBL/ACVRBOUCHCOUL) : aucune
       catégorie stock existante pour ce type de bouchon (la catégorie
       "bouchons" actuelle est pour du 80x80/100x100, un produit différent).
     - Sabots (génériques), Poutres "brut"/"7m"/"brillant", Contre-Axe
       Brut/Gris clair 7035, Palier 200, Capots seul (sans couleur/trous
       précisés) : pas de libellé existant correspondant avec certitude.
     - Axes diamètre 140 à 6.6m et 7m (hors 3.2/4.2/4.7/5.2/5.7/6.2) : pas
       de label "Axe ..." correspondant dans AXE_PAR_LARGEUR_CM.

   Axes diamètre 200 (7.2m→"Axe 200 700", 8.2m→"Axe 200 820") : léger écart
   de notation assumé comme un choix raisonnable (les 2 seules valeurs de
   ce groupe, dans le même ordre que les 2 labels existants) — à confirmer
   avec l'utilisateur si le nombre semble faux à l'usage.

   DRY-RUN PAR DÉFAUT :
     node scripts/update-piece-quantites.js
   Écriture réelle :
     node scripts/update-piece-quantites.js --write
   Service account : /Users/sachajourdan/Downloads/service-account.json
   (ou 1er argument après --write).
   ================================================================ */

const QUANTITES = [
  // Axes diamètre 140 (aluminium)
  { categorie: 'aluminium', label: 'Axe 320', quantite: 141 },
  { categorie: 'aluminium', label: 'Axe 420', quantite: 78 },
  { categorie: 'aluminium', label: 'Axe 470', quantite: 57 },
  { categorie: 'aluminium', label: 'Axe 520', quantite: 69 },
  { categorie: 'aluminium', label: 'Axe 570', quantite: 95 },
  { categorie: 'aluminium', label: 'Axe 620', quantite: 53 },
  // Axes diamètre 200 (aluminium) — voir note ci-dessus sur l'écart de notation
  { categorie: 'aluminium', label: 'Axe 200 700', quantite: 4 },
  { categorie: 'aluminium', label: 'Axe 200 820', quantite: 1 },
  // Paliers (autre)
  { categorie: 'autre', label: 'Palier Hors Sol', quantite: 1183 },
  { categorie: 'autre', label: 'Palier Immerge', quantite: 33 },
  // Contre-Axes (aluminium)
  { categorie: 'aluminium', label: 'Contre Axe Blanc', quantite: 39 },
  { categorie: 'aluminium', label: 'Contre Axe Sable', quantite: 57 },
  { categorie: 'aluminium', label: 'Contre Axe Gris', quantite: 66 },
  { categorie: 'aluminium', label: 'Contre Axe 7016', quantite: 75 },
  // Pieds bruts (pied) — seules variantes couleur avec une vraie quantité (les colorées sont vides dans l'inventaire)
  { categorie: 'pied', label: 'Pied Brut', quantite: 925 },
  { categorie: 'pied', label: 'Pied XTREM Brute', quantite: 29 },
  // Poutres 6m (aluminium)
  { categorie: 'aluminium', label: 'Poutre 6m Sable', quantite: 37 },
  { categorie: 'aluminium', label: 'Poutre 6m Gris', quantite: 6 },
  { categorie: 'aluminium', label: 'Poutre 6m Blanc', quantite: 69 },
  { categorie: 'aluminium', label: 'Poutre 6m 7016', quantite: 78 },
  // Moteurs (moteur) — matchés par CODE Mégao (MOTxxx → xxx), pas par le texte de désignation
  { categorie: 'moteur', label: '120BD', quantite: 15 },
  { categorie: 'moteur', label: '120IM', quantite: 76 },
  { categorie: 'moteur', label: '200S', quantite: 188 },
  { categorie: 'moteur', label: 'C120', quantite: 160 },
];

const WRITE = process.argv.includes('--write');
const saArgIdx = process.argv.indexOf('--write') + 1;
const saPath = (WRITE && process.argv[saArgIdx] && !process.argv[saArgIdx].startsWith('--'))
  ? process.argv[saArgIdx]
  : '/Users/sachajourdan/Downloads/service-account.json';

(async () => {
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
  const db = admin.firestore();

  const snap = await db.collection('stock_refs').get();
  const pieceRefs = snap.docs
    .map(d => ({ docId: d.id, ...d.data() }))
    .filter(r => r.categorie && !r.type);

  const norm = s => String(s || '').trim().toLowerCase();
  const plan = [];
  const introuvables = [];
  for (const q of QUANTITES) {
    const ref = pieceRefs.find(r => r.categorie === q.categorie && norm(r.label) === norm(q.label));
    if (!ref) { introuvables.push(q); continue; }
    if (ref.quantite === q.quantite) continue;
    plan.push({ docId: ref.docId, categorie: q.categorie, label: q.label, avant: ref.quantite, apres: q.quantite });
  }

  console.log(`${QUANTITES.length} quantités source, ${plan.length} à mettre à jour, ${QUANTITES.length - plan.length - introuvables.length} déjà à jour, ${introuvables.length} réf introuvable(s).`);
  if (introuvables.length) console.log('Introuvables (à vérifier) :', introuvables);
  console.log('\nPlan complet :');
  plan.forEach(p => console.log(`  [${p.categorie}] ${p.label} : ${p.avant} → ${p.apres}`));

  if (!WRITE) {
    console.log('\n[DRY-RUN] Aucune écriture. Relancer avec --write pour appliquer.');
    return;
  }

  const batch = db.batch();
  for (const p of plan) {
    batch.update(db.collection('stock_refs').doc(p.docId), { quantite: p.apres });
  }
  if (plan.length) await batch.commit();
  console.log(`✓ ${plan.length} référence(s) mise(s) à jour.`);
})().catch(e => { console.error(e); process.exit(1); });
