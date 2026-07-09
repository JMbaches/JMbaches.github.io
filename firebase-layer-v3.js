/* ================================================================
   FIREBASE LAYER v3 — JM Bâches
   Firestore s'ouvre UNIQUEMENT après confirmation Auth
   ================================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyBe3ftHEv0SLYE9iaLoX0ycv4b0os48wPI",
  authDomain: "jm-baches.firebaseapp.com",
  projectId: "jm-baches",
  storageBucket: "jm-baches.firebasestorage.app",
  messagingSenderId: "526625133379",
  appId: "1:526625133379:web:5d23d9eef20df4a1bd55f6"
};

firebase.initializeApp(firebaseConfig);

// App Check — reCAPTCHA v3 (invisible, aucune interaction utilisateur)
const _appCheck = firebase.appCheck();
_appCheck.activate(
  new firebase.appCheck.ReCaptchaV3Provider('6LcgHxktAAAAAIbSowBLdOfNPY-2gSr7MGTlRf2y'),
  true
);

const _auth = firebase.auth();
const _db   = firebase.firestore();
window._db  = _db;
window._FieldValue = firebase.firestore.FieldValue;
try { window._storage = firebase.storage(); } catch(e) { console.warn('Firebase Storage non disponible'); }

let _firestoreReady = false;
let _unsubUsers, _unsubDossiers, _unsubNotifs, _unsubMessages, _unsubStockRefs, _unsubStockMouvements;
window._chatMessages = [];

// Affiche un message propre au lieu de planter sur permission-denied
function handleFirestoreError(e, context) {
  if (e.code === 'permission-denied') {
    if (typeof showToast === 'function') showToast('⛔ Action non autorisée' + (context ? ' : ' + context : ''));
    else console.warn('Permission refusée :', context, e);
  } else {
    console.error('Firestore error' + (context ? ' [' + context + ']' : ''), e);
  }
}

function startFirestoreListeners() {
  return new Promise(resolve => {
    let loaded = 0;
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
        if (typeof currentTab !== 'undefined' && currentTab === 'planning_avance') {
          typeof _planningAvanceAutoSync === 'function' && _planningAvanceAutoSync();
        }
      }
      check();
    }, e => { handleFirestoreError(e, 'users'); check(); });

    _unsubDossiers = _db.collection('dossiers')
      .orderBy(firebase.firestore.FieldPath.documentId(), 'desc')
      .onSnapshot(snap => {
        dossiers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (_firestoreReady) refreshCurrentView();
        check();
      }, e => { handleFirestoreError(e, 'dossiers'); check(); });

    _unsubNotifs = _db.collection('notifications').onSnapshot(snap => {
      notifications = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (String(b.id) > String(a.id) ? 1 : -1));
      if (_firestoreReady) updateBadge?.();
      check();
    }, e => { handleFirestoreError(e, 'notifications'); check(); });

    _unsubMessages = _db.collection('messages')
      .orderBy('at', 'asc')
      .onSnapshot(snap => {
        window._chatMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Vérification stricte avant tout accès à currentUser
        if (!_firestoreReady || !currentUser || !currentUser.id) return;
        // Recalculer non lus avec convIds canoniques (priv_u1_u9)
        const otherUsers = users.filter(u => u.id !== currentUser.id);
        const convIds = [
          'general',
          ...otherUsers.map(u => {
            const ids = [currentUser.id, u.id].sort();
            return 'priv_' + ids[0] + '_' + ids[1];
          })
        ];
        convIds.forEach(cid => {
          const unread = window._chatMessages.filter(m =>
            m.convId === cid &&
            m.from !== currentUser.id &&
            (!m.readBy || !m.readBy.includes(currentUser.id))
          ).length;
          if (!chatConvs[cid]) chatConvs[cid] = {};
          chatConvs[cid].unread = unread;
        });
        if (currentUser && currentUser.id) updateChatBadge?.();
        if (typeof chatOpen !== 'undefined' && chatOpen && currentUser && currentUser.id) {
          buildChatTabs?.();
          renderChatMessages?.();
          }
      }, e => { handleFirestoreError(e, 'messages'); });

    _unsubStockRefs = _db.collection('stock_refs').onSnapshot(snap => {
      stockRefs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_firestoreReady) refreshCurrentView();
    }, e => { handleFirestoreError(e, 'stock_refs'); });

    _unsubStockMouvements = _db.collection('stock_mouvements')
      .orderBy('at', 'desc')
      .limit(200)
      .onSnapshot(snap => {
        stockMouvements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (_firestoreReady) refreshCurrentView();
      }, e => { handleFirestoreError(e, 'stock_mouvements'); });
  });
}

function stopFirestoreListeners() {
  _unsubUsers?.();
  _unsubDossiers?.();
  _unsubNotifs?.();
  _unsubMessages?.();
  _unsubStockRefs?.();
  _unsubStockMouvements?.();
  _unsubUsers = _unsubDossiers = _unsubNotifs = _unsubMessages = _unsubStockRefs = _unsubStockMouvements = null;
  _firestoreReady = false;
  window._chatMessages = [];
}

window.saveData = async function saveData() {
  if (!_firestoreReady) return;
  let hasError = false;

  // 1. Dossiers
  try {
    const batch = _db.batch();
    dossiers.forEach(d => {
      const data = { ...d }; delete data.id;
      batch.set(_db.collection('dossiers').doc(d.id), data, { merge: true });
    });
    await batch.commit();
  } catch (e) {
    console.error('Firestore saveData [dossiers] error:', e);
    hasError = true;
  }

  // 2. Users — uniquement si l'utilisateur a le droit d'écrire
  try {
    const batch = _db.batch();
    users.forEach(u => {
      const data = { ...u }; delete data.id;
      delete data.pwd;
      batch.set(_db.collection('users').doc(u.id), data, { merge: true });
    });
    await batch.commit();
  } catch (e) {
    // Permission refusée pour cet utilisateur — silencieux, pas une erreur bloquante
    if (e.code !== 'permission-denied') {
      console.error('Firestore saveData [users] error:', e);
      hasError = true;
    }
  }

  // 3. Notifications
  try {
    const batch = _db.batch();
    notifications.forEach(n => {
      const data = { ...n }; delete data.id;
      batch.set(_db.collection('notifications').doc(String(n.id)), data, { merge: true });
    });
    await batch.commit();
  } catch (e) {
    console.error('Firestore saveData [notifications] error:', e);
    hasError = true;
  }

  showSaveIndicator(hasError ? 'error' : 'ok');
};

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
  // 1. Fermer et cacher le chat EN PREMIER
  if (typeof chatOpen !== 'undefined') chatOpen = false;
  if (typeof chatConvs !== 'undefined') chatConvs = {};
  const chatPanel = document.getElementById('chat-panel');
  if (chatPanel) chatPanel.classList.remove('open');
  const chatBtn = document.getElementById('chat-btn');
  if (chatBtn) chatBtn.style.display = 'none';
  // 2. Effacer la présence avant de couper les listeners
  if (typeof clearPresence === 'function') clearPresence();
  stopFirestoreListeners();
  // 3. Déconnecter Auth
  await _auth.signOut();
  // 4. Nettoyer l'état
  currentUser = null;
  currentDosId = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-email').value = '';
  document.getElementById('login-pwd').value = '';
  document.getElementById('login-error').textContent = '';
};

document.addEventListener('DOMContentLoaded', () => {
  showLoadingOverlay(true);

  // Si Firebase/reCAPTCHA ne répond pas en 12s, afficher une erreur claire
  const loadTimeout = setTimeout(() => {
    showLoadingOverlay(false);
    document.getElementById('login-screen').style.display = 'flex';
    const err = document.getElementById('login-error');
    if (err) err.textContent = '⚠️ Impossible de contacter Firebase. Vérifiez votre connexion internet et rechargez la page.';
  }, 12000);

  _auth.onAuthStateChanged(async firebaseUser => {
    clearTimeout(loadTimeout);
    if (firebaseUser) {
      showLoadingOverlay(true);
      await startFirestoreListeners();
      _firestoreReady = true;
      showLoadingOverlay(false);
      const u = users.find(x => x.id === firebaseUser.uid && x.active)
             || users.find(x => x.email && x.email.toLowerCase() === firebaseUser.email.toLowerCase() && x.active);
      if (u) {
        connectUser(u);
      } else {
        console.warn('Pas de profil Firestore pour :', firebaseUser.email);
        stopFirestoreListeners();
        await _auth.signOut();
        showLoadingOverlay(false);
      }
    } else {
      showLoadingOverlay(false);
    }
  });
});

window.resetData = async function resetData() {
  if (!confirm('Remettre toutes les données à zéro ? Cette action est irréversible.')) return;
  const batch = _db.batch();
  dossiers.forEach(d => batch.delete(_db.collection('dossiers').doc(d.id)));
  notifications.forEach(n => batch.delete(_db.collection('notifications').doc(String(n.id))));
  await batch.commit();
  location.reload();
};

window.seedFirestore = async function seedFirestore() {
  if (!confirm('Importer les données initiales ? À ne faire qu\'une seule fois.')) return;
  const _users  = typeof INITIAL_USERS        !== 'undefined' ? INITIAL_USERS        : users;
  const _dos    = typeof INITIAL_DOSSIERS      !== 'undefined' ? INITIAL_DOSSIERS      : dossiers;
  const _notifs = typeof INITIAL_NOTIFICATIONS !== 'undefined' ? INITIAL_NOTIFICATIONS : notifications;
  const batch = _db.batch();
  _users.forEach(u => { const data = { ...u }; delete data.id; delete data.pwd; batch.set(_db.collection('users').doc(u.id), data); });
  _dos.forEach(d => { const data = { ...d }; delete data.id; batch.set(_db.collection('dossiers').doc(d.id), data); });
  _notifs.forEach(n => { const data = { ...n }; delete data.id; batch.set(_db.collection('notifications').doc(String(n.id)), data); });
  await batch.commit();
  alert(`✓ Seed terminé : ${_users.length} users, ${_dos.length} dossiers, ${_notifs.length} notifications`);
};

/* ================================================================
   STOCK (lames PVC/polycarbonate) — collections indépendantes de saveData()
   ================================================================ */
