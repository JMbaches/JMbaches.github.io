/* ================================================================
   EMBALLAGE.JS — JM Bâches
   Module autonome pour l'onglet Emballage (liste + vue grand écran,
   signalement de manquants, drag&drop de tri, avancement de statut).
   Dépend de variables/fonctions globales définies dans index.html
   (dossiers, currentTab, STATUT_NEXT, STATUT_LABEL, logHistory,
   pushNotif, saveData, showToast, fmt, ttc, openFiche, printFeuilLivraison)
   — fonctionne car tous les <script> classiques partagent le même
   scope lexical global du document (voir mémoire projet : piège
   let/window).
   ================================================================ */
function signalerManquant(id) {
  const d = dossiers.find(x => x.id === id);
  if (!d) return;
  const el = document.getElementById('manquant-input-'+id);
  if (!el) {
    // Afficher le champ
    const zone = document.getElementById('manquant-zone-'+id);
    if (zone) {
      zone.innerHTML = `
        <div style="margin-top:10px;background:var(--red-light);border:1px solid #F09595;border-radius:var(--radius);padding:10px 12px">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--red);margin-bottom:6px">Décrire ce qui manque</div>
          <textarea id="manquant-input-${id}" placeholder="ex: télécommande manquante, lame abîmée..." style="width:100%;min-height:56px;border:1px solid #F09595;border-radius:3px;padding:7px 9px;font-size:13px;background:#fff;color:var(--ink);resize:vertical"></textarea>
          <div style="display:flex;gap:7px;margin-top:7px">
            <button class="btn btn-danger btn-sm" style="flex:1;justify-content:center" onclick="confirmerManquant('${id}')"><i class="ti ti-alert-triangle"></i> Confirmer le signalement</button>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('manquant-zone-${id}').innerHTML=''">Annuler</button>
          </div>
        </div>`;
    }
    return;
  }
  confirmerManquant(id);
}

function confirmerManquant(id) {
  const d = dossiers.find(x => x.id === id);
  const el = document.getElementById('manquant-input-'+id);
  if (!d || !el) return;
  const txt = el.value.trim();
  if (!txt) { el.focus(); return; }
  logHistory(id, 'commentaire', '⚠ Manquant signalé à l\'emballage', txt);
  pushNotif('commentaire', id, d, '⚠ MANQUANT : ' + txt);
  saveData();
  showToast('Manquant signalé — l\'admin a été notifié');
  renderEmballage();
}

