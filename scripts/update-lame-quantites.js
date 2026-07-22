#!/usr/bin/env node
/* ================================================================
   MISE À JOUR PONCTUELLE — quantités réelles des lames volet
   ----------------------------------------------------------------
   Les 66 réfs lame déjà en base (PVC Blanc/Sable/Gris + Polycarbonate
   Poly Bleu/Poly Gris/Poly Noir, 11 tailles chacune) sont TOUTES à
   quantite=0 depuis leur création (catalogue complet pré-généré, jamais
   rempli avec de vraies quantités). "INVENTAIRE 2025.xlsx" (feuille
   "INVENTAIRE VOLETS", fourni par l'utilisateur le 2026-07-22) donne les
   vraies quantités actuelles pour PVC (Blanc/Sable/Gris) et Polycarbonate
   Bleu ("bleu fond noir" → Poly Bleu, le fond est toujours noir — confirmé
   par l'utilisateur) et Gris ("gris nacré" → Poly Gris).

   Poly Noir — RÉSOLU (2026-07-22, même session) : confirmé par recherche
   dans l'historique réel de commandes CMDCLIB (2 vraies commandes trouvées :
   "TABLIER SEUL DE SILVER EN POLY NOIR FUME FOND NOIR B. NOIR" et "TABLIER
   POLY NOIR FOND NOIR B.NOIR"), donc Poly Noir = la section "Lame Poly fumé
   fond noir" de l'inventaire — PAS "transparent/noir" (un bicolore
   différent, jamais rattaché au nom "Poly Noir" dans les vraies données).
   Confirmé aussi par 2 codes catalogue Mégao utilisant "POLY NOIR" comme
   nom de couleur autonome : ACVRAIL300COU (ailette), ACVRBOUCHCOUL
   (bouchon à coller).

   Certaines tailles sont absentes de l'inventaire pour certaines couleurs
   (ex. PVC Blanc n'a pas de ligne 750, PVC Gris s'arrête à 700, Poly Noir
   n'a pas de ligne 800) — ces réfs-là restent inchangées (pas remises à 0
   par erreur, juste non touchées).

   ⚠️ CONFLIT DE SOURCE NON RÉSOLU (2026-07-22, même session) : les valeurs
   ci-dessous viennent d'INVENTAIRE 2025.xlsx (en-tête "DECEMBRE" — un
   comptage physique de décembre 2025). Un export plus récent du logiciel
   legacy Stock.exe encore utilisé (Downloads/logiciel/lames_stock.csv,
   daté du 8-9 juillet 2026) donne des valeurs TOTALEMENT différentes pour
   les mêmes réfs (ex. PVC Blanc 300 : 1302 ici vs 166 dans ce CSV — écart
   similaire sur toutes les autres couleurs). Sur demande explicite de
   l'utilisateur, TOUTES les quantités déjà écrites par ce script ont été
   remises à 0 en production (les RÉFÉRENCES restent correctes, seule la
   quantité est douteuse). NE PAS relancer avec --write tant que la bonne
   source n'a pas été confirmée avec l'utilisateur/JM — les valeurs
   ci-dessous (y compris Poly Noir) sont gardées pour référence, pas parce
   qu'elles sont fiables.

   Idempotent : peut être relancé sans risque si l'Excel est mis à jour.

   DRY-RUN PAR DÉFAUT :
     node scripts/update-lame-quantites.js
   Écriture réelle :
     node scripts/update-lame-quantites.js --write
   Service account : /Users/sachajourdan/Downloads/service-account.json
   (ou 1er argument après --write).
   ================================================================ */

