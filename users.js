/* ================================================================
   USERS.JS — JM Bâches
   Module autonome pour la gestion des comptes (création, édition,
   permissions, activation/désactivation, suppression).
   Dépend de variables/fonctions globales définies dans index.html
   (currentUser, users, ROLE_DEFAULT_PERMS, ALL_PERMS, ROLE_COLORS,
   ROLE_LABELS, can, saveData, buildLoginSelect, openModal, closeModal,
   showToast, firebaseConfig) — fonctionne car tous les <script>
   classiques partagent le même scope lexical global du document
   (voir mémoire projet : piège let/window).
   ================================================================ */
let editingUserId = null;

function renderUsers() {
  const permsLabel=ALL_PERMS.reduce((o,p)=>{o[p.id]=p.label;return o},{});
  const apiKey = localStorage.getItem('jmb_claude_api_key') || '';
  document.getElementById('main-content').innerHTML=`
  <div class="section-header">
    <div class="section-title">Gestion des comptes</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-danger btn-sm" onclick="resetData()" title="Remettre toutes les données à zéro"><i class="ti ti-refresh"></i> Réinitialiser</button>
      ${can('reset_dossiers')?`<button class="btn btn-danger btn-sm" onclick="confirmResetDossiers()" title="Supprimer tous les dossiers"><i class="ti ti-trash"></i> Supprimer tous les dossiers</button>`:''}
      <button class="btn btn-primary" onclick="openNewUser()"><i class="ti ti-plus"></i> Nouveau compte</button>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
    ${users.map(u=>{
      const rc=ROLE_COLORS[u.role]||{bg:'#F1EFE8',c:'#444'};
      const isMe=u.id===currentUser.id;
      return `<div class="card" style="padding:14px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
          <div class="avatar" style="background:${rc.bg};color:${rc.c}">${initials(u.name)}</div>
          ${!u.active?`<span class="badge" style="background:var(--red-light);color:var(--red)">Inactif</span>`:''}
        </div>
        <div style="font-size:14px;font-weight:600;margin-bottom:2px">${u.name} ${isMe?'<span style="font-size:11px;color:var(--accent)">(vous)</span>':''}</div>
        <div style="font-size:12px;color:var(--ink-faint);margin-bottom:2px">${u.login} · ${ROLE_LABELS[u.role]}</div>
        ${u.perimetre&&u.perimetre!=='tous'?`<div style="margin-bottom:4px"><span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--accent-light);color:var(--accent-deep);font-weight:600">${u.perimetre==='volet'?'Volets uniquement':'Bâches uniquement'}</span></div>`:''}
        ${u.email?`<div style="font-size:11px;color:var(--ink-faint);margin-bottom:8px"><i class="ti ti-mail" style="font-size:11px;vertical-align:-1px"></i> ${u.email}</div>`:'<div style="margin-bottom:8px"></div>'}
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">${u.perms.map(p=>`<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--bg);border:1px solid var(--border);color:var(--ink-soft)">${permsLabel[p]||p}</span>`).join('')}</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-secondary btn-sm" style="flex:1;justify-content:center" onclick="openEditUser('${u.id}')"><i class="ti ti-edit"></i> Modifier</button>
          ${!isMe?`<button class="btn ${u.active?'btn-danger':'btn-secondary'} btn-sm" onclick="toggleActive('${u.id}')">${u.active?'Désactiver':'Réactiver'}</button>`:''}
          ${!isMe?`<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteUser('${u.id}')" title="Supprimer le compte"><i class="ti ti-trash"></i></button>`:''}
        </div>
      </div>`;
    }).join('')}
  </div>

  ${(can('view_all')||can('planning')) ? _renderBinomesSection() : ''}
`;
  if (can('view_all')||can('planning')) _appendBinomesSection();
}

