// check-megao-enrich-watchdog.js — Alerte in-app si l'enrichissement Mégao
// (accessoires/notes envoyés par le script VM megao_enrich_vm.py) est
// silencieux depuis trop longtemps.
//
// Pourquoi ce script distinct de notify-sync-failure.js : megao-enrich-sync.js
// réussit TOUJOURS (exit 0), même si la VM est éteinte ou sa tâche planifiée
// arrêtée — "0 email(s) d'enrichissement trouvé(s)" n'est pas une erreur, donc
// aucune alerte existante ne se déclenche dans ce cas. Incident réel du
// 2026-07-22 au 2026-07-28 (6 jours) découvert par hasard, pas par une alerte —
// ce script comble ce trou en surveillant le SILENCE plutôt que l'échec.
//
// Repose sur config/megaoEnrichWatchdog.lastSeenAt, mis à jour par
// megao-enrich-sync.js dès qu'au moins un email d'enrichissement est trouvé.

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const SILENCE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h — décidé avec l'utilisateur (2026-07-28)
const ALERT_COOLDOWN_MS    = 6 * 60 * 60 * 1000; // 6h — anti-spam pendant qu'une panne dure

function now() {
  const d = new Date();
  const date = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  return `${date} à ${time}`;
}

(async () => {
  const ref = db.collection('config').doc('megaoEnrichWatchdog');
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : null;

  if (!data || !data.lastSeenAt) {
    // Premier passage jamais vu (déploiement initial) : on amorce l'horodatage
    // sans alerter — pas d'historique de référence pour juger d'un silence.
    await ref.set({ lastSeenAt: new Date().toISOString() }, { merge: true });
    console.log('Watchdog amorcé (aucun historique précédent) — pas d\'alerte.');
    return;
  }

  const silenceMs = Date.now() - new Date(data.lastSeenAt).getTime();
  console.log(`Dernier email d'enrichissement reçu il y a ${Math.round(silenceMs / 60000)} min.`);

  if (silenceMs < SILENCE_THRESHOLD_MS) {
    console.log('Silence sous le seuil (2h) — RAS.');
    return;
  }

  const lastAlertedMs = data.lastAlertedAt ? new Date(data.lastAlertedAt).getTime() : 0;
  if (Date.now() - lastAlertedMs < ALERT_COOLDOWN_MS) {
    console.log('Silence prolongé mais alerte déjà envoyée récemment (cooldown 6h) — pas de nouvelle notification.');
    return;
  }

  const usersSnap = await db.collection('users').get();
  const read = {};
  usersSnap.docs.forEach(doc => {
    const u = doc.data();
    const isAdmin     = u.role === 'admin' || (u.perms || []).includes('users');
    const isDirection = (u.perms || []).includes('users');
    read[doc.id] = !(isAdmin || isDirection); // false = non lu pour Direction/Admin
  });

  const heures = Math.round(silenceMs / 3600000);
  const id = String(Date.now());
  await db.collection('notifications').doc(id).set({
    type: 'system:megao_enrich_silence',
    dosId: null,
    targets: ['direction', 'admin'],
    icon: 'ti-alert-triangle',
    bg: '#FEE2E2',
    c: '#991B1B',
    title: 'Enrichissement Mégao silencieux',
    body: `Aucune donnée d'enrichissement (accessoires/notes) reçue depuis la VM Mégao depuis environ ${heures}h. Vérifier que la VM et sa tâche planifiée tournent toujours.`,
    at: now(),
    read,
  });

  await ref.set({ lastAlertedAt: new Date().toISOString() }, { merge: true });
  console.log(`Alerte de silence créée (id ${id}), ${Object.values(read).filter(v => !v).length} destinataire(s).`);
})().catch(e => { console.error('check-megao-enrich-watchdog a échoué :', e); process.exit(1); });
