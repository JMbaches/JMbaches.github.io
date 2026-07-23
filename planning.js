/* ================================================================
   PLANNING.JS — JM Bâches
   Module autonome pour le planning des poses (calendrier EDT interne
   + pont postMessage vers l'app planning.html en iframe + fenêtre
   planning séparée export/import JSON).
   Dépend de variables/fonctions globales définies dans index.html
   (dossiers, users, currentTab, saveData, showToast, logHistory, fmt,
   isUrgent, openFiche, _binomesConfig, getPoseurs, getSuiviLabel...)
   — fonctionne car tous les <script> classiques partagent le même
   scope lexical global du document (voir mémoire projet : piège
   let/window).
   ================================================================ */
// Un dossier envoyé au planning depuis la Saisie passe en statut "attente_planif" (voir
// envoyerAuPlanning() dans index.html) : il en ressort tout seul, de retour en Saisie (statut
// admin), dès qu'une date de pose lui est fixée — peu importe par quel mécanisme (EDT interne,
// Planning IA en iframe, import JSON). Appelé après CHAQUE affectation réelle de d.poseDate.
async function _retourSaisieSiPlanifie(d) {
  if (d.statut !== 'attente_planif' || !d.poseDate) return;
  await changerStatutDossier(d, 'admin', 'automatique après planification de la pose');
  showToast(`${d.client} revient en Saisie — pose planifiée le ${fmt(d.poseDate)}`);
}

/* ================================================================
   PLANNING EDT
   ================================================================ */
let edtWeekOffset = 0;   // 0 = semaine courante
let edtView = 'week';    // 'week' | 'month'
let edtDragDosId = null;

function getWeekDates(offset) {
  const now = new Date();
  const day = now.getDay() || 7; // lundi=1
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1 + offset * 7);
  monday.setHours(0,0,0,0);
  const days = [];
  for(let i=0;i<7;i++){
    const d = new Date(monday);
    d.setDate(monday.getDate()+i);
    days.push(d);
  }
  return days;
}

function toISODate(d) {
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function isToday(d) { return toISODate(d) === toISODate(new Date()); }

function edtCardHTML(d, opts={}) {
  const urgent = isUrgent(d);
  const cls = opts.unplanned ? 'edt-unplanned-card' : ('edt-card'+(urgent?' urgent':'')+(d.statut==='posé'?' pose':''));
  const dur = d.structure ? d.structure.match(/\(([^)]+)\)/)?.[1]||'' : '';
  return `<div class="${cls}" draggable="true"
    ondragstart="edtDragStart(event,'${d.id}')"
    ondragend="edtDragEnd(event)"
    onclick="openFiche('${d.id}')"
    title="${d.client} — ${d.structure||''}${d.contraintes?' · ⚠ '+d.contraintes:''}">
    <div class="edt-card-client">${d.client}</div>
    <div class="edt-card-sub">${d.structure||'—'}${dur?' · '+dur:''}</div>
    ${d.adresse?`<div class="edt-card-sub"><i class="ti ti-map-pin" style="font-size:10px"></i> ${d.ville||d.adresse}</div>`:''}
    ${urgent?`<div style="font-size:10px;color:var(--red);font-weight:600;margin-top:3px"><i class="ti ti-alert-triangle"></i> URGENT</div>`:''}
    <div class="edt-card-actions" onclick="event.stopPropagation()">
      ${!opts.unplanned&&d.poseDate?`<button class="btn btn-ghost btn-xs" onclick="clearPoseDateEdt('${d.id}')" title="Retirer du planning"><i class="ti ti-x"></i></button>`:''}
      <button class="btn btn-ghost btn-xs" onclick="openFiche('${d.id}')" title="Ouvrir le dossier"><i class="ti ti-external-link"></i></button>
    </div>
  </div>`;
}

/* ================================================================
   PLANNING IA — iframe vers planning.html + pont postMessage
   ================================================================ */