window.saveStockRef = async function saveStockRef(codeBarre, { type, finition, taille, minimum }) {
  try {
    const ref = _db.collection('stock_refs').doc(codeBarre);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({ type, finition, taille, minimum: minimum || 0, quantite: 0, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
  } catch (e) {
    handleFirestoreError(e, 'saveStockRef');
  }
};

window.submitStockMouvement = async function submitStockMouvement(codeBarre, action, qte) {
  try {
    const ref = _db.collection('stock_refs').doc(codeBarre);
    await _db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const avant = snap.exists ? (snap.data().quantite || 0) : 0;
      const delta = action === 'entree' ? qte : action === 'sortie' ? -qte : (qte - avant);
      const quantiteApres = avant + delta;
      tx.set(ref, { quantite: quantiteApres }, { merge: true });
      tx.set(_db.collection('stock_mouvements').doc(), {
        codeBarre, action, qte, delta, quantiteApres,
        at: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    handleFirestoreError(e, 'submitStockMouvement');
  }
};

window.updateStockRef = async function updateStockRef(codeBarre, { type, finition, taille, minimum }) {
  try {
    await _db.collection('stock_refs').doc(codeBarre).set({ type, finition, taille, minimum: minimum || 0 }, { merge: true });
  } catch (e) {
    handleFirestoreError(e, 'updateStockRef');
  }
};

window.deleteStockRef = async function deleteStockRef(codeBarre) {
  try {
    await _db.collection('stock_refs').doc(codeBarre).delete();
  } catch (e) {
    handleFirestoreError(e, 'deleteStockRef');
  }
};

// Pièces détachées hors lames (alimentation, aluminium, moteur...) — pas de code-barre, ID auto
window.saveCatStockRef = async function saveCatStockRef(categorie, { label, minimum }) {
  try {
    const docRef = await _db.collection('stock_refs').add({
      categorie, label, minimum: minimum || 0, quantite: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return docRef.id;
  } catch (e) {
    handleFirestoreError(e, 'saveCatStockRef');
    return null;
  }
};

window.updateCatStockRef = async function updateCatStockRef(id, { label, minimum }) {
  try {
    await _db.collection('stock_refs').doc(id).set({ label, minimum: minimum || 0 }, { merge: true });
  } catch (e) {
    handleFirestoreError(e, 'updateCatStockRef');
  }
};

function showSaveIndicator(state) {
  const ind = document.getElementById('save-indicator');
  if (!ind) return;
  if (state === 'ok') {
    ind.textContent = '✓ Sauvegardé'; ind.style.color = 'var(--green)';
    clearTimeout(ind._t);
    ind._t = setTimeout(() => { ind.textContent = '☁ Cloud'; ind.style.color = 'rgba(255,255,255,.4)'; }, 2000);
  } else {
    ind.textContent = '⚠ Erreur sauvegarde'; ind.style.color = 'var(--red)';
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
  if (typeof currentTab === 'string' && currentTab.startsWith('stock_cat_')) {
    if (typeof renderStockCategorie === 'function') renderStockCategorie(currentTab.slice('stock_cat_'.length));
    updateBadge?.();
    return;
  }
  const map = {
    dashboard:       () => typeof renderDashboard      === 'function' && renderDashboard(),
    dossiers:        () => typeof renderDos            === 'function' && renderDos(),
    atelier:         () => typeof renderAtelier        === 'function' && renderAtelier(),
    atelier_grand:   () => typeof renderAtelierGrand   === 'function' && renderAtelierGrand(),
    emballage:       () => typeof renderEmballage      === 'function' && renderEmballage(),
    emballage_grand: () => typeof renderEmballageGrand === 'function' && renderEmballageGrand(),
    planning:        () => typeof renderPlanning       === 'function' && renderPlanning(),
    users:           () => typeof renderUsers          === 'function' && renderUsers(),
    planning_avance: () => typeof _planningAvanceAutoSync === 'function' && _planningAvanceAutoSync(),
    stock_scan:      () => typeof renderStockScan      === 'function' && renderStockScan(),
    stock_liste:     () => typeof renderStockListe     === 'function' && renderStockListe(),
  };
  const fn = map[currentTab];
  if (fn) fn();
  updateBadge?.();
}

window.showResetPassword = function() {
  const modal = document.getElementById('modal-reset-pwd');
  const emailInput = document.getElementById('reset-email');
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
  if (!email) { msg.style.color = 'var(--red)'; msg.textContent = 'Entrez votre adresse email.'; return; }
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader"></i> Envoi…';
  msg.textContent = '';
  try {
    await _auth.sendPasswordResetEmail(email);
    msg.style.color = 'var(--green)';
    msg.textContent = '✓ Email envoyé ! Vérifiez votre boîte mail (et les spams).';
    btn.innerHTML = '<i class="ti ti-check"></i> Envoyé';
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

document.getElementById('modal-reset-pwd')?.addEventListener('click', function(e) {
  if (e.target === this) hideResetPassword();
});
