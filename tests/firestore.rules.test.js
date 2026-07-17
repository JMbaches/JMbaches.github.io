/* ================================================================
   TESTS DE RÉGRESSION — Règles de sécurité Firestore (JM Bâches)
   ----------------------------------------------------------------
   Rejoue contre l'émulateur Firestore les scénarios réels de l'app
   (lecture/écriture par collection) pour détecter AVANT publication
   toute règle qui casse un usage légitime — voir la régression du
   2026-07-17 : la messagerie était cassée en prod car son listener
   faisait une requête large incompatible avec une règle par-document,
   découvert seulement en testant en conditions réelles après coup.

   Usage : npm run test:rules
   (lance l'émulateur Firestore avec firestore.rules, puis ce script)

   ⚠️ Garder `firestore.rules` synchronisé avec la Console Firebase à
   chaque modification — ce fichier teste le MIROIR local, pas le
   ruleset réellement déployé.
   ================================================================ */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'jm-baches-rules-test';

let pass = 0, fail = 0;
const failures = [];

async function check(label, promise, expect) {
  try {
    if (expect === 'succeed') await assertSucceeds(promise);
    else await assertFails(promise);
    pass++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    fail++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
    console.log('     ' + String(e.message || e).split('\n')[0]);
  }
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
  });

  // ---- Fixtures : personas seedées hors règles (withSecurityRulesDisabled) ----
  await testEnv.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await db.collection('users').doc('admin1').set({ active: true, role: 'admin', perms: ['users', 'create', 'edit', 'stock'] });
    await db.collection('users').doc('direction1').set({ active: true, role: 'direction', perms: [] });
    await db.collection('users').doc('poseur1').set({ active: true, role: 'poseur', perms: [] });
    await db.collection('users').doc('viewer1').set({ active: true, role: 'metreur', perms: ['metreur'] });
    await db.collection('users').doc('inactive1').set({ active: false, role: 'admin', perms: ['users'] });
    await db.collection('users').doc('noperm1').set({ active: true, role: 'ouvrier', perms: [] });

    await db.collection('dossiers').doc('D1').set({ statut: 'admin' });
    await db.collection('notifications').doc('N1').set({ text: 'x', read: { admin1: true } });
    await db.collection('messages').doc('M-general').set({ convId: 'general', from: 'noperm1', text: 'hey' });
    await db.collection('messages').doc('M-priv').set({ convId: 'priv_noperm1_viewer1', from: 'noperm1', text: 'hey' });
    await db.collection('meta').doc('horaires').set({ data: {} });
    await db.collection('poseur_hours').doc('poseur1').set({ data: {} });
    await db.collection('stock_refs').doc('REF1').set({ categorie: 'aluminium', label: 'Axe 320', quantite: 10 });
    await db.collection('stock_mouvements').doc('SM1').set({ codeBarre: 'REF1', action: 'entree', qte: 1 });
    await db.collection('config').doc('stock').set({ decompteAutoActif: true });
  });

  const anon = () => testEnv.unauthenticatedContext().firestore();
  const as = uid => testEnv.authenticatedContext(uid).firestore();

  // ============================== users ==============================
  console.log('\n-- users --');
  await check('anonyme ne peut pas lister users', anon().collection('users').get(), 'fail');
  await check('inactif ne peut pas lister users', as('inactive1').collection('users').get(), 'fail');
  await check('actif sans perm peut lister users', as('noperm1').collection('users').get(), 'succeed');
  await check('sans perm ne peut pas créer user', as('noperm1').collection('users').doc('new1').set({ active: true, role: 'ouvrier', perms: [] }), 'fail');
  await check("hasPerm('users') peut créer user", as('admin1').collection('users').doc('new1').set({ active: true, role: 'ouvrier', perms: [] }), 'succeed');
  await check("sans perm ne peut pas supprimer user", as('noperm1').collection('users').doc('viewer1').delete(), 'fail');
  await check("hasPerm('users') peut supprimer user", as('admin1').collection('users').doc('new1').delete(), 'succeed');
  await check('peut modifier son propre profil (champ neutre)', as('noperm1').collection('users').doc('noperm1').set({ active: true, role: 'ouvrier', perms: [], name: 'Nouveau nom' }), 'succeed');
  await check('ne peut pas modifier son propre role', as('noperm1').collection('users').doc('noperm1').set({ active: true, role: 'admin', perms: [] }), 'fail');
  await check("ne peut pas modifier le profil d'un autre", as('noperm1').collection('users').doc('viewer1').set({ active: true, role: 'metreur', perms: ['metreur'], name: 'x' }), 'fail');

  // ============================ dossiers ==============================
  console.log('\n-- dossiers --');
  await check('sans perm de vue ne peut pas lire dossiers', as('noperm1').collection('dossiers').get(), 'fail');
  await check("hasPerm('metreur') peut lire dossiers", as('viewer1').collection('dossiers').get(), 'succeed');
  await check("sans hasPerm('create') ne peut pas créer dossier", as('noperm1').collection('dossiers').doc('D2').set({ statut: 'nouveau' }), 'fail');
  await check("hasPerm('create') peut créer dossier", as('admin1').collection('dossiers').doc('D2').set({ statut: 'nouveau' }), 'succeed');
  await check("hasPerm('metreur') peut modifier dossier", as('viewer1').collection('dossiers').doc('D1').update({ statut: 'verif' }), 'succeed');
  await check('sans perm ne peut pas modifier dossier', as('noperm1').collection('dossiers').doc('D1').update({ statut: 'verif' }), 'fail');
  await check('sans droit ne peut pas supprimer dossier', as('noperm1').collection('dossiers').doc('D1').delete(), 'fail');
  await check('direction peut supprimer dossier', as('direction1').collection('dossiers').doc('D2').delete(), 'succeed');

  // ========================== notifications ===========================
  console.log('\n-- notifications --');
  await check('actif peut lire notifications', as('noperm1').collection('notifications').get(), 'succeed');
  await check('actif peut créer notification', as('noperm1').collection('notifications').doc('N2').set({ text: 'y', read: {} }), 'succeed');
  await check('peut marquer SA SEULE clé "read"', as('noperm1').collection('notifications').doc('N1').update({ read: { admin1: true, noperm1: true } }), 'succeed');
  await check("ne peut pas marquer la clé 'read' de quelqu'un d'autre", as('viewer1').collection('notifications').doc('N1').update({ read: { admin1: false, viewer1: true } }), 'fail');
  await check("ne peut pas modifier un champ hors 'read'", as('noperm1').collection('notifications').doc('N1').update({ text: 'modifié' }), 'fail');
  await check('sans droit ne peut pas supprimer notification', as('noperm1').collection('notifications').doc('N1').delete(), 'fail');
  await check('direction peut supprimer notification', as('direction1').collection('notifications').doc('N2').delete(), 'succeed');

  // ============================= messages =============================
  // Le cœur du sujet : le bug de prod du 2026-07-17 (requête large cassée
  // par une règle par-document) — ces tests figent le comportement attendu
  // pour empêcher une régression silencieuse similaire.
  console.log('\n-- messages --');
  await check("non-membre d'une conv privée ne peut PAS lire ce message", as('direction1').collection('messages').doc('M-priv').get(), 'fail');
  await check('tout actif peut lire un message du canal general', as('viewer1').collection('messages').doc('M-general').get(), 'succeed');
  await check('membre de la conv privée peut lire son message', as('viewer1').collection('messages').doc('M-priv').get(), 'succeed');
  await check('[RÉGRESSION] liste NON filtrée (orderBy seul) = REFUSÉE en bloc', as('viewer1').collection('messages').orderBy('at').get(), 'fail');
  await check("[FIX] liste filtrée par égalité convId=='general' = OK", as('viewer1').collection('messages').where('convId', '==', 'general').get(), 'succeed');
  await check("[FIX] liste filtrée par égalité sur la conv privée = OK", as('viewer1').collection('messages').where('convId', '==', 'priv_noperm1_viewer1').get(), 'succeed');
  await check("non-membre ne peut pas créer un message dans une conv qui n'est pas la sienne", as('admin1').collection('messages').doc('M-hack').set({ convId: 'priv_noperm1_viewer1', from: 'admin1', text: 'x' }), 'fail');
  await check("ne peut pas usurper 'from' (impersonation)", as('viewer1').collection('messages').doc('M-hack2').set({ convId: 'general', from: 'admin1', text: 'x' }), 'fail');
  await check('membre peut créer un message avec from == soi-même', as('viewer1').collection('messages').doc('M-ok').set({ convId: 'general', from: 'viewer1', text: 'x' }), 'succeed');
  await check('peut supprimer son propre message', as('viewer1').collection('messages').doc('M-ok').delete(), 'succeed');
  await check("ne peut pas supprimer le message d'un autre", as('viewer1').collection('messages').doc('M-general').delete(), 'fail');
  await check('direction peut supprimer le message de quelqu\'un d\'autre', as('direction1').collection('messages').doc('M-general').delete(), 'succeed');

  // =============================== meta ================================
  console.log('\n-- meta --');
  await check('actif peut lire meta/horaires', as('noperm1').collection('meta').doc('horaires').get(), 'succeed');
  await check("sans horaires_poseurs/direction ne peut pas écrire meta/horaires", as('noperm1').collection('meta').doc('horaires').set({ data: {} }), 'fail');
  await check('direction peut écrire meta/horaires', as('direction1').collection('meta').doc('horaires').set({ data: {} }), 'succeed');

  // =========================== poseur_hours ============================
  console.log('\n-- poseur_hours --');
  await check('poseur peut lire/écrire son propre doc', as('poseur1').collection('poseur_hours').doc('poseur1').set({ data: {} }), 'succeed');
  await check("poseur ne peut pas écrire le doc d'un autre", as('poseur1').collection('poseur_hours').doc('autre').set({ data: {} }), 'fail');
  await check("poseur ne peut pas lire le doc d'un autre poseur", as('poseur1').collection('poseur_hours').doc('inexistant').get(), 'fail');
  await check('direction peut lire un doc poseur_hours ciblé', as('direction1').collection('poseur_hours').doc('poseur1').get(), 'succeed');
  await check("[réel] direction peut lister TOUTE la collection poseur_hours", as('direction1').collection('poseur_hours').get(), 'succeed');
  await check("actif sans droit horaires ne peut PAS lister toute la collection poseur_hours", as('noperm1').collection('poseur_hours').get(), 'fail');

  // ====================== stock_refs / stock_mouvements / config ======================
  console.log('\n-- stock --');
  await check("sans hasPerm('stock') ne peut pas lire stock_refs", as('noperm1').collection('stock_refs').get(), 'fail');
  await check("hasPerm('stock') peut lire/écrire stock_refs", as('admin1').collection('stock_refs').doc('REF2').set({ categorie: 'aluminium', label: 'Axe 420', quantite: 5 }), 'succeed');
  await check("hasPerm('stock') peut créer un mouvement", as('admin1').collection('stock_mouvements').doc('SM2').set({ codeBarre: 'REF1', action: 'sortie', qte: 1 }), 'succeed');
  await check('[historique immuable] personne ne peut modifier un mouvement, même admin', as('admin1').collection('stock_mouvements').doc('SM1').update({ qte: 99 }), 'fail');
  await check('[historique immuable] personne ne peut supprimer un mouvement, même admin', as('admin1').collection('stock_mouvements').doc('SM1').delete(), 'fail');
  await check('actif peut lire config/stock', as('noperm1').collection('config').doc('stock').get(), 'succeed');
  await check("sans hasPerm('stock') ne peut pas écrire config/stock", as('noperm1').collection('config').doc('stock').set({ decompteAutoActif: false }), 'fail');
  await check("hasPerm('stock') peut écrire config/stock", as('admin1').collection('config').doc('stock').set({ decompteAutoActif: false }), 'succeed');

  // ============================ défaut : refus =========================
  console.log('\n-- collection non listée (refus par défaut) --');
  await check('même direction ne peut rien lire sur une collection non déclarée', as('direction1').collection('secret_stuff').doc('x').get(), 'fail');
  await check('même admin ne peut rien écrire sur une collection non déclarée', as('admin1').collection('secret_stuff').doc('x').set({ a: 1 }), 'fail');

  await testEnv.cleanup();

  console.log(`\n${pass}/${pass + fail} tests passés.`);
  if (fail) {
    console.log('Échecs : ' + failures.join(', '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
