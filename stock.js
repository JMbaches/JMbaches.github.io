/* ================================================================
   STOCK.JS — JM Bâches
   Module autonome pour la gestion du stock (lames + pièces détachées).
   Dépend de variables/fonctions globales définies dans index.html
   (currentTab, can, goTab, showToast, ROLE_DEFAULT_PERMS, STOCK_CATEGORIES)
   et dans firebase-layer-v3.js (submitStockMouvement, saveStockRef, etc.)
   — fonctionne car tous les <script> classiques partagent le même scope
   lexical global du document (voir mémoire projet : piège let/window).
   ================================================================ */
let stockRefs = []; // Rempli par Firestore au chargement — { id:codeBarre, type, finition, taille, quantite, createdAt }
let stockMouvements = []; // Rempli par Firestore au chargement — historique entrées/sorties/inventaires

/* ================================================================
   STOCK (lames PVC/polycarbonate)
   ================================================================ */
let stockCurrentCode = null; // code actuellement affiché dans la fiche scan

function stockFindRef(code) {
  return stockRefs.find(r => r.id === code);
}

// Recherche une référence lame par type + coloris (finition) + taille — utilisé pour le décompte auto au moment de la vérif.
function stockFindRefByAttrs(type, finition, taille) {
  if (!type || !finition || !taille) return null;
  const f = String(finition).trim().toLowerCase();
  return stockRefs.find(r => r.type === type && (r.finition||'').trim().toLowerCase() === f && String(r.taille) === String(taille)) || null;
}

// Décompte automatique du stock de lames pour un dossier, appelé quand il quitte le statut "verif".
// Le stock de lames est compté en FAGOTS (1 fagot = 3 lames, cf. calcNbFagots dans
// subapp_calculs.html), pas en lames individuelles — la quantité vient donc obligatoirement de
// d.nbFagotsCalcule, renseigné par la fiche de calcul (jmb:export) qui fait ce calcul précisément
// (prend en compte découpe/chutes réelles). Pas d'estimation de secours si la fiche de calcul n'a
// pas été faite pour ce dossier : mieux vaut ne rien décompter qu'un chiffre approximatif.
// Retourne {ok:true, nbFagots, ref} en cas de succès, ou {ok:false, reason} sinon (jamais d'exception).
async function stockDecompterDossier(d) {
  if (d.stockDecompteFait) return { ok:false, reason:'déjà décompté' };
  if (!d.typeLame || !d.lames || !d.tailleLame) return { ok:false, reason:'type/coloris/taille de lame non renseignés sur le dossier' };
  const nbFagots = d.nbFagotsCalcule;
  if (!nbFagots) return { ok:false, reason:'fiche de calcul non faite pour ce dossier (nombre de fagots inconnu)' };
  const ref = stockFindRefByAttrs(d.typeLame, d.lames, d.tailleLame);
  if (!ref) return { ok:false, reason:`aucune référence stock pour ${d.typeLame} / ${d.lames} / taille ${d.tailleLame}` };
  await window.submitStockMouvement(ref.id, 'sortie', nbFagots);
  ref.quantite = (ref.quantite||0) - nbFagots;
  return { ok:true, nbFagots, ref };
}

/* ================================================================
   STOCK (pièces détachées — moteur, pied, axe...)
   ================================================================ */

// Recherche une référence pièce par catégorie + libellé exact (comparaison trim+lowercase).
function stockFindPieceRef(categorie, label) {
  if (!categorie || !label) return null;
  const l = String(label).trim().toLowerCase();
  return stockRefs.find(r => r.categorie === categorie && (r.label||'').trim().toLowerCase() === l) || null;
}

// Décompte automatique du moteur (1 par dossier), appelé en même temps que les lames.
// d.moteur (ex: "80S") matche directement le libellé de la ref stock catégorie 'moteur'
// — même code que celui extrait par megao-sync.js depuis le code produit VR (VRSIL80S → 80S).
async function stockDecompterMoteur(d) {
  if (d.stockMoteurDecompteFait) return { ok:false, reason:'déjà décompté' };
  if (!d.moteur) return { ok:false, reason:'moteur non renseigné sur le dossier' };
  const ref = stockFindPieceRef('moteur', d.moteur);
  if (!ref) return { ok:false, reason:`aucune référence stock moteur pour "${d.moteur}"` };
  await window.submitStockMouvement(ref.id, 'sortie', 1);
  ref.quantite = (ref.quantite||0) - 1;
  return { ok:true, ref };
}

