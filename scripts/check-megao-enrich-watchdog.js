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

// Heures ouvrées JM Bâches (2026-07-30) : lundi-vendredi 7h-17h30, Europe/Paris. En dehors de ces
// horaires, l'absence d'email d'enrichissement est NORMALE (personne ne crée/modifie de dossier
// la nuit ou le week-end — le script VM n'envoie que s'il y a un changement, cf. megao_enrich_vm.py
// ::main "Rien de nouveau depuis le dernier envoi — aucun email."). Avant ce correctif, le seuil de
// 2h se déclenchait toutes les nuits (fausse alerte quotidienne), ce qui use la confiance dans
// l'alerte — le jour où c'est un vrai problème, plus personne n'y prête attention.
const BIZ_START_MIN = 7 * 60;        // 07:00
const BIZ_END_MIN   = 17 * 60 + 30;  // 17:30
const BIZ_WEEKDAYS  = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function parisParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return { weekday: get('weekday'), hour: parseInt(get('hour'), 10) % 24, minute: parseInt(get('minute'), 10) };
}
function isBusinessMoment(date) {
  const p = parisParts(date);
  if (!BIZ_WEEKDAYS.has(p.weekday)) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= BIZ_START_MIN && mins < BIZ_END_MIN;
}
// Minutes ouvrées écoulées entre `from` et `to` (échantillonnage minute par minute, borné à 14
// jours — largement suffisant en pratique, le cooldown d'alerte est de 6h — plutôt qu'un calcul
// calendaire pour rester simple). Sert de base au seuil de silence à la place du temps réel écoulé,
// pour qu'un silence de nuit/week-end ne s'accumule pas comme un vrai silence côté VM.
function businessMinutesBetween(from, to) {
  const MAX_MINUTES = 14 * 24 * 60;
  const totalMinutes = Math.min(Math.round((to - from) / 60000), MAX_MINUTES);
  let count = 0;
  for (let i = 0; i < totalMinutes; i++) {
    if (isBusinessMoment(new Date(from.getTime() + i * 60000))) count++;
  }
  return count;
}

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

  const lastSeen = new Date(data.lastSeenAt);
  const silenceMs = Date.now() - lastSeen.getTime();
  const bizSilenceMs = businessMinutesBetween(lastSeen, new Date()) * 60000;
  console.log(`Dernier email d'enrichissement reçu il y a ${Math.round(silenceMs / 60000)} min `
    + `(${Math.round(bizSilenceMs / 60000)} min ouvrées).`);

  if (bizSilenceMs < SILENCE_THRESHOLD_MS) {
    console.log('Silence ouvré sous le seuil (2h) — RAS (silence nuit/week-end normal, non compté).');
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
