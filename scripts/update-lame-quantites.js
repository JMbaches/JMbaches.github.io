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

   Poly Noir volontairement PAS mis à jour ici : l'inventaire liste 3 autres
   variantes Polycarbonate ("transparent/noir", "fumé fond noir",
   "transparent/transparent") sans qu'aucune ne corresponde clairement à
   "Poly Noir" tel qu'utilisé par l'app (coloreurLameVersFinition, stock.js)
   — risque de mal attribuer une quantité à la mauvaise réf, laissé de côté
   plutôt que deviné.

   Certaines tailles sont absentes de l'inventaire pour certaines couleurs
   (ex. PVC Blanc n'a pas de ligne 750, PVC Gris s'arrête à 700) — ces
   réfs-là restent inchangées (pas remises à 0 par erreur, juste non
   touchées).

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
