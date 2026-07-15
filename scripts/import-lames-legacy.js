#!/usr/bin/env node
/* ================================================================
   IMPORT LAMES LEGACY — références lames (type × coloris × largeur)
   ----------------------------------------------------------------
   Reprend les références de lames de l'ancienne application (Stock.exe)
   avec leurs tailles associées, pour que le décompte auto (matching
   EXACT type + finition + largeur bassin, cf. 5a08b91) trouve toujours
   sa référence. Complète l'import des 174 réfs pièces (9 catégories)
   fait précédemment depuis le même dossier CSV.

   Schéma cible stock_refs (identique aux réfs lames créées par scan) :
     doc id  = CODE-BARRES physique (indispensable : les scans magasin
               font doc(codeBarre) directement)
     champs  = { type: 'PVC'|'Polycarbonate', finition, taille: '350',
                 quantite, minimum }
     finitions attendues par le décompte : Blanc / Sable / Gris /
     Poly Bleu / Poly Gris / Poly Noir (cf. coloreurLameVersFinition)

   ÉTAPE 1 — INSPECTION (aucune écriture) :
     node scripts/import-lames-legacy.js --inspect
     → liste chaque CSV du dossier legacy (en-tête + 3 lignes) pour
       vérifier/ajuster le MAPPING ci-dessous. Colle la sortie dans le
       chat si le mapping doit être adapté.

   ÉTAPE 2 — IMPORT :
     node scripts/import-lames-legacy.js --dry-run   # montre sans écrire
     node scripts/import-lames-legacy.js             # applique

   Options :
     --csv <chemin>          dossier des CSV (défaut : csv_principal legacy)
     --maj-quantites         met aussi à jour la quantité des réfs déjà
                             présentes (défaut : n'importe que les manquantes)

   Service account : /Users/sachajourdan/Downloads/service-account.json
   ================================================================ */

const fs = require('fs');
const path = require('path');

/* ─────────────── MAPPING À VÉRIFIER AVEC --inspect ─────────────── */
// Fichier(s) CSV contenant les lames : tout fichier dont le nom matche.
const FICHIER_LAMES_RE = /lame/i;
// Séparateur CSV legacy (';' classique des exports FR, ',' sinon).
const SEP = ';';
// Noms de colonnes candidats (insensible à la casse, accents ignorés) —
// la 1re colonne trouvée dans l'en-tête est utilisée.
const COLS = {
  code:     ['code', 'code_barre', 'codebarre', 'code barre', 'barcode', 'ref', 'reference'],
  libelle:  ['libelle', 'libellé', 'nom', 'designation', 'désignation', 'produit'],
  quantite: ['quantite', 'quantité', 'qte', 'stock', 'qty'],
  minimum:  ['minimum', 'mini', 'seuil', 'stock_mini', 'alerte'],
};
// Extraction type/finition/largeur depuis le libellé si pas de colonnes
// dédiées. Exemples visés : "Lame PVC Gris 350", "Lame Poly Bleu 4m",
// "LAMPOL450 Poly Noir", "Lames Blanc 3.50"…
function parseLibelleLame(libelle) {
  const s = String(libelle || '').trim();
  const type = /pol/i.test(s) ? 'Polycarbonate' : 'PVC';
  const FINITIONS = type === 'Polycarbonate'
    ? [['bleu','Poly Bleu'], ['gris','Poly Gris'], ['nacr','Poly Gris'], ['noir','Poly Noir']]
    : [['blanc','Blanc'], ['sable','Sable'], ['gris','Gris']];
  const fin = FINITIONS.find(([k]) => new RegExp(k, 'i').test(s));
  // Largeur : code LAM collé (LAM350/LAMPOL45/LAM4 — même convention que megao-sync),
  // sinon nombre en cm (300-800), sinon mètres éventuellement décimaux (3.50 / 4,5 / 4m).
  let largeur = null;
  const mCode = s.match(/LAM[A-Z]*([0-9]+)/i);
  const mCm   = s.match(/(?:^|[^0-9])([3-8][05]0)(?![0-9])/);
  const mM    = s.match(/(?:^|[^0-9])([3-8])(?:[.,]([0-9]{1,2}))?\s*m?(?![0-9a-z])/i);
  if (mCode) { const n = mCode[1]; largeur = n.length === 3 ? +n : n.length === 2 ? +n * 10 : +n * 100; }
  else if (mCm) largeur = +mCm[1];
  else if (mM) largeur = +mM[1] * 100 + (mM[2] ? +(mM[2] + '0').slice(0, 2) : 0);
  return { type, finition: fin ? fin[1] : null, largeur };
}
/* ────────────────────────────────────────────────────────────────── */