// Écoute en permanence les mises à jour de planning.html → Firebase
window.addEventListener('message', async (e) => {
  if (!e.data) return;
  if (e.data.type === 'JMBACH_READY') {
    // L'iframe vient de charger et signale qu'elle est prête : on envoie les dossiers
    const frame = document.getElementById('planning-ia-frame');
    if (frame) _envoyerDossiersPlanning(frame);
  }
  if (e.data.type === 'JMBACH_UPDATE') {
    const updates = e.data.updates || [];
    let changed = false;
    for (const upd of updates) {
      const d = dossiers.find(x => x.id === upd.externalId);
      if (!d) continue;
      const newDate     = upd.scheduledDate  || '';
      const newPoseurId = upd.scheduledBinome || '';
      // "valide" côté Planning IA = date confirmée par téléphone avec le client (bouton "Valider
      // avec le client (verrouiller)"), PAS juste une date proposée par l'optimiseur — jusqu'ici
      // ce statut était envoyé par l'iframe mais jamais lu ici, donc _retourSaisieSiPlanifie()
      // renvoyait le dossier à l'admin dès qu'une date était ne serait-ce que proposée. Corrigé :
      // on ne renvoie à l'admin QUE si le client a réellement validé.
      const newValideClient = upd.status === 'valide';
      if (d.poseDate  !== newDate)     { d.poseDate  = newDate;     changed = true; }
      if (d.poseurId  !== newPoseurId) { d.poseurId  = newPoseurId; changed = true; }
      if (d.poseValideClient !== newValideClient) { d.poseValideClient = newValideClient; changed = true; }
      if (newValideClient) await _retourSaisieSiPlanifie(d);
    }
    if (changed) { saveData(); showToast('✓ Planning synchronisé avec Firebase'); }
  }
});

function _envoyerDossiersPlanning(frame) {
  if (!frame || !frame.contentWindow) return;
  const liste = dossiersScope().filter(d => d.transport === 'liv_pose' || d.needPose);
  const chantiers = liste.map(d => ({
    id:               d.id,
    externalId:       d.id,
    clientName:       d.client       || '',
    clientPhone:      d.tel          || '',
    clientEmail:      d.email        || '',
    address:          d.adresse      || '',
    city:             d.ville        || '',
    postalCode:       d.cp           || '',
    type:             d.structure    || '',
    dimensions:       [d.largeur && `L:${d.largeur}m`, d.longueur && `l:${d.longueur}m`].filter(Boolean).join(' · '),
    constraints:      [d.contraintes, d.autres].filter(Boolean).join(' — '),
    notes:            d.remarques    || '',
    estimatedDuration: 2.5,
    materials:        [],
    weatherSensitive: true,
    status:           d.poseDate ? 'planifie' : 'a_planifier',
    scheduledDate:    d.poseDate     || '',
    scheduledBinome:  d.poseurId     || '',
    fixedTime:        '',
    notBefore:        d.dateFrom     || '',
    notAfter:         d.dateLivraison|| '',
    linkId: '', linkRole: 0, linkGap: 0, archived: false,
  }));
  const binomes = _binomesConfig.length > 0
    ? _binomesConfig.map(b => {
        const memberNames = (b.memberIds || []).map(id => {
          const u = users.find(x => x.id === id);
          return u ? (u.name || u.email) : '';
        }).filter(Boolean);
        return {
          id:      b.id,
          name:    b.name,
          members: memberNames,
          color:   '#1B5FCC',
          phone:   '',
          email:   '',
        };
      })
    : getPoseurs().map(u => ({
        id:      u.id,
        name:    u.name || u.email || u.id,
        members: [u.name || u.email || ''],
        color:   '#1B5FCC',
        phone:   u.tel   || '',
        email:   u.email || '',
      }));
  frame.contentWindow.postMessage({ type: 'JMBACH_INIT', dossiers: chantiers, binomes }, '*');
  // Mettre à jour la barre de statut
  const bar = document.getElementById('planning-sync-bar');
  if (bar) {
    const t = new Date().toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
    bar.innerHTML = `<i class="ti ti-circle-check" style="color:var(--green)"></i> ${liste.length} dossier${liste.length>1?'s':''} envoyé${liste.length>1?'s':''} · ${t}
      <button onclick="syncPlanningMaintenant()" style="margin-left:12px;padding:3px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--paper);font-size:12px;cursor:pointer"><i class="ti ti-upload"></i> Envoyer dossiers</button>
      <button onclick="recupererPlanningIA()" style="margin-left:6px;padding:3px 10px;border:1px solid var(--accent);border-radius:var(--radius-sm);background:var(--accent-light);color:var(--accent-deep);font-size:12px;cursor:pointer;font-weight:600"><i class="ti ti-download"></i> Récupérer le planning</button>`;
  }
}

