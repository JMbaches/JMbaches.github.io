// megao-sync.js — Sync automatique Mégao → Firestore
// Tourne via GitHub Actions toutes les 30 min

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse         = require('pdf-parse');
const admin            = require('firebase-admin');
const { randomUUID }   = require('crypto');
// Classification code→famille (BA/BU/HI), extraite de la table ARTICLE.mkd de Mégao
// (catalogue produit officiel — voir mémoire projet pour la méthode de décodage). Volontairement
// réduite à la classification seule (pas de désignation ni de prix, données catalogue internes,
// repo public) : sert uniquement à fiabiliser bacheGamme au-delà de l'heuristique par préfixe.
const MEGAO_BACHE_FAMILLES = require('./megao-bache-familles.json');

// ─── Firebase ────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:    admin.credential.cert(serviceAccount),
  storageBucket: 'jm-baches.firebasestorage.app',
});
const db     = admin.firestore();
const bucket = admin.storage().bucket();

// ⚠ Doit rester aligné avec PD_DEFAULT_FOLDERS dans index.html (sans 'Général', que
// l'affichage préfixe déjà — cf. fix doublon b8e7995 — et avec le nom actuel
// 'Fiche de fabrication', renommé depuis 'Fiche produit' en 418b702).
const PD_DEFAULT_FOLDERS = ['Bon de commande', 'Facture', 'Fiche de côte', 'Fiche de fabrication'];

// Codes abrégés Mégao pour la couleur de bouchon (motif "B.<code>", ex. "B.TRSP" = Bouchon
// Transparent), quand ce n'est pas déjà un nom de couleur en clair (ex. "B.Noir") — confirmé par
// l'utilisateur (2026-07-22). Compléter si d'autres codes apparaissent.
const BOUCHON_LABELS = { TRSP: 'Transparent' };