// Point d'entrée unique du décompte auto de stock à l'entrée en production (sortie du statut
// "verif"). Appelé depuis changerStatutDossier() dans index.html, quel que soit le bouton/menu
// utilisé pour faire avancer le dossier — pour ne pas dépendre d'un chemin en particulier.
async function stockDecompterEntreeProduction(d) {
  const lamesRes = await stockDecompterDossier(d);
  if (lamesRes.ok) {
    d.stockDecompteFait = true;
    logHistory(d.id,'stock',`Stock décompté automatiquement : ${lamesRes.nbFagots} fagot${lamesRes.nbFagots>1?'s':''} (${lamesRes.ref.type} ${d.lames} taille ${d.tailleLame})${lamesRes.ref.quantite<0?' — ⚠ stock passé négatif':''}`);
    showToast(lamesRes.ref.quantite<0 ? `⚠ ${lamesRes.nbFagots} fagots décomptés — stock négatif (${lamesRes.ref.quantite})` : `${lamesRes.nbFagots} fagots décomptés du stock`);
  } else if (lamesRes.reason !== 'déjà décompté') {
    showToast(`⚠ Décompte stock lames impossible : ${lamesRes.reason}`);
    logHistory(d.id,'stock',`Décompte stock lames automatique impossible : ${lamesRes.reason}`);
  }

  const moteurRes = await stockDecompterMoteur(d);
  if (moteurRes.ok) {
    d.stockMoteurDecompteFait = true;
    logHistory(d.id,'stock',`Moteur décompté automatiquement : ${d.moteur}${moteurRes.ref.quantite<0?' — ⚠ stock passé négatif':''}`);
    showToast(moteurRes.ref.quantite<0 ? `⚠ moteur ${d.moteur} décompté — stock négatif (${moteurRes.ref.quantite})` : `Moteur ${d.moteur} décompté du stock`);
  } else if (moteurRes.reason !== 'déjà décompté') {
    showToast(`⚠ Décompte stock moteur impossible : ${moteurRes.reason}`);
    logHistory(d.id,'stock',`Décompte stock moteur automatique impossible : ${moteurRes.reason}`);
  }
}

function stockFmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('fr-FR', {day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});
}

function renderStockScan() {
  const mc = document.getElementById('main-content');
  const nbLames = stockRefs.filter(r => !r.categorie).length;
  mc.innerHTML = `
  <div class="page-header">
    <h1 style="font-size:20px;font-weight:700;letter-spacing:-.2px">Stock — Scanner</h1>
    <p>${nbLames} référence${nbLames>1?'s':''} enregistrée${nbLames>1?'s':''}</p>
  </div>
  <div style="max-width:480px;margin-bottom:20px">
    <input id="stock-scan-input" type="text" placeholder="Scannez une lame…" autocomplete="off"
      style="width:100%;padding:14px 16px;font-size:16px;border:2px solid var(--border);border-radius:var(--radius);font-family:'JetBrains Mono',monospace"
      onkeydown="if(event.key==='Enter'){event.preventDefault();stockHandleScan(this.value.trim());this.value='';}">
  </div>
  <div id="stock-fiche-zone"></div>
  `;
  const input = document.getElementById('stock-scan-input');
  if (input) input.focus();
  if (stockCurrentCode) stockHandleScan(stockCurrentCode);
}

function stockHandleScan(code) {
  if (!code) return;
  stockCurrentCode = code;
  const zone = document.getElementById('stock-fiche-zone');
  if (!zone) return;
  const ref = stockFindRef(code);
  zone.innerHTML = ref ? stockFicheHtml(ref) : stockNewRefFormHtml(code);
  const input = document.getElementById('stock-scan-input');
  if (input) input.focus();
}

