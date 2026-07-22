/* ================================================================
   ATELIER.JS — JM Bâches
   Module autonome pour l'onglet Atelier (liste + grand écran, vue
   fabrication détaillée, checklist de vérification avant expédition).
   Dépend de variables/fonctions globales définies dans index.html
   (dossiers, currentTab, atelierOrder, VERIF_ROWS, VERIF_EXP, can,
   logHistory, saveData, showToast, fmt, isUrgent, tempsStatut,
   tempsStatutColor, filteredDossiers, avancerDos, openModal, closeModal)
   — fonctionne car tous les <script> classiques partagent le même
   scope lexical global du document (voir mémoire projet : piège
   let/window).
   ================================================================ */
function renderAtelier() {
  const prod=filteredDossiers(dossiers.filter(d=>d.statut==='production')).filter(matchesTypeFilter);
  const mc=document.getElementById('main-content');
  const header=`<div class="section-header"><div class="section-title">Commandes à fabriquer</div><div style="display:flex;align-items:center;gap:10px">${typeFilterSelectHtml('renderAtelier')}<span style="font-size:13px;color:var(--ink-faint)">${prod.length} en cours</span></div></div>`;
  if(!prod.length){mc.innerHTML=header+`<div class="empty-state"><i class="ti ti-tools"></i>Aucune commande en production pour le moment</div>`;return;}
  mc.innerHTML=`${header}
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">
    ${prod.map(d=>{
      const urg=isUrgent(d);
      return `<div class="card" style="${urg?'border-left:3px solid var(--red);':''}">
        <div style="padding:12px 14px">
          <div style="font-size:11px;color:var(--ink-faint);margin-bottom:3px;font-family:'JetBrains Mono',monospace">${d.id}${urg?' <span style="color:var(--red);font-weight:600">URGENT</span>':''}</div>
          <div style="font-size:15px;font-weight:600;margin-bottom:4px">${d.client}</div>
          <div style="font-size:13px;color:var(--ink-soft);margin-bottom:4px">${d.structure||'—'}</div>
          ${(()=>{const t=tempsStatut(d);return t?`<div style="font-size:11px;color:${tempsStatutColor(d)};margin-bottom:6px;display:flex;align-items:center;gap:3px"><i class="ti ti-clock" style="font-size:11px"></i> En production depuis ${t}</div>`:''})()}
          ${d.options?`<div style="font-size:12px;color:var(--ink-faint);margin-bottom:8px">${d.options}</div>`:''}
          ${d.remarques?`<div style="font-size:12px;background:var(--bg);padding:7px 10px;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:8px">${d.remarques}</div>`:''}
          ${d.autres?`<div style="font-size:12px;color:var(--red);background:var(--red-light);padding:7px 10px;border-radius:var(--radius);border:1px solid #F09595;margin-bottom:8px">${d.autres}</div>`:''}
          ${getFicheFabrication(d)?`<div style="display:flex;align-items:center;gap:8px;background:#E1F5EE;border:1px solid #A7F3D0;border-radius:var(--radius);padding:7px 10px;margin-bottom:8px;cursor:pointer" onclick="voirFicheTechnique('${d.id}')">
            <i class="ti ti-file-type-pdf" style="color:#E53E3E;font-size:16px"></i>
            <span style="font-size:12px;font-weight:600;color:#085041;flex:1">Fiche de fabrication disponible</span>
            <i class="ti ti-eye" style="font-size:13px;color:#085041"></i>
          </div>`:`<div style="display:flex;align-items:center;gap:8px;background:#FEF3C7;border:1px solid #FCD34D;border-radius:var(--radius);padding:7px 10px;margin-bottom:8px">
            <i class="ti ti-clock" style="color:#92400E;font-size:14px"></i>
            <span style="font-size:12px;color:#92400E">Fiche de fabrication en attente</span>
          </div>`}
          <div style="display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border)">
            <span style="font-size:12px;color:var(--ink-faint)"><i class="ti ti-calendar" style="font-size:12px;vertical-align:-1px"></i> ${fmt(d.dateLivraison)}${d.dateFab?` <span style="color:var(--teal);font-weight:600" title="Semaine de fabrication souhaitée">· Sem. ${numeroSemaineISO(new Date(d.dateFab+'T00:00:00'))}</span>`:''}</span>
            <div style="display:flex;gap:6px">
              <button class="btn btn-ghost btn-sm" onclick="openVueFab('${d.id}')"><i class="ti ti-eye"></i> Voir</button>
              ${can('adv_prod')?`<button class="btn btn-secondary btn-sm" onclick="avancerDos('${d.id}',event)"><i class="ti ti-check"></i> Fabriqué</button>`:''}
            </div>
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}
function getSortedProd() {
  const prod = filteredDossiers(dossiers.filter(d => d.statut === 'production')).filter(matchesTypeFilter);
  // Appliquer l'ordre manuel si existant, sinon tri auto : URGENT > date livraison
  const manualIds = atelierOrder.filter(id => prod.find(d => d.id === id));
  const unordered = prod.filter(d => !manualIds.includes(d.id));
  // Tri auto : urgent d'abord, puis date de fabrication souhaitée (fixée en Saisie pour
  // prioriser un dossier) si renseignée, sinon repli sur la date de livraison comme avant.
  unordered.sort((a, b) => {
    const aUrg = isUrgent(a) ? 0 : 1;
    const bUrg = isUrgent(b) ? 0 : 1;
    if (aUrg !== bUrg) return aUrg - bUrg;
    const aDate = a.dateFab || a.dateLivraison || '9999';
    const bDate = b.dateFab || b.dateLivraison || '9999';
    return aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
  });
  // Reconstruire : manuels en tête dans leur ordre, puis auto-triés
  return [
    ...manualIds.map(id => prod.find(d => d.id === id)),
    ...unordered
  ].filter(Boolean);
}