function syncPlanningMaintenant() {
  const frame = document.getElementById('planning-ia-frame');
  if (frame) _envoyerDossiersPlanning(frame);
}

function recupererPlanningIA() {
  const frame = document.getElementById('planning-ia-frame');
  if (!frame || !frame.contentWindow) { showToast('⚠ Ouvrez d\'abord l\'onglet Planning IA'); return; }
  frame.contentWindow.postMessage({ type: 'JMBACH_REQUEST_UPDATE' }, '*');
  showToast('⟳ Récupération du planning en cours…');
}

function renderPlanningAvance() {
  const mc = document.getElementById('main-content');
  mc.style.padding = '0';
  const liste = dossiersScope().filter(d => d.transport === 'liv_pose' || d.needPose);
  mc.innerHTML = `
    <div id="planning-sync-bar" style="display:flex;align-items:center;gap:8px;padding:6px 16px;background:var(--surface);border-bottom:1px solid var(--border);font-size:12px;color:var(--ink-soft)">
      <i class="ti ti-loader" style="animation:spin .8s linear infinite"></i> Connexion à l'app planning…
    </div>
    <iframe id="planning-ia-frame" src="planning.html?embedded=1"
      style="width:100%;height:calc(100vh - 140px);border:none;display:block"
      allow="clipboard-write; geolocation"></iframe>`;

  const frame = document.getElementById('planning-ia-frame');
  frame.addEventListener('load', () => {
    // Double tentative : 500ms et 1500ms (cache vs premier chargement)
    setTimeout(() => _envoyerDossiersPlanning(frame), 500);
    setTimeout(() => _envoyerDossiersPlanning(frame), 1500);
  });
}

// Auto-sync quand Firestore met à jour les dossiers et que l'onglet Planning IA est actif
function _planningAvanceAutoSync() {
  if (currentTab !== 'planning_avance') return;
  const frame = document.getElementById('planning-ia-frame');
  if (frame && frame.contentWindow) _envoyerDossiersPlanning(frame);
}

function renderPlanning() {
  const mc = document.getElementById('main-content');
  const dossiersP = dossiersScope();
  const aPlaner = dossiersP.filter(d => (d.needPose || d.transport === 'liv_pose') && !d.poseDate);
  const planifies = dossiersP.filter(d => (d.needPose || d.transport === 'liv_pose') && d.poseDate);
  // "Validé client" = date confirmée par téléphone dans Planning IA (bouton "Valider avec le
  // client"), pas juste proposée — seuls ceux-là font revenir le dossier en Saisie admin (cf.
  // JMBACH_UPDATE plus haut). Distingués ici pour que la personne au planning sache qui appeler.
  const enAttenteValidation = planifies.filter(d => !d.poseValideClient);

  mc.innerHTML = `
  <div class="edt-toolbar">
    <div>
      <div class="section-title">Planning des poses</div>
      <div style="font-size:12px;color:var(--ink-faint);margin-top:2px">${aPlaner.length} à planifier · ${planifies.length} planifié${planifies.length>1?'s':''}${enAttenteValidation.length?` · <span style="color:var(--amber,#B45309);font-weight:600">${enAttenteValidation.length} en attente de validation client</span>`:''}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div class="edt-views">
        <button class="edt-view-btn ${edtView==='week'?'active':''}" onclick="setEdtView('week')"><i class="ti ti-layout-columns"></i> Semaine</button>
        <button class="edt-view-btn ${edtView==='month'?'active':''}" onclick="setEdtView('month')"><i class="ti ti-calendar-month"></i> Mois</button>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="importerPlanning()"><i class="ti ti-upload"></i> Importer</button>
      <button class="btn btn-primary btn-sm" onclick="exporterPourPlanning()"><i class="ti ti-download"></i> Exporter</button>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 220px;gap:14px;align-items:start">
    <div id="edt-main"></div>
    <div class="edt-sidebar">
      <div class="edt-unplanned">
        <div class="edt-unplanned-title"><i class="ti ti-clock"></i> À planifier (${aPlaner.length})</div>
        ${aPlaner.length===0
          ? `<div style="font-size:12px;color:var(--ink-faint);text-align:center;padding:10px 0">Aucun dossier en attente</div>`
          : aPlaner.map(d=>edtCardHTML(d,{unplanned:true})).join('')}
      </div>
      <div class="edt-unplanned">
        <div class="edt-unplanned-title" style="color:var(--green)"><i class="ti ti-check"></i> Planifiés (${planifies.length})</div>
        ${planifies.length===0
          ? `<div style="font-size:12px;color:var(--ink-faint);text-align:center;padding:10px 0">Aucun</div>`
          : planifies.map(d=>`<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="openFiche('${d.id}')">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-weight:500">${d.client}</span>
                <span style="color:var(--ink-faint)">${fmt(d.poseDate)}</span>
              </div>
              <div style="margin-top:1px">${d.poseValideClient
                ? `<span style="font-size:10px;color:var(--green);font-weight:600"><i class="ti ti-circle-check" style="font-size:10px"></i> Validé client</span>`
                : `<span style="font-size:10px;color:var(--amber,#B45309);font-weight:600"><i class="ti ti-phone" style="font-size:10px"></i> En attente de validation client</span>`}</div>
            </div>`).join('')}
      </div>
    </div>
  </div>`;

  renderEdtMain();
}

