// notify-sync-failure.js — Alerte in-app (Direction/Admin) quand la sync Mégao échoue
// Appelé en step `if: failure()` par megao-sync.yml — écrit directement dans la
// collection `notifications` avec le même format que pushNotif() (index.html),
// pour apparaître dans le centre de notifications de l'app comme n'importe
// quelle autre alerte (cloche en haut à droite).
//
// ID du document : timestamp ms (String(Date.now())) plutôt que le compteur
// nextNotifId client (qui repart de 100 à chaque session, cf. index.html) —
// évite toute collision et trie naturellement en tête (le tri de l'app compare
// les id en string : un timestamp à 13 chiffres est toujours "plus grand" que
// les petits compteurs numériques existants).

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function now() {
  const d = new Date();
  const date = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  return `${date} à ${time}`;
}

(async () => {
  const usersSnap = await db.collection('users').get();
  const read = {};
  usersSnap.docs.forEach(doc => {
    const u = doc.data();
    const isAdmin     = u.role === 'admin' || (u.perms || []).includes('users');
    const isDirection = (u.perms || []).includes('users');
    read[doc.id] = !(isAdmin || isDirection); // false = non lu pour Direction/Admin
  });

  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

  const id = String(Date.now());
  await db.collection('notifications').doc(id).set({
    type: 'system:megao_sync_failed',
    dosId: null,
    targets: ['direction', 'admin'],
    icon: 'ti-alert-triangle',
    bg: '#FEE2E2',
    c: '#991B1B',
    title: 'Échec de la synchronisation Mégao',
    body: 'La récupération automatique des commandes Mégao a échoué. Les nouvelles commandes ne seront pas importées tant que ce n\'est pas résolu.' + (runUrl ? ' Détails techniques : ' + runUrl : ''),
    at: now(),
    read,
  });

  console.log(`Notification d'échec créée (id ${id}), ${Object.values(read).filter(v => !v).length} destinataire(s).`);
})().catch(e => { console.error('notify-sync-failure a échoué :', e); process.exit(1); });