function stockNewRefFormHtml(code) {
  return `
  <div class="daily-card" style="max-width:480px;padding:16px">
    <div style="font-size:12px;color:var(--ink-faint);margin-bottom:2px">Code inconnu</div>
    <div style="font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;margin-bottom:14px">${code}</div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Type de lame</label>
        <select id="stock-new-type" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
          <option value="PVC">PVC</option>
          <option value="Polycarbonate">Polycarbonate</option>
        </select>
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Finition / couleur</label>
        <input id="stock-new-finition" type="text" placeholder="Ex: Blanc, Gris anthracite…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Taille</label>
        <input id="stock-new-taille" type="text" placeholder="Ex: 220, 180…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Seuil minimum (alerte stock bas)</label>
        <input id="stock-new-minimum" type="number" min="0" value="0" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
    </div>
    <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="stockSaveNewRef('${code}')"><i class="ti ti-check"></i> Enregistrer et continuer</button>
  </div>`;
}

async function stockSaveNewRef(code) {
  const type = document.getElementById('stock-new-type').value;
  const finition = document.getElementById('stock-new-finition').value.trim();
  const taille = document.getElementById('stock-new-taille').value.trim();
  const minimum = parseInt(document.getElementById('stock-new-minimum').value, 10) || 0;
  if (!taille) { showToast('⚠ Indiquez une taille'); return; }
  await window.saveStockRef(code, { type, finition, taille, minimum });
  if (!stockFindRef(code)) stockRefs.push({ id: code, type, finition, taille, minimum, quantite: 0 });
  showToast('Référence enregistrée');
  stockHandleScan(code);
}

// Statut d'une référence : 'ok' | 'low' (sous le seuil, encore positif) | 'negative' (déficit réel, stock < 0)
function stockStatus(ref) {
  const q = ref.quantite || 0;
  if (q < 0) return 'negative';
  if ((ref.minimum || 0) > 0 && q < ref.minimum) return 'low';
  return 'ok';
}
// Conservé pour compat (compte "sous le seuil" tous statuts non-ok confondus)
function stockIsLow(ref) {
  return stockStatus(ref) !== 'ok';
}
function stockStatusColor(status) {
  return status === 'negative' ? 'var(--red)' : status === 'low' ? 'var(--amber)' : null;
}
function stockStatusBg(status) {
  return status === 'negative' ? 'var(--red-light)' : status === 'low' ? 'var(--amber-light)' : null;
}
function stockStatusBadge(ref) {
  const status = stockStatus(ref);
  if (status === 'negative') return `<div style="background:var(--red-light);border:1px solid #D9A0A0;border-radius:var(--radius);padding:6px 10px;margin-bottom:12px;font-size:12px;color:var(--red);font-weight:600"><i class="ti ti-alert-triangle"></i> Déficit de ${Math.abs(ref.quantite)} unité${Math.abs(ref.quantite)>1?'s':''} — à commander en urgence</div>`;
  if (status === 'low') return `<div style="background:var(--amber-light);border:1px solid #E0C08A;border-radius:var(--radius);padding:6px 10px;margin-bottom:12px;font-size:12px;color:var(--amber);font-weight:600"><i class="ti ti-alert-triangle"></i> Sous le seuil minimum (${ref.minimum})</div>`;
  return '';
}
function stockCommandeeBadge(ref) {
  const c = ref.quantiteCommandee || 0;
  if (c <= 0) return '';
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--teal-light);color:var(--teal);border-radius:var(--radius-sm);padding:2px 7px;font-size:11px;font-weight:600"><i class="ti ti-truck-delivery"></i> ${c} en commande</span>`;
}

function stockFicheHtml(ref) {
  const status = stockStatus(ref);
  const color = stockStatusColor(status);
  return `
  <div class="daily-card" style="max-width:480px;padding:16px${color?`;border-color:${color}`:''}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <div>
        <div style="font-size:19px;font-weight:700;letter-spacing:-.2px">${ref.type} — ${ref.finition||'—'}</div>
        <div style="font-size:13px;color:var(--ink-soft)">Taille ${ref.taille}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--ink-faint);margin-top:4px">${ref.id}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;color:var(--ink-faint);text-transform:uppercase;font-weight:600">Stock</div>
        <div style="font-size:28px;font-weight:700${color?`;color:${color}`:''}">${ref.quantite||0}</div>
      </div>
    </div>
    <div style="margin-bottom:10px">${stockCommandeeBadge(ref)}</div>
    ${stockStatusBadge(ref)}
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">
      <button class="btn btn-secondary" style="justify-content:center" onclick="stockOpenAction('${ref.id}','entree')"><i class="ti ti-plus"></i> Entrée</button>
      <button class="btn btn-secondary" style="justify-content:center" onclick="stockOpenAction('${ref.id}','sortie')"><i class="ti ti-minus"></i> Sortie</button>
      <button class="btn btn-secondary" style="justify-content:center" onclick="stockOpenAction('${ref.id}','commande')"><i class="ti ti-truck-delivery"></i> Commande</button>
      <button class="btn btn-secondary" style="justify-content:center" onclick="stockOpenAction('${ref.id}','inventaire')"><i class="ti ti-clipboard-list"></i> Inventaire</button>
    </div>
    <div id="stock-action-zone" style="margin-top:12px"></div>
  </div>`;
}