function renderEdtMain() {
  const container = document.getElementById('edt-main');
  if(!container) return;
  if(edtView==='week') renderEdtWeek(container);
  else renderEdtMonth(container);
}

function renderEdtWeek(container) {
  const dossiersEdt = dossiersScope();
  const days = getWeekDates(edtWeekOffset);
  const JOURS = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
  const moisLabel = days[0].toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
  const semDebut = days[0].toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
  const semFin = days[6].toLocaleDateString('fr-FR',{day:'numeric',month:'short'});

  const cols = days.map((d,i) => {
    const iso = toISODate(d);
    const dosJour = dossiersEdt.filter(x => (x.needPose || x.transport === 'liv_pose') && x.poseDate === iso);
    const todayCls = isToday(d) ? ' today' : '';
    return `
      <div class="edt-head-cell${todayCls}">
        <span>${JOURS[i]}</span>
        <span class="day-num">${d.getDate()}</span>
        <span style="font-size:10px;color:var(--ink-faint)">${d.toLocaleDateString('fr-FR',{month:'short'})}</span>
      </div>`;
  }).join('');

  const cells = days.map(d => {
    const iso = toISODate(d);
    const dosJour = dossiersEdt.filter(x => (x.needPose || x.transport === 'liv_pose') && x.poseDate === iso);
    const todayCls = isToday(d) ? ' today' : '';
    return `
      <div class="edt-col${todayCls}" id="edtcol-${iso}"
        ondragover="event.preventDefault();this.classList.add('dragover')"
        ondragleave="this.classList.remove('dragover')"
        ondrop="edtDrop(event,'${iso}')">
        ${dosJour.length===0
          ? `<div class="edt-empty">—</div>`
          : dosJour.map(d=>edtCardHTML(d)).join('')}
      </div>`;
  }).join('');

  container.innerHTML = `
  <div class="edt-nav" style="margin-bottom:10px;display:flex;align-items:center;gap:8px">
    <button class="btn btn-ghost btn-sm" onclick="edtWeekOffset--;renderEdtMain()"><i class="ti ti-chevron-left"></i></button>
    <span class="edt-week-label">${semDebut} – ${semFin} ${days[0].getFullYear()}</span>
    <button class="btn btn-ghost btn-sm" onclick="edtWeekOffset++;renderEdtMain()"><i class="ti ti-chevron-right"></i></button>
    <button class="btn btn-ghost btn-sm" onclick="edtWeekOffset=0;renderEdtMain()">Aujourd'hui</button>
  </div>
  <div class="edt-calendar">
    <div class="edt-head" style="grid-template-columns:repeat(7,1fr)">${cols}</div>
    <div class="edt-body" style="grid-template-columns:repeat(7,1fr)">${cells}</div>
    <div class="edt-legend">
      <span><span class="edt-legend-dot" style="background:var(--accent-light);border:1px solid #C3D8EF;border-left:3px solid var(--accent)"></span>Pose prévue</span>
      <span><span class="edt-legend-dot" style="background:var(--red-light);border-left:3px solid var(--red)"></span>Urgent</span>
      <span><span class="edt-legend-dot" style="background:var(--green-light);border-left:3px solid var(--green)"></span>Posé</span>
      <span style="margin-left:auto;font-style:italic">Glisser-déposer pour planifier</span>
    </div>
  </div>`;
}

