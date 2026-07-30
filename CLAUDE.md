# CLAUDE.md — App de gestion de dossiers JM Bâches

Brief technique pour reprise du projet. Lis ce fichier en entier avant d'agir.
C'est l'app la plus grosse et la plus utilisée au quotidien (production, atelier,
stock, planning, messagerie interne).

## En une phrase
Suivi de dossiers clients (volets + bâches) de la commande à la livraison :
imports automatiques depuis les emails de commande Mégao, ateliers de fabrication,
stock, emballage, livraison/pose planifiée, messagerie interne par dossier.
Déployé : **https://jmbaches.github.io/** (racine du repo `JMbaches/JMbaches.github.io`,
c'est un repo GitHub Pages spécial à l'org — pas de dossier `devis`/`planning` ici).

## Fichiers principaux
- `index.html` (~380 Ko) : cœur de l'app — vues, navigation, dossiers, fiche
  dossier, recherche, raccourcis clavier. Le plus gros fichier, à chercher en
  premier pour toute logique transverse.
- `atelier.js`, `emballage.js`, `stock.js`, `users.js`, `chat.js` : modules par
  domaine, extraits de `index.html` mais **partagent le même scope global**
  (variables/fonctions comme `users`, `dossiers`, `currentUser`, `saveData`,
  `can()` sont des globales de `index.html` — pas d'imports/exports, c'est du
  script classique concaténé par le navigateur). Piège connu : ne pas utiliser
  `let`/`const` au top-level d'un de ces fichiers pour un nom déjà utilisé ailleurs.
- `firebase-layer-v3.js` : **toute** la synchro Firestore — `startFirestoreListeners()`
  (un `onSnapshot` par collection, reconstruit l'array JS en entier à chaque
  changement) et `saveData()` (réécrit dossiers/users/notifications/stock_refs/
  stock_mouvements par batch à chaque appel). Lire ce fichier avant de toucher
  à la persistance de quoi que ce soit.
- `planning.html` + `planning.js` : **copie embarquée** de l'app planning
  autonome (voir dépôt séparé `planning-jm`, plus bas). Ce n'est PAS un import/build
  — c'est une copie maintenue à la main en resynchronisant les mêmes correctifs
  dans les deux fichiers. Voir section dédiée ci-dessous, c'est un piège réel.
- `scripts/` : pipeline d'import Mégao (`megao-sync.js` / `megao-enrich-sync.js`).

## Firebase
- Projet : **`jm-baches`** (différent de `jm-baches-devis` utilisé par le
  configurateur de devis, dépôt séparé `jm-devis` — deux projets Firebase distincts).
- Règles Firestore versionnées et testées : `npm run test:rules` (suite dans
  `tests/`, 56/56 au dernier passage). Toujours relancer cette suite après une
  modif de `firestore.rules`.
- Clé de service admin (pour scripts one-off / diagnostics) : voir la note
  "Clés de service" plus bas — **il y en a deux, avec des noms différents,
  attention à ne pas se tromper**.

## Conventions & pièges à connaître (le plus important de ce fichier)

### 1. Ne jamais pousser manuellement dans un tableau synchronisé par onSnapshot
`users`, `dossiers`, `notifications`, `stock_refs`, `stock_mouvements` sont
**entièrement reconstruits** par les listeners de `firebase-layer-v3.js` à chaque
écriture Firestore. Si du code fait une écriture Firestore PUIS un `push()`/`splice()`
manuel sur le même tableau JS "pour aller plus vite", ça crée une course : le
listener arrive souvent avant la fin du code manuel et produit des doublons
transitoires à l'écran (bug réel corrigé le 2026-07-29, commit `f27c99b`,
voir `users.js`). Laisser le listener faire le travail ; au pire, appeler
`renderXxx()` juste après l'écriture pour un rafraîchissement immédiat.