let atelierDragId = null;
let atelierDragOverId = null;

function atelierDragStart(e, id) {
  atelierDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => { const el = document.getElementById('atelier-card-'+id); if(el) el.style.opacity = '0.4'; }, 0);
}
function atelierDragEnd(e, id) {
  const el = document.getElementById('atelier-card-'+id); if(el) el.style.opacity = '1';
  document.querySelectorAll('.atelier-card').forEach(c => c.classList.remove('atelier-drag-over'));
}
function atelierDragOver(e, id) {
  e.preventDefault();
  if (id === atelierDragId) return;
  document.querySelectorAll('.atelier-card').forEach(c => c.classList.remove('atelier-drag-over'));
  const el = document.getElementById('atelier-card-'+id); if(el) el.classList.add('atelier-drag-over');
  atelierDragOverId = id;
}
function atelierDrop(e, id) {
  e.preventDefault();
  if (!atelierDragId || atelierDragId === id) return;
  const sorted = getSortedProd().map(d => d.id);
  const fromIdx = sorted.indexOf(atelierDragId);
  const toIdx = sorted.indexOf(id);
  if (fromIdx === -1 || toIdx === -1) return;
  sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, atelierDragId);
  atelierOrder = sorted;
  document.querySelectorAll('.atelier-card').forEach(c => c.classList.remove('atelier-drag-over'));
  renderAtelierGrand();
}