function renderEdtMonth(container) {
  const dossiersEdt = dossiersScope();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + edtWeekOffset; // on réutilise edtWeekOffset pour le mois
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month+1, 0);
  const JOURS = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
  const moisLabel = firstDay.toLocaleDateString('fr-FR',{month:'long',year:'numeric'});

  // Remplir la grille (commence lundi)
  let startDow = firstDay.getDay() || 7; // 1=lun
  const cells = [];
  // jours du mois précédent
  for(let i=1;i<startDow;i++){
    const d = new Date(firstDay); d.setDate(d.getDate()-(startDow-i));
    cells.push({date:d,other:true});
  }
  for(let i=1;i<=lastDay.getDate();i++) cells.push({date:new Date(year,month,i),other:false});
  // compléter à 42 cases
  while(cells.length<42){ const last=cells[cells.length-1].date; const d=new Date(last); d.setDate(d.getDate()+1); cells.push({date:d,other:true}); }

  const heads = JOURS.map(j=>`<div class="edt-month-head">${j}</div>`).join('');
  const dayCells = cells.map(({date,other})=>{
    const iso = toISODate(date);
    const dosJour = dossiersEdt.filter(x=>x.needPose&&x.poseDate===iso);
    const todayCls = isToday(date)?' today':'';
    const otherCls = other?' other-month':'';
    return `<div class="edt-month-day${todayCls}${otherCls}"
      ondragover="event.preventDefault()"
      ondrop="edtDrop(event,'${iso}')">
      <div class="edt-month-day-num">${date.getDate()}</div>
      ${dosJour.map(d=>`<div class="edt-card" style="margin-bottom:3px;padding:3px 6px;font-size:11px;cursor:pointer" onclick="openFiche('${d.id}')" title="${d.client}">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.client}</div>
      </div>`).join('')}
    </div>`;
  }).join('');

  container.innerHTML = `
  <div class="edt-nav" style="margin-bottom:10px;display:flex;align-items:center;gap:8px">
    <button class="btn btn-ghost btn-sm" onclick="edtWeekOffset--;renderEdtMain()"><i class="ti ti-chevron-left"></i></button>
    <span class="edt-week-label">${moisLabel.charAt(0).toUpperCase()+moisLabel.slice(1)}</span>
    <button class="btn btn-ghost btn-sm" onclick="edtWeekOffset++;renderEdtMain()"><i class="ti ti-chevron-right"></i></button>
    <button class="btn btn-ghost btn-sm" onclick="edtWeekOffset=0;renderEdtMain()">Aujourd'hui</button>
  </div>
  <div class="edt-month">${heads}${dayCells}</div>`;
}

function setEdtView(v) { edtView=v; edtWeekOffset=0; renderEdtMain(); }

function edtDragStart(e, dosId) {
  edtDragDosId = dosId;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.style.opacity = '0.5';
}
function edtDragEnd(e) { e.currentTarget.style.opacity = '1'; }

async function edtDrop(e, isoDate) {
  e.preventDefault();
  document.querySelectorAll('.edt-col').forEach(el=>el.classList.remove('dragover'));
  if(!edtDragDosId) return;
  const d = dossiers.find(x=>x.id===edtDragDosId);
  if(!d) return;
  d.poseDate = isoDate;
  // Assignation directe (glisser-déposer humain) = considérée confirmée d'emblée, pas une simple
  // proposition en attente d'appel client — pas de statut "valide" séparé pour ce mécanisme,
  // contrairement à Planning IA (JMBACH_UPDATE plus haut).
  d.poseValideClient = true;
  logHistory(d.id,'modification','Date de pose planifiée','Pose le '+fmt(isoDate));
  await _retourSaisieSiPlanifie(d);
  saveData();
  edtDragDosId = null;
  renderPlanning();
  showToast('✓ '+d.client+' planifié le '+fmt(isoDate));
}