// ─── Parser PDF Mégao ────────────────────────────────────────────────────────
// Format réel : tableau de codes produits (VRSIL80S, LAM350, TRSPVR5…)
// Infos client dans le bloc Contact (colonne gauche)
function parseMegaoText(text) {
  // pdf-parse colle le code et la désignation sans espace : VRSIL80SStucture...
  // Le client apparaît directement après COMMANDE N°

  const refM = text.match(/COMMANDE\s+N[°º]\s*([A-Z0-9\-\/]+)/i);
  const ref  = refM ? refM[1].trim() : '';

  // Revendeur : bloc entre la Date et COMMANDE N° — première ligne tout-majuscules
  const revBlockM = text.match(/Date\s*:[^\n]*\n([\s\S]*?)COMMANDE\s+N[°º]/i);
  let revendeur = '';
  if (revBlockM) {
    const revLines = revBlockM[1].split('\n').map(l => l.trim()).filter(Boolean);
    revendeur = revLines.find(l => /^[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ\s\-&\.]+$/.test(l) && !/^\d+$/.test(l)) || '';
  }

  const dateM    = text.match(/Date\s*:\s*(?:[^\d\n]{0,30}\n\s*)?(\d{2})\/(\d{2})\/(\d{4})/i);
  const dateFrom = dateM ? `${dateM[3]}-${dateM[2]}-${dateM[1]}` : '';

  // Codes produits en début de ligne, collés à la désignation
  // Backtracking : VR[A-Z0-9<>]+ greedy, recule jusqu'à trouver [A-Z][a-zÀ-ÿ]. Classe élargie
  // à <> car les codes découpe (VRDEC<20E, VRDEC<60F...) en contiennent.
  const isVolet   = /^(VR[A-Z0-9]|LAM[A-Z]*\d)/m.test(text);
  // Plusieurs lignes VR par commande sont fréquentes (escalier + découpe + structure, vus sur
  // 42% des commandes réelles) — matchAll plutôt qu'un simple match, sinon la première ligne VR
  // rencontrée (parfois un escalier ou une découpe, pas la structure) écrase le vrai type de
  // volet. VRES*/VRDEC* explicitement exclus de la recherche de la ligne "structure".
  const vrAllM    = [...text.matchAll(/^(VR[A-Z0-9<>]+)\s*([A-Z][a-zÀ-ÿé].+)/gm)];
  const isAccessoireVR = code => /^VRES|^VRDEC/.test(code);
  const vrM       = vrAllM.find(m => !isAccessoireVR(m[1])) || null;
  const cleanDesig = m => m[2].replace(/\s*(UN|ML|M2|PCS)\s+.*$/i, '').trim();
  const escalier  = [...new Set(vrAllM.filter(m => /^VRES/.test(m[1])).map(cleanDesig))].join(' ; ');
  const decoupe   = [...new Set(vrAllM.filter(m => /^VRDEC/.test(m[1])).map(cleanDesig))].join(' ; ');
  const lamM      = text.match(/^(LAM[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  // Type de lame : le code produit distingue PVC (LAM…) et Polycarbonate (LAMPOL…)
  const typeLame  = lamM ? (/POL/i.test(lamM[1]) ? 'Polycarbonate' : 'PVC') : '';
  const trspM     = text.match(/^(TRSP[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  const instM     = text.match(/^(TRSP[A-Z0-9]*(?:PINST|INST)(\d{2,3})[A-Z0-9]*)/im);
  const enlevM    = text.match(/^(ENLEV[A-Z0-9]+)/im);
  const JM_COVER_DEPTS = new Set(['01','04','05','06','07','08','12','13','21','25','26','30','34','38','39','42','43','48','51','52','54','55','57','63','67','68','69','70','71','73','74','83','84','88','90']);
  // Structure : correspondance avec les options du select de l'app
  const vrDesig = vrM ? vrM[2].replace(/\s*(UN|ML|M2|PCS)\s+.*$/i, '').trim() : '';
  const vrCode  = vrM ? vrM[1] : '';
  const vrText  = (vrCode + ' ' + vrDesig).toLowerCase();
  const STRUCT_MAP = [
    { k: ['silver roll','vrsil'],           v: 'Volet hors-sol Silver Roll (2h30)' },
    { k: ['golden roll','solaire','vrsol'],  v: 'Volet hors-sol solaire Golden Roll (2h30)' },
    { k: ['coffre','vrcof'],                v: 'Volet hors-sol avec coffre (2h30)' },
    { k: ['x-trem','xtrem','vrxtr','grand bassin'], v: 'Volet hors-sol grand bassin X-Trem Roll (2h30)' },
    { k: ['mouv','mouv&roll','vrmouv'],     v: 'Volet déplaçable Mouv&Roll (3h)' },
    { k: ['subwater total','vrsubt'],       v: 'Volet immergé Subwater Total (6h30)' },
    { k: ['subwater','vrsub'],              v: 'Volet immergé Subwater (5h)' },
  ];
  const structure = STRUCT_MAP.find(m => m.k.some(k => vrText.includes(k)))?.v
                 || vrDesig
                 || (/tablier\s+seul/i.test(text) ? 'Tablier seul' : '');
  const lameRaw   = lamM ? lamM[2].replace(/\s*(UN|ML|M2|PCS)\s+.*$/i, '').trim() : '';
  const lameParenIdx = lameRaw.lastIndexOf(')');
  let lames       = lameParenIdx >= 0 ? lameRaw.slice(lameParenIdx + 1).trim() : lameRaw;
  // Couleur du bouchon (embout de lame) : motif "B. <couleur>" dans le texte Mégao (ex: "B. Noir"
  // = Bouchon noir), distinct de la couleur de la lame elle-même — confirmé par l'utilisateur
  // (2026-07-22), corrige une hypothèse erronée précédente qui lisait "B." comme "Bicolore".
  const bouchonM  = lames.match(/\bB\.\s*([A-Za-zÀ-ÿ]+)\b\s*/i);
  const couleurBouchon = bouchonM
    ? (BOUCHON_LABELS[bouchonM[1].toUpperCase()] || (bouchonM[1].charAt(0).toUpperCase() + bouchonM[1].slice(1).toLowerCase()))
    : '';
  if (bouchonM) lames = (lames.slice(0, bouchonM.index) + lames.slice(bouchonM.index + bouchonM[0].length)).trim();

  // Moteur : suffixe du code VR après le préfixe de structure (VRSIL80S → 80S)
  const moteurM = vrCode.match(/^VR(?:SUBT|SUB|MOUV|XTR|COF|SOL|SIL)([A-Z0-9]+)$/i);
  const moteur  = moteurM ? moteurM[1] : '';

  // Alim + couleur pieds : extraits du bloc de la ligne VR (400 premiers caractères)
  const vrIdx   = vrM ? text.indexOf(vrM[0]) : -1;
  const vrBlock = vrIdx >= 0 ? text.slice(vrIdx, vrIdx + 400) : text;
  const alimM   = vrBlock.match(/\b(\d{2,3})\s*V\b/i);
  const alim    = alimM ? alimM[1] + 'V' : '';
  // Couleur pieds : code RAL 4 chiffres ou nom de couleur après "impultionnelle" ou "RAL"
  const COULEURS = 'blanc|noir|gris|anthracite|beige|marron|brun|ivoire|argent|bronze|bleu|vert|rouge';
  const piedM   = vrBlock.match(new RegExp(`impult\\w*\\s+(\\d{4}|${COULEURS})\\b`, 'i'))
               || vrBlock.match(/\bRAL\s*[-:]?\s*(\d{4})\b/i);
  const piedRaw = piedM ? piedM[1] : '';
  let pieds     = piedRaw ? ((/^\d{4}$/).test(piedRaw) ? `RAL ${piedRaw}` : piedRaw.charAt(0).toUpperCase() + piedRaw.slice(1).toLowerCase()) : '';
  // Option couleur pieds sur ligne à part (ACVRPIEDANT/ACVRMOUVANT) — rare (~6 lignes sur tout
  // l'historique Mégao) mais réelle, jamais captée par l'extraction ci-dessus (ligne séparée de
  // la structure). Vue uniquement pour la finition "Anthracite Granulé/structurée" jusqu'ici —
  // prioritaire sur la couleur pieds déduite de la ligne structure quand présente.
  const piedOptionM = text.match(/^(ACVRPIEDANT|ACVRMOUVANT)\s*([A-Z][a-zÀ-ÿé].+)/m);
  if (piedOptionM) pieds = 'Anthracite Granulé';

  // Largeur depuis le code LAM — chiffre(s) à la fin du code (LAM350→3.50m, LAM45→4.5m, LAM4→4m, LAMPOL4→4m)
  const lamCodeM = text.match(/^LAM[A-Z]*([0-9]+)/m);
  let largeur = '';
  if (lamCodeM) {
    const n = parseInt(lamCodeM[1]);
    largeur = String(lamCodeM[1].length >= 3 ? n / 100 : lamCodeM[1].length === 2 ? n / 10 : n);
  }

  // Longueur : somme des quantités ML de toutes les refs LAM
  // [\s\S]*? pour gérer le cas où ML est sur la ligne suivante (LAMPOL4, etc.)
  const lamLines = [...text.matchAll(/^LAM[A-Z0-9]+[\s\S]*?\bML\s+([\d,]+)/gm)];
  const longueur = lamLines.length
    ? String(lamLines.reduce((sum, m) => sum + parseFloat(m[1].replace(',', '.')), 0))
    : '';

  let transport = 'liv_pose';
  if (enlevM) {
    transport = 'enlvt';
  } else if (instM) {
    const dept = String(parseInt(instM[2])).padStart(2, '0');
    transport  = JM_COVER_DEPTS.has(dept) ? 'liv_pose' : 'livraison';
  } else if (trspM) {
    const d = trspM[2].toUpperCase();
    transport = d.includes('ENLV') ? 'enlvt' : d.includes('POSE') ? 'liv_pose' : 'livraison';
  }

  const telM   = text.match(/T[eé]l\s*:\s*([\d\s.\-\/]+?)(?=\s*\n)/im);
  const tel    = telM ? telM[1].replace(/\s*\/\s*$/, '').trim() : '';
  const emailM = text.match(/E-?mail\s*:\s*([\w.+\-]+@[\w.\-]+\.[a-z]{2,})/i)
              || text.match(/([\w.+\-]+@[\w.\-]+\.[a-z]{2,})/i);
  const email  = emailM ? emailM[1].trim() : '';

  // Client : bloc juste après COMMANDE N° (pdf-parse sort les lignes en colonnes)
  let client = '', contact = '', adresse = '', cp = '', ville = '';
  if (refM) {
    const afterRef = text.slice(refM.index + refM[0].length);
    for (const l of afterRef.split('\n').map(s => s.trim()).filter(Boolean)) {
      if (/^(page\s*:|code\s*client|repr[eé]sentant|r[eé]f[eé]rences|d[eé]lai|t[eé]l|e-?mail|contact\b|d[eé]signation|bulles)/i.test(l)) break;
      if (/^france$/i.test(l)) continue;
      const cpVm = l.match(/^(\d{5})\s+([A-ZÀ-Ÿ][^\n]+)/);
      if (cpVm) { cp = cpVm[1]; ville = cpVm[2].trim(); continue; }
      if (!client)  { client = l; contact = l; continue; }
      if (!adresse) { adresse = l; continue; }
    }
  }
  // Cas "enlèvement" (bloc client remplacé par une instruction de retrait plutôt qu'un nom,
  // confirmé sur données réelles Mégao — CMDCLI.Nomliv contient littéralement "ENLEVEMENT" ou
  // "ENLEVEMENT LE <date>" dans ce cas) : repli sur le revendeur plutôt que de garder un nom
  // manifestement faux (même correction que pour les bâches, cf. parseMegaoBacheText).
  if (/^enl[eè]vement\b/i.test(client) && revendeur) { client = revendeur; contact = revendeur; }

  // HT : "Net HT\n 1 823,84" (valeur sur la ligne suivante dans pdf-parse)
  const htM = text.match(/Net\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i)
           || text.match(/Total\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i);
  const ht  = htM ? parseFloat(htM[1].replace(/\s/g, '').replace(',', '.')) : 0;

  return {
    ref, refCommande: ref, client, contact, tel, email, adresse, cp, ville,
    structure, lames, couleurBouchon, pieds, alim, moteur, typeLame, escalier, decoupe,
    options: '', remarques: '', autres: '',
    largeur, longueur, revendeur,
    transport, ht, dateFrom, isVolet,
  };
}

// ─── Parser PDF Mégao — bâches (barres/bulles/Sécuritis) ─────────────────────
// Même mise en page Mégao que les volets (en-tête/client/revendeur/date/HT identiques,
// cf. parseMegaoText ci-dessus) — seule la partie "lignes produit" change.
// Découverte sur 10 vrais bons de commande : le code produit et sa désignation sont
// collés sans espace par pdf-parse (ex. "BACLASécu Classic SableM2"). Contrairement aux
// codes volet (préfixes fixes VR.../LAM...), les codes bâches n'ont pas de préfixe unique
// exploitable (BA*, BU*, SE*, TRSP*, ENLEV*, ENR*, AC*, GESTECO*) : la coupure fiable est
// la frontière MAJUSCULES-only (le code) → Majuscule+minuscule (début de la désignation en
// Title Case), qui correspond exactement à l'espace supprimé par pdf-parse.
const BACHE_LIGNE_RE = /^([A-Z][A-Z0-9\/\+]{1,15})([A-ZÀ-Þ][a-zà-ÿ][\s\S]*?)(?:M2|UN)/gm;

function isBache(text) {
  return /^(BA[A-Z]|BU[A-Z0-9]|SEES|SEECH|TRSPBA|TRSPBU|TRSPHI|ENLEVBA)/m.test(text);
}

// Catégories d'accessoires bâches — alignées sur les vraies sections de l'inventaire JM
// (fichier Excel "INVENTAIRE 2025.xlsx", feuille "INVENTAIRE BACHES", remonté par l'utilisateur
// le 2026-07-22 : "ACCESSOIRES BULLES", "ROLLING UP", "ACCESSOIRES BACHE SECU+", "ACCESSOIRES
// BACHE BARRE/HIVER", "CHIMIE"), recoupées avec l'audit réel des 63 735 commandes CMDCLIB pour
// ne garder que des codes effectivement vus. "Sécu+" et "Barre/Hiver" fusionnés en une seule
// catégorie : plusieurs codes (ex. ACPITESC) apparaissent dans les DEUX sections de
// l'inventaire, la frontière n'est pas nette. ACANTIABRA/ACCLIQINOX/ACKITSOUT (fréquents dans
// l'historique de commandes réel mais absents de l'inventaire actuel — probablement
// discontinués/renommés) rattachés à cette même catégorie par proximité de sens (accessoires
// de fixation/protection barres). Codes déjà couverts par un champ dédié (bacheOeilletsSupp,
// bacheDecoupeAspi/Escalier, bacheBarreCharge, bacheEnrouleur) volontairement PAS répétés ici
// pour éviter un double affichage de la même info.
const BACHE_ACCESSORY_PREFIXES = {
  'Bulles (accessoires)':               ['ACBOUFEUIL', 'ACSANENR', 'ACENRDEMUL', 'ACBUSANGLET', 'ACBUBACHET', 'ACBUROUL', 'ACBUBAV'],
  'Enrouleur (accessoire)':             ['ACRUPRELAIS', 'ACRUPBOUT', 'ACRUPCHARG', 'ACBACARR'],
  'Sécu+ / Barre / Hiver (accessoire)': ['ACBABOUCH', 'ACSANGCLIQ', 'ACPITESC', 'ACPITBOIS', 'ACBAALU', 'ACBAENR', 'ACROINOX', 'ACROPLAST', 'ACAB', 'ACPITCROS', 'ACPITGAZ', 'ACPLAQUET', 'ACMANIV', 'ACSANCROACIER', 'ACSANVECO', 'ACSANGLUX', 'ACSANGD', 'ACSANGRAP', 'ACSANGGAN', 'ACKITPAT', 'ACBAVOL', 'ACOL', 'ACANTIABRA', 'ACCLIQINOX', 'ACKITSOUT'],
  'Entretien':                          ['CHHJ', 'CHGAPPTRAIT', 'BROME', 'CHEMOBROME', 'CHLORE', 'DIACLOR', 'CLEARPOOL'],
  'Divers':                             ['ACBOUEAU'],
};
function classifyBacheAccessoire(code) {
  for (const [label, prefixes] of Object.entries(BACHE_ACCESSORY_PREFIXES)) {
    if (prefixes.some(p => code.startsWith(p))) return label;
  }
  return null;
}
// Financier/logistique — jamais des accessoires produit, retirés du texte libre "options"
// (confirmé par le même audit) plutôt que mélangés à la fabrication.
const BACHE_IGNORE_EXACT = new Set(['FRANCO', 'CR', 'NBDEVIS']);
// SAV/reprise (texte libre sur un code générique "*T", ou ACNEGOCE) — vraie info utile pour
// l'atelier, mais pas un accessoire produit : routé vers "remarques" plutôt que jeté ou noyé
// dans "options".
const BACHE_SAV_CODES = new Set(['*T', 'ACNEGOCE']);

function parseMegaoBacheText(text) {
  // En-tête / client / revendeur / date / HT : identique à parseMegaoText (même mise en
  // page Mégao) — dupliqué ici plutôt que factorisé pour ne pas fragiliser le chemin volet
  // existant (cf. convention "fonction sœur" déjà utilisée pour renderPageCommandeBache).
  const refM = text.match(/COMMANDE\s+N[°º]\s*([A-Z0-9\-\/]+)/i);
  const ref  = refM ? refM[1].trim() : '';

  const revBlockM = text.match(/Date\s*:[^\n]*\n([\s\S]*?)COMMANDE\s+N[°º]/i);
  let revendeur = '';
  if (revBlockM) {
    const revLines = revBlockM[1].split('\n').map(l => l.trim()).filter(Boolean);
    revendeur = revLines.find(l => /^[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ\s\-&\.]+$/.test(l) && !/^\d+$/.test(l)) || '';
  }

  const dateM    = text.match(/Date\s*:\s*(?:[^\d\n]{0,30}\n\s*)?(\d{2})\/(\d{2})\/(\d{4})/i);
  const dateFrom = dateM ? `${dateM[3]}-${dateM[2]}-${dateM[1]}` : '';

  const telM   = text.match(/T[eé]l\s*:\s*([\d\s.\-\/]+?)(?=\s*\n)/im);
  const tel    = telM ? telM[1].replace(/\s*\/\s*$/, '').trim() : '';
  const emailM = text.match(/E-?mail\s*:\s*([\w.+\-]+@[\w.\-]+\.[a-z]{2,})/i)
              || text.match(/([\w.+\-]+@[\w.\-]+\.[a-z]{2,})/i);
  const email  = emailM ? emailM[1].trim() : '';

  let client = '', contact = '', adresse = '', cp = '', ville = '';
  if (refM) {
    const afterRef = text.slice(refM.index + refM[0].length);
    for (const l of afterRef.split('\n').map(s => s.trim()).filter(Boolean)) {
      if (/^(page\s*:|code\s*client|repr[eé]sentant|r[eé]f[eé]rences|d[eé]lai|t[eé]l|e-?mail|contact\b|d[eé]signation|bulles)/i.test(l)) break;
      if (/^france$/i.test(l)) continue;
      const cpVm = l.match(/^(\d{5})\s+([A-ZÀ-Ÿ][^\n]+)/);
      if (cpVm) { cp = cpVm[1]; ville = cpVm[2].trim(); continue; }
      if (!client)  { client = l; contact = l; continue; }
      if (!adresse) { adresse = l; continue; }
    }
  }
  // Cas "enlèvement" (vu sur commande 120791 réelle) : le bloc client n'est pas un nom mais
  // une instruction ("ENLEVEMENT" / "PREVENIR ..."), le vrai client apparaît dans le bloc
  // revendeur à la place. Repli sur revendeur plutôt que de garder un nom manifestement faux.
  if (/^enl[eè]vement$/i.test(client) && revendeur) { client = revendeur; contact = revendeur; }

  const htM = text.match(/Net\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i)
           || text.match(/Total\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i);
  const ht  = htM ? parseFloat(htM[1].replace(/\s/g, '').replace(',', '.')) : 0;

  // Lignes produit : {code, design} pour chaque ligne détectée
  const lignes = [...text.matchAll(BACHE_LIGNE_RE)].map(m => ({
    code: m[1],
    design: m[2].replace(/\s*\n\s*/g, ' ').trim(),
  }));

  // Ligne "principale" = le produit bâche lui-même, pas un accessoire/transport.
  // SEES (escalier standard Sécuritis) exclu explicitement : commence comme SE/SEEC mais
  // c'est un accessoire, pas le produit (vu sur la commande 120892 réelle, les deux
  // apparaissent dans le même bon de commande).
  const mainLigne = lignes.find(l => /^(BA|BU)/.test(l.code) || l.code === 'SE' || /^SEEC/.test(l.code)) || null;
  const structure = mainLigne ? mainLigne.design : '';
  const bacheModele = mainLigne ? mainLigne.code : '';
  // Gamme déduite en priorité du catalogue officiel Mégao (ARTICLE.mkd, code→famille
  // BA/BU/HI — voir megao-bache-familles.json et la mémoire projet pour la méthode de
  // décodage), repli sur une heuristique de préfixe si le code n'y figure pas (ex. variante
  // pas encore au catalogue, commande multi-produits). "HIVER" (bâche dite "Sécuritis") est
  // une 3e famille Mégao officielle, confirmée via FAMART.mkd — l'app ne modélise aujourd'hui
  // que Barres/Bulles pour bacheGamme, donc "Hiver" y est stocké tel quel (donnée honnête,
  // n'importe quelle valeur hors Barres/Bulles affiche déjà les deux jeux de champs sans
  // erreur côté fiche — décision produit actée avec l'utilisateur de ne pas retoucher la
  // modale pour l'instant).
  const FAMILLE_GAMME = { BA: 'Barres', BU: 'Bulles', HI: 'Hiver' };
  const bacheGamme = mainLigne
    ? (FAMILLE_GAMME[MEGAO_BACHE_FAMILLES[mainLigne.code]]
       || (/^BA/.test(mainLigne.code) ? 'Barres' : /^BU/.test(mainLigne.code) ? 'Bulles' : ''))
    : '';

  // Escalier standard : ACESBAR (Barres/Bulles) + HIES (Hiver, même famille jamais captée
  // avant — trouvée dans l'audit CMDCLIB réel). HIESHS (hors-standard) prioritaire si présent.
  const hasEscalierStandard    = lignes.some(l => l.code === 'ACESBAR' || l.code === 'SEES' || l.code === 'HIES');
  const hasEscalierHorsStandard = lignes.some(l => l.code === 'HIESHS');
  const bacheDecoupeEscalier = hasEscalierHorsStandard ? 'Hors-standard' : (hasEscalierStandard ? 'Standard' : '');
  const bacheBarreCharge     = lignes.some(l => l.code === 'ACBACHAR') ? 'Oui' : '';
  // Découpe aspiration/échelle : champ existant côté UI (f-bacheDecoupeAspi), jamais alimenté
  // par ce parseur jusqu'ici — ACDECASPI (Barres/Bulles) / HIDECASPI (Hiver).
  const bacheDecoupeAspi = lignes.some(l => l.code === 'ACDECASPI' || l.code === 'HIDECASPI') ? 'Oui' : '';
  // Œillets supplémentaires (bulles) : champ existant côté UI (f-bacheOeilletsSupp), jamais
  // alimenté non plus — ACOEILPLAST/ACOEILMETAL/ACKITEMPOEIL vus dans l'audit réel.
  const OEILLETS_CODES = ['ACOEILPLAST', 'ACOEILMETAL', 'ACKITEMPOEIL'];
  const bacheOeilletsSupp = lignes.some(l => OEILLETS_CODES.includes(l.code)) ? 'Oui' : '';
  // Enrouleur : le vrai code produit est "RUP*" (Rolling-Up), PAS "ENR*" comme supposé jusqu'ici
  // (confirmé par audit réel : RUPCDE/RUPMANIV totalisent >1000 lignes jamais reconnues — le
  // placeholder UI "ex: RUPCDE, ENRHS..." le savait déjà, juste jamais câblé côté parseur).
  const enrouleurLigne       = lignes.find(l => /^(ENR|RUP)/.test(l.code));
  const bacheEnrouleur       = enrouleurLigne ? enrouleurLigne.code : '';

  const transportLigne = lignes.find(l => /^TRSP/.test(l.code));
  const bacheTransportZone = transportLigne
    ? transportLigne.design.replace(/^Transport[^-]*-\s*/i, '').trim()
    : '';
  const isEnlevement = lignes.some(l => /^ENLEV/.test(l.code));

  // Accessoires classés (voir BACHE_ACCESSORY_PREFIXES) — dédupliqués, affichés en plus du champ
  // "options" plutôt que noyés dedans en texte brut.
  const bacheAccessoires = [...new Set(lignes.map(l => classifyBacheAccessoire(l.code)).filter(Boolean))];
  // Notes SAV/reprise (code générique "*T" ou ACNEGOCE) → remarques, pas "options" ni perdues.
  const bacheSavNotes = lignes.filter(l => BACHE_SAV_CODES.has(l.code)).map(l => l.design);
  const remarques = bacheSavNotes.join(' / ');

  // Lignes ni principale, ni transport/enlèvement/enrouleur, ni catégorisées dans un champ
  // dédié ou une catégorie d'accessoire connue, ni financier/logistique (FRANCO, contre-
  // remboursement, geste commercial, disclaimer devis) ni SAV (routé vers remarques ci-dessus)
  // → conservées en texte libre, seul filet de sécurité pour un code vraiment inconnu.
  const autresLignes = lignes.filter(l =>
    l !== mainLigne &&
    !/^TRSP/.test(l.code) && !/^ENLEV/.test(l.code) && !/^(ENR|RUP)/.test(l.code) &&
    l.code !== 'ACESBAR' && l.code !== 'SEES' && l.code !== 'HIES' && l.code !== 'HIESHS' &&
    l.code !== 'ACBACHAR' &&
    l.code !== 'ACDECASPI' && l.code !== 'HIDECASPI' &&
    !OEILLETS_CODES.includes(l.code) &&
    !classifyBacheAccessoire(l.code) &&
    !BACHE_IGNORE_EXACT.has(l.code) && !/^GESTECO/.test(l.code) &&
    !BACHE_SAV_CODES.has(l.code)
  );
  const options = [...bacheAccessoires, ...autresLignes.map(l => l.design)].join(' — ');

  return {
    ref, refCommande: ref, client, contact, tel, email, adresse, cp, ville, revendeur,
    dateFrom, ht,
    type: 'bache',
    structure, bacheModele, bacheGamme,
    bacheDecoupeEscalier, bacheBarreCharge, bacheDecoupeAspi, bacheOeilletsSupp,
    bacheEnrouleur, bacheTransportZone, bacheAccessoires, remarques,
    options,
    transport: isEnlevement ? 'enlvt' : 'livraison',
    isBache: isBache(text),
  };
}

// ─── Upload PDF vers Firebase Storage ────────────────────────────────────────
async function uploadPdfToStorage(pdfBuffer, dosId, originalFilename) {
  const ts       = Date.now();
  const safeName = originalFilename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path     = `dossiers/${dosId}/${ts}_${safeName}`;
  const file     = bucket.file(path);

  await file.save(pdfBuffer, { metadata: { contentType: 'application/pdf' } });

  const token = randomUUID();
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  return { url, path, size: pdfBuffer.length };
}

// Empêche de ré-uploader/ré-attacher le même PDF plusieurs fois quand un dossier existant
// est retraité (ex. plusieurs passages sur le même email avant sa suppression) — bug réel
// observé en production (jusqu'à 5 copies du même bon de commande sur un même dossier).
function hasSameDoc(existingDocuments, folder, filename) {
  return (existingDocuments || []).some(d => d.folder === folder && d.name === filename);
}

function buildDocEntry(uploaded, filename, nowAt) {
  return {
    id:         `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name:       filename,
    url:        uploaded.url,
    path:       uploaded.path,
    type:       'application/pdf',
    size:       uploaded.size,
    folder:     'Bon de commande',
    uploadedBy: 'megao-sync',
    uploadedAt: nowAt,
  };
}

// ─── Helpers Dercya ──────────────────────────────────────────────────────────
const isDercya      = d => /dercya/i.test(d.revendeur || '');
const isParticulier = d => /particulier/i.test(d.revendeur || '');

// ─── Ref Mégao → ID Firestore (remplace "/" par "-") ─────────────────────────
function refToId(ref) {
  return (ref || '').replace(/\//g, '-').replace(/\s+/g, '_').trim();
}

// ─── Créer ou mettre à jour le dossier ───────────────────────────────────────
async function upsertDossier(data, pdfBuffer = null, pdfFilename = '') {
  if (!data.ref) { console.warn('Ref absente — dossier ignoré'); return; }

  const nowDate  = new Date();
  const now      = nowDate.toISOString();
  const today    = now.split('T')[0];
  const nowAt    = nowDate.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'})
                 + ' à ' + nowDate.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});

  const dosId    = refToId(data.ref);
  const docRef   = db.collection('dossiers').doc(dosId);
  const existing = await docRef.get();

  if (existing.exists) {
    const doc    = { id: dosId, ref: docRef };
    const prev   = existing.data();
    const fields = ['client','tel','email','contact','adresse','cp','ville',
                    'structure','lames','couleurBouchon','typeLame','pieds','alim','moteur','escalier','decoupe','options','remarques','autres','transport',
                    'largeur','longueur','revendeur','refCommande'];
    const update = {};
    for (const f of fields) {
      if (data[f]) update[f] = data[f];
    }
    if (data.ht > 0 && !prev.ht) update.ht = data.ht;
    if (pdfBuffer && pdfFilename && !hasSameDoc(prev.documents, 'Bon de commande', pdfFilename)) {
      const uploaded = await uploadPdfToStorage(pdfBuffer, dosId, pdfFilename);
      update.documents  = admin.firestore.FieldValue.arrayUnion(buildDocEntry(uploaded, pdfFilename, nowAt));
      update.docFolders = admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS);
    }
    update.history = [
      ...(prev.history || []),
      { id: Date.now(), type: 'megao', action: 'Mis à jour depuis Mégao', detail: '', user: 'megao-sync', at: nowAt }
    ];
    await docRef.update(update);
    console.log(`✓ Mis à jour : ${dosId} (ref: ${data.ref})`);
  } else {
    let initialDocs = [];
    if (pdfBuffer && pdfFilename) {
      const uploaded = await uploadPdfToStorage(pdfBuffer, dosId, pdfFilename);
      initialDocs = [buildDocEntry(uploaded, pdfFilename, nowAt)];
    }
    await docRef.set({
      client:      data.client     || '',
      tel:         data.tel        || '',
      email:       data.email      || '',
      contact:     data.contact    || '',
      adresse:     data.adresse    || '',
      cp:          data.cp         || '',
      ville:       data.ville      || '',
      contraintes: '',
      structure:   data.structure  || '',
      escalier:    data.escalier   || '',
      decoupe:     data.decoupe    || '',
      options:     data.options    || '',
      lames:       data.lames      || '',
      couleurBouchon: data.couleurBouchon || '',
      typeLame:    data.typeLame   || '',
      pieds:       data.pieds      || '',
      alim:        data.alim       || '',
      moteur:      data.moteur     || '',
      ht:          data.ht         || 0,
      tva:         20,
      ref:          data.ref,
      refCommande:  data.ref,
      devisStatut: 'accepte',
      dateFrom:      data.dateFrom   || today,
      dateTo:        '',
      dateLivraison: data.dateFrom   || today,
      transport:   data.transport  || 'liv_pose',
      remarques:   data.remarques  || '',
      autres:      data.autres     || '',
      largeur:     data.largeur    || '',
      longueur:    data.longueur   || '',
      revendeur:   data.revendeur  || '',
      needPose:    data.transport  === 'liv_pose',
      poseDate:    '',
      statut:      'admin',
      createdBy:   'megao-sync',
      pages: [
        { type: 'commande', label: 'Fiche commande', checks: {} },
        { type: 'verif', label: 'Vérification atelier', checks: {}, rows: ['Rayons','Pans coupés','Lames coupées','Lames finies','Axe','Contre axe + rails','Découpe ESC en équerre','Découpe ESC en lisse','Poutre + cornière','Cloison','Caillebotis'] }
      ],
      documents:   initialDocs,
      docFolders:  PD_DEFAULT_FOLDERS,
      history:     [{ id: Date.now(), type: 'création', action: 'Créé automatiquement depuis Mégao', detail: '', user: 'megao-sync', at: nowAt }]
    });
    console.log(`✓ Créé : ${dosId} (ref: ${data.ref}, client: ${data.client})`);
  }
}

// Doit rester aligné avec VERIF_ROWS_BACHE dans index.html (dupliqué ici — script Node
// séparé, pas de module partagé avec le front).
const VERIF_ROWS_BACHE = ['Dimensions bâche conformes bassin','Coloris conforme commande','Découpes (aspi/escalier) conformes','Enrouleur conforme','Œillets/finitions','Contrôle qualité soudures','Emballage complet'];

// ─── Créer ou mettre à jour le dossier — bâches ──────────────────────────────
// Fonction sœur de upsertDossier plutôt que branches conditionnelles dedans : champs et
// page "verif" par défaut différents, et pas de logique liv_pose/needPose (jamais de pose
// sur une bâche, cf. index.html isBacheDossier).
async function upsertDossierBache(data, pdfBuffer = null, pdfFilename = '') {
  if (!data.ref) { console.warn('Ref absente — dossier ignoré'); return; }

  const nowDate  = new Date();
  const now      = nowDate.toISOString();
  const today    = now.split('T')[0];
  const nowAt    = nowDate.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'})
                 + ' à ' + nowDate.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});

  const dosId    = refToId(data.ref);
  const docRef   = db.collection('dossiers').doc(dosId);
  const existing = await docRef.get();

  if (existing.exists) {
    const doc    = { id: dosId, ref: docRef };
    const prev   = existing.data();
    const fields = ['client','tel','email','contact','adresse','cp','ville',
                    'structure','bacheModele','bacheGamme','bacheDecoupeEscalier','bacheBarreCharge',
                    'bacheDecoupeAspi','bacheOeilletsSupp','bacheAccessoires','remarques',
                    'bacheEnrouleur','bacheTransportZone','options','transport','revendeur','refCommande'];
    const update = {};
    for (const f of fields) {
      if (data[f]) update[f] = data[f];
    }
    if (data.ht > 0 && !prev.ht) update.ht = data.ht;
    if (pdfBuffer && pdfFilename && !hasSameDoc(prev.documents, 'Bon de commande', pdfFilename)) {
      const uploaded = await uploadPdfToStorage(pdfBuffer, dosId, pdfFilename);
      update.documents  = admin.firestore.FieldValue.arrayUnion(buildDocEntry(uploaded, pdfFilename, nowAt));
      update.docFolders = admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS);
    }
    update.history = [
      ...(prev.history || []),
      { id: Date.now(), type: 'megao', action: 'Mis à jour depuis Mégao', detail: '', user: 'megao-sync', at: nowAt }
    ];
    await docRef.update(update);
    console.log(`✓ Mis à jour (bâche) : ${dosId} (ref: ${data.ref})`);
  } else {
    let initialDocs = [];
    if (pdfBuffer && pdfFilename) {
      const uploaded = await uploadPdfToStorage(pdfBuffer, dosId, pdfFilename);
      initialDocs = [buildDocEntry(uploaded, pdfFilename, nowAt)];
    }
    await docRef.set({
      type:        'bache',
      client:      data.client     || '',
      tel:         data.tel        || '',
      email:       data.email      || '',
      contact:     data.contact    || '',
      adresse:     data.adresse    || '',
      cp:          data.cp         || '',
      ville:       data.ville      || '',
      contraintes: '',
      structure:   data.structure  || '',
      bacheModele:          data.bacheModele          || '',
      bacheGamme:           data.bacheGamme           || '',
      bacheDecoupeEscalier: data.bacheDecoupeEscalier || '',
      bacheBarreCharge:     data.bacheBarreCharge     || '',
      bacheDecoupeAspi:     data.bacheDecoupeAspi     || '',
      bacheOeilletsSupp:    data.bacheOeilletsSupp    || '',
      bacheAccessoires:     data.bacheAccessoires     || [],
      bacheEnrouleur:       data.bacheEnrouleur       || '',
      bacheTransportZone:   data.bacheTransportZone   || '',
      options:     data.options    || '',
      ht:          data.ht         || 0,
      tva:         20,
      ref:          data.ref,
      refCommande:  data.ref,
      devisStatut: 'accepte',
      dateFrom:      data.dateFrom   || today,
      dateTo:        '',
      dateLivraison: data.dateFrom   || today,
      transport:   data.transport  || 'livraison',
      remarques:   data.remarques  || '',
      autres:      '',
      revendeur:   data.revendeur  || '',
      needPose:    false,
      poseDate:    '',
      statut:      'admin',
      createdBy:   'megao-sync',
      pages: [
        { type: 'commande', label: 'Fiche commande', checks: {} },
        { type: 'verif', label: 'Vérification atelier', checks: {}, rows: [...VERIF_ROWS_BACHE] }
      ],
      documents:   initialDocs,
      docFolders:  PD_DEFAULT_FOLDERS,
      history:     [{ id: Date.now(), type: 'création', action: 'Créé automatiquement depuis Mégao', detail: '', user: 'megao-sync', at: nowAt }]
    });
    console.log(`✓ Créé (bâche) : ${dosId} (ref: ${data.ref}, client: ${data.client})`);
  }
}

// ─── Fusion paire Dercya (1 BDC livraison + 1 BDC pose → 1 dossier liv_pose) ──
async function upsertDercyaPair(dercyaItem, poseItem) {
  const nowDate = new Date();
  const today   = nowDate.toISOString().split('T')[0];
  const nowAt   = nowDate.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' })
                + ' à ' + nowDate.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });

  const data = { ...dercyaItem.data, transport: 'liv_pose', needPose: true };

  // L'ID = ref Mégao de la commande Dercya (source principale)
  const dosId      = refToId(dercyaItem.data.ref);
  const pairDocRef = db.collection('dossiers').doc(dosId);
  const existingSnap = await pairDocRef.get();
  const existingDoc  = existingSnap.exists ? { id: dosId, ref: pairDocRef, data: () => existingSnap.data() } : null;

  // Upload les 2 PDFs (sauf si déjà attachés — évite les doublons en cas de retraitement)
  const existingDocuments = existingSnap.exists ? existingSnap.data().documents : null;
  const docs = [];
  for (const { buf, name } of [
    { buf: dercyaItem.pdfBuffer, name: dercyaItem.pdfFilename },
    { buf: poseItem.pdfBuffer,   name: poseItem.pdfFilename   },
  ]) {
    if (buf && !hasSameDoc(existingDocuments, 'Bon de commande', name)) {
      docs.push(buildDocEntry(await uploadPdfToStorage(buf, dosId, name), name, nowAt));
    }
  }

  if (existingDoc) {
    const prev = existingDoc.data();
    const update = { transport: 'liv_pose', needPose: true };
    if (docs.length > 0) {
      update.documents  = admin.firestore.FieldValue.arrayUnion(...docs);
      update.docFolders = admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS);
    }
    update.history = [...(prev.history || []), {
      id: Date.now(), type: 'megao',
      action: 'Fusionné paire Dercya → liv+pose',
      detail: `${dercyaItem.data.ref} + ${poseItem.data.ref}`,
      user: 'megao-sync', at: nowAt,
    }];
    await pairDocRef.update(update);
    console.log(`✓ Paire Dercya mise à jour : ${dosId}`);
  } else {
    await pairDocRef.set({
      client: data.client || '', tel: data.tel || '', email: data.email || '',
      contact: data.contact || '', adresse: data.adresse || '', cp: data.cp || '',
      ville: data.ville || '', contraintes: '', structure: data.structure || '',
      options: data.options || '', lames: data.lames || '', typeLame: data.typeLame || '', pieds: data.pieds || '',
      alim: data.alim || '', moteur: data.moteur || '', ht: data.ht || 0, tva: 20,
      ref: data.ref, refCommande: data.ref, devisStatut: 'accepte',
      dateFrom: data.dateFrom || today, dateTo: '', dateLivraison: data.dateFrom || today,
      transport: 'liv_pose', remarques: data.remarques || '', autres: data.autres || '',
      largeur: data.largeur || '', longueur: data.longueur || '',
      revendeur: data.revendeur || '', needPose: true, poseDate: '', statut: 'admin',
      createdBy: 'megao-sync',
      pages: [
        { type: 'commande', label: 'Fiche commande', checks: {} },
        { type: 'verif',    label: 'Vérification atelier', checks: {}, rows: ['Rayons','Pans coupés','Lames coupées','Lames finies','Axe','Contre axe + rails','Découpe ESC en équerre','Découpe ESC en lisse','Poutre + cornière','Cloison','Caillebotis'] },
      ],
      documents: docs, docFolders: PD_DEFAULT_FOLDERS,
      history: [{ id: Date.now(), type: 'création', action: 'Créé depuis Mégao — paire Dercya (liv+pose)', detail: `${dercyaItem.data.ref} + ${poseItem.data.ref}`, user: 'megao-sync', at: nowAt }],
    });
    console.log(`✓ Paire Dercya créée : ${dosId} (${dercyaItem.data.ref} + ${poseItem.data.ref})`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Démarrage sync Mégao…`);

  const imap = new ImapFlow({
    host:   'imap.gmail.com',
    port:   993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
    logger: false,
  });

  await imap.connect();
  const lock = await imap.getMailboxLock('INBOX');

  try {
    const uids = await imap.search({ seen: false }, { uid: true });
    console.log(`${uids.length} email(s) non lu(s) trouvé(s)`);

    // ── Phase 1 : parser tous les PDFs ────────────────────────────────────────
    const items      = [];  // { uid, data, pdfBuffer, pdfFilename } — volets
    const bacheItems = [];  // { uid, data, pdfBuffer, pdfFilename } — bâches
    const skipUids   = []; // emails sans PDF ni commande reconnue → marquer lu seulement

    for (const uid of uids) {
      const msg    = await imap.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);

      const pdfAtt = parsed.attachments.find(a =>
        a.contentType === 'application/pdf' ||
        (a.filename || '').toLowerCase().endsWith('.pdf')
      );

      if (!pdfAtt) {
        console.log(`Aucun PDF dans : "${parsed.subject}" — email marqué lu`);
        skipUids.push(uid);
        continue;
      }

      console.log(`PDF trouvé : ${pdfAtt.filename} (${Math.round(pdfAtt.size / 1024)}ko)`);
      const pdfData = await pdfParse(pdfAtt.content);
      const data    = parseMegaoText(pdfData.text);
      console.log(`Ref: ${data.ref || '(non trouvée)'} | Client: ${data.client || '(non trouvé)'} | Revendeur: ${data.revendeur || '—'} | Volet: ${data.isVolet}`);

      if (data.isVolet) {
        items.push({ uid, data, pdfBuffer: pdfAtt.content, pdfFilename: pdfAtt.filename || 'bon-de-commande.pdf' });
        continue;
      }

      const bData = parseMegaoBacheText(pdfData.text);
      if (bData.isBache) {
        console.log(`→ Bâche détectée : ${bData.bacheModele || '(modèle non identifié)'} (${bData.bacheGamme || 'gamme inconnue'})`);
        bacheItems.push({ uid, data: bData, pdfBuffer: pdfAtt.content, pdfFilename: pdfAtt.filename || 'bon-de-commande.pdf' });
        continue;
      }

      console.log(`→ Ni volet ni bâche reconnue — email ignoré`);
      skipUids.push(uid);
    }

    // Marquer lu les emails sans commande reconnue
    for (const uid of skipUids) {
      await imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
    }

    // ── Phase bâches : upsert direct (pas de logique de paire Dercya/pose) ────
    for (const { uid, data, pdfBuffer, pdfFilename } of bacheItems) {
      await upsertDossierBache(data, pdfBuffer, pdfFilename);
      await imap.messageDelete([uid], { uid: true });
      console.log(`Email supprimé`);
    }

    // ── Phase 2 : détecter les paires Dercya dans ce batch ───────────────────
    const used   = new Set();
    const tasks  = []; // { type: 'pair'|'single', ... }

    for (let i = 0; i < items.length; i++) {
      if (used.has(i)) continue;
      const a = items[i];
      if (isDercya(a.data) || isParticulier(a.data)) {
        const j = items.findIndex((b, idx) =>
          idx !== i && !used.has(idx) &&
          a.data.client && b.data.client &&
          a.data.client.toLowerCase() === b.data.client.toLowerCase() &&
          ((isDercya(a.data) && isParticulier(b.data)) || (isParticulier(a.data) && isDercya(b.data)))
        );
        if (j !== -1) {
          const [dItem, pItem] = isDercya(a.data) ? [a, items[j]] : [items[j], a];
          tasks.push({ type: 'pair', dercya: dItem, pose: pItem });
          used.add(i); used.add(j);
          console.log(`→ Paire Dercya détectée : "${a.data.client}" (${a.data.ref} + ${items[j].data.ref})`);
          continue;
        }
      }
      tasks.push({ type: 'single', item: a });
      used.add(i);
    }

    // ── Phase 3 : upsert ──────────────────────────────────────────────────────
    for (const task of tasks) {
      if (task.type === 'pair') {
        await upsertDercyaPair(task.dercya, task.pose);
        await imap.messageDelete([task.dercya.uid, task.pose.uid], { uid: true });
        console.log(`Emails paire supprimés`);
      } else {
        const { uid, data, pdfBuffer, pdfFilename } = task.item;
        // Fallback cross-batch : si commande "particulier" sans partenaire dans ce batch,
        // chercher en Firestore un dossier Dercya créé aujourd'hui avec le même client.
        if (isParticulier(data) && data.client) {
          const today = new Date().toISOString().split('T')[0];
          const snap  = await db.collection('dossiers')
            .where('client',    '==', data.client)
            .where('dateFrom',  '==', today)
            .where('createdBy', '==', 'megao-sync')
            .limit(1).get();
          if (!snap.empty && isDercya(snap.docs[0].data())) {
            console.log(`→ Commande pose trouvée pour dossier Dercya existant : ${snap.docs[0].id}`);
            const nowDate = new Date();
            const nowAt   = nowDate.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' })
                          + ' à ' + nowDate.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
            const prev    = snap.docs[0].data();
            const update  = { transport: 'liv_pose', needPose: true };
            if (pdfBuffer && !hasSameDoc(prev.documents, 'Bon de commande', pdfFilename)) {
              const up = await uploadPdfToStorage(pdfBuffer, snap.docs[0].id, pdfFilename);
              update.documents  = admin.firestore.FieldValue.arrayUnion(buildDocEntry(up, pdfFilename, nowAt));
              update.docFolders = admin.firestore.FieldValue.arrayUnion(...PD_DEFAULT_FOLDERS);
            }
            update.history = [...(prev.history || []), {
              id: Date.now(), type: 'megao', action: 'Commande pose Dercya fusionnée',
              detail: data.ref, user: 'megao-sync', at: nowAt,
            }];
            await snap.docs[0].ref.update(update);
            await imap.messageDelete([uid], { uid: true });
            console.log(`Email supprimé`);
            continue;
          }
        }
        await upsertDossier(data, pdfBuffer, pdfFilename);
        await imap.messageDelete([uid], { uid: true });
        console.log(`Email supprimé`);
      }
    }

    console.log(`[${new Date().toISOString()}] Sync terminée`);
  } finally {
    lock.release();
    await imap.logout();
  }
}

main().catch(e => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});
