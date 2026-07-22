#!/usr/bin/env node
/* ================================================================
   IMPORT PONCTUEL — références stock accessoires bâches
   ----------------------------------------------------------------
   Importe dans `stock_refs` les accessoires bâches extraits de
   "INVENTAIRE 2025.xlsx" (feuille "INVENTAIRE BACHES", fournie par
   l'utilisateur le 2026-07-22) qui correspondent aux 5 catégories déjà
   utilisées côté parseur (scripts/megao-sync.js::BACHE_ACCESSORY_PREFIXES) :
   bache_bulles, bache_enrouleur, bache_securite (Sécu+/Barre/Hiver fusionnés,
   plusieurs codes apparaissent dans les deux sections de l'inventaire),
   bache_entretien, bache_divers. Décision actée avec l'utilisateur : SEULEMENT
   les accessoires, pas la matière première (rouleaux bâches/bordage), ni la
   chimie hors "kits"/produits déjà listés, ni les emballages — ces lignes-là
   restent hors du Stock de l'app pour l'instant.

   Snapshot de quantité figé à la date de l'export Excel — comme pour l'import
   CSV legacy (csv_principal, 2026-07-15), les quantités réelles dérivent
   ensuite via le Scanner (entrée/sortie/inventaire), ce script ne fait que
   poser un point de départ. Pas de colonne "Minimum" dans cette feuille
   (contrairement aux CSV legacy Produit/Stock/Minimum) → minimum:0 par défaut,
   ajustable ensuite depuis Stock → Références.

   IDs synthétiques (code Mégao + désignation slugifiée) : ces accessoires
   n'ont pas de code-barre physique connu, comme les 175 refs legacy déjà en
   base. Matching utilisé par le décompte auto (stock.js::stockFindPieceRef)
   se fait par categorie+label, PAS par cet id — cohérent avec l'existant.

   DRY-RUN PAR DÉFAUT (n'écrit rien, affiche juste ce qui serait fait) :
     node scripts/import-bache-stock.js
   Écriture réelle :
     node scripts/import-bache-stock.js --write
   Service account : /Users/sachajourdan/Downloads/service-account.json
   (ou 1er argument après --write).
   ================================================================ */

