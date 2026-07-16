#!/usr/bin/env node
/* ================================================================
   AUDIT LECTURE SEULE — libellés décomptables par stock.js vs catalogue
   ----------------------------------------------------------------
   Confronte chaque libellé que le décompte auto (stock.js) peut demander
   aux réfs réellement présentes dans la collection stock_refs. Objectif :
   détecter les divergences de nommage AVANT les tests en conditions
   réelles (cf. cas "Support Solaire" : le code demandait une réf sans
   suffixe couleur qui n'existait pas au catalogue — corrigé en 6d77bb8).

   N'ÉCRIT RIEN. Usage :
     node scripts/audit-refs-stock.js
   Service account : /Users/sachajourdan/Downloads/service-account.json
   (ou 1er argument du script).

   ⚠ À maintenir aligné avec stock.js : les listes ci-dessous reprennent
   AXE_PAR_LARGEUR_CM, LEGACY_PIECES_FIXES, SANGLE/CLIPS_PAR_COULEUR,
   SANGLE_TYPE_PAR_VOLET, ALIMENTATION_TABLE et les décomptes déclenchés
   par stockDecompterMoteur (débrayage + U de fixation).
   ================================================================ */

const admin = require('firebase-admin');
const saPath = process.argv[2] || '/Users/sachajourdan/Downloads/service-account.json';
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

// ── Libellés STATIQUES : [categorie, label] toujours demandés tels quels ──
const STATIQUES = [
  // Axes (AXE_PAR_LARGEUR_CM)
  ['aluminium','Axe 320'], ['aluminium','Axe 420'], ['aluminium','Axe 470'],
  ['aluminium','Axe 520'], ['aluminium','Axe 570'], ['aluminium','Axe 620'],
  ['aluminium','Axe 200 700'], ['aluminium','Axe 200 820'],
  // Déclenchés par moteur 80S/C120 (MOTEURS_AVEC_DEBRAYAGE)
  ['autre','Debrayage'], ['aluminium','U de fixation'],
  // LEGACY_PIECES_FIXES — silver / xtrem / mouv
  ['autre','Ski'], ['autre','Palier Hors Sol'], ['autre','Palier Xtrem'],
  ['aluminium','Bite'], ['aluminium','Bague'],
  ['aluminium','Chappe de Roue Mouv'], ['autre','Rails Mouv 3m'],
  ['autre','Roue Mouv'], ['autre','Roulement Roue Mouv'],
  // immerge / immerge_total
  ['autre','Palier Immerge'], ['aluminium','Flasque Immerge Classique'],
  ['aluminium','Corniere 40x40'], ['aluminium','Flasque Immerge Total'],
  ['autre','Sangle Contre Poids'], ['inox','Sabot Immerge Total'],
  // banc
  ['alimentation','Coffret Hors sol'], ['pied','Pied + Capot Banc'],
  ['autre','Lame Banc'], ['aluminium','Poutre Banc'],
  ['aluminium','Corniere Banc'], ['autre','Plaque Diffusante Banc'],
  // volet manuel
  ['autre','Palier manuel'], ['autre',"Tige d'entrainement"],
  ['autre','Volant'], ['autre','Frein manuel'], ['inox','Piece volet manuel'],
  // Sangles / clips (toutes couleurs atteignables + variantes Longue)
  ['attaches','Sangle Blanche'], ['attaches','Sangle Sable'], ['attaches','Sangle Grise'],
  ['attaches','Sangle Longue Blanche'], ['attaches','Sangle Longue Sable'], ['attaches','Sangle Longue Grise'],
  ['attaches','Clips Blanc'], ['attaches','Clips Sable'], ['attaches','Clips Gris'],
  // Alimentation — pièces électriques fixes (ALIMENTATION_TABLE, quantités retirées)
  ['alimentation','Regulateur Solaire'], ['alimentation','Batterie 12V'],
  ['alimentation','Cadran de Voltage'], ['alimentation','Panneau Solaire'],
  ['alimentation','Maintient de charge 24V'], ['alimentation','Batterie 24V'],
  ['alimentation','Chargeur Double Slots 24V'], ['alimentation','Indicateur de charge'],
  ['alimentation','Batterie 24V 6ah'], ['alimentation','Bandeau Solaire'],
  // 2026-07-16 — 9 groupes de pièces legacy redécompilés (télécommande, gestion sel,
  // passes-sangles, flasque murale, mur+barre de renfort, caillebotis, contre-axe, bouchons,
  // équerres/fixation/cornière/poutre/sabots)
  ['autre','Telecommande Recepteur'], ['autre','Telecommande Emmeteur'], ['autre','Telecommande Bluetooth'],
  ['autre','Electrolyseur'], ['autre','Oxeo'],
  ['attaches','Passes Sangles'],
  ['autre','Lame Mur Blanche'], ['autre','Lame Mur Grise'], ['autre','Lame Mur Sable'],
  ['inox','Jambe de mur 1.5m'], ['inox','Jambe de mur 2m'], ['inox','Jambe immerge total'],
  ['inox','Barre renfort de mur'],
  ['autre','Lame Caillebotis Blanche 6m'], ['autre','Lame Caillebotis Grise 6m'], ['autre','Lame Caillebotis Sable 6m'],
  ['autre','Lame Caillebotis IPE 1m'], ['autre','Lame Caillebotis IPE 1.5m'],
  ['autre','Lame Caillebotis Robinier 1m'], ['autre','Lame Caillebotis Robinier 1.5m'],
  ['aluminium','Contre Axe Blanc'], ['aluminium','Contre Axe Gris'], ['aluminium','Contre Axe Sable'], ['aluminium','Contre Axe 7016'],
  ['bouchons','Bouchon 80x80 Blanc'], ['bouchons','Bouchon 80x80 Gris'], ['bouchons','Bouchon 80x80 Noir'],
  ['bouchons','Bouchon 100x100 Blanc'], ['bouchons','Bouchon 100x100 Gris'], ['bouchons','Bouchon 100x100 Noir'],
  ['aluminium','Equerre de flasque/poutre bassin beton'], ['aluminium','Equerre de flasque/poutre bassin coque'],
  ['aluminium','Equerre de renfort telescopique'], ['aluminium','Corniere 60x60'],
  ['aluminium','Poutre 6m Blanc'], ['aluminium','Poutre 6m Gris'], ['aluminium','Poutre 6m Sable'], ['aluminium','Poutre 6m 7016'],
  ['aluminium','Poutre 6m Brute'], ['aluminium','Sabot Immerge Brute'],
];

