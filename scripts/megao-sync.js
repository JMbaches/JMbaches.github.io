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
const PD_DEFAULT_FOLDERS = ['Bon de commande', 'Facture', 'Fiche de côte', 'Fiche de fabrication', 'Photos'];

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
  // [\s\S]*? (pas .+) pour spanner un retour à la ligne PDF quand la couleur/finition est
  // rejetée sur la ligne suivante par pdf-parse (ex. "...(le ml) Poly\nBleu/Noir" — vérifié sur
  // le vrai PDF du dossier 120969, couleur "Bleu/Noir" perdue en silence, lames="Poly" seul) —
  // même classe de bug que le fix longueur du 2026-07-23 (087d458), cette fois sur la couleur.
  // S'arrête juste avant le marqueur de quantité (UN/ML/M2/PCS + chiffre), qu'il soit collé sans
  // espace (BlancML, cas déjà géré) ou sur une ligne séparée (nouveau cas).
  // Plusieurs lignes LAM possibles sur une même commande (2 longueurs différentes, ou PVC +
  // Polycarbonate) — vu sur 12/130 commandes réelles (~9%, mesuré le 2026-07-28). Avant ce fix,
  // seule la 1ère ligne était captée, les suivantes silencieusement perdues (aucune trace nulle
  // part, ni fiche ni décompte stock). matchAll plutôt qu'un simple match, comme pour vrAllM plus
  // haut (même classe de bug, même remède).
  const lamAllM   = [...text.matchAll(/^(LAM[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé][\s\S]*?)(?:UN|ML|M2|PCS)\s+[\d,]/gim)];
  // Type de lame (dérivé plus bas, une fois la ligne canonique choisie parmi lamAllM — voir
  // lameInfoFirst) : le code produit distingue PVC (LAM…) et Polycarbonate (LAMPOL…), mais le
  // segment "DECROCHE" (petit morceau de tablier pour un bassin avec décroché, cf. deriveLameInfo)
  // porte parfois un code LAM générique même quand le tablier principal est en Polycarbonate — s'y
  // fier pour le type donnerait un typeLame faux (vu réellement sur le dossier 120770).
  const trspM     = text.match(/^(TRSP[A-Z0-9]+)\s*([A-Z][a-zÀ-ÿé].+)/m);
  const instM     = text.match(/^(TRSP[A-Z0-9]*(?:PINST|INST)(\d{2,3})[A-Z0-9]*)/im);
  const enlevM    = text.match(/^(ENLEV[A-Z0-9]+)/im);
  const JM_COVER_DEPTS = new Set(['01','04','05','06','07','08','12','13','21','25','26','30','34','38','39','42','43','48','51','52','54','55','57','63','67','68','69','70','71','73','74','83','84','88','90']);
  // Structure : correspondance avec les options du select de l'app
  const vrDesig = vrM ? vrM[2].replace(/\s*(UN|ML|M2|PCS)\s+.*$/i, '').trim() : '';
  const vrCode  = vrM ? vrM[1] : '';
  const vrText  = (vrCode + ' ' + vrDesig).toLowerCase();
  const STRUCT_MAP = [
    { k: ['silver roll','vrsil'],           v: 'Volet hors-sol Silver Roll' },
    { k: ['golden roll','solaire','vrsol'],  v: 'Volet hors-sol solaire Golden Roll' },
    { k: ['coffre','vrcof'],                v: 'Volet hors-sol avec coffre' },
    { k: ['x-trem','xtrem','vrxtr','grand bassin'], v: 'Volet hors-sol grand bassin X-Trem Roll' },
    { k: ['mouv','mouv&roll','vrmouv'],     v: 'Volet déplaçable Mouv&Roll' },
    { k: ['subwater total','vrsubt'],       v: 'Volet immergé Subwater Total' },
    { k: ['subwater','vrsub'],              v: 'Volet immergé Subwater' },
  ];
  const structure = STRUCT_MAP.find(m => m.k.some(k => vrText.includes(k)))?.v
                 || vrDesig
                 || (/tablier\s+seul/i.test(text) ? 'Tablier seul' : '');
  // Le marqueur de quantité n'est plus dans lamM[2] (exclu par la regex ci-dessus) — reste juste
  // à recoller les lignes wrappées en un seul texte (même nettoyage que le design des accessoires).
  // Dérive {type, couleur, couleurBouchon} pour UNE ligne LAM — factorisé pour être appliqué à
  // chaque ligne trouvée (lamAllM), pas seulement la 1ère. Logique inchangée par rapport à avant
  // ce fix (jointure des lignes wrappées, extraction bouchon, normalisation "Noir fumé fond noir",
  // repli bouchon=lame pour le PVC), juste appliquée en boucle au lieu d'une seule fois.
  function deriveLameInfo(m) {
    const codeType = /POL/i.test(m[1]) ? 'Polycarbonate' : 'PVC';
    const lameRaw = m[2].replace(/\s*\n\s*/g, ' ').trim();
    const lameParenIdx = lameRaw.lastIndexOf(')');
    let c = lameParenIdx >= 0 ? lameRaw.slice(lameParenIdx + 1).trim() : lameRaw;
    // "DECROCHE" est un vrai terme catalogue Mégao (bassin avec décroché, d'où une 2e ligne de
    // lame pour ce segment) — pas une couleur. Confirmé par l'utilisateur (2026-07-28). Avant ce
    // fix, restait collé devant la couleur (ex. "- DECROCHE Blanc"). Signalé via `decroche: true`
    // plutôt que simplement jeté, pour ne pas perdre l'info métier.
    const decM = c.match(/^-?\s*DECROCHE\b\s*/i);
    const decroche = !!decM;
    if (decM) c = c.slice(decM[0].length).trim();
    // "LAMES SEUL(ES) POUR (RECOUVRIR) L'ESCALIER" : autre marqueur catalogue Mégao (lames plus
    // petites, batch séparé pour recouvrir l'escalier) — même famille que DECROCHE, pas une couleur.
    // Confirmé par l'utilisateur (2026-07-28), vu sous 2 formulations réelles (dossiers 120758,
    // 120470). Signalé via `lameEscalier: true` plutôt que jeté, même logique que `decroche`.
    const escM = c.match(/^-?\s*LAMES?\s+SEULE?S?\s+POUR\s+(?:RECOUVRIR\s+)?L['’]ESCALIER\.?\s*/i);
    const lameEscalier = !!escM;
    if (escM) c = c.slice(escM[0].length).trim();
    // Couleur du bouchon (embout de lame) : motif "B. <couleur>" dans le texte Mégao (ex: "B. Noir"
    // = Bouchon noir), distinct de la couleur de la lame elle-même — confirmé par l'utilisateur
    // (2026-07-22), corrige une hypothèse erronée précédente qui lisait "B." comme "Bicolore".
    const bM = c.match(/\bB\.\s*([A-Za-zÀ-ÿ]+)\b\s*/i);
    let cb = bM ? (BOUCHON_LABELS[bM[1].toUpperCase()] || (bM[1].charAt(0).toUpperCase() + bM[1].slice(1).toLowerCase())) : '';
    if (bM) c = (c.slice(0, bM.index) + c.slice(bM.index + bM[0].length)).trim();
    // "Noir fumé fond noir" est le nom CATALOGUE Mégao du polycarbonate noir opaque (vérifié sur
    // plusieurs vrais BO, ex. dossiers 118437/119577/119782/119980) — pas une couleur distincte du
    // "Noir" tout court choisi par le client. Simplifié en "Noir" (confirmé par l'utilisateur,
    // 2026-07-28) : sinon la couleur affichée est inutilement verbeuse ET coloreurLameVersFinition
    // (stock.js) ne matche jamais exactement "Noir", donc le décompte stock échouait en silence.
    // Leading "Noir" rendu optionnel : quand un marqueur bouchon "B. Noir" précède immédiatement
    // ce même mot (ex. dossier 114893, "B.  Noir\nfumé fond noir"), l'extraction bouchon ci-dessus
    // l'a déjà consommé pour couleurBouchon, ne laissant que "fumé fond noir" — sans ce repli la
    // normalisation ne se déclenchait plus et la couleur lame restait tronquée/fausse.
    if (/(?:noir\s*)?fum[ée]\s*fond\s*noir/i.test(c)) c = 'Noir';
    // PVC : le bouchon est TOUJOURS de la même couleur que la lame (confirmé par l'utilisateur
    // 2026-07-27) — jamais de ligne "B.<couleur>" séparée dans le PDF pour du PVC en pratique, donc
    // couleurBouchon reste vide sans ce repli. Le Polycarbonate peut différer (ligne dédiée gérée
    // ci-dessus quand présente) — pas de valeur par défaut à inventer pour le Poly.
    if (!cb && codeType === 'PVC' && c) cb = c;
    return { type: codeType, couleur: c, couleurBouchon: cb, decroche, lameEscalier };
  }
  const lameInfoAll = lamAllM.map(deriveLameInfo);
  // Ligne canonique = la 1ère ligne qui n'est ni décroché ni escalier s'il y en a une, sinon la
  // 1ère ligne tout court — un segment "spécial" (décroché ou lames d'escalier séparées) ne doit
  // jamais représenter la commande (type/couleur/bouchon), même quand il apparaît en premier dans
  // le texte (cf. commentaire lamAllM plus haut, dossiers 120770/120758 réels).
  const lameInfoFirst = lameInfoAll.find(li => !li.decroche && !li.lameEscalier) || lameInfoAll[0]
                      || { type: '', couleur: '', couleurBouchon: '', decroche: false, lameEscalier: false };
  const typeLame = lameInfoFirst.type;
  let lames = lameInfoFirst.couleur;
  let couleurBouchon = lameInfoFirst.couleurBouchon;
  // Bassin avec décroché / lames d'escalier séparées (voir deriveLameInfo) : vrai peu importe la
  // ligne où le marqueur apparaît.
  const decroche = lameInfoAll.some(li => li.decroche);
  const lameEscalier = lameInfoAll.some(li => li.lameEscalier);
  // Lignes de lames SUPPLÉMENTAIRES (au-delà de la 1ère) — avant ce fix, silencieusement perdues.
  // undefined pour les dossiers à une seule ligne (91% du parc réel mesuré), donc aucun impact sur
  // le comportement existant (lames/typeLame/couleurBouchon = toujours la 1ère ligne, comme avant).
  const lamesDetail = lameInfoAll.length > 1 ? lameInfoAll.map(li => ({ type: li.type, couleur: li.couleur })) : undefined;

  // Moteur : suffixe du code VR après le préfixe de structure (VRSIL80S → 80S)
  const moteurM = vrCode.match(/^VR(?:SUBT|SUB|MOUV|XTR|COF|SOL|SIL)([A-Z0-9]+)$/i);
  const moteur  = moteurM ? moteurM[1] : '';

  // Alim + couleur pieds : extraits du bloc de la ligne VR (400 premiers caractères)
  const vrIdx   = vrM ? text.indexOf(vrM[0]) : -1;
  const vrBlock = vrIdx >= 0 ? text.slice(vrIdx, vrIdx + 400) : text;
  const alimM   = vrBlock.match(/\b(\d{2,3})\s*V\b/i);
  const alim    = alimM ? alimM[1] + 'V' : '';
  // Couleur pieds : code RAL 4 chiffres ou nom de couleur après "clé impultionnelle" (moteur
  // électronique) OU "clé maintenue" (moteur mécanique) — les deux mécanismes existent selon le
  // moteur choisi ("réglage de fin de course électronique/mécanique"). Le motif "maintenue"
  // manquait entièrement (regex initiale ne testait qu'"impult\w*") : vérifié sur un échantillon
  // réel de 30 dossiers volets au champ pieds vide, 20/30 avaient "clé maintenue <couleur>" dans
  // le PDF, jamais capté — cause principale du champ vide sur ~90% des dossiers volets réels.
  const COULEURS = 'blanc|noir|gris|anthracite|beige|marron|brun|ivoire|argent|bronze|bleu|vert|rouge';
  const piedM   = vrBlock.match(new RegExp(`(?:impult\\w*|maintenue)\\s+(\\d{4}|${COULEURS})\\b`, 'i'))
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
  // PAS de \b avant ML (corrigé 2026-07-23) : la couleur de lame est collée directement devant
  // "ML" par pdf-parse (ex. "...(le ml) BlancML  11,00..."), donc aucune frontière de mot entre
  // "Blanc" et "ML" — \bML ne matchait jamais dans ce cas, laissant longueur vide alors que
  // largeur (extrait séparément depuis le CODE, pas ce texte) restait correct. Vérifié sur 2
  // vrais PDF téléchargés (dossiers 119164/119260/119516, "BlancML"/"AnthraciteML") — touchait
  // 30/83 dossiers volets réels (36%, largeur présente mais longueur vide).
  const lamLines = [...text.matchAll(/^LAM[A-Z0-9]+[\s\S]*?ML\s+([\d,]+)/gm)];
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
  // Références : champ Mégao souvent utilisé pour noter le VRAI client final quand un revendeur
  // enlève pour son compte (le PDF porte alors une ligne "PREVENIR <revendeur>" à côté) — collé
  // sans espace à la valeur suivante ("Références :MICHELDélai :", vu sur données réelles), d'où
  // l'arrêt avant "Délai" plutôt qu'un simple \n.
  const referencesM = text.match(/R[ée]f[ée]rences\s*:\s*([^\n]*?)(?=D[ée]lai\s*:|\n|$)/i);
  const references  = referencesM ? referencesM[1].trim() : '';

  // Client : bloc juste après COMMANDE N° (pdf-parse sort les lignes en colonnes)
  let client = '', contact = '', adresse = '', cp = '', ville = '';
  if (refM) {
    const afterRef = text.slice(refM.index + refM[0].length);
    for (const l of afterRef.split('\n').map(s => s.trim()).filter(Boolean)) {
      if (/^(page\s*:|code\s*client|repr[eé]sentant|r[eé]f[eé]rences|d[eé]lai|t[eé]l|e-?mail|contact\b|d[eé]signation|bulles)/i.test(l)) break;
      // Nom de pays isolé sur sa propre ligne (adresse revendeur à l'étranger, ex. Abrisud Iberica
      // en Espagne — vu sur données réelles, "ESPAGNE" se retrouvait sinon capturé comme client) :
      // ignoré comme "France" plutôt que pris comme nom, pour laisser la ligne suivante (souvent
      // "ENLEVEMENT" ou le vrai nom) être évaluée normalement par la suite de la boucle.
      if (/^(france|espagne)$/i.test(l)) continue;
      const cpVm = l.match(/^(\d{5})\s+([A-ZÀ-Ÿ][^\n]+)/);
      if (cpVm) { cp = cpVm[1]; ville = cpVm[2].trim(); continue; }
      if (!client)  { client = l; contact = l; continue; }
      if (!adresse) { adresse = l; continue; }
    }
  }
  // Cas "enlèvement" (bloc client remplacé par une instruction de retrait plutôt qu'un nom,
  // confirmé sur données réelles Mégao — CMDCLI.Nomliv contient littéralement "ENLEVEMENT",
  // "ENLEVEMENT CLIENT/USINE" ou "ENLEVEMENT LE <date>" dans ce cas) : Références d'abord (le vrai
  // client final quand un revendeur enlève pour son compte, cf. commentaire ci-dessus — décision
  // utilisateur du 2026-07-27 malgré un contre-exemple identifié où Références contient une valeur
  // sans rapport, ex. dossier réel 121027 "PARISOTO" vs revendeur "ADRIEN CLEMENTE" correct — jugé
  // acceptable), sinon repli sur le revendeur comme avant plutôt que de garder un nom faux.
  if (/^enl[eè]vement\b/i.test(client) && (references || revendeur)) {
    client = references || revendeur;
    contact = client;
  }

  // HT : "Net HT\n 1 823,84" (valeur sur la ligne suivante dans pdf-parse)
  const htM = text.match(/Net\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i)
           || text.match(/Total\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i);
  const ht  = htM ? parseFloat(htM[1].replace(/\s/g, '').replace(',', '.')) : 0;

  const champsAccessoiresVolet = deriveChampsAccessoiresVoletDepuisPdf(text, structure, largeur);

  return {
    ref, refCommande: ref, client, contact, tel, email, adresse, cp, ville,
    structure, lames, couleurBouchon, pieds, alim, moteur, typeLame, escalier, decoupe,
    lamesDetail, decroche, lameEscalier,
    options: '', remarques: '', autres: '', // options réellement alimenté via le spread ci-dessous
    largeur, longueur, revendeur,
    transport, ht, dateFrom, isVolet,
    ...champsAccessoiresVolet,
  };
}

// Accessoires volet lus DIRECTEMENT dans le texte PDF (pas via l'enrichissement VM séparé,
// megao-enrich-sync.js/megao_enrich_vm.py, qui s'est avéré manquer des lignes réelles — ex.
// commande 120779 réelle : CAIBO905 absent de megaoAccessoiresDetail alors que la ligne existe
// bel et bien dans le PDF). Régler la fiabilité à la source plutôt que côté enrichissement.
// Même principe que BACHE_LIGNE_RE (code MAJUSCULES collé à une désignation Titlecase par
// pdf-parse), élargi à "ML" en plus de "UN"/"M2" comme marqueur de fin (les lignes LAM/CAIBO
// utilisent ML) et au charset "<>" (codes découpe VRDEC<20E).
const VOLET_ACCESSOIRE_LIGNE_RE = /^([A-Z][A-Z0-9<>]{1,15})([A-ZÀ-Þ][a-zà-ÿ][\s\S]*?)(?:M2|UN|ML)(?:\s+([\d,]+))?/gm;
const COULEUR_STRUCTURE_VOLET_RE = /\b(Blanc|Gris|Sable)\b/i;
// Hauteur du mur immergé : code MU1<suffixe> → hauteur (vérifié sur CMDCLIB réel, voir
// deriveChampsAccessoiresVolet dans megao-enrich-sync.js pour la même table/le même détail).
const MUR_HAUTEUR_PAR_CODE_VOLET = {
  MU14: '1m', MU15: '1m', MU16: '1m',
  MU1254: '1,25m', MU1255: '1,25m', MU1256: '1,25m',
  MU1504: '1,5m', MU1505: '1,5m', MU1506: '1,5m',
};
// Profondeur du caillebotis (cm) : code CAIBO/CAIPVC + 7 = 70cm, + 9 = 90cm (2e/3e chiffre du
// code, vérifié sur CMDCLIB réel — CAIBO704/CAIPVC704="70 cm", CAIBO904/CAIPVC904="90 cm").
// Largeur caillebotis ESTIMÉE depuis la largeur du bassin (code LAM, toujours fiable) : le code
// caillebotis lui-même n'encode qu'une fourchette (ex. "4 à 5m"), pas une valeur exacte — vérifié
// sur 19 commandes réelles, la fourchette correspond à la largeur bassin dans 18/19 cas (1
// exception trouvée, bassin de forme non standard probable). Risque connu et accepté par
// l'utilisateur (2026-07-24) : la fiche de fabrication / fiche de côte donnera de toute façon la
// vraie valeur avant fabrication, cette estimation est juste un point de départ — marquée
// `caillebotisLargeurEstimee` pour rester repérable tant qu'elle n'a pas été confirmée/corrigée
// à la main (`setDosField` efface le flag dès qu'un humain édite le champ, cf. index.html).
function deriveChampsAccessoiresVoletDepuisPdf(text, structure, largeurBassin) {
  const lignes = [...text.matchAll(VOLET_ACCESSOIRE_LIGNE_RE)].map(m => ({
    code: m[1],
    design: m[2].replace(/\s*\n\s*/g, ' ').trim(),
    qte: m[3] ? parseFloat(m[3].replace(',', '.')) : null,
  }));
  const update = {};

  // ⚠ Le code est TRONQUÉ à "ACVRTELEC" par le rendu PDF Mégao pour les 2 variantes (vérifié sur
  // 3 vrais PDF : "ACVRTELECTélécommande pour volet" ET "ACVRTELECTélécommande pour volet
  // bluetooth" partagent EXACTEMENT le même code tronqué — contrairement au Codeart complet côté
  // base Mégao, ACVRTELECOM/ACVRTELECOMBL, utilisable lui sans troncature côté enrichissement VM).
  // Distinction uniquement possible via le mot "bluetooth" dans la désignation ici.
  const telecommandeLigne = lignes.find(l => l.code.startsWith('ACVRTELEC'));
  if (telecommandeLigne) update.telecommande = /bluetooth/i.test(telecommandeLigne.design) ? 'Bluetooth' : 'Classique';

  // OXEO recherché aussi dans la désignation (pas seulement le code) par prudence : la
  // troncature PDF de télécommande ci-dessus a montré que le code peut être raccourci d'une
  // façon qui masque la vraie variante — la désignation reste le signal fiable dans ce cas.
  const gestionSelLigne = lignes.find(l => l.code.startsWith('ACCOFAS') || l.code.startsWith('ACVRCOFAS'));
  if (gestionSelLigne) update.gestionSel = /OXEO/i.test(gestionSelLigne.design) ? 'Oxeo' : 'Electrolyseur';

  // ⚠ Préfixes raccourcis (ACVRPASSA pas ACVRPASSANG, ACVREQUFL pas ACVREQUFLASQ, ACVREQUTE pas
  // ACVREQUTELESC) — trouvés en comparant les 78 vrais PDF stockés à la classification d'origine
  // (basée sur le Codeart complet CMDCLIB) : le rendu PDF Mégao utilise des codes plus courts que
  // ceux vus côté base historique pour plusieurs accessoires, pas seulement télécommande.
  const passesSanglesQte = lignes.filter(l => l.code.startsWith('ACVRPASSA')).reduce((s, l) => s + (l.qte || 0), 0);
  if (passesSanglesQte > 0) update.passesSangles = String(passesSanglesQte);

  if (lignes.some(l => l.code.startsWith('ACVREQUFL'))) update.flasqueMurale = 'Oui';
  if (lignes.some(l => l.code.startsWith('ACVRCORN'))) update.corniere6060 = 'Oui';

  const equerresQte = lignes.filter(l => l.code.startsWith('ACVREQUTE') || l.code.startsWith('ACVREQUROU')).reduce((s, l) => s + (l.qte || 0), 0);
  if (equerresQte >= 1 && equerresQte <= 3) update.equerresRenfort = String(equerresQte);

  // Alimentation (d.typeAlimentation, lu par stockDecompterAlimentation) — jamais dérivé avant
  // ce jour : ACVRALIBAT ("kit chargeur + batteries...") vu sur 21/78 dossiers réels (27%, de
  // loin le code le plus fréquent), distingue 6ah/3ah dans la désignation → 'Batterie 6ah' sinon
  // 'Batterie' ; ACVRPLUG ("Easy Plug") → 'EasyPlug'. Electrique/Solaire/Solaire + Chargeur pas
  // couverts : aucun code dédié rencontré dans l'échantillon réel disponible.
  const alimBatLigne = lignes.find(l => l.code.startsWith('ACVRALIBAT'));
  if (alimBatLigne) update.typeAlimentation = /6\s*ah/i.test(alimBatLigne.design) ? 'Batterie 6ah' : 'Batterie';
  else if (lignes.some(l => l.code.startsWith('ACVRPLUG'))) update.typeAlimentation = 'EasyPlug';

  const murLigne = lignes.find(l => MUR_HAUTEUR_PAR_CODE_VOLET[l.code]);
  if (murLigne) {
    update.murHauteur = MUR_HAUTEUR_PAR_CODE_VOLET[murLigne.code];
    const coul = murLigne.design.match(COULEUR_STRUCTURE_VOLET_RE);
    if (coul) update.murCouleur = coul[1].charAt(0).toUpperCase() + coul[1].slice(1).toLowerCase();
  }

  // Poutre : le code catalogue Codeart ACVRPOUTR (immergé simple, couleur) et ACVRPOUTRIN
  // (immergé total, quantité 0-2) tronquent TOUS LES DEUX vers "ACVRPOUT" dans le PDF rendu
  // (vérifié sur la commande 120779 réelle : "ACVRPOUTPoutre aluminium...") — impossible de les
  // distinguer par le code seul comme pour télécommande ci-dessus. On route donc sur le type de
  // structure déjà extrait (fiable), pas sur le suffixe du code.
  const poutreLigne = lignes.find(l => l.code.startsWith('ACVRPOUT'));
  const isImmergeTotal = /immerg[ée].*total|subwater\s*total/i.test(structure);
  if (poutreLigne && isImmergeTotal) {
    const qte = lignes.filter(l => l.code.startsWith('ACVRPOUT')).reduce((s, l) => s + (l.qte || 0), 0);
    if (qte <= 2) update.nombrePoutres = String(qte);
  } else if (poutreLigne) {
    const coul = poutreLigne.design.match(COULEUR_STRUCTURE_VOLET_RE);
    if (coul) update.poutreCouleur = coul[1].charAt(0).toUpperCase() + coul[1].slice(1).toLowerCase();
  }

  // Caillebotis : choix (couleur peinte ou essence de bois) + profondeur exacte depuis le code.
  // Largeur volontairement PAS renseignée (voir commentaire au-dessus de la fonction).
  const caillebotisLigne = lignes.find(l => /^(CAIBO|CAIPVC)/.test(l.code));
  if (caillebotisLigne) {
    const profM = caillebotisLigne.code.match(/^CAI(?:BO|PVC)([79])/);
    if (profM) update.caillebotisProfondeur = profM[1] === '7' ? '70' : '90';
    const coul = caillebotisLigne.design.match(COULEUR_STRUCTURE_VOLET_RE);
    if (coul) update.caillebotisChoix = coul[1].charAt(0).toUpperCase() + coul[1].slice(1).toLowerCase();
    else if (/ROBINIER/i.test(caillebotisLigne.design)) update.caillebotisChoix = 'Robinier';
    else if (/\bIPE\b/i.test(caillebotisLigne.design)) update.caillebotisChoix = 'IPE';

    const largeurBassinCm = Math.round(parseFloat(largeurBassin) * 100);
    if (largeurBassinCm > 0) {
      update.caillebotisLargeur = String(largeurBassinCm);
      update.caillebotisLargeurEstimee = true;
    }
  }

  // Filet de sécurité (2026-07-24) : jusqu'ici tout code non explicitement traité ci-dessus était
  // silencieusement perdu (parseMegaoText renvoyait options/remarques/autres vides EN DUR, sans
  // aucun repli — contrairement au parseur bâches, qui garde toujours tout code non catégorisé en
  // texte libre dans "options"). Trouvé en auditant les 67 vrais PDF volets déjà stockés : des
  // accessoires réels jamais capturés (ACVREQUP, ACVRALISO, ACVRCHAR, ACVRPLATP, ACVRCOHS2...).
  // Même principe que BACHE_LIGNE_RE/autresLignes : tout ce qui n'est ni la structure/l'escalier/
  // la découpe (VR*), la lame (LAM*), le transport/enlèvement (TRSP*/ENLEV*), l'emballage (EMB*,
  // jamais une info produit), le geste commercial (GESTECO*, financier) ni un accessoire déjà
  // reconnu ci-dessus va dans `options` — jamais perdu, juste pas structuré.
  const VOLET_DEJA_TRAITE_PREFIX = [
    'VR', 'LAM', 'TRSP', 'ENLEV', 'EMB', 'GESTECO',
    'ACVRTELEC', 'ACCOFAS', 'ACVRCOFAS', 'ACVRPASSA', 'ACVREQUFL', 'ACVRCORN',
    'ACVREQUTE', 'ACVREQUROU', 'ACVRALIBAT', 'ACVRPLUG', 'ACVRPOUT', 'CAIBO', 'CAIPVC',
    'ACVRPIEDANT', 'ACVRMOUVANT', // couleur pieds — traité dans parseMegaoText, pas ici
  ];
  const VOLET_DEJA_TRAITE_EXACT = new Set(Object.keys(MUR_HAUTEUR_PAR_CODE_VOLET));
  const autresLignes = lignes.filter(l =>
    !VOLET_DEJA_TRAITE_PREFIX.some(p => l.code.startsWith(p)) &&
    !VOLET_DEJA_TRAITE_EXACT.has(l.code)
  );
  if (autresLignes.length) update.options = autresLignes.map(l => l.design).join(', ');

  return update;
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
// Groupe 3 : quantité juste après l'unité (UN|M2), même convention que le volet
// (cf. lamQtyM plus haut : "ML\s+([\d,]+)") — pas vérifié sur un vrai PDF bâches
// pour cette ligne précise, à confirmer si un dossier réel remonte un écart.
// Groupe 3 (quantité) rendu OPTIONNEL exprès : s'il ne matche pas sur un vrai PDF (format
// différent de ce qu'on suppose), la ligne reste quand même détectée comme avant — seul le
// décompte stock (qui a besoin de la quantité) sera dégradé, pas la détection de structure/
// options qui existait déjà et fonctionne en prod.
const BACHE_LIGNE_RE = /^([A-Z][A-Z0-9\/\+]{1,15})([A-ZÀ-Þ][a-zà-ÿ][\s\S]*?)(?:M2|UN)(?:\s+([\d,]+))?/gm;

// Gamme "Cover"/"Poly Cover" (bâches hiver rigides, marques Cover et Ecolight - Poly Cover) —
// jamais reconnue avant le 2026-07-23 : COV[1-4]/COVONE/COVPREST/COVPVCAUTRE + variantes à
// forme catalogue (COV1HJ<ville>/COV1GAPP<code>), CIKP*/CIKB* (montage spécifique marque Gré,
// ex. "Cover 1 - Gré"), POLYHJ<ville> (Ecolight - Poly Cover) + code générique ECOLIGHT — vu
// sur 5337 commandes réelles distinctes dans CMDCLIB, jamais matché par cette regex ni par
// mainLigne plus bas → email silencieusement ignoré ("Ni volet ni bâche reconnue") si aucun
// code BA/BU compagnon n'était présent sur la même commande. DFCI* (bâche réserve incendie)
// confirmé être un produit SANS RAPPORT (1 seule commande dans tout l'historique) — pas inclus.
const BACHE_COVER_RE = /^(COV|CIK|POLYHJ)/;
// Gamme "GR VOL" (grille de sécurité rigide, distincte d'une bâche — même famille Mégao "HI")
// — même bug, ajouté le 2026-07-23 après Cover/Poly Cover : GRVOL (bare) + variantes à forme
// catalogue GRVOLUW<lettre grecque>/GRVOLVI<ville> + GRVOLPROMOAZ (offre commerciale). 462
// commandes CMDCLIB distinctes, produit actif (commandes récentes) — même correction que Cover.
const BACHE_GRVOL_RE = /^GRVOL/;
// Gamme "Sécuritis" (bâche hiver "classique", la 3e famille Mégao officielle déjà anticipée en
// commentaire plus bas mais jamais câblée) — même bug, découvert le 2026-07-23 en balayant TOUS
// les codes de commandes orphelines (ni volet ni bâche reconnue) : bare SE/SEEC (Eco)/SEHS (Hors
// Sol)/SEEVOL (évolution)/SE1GOABA/SEGOABA (Gold) + variantes à forme catalogue SESHHJ<ville>/
// SEECHJ<ville>/SEECUW<lettre grecque>/SEGP<ville>. 71 codes distincts vérifiés un par un dans
// CMDCLIB — TOUS Sécuritis, aucun bruit. Volume largement supérieur à Cover (SE seul : 1479
// lignes). L'ancien isBache() ne testait QUE 'SEES'/'SEECH' (accessoires escalier, pas le
// produit) — et 'SEECH' s'avère être une coquille : n'existe dans AUCUNE commande réelle, le
// vrai code hors-standard est 'SEESHS' (110 lignes, jamais reconnu non plus, ni ici ni dans
// hasEscalierHorsStandard plus bas). mainLigne ne testait que le code bare 'SE' exact.
// (?!ES|DECASPI) exclut les codes accessoires SEES/SEESHS/SEDECASPI (jamais le produit).
const BACHE_SECURITIS_RE = /^SE(?!ES|DECASPI)/;
function isBache(text) {
  return /^(BA[A-Z]|BU[A-Z0-9]|SE|TRSPBA|TRSPBU|TRSPHI|ENLEVBA|COV|CIK|POLYHJ|ECOLIGHT|GRVOL)/m.test(text);
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
  // Références : voir commentaire identique dans parseMegaoText — champ Mégao souvent utilisé
  // pour noter le VRAI client final quand un revendeur enlève pour son compte.
  const referencesM = text.match(/R[ée]f[ée]rences\s*:\s*([^\n]*?)(?=D[ée]lai\s*:|\n|$)/i);
  const references  = referencesM ? referencesM[1].trim() : '';

  let client = '', contact = '', adresse = '', cp = '', ville = '';
  if (refM) {
    const afterRef = text.slice(refM.index + refM[0].length);
    for (const l of afterRef.split('\n').map(s => s.trim()).filter(Boolean)) {
      if (/^(page\s*:|code\s*client|repr[eé]sentant|r[eé]f[eé]rences|d[eé]lai|t[eé]l|e-?mail|contact\b|d[eé]signation|bulles)/i.test(l)) break;
      // Nom de pays isolé sur sa propre ligne (adresse revendeur à l'étranger, ex. Abrisud Iberica
      // en Espagne — vu sur données réelles, "ESPAGNE" se retrouvait sinon capturé comme client) :
      // ignoré comme "France" plutôt que pris comme nom, pour laisser la ligne suivante (souvent
      // "ENLEVEMENT" ou le vrai nom) être évaluée normalement par la suite de la boucle.
      if (/^(france|espagne)$/i.test(l)) continue;
      const cpVm = l.match(/^(\d{5})\s+([A-ZÀ-Ÿ][^\n]+)/);
      if (cpVm) { cp = cpVm[1]; ville = cpVm[2].trim(); continue; }
      if (!client)  { client = l; contact = l; continue; }
      if (!adresse) { adresse = l; continue; }
    }
  }
  // Cas "enlèvement" (vu sur commande 120791 réelle, et sur les variantes réelles "ENLEVEMENT
  // CLIENT"/"ENLEVEMENT USINE" — d'où \b plutôt que $ ci-dessous, l'ancre stricte ratait ces deux
  // variantes) : le bloc client n'est pas un nom mais une instruction. Références d'abord (le
  // vrai client final, cf. commentaire ci-dessus), sinon repli sur le revendeur comme avant.
  if (/^enl[eè]vement\b/i.test(client) && (references || revendeur)) {
    client = references || revendeur;
    contact = client;
  }

  const htM = text.match(/Net\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i)
           || text.match(/Total\s+HT\s*\n\s*([\d][\d\s]*,\d{2})/i);
  const ht  = htM ? parseFloat(htM[1].replace(/\s/g, '').replace(',', '.')) : 0;

  // Lignes produit : {code, design, qte} pour chaque ligne détectée
  const lignes = [...text.matchAll(BACHE_LIGNE_RE)].map(m => ({
    code: m[1],
    design: m[2].replace(/\s*\n\s*/g, ' ').trim(),
    qte: m[3] ? parseFloat(m[3].replace(',', '.')) : null,
  }));

  // Ligne "principale" = le produit bâche lui-même, pas un accessoire/transport.
  // SEES (escalier standard Sécuritis) exclu explicitement : commence comme SE/SEEC mais
  // c'est un accessoire, pas le produit (vu sur la commande 120892 réelle, les deux
  // apparaissent dans le même bon de commande). COV/CIK/POLYHJ/ECOLIGHT (gamme Cover/Poly
  // Cover, cf. BACHE_COVER_RE ci-dessus) ajoutés le 2026-07-23 — avant ça un Cover/Poly Cover
  // vu sur une commande avec un code compagnon (ex. SEES) créait bien un dossier mais sa ligne
  // produit retombait en texte libre dans "options" (structure/bacheGamme restaient vides,
  // cf. dossier réel 120935 "Forestiers-Sapeurs de l'Ardèche"). GRVOL (gamme GR VOL, cf.
  // BACHE_GRVOL_RE) ajouté juste après, même bug/même méthode. BACHE_SECURITIS_RE (gamme
  // Sécuritis) remplace l'ancien test exact `l.code === 'SE' || /^SEEC/.test(l.code)`, trop
  // étroit (ratait SEHS/SESHHJ*/SEECHJ*/SEECUW*/SEGP*/SEEVOL/SE1GOABA/SEGOABA).
  const mainLigne = lignes.find(l => /^(BA|BU)/.test(l.code) || BACHE_SECURITIS_RE.test(l.code) || BACHE_COVER_RE.test(l.code) || l.code === 'ECOLIGHT' || BACHE_GRVOL_RE.test(l.code)) || null;
  const structure = mainLigne ? mainLigne.design : '';
  const bacheModele = mainLigne ? mainLigne.code : '';
  // Gamme déduite en priorité du catalogue officiel Mégao (ARTICLE.mkd, code→famille
  // BA/BU/HI — voir megao-bache-familles.json et la mémoire projet pour la méthode de
  // décodage), repli sur une heuristique de préfixe si le code n'y figure pas (ex. variante
  // pas encore au catalogue, commande multi-produits). "HIVER" (bâche dite "Sécuritis") est
  // une 3e famille Mégao officielle, confirmée via FAMART.mkd — l'app ne modélise aujourd'hui
  // que Barres/Bulles/Cover/Poly Cover pour bacheGamme, donc "Hiver" (Sécuritis) générique y
  // est stocké tel quel (donnée honnête, n'importe quelle valeur hors Barres/Bulles affiche
  // déjà les deux jeux de champs sans erreur côté fiche — décision produit actée avec
  // l'utilisateur de ne pas retoucher la modale pour l'instant). Cover/Poly Cover distingués
  // AVANT le lookup catalogue : megao-bache-familles.json (snapshot ARTICLE.mkd du 2026-07-15)
  // ne connaît que COVONE/COVPREST/COVPVCAUTRE, pas les codes COV1/COV1HJ*/COV1GAPP* vus dans
  // l'audit CMDCLIB réel (catalogue Mégao mis à jour depuis) — préfixe direct plus fiable ici.
  const FAMILLE_GAMME = { BA: 'Barres', BU: 'Bulles', HI: 'Hiver' };
  // POLYHJ*/ECOLIGHT = marque Ecolight ("Poly Cover"), distingué de COV*/CIK* ("Cover") bien
  // que les deux matchent BACHE_COVER_RE (qui sert aussi de détecteur générique dans
  // isBache/mainLigne) — testé en premier pour ne pas tomber dans la branche Cover. "Hiver"
  // générique (FAMILLE_GAMME.HI) reste le repli pour tout AUTRE code HI non couvert par une des
  // 4 sous-gammes désormais distinguées (Cover/Poly Cover/GR VOL/Sécuritis).
  const bacheGamme = mainLigne
    ? (/^POLYHJ/.test(mainLigne.code) || mainLigne.code === 'ECOLIGHT' ? 'Poly Cover'
       : BACHE_COVER_RE.test(mainLigne.code) ? 'Cover'
       : BACHE_GRVOL_RE.test(mainLigne.code) ? 'GR VOL'
       : BACHE_SECURITIS_RE.test(mainLigne.code) ? 'Sécuritis'
       : FAMILLE_GAMME[MEGAO_BACHE_FAMILLES[mainLigne.code]]
       || (/^BA/.test(mainLigne.code) ? 'Barres' : /^BU/.test(mainLigne.code) ? 'Bulles' : ''))
    : '';

  // Escalier standard : ACESBAR (Barres/Bulles) + HIES (Hiver, même famille jamais captée
  // avant — trouvée dans l'audit CMDCLIB réel) + ECOLES (Poly Cover) + SEES (Sécuritis).
  // HIESHS/ECOLESHS/SEESHS (hors-standard) prioritaires si présents — SEESHS (110 lignes
  // réelles) ajouté le 2026-07-23 : l'ancien isBache() référençait un code "SEECH" qui
  // n'existe dans AUCUNE commande réelle (coquille jamais détectée faute de test), le vrai
  // code hors-standard Sécuritis est SEESHS et n'était câblé nulle part avant aujourd'hui.
  const hasEscalierStandard    = lignes.some(l => l.code === 'ACESBAR' || l.code === 'SEES' || l.code === 'HIES' || l.code === 'ECOLES');
  const hasEscalierHorsStandard = lignes.some(l => l.code === 'HIESHS' || l.code === 'ECOLESHS' || l.code === 'SEESHS');
  const bacheDecoupeEscalier = hasEscalierHorsStandard ? 'Hors-standard' : (hasEscalierStandard ? 'Standard' : '');
  const bacheBarreCharge     = lignes.some(l => l.code === 'ACBACHAR') ? 'Oui' : '';
  // Découpe aspiration/échelle : champ existant côté UI (f-bacheDecoupeAspi), jamais alimenté
  // par ce parseur jusqu'ici — ACDECASPI (Barres/Bulles) / HIDECASPI (Hiver) / ECOLDECASPI
  // (Poly Cover) / SEDECASPI (Sécuritis).
  const bacheDecoupeAspi = lignes.some(l => l.code === 'ACDECASPI' || l.code === 'HIDECASPI' || l.code === 'ECOLDECASPI' || l.code === 'SEDECASPI') ? 'Oui' : '';
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
  // Détail par ligne (code+qté), nécessaire au décompte stock auto (stock.js::
  // stockDecompterAccessoiresBache) — bacheAccessoires seul (juste les catégories) ne suffit
  // pas à savoir QUELLE réf précise décrémenter ni de COMBIEN.
  const bacheAccessoiresDetail = lignes
    .filter(l => classifyBacheAccessoire(l.code))
    .map(l => ({ code: l.code, design: l.design, qte: l.qte, categorie: classifyBacheAccessoire(l.code) }));
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
    l.code !== 'ECOLES' && l.code !== 'ECOLESHS' && l.code !== 'SEESHS' &&
    l.code !== 'ACBACHAR' &&
    l.code !== 'ACDECASPI' && l.code !== 'HIDECASPI' && l.code !== 'ECOLDECASPI' && l.code !== 'SEDECASPI' &&
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
    bacheEnrouleur, bacheTransportZone, bacheAccessoires, bacheAccessoiresDetail, remarques,
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

// ─── Secteurs de pose (carte POSE'N CO, confirmée par l'utilisateur 2026-07-30) ──────────────
// Détermine qui pose un dossier livraison+pose selon le département du chantier :
//   JM → pose planifiée par JM (needPose=true) ; Azenco → sous-traitée, non planifiée (badge
//   poseSecteur='azenco') ; Akena → JM ne pose pas, la commande repasse en "Livraison seule".
// Un volet IMMERGÉ est toujours posé par JM, quel que soit le département.
// ⚠ Ces 2 listes DOIVENT rester identiques à celles de index.html (JM_POSE_DEPTS / AKENA_POSE_DEPTS)
// — dupliquées ici car ce script Node ne partage pas de module avec le front. Corriger aux 2 endroits.
const JM_POSE_DEPTS = new Set(['01','04','05','06','07','08','12','13','21','25','26','30','34','38','39','42','43','48','51','52','54','55','57','63','67','68','69','70','71','73','74','83','84','88','90']);
const AKENA_POSE_DEPTS = new Set(['02','59','60','62','76','80']);
function classePose(transport, cp, structure) {
  if (transport !== 'liv_pose') return { transport, needPose: false, poseSecteur: '' };
  if (/immerg/i.test(structure || '')) return { transport: 'liv_pose', needPose: true, poseSecteur: 'jm' };
  const dept = String(cp || '').replace(/\D/g, '').slice(0, 2);
  if (dept.length < 2) return { transport: 'liv_pose', needPose: true, poseSecteur: '' };
  if (JM_POSE_DEPTS.has(dept)) return { transport: 'liv_pose', needPose: true, poseSecteur: 'jm' };
  if (AKENA_POSE_DEPTS.has(dept)) return { transport: 'livraison', needPose: false, poseSecteur: '' };
  return { transport: 'liv_pose', needPose: false, poseSecteur: 'azenco' };
}

// ─── Créer ou mettre à jour le dossier ───────────────────────────────────────
async function upsertDossier(data, pdfBuffer = null, pdfFilename = '') {
  if (!data.ref) { console.warn('Ref absente — dossier ignoré'); return; }
  // Classement du secteur de pose (JM planifie / Azenco sous-traite / Akena → livraison seule).
  const pose = classePose(data.transport || 'liv_pose', data.cp, data.structure);

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
    // TOUS ces champs sont dérivés à 100% du texte du PDF de CETTE commande (chaque email traité
    // est un document complet, jamais un correctif partiel — l'email est supprimé une fois traité,
    // cf. imap.messageDelete plus bas, donc il n'y a pas de "nouvelle tentative sur les mêmes
    // données" à ménager). Donc TOUJOURS écrasés avec le résultat de ce parse, même redevenu
    // vide — pas de raison de garder une ancienne valeur si la commande a été révisée et ne la
    // contient plus. Mêmes valeurs de repli que la branche de création plus bas, pour que rééditer
    // un dossier existant se comporte comme en créer un nouveau à l'identique.
    // Bug réel trouvé sur le dossier 120470 (2026-07-28) : le PDF dit maintenant "escalier non
    // recouvert" et n'a plus qu'une ligne de lame, mais l'ancien code (qui n'écrasait un champ que
    // s'il avait une nouvelle valeur non vide) gardait l'ancienne ligne d'escalier obsolète pour
    // toujours dans `lamesDetail`.
    // N'est PAS concerné par cette règle (logique séparée, volontairement différente) : `ht` (ne se
    // met à jour que si jamais renseigné — protège un montant contre un recalcul silencieux) et
    // `caillebotisLargeurEstimee`/`statut`/`needPose`/etc. (enrichis par d'autres process que le
    // parse PDF, pas concernés par cette liste).
    const update = {
      client: data.client || '', tel: data.tel || '', email: data.email || '',
      contact: data.contact || '', adresse: data.adresse || '', cp: data.cp || '', ville: data.ville || '',
      structure: data.structure || '', lames: data.lames || '', couleurBouchon: data.couleurBouchon || '',
      typeLame: data.typeLame || '', lamesDetail: data.lamesDetail || null,
      decroche: !!data.decroche, lameEscalier: !!data.lameEscalier,
      pieds: data.pieds || '', alim: data.alim || '', moteur: data.moteur || '',
      escalier: data.escalier || '', decoupe: data.decoupe || '', options: data.options || '',
      remarques: data.remarques || '', autres: data.autres || '',
      transport: pose.transport, needPose: pose.needPose, poseSecteur: pose.poseSecteur,
      largeur: data.largeur || '', longueur: data.longueur || '',
      revendeur: data.revendeur || 'Client particulier', refCommande: data.ref,
      telecommande: data.telecommande || '', gestionSel: data.gestionSel || '',
      passesSangles: data.passesSangles || '', flasqueMurale: data.flasqueMurale || '',
      corniere6060: data.corniere6060 || '', equerresRenfort: data.equerresRenfort || '',
      murHauteur: data.murHauteur || '', murCouleur: data.murCouleur || '',
      poutreCouleur: data.poutreCouleur || '', nombrePoutres: data.nombrePoutres || '',
      caillebotisChoix: data.caillebotisChoix || '', caillebotisProfondeur: data.caillebotisProfondeur || '',
      caillebotisLargeur: data.caillebotisLargeur || '', typeAlimentation: data.typeAlimentation || '',
    };
    // Estimée uniquement quand la valeur qu'on vient d'écrire ci-dessus vient réellement de
    // l'estimation (pas d'un champ déjà rempli à la main resté inchangé par le for ci-dessus).
    if (data.caillebotisLargeur && data.caillebotisLargeurEstimee) update.caillebotisLargeurEstimee = true;
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
      lamesDetail: data.lamesDetail || null,
      decroche:    data.decroche   || false,
      lameEscalier: data.lameEscalier || false,
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
      // Volontairement vide à la création : "Date livraison prévue" est une date FUTURE décidée
      // par l'atelier/admin (délai de fabrication), jamais dérivable de la date de commande —
      // la remplir avec dateFrom faisait apparaître TOUT nouveau dossier comme "en retard" dès sa
      // création (bug confirmé par l'utilisateur, 2026-07-22 : d.dateLivraison < today déclenche
      // le badge retard, cf. index.html ligne ~2257). À définir manuellement (f-date-livraison).
      dateLivraison: '',
      transport:   pose.transport,
      poseSecteur: pose.poseSecteur,
      remarques:   data.remarques  || '',
      autres:      data.autres     || '',
      largeur:     data.largeur    || '',
      longueur:    data.longueur   || '',
      // Pas de revendeur détecté dans le bloc en-tête du PDF = vente en direct au client final,
      // pas une valeur manquante — confirmé par l'utilisateur (2026-07-27). "Client particulier"
      // reste compatible avec isParticulier() (substring "particulier"), sans modifier la valeur
      // brute utilisée par la réconciliation Dercya/pose (qui lit `data.revendeur` avant cet appel).
      revendeur:   data.revendeur  || 'Client particulier',
      // Accessoires volet lus directement dans le PDF (cf. deriveChampsAccessoiresVoletDepuisPdf)
      telecommande: data.telecommande || '',
      gestionSel:   data.gestionSel   || '',
      passesSangles: data.passesSangles || '',
      flasqueMurale: data.flasqueMurale || '',
      corniere6060:  data.corniere6060  || '',
      equerresRenfort: data.equerresRenfort || '',
      murHauteur:   data.murHauteur   || '',
      murCouleur:   data.murCouleur   || '',
      poutreCouleur: data.poutreCouleur || '',
      nombrePoutres: data.nombrePoutres || '',
      caillebotisChoix: data.caillebotisChoix || '',
      caillebotisProfondeur: data.caillebotisProfondeur || '',
      caillebotisLargeur: data.caillebotisLargeur || '',
      caillebotisLargeurEstimee: !!(data.caillebotisLargeur && data.caillebotisLargeurEstimee),
      typeAlimentation: data.typeAlimentation || '',
      needPose:    pose.needPose,
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
                    'bacheDecoupeAspi','bacheOeilletsSupp','bacheAccessoires','bacheAccessoiresDetail','remarques',
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
      bacheAccessoiresDetail: data.bacheAccessoiresDetail || [],
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
      // Volontairement vide à la création : "Date livraison prévue" est une date FUTURE décidée
      // par l'atelier/admin (délai de fabrication), jamais dérivable de la date de commande —
      // la remplir avec dateFrom faisait apparaître TOUT nouveau dossier comme "en retard" dès sa
      // création (bug confirmé par l'utilisateur, 2026-07-22 : d.dateLivraison < today déclenche
      // le badge retard, cf. index.html ligne ~2257). À définir manuellement (f-date-livraison).
      dateLivraison: '',
      transport:   data.transport  || 'livraison',
      remarques:   data.remarques  || '',
      autres:      '',
      revendeur:   data.revendeur  || 'Client particulier',
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
      // dateLivraison volontairement vide — voir commentaire détaillé dans upsertDossier/
      // upsertDossierBache ci-dessus (même bug, même fix).
      dateFrom: data.dateFrom || today, dateTo: '', dateLivraison: '',
      transport: 'liv_pose', remarques: data.remarques || '', autres: data.autres || '',
      largeur: data.largeur || '', longueur: data.longueur || '',
      revendeur: data.revendeur || 'Client particulier', needPose: true, poseDate: '', statut: 'admin',
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