function syncPerms() {
  const role=document.getElementById('u-role').value;
  const defaults=ROLE_DEFAULT_PERMS[role]||[];
  document.querySelectorAll('#perms-grid input[type=checkbox]').forEach(cb=>{cb.checked=defaults.includes(cb.value);});
}
function buildPermsGrid(current) {
  document.getElementById('perms-grid').innerHTML=ALL_PERMS.map(p=>`
    <label style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:var(--radius);border:1px solid var(--border);cursor:pointer;background:${current.includes(p.id)?'var(--accent-light)':'var(--paper)'};font-size:13px">
      <input type="checkbox" value="${p.id}"${current.includes(p.id)?' checked':''} style="width:15px;height:15px;accent-color:var(--accent);flex-shrink:0">
      <span style="flex:1">${p.label}</span>
    </label>`).join('');
}
function openNewUser() {
  editingUserId=null;
  document.getElementById('modal-user-title').textContent='Nouveau compte';
  document.getElementById('u-name').value='';
  document.getElementById('u-login').value='';
  document.getElementById('u-email').value='';
  document.getElementById('u-role').value='commercial';
  document.getElementById('u-perimetre').value='tous';
  document.getElementById('u-pwd').value='';
  document.getElementById('u-pwd2').value='';
  buildPermsGrid(ROLE_DEFAULT_PERMS.commercial);
  openModal('modal-user');
}
function openEditUser(uid) {
  const u=users.find(x=>x.id===uid); if(!u) return;
  editingUserId=uid;
  document.getElementById('modal-user-title').textContent='Modifier le compte';
  document.getElementById('u-name').value=u.name;
  document.getElementById('u-login').value=u.login;
  document.getElementById('u-email').value=u.email||'';
  document.getElementById('u-role').value=u.role;
  document.getElementById('u-perimetre').value=u.perimetre||'tous';
  document.getElementById('u-pwd').value='';
  document.getElementById('u-pwd2').value='';
  buildPermsGrid(u.perms);
  openModal('modal-user');
}
document.getElementById('u-role').addEventListener('change',syncPerms);
async function saveUser() {
  const name=document.getElementById('u-name').value.trim();
  const login=document.getElementById('u-login').value.trim();
  const email=document.getElementById('u-email').value.trim();
  const pwd1=document.getElementById('u-pwd').value;
  const pwd2=document.getElementById('u-pwd2').value;
  if(!name||!login){alert('Nom et identifiant requis');return;}
  if(!email){alert('L\'adresse email est requise pour créer un compte.');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){alert('Adresse email invalide');return;}
  if(pwd1 && pwd1!==pwd2){alert('Les mots de passe ne correspondent pas');return;}
  const role=document.getElementById('u-role').value;
  const perimetre=document.getElementById('u-perimetre').value;
  const perms=[...document.querySelectorAll('#perms-grid input:checked')].map(cb=>cb.value);

  if(editingUserId) {
    // Modification d'un compte existant
    const u=users.find(x=>x.id===editingUserId);
    u.name=name; u.login=login; u.email=email; u.role=role; u.perms=perms; u.perimetre=perimetre;
    // Ne pas modifier le pwd — géré par Firebase Auth
    if(u.id===currentUser.id) {
      currentUser=u; document.getElementById('top-name').textContent=u.name; document.getElementById('top-role').textContent=ROLE_LABELS[u.role]; buildNav();
      // Le périmètre de l'utilisateur connecté vient de changer — le tableau de dossiers affiché
      // doit être ré-évalué immédiatement (voir dossiersScope()/refreshCurrentView()).
      if (typeof refreshCurrentView === 'function') refreshCurrentView();
    }
    saveData(); closeModal('modal-user'); buildLoginSelect(); renderUsers();
  } else {
    // Nouveau compte : créer dans Firebase Auth puis dans Firestore
    const btn = document.querySelector('#modal-user .btn-primary');
    if(btn) { btn.disabled=true; btn.innerHTML='<i class="ti ti-loader"></i> Création…'; }
    try {
      // Utiliser une app secondaire pour ne pas déconnecter l'utilisateur courant
      const tmpPwd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + 'A1!';
      const secondaryApp = firebase.initializeApp(firebaseConfig, 'createUser_' + Date.now());
      let uid;
      try {
        const cred = await secondaryApp.auth().createUserWithEmailAndPassword(email, tmpPwd);
        uid = cred.user.uid;
        await secondaryApp.auth().signOut();
      } finally {
        await secondaryApp.delete();
      }

      // Créer le profil Firestore avec l'UID comme ID (sans pwd)
      const profileData = { name, login, email, role, perms, perimetre, active: true };
      await window._db.collection('users').doc(uid).set(profileData);

      // Envoyer l'email de définition de mot de passe
      await firebase.auth().sendPasswordResetEmail(email);

      // Ajouter localement
      users.push({ id: uid, ...profileData });
      saveData(); closeModal('modal-user'); buildLoginSelect(); renderUsers();
      showToast(`✓ Compte créé — email de définition de mot de passe envoyé à ${email}`);
    } catch(e) {
      const msgs = {
        'auth/email-already-in-use': 'Cette adresse email est déjà utilisée.',
        'auth/invalid-email': 'Adresse email invalide.',
        'auth/weak-password': 'Mot de passe trop faible (min. 6 caractères).',
        'permission-denied': 'Vous n\'avez pas les droits pour créer un compte.',
      };
      alert(msgs[e.code] || msgs[e.message] || 'Erreur : ' + e.message);
    } finally {
      if(btn) { btn.disabled=false; btn.innerHTML='<i class="ti ti-check"></i> Enregistrer'; }
    }
  }
}
function toggleActive(uid) {
  const u=users.find(x=>x.id===uid); if(!u||u.id===currentUser.id) return;
  u.active=!u.active; saveData(); buildLoginSelect(); renderUsers();
}

async function deleteUser(uid) {
  const u = users.find(x => x.id === uid);
  if (!u || u.id === currentUser.id) return;
  if (!confirm(`Supprimer le compte de ${u.name} ?\n\nCette action :\n• Supprime le profil Firestore\n• Désactive immédiatement l'accès\n• Un lien vous sera affiché pour finaliser la suppression du compte Firebase Auth`)) return;

  try {
    // 1. Supprimer le profil Firestore
    if (window._db) {
      await window._db.collection('users').doc(uid).delete();
    }
    // 2. Supprimer localement
    users = users.filter(x => x.id !== uid);
    buildLoginSelect();
    renderUsers();

    // 3. Afficher lien vers Firebase Console pour supprimer le compte Auth
    const consoleUrl = `https://console.firebase.google.com/project/jm-baches/authentication/users`;
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--charcoal);color:#fff;padding:14px 20px;border-radius:var(--radius-lg);font-size:13px;z-index:9999;display:flex;gap:14px;align-items:center;box-shadow:var(--shadow-lg);max-width:500px';
    msg.innerHTML = `<i class="ti ti-check" style="color:var(--green);font-size:16px;flex-shrink:0"></i>
      <span>Profil de <strong>${u.name}</strong> supprimé. Pensez à supprimer le compte Auth (UID : <code style="font-size:11px;opacity:.7">${uid.slice(0,12)}…</code>)</span>
      <a href="${consoleUrl}" target="_blank" style="color:var(--accent-light);white-space:nowrap;font-weight:600">Ouvrir →</a>
      <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,.5);cursor:pointer;font-size:16px;padding:0 4px">×</button>`;
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 12000);
  } catch(e) {
    if (e.code === 'permission-denied') showToast('⛔ Vous n\'avez pas les droits pour supprimer ce compte');
    else { console.error('deleteUser error:', e); showToast('Erreur lors de la suppression'); }
  }
}