function renderEmballage() {
  const aEmballer = dossiers.filter(d => d.statut === 'emballage').filter(matchesTypeFilter);
  const stockes   = dossiers.filter(d => d.statut === 'stocké').filter(matchesTypeFilter);
  const mc = document.getElementById('main-content');

  mc.innerHTML = `
  <div id="toast-msg" class="toast-msg"></div>
  <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <div>
      <h1 style="font-size:20px;font-weight:700;letter-spacing:-.2px">Emballage</h1>
      <p>${aEmballer.length} commande${aEmballer.length>1?'s':''} à emballer · ${stockes.length} en stock</p>
    </div>
    ${typeFilterSelectHtml('renderEmballage')}
  </div>

  ${aEmballer.length===0&&stockes.length===0 ? `<div class="empty-state"><i class="ti ti-package"></i>Aucune commande en attente d'emballage</div>` : ''}

  ${aEmballer.length > 0 ? `
  <div class="section-header" style="margin-bottom:14px">
    <div class="section-title" style="color:#92400E;font-size:15px;font-weight:700"><i class="ti ti-package" style="margin-right:6px"></i>À emballer (${aEmballer.length})</div>
  </div>
  <div class="stagger" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:28px">
    ${aEmballer.map(d => {
      const manquantsExistants = d.history.filter(h => h.type==='commentaire' && h.action.includes('Manquant signalé'));
      const transportLabel = {enlvt:'Enlèvement client',liv_pose:'Livraison + Pose',livraison:'Livraison seule'}[d.transport]||d.transport;
      return `<div class="daily-card" style="border-color:#F59E0B">
        <div style="padding:14px 16px 12px;background:#FFFBEB;border-bottom:1px solid #FDE68A">
          <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--ink-faint);font-weight:500;margin-bottom:4px">${d.id}</div>
          <div style="font-size:19px;font-weight:700;color:var(--ink);margin-bottom:2px;letter-spacing:-.2px">${d.client}</div>
          <div style="font-size:13px;color:var(--ink-soft);font-weight:500">${d.structure||'—'}</div>
        </div>
        <div style="padding:13px 16px">
          ${d.lames||d.pieds ? `<div class="spec-grid" style="margin-bottom:11px">
            ${d.lames ? `<div><div class="spec-k">Lames</div><div class="spec-v">${d.lames}</div></div>` : ''}
            ${d.pieds ? `<div><div class="spec-k">Pieds</div><div class="spec-v">${d.pieds}</div></div>` : ''}
          </div>` : ''}
          ${d.options ? `<div style="margin-bottom:10px"><div class="spec-k" style="margin-bottom:4px">Options</div><div style="font-size:12px;color:var(--ink-soft)">${d.options}</div></div>` : ''}
          ${d.transport ? `<div style="margin-bottom:12px"><span style="background:#E0E7FF;color:#3730A3;padding:3px 10px;border-radius:3px;font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:4px"><i class="ti ti-truck" style="font-size:11px"></i>${transportLabel}</span></div>` : ''}
          ${manquantsExistants.length > 0 ? `<div style="background:var(--red-light);border:1px solid #F09595;border-radius:var(--radius);padding:8px 10px;margin-bottom:10px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--red);margin-bottom:3px">⚠ ${manquantsExistants.length} manquant${manquantsExistants.length>1?'s':''} signalé${manquantsExistants.length>1?'s':''}</div>${manquantsExistants.slice(-2).map(h=>`<div style="font-size:12px;color:var(--red)">${h.detail}</div>`).join('')}</div>` : ''}
          <div id="manquant-zone-${d.id}"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:6px">
            <button class="btn btn-secondary" style="justify-content:center;font-size:12px" onclick="printFeuilLivraison('${d.id}')"><i class="ti ti-printer"></i> Feuille livraison</button>
            <button class="btn btn-ghost" style="justify-content:center;font-size:12px;color:var(--red);border-color:#F09595" onclick="signalerManquant('${d.id}')"><i class="ti ti-alert-triangle"></i> Manquant</button>
          </div>
          <button class="btn btn-primary" onclick="avancerDos('${d.id}',event)" style="width:100%;justify-content:center;margin-top:8px"><i class="ti ti-archive"></i> Marquer stocké</button>
        </div>
      </div>`;
    }).join('')}
  </div>` : ''}

  ${stockes.length > 0 ? `
  <div class="section-header" style="margin-bottom:14px">
    <div class="section-title" style="color:#3730A3;font-size:15px;font-weight:700"><i class="ti ti-archive" style="margin-right:6px"></i>En stock (${stockes.length})</div>
  </div>
  <div class="table-wrap">
    <table>
      <colgroup><col style="width:85px"><col style="width:160px"><col style="width:130px"><col style="width:120px"><col style="width:90px"><col style="width:120px"><col></colgroup>
      <thead><tr><th>N°</th><th>Client</th><th>Produit</th><th>Transport</th><th>Date</th><th>Livraison</th><th>Action</th></tr></thead>
      <tbody>${stockes.map(d=>`<tr>
        <td style="font-size:11px;color:var(--ink-faint);font-family:'JetBrains Mono',monospace;font-weight:500">${d.id}</td>
        <td><strong>${d.client}</strong></td>
        <td style="color:var(--ink-soft)">${d.structure||'—'}</td>
        <td><span style="background:#E0E7FF;color:#3730A3;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600">${{enlvt:'Enlèvement',liv_pose:'Liv+Pose',livraison:'Livraison'}[d.transport]||'—'}</span></td>
        <td style="font-size:12px;color:var(--ink-faint)">${fmt(d.dateLivraison)}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="printFeuilLivraison('${d.id}')"><i class="ti ti-printer"></i> Imprimer</button></td>
        <td><button class="btn btn-primary btn-sm" onclick="openModalCloture('${d.id}','dos')"><i class="ti ti-check"></i> Clôturer</button></td>
      </tr>`).join('')}</tbody>
    </table>
  </div>` : ''}`;
}

function getSortedEmballage() {
  const emb = dossiers.filter(d => d.statut === 'emballage').filter(matchesTypeFilter);
  const manualIds = emballageOrder.filter(id => emb.find(d => d.id === id));
  const unordered = emb.filter(d => !manualIds.includes(d.id));
  unordered.sort((a, b) => {
    const aUrg = a.autres && a.autres.toLowerCase().includes('urgent') ? 0 : 1;
    const bUrg = b.autres && b.autres.toLowerCase().includes('urgent') ? 0 : 1;
    if (aUrg !== bUrg) return aUrg - bUrg;
    return (a.dateLivraison||'9999') < (b.dateLivraison||'9999') ? -1 : 1;
  });
  return [...manualIds.map(id => emb.find(d => d.id === id)), ...unordered].filter(Boolean);
}

let emballageDragId = null;

function emballageDragStart(e, id) {
  emballageDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => { const el = document.getElementById('emballage-card-'+id); if(el) el.style.opacity = '0.4'; }, 0);
}
function emballageDragEnd(e, id) {
  const el = document.getElementById('emballage-card-'+id); if(el) el.style.opacity = '1';
  document.querySelectorAll('.emballage-grand-card').forEach(c => c.classList.remove('atelier-drag-over'));
}
function emballageDragOver(e, id) {
  e.preventDefault();
  if (id === emballageDragId) return;
  document.querySelectorAll('.emballage-grand-card').forEach(c => c.classList.remove('atelier-drag-over'));
  const el = document.getElementById('emballage-card-'+id); if(el) el.classList.add('atelier-drag-over');
}
function emballageDrop(e, id) {
  e.preventDefault();
  if (!emballageDragId || emballageDragId === id) return;
  const sorted = getSortedEmballage().map(d => d.id);
  const fromIdx = sorted.indexOf(emballageDragId);
  const toIdx   = sorted.indexOf(id);
  if (fromIdx === -1 || toIdx === -1) return;
  sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, emballageDragId);
  emballageOrder = sorted;
  document.querySelectorAll('.emballage-grand-card').forEach(c => c.classList.remove('atelier-drag-over'));
  renderEmballageGrand();
}

function renderEmballageGrand() {
  const mc = document.getElementById('main-content');
  const sorted = getSortedEmballage();

  if (!sorted.length) {
    mc.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">${typeFilterSelectHtml('renderEmballageGrand')}</div><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:420px;gap:18px">
      <div style="width:88px;height:88px;border-radius:50%;background:#FEF3C7;display:flex;align-items:center;justify-content:center"><i class="ti ti-package" style="font-size:44px;color:#92400E"></i></div>
      <div style="font-size:22px;color:var(--ink-soft);font-weight:600">Rien à emballer pour le moment</div>
      <div style="font-size:14px;color:var(--ink-faint)">Les dossiers prêts à emballer apparaîtront ici</div>
    </div>`;
    return;
  }

  mc.innerHTML = `
  <div id="toast-msg" class="toast-msg"></div>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div style="font-size:21px;font-weight:700;color:var(--ink);letter-spacing:-.2px">
      <i class="ti ti-package" style="vertical-align:-3px;margin-right:9px;color:#92400E"></i>
      ${sorted.length} commande${sorted.length>1?'s':''} à emballer
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      ${typeFilterSelectHtml('renderEmballageGrand')}
      <div style="font-size:14px;color:var(--ink-faint);text-transform:capitalize">${new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})}</div>
      ${emballageOrder.length>0?`<button class="btn btn-ghost btn-sm" onclick="emballageOrder=[];renderEmballageGrand()" title="Remettre le tri automatique"><i class="ti ti-refresh"></i> Réinitialiser ordre</button>`:''}
    </div>
  </div>
  <div style="font-size:12px;color:var(--ink-faint);margin-bottom:20px;display:flex;align-items:center;gap:6px">
    <i class="ti ti-drag-drop" style="font-size:13px"></i>
    ${emballageOrder.length>0
      ? `<span style="color:var(--accent);font-weight:600">Ordre manuel activé</span> — glissez les cartes pour réorganiser`
      : `Tri auto : <strong style="color:var(--red)">URGENT</strong> en tête, puis par date de livraison — glissez pour réorganiser`}
  </div>

  <div class="stagger" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:18px">
    ${sorted.map((d, idx) => {
      const urg = isUrgent(d);
      const pos = idx + 1;
      const posColor = pos===1 ? 'var(--red)' : pos===2 ? 'var(--amber)' : '#92400E';
      const posBg   = pos===1 ? 'var(--red-light)' : pos===2 ? 'var(--amber-light)' : '#FEF3C7';
      const manquants = d.history.filter(h => h.type==='commentaire' && h.action.includes('Manquant signalé'));
      const retard = d.dateLivraison && d.dateLivraison < new Date().toISOString().split('T')[0];
      const transportLabel = {enlvt:'Enlèvement client', liv_pose:'Livraison + Pose', livraison:'Livraison seule'}[d.transport]||d.transport;

      return `<div id="emballage-card-${d.id}" class="emballage-grand-card daily-card${urg?' is-urgent':''}"
        draggable="true"
        ondragstart="emballageDragStart(event,'${d.id}')"
        ondragend="emballageDragEnd(event,'${d.id}')"
        ondragover="emballageDragOver(event,'${d.id}')"
        ondrop="emballageDrop(event,'${d.id}')"
        style="cursor:grab;${urg?'border-color:#F09595;':''}position:relative">

        <div style="padding:15px 20px 13px;background:${urg?'var(--red-light)':'var(--bg)'};border-bottom:1px solid ${urg?'#F4CFCF':'var(--border)'}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px">
            <div style="display:flex;align-items:center;gap:9px">
              <span class="pos-badge" style="background:${posBg};color:${posColor};border:2px solid ${posColor}">${pos}</span>
              <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--ink-faint);font-weight:500">${d.id}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end">
              ${urg ? `<span style="background:var(--red);color:#fff;font-size:11px;font-weight:700;padding:3px 11px;border-radius:3px;box-shadow:var(--shadow-xs)"><i class="ti ti-alert-triangle" style="font-size:11px;vertical-align:-1px"></i> URGENT</span>` : ''}
              ${manquants.length > 0 ? `<span style="background:var(--red-light);color:var(--red);font-size:11px;font-weight:700;padding:3px 10px;border-radius:3px;border:1px solid #F09595"><i class="ti ti-alert-circle" style="font-size:11px;vertical-align:-1px"></i> ${manquants.length} manquant${manquants.length>1?'s':''}</span>` : ''}
              <i class="ti ti-grip-vertical drag-handle" title="Glisser pour réorganiser"></i>
            </div>
          </div>
          <div style="font-size:22px;font-weight:700;color:var(--ink);margin-bottom:2px;letter-spacing:-.3px">${d.client}</div>
          <div style="font-size:15px;color:var(--ink-soft);font-weight:500">${d.structure||'—'}</div>
        </div>

        <div style="padding:15px 20px">

          ${d.lames||d.pieds||d.alim||d.moteur ? `
          <div class="spec-grid" style="margin-bottom:13px">
            ${d.lames  ? `<div><div class="spec-k">Lames</div><div class="spec-v">${d.lames}</div></div>` : ''}
            ${d.pieds  ? `<div><div class="spec-k">Pieds</div><div class="spec-v">${d.pieds}</div></div>` : ''}
            ${d.alim   ? `<div><div class="spec-k">Alimentation</div><div class="spec-v">${d.alim}</div></div>` : ''}
            ${d.moteur ? `<div><div class="spec-k">Moteur</div><div class="spec-v">${d.moteur}</div></div>` : ''}
          </div>` : ''}

          ${d.options ? `
          <div style="margin-bottom:12px">
            <div class="spec-k" style="margin-bottom:5px">Options</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">
              ${d.options.split(',').map(o=>`<span class="opt-tag">${o.trim()}</span>`).join('')}
            </div>
          </div>` : ''}

          ${d.transport ? `
          <div style="margin-bottom:12px">
            <span style="background:#E0E7FF;color:#3730A3;padding:5px 13px;border-radius:3px;font-size:13px;font-weight:600;box-shadow:var(--shadow-xs);display:inline-flex;align-items:center;gap:5px">
              <i class="ti ti-truck" style="font-size:13px"></i>${transportLabel}
            </span>
          </div>` : ''}

          ${d.contraintes ? `
          <div style="background:var(--red-light);border:1px solid #F09595;border-radius:var(--radius);padding:9px 12px;margin-bottom:10px;font-size:13px;color:var(--red);font-weight:500">
            <i class="ti ti-alert-circle" style="font-size:13px;vertical-align:-2px;margin-right:5px"></i>${d.contraintes}
          </div>` : ''}

          ${d.autres ? `
          <div style="background:#FFFBEB;border:1px solid #FAC775;border-radius:var(--radius);padding:9px 12px;margin-bottom:10px;font-size:13px;color:#633806">
            <i class="ti ti-alert-triangle" style="font-size:13px;vertical-align:-2px;margin-right:5px"></i>${d.autres}
          </div>` : ''}

          ${manquants.length > 0 ? `
          <div style="background:var(--red-light);border:1px solid #F09595;border-radius:var(--radius);padding:9px 12px;margin-bottom:10px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--red);margin-bottom:4px">⚠ Manquant${manquants.length>1?'s':''} signalé${manquants.length>1?'s':''}</div>
            ${manquants.slice(-2).map(h=>`<div style="font-size:12px;color:var(--red)">${h.detail}</div>`).join('')}
          </div>` : ''}

          <div id="manquant-zone-grand-${d.id}"></div>

          <div style="font-size:13px;font-weight:500;color:${retard?'var(--red)':'var(--ink-faint)'};margin-bottom:14px">
            <i class="ti ti-calendar" style="font-size:12px;vertical-align:-1px"></i> ${fmt(d.dateLivraison)||'—'}
            ${retard ? `<span style="font-size:10px;font-weight:700;color:var(--red);margin-left:6px">EN RETARD</span>` : ''}
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:9px">
            <button class="btn btn-secondary" style="justify-content:center;font-size:13px;padding:9px" onclick="printFeuilLivraison('${d.id}')">
              <i class="ti ti-printer"></i> Feuille livraison
            </button>
            <button class="btn btn-ghost" style="justify-content:center;font-size:13px;padding:9px;color:var(--red);border-color:#F09595"
              onclick="signalerManquantGrand('${d.id}')">
              <i class="ti ti-alert-triangle"></i> Manquant
            </button>
          </div>
          <button class="btn btn-primary" onclick="avancerDosEmballageGrand('${d.id}')" style="width:100%;justify-content:center;font-size:15px;padding:11px 0">
            <i class="ti ti-archive"></i> Marquer stocké
          </button>

        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function signalerManquantGrand(id) {
  const zone = document.getElementById('manquant-zone-grand-'+id);
  if (!zone || zone.innerHTML.trim()) { zone.innerHTML = ''; return; }
  zone.innerHTML = `
    <div style="margin-bottom:10px;background:var(--red-light);border:1px solid #F09595;border-radius:var(--radius);padding:10px 12px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--red);margin-bottom:6px">Décrire ce qui manque</div>
      <textarea id="manquant-grand-input-${id}" placeholder="ex: télécommande manquante, lame abîmée..."
        style="width:100%;min-height:56px;border:1px solid #F09595;border-radius:3px;padding:7px 9px;font-size:13px;background:#fff;color:var(--ink);resize:vertical"></textarea>
      <div style="display:flex;gap:7px;margin-top:7px">
        <button class="btn btn-danger btn-sm" style="flex:1;justify-content:center" onclick="confirmerManquantGrand('${id}')">
          <i class="ti ti-alert-triangle"></i> Confirmer
        </button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('manquant-zone-grand-${id}').innerHTML=''">Annuler</button>
      </div>
    </div>`;
  setTimeout(() => document.getElementById('manquant-grand-input-'+id)?.focus(), 50);
}

function confirmerManquantGrand(id) {
  const d = dossiers.find(x => x.id === id);
  const el = document.getElementById('manquant-grand-input-'+id);
  if (!d || !el) return;
  const txt = el.value.trim();
  if (!txt) { el.focus(); return; }
  logHistory(id, 'commentaire', '⚠ Manquant signalé à l\'emballage', txt);
  pushNotif('commentaire', id, d, '⚠ MANQUANT : ' + txt);
  saveData();
  showToast('Manquant signalé — l\'admin a été notifié');
  renderEmballageGrand();
}

async function avancerDosEmballageGrand(id) {
  const d = dossiers.find(x => x.id === id);
  if (!d) return;
  // Passe par le point d'entrée unique de changement de statut (index.html) — sans effet
  // fonctionnel ici (emballage → stocké ne touche jamais 'verif') mais garantit qu'aucun
  // chemin ne reste hors de la fonction centrale (cf. mémoire projet).
  if (!(await changerStatutDossier(d, STATUT_NEXT[d.statut]))) return;
  saveData();
  showToast(`${d.client} — Stocké ✓`);
  renderEmballageGrand();
}