const REFS = [
  { id: 'ACBOUFEUIL-BOUDIN-RAMASSE-FEUILLE', categorie: 'bache_bulles', label: 'BOUDIN RAMASSE FEUILLE', quantite: 36 },
  { id: 'ACSANENR-SANDOWS-ENROULEUR', categorie: 'bache_bulles', label: 'SANDOWS ENROULEUR', quantite: 2750 },
  { id: 'ACENRDEMUL-DEMULTIPLICATEUR', categorie: 'bache_bulles', label: 'DEMULTIPLICATEUR', quantite: 37 },
  { id: 'ACBUSANGLET-SANGLETTES', categorie: 'bache_bulles', label: 'SANGLETTES', quantite: 3500 },
  { id: 'ACBUBACHET-ROULEAU-DE-BACHETTE', categorie: 'bache_bulles', label: 'ROULEAU DE BACHETTE', quantite: 192 },
  { id: 'ACBUROUL-BORDAGE-PVC-AMANDE-8CM-DE-LARG', categorie: 'bache_bulles', label: 'BORDAGE PVC AMANDE / 8cm de large par 60 de long', quantite: 89 },
  { id: 'ACBABOUCH-BOUCHONS-DIAM-48', categorie: 'bache_securite', label: 'BOUCHONS DIAM 48', quantite: 0 },
  { id: 'ACSANGCLIQ-SANGLE-CLIQUET-SECU', categorie: 'bache_securite', label: 'SANGLE CLIQUET SECU+', quantite: 420 },
  { id: 'ACPITESC-PITONS-ESCAM-14', categorie: 'bache_securite', label: 'PITONS ESCAM 14', quantite: 6000 },
  { id: 'ACPITESC-PITONS-ESCAM-BOIS-SECU', categorie: 'bache_securite', label: 'PITONS ESCAM BOIS SECU+', quantite: 56 },
  { id: 'ACRUPRELAIS-RELAIS', categorie: 'bache_enrouleur', label: 'RELAIS', quantite: 6 },
  { id: 'ACRUPBOUT-BOUTONS', categorie: 'bache_enrouleur', label: 'BOUTONS', quantite: 293 },
  { id: 'ACRUPCHARG-CHARGEUR', categorie: 'bache_enrouleur', label: 'CHARGEUR', quantite: 4 },
  { id: 'ACBAALU-SECU-BARRE-ALU-A6-90-DIAM-50', categorie: 'bache_securite', label: 'BARRE ALU A6.90 DIAM 50', quantite: 368 },
  { id: 'ACBAALU-SECU-BARRE-ALU-5-90-DIAM-50', categorie: 'bache_securite', label: 'BARRE ALU 5,90 DIAM 50', quantite: 373 },
  { id: 'ACBAENR-BARRES-GALVA-5-00', categorie: 'bache_securite', label: 'BARRES GALVA 5.00', quantite: 0 },
  { id: 'ACBACARR-CARRE-ENROUL-GALVA', categorie: 'bache_enrouleur', label: 'CARRE ENROUL GALVA', quantite: 0 },
  { id: 'ACROINOX-CROCHETS-INOX-HS', categorie: 'bache_securite', label: 'CROCHETS INOX HS', quantite: 971 },
  { id: 'ACROPLAST-CROCHETS-PLASTIQUES-HS', categorie: 'bache_securite', label: 'CROCHETS PLASTIQUES HS', quantite: 9200 },
  { id: 'ACAB-CABICLIC', categorie: 'bache_securite', label: 'CABICLIC', quantite: 1200 },
  { id: 'ACPITCROS-PITONS-CROSSES', categorie: 'bache_securite', label: 'PITONS CROSSES', quantite: 4600 },
  { id: 'ACPITGAZ-PITONS-GAZON', categorie: 'bache_securite', label: 'PITONS GAZON', quantite: 1370 },
  { id: 'ACPLAQUET-PLAQUETTES-SECURITIS', categorie: 'bache_securite', label: 'PLAQUETTES SECURITIS', quantite: 3600 },
  { id: 'ACMANIV-MANIVELLE-MANUEL', categorie: 'bache_securite', label: 'MANIVELLE MANUEL', quantite: 1848 },
  { id: 'ACSANCROACIER-SANDOWS-CROCHET-ACIER', categorie: 'bache_securite', label: 'SANDOWS CROCHET ACIER', quantite: 0 },
  { id: 'ACSANVECO-SANDOWS-V', categorie: 'bache_securite', label: 'SANDOWS V', quantite: 2750 },
  { id: 'ACSANGLUX-SANGLES-LUXE', categorie: 'bache_securite', label: 'SANGLES LUXE', quantite: 616 },
  { id: 'ACSANGCLIQ-SANGLE-CLIQUETS-BARRE', categorie: 'bache_securite', label: 'SANGLE CLIQUETS BARRE', quantite: 0 },
  { id: 'ACSANGD-SANGLE-D', categorie: 'bache_securite', label: 'SANGLE D', quantite: 0 },
  { id: 'ACSANGRAP-SANGLE-DE-RAPPEL', categorie: 'bache_securite', label: 'SANGLE DE RAPPEL', quantite: 140 },
  { id: 'ACSANGGAN-SANGLE-GANSE', categorie: 'bache_securite', label: 'SANGLE GANSE', quantite: 150 },
  { id: 'ACKITPAT-PATINS', categorie: 'bache_securite', label: 'PATINS', quantite: 9250 },
  { id: 'ACPITESC-PITONS-ESCAM-12', categorie: 'bache_securite', label: 'PITONS ESCAM 12', quantite: 7400 },
  { id: 'ACBAVOL-VOLANTS-HS', categorie: 'bache_securite', label: 'VOLANTS HS', quantite: 76 },
  { id: 'ACOL-TUBE-COLLE-PVC', categorie: 'bache_securite', label: 'TUBE COLLE PVC', quantite: 66 },
  { id: 'ACBOUEAU-BOUDIN-D-EAU', categorie: 'bache_divers', label: "BOUDIN D'EAU", quantite: 0 },
  { id: 'CHHJO80501-KIT-ETE', categorie: 'bache_entretien', label: 'KIT ETE', quantite: 0 },
  { id: 'CHHJO80503-KIT-HIVER', categorie: 'bache_entretien', label: 'KIT HIVER', quantite: 0 },
  { id: 'BROME-BROME-PERMANENT', categorie: 'bache_entretien', label: 'BROME PERMANENT', quantite: 0 },
  { id: 'CHEMOBROME-CHEMOBROME', categorie: 'bache_entretien', label: 'CHEMOBROME', quantite: 0 },
  { id: 'CHLORE-CHLORE-MULTIFONCTION', categorie: 'bache_entretien', label: 'CHLORE MULTIFONCTION', quantite: 0 },
  { id: 'DIACLOR-DIACLOR-PS-90-200', categorie: 'bache_entretien', label: 'DIACLOR PS 90/200', quantite: 0 },
  { id: 'DIACLOR-DIACLOR-PS-MULTI', categorie: 'bache_entretien', label: 'DIACLOR PS MULTI', quantite: 0 },
  { id: 'DIACLOR-DIACLOR-PS-200-MULTI', categorie: 'bache_entretien', label: 'DIACLOR PS 200 MULTI', quantite: 0 },
  { id: 'CLEARPOOL-CLEARPOOL-2', categorie: 'bache_entretien', label: 'CLEARPOOL 2', quantite: 0 },
  { id: 'CHHJKIT4-50-KIT-SANS-CHLORE', categorie: 'bache_entretien', label: 'KIT SANS CHLORE', quantite: 0 },
];

const WRITE = process.argv.includes('--write');
const saArgIdx = process.argv.indexOf('--write') + 1;
const saPath = (WRITE && process.argv[saArgIdx] && !process.argv[saArgIdx].startsWith('--'))
  ? process.argv[saArgIdx]
  : '/Users/sachajourdan/Downloads/service-account.json';

(async () => {
  console.log(`${REFS.length} référence(s) à importer, ${new Set(REFS.map(r => r.categorie)).size} catégories.`);
  const parCat = {};
  for (const r of REFS) parCat[r.categorie] = (parCat[r.categorie] || 0) + 1;
  console.log(parCat);

  if (!WRITE) {
    console.log('\n[DRY-RUN] Aucune écriture. Relancer avec --write pour importer réellement dans Firestore.');
    console.log('Exemple de doc qui serait écrit :', JSON.stringify({ ...REFS[0], minimum: 0 }, null, 1));
    return;
  }

  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
  const db = admin.firestore();

  const snap = await db.collection('stock_refs').get();
  const existingIds = new Set(snap.docs.map(d => d.id));

  const batch = db.batch();
  let nouveaux = 0, misAJour = 0;
  for (const r of REFS) {
    const ref = db.collection('stock_refs').doc(r.id);
    const isNew = !existingIds.has(r.id);
    if (isNew) nouveaux++; else misAJour++;
    batch.set(ref, { categorie: r.categorie, label: r.label, quantite: r.quantite, minimum: 0 }, { merge: true });
  }
  await batch.commit();
  console.log(`✓ Import terminé : ${nouveaux} créée(s), ${misAJour} déjà existante(s) mise(s) à jour.`);
})().catch(e => { console.error(e); process.exit(1); });