function clearPoseDateEdt(dosId) {
  const d = dossiers.find(x=>x.id===dosId);
  if(!d) return;
  d.poseDate = '';
  logHistory(dosId,'modification','Date de pose retirée','');
  saveData();
  renderPlanning();
}

async function setPoseAndRefresh(dosId, val) {
  const d = dossiers.find(x=>x.id===dosId);
  if(!d) return;
  d.poseDate = val;
  d.poseValideClient = true; // assignation directe = confirmée d'emblée, voir edtDrop() ci-dessus
  logHistory(dosId,'modification','Date de pose définie','Pose le '+fmt(val));
  await _retourSaisieSiPlanifie(d);
  saveData();
  renderPlanning();
}
function clearPoseDate(dosId) { clearPoseDateEdt(dosId); }

let _planningWindow = null;

function openPlanningApp() {
  alert('Pour ouvrir l\'app planning, ouvrez le fichier jm_baches_app5_6-3.html dans un autre onglet.\n\nPour synchroniser les dates de pose, utilisez les boutons Exporter / Importer.');
}

function ouvrirAppPlanning() {
  if(_planningWindow && !_planningWindow.closed) {
    _planningWindow.focus();
    return;
  }
  const el = document.getElementById('planning-data');
  if(!el) { alert('App planning introuvable.'); return; }
  try {
    const b64 = el.getAttribute('data-content');
    const html = decodeURIComponent(escape(atob(b64)));
    const blob = new Blob([html], {type: 'text/html'});
    const url = URL.createObjectURL(blob);
    _planningWindow = window.open(url, 'jmb_planning', 'width=1400,height=900,resizable=yes,scrollbars=yes');
  } catch(e) {
    alert('Erreur ouverture planning : ' + e.message);
  }
}

function exporterPourPlanning() {
  const chantiers = dossiersScope().filter(d=>d.needPose).map(d=>({
    id: d.id,
    client: d.client,
    adresse: [d.adresse, d.cp, d.ville].filter(Boolean).join(', '),
    tel: d.tel||'',
    structure: d.structure||'',
    dateFrom: d.dateFrom||'',
    dateTo: d.dateTo||'',
    dateLivraison: d.dateLivraison||'',
    remarques: d.remarques||'',
    autres: d.autres||'',
    poseDate: d.poseDate||'',
    statut: d.statut,
  }));
  const data = { version:'JMB_EXPORT_V1', exportedAt: now(), chantiers };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'planning-jmbaches-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('✓ ' + chantiers.length + ' dossier(s) exportés');
}

function importerPlanning() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = e => {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const raw = JSON.parse(ev.target.result);
        // Accepte les deux formats : ancien (JMB_IMPORT_V1 string) et nouveau (objet JSON)
        let items = [];
        if(Array.isArray(raw)) items = raw;
        else if(raw.chantiers) items = raw.chantiers;
        else { alert('Format de fichier invalide.'); return; }
        let updated = 0;
        for (const item of items) {
          const d = dossiers.find(x=>x.id===item.id);
          // Le fichier importé peut référencer n'importe quel dossier (export fait par un autre
          // compte) — on ignore silencieusement ceux hors du périmètre du compte qui importe,
          // plutôt que de les appliquer sans que l'utilisateur les ait jamais vus.
          if(d && !dossierDansPerimetre(d)) continue;
          if(d && item.poseDate) {
            d.poseDate = item.poseDate;
            d.poseValideClient = true; // import manuel = confirmé d'emblée, voir edtDrop() plus haut
            logHistory(d.id, 'modification', 'Date de pose importée', 'Pose le ' + fmt(item.poseDate));
            await _retourSaisieSiPlanifie(d);
            updated++;
          }
        }
        saveData();
        showToast('✓ ' + updated + ' date(s) de pose importée(s)');
        renderPlanning();
      } catch(err) {
        alert('Erreur lors de la lecture du fichier. Vérifiez qu\'il s\'agit bien d\'un fichier export JM Bâches.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}
