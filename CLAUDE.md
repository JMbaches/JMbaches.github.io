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
- `u.posteAtelier` (`tablier`/`accessoires`/`axes`) restreint la vue Atelier volets
  à un poste précis (découpage du travail en 3 postes séparés).
- Toujours vérifier après un test de permissions que `currentUser.posteAtelier`
  (ou tout champ muté "juste pour tester") n'a pas été persisté par erreur sur
  un vrai compte : `currentUser` EST le même objet que l'entrée dans `users[]`,
  donc un `saveData()` appelé pendant un test persiste réellement la mutation
  (piège vécu, a fuité sur un compte réel une fois — corrigé immédiatement).

## Ce qui est délibérément désactivé / limité (ne pas "corriger" sans en parler)
- `config/stock.decompteAutoActif = false` en prod : le décompte auto de stock à
  l'entrée en production est câblé et testé bout en bout, mais **désactivé
  volontairement**. Ne pas le réactiver sans validation explicite.
- `caillebotisLargeur` est **estimée** depuis la largeur du bassin (~5% de risque
  d'erreur accepté sciemment) — la vraie valeur vient des fiches fab/côte.
- Fixation béton/coque : non automatisable (aucun code Mégao fiable), laissé de côté.
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