function renderAtelierGrand() {
  const sorted = getSortedProd();
  const mc = document.getElementById('main-content');
  if (!sorted.length) {
    mc.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">${typeFilterSelectHtml('renderAtelierGrand')}</div><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:420px;gap:18px"><div style="width:88px;height:88px;border-radius:50%;background:var(--green-light);display:flex;align-items:center;justify-content:center"><i class="ti ti-mood-happy" style="font-size:44px;color:var(--green)"></i></div><div style="font-size:22px;color:var(--ink-soft);font-weight:600">Rien à fabriquer pour le moment</div><div style="font-size:14px;color:var(--ink-faint)">Les commandes en production apparaîtront ici</div></div>`;
    return;
  }
  mc.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div style="font-size:21px;font-weight:700;color:var(--ink);letter-spacing:-.2px"><i class="ti ti-tool" style="vertical-align:-3px;margin-right:9px;color:var(--accent)"></i>${sorted.length} commande${sorted.length>1?'s':''} en production</div>
    <div style="display:flex;align-items:center;gap:12px">
      ${typeFilterSelectHtml('renderAtelierGrand')}
      <div style="font-size:14px;color:var(--ink-faint);text-transform:capitalize">${new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})}</div>
      ${atelierOrder.length>0?`<button class="btn btn-ghost btn-sm" onclick="atelierOrder=[];renderAtelierGrand()" title="Remettre le tri automatique"><i class="ti ti-refresh"></i> Réinitialiser ordre</button>`:''}
    </div>
  </div>
  <div style="font-size:12px;color:var(--ink-faint);margin-bottom:20px;display:flex;align-items:center;gap:6px">
    <i class="ti ti-drag-drop" style="font-size:13px"></i>
    ${atelierOrder.length>0
      ? `<span style="color:var(--accent);font-weight:600">Ordre manuel activé</span> — glissez les cartes pour réorganiser`
      : `Tri auto : <strong style="color:var(--red)">URGENT</strong> en tête, puis par date de livraison — glissez pour réorganiser`}
  </div>
  <div class="stagger" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:18px">
    ${sorted.map((d, idx) => {
      const urg = isUrgent(d);
      const chk = d.pages?.find(p => p.type==='verif')?.checks || {};
      const rows = d.pages?.find(p => p.type==='verif')?.rows || VERIF_ROWS;
      const done = Object.values(chk).filter(c => c.oui).length;
      const total = rows.length + VERIF_EXP.length;
      const pct = total > 0 ? Math.round(done/total*100) : 0;
      const pos = idx + 1;
      const posColor = pos===1 ? 'var(--red)' : pos===2 ? 'var(--amber)' : 'var(--ink-faint)';
      const posBg = pos===1 ? 'var(--red-light)' : pos===2 ? 'var(--amber-light)' : 'var(--bg)';
      const retard = d.dateLivraison && d.dateLivraison < new Date().toISOString().split('T')[0];
      const barColor = pct===100?'var(--green)':pct>50?'var(--amber)':'var(--accent)';
      return `<div id="atelier-card-${d.id}" class="atelier-card daily-card${urg?' is-urgent':''}"
        draggable="true"
        ondragstart="atelierDragStart(event,'${d.id}')"
        ondragend="atelierDragEnd(event,'${d.id}')"
        ondragover="atelierDragOver(event,'${d.id}')"
        ondrop="atelierDrop(event,'${d.id}')"
        style="cursor:grab${urg?';border-color:#F09595':''}">
        <div style="padding:15px 18px 13px;background:${urg?'var(--red-light)':'var(--bg)'};border-bottom:1px solid ${urg?'#F4CFCF':'var(--border)'}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px">
            <div style="display:flex;align-items:center;gap:9px">
              <span class="pos-badge" style="background:${posBg};color:${posColor};border:2px solid ${posColor}">${pos}</span>
              <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--ink-faint);font-weight:500">${d.id}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              ${urg?`<span style="background:var(--red);color:#fff;font-size:11px;font-weight:700;padding:3px 11px;border-radius:3px;box-shadow:var(--shadow-xs)"><i class="ti ti-alert-triangle" style="font-size:11px;vertical-align:-1px"></i> URGENT</span>`:''}
              <i class="ti ti-grip-vertical drag-handle" title="Glisser pour réorganiser"></i>
            </div>
          </div>
          <div style="font-size:22px;font-weight:700;color:var(--ink);margin-bottom:2px;letter-spacing:-.3px">${d.client}</div>
          <div style="font-size:15px;color:var(--ink-soft);font-weight:500;margin-bottom:4px">${d.structure||'&#8212;'}</div>
          ${(()=>{const t=tempsStatut(d);return t?`<div style="font-size:12px;color:${tempsStatutColor(d)};display:flex;align-items:center;gap:4px"><i class="ti ti-clock" style="font-size:12px"></i> En production depuis ${t}</div>`:''})()}
        </div>
        <div style="padding:15px 18px">
          ${d.lames||d.pieds||d.alim||d.moteur?`<div class="spec-grid" style="margin-bottom:13px">
            ${d.lames?`<div><div class="spec-k">Lames</div><div class="spec-v">${d.lames}</div></div>`:''}
            ${d.pieds?`<div><div class="spec-k">Pieds</div><div class="spec-v">${d.pieds}</div></div>`:''}
            ${d.alim?`<div><div class="spec-k">Alimentation</div><div class="spec-v">${d.alim}</div></div>`:''}
            ${d.moteur?`<div><div class="spec-k">Moteur</div><div class="spec-v">${d.moteur}</div></div>`:''}
          </div>`:''}
          ${d.options?`<div style="margin-bottom:11px"><div class="spec-k" style="margin-bottom:5px">Options</div><div style="display:flex;flex-wrap:wrap;gap:4px">${d.options.split(',').map(o=>`<span class="opt-tag">${o.trim()}</span>`).join('')}</div></div>`:''}
          ${d.remarques?`<div style="background:#FFFBEB;border:1px solid #FAC775;border-radius:var(--radius);padding:9px 12px;margin-bottom:9px;font-size:13px;color:#633806"><i class="ti ti-alert-triangle" style="font-size:13px;vertical-align:-2px;margin-right:5px"></i>${d.remarques}</div>`:''}
          ${d.autres?`<div style="background:var(--red-light);border:1px solid #F09595;border-radius:var(--radius);padding:9px 12px;margin-bottom:9px;font-size:13px;color:var(--red);font-weight:500"><i class="ti ti-alert-circle" style="font-size:13px;vertical-align:-2px;margin-right:5px"></i>${d.autres}</div>`:''}
          ${getFicheFabrication(d)
            ? `<div style="display:flex;align-items:center;gap:8px;background:#E1F5EE;border:1px solid #A7F3D0;border-radius:var(--radius);padding:9px 12px;margin-bottom:9px;cursor:pointer" onclick="voirFicheTechnique('${d.id}')">
                <i class="ti ti-file-type-pdf" style="color:#E53E3E;font-size:18px"></i>
                <span style="font-size:13px;font-weight:600;color:#085041;flex:1">Fiche de fabrication disponible</span>
                <i class="ti ti-eye" style="font-size:14px;color:#085041"></i>
               </div>`
            : `<div style="display:flex;align-items:center;gap:8px;background:#FEF3C7;border:1px solid #FCD34D;border-radius:var(--radius);padding:9px 12px;margin-bottom:9px">
                <i class="ti ti-clock" style="color:#92400E;font-size:16px"></i>
                <span style="font-size:13px;color:#92400E">Fiche de fabrication en attente</span>
               </div>`}
          <div style="margin-bottom:13px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span style="font-size:11px;color:var(--ink-faint);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Avancement vérification</span>
              <span style="font-size:12px;font-weight:700;font-family:'JetBrains Mono',monospace;color:${pct===100?'var(--green)':pct>0?'var(--amber)':'var(--ink-faint)'}">${done}/${total}</span>
            </div>
            <div class="daily-progress"><div style="width:${pct}%;background:${barColor}"></div></div>
          </div>
          <div style="margin-bottom:10px">
            <button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center;font-size:12px;color:var(--ink-soft)" onclick="toggleNoteRapide('${d.id}')">
              <i class="ti ti-message-plus"></i> Ajouter une note
            </button>
            <div id="note-rapide-${d.id}" style="display:none;margin-top:7px">
              <textarea id="note-input-${d.id}" placeholder="Note rapide — visible dans l'historique du dossier…" style="width:100%;min-height:54px;resize:vertical;padding:7px 9px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius);background:var(--paper);color:var(--ink);outline:none"></textarea>
              <div style="display:flex;gap:6px;margin-top:5px">
                <button class="btn btn-secondary btn-sm" style="flex:1;justify-content:center" onclick="addNoteRapide('${d.id}')"><i class="ti ti-send"></i> Envoyer</button>
                <button class="btn btn-ghost btn-sm" onclick="toggleNoteRapide('${d.id}')">Annuler</button>
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px">
            <span style="font-size:13px;font-weight:500;color:${retard?'var(--red)':'var(--ink-faint)'}">
              <i class="ti ti-calendar" style="font-size:12px;vertical-align:-1px"></i> ${fmt(d.dateLivraison)}
              ${d.dateFab?` <span style="color:var(--teal);font-weight:600" title="Semaine de fabrication souhaitée">· Sem. ${numeroSemaineISO(new Date(d.dateFab+'T00:00:00'))}</span>`:''}
              ${retard?'<span style="font-size:10px;font-weight:700;color:var(--red);margin-left:4px">EN RETARD</span>':''}
            </span>
            <div style="display:flex;gap:7px">
              <button class="btn btn-ghost" onclick="openVueFab('${d.id}')" style="font-size:12px;padding:7px 12px"><i class="ti ti-eye"></i> Vue fab.</button>
              <button class="btn btn-secondary" onclick="openChecklist('${d.id}')" style="font-size:12px;padding:7px 12px"><i class="ti ti-list-check"></i> Checklist</button>
              ${can('adv_prod')?`<button class="btn btn-primary" onclick="avancerDos('${d.id}',event)" style="font-size:13px;padding:8px 16px"><i class="ti ti-check"></i> Fabriqué</button>`:''}
            </div>
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}
function openVueFab(dosId) {
  const d = dossiers.find(x => x.id === dosId); if (!d) return;
  const urg = isUrgent(d);
  const retard = d.dateLivraison && d.dateLivraison < new Date().toISOString().split('T')[0];
  const specs = [
    d.largeur  && {k:'Largeur',  v: d.largeur  + ' m'},
    d.longueur && {k:'Longueur', v: d.longueur + ' m'},
    d.hauteur  && {k:'Hauteur coffre', v: d.hauteur + ' m'},
    d.surface  && {k:'Surface',  v: d.surface  + ' m²'},
    d.lames    && {k:'Lames',    v: d.lames},
    d.pieds    && {k:'Pieds',    v: d.pieds},
    d.alim     && {k:'Alimentation', v: d.alim},
    d.moteur   && {k:'Moteur',   v: d.moteur},
  ].filter(Boolean);

  document.getElementById('vf-content').innerHTML = `
    <div style="padding:22px 26px;border-bottom:1px solid var(--border);background:${urg?'var(--red-light)':'var(--bg)'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div>
          ${urg?`<span style="background:var(--red);color:#fff;font-size:12px;font-weight:700;padding:3px 12px;border-radius:3px;display:inline-block;margin-bottom:8px"><i class="ti ti-alert-triangle"></i> URGENT</span>`:''}
          <div style="font-size:30px;font-weight:800;color:var(--ink);letter-spacing:-.5px;line-height:1.1">${d.client}</div>
          <div style="font-size:18px;color:var(--ink-soft);font-weight:500;margin-top:4px">${d.structure||'—'}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--ink-faint)">${d.id}</div>
          <div style="font-size:14px;font-weight:600;margin-top:4px;color:${retard?'var(--red)':'var(--ink-soft)'}">
            <i class="ti ti-calendar" style="font-size:13px;vertical-align:-1px"></i> ${fmt(d.dateLivraison)||'—'}
            ${d.dateFab?`<div style="font-size:12px;color:var(--teal);font-weight:600;margin-top:2px">Semaine de fab. souhaitée : ${numeroSemaineISO(new Date(d.dateFab+'T00:00:00'))}</div>`:''}
            ${retard?'<span style="font-size:11px;font-weight:700;color:var(--red);margin-left:4px">EN RETARD</span>':''}
          </div>
        </div>
      </div>
    </div>
    <div style="padding:22px 26px">
      ${specs.length ? `
      <div style="margin-bottom:22px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-faint);margin-bottom:12px">Dimensions & caractéristiques</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
          ${specs.map(s=>`<div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px">
            <div style="font-size:11px;color:var(--ink-faint);margin-bottom:4px">${s.k}</div>
            <div style="font-size:26px;font-weight:700;color:var(--ink);line-height:1">${s.v}</div>
          </div>`).join('')}
        </div>
      </div>` : ''}
      ${d.options ? `
      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-faint);margin-bottom:8px">Options</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${d.options.split(',').map(o=>`<span class="opt-tag" style="font-size:14px;padding:5px 14px">${o.trim()}</span>`).join('')}
        </div>
      </div>` : ''}
      ${d.remarques ? `
      <div style="background:#FFFBEB;border:1px solid #FAC775;border-radius:var(--radius);padding:14px 18px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#92400E;margin-bottom:6px"><i class="ti ti-alert-triangle"></i> Remarques</div>
        <div style="font-size:18px;color:#633806;line-height:1.5">${d.remarques}</div>
      </div>` : ''}
      ${d.autres ? `
      <div style="background:var(--red-light);border:1px solid #F09595;border-radius:var(--radius);padding:14px 18px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--red);margin-bottom:6px"><i class="ti ti-alert-circle"></i> Attention</div>
        <div style="font-size:18px;color:var(--red);line-height:1.5">${d.autres}</div>
      </div>` : ''}
      ${d.notesMetreur ? `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-faint);margin-bottom:6px"><i class="ti ti-ruler"></i> Notes métreur</div>
        <div style="font-size:16px;color:var(--ink);line-height:1.6;white-space:pre-wrap">${d.notesMetreur}</div>
      </div>` : ''}
      ${(()=>{const fiche=getFicheFabrication(d);return fiche ? `
      <div style="margin-top:6px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-faint);margin-bottom:10px"><i class="ti ti-file-type-pdf" style="color:var(--red)"></i> Fiche de fabrication</div>
        <iframe src="${fiche.url}" style="width:100%;height:520px;border:1px solid var(--border);border-radius:var(--radius)"></iframe>
      </div>` : `
      <div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:var(--radius);padding:14px 18px">
        <div style="font-size:14px;color:#92400E"><i class="ti ti-clock" style="vertical-align:-1px;margin-right:6px"></i>Fiche de fabrication en attente</div>
      </div>`})()}
    </div>`;

  document.getElementById('vf-footer-btns').innerHTML = can('adv_prod')
    ? `<button class="btn btn-primary" style="font-size:15px;padding:10px 28px" onclick="closeModal('modal-vue-fab');avancerDos('${d.id}',event)"><i class="ti ti-check"></i> Marquer Fabriqué</button>`
    : '';
  openModal('modal-vue-fab');
}