const QUANTITES = [
  {"type":"PVC","finition":"Blanc","taille":"300","quantite":1302},
  {"type":"PVC","finition":"Blanc","taille":"350","quantite":609},
  {"type":"PVC","finition":"Blanc","taille":"400","quantite":1143},
  {"type":"PVC","finition":"Blanc","taille":"450","quantite":1170},
  {"type":"PVC","finition":"Blanc","taille":"500","quantite":549},
  {"type":"PVC","finition":"Blanc","taille":"550","quantite":891},
  {"type":"PVC","finition":"Blanc","taille":"600","quantite":822},
  {"type":"PVC","finition":"Blanc","taille":"650","quantite":270},
  {"type":"PVC","finition":"Blanc","taille":"700","quantite":270},
  {"type":"PVC","finition":"Blanc","taille":"800","quantite":270},
  {"type":"PVC","finition":"Sable","taille":"300","quantite":1239},
  {"type":"PVC","finition":"Sable","taille":"350","quantite":450},
  {"type":"PVC","finition":"Sable","taille":"400","quantite":849},
  {"type":"PVC","finition":"Sable","taille":"450","quantite":918},
  {"type":"PVC","finition":"Sable","taille":"500","quantite":660},
  {"type":"PVC","finition":"Sable","taille":"550","quantite":276},
  {"type":"PVC","finition":"Sable","taille":"600","quantite":1116},
  {"type":"PVC","finition":"Sable","taille":"650","quantite":0},
  {"type":"PVC","finition":"Sable","taille":"700","quantite":555},
  {"type":"PVC","finition":"Sable","taille":"750","quantite":0},
  {"type":"PVC","finition":"Sable","taille":"800","quantite":540},
  {"type":"PVC","finition":"Gris","taille":"300","quantite":1671},
  {"type":"PVC","finition":"Gris","taille":"350","quantite":630},
  {"type":"PVC","finition":"Gris","taille":"400","quantite":1695},
  {"type":"PVC","finition":"Gris","taille":"450","quantite":1527},
  {"type":"PVC","finition":"Gris","taille":"500","quantite":561},
  {"type":"PVC","finition":"Gris","taille":"550","quantite":342},
  {"type":"PVC","finition":"Gris","taille":"600","quantite":564},
  {"type":"PVC","finition":"Gris","taille":"650","quantite":42},
  {"type":"PVC","finition":"Gris","taille":"700","quantite":0},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"300","quantite":117},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"350","quantite":321},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"400","quantite":738},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"450","quantite":678},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"500","quantite":111},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"550","quantite":540},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"600","quantite":0},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"650","quantite":0},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"700","quantite":9},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"750","quantite":0},
  {"type":"Polycarbonate","finition":"Poly Bleu","taille":"800","quantite":0},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"300","quantite":381},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"350","quantite":387},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"400","quantite":54},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"450","quantite":27},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"500","quantite":270},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"550","quantite":1080},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"600","quantite":0},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"650","quantite":270},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"700","quantite":270},
  {"type":"Polycarbonate","finition":"Poly Gris","taille":"750","quantite":270},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"300","quantite":924},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"350","quantite":168},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"400","quantite":381},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"450","quantite":501},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"500","quantite":309},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"550","quantite":894},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"600","quantite":546},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"650","quantite":0},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"700","quantite":0},
  {"type":"Polycarbonate","finition":"Poly Noir","taille":"750","quantite":0},
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
  const lameRefs = snap.docs
    .map(d => ({ docId: d.id, ...d.data() }))
    .filter(r => r.type);

  const plan = [];
  const introuvables = [];
  for (const q of QUANTITES) {
    const ref = lameRefs.find(r => r.type === q.type && r.finition === q.finition && String(r.taille) === q.taille);
    if (!ref) { introuvables.push(q); continue; }
    if (ref.quantite === q.quantite) continue; // déjà à jour
    plan.push({ docId: ref.docId, type: q.type, finition: q.finition, taille: q.taille, avant: ref.quantite, apres: q.quantite });
  }

  console.log(`${QUANTITES.length} quantités source, ${plan.length} à mettre à jour, ${QUANTITES.length - plan.length - introuvables.length} déjà à jour, ${introuvables.length} réf introuvable(s).`);
  if (introuvables.length) console.log('Introuvables :', introuvables);

  if (!WRITE) {
    console.log('\n[DRY-RUN] Aucune écriture. Relancer avec --write pour appliquer.');
    console.log('Aperçu (5 premières) :', plan.slice(0, 5));
    return;
  }

  const batch = db.batch();
  for (const p of plan) {
    batch.update(db.collection('stock_refs').doc(p.docId), { quantite: p.apres });
  }
  if (plan.length) await batch.commit();
  console.log(`✓ ${plan.length} référence(s) mise(s) à jour.`);
})().catch(e => { console.error(e); process.exit(1); });
