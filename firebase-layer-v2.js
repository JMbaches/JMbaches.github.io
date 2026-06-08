/* ================================================================
   FIREBASE LAYER v2 — JM Bâches
   Version COMPAT (sans import ES module) — compatible GitHub Pages
   
   UTILISATION : ce fichier est chargé APRÈS les scripts Firebase compat
   via des balises <script> classiques dans le HTML.
   ================================================================ */

// ----------------------------------------------------------------
// 1. CONFIGURATION — remplacer par ta vraie config
// ----------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBe3ftHEv0SLYE9iaLoX0ycv4b0os48wPI",
  authDomain: "jm-baches.firebaseapp.com",
  projectId: "jm-baches",
  storageBucket: "jm-baches.firebasestorage.app",
  messagingSenderId: "526625133379",
  appId: "1:526625133379:web:5d23d9eef20df4a1bd55f6"
};

// ----------------------------------------------------------------
// 2. INITIALISATION
// ----------------------------------------------------------------
firebase.initializeApp(FIREBASE_CONFIG);
const _auth = firebase.auth();
const _db   = firebase.firestore();

let _firestoreReady = false;

// ----------------------------------------------------------------
// 3. CHARGEMENT INITIAL — abonnements temps réel
// ----------------------------------------------------------------
async function initFirebase() {
  showLoadingOverlay(true);

  await waitForFirstLoad();
  _firestoreReady = true;
  showLoadingOverlay(false);

  // Abonnements temps réel après le premier chargement
  _db.collection('users').onSnapshot(snap => {
    users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentUser) {
      const refreshed = users.find(u => u.id === currentUser.id);
      if (refreshed) currentUser = refreshed;
    }
    if (_firestoreReady) {
      buildLoginSelect?.();
      if (typeof currentTab !== 'undefined' && currentTab === 'users') renderUsers?.();
    }
  });

  _db.collection('dossiers').orderBy(firebase.firestore.FieldPath.documentId(), 'desc').onSnapshot(snap => {
    dossiers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (_firestoreReady) refreshCurrentView();
  });

  _db.collection('notifications').onSnapshot(snap => {
    notifications = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (String(b.id) > String(a.id) ? 1 : -1));
    if (_firestoreReady) updateBadge?.();
  });
}

function waitForFirstLoad() {
  return new Promise(resolve => {
    let loaded = 0;
    const check = () => { if (++loaded >= 3) resolve(); };
    const u1 = _db.collection('users').onSnapshot(() => { u1(); check(); });
    const u2 = _db.collection('dossiers').onSnapshot(() => { u2(); check(); });
    const u3 = _db.collection('notifications').onSnapshot(() => { u3(); check(); });
  });
}

// ----------------------------------------------------------------
// 4. SAUVEGARDE — remplace saveData()
// ----------------------------------------------------------------
window.saveData = async function saveData() {
  if (!_firestoreReady) return;
  try {
    const batch = _db.batch();
    dossiers.forEach(d => {
      const ref = _db.collection('dossiers').doc(d.id);
      const data = { ...d }; delete data.id;
      batch.set(ref, data, { merge: true });
    });
    users.forEach(u => {
      const ref = _db.collection('users').doc(u.id);
      const data = { ...u }; delete data.id;
      batch.set(ref, data, { merge: true });
    });
    notifications.forEach(n => {
      const ref = _db.collection('notifications').doc(String(n.id));
      const data = { ...n }; delete data.id;
      batch.set(ref, data, { merge: true });
    });
    await batch.commit();
    showSaveIndicator('ok');
  } catch (e) {
    console.error('Firestore saveData error:', e);
    showSaveIndicator('error');
  }
};

// ----------------------------------------------------------------
// 5. AUTH — remplace doLogin() / doLogout()
// ----------------------------------------------------------------
window.doLogin = async function doLogin() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pwd   = document.getElementById('login-pwd').value;
  const err   = document.getElementById('login-error');

  if (!email) { err.textContent = 'Entrez votre adresse email'; return; }
  if (!pwd)   { err.textContent = 'Entrez votre mot de passe'; return; }

  err.textContent = '';
  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Connexion…'; }

  try {
    await _auth.signInWithEmailAndPassword(email, pwd);
  } catch (e) {
    const msgs = {
      'auth/user-not-found':     'Aucun compte trouvé pour cette adresse email',
      'auth/wrong-password':     'Mot de passe incorrect',
      'auth/invalid-email':      'Adresse email invalide',
      'auth/user-disabled':      'Ce compte a été désactivé',
      'auth/too-many-requests':  'Trop de tentatives — réessayez dans quelques minutes',
      'auth/invalid-credential': 'Email ou mot de passe incorrect',
    };
    err.textContent = msgs[e.code] || 'Erreur : ' + e.message;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-login"></i> Se connecter'; }
  }
};