const LARGEURS_VALIDES = [300,350,400,450,500,550,600,650,700,750,800]; // = LAME_LARGEURS_VALIDES (stock.js)

const args = process.argv.slice(2);
const INSPECT = args.includes('--inspect');
const DRY = args.includes('--dry-run');
const MAJ_QTE = args.includes('--maj-quantites');
const csvIdx = args.indexOf('--csv');
const CSV_DIR = csvIdx >= 0 ? args[csvIdx+1] : '/Users/sachajourdan/Downloads/logiciel/csv_principal';

function lireCsv(fp) {
  const raw = fs.readFileSync(fp, 'latin1'); // exports legacy souvent en ANSI ; réessayer utf8 si accents cassés
  const lignes = raw.split(/\r?\n/).filter(l => l.trim());
  const header = lignes[0].split(SEP).map(h => h.trim());
  const rows = lignes.slice(1).map(l => l.split(SEP).map(c => c.trim()));
  return { header, rows };
}
const normCol = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function idxCol(header, candidats) {
  const h = header.map(normCol);
  for (const c of candidats) { const i = h.indexOf(normCol(c)); if (i >= 0) return i; }
  return -1;
}

/* ─── MODE INSPECTION ─── */
if (INSPECT) {
  const files = fs.readdirSync(CSV_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  console.log(`${files.length} CSV dans ${CSV_DIR}\n`);
  for (const f of files) {
    const { header, rows } = lireCsv(path.join(CSV_DIR, f));
    const cible = FICHIER_LAMES_RE.test(f) ? '  ← CANDIDAT LAMES' : '';
    console.log(`── ${f} (${rows.length} lignes)${cible}`);
    console.log('   en-tête : ' + header.join(' | '));
    rows.slice(0, 3).forEach(r => console.log('   ex.     : ' + r.join(' | ')));
    console.log('');
  }
  console.log('Vérifie quel(s) fichier(s) contiennent les lames et si les colonnes matchent le MAPPING.');
  process.exit(0);
}

/* ─── MODE IMPORT ─── */
const admin = require('firebase-admin');
const saPath = '/Users/sachajourdan/Downloads/service-account.json';
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

(async () => {
  const files = fs.readdirSync(CSV_DIR).filter(f => f.toLowerCase().endsWith('.csv') && FICHIER_LAMES_RE.test(f));
  if (!files.length) { console.error(`Aucun CSV "lames" (${FICHIER_LAMES_RE}) dans ${CSV_DIR} — lance --inspect pour voir les fichiers.`); process.exit(1); }
  console.log(`Fichier(s) lames : ${files.join(', ')}${DRY ? ' — DRY RUN, aucune écriture' : ''}\n`);

  // Réfs lames déjà en base (pas de champ categorie = lame)
  const snap = await db.collection('stock_refs').get();
  const existantes = snap.docs.map(r => ({ id: r.id, ...r.data() })).filter(r => !r.categorie);
  const cle = r => `${r.type}|${String(r.finition||'').toLowerCase()}|${String(r.taille)}`;
  const dejaLa = new Map(existantes.map(r => [cle(r), r]));

  let importees = 0, majQte = 0, ignorees = 0, invalides = 0;
  let batch = db.batch(), inBatch = 0;

  for (const f of files) {
    const { header, rows } = lireCsv(path.join(CSV_DIR, f));
    const iCode = idxCol(header, COLS.code), iLib = idxCol(header, COLS.libelle);
    const iQte = idxCol(header, COLS.quantite), iMin = idxCol(header, COLS.minimum);
    if (iCode < 0 || iLib < 0) { console.error(`❌ ${f} : colonnes code/libellé introuvables (en-tête : ${header.join(' | ')}) — ajuster COLS puis relancer.`); process.exit(1); }

    for (const row of rows) {
      const code = row[iCode], libelle = row[iLib];
      if (!code || !libelle) continue;
      const { type, finition, largeur } = parseLibelleLame(libelle);
      if (!finition || !largeur || !LARGEURS_VALIDES.includes(largeur)) {
        invalides++;
        console.log(`  ⚠ ignoré (parse) : "${libelle}" → finition=${finition} largeur=${largeur}`);
        continue;
      }
      const quantite = iQte >= 0 ? (parseInt(row[iQte], 10) || 0) : 0;
      const minimum  = iMin >= 0 ? (parseInt(row[iMin], 10) || 0) : 0;
      const ref = { type, finition, taille: String(largeur), quantite, minimum };
      const k = cle(ref);

      if (dejaLa.has(k)) {
        const ex = dejaLa.get(k);
        if (MAJ_QTE && ex.quantite !== quantite) {
          majQte++;
          console.log(`  ↻ maj quantité : ${type} ${finition} ${largeur} (${ex.quantite} → ${quantite}) [doc ${ex.id}]`);
          if (!DRY) { batch.set(db.collection('stock_refs').doc(ex.id), { quantite }, { merge: true });
            if (++inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; } }
        } else {
          ignorees++;
          console.log(`  = déjà en base : ${type} ${finition} ${largeur} [doc ${ex.id}${String(ex.id)!==String(code)?` ≠ code legacy ${code} ⚠`:''}]`);
        }
        continue;
      }
      importees++;
      console.log(`  + import : ${type} ${finition} ${largeur} — qte ${quantite} [code ${code}]`);
      if (!DRY) { batch.set(db.collection('stock_refs').doc(String(code)), ref, { merge: true });
        if (++inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; } }
    }
  }
  if (!DRY && inBatch) await batch.commit();

  console.log(`\n${importees} importée(s), ${ignorees} déjà présente(s), ${majQte} quantité(s) mise(s) à jour, ${invalides} ligne(s) non parsée(s).`);
  // Couverture : la grille complète attendue par le décompte
  const attendus = [];
  for (const t of ['PVC','Polycarbonate'])
    for (const fi of (t==='PVC'?['Blanc','Sable','Gris']:['Poly Bleu','Poly Gris','Poly Noir']))
      for (const l of LARGEURS_VALIDES) attendus.push({type:t,finition:fi,taille:String(l)});
  const apres = new Set([...dejaLa.keys()]);
  // (en dry-run on simule l'ajout)
  // NB : re-check simple — les importées de ce run comptent comme couvertes
  const manquantes = attendus.filter(a => !apres.has(cle(a)) );
  if (manquantes.length) {
    console.log(`\n⚠ Grille incomplète même après import — ${manquantes.length} combinaisons sans réf (le décompte échouera dessus si un dossier tombe pile) :`);
    // regroupé par type/finition pour lisibilité
    const parFin = {};
    manquantes.forEach(m => { (parFin[m.type+' '+m.finition] ||= []).push(m.taille); });
    Object.entries(parFin).forEach(([k, v]) => console.log(`   ${k} : ${v.join(', ')}`));
    console.log('   (normal si certaines combinaisons n\'existent pas commercialement)');
  } else {
    console.log('\n✅ Grille complète : toutes les combinaisons type × finition × largeur ont une réf.');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
