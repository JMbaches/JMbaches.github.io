/* ================================================================
   FIREBASE LAYER v3 — JM Bâches
   Firestore s'ouvre UNIQUEMENT après confirmation Auth
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
firebase.initializeApp(firebaseConfig);
const _auth = firebase.auth();
const _db   = firebase.firestore();
window._db  = _db; // Exposé pour la messagerie
window._FieldValue = firebase.firestore.FieldValue; // Exposé pour arrayUnion
 
let _firestoreReady = false;
let _unsubUsers, _unsubDossiers, _unsubNotifs, _unsubMessages;
window._chatMessages = [];
 
// ----------------------------------------------------------------
// 3. CHARGEMENT FIRESTORE — lancé uniquement après auth confirmée
// ----------------------------------------------------------------
function startFirestoreListeners() {
  return new Promise(resolve => {
    let loaded = 0;
    // check() ne résout la promesse qu'une seule fois au premier chargement
    const check = () => { if (++loaded >= 3 && !_firestoreReady) resolve(); };
 
    _unsubUsers = _db.collection('users').onSnapshot(snap => {
      users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (currentUser) {
        const r = users.find(u => u.id === currentUser.id);
        if (r) currentUser = r;
      }
      if (_firestoreReady) {
        buildLoginSelect?.();
        if (typeof currentTab !== 'undefined' && currentTab === 'users') renderUsers?.();
      }
      check();
    });
 
    _unsubDossiers = _db.collection('dossiers')
      .orderBy(firebase.firestore.FieldPath.documentId(), 'desc')
      .onSnapshot(snap => {
        dossiers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (_firestoreReady) refreshCurrentView();
        check();
      });
 
    _unsubNotifs = _db.collection('notifications').onSnapshot(snap => {
      notifications = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (String(b.id) > String(a.id) ? 1 : -1));
      if (_firestoreReady) updateBadge?.();
      check();
    });

    // Listener messages temps réel
    _unsubMessages = _db.collection('messages')
      .orderBy('at', 'asc')
      .onSnapshot(snap => {
        window._chatMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (_firestoreReady && currentUser) {
          // Calculer non lus par conv
          window._chatMessages.forEach(m => {
            if (m.from === currentUser.id) return;
            if (!m.readBy || !m.readBy.includes(currentUser.id)) {
              if (!chatConvs[m.convId]) chatConvs[m.convId] = { unread: 0 };
              // On recalcule tout à chaque snapshot
            }
          });

          // Recalculer unread pour chaque conv
          const convIds = ['general', ...users.filter(u => u.id !== currentUser.id).map(u => u.id)];
          convIds.forEach(cid => {
            const unread = window._chatMessages.filter(m =>
              m.convId === cid &&
              m.from !== currentUser.id &&
              (!m.readBy || !m.readBy.includes(currentUser.id))
            ).length;
            if (!chatConvs[cid]) chatConvs[cid] = {};
            chatConvs[cid].unread = unread;
          });

          updateChatBadge?.();
          if (typeof chatOpen !== 'undefined' && chatOpen) {
            buildChatTabs?.();
            renderChatMessages?.();
          }
        }
      });
  });
}
 
function stopFirestoreListeners() {
  _unsubUsers?.();
  _unsubDossiers?.();
  _unsubNotifs?.();
  _unsubMessages?.();
  _firestoreReady = false;
  window._chatMessages = [];
}
 
// ----------------------------------------------------------------
// 4. SAUVEGARDE — remplace saveData()
// ----------------------------------------------------------------
window.saveData = async function saveData() {
  if (!_firestoreReady) return;
  try {
    const batch = _db.batch();
    dossiers.forEach(d => {
      const data = { ...d }; delete data.id;
      batch.set(_db.collection('dossiers').doc(d.id), data, { merge: true });
    });
    users.forEach(u => {
      const data = { ...u }; delete data.id;
      batch.set(_db.collection('users').doc(u.id), data, { merge: true });
    });
    notifications.forEach(n => {
      const data = { ...n }; delete data.id;
      batch.set(_db.collection('notifications').doc(String(n.id)), data, { merge: true });
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
    // onAuthStateChanged prend le relais
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
  stopFirestoreListeners();
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
// 6. SESSION — point d'entrée unique, géré par onAuthStateChanged
// ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  showLoadingOverlay(true);
 
  _auth.onAuthStateChanged(async firebaseUser => {
    if (firebaseUser) {
      // Utilisateur connecté (login ou session persistante)
      showLoadingOverlay(true);
      await startFirestoreListeners();
      _firestoreReady = true;
      showLoadingOverlay(false);
 
      const u = users.find(x =>
        x.email && x.email.toLowerCase() === firebaseUser.email.toLowerCase() && x.active
      );
      if (u) {
        connectUser(u);
      } else {
        console.warn('Pas de profil Firestore pour :', firebaseUser.email);
        stopFirestoreListeners();
        await _auth.signOut();
        showLoadingOverlay(false);
      }
    } else {
      // Pas de session — afficher l'écran de login
      showLoadingOverlay(false);
    }
  });
});
 
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
  // Utilise les constantes INITIAL_ définies dans index.html
  const _users  = typeof INITIAL_USERS         !== 'undefined' ? INITIAL_USERS         : users;
  const _dos    = typeof INITIAL_DOSSIERS       !== 'undefined' ? INITIAL_DOSSIERS       : dossiers;
  const _notifs = typeof INITIAL_NOTIFICATIONS  !== 'undefined' ? INITIAL_NOTIFICATIONS  : notifications;
  const batch = _db.batch();
  _users.forEach(u => {
    const data = { ...u }; delete data.id;
    batch.set(_db.collection('users').doc(u.id), data);
  });
  _dos.forEach(d => {
    const data = { ...d }; delete data.id;
    batch.set(_db.collection('dossiers').doc(d.id), data);
  });
  _notifs.forEach(n => {
    const data = { ...n }; delete data.id;
    batch.set(_db.collection('notifications').doc(String(n.id)), data);
  });
  await batch.commit();
  alert(`✓ Seed terminé : ${_users.length} users, ${_dos.length} dossiers, ${_notifs.length} notifications`);
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
      el.innerHTML = '<div style="width:20px;height:20px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite"></div> Chargement…';
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
    dashboard:       () => typeof renderDashboard      === 'function' && renderDashboard(),
    dossiers:        () => typeof renderDos            === 'function' && renderDos(),
    atelier:         () => typeof renderAtelier        === 'function' && renderAtelier(),
    atelier_grand:   () => typeof renderAtelierGrand   === 'function' && renderAtelierGrand(),
    emballage:       () => typeof renderEmballage      === 'function' && renderEmballage(),
    emballage_grand: () => typeof renderEmballageGrand === 'function' && renderEmballageGrand(),
    planning:        () => typeof renderPlanning       === 'function' && renderPlanning(),
    users:           () => typeof renderUsers          === 'function' && renderUsers(),
  };
  const fn = map[currentTab];
  if (fn) fn();
  updateBadge?.();
}
 
// ----------------------------------------------------------------
// 10. MOT DE PASSE OUBLIÉ
// ----------------------------------------------------------------
window.showResetPassword = function() {
  const modal = document.getElementById('modal-reset-pwd');
  const emailInput = document.getElementById('reset-email');
  // Pré-remplir avec l'email saisi dans le login si disponible
  const loginEmail = document.getElementById('login-email')?.value.trim();
  if (loginEmail) emailInput.value = loginEmail;
  document.getElementById('reset-msg').textContent = '';
  document.getElementById('reset-msg').style.color = 'var(--ink-faint)';
  modal.style.display = 'flex';
  setTimeout(() => emailInput.focus(), 100);
};
 
window.hideResetPassword = function() {
  document.getElementById('modal-reset-pwd').style.display = 'none';
  document.getElementById('reset-msg').textContent = '';
};
 
window.doResetPassword = async function() {
  const email = document.getElementById('reset-email').value.trim().toLowerCase();
  const msg   = document.getElementById('reset-msg');
  const btn   = document.getElementById('reset-btn');
 
  if (!email) {
    msg.style.color = 'var(--red)';
    msg.textContent = 'Entrez votre adresse email.';
    return;
  }
 
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader"></i> Envoi…';
  msg.textContent = '';
 
  try {
    await _auth.sendPasswordResetEmail(email);
    msg.style.color = 'var(--green)';
    msg.textContent = '✓ Email envoyé ! Vérifiez votre boîte mail (et les spams).';
    btn.innerHTML = '<i class="ti ti-check"></i> Envoyé';
    // Fermer automatiquement après 3 secondes
    setTimeout(() => hideResetPassword(), 3000);
  } catch (e) {
    const msgs = {
      'auth/user-not-found': 'Aucun compte trouvé pour cette adresse.',
      'auth/invalid-email':  'Adresse email invalide.',
      'auth/too-many-requests': 'Trop de tentatives — réessayez dans quelques minutes.',
    };
    msg.style.color = 'var(--red)';
    msg.textContent = msgs[e.code] || 'Erreur : ' + e.message;
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-mail"></i> Envoyer le lien';
  }
};
 
// Fermer le modal en cliquant sur le fond
document.getElementById('modal-reset-pwd')?.addEventListener('click', function(e) {
  if (e.target === this) hideResetPassword();
});