function openChecklist(dosId) {
  const d=dossiers.find(x=>x.id===dosId); if(!d) return;
  document.getElementById('checklist-title').textContent=`Checklist — ${d.client}`;
  document.getElementById('checklist-sub').textContent=`${d.id} · ${d.structure||'—'}`;
  const btn=document.getElementById('checklist-fabrique-btn');
  btn.onclick=()=>{avancerDos(dosId,null);closeModal('modal-checklist');};
  btn.style.display=can('adv_prod')&&d.statut==='production'?'':'none';
  renderChecklistBody(dosId);
  openModal('modal-checklist');
}
function renderChecklistBody(dosId) {
  const d=dossiers.find(x=>x.id===dosId); if(!d) return;
  let p=d.pages?.find(pg=>pg.type==='verif');
  if(!p){
    d.pages=d.pages||[];
    p={type:'verif',label:'Vérification atelier',checks:{},rows:[...VERIF_ROWS]};
    d.pages.push(p);
  }
  const rows=p.rows||[...VERIF_ROWS];
  const chk=p.checks||{};
  const done=Object.values(chk).filter(c=>c.oui).length;
  const total=rows.length+VERIF_EXP.length;
  const pct=total>0?Math.round(done/total*100):0;
  document.getElementById('checklist-progress').innerHTML=`
    <div style="display:flex;align-items:center;gap:10px">
      <div style="flex:1;height:6px;background:var(--bg);border-radius:3px;overflow:hidden;border:1px solid var(--border)">
        <div style="height:100%;width:${pct}%;background:${pct===100?'var(--green)':pct>50?'var(--amber)':'var(--accent)'};border-radius:3px;transition:width .3s"></div>
      </div>
      <span style="font-weight:600;color:${pct===100?'var(--green)':'var(--ink)'}">${done}/${total}</span>
    </div>`;
  const makeRow=(row,ri,section)=>{
    const s=chk[ri]||{};
    return `<div style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);${s.oui?'background:var(--green-light);':''}transition:background .15s">
      <div style="flex:1;font-size:14px;font-weight:${s.oui?'600':'400'};color:${s.oui?'var(--green)':'var(--ink)'}">${row}</div>
      <div style="display:flex;gap:6px">
        <button onclick="toggleChkModal('${dosId}',${ri},'oui')" style="width:36px;height:36px;border-radius:var(--radius);border:1.5px solid ${s.oui?'var(--green)':'var(--border)'};background:${s.oui?'var(--green-light)':'transparent'};font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .1s">✓</button>
        <button onclick="toggleChkModal('${dosId}',${ri},'non')" style="width:36px;height:36px;border-radius:var(--radius);border:1.5px solid ${s.non?'var(--red)':'var(--border)'};background:${s.non?'var(--red-light)':'transparent'};font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .1s">✗</button>
      </div>
    </div>`;
  };
  document.getElementById('checklist-body').innerHTML=`
    <div style="padding:8px 16px;background:var(--bg);border-bottom:1px solid var(--border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-faint)">Fabrication</div>
    ${rows.map((r,i)=>makeRow(r,i)).join('')}
    <div style="padding:8px 16px;background:var(--bg);border-bottom:1px solid var(--border);border-top:1px solid var(--border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-faint)">Vérification avant expédition</div>
    ${VERIF_EXP.map((r,i)=>makeRow(r,rows.length+i)).join('')}`;
}
function toggleChkModal(dosId,ri,type) {
  const d=dossiers.find(x=>x.id===dosId); if(!d) return;
  let p=d.pages?.find(pg=>pg.type==='verif');
  if(!p) return;
  if(!p.checks) p.checks={};
  const c=p.checks[ri]||{};
  if(type==='oui'){c.oui=!c.oui;if(c.oui)c.non=false;}
  else{c.non=!c.non;if(c.non)c.oui=false;}
  p.checks[ri]=c;
  logHistory(dosId,'vérification',`Checklist — "${p.rows?p.rows[ri]||ri:ri}" : ${type.toUpperCase()}`);
  saveData();
  renderChecklistBody(dosId);
  // Rafraîchir la barre de progression sur la carte
  if(currentTab==='atelier_grand') renderAtelierGrand();
}
