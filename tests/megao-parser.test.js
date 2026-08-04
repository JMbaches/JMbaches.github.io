/* ================================================================
   TESTS DE RÉGRESSION — Parseur PDF Mégao (scripts/megao-parser.js)
   ----------------------------------------------------------------
   Couvre TOUTES les gammes produit connues (volets + bâches) avec du texte
   SYNTHÉTIQUE au format pdf-parse — zéro donnée client réelle, committable
   sans risque (contrairement aux vrais PDF, qui contiennent nom/adresse/tél
   et ne doivent jamais atterrir dans ce repo public).

   Contexte (2026-08-03) : lors de l'extraction de megao-parser.js depuis
   megao-sync.js, seuls 2 vrais PDF étaient disponibles localement (1 volet,
   1 bâche/Barres). L'accès à la boîte mail pour en récupérer d'autres a été
   bloqué par une 2FA Google sans méthode de secours. 5 PDF supplémentaires
   ont pu être récupérés depuis Firebase Storage (dossiers déjà en base),
   couvrant Bulles/Cover/Sécuritis/Silver Roll + un vrai bug trouvé (voir
   plus bas, cas "EASY CLIP"). Ce fichier complète la couverture avec du
   texte fabriqué pour les gammes qu'aucun dossier réel actuel ne couvre
   (Golden Roll, coffre, X-Trem, Mouv&Roll, Subwater, Subwater Total, Poly
   Cover, GR VOL) — et sert de garde-fou pérenne pour toute future modif.

   Usage : npm run test:megao-parser (ou directement `node tests/megao-parser.test.js`)
   ================================================================ */

const assert = require('assert');
const { parseMegaoText, parseMegaoBacheText } = require('../scripts/megao-parser.js');

let pass = 0, fail = 0;
const failures = [];

function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    pass++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    fail++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
    console.log(`     attendu: ${JSON.stringify(expected)} | reçu: ${JSON.stringify(actual)}`);
  }
}

// ─── Générateurs de texte synthétique (format pdf-parse fictif) ────────────
function voletText({ vrCode, vrDesig, lamCode = 'LAM4', lamCouleur = 'Blanc', extra = '' }) {
  return `AQUAMASTER - JM Bâches
Réalisations :
ZA 11 Rue des Tilleuls
26120 MONTELIER
Date :01/08/2026
COMMANDE N° TEST-VOLET
TESTREVENDEUR SARL
CLIENT FICTIF TEST
1 RUE DU TEST
26000 VALENCE
Tél :  06.00.00.00.00
Références :Délai :
Désignation Quantité Code Prix unit. Montant TP.U. Brut Un.
${vrCode}${vrDesig}UN  1,00  100,00   100,00  100,001
${extra}${lamCode}Lames PVC (le ml) ${lamCouleur}ML  4,00  50,00   200,00  200,001
Net HT
  300,00`;
}

function bacheText({ code, desig, unit = 'M2' }) {
  return `AQUAMASTER - JM Bâches
Réalisations :
ZA 11 Rue des Tilleuls
26120 MONTELIER
Date :01/08/2026
COMMANDE N° TEST-BACHE
TESTREVENDEUR SARL
CLIENT FICTIF TEST
1 RUE DU TEST
26000 VALENCE
Tél :  06.00.00.00.00
Références :Délai :
Désignation Quantité Code Prix unit. Montant TP.U. Brut Un.
${code}${desig}${unit}  10,00  20,00   200,00  200,001
Net HT
  200,00`;
}

// ================================ volets ====================================
console.log('\n-- volets : structure par gamme --');

const voletCases = [
  ['Silver Roll',    { vrCode: 'VRSIL80S',   vrDesig: 'Volet hors-sol Silver Roll structure Blanc ' },  'Volet hors-sol Silver Roll'],
  ['Golden Roll',    { vrCode: 'VRSOL80S',   vrDesig: 'Volet hors-sol solaire Golden Roll structure Blanc ' }, 'Volet hors-sol solaire Golden Roll'],
  ['Coffre',         { vrCode: 'VRCOF80S',   vrDesig: 'Volet hors-sol avec coffre structure Blanc ' }, 'Volet hors-sol avec coffre'],
  ['X-Trem Roll',    { vrCode: 'VRXTR80S',   vrDesig: 'Volet hors-sol grand bassin X-Trem Roll structure Blanc ' }, 'Volet hors-sol grand bassin X-Trem Roll'],
  ['Mouv&Roll',      { vrCode: 'VRMOUV80S',  vrDesig: 'Volet déplaçable Mouv and Roll structure Blanc ' }, 'Volet déplaçable Mouv&Roll'],
  ['Subwater',       { vrCode: 'VRSUB80S',   vrDesig: 'Volet immergé Subwater structure Blanc ' }, 'Volet immergé Subwater'],
  ['Subwater Total', { vrCode: 'VRSUBT80S',  vrDesig: 'Volet immergé Subwater Total structure Blanc ' }, 'Volet immergé Subwater Total'],
];