function stockOpenAction(code, action) {
  const ref = stockFindRef(code);
  if (!ref) return;
  const zone = document.getElementById('stock-action-zone');
  const labels = {entree:'Quantité reçue', sortie:'Quantité sortie', inventaire:'Quantité comptée (stock réel)', commande:'Quantité commandée au fournisseur'};
  const nom = ref.label || `${ref.type} — ${ref.finition||'—'} (taille ${ref.taille})`;
  zone.innerHTML = `
    <div class="daily-card" style="max-width:480px;padding:12px 14px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">${nom}</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="stock-action-qte" type="number" min="0" value="${action==='inventaire'?(ref.quantite||0):1}" style="width:100px;padding:8px;border:1px solid var(--border);border-radius:var(--radius)"
          onkeydown="if(event.key==='Enter'){event.preventDefault();stockConfirmAction('${code}','${action}');}">
        <span style="font-size:12px;color:var(--ink-soft);flex:1">${labels[action]}</span>
        <button class="btn btn-primary btn-sm" onclick="stockConfirmAction('${code}','${action}')"><i class="ti ti-check"></i> Valider</button>
      </div>
      ${action==='commande' ? `<div style="font-size:11px;color:var(--ink-faint);margin-top:6px">S'ajoute à ce qui est déjà en commande (${ref.quantiteCommandee||0} actuellement). Une entrée de stock déduira automatiquement cette quantité.</div>` : ''}
    </div>`;
  const qteInput = document.getElementById('stock-action-qte');
  qteInput.focus();
  qteInput.select();
}

async function stockConfirmAction(code, action) {
  const qteInput = document.getElementById('stock-action-qte');
  const qte = parseInt(qteInput.value, 10);
  if (isNaN(qte) || qte < 0) { showToast('⚠ Quantité invalide'); return; }
  const ref = stockFindRef(code);
  if (action === 'commande') {
    await window.submitStockCommande(code, qte);
    if (ref) ref.quantiteCommandee = (ref.quantiteCommandee||0) + qte;
    showToast('Commande enregistrée');
    stockRefreshCurrentView(code);
    return;
  }
  const avant = ref ? (ref.quantite||0) : 0;
  const delta = action==='entree' ? qte : action==='sortie' ? -qte : (qte - avant);
  await window.submitStockMouvement(code, action, qte);
  if (ref) {
    ref.quantite = avant + delta;
    if (action === 'entree') ref.quantiteCommandee = Math.max(0, (ref.quantiteCommandee||0) - qte);
  }
  showToast('Mouvement enregistré');
  stockRefreshCurrentView(code);
}

// Réaffiche la vue Stock actuellement ouverte (Scanner, Références ou une catégorie de pièces)
function stockRefreshCurrentView(code) {
  if (currentTab === 'stock_scan') stockHandleScan(code);
  else if (currentTab === 'stock_liste') renderStockListe();
  else if (typeof currentTab === 'string' && currentTab.startsWith('stock_cat_')) renderStockCategorie(currentTab.slice('stock_cat_'.length));
}

let stockListeQuery = ''; // recherche texte dans Stock > Références

function stockFilterListe(val) {
  stockListeQuery = val;
  const input = document.getElementById('stock-liste-search');
  const selStart = input ? input.selectionStart : null;
  const selEnd = input ? input.selectionEnd : null;
  renderStockListe();
  const newInput = document.getElementById('stock-liste-search');
  if (newInput) {
    newInput.focus();
    if (selStart !== null) newInput.setSelectionRange(selStart, selEnd);
  }
}

function renderStockListe() {
  const mc = document.getElementById('main-content');
  const allRefs = stockRefs.filter(r => !r.categorie).sort((a,b) => (a.type+a.finition+a.taille).localeCompare(b.type+b.finition+b.taille));
  const q = stockListeQuery.trim().toLowerCase();
  const refs = !q ? allRefs : allRefs.filter(r =>
    (r.id||'').toLowerCase().includes(q) ||
    (r.type||'').toLowerCase().includes(q) ||
    (r.finition||'').toLowerCase().includes(q) ||
    (r.taille||'').toLowerCase().includes(q)
  );
  const nbLow = allRefs.filter(stockIsLow).length;
  mc.innerHTML = `
  <div class="page-header">
    <h1 style="font-size:20px;font-weight:700;letter-spacing:-.2px">Stock — Références</h1>
    <p>${allRefs.length} référence${allRefs.length>1?'s':''}${nbLow>0?` · <span style="color:var(--red);font-weight:600"><i class="ti ti-alert-triangle"></i> ${nbLow} sous le seuil</span>`:''}</p>
  </div>
  <div class="section-header" style="margin-bottom:14px">
    <div class="section-title" style="font-size:15px;font-weight:700">Références</div>
    <div style="display:flex;gap:8px;align-items:center">
      <div style="position:relative">
        <i class="ti ti-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-faint);font-size:13px;pointer-events:none"></i>
        <input type="text" id="stock-liste-search" placeholder="Code, type, coloris, taille…" autocomplete="off" value="${stockListeQuery}" style="padding:7px 10px 7px 30px;width:220px" oninput="stockFilterListe(this.value)">
      </div>
      <button class="btn btn-primary btn-sm" onclick="stockToggleManualForm()"><i class="ti ti-plus"></i> Nouvelle référence</button>
    </div>
  </div>
  <div id="stock-manual-form-zone" style="margin-bottom:16px"></div>
  ${refs.length===0 ? `<div class="empty-state"><i class="ti ti-box-multiple"></i>${q ? `Aucune référence ne correspond à « ${stockListeQuery} »` : `Aucune référence enregistrée — scannez une lame dans l'onglet Scanner, ou ajoutez-en une manuellement`}</div>` : `
  <div class="table-wrap" style="margin-bottom:24px">
    <table>
      <thead><tr><th>Code</th><th>Type</th><th>Finition</th><th>Taille</th><th>Quantité</th><th>Seuil</th><th>En commande</th><th></th></tr></thead>
      <tbody>${refs.map(r=>{const status=stockStatus(r);const color=stockStatusColor(status);return `<tr${status!=='ok'?` style="background:${stockStatusBg(status)}"`:''}>
        <td style="font-size:11px;color:var(--ink-faint);font-family:'JetBrains Mono',monospace">${r.id}</td>
        <td>${r.type}</td>
        <td>${r.finition||'—'}</td>
        <td>${r.taille}</td>
        <td><strong${color?` style="color:${color}"`:''}>${r.quantite||0}</strong>${status!=='ok'?` <i class="ti ti-alert-triangle" style="color:${color};font-size:12px" title="${status==='negative'?'Déficit':'Sous le seuil minimum'}"></i>`:''}</td>
        <td style="color:var(--ink-faint)">${r.minimum||0}</td>
        <td>${stockCommandeeBadge(r)}</td>
        <td><div style="display:flex;gap:4px">
          <button class="btn btn-ghost btn-sm" onclick="goTab('stock_scan');setTimeout(()=>stockHandleScan('${r.id}'),50)" title="Gérer le stock"><i class="ti ti-scan"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="stockOpenManualForm('${r.id}')" title="Modifier"><i class="ti ti-edit"></i></button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="stockDeleteRef('${r.id}')" title="Supprimer"><i class="ti ti-trash"></i></button>
        </div></td>
      </tr>`;}).join('')}</tbody>
    </table>
  </div>`}
  <div class="section-header" style="margin-bottom:14px">
    <div class="section-title" style="font-size:15px;font-weight:700">Derniers mouvements</div>
  </div>
  ${stockMouvements.length===0 ? `<div class="empty-state"><i class="ti ti-history"></i>Aucun mouvement enregistré</div>` : `
  <div class="table-wrap">
    <table>
      <thead><tr><th>Date</th><th>Code</th><th>Action</th><th>Qté</th><th>Stock après</th></tr></thead>
      <tbody>${stockMouvements.slice(0,50).map(m=>`<tr>
        <td style="font-size:12px;color:var(--ink-faint)">${stockFmtDate(m.at)}</td>
        <td style="font-size:11px;color:var(--ink-faint);font-family:'JetBrains Mono',monospace">${m.codeBarre}</td>
        <td>${{entree:'Entrée',sortie:'Sortie',inventaire:'Inventaire',commande:'Commande'}[m.action]||m.action}</td>
        <td>${m.delta>0?'+':''}${m.delta}</td>
        <td>${m.action==='commande' ? `${m.quantiteCommandeeApres} en commande` : m.quantiteApres}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`}
  `;
}

let stockManualFormEditCode = null; // null = création, sinon code de la référence en cours d'édition

function stockToggleManualForm() {
  const zone = document.getElementById('stock-manual-form-zone');
  if (zone && zone.innerHTML.trim()) { stockCloseManualForm(); return; }
  stockOpenManualForm(null);
}

function stockCloseManualForm() {
  stockManualFormEditCode = null;
  const zone = document.getElementById('stock-manual-form-zone');
  if (zone) zone.innerHTML = '';
}

function stockOpenManualForm(editCode) {
  stockManualFormEditCode = editCode || null;
  const zone = document.getElementById('stock-manual-form-zone');
  if (!zone) return;
  const ref = editCode ? stockFindRef(editCode) : null;
  zone.innerHTML = `
  <div class="daily-card" style="max-width:480px;padding:16px">
    <div style="font-size:14px;font-weight:700;margin-bottom:14px">${editCode ? 'Modifier la référence' : 'Nouvelle référence'}</div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Code-barre</label>
        ${editCode
          ? `<div style="padding:8px;border:1px solid var(--border);border-radius:var(--radius);font-family:'JetBrains Mono',monospace;color:var(--ink-faint)">${editCode}</div>`
          : `<input id="stock-manual-code" type="text" autocomplete="off" placeholder="Ex: 3760123456789" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius);font-family:'JetBrains Mono',monospace">`}
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Type de lame</label>
        <select id="stock-manual-type" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
          <option value="PVC"${ref?.type==='PVC'?' selected':''}>PVC</option>
          <option value="Polycarbonate"${ref?.type==='Polycarbonate'?' selected':''}>Polycarbonate</option>
        </select>
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Finition / couleur</label>
        <input id="stock-manual-finition" type="text" value="${ref?.finition||''}" placeholder="Ex: Blanc, Gris anthracite…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Taille</label>
        <input id="stock-manual-taille" type="text" value="${ref?.taille||''}" placeholder="Ex: 220, 180…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Seuil minimum (alerte stock bas)</label>
        <input id="stock-manual-minimum" type="number" min="0" value="${ref?.minimum||0}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
      ${editCode ? '' : `
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Quantité initiale</label>
        <input id="stock-manual-qte" type="number" min="0" value="0" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>`}
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="stockSaveManualRef()"><i class="ti ti-check"></i> Enregistrer</button>
      <button class="btn btn-ghost" onclick="stockCloseManualForm()">Annuler</button>
    </div>
  </div>`;
  const firstInput = document.getElementById('stock-manual-code') || document.getElementById('stock-manual-finition');
  firstInput?.focus();
}

async function stockSaveManualRef() {
  const editCode = stockManualFormEditCode;
  const type = document.getElementById('stock-manual-type').value;
  const finition = document.getElementById('stock-manual-finition').value.trim();
  const taille = document.getElementById('stock-manual-taille').value.trim();
  const minimum = parseInt(document.getElementById('stock-manual-minimum').value, 10) || 0;
  if (!taille) { showToast('⚠ Indiquez une taille'); return; }

  if (editCode) {
    await window.updateStockRef(editCode, { type, finition, taille, minimum });
    const ref = stockFindRef(editCode);
    if (ref) { ref.type = type; ref.finition = finition; ref.taille = taille; ref.minimum = minimum; }
    showToast('Référence mise à jour');
    stockCloseManualForm();
    renderStockListe();
    return;
  }

  const code = document.getElementById('stock-manual-code').value.trim();
  const qte = parseInt(document.getElementById('stock-manual-qte').value, 10) || 0;
  if (!code) { showToast('⚠ Indiquez un code-barre'); return; }
  if (stockFindRef(code)) { showToast('⚠ Ce code existe déjà — utilisez le Scanner pour le gérer'); return; }
  await window.saveStockRef(code, { type, finition, taille, minimum });
  stockRefs.push({ id: code, type, finition, taille, minimum, quantite: 0 });
  if (qte > 0) {
    await window.submitStockMouvement(code, 'entree', qte);
    const ref = stockFindRef(code);
    if (ref) ref.quantite = qte;
  }
  showToast('Référence créée');
  stockCloseManualForm();
  renderStockListe();
}

async function stockDeleteRef(code) {
  const ref = stockFindRef(code);
  if (!ref) return;
  if (!confirm(`Supprimer la référence ${ref.type} — ${ref.finition||'—'} (${ref.taille}) ?\nLe stock actuel (${ref.quantite||0}) sera perdu. Cette action est irréversible.`)) return;
  await window.deleteStockRef(code);
  stockRefs = stockRefs.filter(r => r.id !== code);
  showToast('Référence supprimée');
  renderStockListe();
}

/* ================================================================
   STOCK — CATÉGORIES DE PIÈCES (hors lames, ajustées manuellement)
   ================================================================ */
let stockCatQuery = {}; // recherche texte, par catégorie
let stockCatFormEditId = null; // null = création, sinon id du produit en cours d'édition

function stockCatFilter(catId, val) {
  stockCatQuery[catId] = val;
  const input = document.getElementById('stock-cat-search');
  const selStart = input ? input.selectionStart : null;
  const selEnd = input ? input.selectionEnd : null;
  renderStockCategorie(catId);
  const newInput = document.getElementById('stock-cat-search');
  if (newInput) {
    newInput.focus();
    if (selStart !== null) newInput.setSelectionRange(selStart, selEnd);
  }
}

function renderStockCategorie(catId) {
  const cat = STOCK_CATEGORIES.find(c => c.id === catId);
  if (!cat) return;
  const mc = document.getElementById('main-content');
  const allRefs = stockRefs.filter(r => r.categorie === catId).sort((a,b) => (a.label||'').localeCompare(b.label||''));
  const q = (stockCatQuery[catId]||'').trim().toLowerCase();
  const refs = !q ? allRefs : allRefs.filter(r => (r.label||'').toLowerCase().includes(q));
  const nbLow = allRefs.filter(stockIsLow).length;
  mc.innerHTML = `
  <div class="page-header">
    <h1 style="font-size:20px;font-weight:700;letter-spacing:-.2px">Stock — ${cat.label}</h1>
    <p>${allRefs.length} produit${allRefs.length>1?'s':''}${nbLow>0?` · <span style="color:var(--red);font-weight:600"><i class="ti ti-alert-triangle"></i> ${nbLow} sous le seuil</span>`:''}</p>
  </div>
  <div class="section-header" style="margin-bottom:14px">
    <div class="section-title" style="font-size:15px;font-weight:700">${cat.label}</div>
    <div style="display:flex;gap:8px;align-items:center">
      <div style="position:relative">
        <i class="ti ti-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-faint);font-size:13px;pointer-events:none"></i>
        <input type="text" id="stock-cat-search" placeholder="Rechercher un produit…" autocomplete="off" value="${stockCatQuery[catId]||''}" style="padding:7px 10px 7px 30px;width:220px" oninput="stockCatFilter('${catId}',this.value)">
      </div>
      <button class="btn btn-primary btn-sm" onclick="stockCatOpenForm('${catId}',null)"><i class="ti ti-plus"></i> Nouveau produit</button>
    </div>
  </div>
  <div id="stock-cat-form-zone" style="margin-bottom:16px"></div>
  <div id="stock-action-zone" style="margin-bottom:16px"></div>
  ${refs.length===0 ? `<div class="empty-state"><i class="${cat.icon}"></i>${q ? `Aucun produit ne correspond à « ${stockCatQuery[catId]} »` : `Aucun produit enregistré dans cette catégorie`}</div>` : `
  <div class="table-wrap">
    <table>
      <thead><tr><th>Produit</th><th>Stock</th><th>Seuil</th><th>En commande</th><th></th></tr></thead>
      <tbody>${refs.map(r=>{const status=stockStatus(r);const color=stockStatusColor(status);return `<tr${status!=='ok'?` style="background:${stockStatusBg(status)}"`:''}>
        <td>${r.label}</td>
        <td><strong${color?` style="color:${color}"`:''}>${r.quantite||0}</strong>${status!=='ok'?` <i class="ti ti-alert-triangle" style="color:${color};font-size:12px" title="${status==='negative'?'Déficit':'Sous le seuil minimum'}"></i>`:''}</td>
        <td style="color:var(--ink-faint)">${r.minimum||0}</td>
        <td>${stockCommandeeBadge(r)}</td>
        <td><div style="display:flex;gap:4px">
          <button class="btn btn-ghost btn-sm" onclick="stockOpenAction('${r.id}','entree')" title="Entrée"><i class="ti ti-plus"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="stockOpenAction('${r.id}','sortie')" title="Sortie"><i class="ti ti-minus"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="stockOpenAction('${r.id}','commande')" title="Commande"><i class="ti ti-truck-delivery"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="stockOpenAction('${r.id}','inventaire')" title="Inventaire"><i class="ti ti-clipboard-list"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="stockCatOpenForm('${catId}','${r.id}')" title="Modifier"><i class="ti ti-edit"></i></button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="stockCatDeleteRef('${catId}','${r.id}')" title="Supprimer"><i class="ti ti-trash"></i></button>
        </div></td>
      </tr>`;}).join('')}</tbody>
    </table>
  </div>`}
  `;
}

function stockCatOpenForm(catId, editId) {
  stockCatFormEditId = editId || null;
  const zone = document.getElementById('stock-cat-form-zone');
  if (!zone) return;
  const ref = editId ? stockFindRef(editId) : null;
  zone.innerHTML = `
  <div class="daily-card" style="max-width:480px;padding:16px">
    <div style="font-size:14px;font-weight:700;margin-bottom:14px">${editId ? 'Modifier le produit' : 'Nouveau produit'}</div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Nom du produit</label>
        <input id="stock-cat-label" type="text" value="${ref?.label||''}" placeholder="Ex: Pied Blanc, Axe 420…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Seuil minimum (alerte stock bas)</label>
        <input id="stock-cat-minimum" type="number" min="0" value="${ref?.minimum||0}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
      ${editId ? '' : `
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--ink-soft)">Quantité initiale</label>
        <input id="stock-cat-qte" type="number" min="0" value="0" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>`}
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="stockCatSaveForm('${catId}')"><i class="ti ti-check"></i> Enregistrer</button>
      <button class="btn btn-ghost" onclick="stockCatCloseForm()">Annuler</button>
    </div>
  </div>`;
  document.getElementById('stock-cat-label')?.focus();
}

function stockCatCloseForm() {
  stockCatFormEditId = null;
  const zone = document.getElementById('stock-cat-form-zone');
  if (zone) zone.innerHTML = '';
}

async function stockCatSaveForm(catId) {
  const editId = stockCatFormEditId;
  const label = document.getElementById('stock-cat-label').value.trim();
  const minimum = parseInt(document.getElementById('stock-cat-minimum').value, 10) || 0;
  if (!label) { showToast('⚠ Indiquez un nom de produit'); return; }

  if (editId) {
    await window.updateCatStockRef(editId, { label, minimum });
    const ref = stockFindRef(editId);
    if (ref) { ref.label = label; ref.minimum = minimum; }
    showToast('Produit mis à jour');
    stockCatCloseForm();
    renderStockCategorie(catId);
    return;
  }

  const qte = parseInt(document.getElementById('stock-cat-qte').value, 10) || 0;
  const newId = await window.saveCatStockRef(catId, { label, minimum });
  if (!newId) { showToast('⚠ Erreur lors de la création'); return; }
  stockRefs.push({ id: newId, categorie: catId, label, minimum, quantite: 0 });
  if (qte > 0) {
    await window.submitStockMouvement(newId, 'entree', qte);
    const ref = stockFindRef(newId);
    if (ref) ref.quantite = qte;
  }
  showToast('Produit créé');
  stockCatCloseForm();
  renderStockCategorie(catId);
}

async function stockCatDeleteRef(catId, id) {
  const ref = stockFindRef(id);
  if (!ref) return;
  if (!confirm(`Supprimer "${ref.label}" ?\nLe stock actuel (${ref.quantite||0}) sera perdu. Cette action est irréversible.`)) return;
  await window.deleteStockRef(id);
  stockRefs = stockRefs.filter(r => r.id !== id);
  showToast('Produit supprimé');
  renderStockCategorie(catId);
}