// ── Familles PARAMÉTRÉES PAR COULEUR : préfixe + couleur (d.pieds) ─────────
// La couleur vient des dossiers, donc inconnue à l'avance : on liste les
// variantes présentes au catalogue pour chaque famille, pour vérification à l'œil.
const FAMILLES_COULEUR = [
  ['pied','Pied '], ['pied','Capot 0 Trous '], ['pied','Capot Batterie '],
  ['alimentation','Support Solaire '],
];

(async () => {
  const snap = await db.collection('stock_refs').get();
  const refs = snap.docs.map(r => ({ id: r.id, ...r.data() }));
  const norm = s => String(s || '').trim().toLowerCase(); // même comparaison que stockFindPieceRef
  console.log(`${refs.length} réfs au catalogue\n`);

  console.log('── Libellés statiques ──');
  let manquants = 0;
  for (const [cat, label] of STATIQUES) {
    const hit = refs.find(r => r.categorie === cat && norm(r.label) === norm(label));
    if (hit) {
      console.log(`  ✅ [${cat}] ${label} (qte ${hit.quantite ?? '?'})`);
    } else {
      manquants++;
      // Aide au diagnostic : réfs de la même catégorie au libellé proche
      const proches = refs.filter(r => r.categorie === cat &&
        (norm(r.label).includes(norm(label).slice(0, 6)) || norm(label).includes(norm(r.label).slice(0, 6))))
        .map(r => `"${r.label}"`).slice(0, 4);
      console.log(`  ❌ [${cat}] ${label} — INTROUVABLE${proches.length ? ' (proches : ' + proches.join(', ') + ')' : ''}`);
    }
  }

  console.log('\n── Familles par couleur (variantes présentes au catalogue) ──');
  for (const [cat, prefix] of FAMILLES_COULEUR) {
    const variantes = refs.filter(r => r.categorie === cat && norm(r.label).startsWith(norm(prefix)));
    console.log(`  [${cat}] ${prefix}… : ${variantes.length ? variantes.map(r => `"${r.label}"`).join(', ') : '⚠ AUCUNE'}`);
  }

  console.log('\n── Moteurs au catalogue (d.moteur doit matcher un de ces libellés) ──');
  const moteurs = refs.filter(r => r.categorie === 'moteur');
  console.log('  ' + (moteurs.length ? moteurs.map(r => `"${r.label}"`).join(', ') : '⚠ AUCUN'));

  console.log(`\n${manquants ? '❌ ' + manquants + ' libellé(s) statique(s) introuvable(s) — à corriger (renommer la réf ou ajuster stock.js).' : '✅ Tous les libellés statiques existent au catalogue.'}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