window.doLogout = async function doLogout() {
  await _auth.signOut();
  currentUser = null;
  currentDosId = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-email').value = '';
  document.getElementById('login-pwd').value = '';
  document.getElementById('login-error').textContent = '';
};

// ----------------------------------------------------------------
// 6. SESSION — remplace la reconnexion localStorage
// ----------------------------------------------------------------
_auth.onAuthStateChanged(async firebaseUser => {
  if (firebaseUser) {
    // Attendre que Firestore soit prêt si ce n'est pas encore le cas
    if (!_firestoreReady) await waitUntilReady();
    const u = users.find(x => x.email && x.email.toLowerCase() === firebaseUser.email.toLowerCase() && x.active);
    if (u) {
      connectUser(u);
    } else {
      console.warn('Pas de profil Firestore pour :', firebaseUser.email);
      await _auth.signOut();
    }
  }
});

function waitUntilReady() {
  return new Promise(resolve => {
    const interval = setInterval(() => {
      if (_firestoreReady) { clearInterval(interval); resolve(); }
    }, 100);
  });
}

// ----------------------------------------------------------------
// 7. RESET
// ----------------------------------------------------------------
window.resetData = async function resetData() {
  if (!confirm('Remettre toutes les données à zéro ? Cette action est irréversible.')) return;
  const batch = _db.batch();
  dossiers.forEach(d => batch.delete(_db.collection('dossiers').doc(d.id)));
  notifications.forEach(n => batch.delete(_db.collection('notifications').doc(String(n.id))));
  await batch.commit();
  location.reload();
};

// ----------------------------------------------------------------
// 8. SEED
// ----------------------------------------------------------------
window.seedFirestore = async function seedFirestore() {
  if (!confirm('Importer les données initiales ? À ne faire qu\'une seule fois.')) return;
  const batch = _db.batch();
  users.forEach(u => {
    const data = { ...u }; delete data.id;
    batch.set(_db.collection('users').doc(u.id), data);
  });
  dossiers.forEach(d => {
    const data = { ...d }; delete data.id;
    batch.set(_db.collection('dossiers').doc(d.id), data);
  });
  notifications.forEach(n => {
    const data = { ...n }; delete data.id;
    batch.set(_db.collection('notifications').doc(String(n.id)), data);
  });
  await batch.commit();
  alert(`✓ Seed terminé : ${users.length} users, ${dossiers.length} dossiers, ${notifications.length} notifications`);
};

// ----------------------------------------------------------------
// 9. UTILITAIRES UI
// ----------------------------------------------------------------
function showSaveIndicator(state) {
  const ind = document.getElementById('save-indicator');
  if (!ind) return;
  if (state === 'ok') {
    ind.textContent = '✓ Sauvegardé';
    ind.style.color = 'var(--green)';
    clearTimeout(ind._t);
    ind._t = setTimeout(() => {
      ind.textContent = '☁ Cloud';
      ind.style.color = 'rgba(255,255,255,.4)';
    }, 2000);
  } else {
    ind.textContent = '⚠ Erreur sauvegarde';
    ind.style.color = 'var(--red)';
  }
}

function showLoadingOverlay(show) {
  let el = document.getElementById('fb-loading-overlay');
  if (show) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'fb-loading-overlay';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(20,20,24,.75);display:flex;align-items:center;justify-content:center;z-index:9999;color:#fff;font-size:15px;font-family:DM Sans,sans-serif;gap:12px';
      el.innerHTML = '<div style="width:20px;height:20px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite"></div> Chargement des données…';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
  } else {
    if (el) el.style.display = 'none';
  }
}

function refreshCurrentView() {
  if (typeof currentTab === 'undefined') return;
  const map = {
    dashboard:      () => typeof renderDashboard     === 'function' && renderDashboard(),
    dossiers:       () => typeof renderDos           === 'function' && renderDos(),
    atelier:        () => typeof renderAtelier       === 'function' && renderAtelier(),
    atelier_grand:  () => typeof renderAtelierGrand  === 'function' && renderAtelierGrand(),
    emballage:      () => typeof renderEmballage     === 'function' && renderEmballage(),
    emballage_grand:() => typeof renderEmballageGrand=== 'function' && renderEmballageGrand(),
    planning:       () => typeof renderPlanning      === 'function' && renderPlanning(),
    users:          () => typeof renderUsers         === 'function' && renderUsers(),
  };
  const fn = map[currentTab];
  if (fn) fn();
  updateBadge?.();
}

// ----------------------------------------------------------------
// 10. DÉMARRAGE
// ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
});