for (const [label, params, expectedStructure] of voletCases) {
  const data = parseMegaoText(voletText(params));
  check(`${label} : isVolet`, data.isVolet, true);
  check(`${label} : structure`, data.structure, expectedStructure);
}

// X-Trem en version déplaçable (VRXTREMM, ligne d'option distincte — voir megao-parser.js,
// isXtremMouv) : structure dédiée "Mouv" pour router la checklist atelier comme un Mouv&Roll.
{
  const text = voletText({ vrCode: 'VRXTREM7', vrDesig: 'Volet hors-sol grand bassin X-Trem Roll structure Blanc ' })
    .replace('Net HT', 'VRXTREMMOption structure XTrem Roll en déplaçable UN  1,00  50,00   50,00  50,001\nNet HT');
  const data = parseMegaoText(text);
  check('X-Trem Mouv (option déplaçable) : structure', data.structure, 'Volet déplaçable X-Trem Mouv');
}

// Tablier seul : aucune ligne VR ne matche un préfixe STRUCT_MAP connu, repli sur le texte.
{
  const text = voletText({ vrCode: 'VRACC', vrDesig: 'Accessoire non structurel ' })
    .replace('VRACCAccessoire non structurel UN  1,00  100,00   100,00  100,001\n', '')
    + '\ntablier seul';
  const data = parseMegaoText(text);
  check('Tablier seul : structure', data.structure, 'Tablier seul');
}

// ================================ bâches ====================================
console.log('\n-- bâches : gamme + modèle --');

const bacheCases = [
  ['Barres',                 { code: 'BACLA',         desig: 'Sécu Classic Amande ' },        'Barres',     'BACLA'],
  ['Bulles',                 { code: 'BULA',           desig: 'Bulle 500 microns Bleu ' },      'Bulles',     'BULA'],
  ['Cover',                  { code: 'COV1',           desig: 'Cover rigide Sable ' },          'Cover',      'COV1'],
  ['Poly Cover (POLYHJ)',    { code: 'POLYHJVALENCE',  desig: 'Poly Cover rigide Sable ' },     'Poly Cover', 'POLYHJVALENCE'],
  ['Poly Cover (ECOLIGHT)',  { code: 'ECOLIGHT',       desig: 'Ecolight Poly Cover Sable ' },   'Poly Cover', 'ECOLIGHT'],
  ['GR VOL',                 { code: 'GRVOL',          desig: 'Grille de sécurité rigide Sable ' }, 'GR VOL', 'GRVOL'],
  ['Sécuritis',              { code: 'SEHS',           desig: 'Sécuritis hors-sol Bleu ' },     'Sécuritis',  'SEHS'],
];

for (const [label, params, expectedGamme, expectedModele] of bacheCases) {
  const data = parseMegaoBacheText(bacheText(params));
  check(`${label} : isBache`, data.isBache, true);
  check(`${label} : bacheGamme`, data.bacheGamme, expectedGamme);
  check(`${label} : bacheModele`, data.bacheModele, expectedModele);
}

// [RÉGRESSION] Désignation en MAJUSCULES INTÉGRALES au lieu du Title Case habituel — bug réel
// trouvé sur le dossier 121038 (2026-08-03) : "BACLAFCSECU EASY CLIP  Sable", jamais reconnu par
// BACHE_LIGNE_RE (frontière code/désignation basée sur "majuscule PUIS minuscule", qui ne matche
// pas ici) avant le fix du repli explicite dans parseMegaoBacheText.
{
  const text = bacheText({ code: 'BACLAFCSECU', desig: ' EASY CLIP  Sable ' });
  const data = parseMegaoBacheText(text);
  check('[RÉGRESSION 121038] EASY CLIP (majuscules) : bacheModele', data.bacheModele, 'BACLAFCSECU');
  check('[RÉGRESSION 121038] EASY CLIP (majuscules) : bacheGamme', data.bacheGamme, 'Barres');
}

console.log(`\n${pass}/${pass + fail} tests passés.`);
if (fail) {
  console.log('Échecs : ' + failures.join(', '));
  process.exit(1);
}
process.exit(0);
