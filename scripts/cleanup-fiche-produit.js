#!/usr/bin/env node
/* ================================================================
   CLEANUP ONE-SHOT — doublons "Fiche produit" / "Fiche de fabrication"
   ----------------------------------------------------------------
   Contexte : PD_DEFAULT_FOLDERS de scripts/megao-sync.js contenait encore
   l'ancien nom "Fiche produit" après le renommage en "Fiche de fabrication"
   (418b702). Chaque sync Mégao le ré-ajoutait par arrayUnion, et la
   migration côté app (map sans dédoublonnage, avant ef4ead5) pouvait
   produire un doublon "Fiche de fabrication". Ce script nettoie tout le
   stock existant en une passe (même esprit que le nettoyage rétroactif
   du doublon "Général", cf. b8e7995) :
     - renomme "Fiche produit" -> "Fiche de fabrication" dans docFolders
     - dédoublonne docFolders (tous doublons confondus, ordre préservé)
     - corrige documents[].folder encore sur "Fiche produit"

   BONUS (lecture seule) : liste les réfs stock catégorie "alimentation"
   dont le label commence par "Support Solaire" — pour trancher le point
   ouvert "Solaire + Chargeur décompte la réf 'Support Solaire' sans
   suffixe couleur : existe-t-elle au catalogue ?"

   Usage :
     node scripts/cleanup-fiche-produit.js --dry-run   # montre sans écrire
     node scripts/cleanup-fiche-produit.js             # applique

   Service account : /Users/sachajourdan/Downloads/service-account.json
   (ou 1er argument non-option du script).
   Dépendance : npm i firebase-admin (déjà utilisé par megao-sync.js).
   ================================================================ */

const admin = require('firebase-admin');

const DRY_RUN = process.argv.includes('--dry-run');
const saPath = process.argv.slice(2).find(a => !a.startsWith('--'))
  || '/Users/sachajourdan/Downloads/service-account.json';

admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

const OLD = 'Fiche produit';
const NEW = 'Fiche de fabrication';

(async () => {
  const snap = await db.collection('dossiers').get();
  console.log(`${snap.size} dossiers lus${DRY_RUN ? ' — DRY RUN, aucune écriture' : ''}\n`);

  let touched = 0;
  let batch = db.batch(), inBatch = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    const update = {};
    const raisons = [];

    if (Array.isArray(d.docFolders) && d.docFolders.length) {
      const renamed = d.docFolders.map(f => f === OLD ? NEW : f);
      const deduped = [...new Set(renamed)];
      if (JSON.stringify(deduped) !== JSON.stringify(d.docFolders)) {
        update.docFolders = deduped;
        if (d.docFolders.includes(OLD)) raisons.push(`"${OLD}" renommé`);
        if (deduped.length !== renamed.length) raisons.push(`${renamed.length - deduped.length} doublon(s) retiré(s)`);
      }
    }

    if (Array.isArray(d.documents) && d.documents.some(doc2 => doc2 && doc2.folder === OLD)) {
      update.documents = d.documents.map(doc2 =>
        doc2 && doc2.folder === OLD ? { ...doc2, folder: NEW } : doc2);
      raisons.push(`documents[].folder "${OLD}" -> "${NEW}"`);
    }

    if (raisons.length) {
      touched++;
      console.log(`- ${doc.id} (${d.client || '?'}) : ${raisons.join(' + ')}`);
      if (!DRY_RUN) {
        batch.update(doc.ref, update);
        if (++inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
      }
    }
  }
  if (!DRY_RUN && inBatch) await batch.commit();
  console.log(`\n${touched} dossier(s) ${DRY_RUN ? 'à corriger' : 'corrigé(s)'}.`);

  // ── Rapport lecture seule : réfs "Support Solaire" au catalogue ──────────
  const refs = await db.collection('stock_refs').get();
  const supports = refs.docs
    .map(r => ({ id: r.id, ...r.data() }))
    .filter(r => r.categorie === 'alimentation' && /^support solaire/i.test((r.label || '').trim()));
  console.log(`\nRéfs catalogue "Support Solaire" (catégorie alimentation) : ${supports.length}`);
  supports.forEach(r => console.log(`  - "${r.label}" (id ${r.id}, qte ${r.quantite ?? '?'})`));
  const exactePlain = supports.some(r => (r.label || '').trim().toLowerCase() === 'support solaire');
  console.log(exactePlain
    ? '  → la réf "Support Solaire" SANS couleur existe : le décompte "Solaire + Chargeur" fonctionnera tel quel.'
    : '  → PAS de réf "Support Solaire" sans couleur : le décompte "Solaire + Chargeur" échouera (réf introuvable) — à corriger dans ALIMENTATION_TABLE / stockDecompterAlimentation (suffixe couleur comme le chemin "Solaire").');

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
