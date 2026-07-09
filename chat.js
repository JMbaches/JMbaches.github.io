/* ================================================================
   CHAT.JS — JM Bâches
   Module autonome pour la messagerie interne (chat général + privé).
   Dépend de variables/fonctions globales définies dans index.html
   (currentUser, users, ROLE_COLORS, initials, now, openFiche) et dans
   firebase-layer-v3.js (window._db, window._chatMessages, window._FieldValue)
   — fonctionne car tous les <script> classiques partagent le même scope
   lexical global du document (voir mémoire projet : piège let/window).
   ================================================================ */
/* ================================================================
   MESSAGERIE INTERNE
   ================================================================ */

let chatOpen = false;
let chatCurrentConv = 'general'; // 'general' ou convId canonique pour privé
let chatConvs = {}; // { convId: { unread: N } }

// Retourne un convId canonique identique des deux côtés
// ex: u1 + u9 → "priv_u1_u9" (toujours trié alphabétiquement)
function getPrivConvId(userId) {
  if (!currentUser) return userId;
  const ids = [currentUser.id, userId].sort();
  return 'priv_' + ids[0] + '_' + ids[1];
}

// Ouvrir/fermer le panneau
function toggleChat() {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chat-panel');
  if (chatOpen) {
    panel.classList.add('open');
    buildChatTabs();
    // S'assurer que chatCurrentConv est un convId canonique
    if (chatCurrentConv !== 'general' && !chatCurrentConv.startsWith('priv_')) {
      chatCurrentConv = getPrivConvId(chatCurrentConv);
    }
    openChatConv(chatCurrentConv);
  } else {
    panel.classList.remove('open');
  }
}

// Construire les onglets (Général + conversations privées actives)
function buildChatTabs() {
  const tabs = document.getElementById('chat-tabs');
  if (!tabs) return;

  // Calculer non lus par conv
  const otherUsers = users.filter(u => u.id !== currentUser.id && u.active);

  tabs.innerHTML = ['general', ...otherUsers.map(u => u.id)].map(id => {
    const isGeneral = id === 'general';
    const convId = isGeneral ? 'general' : getPrivConvId(id);
    const label = isGeneral ? '# Général' : (users.find(u => u.id === id)?.name || id);
    const unread = chatConvs[convId]?.unread || 0;
    const active = chatCurrentConv === convId ? ' active' : '';
    return `<button class="chat-tab${active}" onclick="openChatConv('${convId}','${id}')">
      ${label}
      ${unread > 0 ? `<span class="tab-badge">${unread}</span>` : ''}
    </button>`;
  }).join('');
}

// Ouvrir une conversation
function openChatConv(convId, userId) {
  chatCurrentConv = convId;
  if (chatConvs[convId]) chatConvs[convId].unread = 0;
  buildChatTabs();
  updateChatBadge();

  let title;
  if (convId === 'general') {
    title = '# Canal général';
  } else {
    // Trouver le nom de l'autre utilisateur depuis le convId canonique
    const otherId = userId || convId.replace('priv_', '').split('_').find(id => id !== currentUser.id);
    title = 'Conversation avec ' + (users.find(u => u.id === otherId)?.name || otherId);
  }
  document.getElementById('chat-panel-title').textContent = title;

  // Marquer tous les messages non lus de cette conv comme lus
  if (window._db && currentUser) {
    const unreadMsgs = (window._chatMessages || []).filter(m =>
      m.convId === convId &&
      m.from !== currentUser.id &&
      (!m.readBy || !m.readBy.includes(currentUser.id))
    );
    // Mise à jour optimiste locale IMMÉDIATE — évite que le prochain snapshot
    // recalcule unread=1 avant que Firestore confirme le readBy
    unreadMsgs.forEach(m => {
      if (!m.readBy) m.readBy = [];
      if (!m.readBy.includes(currentUser.id)) m.readBy = [...m.readBy, currentUser.id];
    });
    // Puis persister dans Firestore en arrière-plan
    unreadMsgs.forEach(m => {
      window._db.collection('messages').doc(m.id).update({
        readBy: (window._FieldValue || firebase.firestore.FieldValue).arrayUnion(currentUser.id)
      }).catch(() => {});
    });
  }

  renderChatMessages();
}

// Afficher les messages de la conv courante
function renderChatMessages() {
  const el = document.getElementById('chat-messages');
  if (!el) return;

  const msgs = (window._chatMessages || []).filter(m => m.convId === chatCurrentConv);

  if (!msgs.length) {
    el.innerHTML = '<div class="chat-empty"><i class="ti ti-message-off" style="font-size:24px;display:block;margin-bottom:6px;opacity:.4"></i>Aucun message — démarrez la conversation !</div>';
    return;
  }

  let lastDate = '';
  el.innerHTML = msgs.map(m => {
    const mine = m.from === currentUser.id;
    const sender = users.find(u => u.id === m.from);
    const rc = ROLE_COLORS[sender?.role] || { bg: '#EAF0F9', c: '#14479B' };
    const av = `<div class="chat-msg-av" style="background:${rc.bg};color:${rc.c}">${initials(sender?.name || '?')}</div>`;

    // Séparateur de date
    const msgDate = m.at ? m.at.split(' ')[0] : '';
    let dateSep = '';
    if (msgDate && msgDate !== lastDate) {
      lastDate = msgDate;
      dateSep = `<div class="chat-date-sep">${msgDate}</div>`;
    }

    // Référence dossier
    const dosRef = m.dosId
      ? `<div><span class="chat-dos-ref" onclick="openFiche('${m.dosId}')"><i class="ti ti-file-description" style="font-size:11px"></i> ${m.dosId}</span></div>`
      : '';

    return `${dateSep}<div class="chat-msg${mine ? ' mine' : ''}">
      ${!mine ? av : ''}
      <div class="chat-msg-body">
        <div class="chat-msg-bubble">${escapeHtml(m.text)}${dosRef}</div>
        <div class="chat-msg-meta">${!mine ? (sender?.name || '') + ' · ' : ''}${m.at?.split(' à ')[1] || ''}</div>
      </div>
      ${mine ? av : ''}
    </div>`;
  }).join('');

  // Scroll en bas
  el.scrollTop = el.scrollHeight;
}

// Envoyer un message
async function sendChatMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !window._db || !currentUser) return;

  const btn = document.getElementById('chat-send-btn');
  btn.disabled = true;

  // Détecter mention de dossier ex: #D-2025-001
  const dosMatch = text.match(/#(D-\d{4}-\d{3})/);
  const dosId = dosMatch ? dosMatch[1] : null;

  const msg = {
    convId: chatCurrentConv,
    from: currentUser.id,
    text,
    dosId: dosId || null,
    at: now(),
    readBy: [currentUser.id],
  };

  try {
    await window._db.collection('messages').add(msg);
    input.value = '';
    input.style.height = 'auto';
  } catch (e) {
    console.error('Erreur envoi message:', e);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// Touche Entrée pour envoyer (Shift+Entrée pour saut de ligne)
function chatInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMsg();
  }
}

// Mettre à jour le badge sur le bouton flottant
function updateChatBadge() {
  const total = Object.values(chatConvs).reduce((s, c) => s + (c.unread || 0), 0);
  const badge = document.getElementById('chat-badge');
  if (!badge) return;
  if (total > 0) {
    badge.textContent = total > 9 ? '9+' : total;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Initialiser le bouton chat après connexion
function initChat() {
  const btn = document.getElementById('chat-btn');
  if (btn) { btn.style.display = 'flex'; btn.style.alignItems = 'center'; btn.style.justifyContent = 'center'; }
}