### 2. `saveData()` réécrit TOUT à chaque appel
Ce n'est pas une sauvegarde incrémentale — chaque appel réécrit l'intégralité
des tableaux `dossiers`/`users`/`notifications`/`stock_refs`/`stock_mouvements`
en batch (avec `merge:true`). C'est la convention établie dans tout le code
(appelé après quasi chaque mutation d'état) — ne pas essayer de "l'optimiser"
en la remplaçant par des writes ciblés sans en parler, ça casserait le pattern
partout ailleurs.

Depuis le 2026-07-30 (`_commitResilient`/`sanitizeForFirestore`, firebase-layer-v3.js), ce n'est
plus un lot Firestore unique et atomique pour toute la collection : les écritures sont chunkées
(50 documents/lot) et chaque valeur invalide pour Firestore (NaN, Infinity, undefined — typiquement
un champ numérique mal saisi en cours d'édition côté client) est omise avant écriture au lieu de
faire échouer tout le lot. Un lot qui échoue quand même est rejoué document par document pour
isoler le(s) fautif(s). Avant ce fix, UN SEUL dossier dans un état invalide bloquait
silencieusement la sauvegarde de tous les autres — symptôme rapporté par l'utilisateur comme
"erreur de sauvegarde" apparemment liée à une action sans rapport (ex. création de compte, qui
déclenche le même `saveData()` global).

### 3. Piège du Service Worker en test
L'app est une PWA (`sw.js`). En test, le SW peut servir du JS en cache **malgré
un rechargement de page** — plusieurs bugs ont semblé "ne pas se corriger" alors
que le fix était bon, juste pas chargé. Avant de conclure à un bug de logique :
désinscrire le service worker + vider les caches, puis rejouer le test.

### 4. Planning : DEUX copies à maintenir manuellement
- `planning-jm` (dépôt séparé `JMbaches/planning`, déployé seul sur
  https://jmbaches.github.io/planning/) : app autonome (React inline, tout en
  un seul `index.html`), **stockage 100% local** (`localStorage`, pas de Firebase),
  clé API Claude Vision + clé OpenRouteService saisies et gardées en local.
- `planning.html`/`planning.js` ICI (dans ce dépôt) : copie embarquée avec un
  pont `isEmbedded`/`postMessage` vers le reste de l'app de gestion (masque le
  header interne, communique avec le shell parent).
- **Ces deux copies ne sont PAS synchronisées automatiquement.** Un fix dans
  l'algorithme de planning (priorités, créneaux, etc.) doit être **réappliqué
  aux deux endroits**, à la main, sur les mêmes zones de code (méthode déjà
  utilisée le 2026-07-27 : patcher les mêmes ancrages dans les deux fichiers
  plutôt que reconstruire le pont d'intégration à chaque fois).

### 5. Pipeline Mégao (import automatique des commandes)
`scripts/megao-sync.js` tourne en continu sur une **VM Windows** (hôte XCP-ng/Xen
`JMBACHES-RDS`) qui surveille une boîte mail, enrichit les dossiers, et pousse
vers Firestore via GitHub Actions. Point de fragilité connu : le script ne tourne
que tant qu'une session RDS Windows reste ouverte — une déconnexion de session
arrête la synchro silencieusement (déjà arrivé, 6 jours de panne non détectée).
Un garde-fou d'alerte existe si le silence dépasse 2h. **Point ouvert non résolu** :
il faudrait un accès admin à cette VM pour configurer l'auto-démarrage + connexion
auto Windows, afin que ça ne recasse plus. À reprendre avec JM/Mégao si l'accès
est obtenu.

### 6. Restrictions & rôles
- `u.perimetre` (`tous`/`volet`/`bache`) restreint les dossiers visibles par compte.
- `u.posteAtelier` (`accessoires`/`tablier_pvc`/`tablier_poly`/`axes`) restreint la vue Atelier
  volets à un poste précis. Ordre de fabrication (réordonné + tablier scindé PVC/Poly le
  2026-07-30, sur demande utilisateur) : **Accessoires → Tablier (PVC ou Poly selon
  `d.typeLame`) → Axes → Emballage** — entièrement séquentiel, un seul poste actionnable à la
  fois par dossier (voir `atelierEtapeActuelle()`/`atelierTablierFait()` dans atelier.js — cette
  dernière reste compatible avec les dossiers déjà en production avant ce changement via l'ancien
  champ `d.atelierPoste==='accessoires_axes'`, sans migration de données). Un compte affecté à un
  poste ne peut plus glisser-déposer les cartes du grand écran atelier pour réordonner la file
  (ce n'est pas sa décision) — seuls les comptes en vue d'ensemble (`posteAtelier` vide,
  direction/admin) le peuvent (`atelierPeutReorganiser()`).
- Toujours vérifier après un test de permissions que `currentUser.posteAtelier`
  (ou tout champ muté "juste pour tester") n'a pas été persisté par erreur sur
  un vrai compte : `currentUser` EST le même objet que l'entrée dans `users[]`,
  donc un `saveData()` appelé pendant un test persiste réellement la mutation
  (piège vécu, a fuité sur un compte réel une fois — corrigé immédiatement).

### 7. Secteurs de pose JM / Azenco / Akena (`poseSecteur`, 2026-07-30)
Qui pose un dossier **livraison+pose** dépend du **département du chantier** (2 premiers chiffres
du CP), d'après la carte POSE'N CO fournie par l'utilisateur. Fonction `classePose(transport, cp,
structure)` — **dupliquée** dans `index.html` ET `scripts/megao-sync.js` (pas de module partagé ;
les 2 listes `JM_POSE_DEPTS`/`AKENA_POSE_DEPTS` doivent rester identiques aux 2 endroits) :
- **Immergé** (`structure` contient "immerg") → **toujours JM**, quel que soit le département.
- Département dans `JM_POSE_DEPTS` (35 dépts) → pose **JM** : `needPose=true`, `poseSecteur='jm'`, va au planning.
- Département dans `AKENA_POSE_DEPTS` (`02 59 60 62 76 80`) → JM ne pose pas : transport **rétrogradé en `'livraison'`**, aucune pose.
- Tout autre département → pose **Azenco** (sous-traitance) : `poseSecteur='azenco'`, `needPose=false`, PAS au planning, badge orange "Pose Azenco — indicatif".
- `poseSecteur` vaut `'jm'` | `'azenco'` | `''`. Le planning n'inclut un dossier que via
  `poseComptePlanning(d)` = `(needPose || transport==='liv_pose') && poseSecteur!=='azenco'` — le
  `|| transport==='liv_pose'` est un filet pour les vieux dossiers sans `needPose`, mais exclut
  explicitement Azenco (sinon un liv_pose Azenco serait rattrapé à tort). Utilisé partout où le
  planning filtre (planning.js + garde-fou d'envoi atelier).
- Recalculé automatiquement : à l'import Mégao (upsertDossier volet) et à chaque changement de
  `transport`/`cp`/`structure` dans la fiche (setDosField). Les bâches ne sont jamais concernées.
- Le statut de livraison (expédié→livré→**posé**) reste inchangé pour une pose Azenco (transport
  reste `'liv_pose'`, la pose a bien lieu, mais par Azenco) — seul le PLANNING JM l'exclut.

## Ce qui est délibérément désactivé / limité (ne pas "corriger" sans en parler)
- `config/stock.decompteAutoActif = false` en prod : le décompte auto de stock à
  l'entrée en production est câblé et testé bout en bout, mais **désactivé
  volontairement**. Ne pas le réactiver sans validation explicite.
- `caillebotisLargeur` est **estimée** depuis la largeur du bassin (~5% de risque
  d'erreur accepté sciemment) — la vraie valeur vient des fiches fab/côte.
- Fixation béton/coque : non automatisable (aucun code Mégao fiable), laissé de côté.
- Flasque murale Silver Roll (code Mégao `ACVRFLASQMUR`, 213 occurrences réelles) : la réf
  stock `Flasque de fixation murale` existe (`aluminium.csv` legacy, jamais migrée en tant que
  telle vers Firestore à vérifier), mais **aucune fonction de l'ancienne app Stock.exe ne la
  décrémentait** — automatiser ça serait une décision nouvelle, pas un portage. Sa désignation
  dit "remplace un pied de la structure" : décompter 1 pied de moins en plus n'est pas tranché.
  En attente de clarification JM avant d'écrire quoi que ce soit.
- Équerre poutre/mur "pose sur arase" (code Mégao `ACVREQUPOUTR`, 897 occurrences réelles,
  volume élevé) : **aucune réf stock au nom correspondant** dans le catalogue legacy (seules
  "Equerre de flasque/poutre bassin béton/coque" et "Equerre de renfort telescopique" existent,
  aucune ne correspond). Bloqué tant que JM n'a pas confirmé sous quel nom stock ranger cet
  accessoire — ne pas deviner un mapping.
- ~28 anciens dossiers ont `typeLame` vide : identifiés, backfill volontairement
  pas fait (décision de s'arrêter là).
- 7 dossiers réels (sur 185) sans bon de commande dans le porte-document,
  concentrés sur 2 fenêtres du 16/06 et du 19/06/2026 — incident transitoire
  probable (upload Storage/Gmail), aucun accès mailbox pour récupérer les PDF
  d'origine, à traiter manuellement si besoin.

## Clés de service (⚠️ ne jamais committer)
Deux fichiers différents existent sur cette machine, avec des noms différents :
- `~/Downloads/service-account.json`
- `~/Downloads/firebase-serviceaccount.json` (utilisé par les scripts de
  `Downloads/firebase-import/`)
Vérifier lequel correspond à quel projet Firebase (`jm-baches` vs `jm-baches-devis`)
avant de lancer un script — ne pas supposer qu'ils sont interchangeables.

## Historique détaillé
Une quantité importante de bugs corrigés, décisions prises et pièges découverts
est journalisée dans la mémoire Claude de ce projet (fichier
`project_app_globale_jmbaches.md` côté Claude) — utile pour retracer le "pourquoi"
d'un choix qui semble bizarre au premier abord.
