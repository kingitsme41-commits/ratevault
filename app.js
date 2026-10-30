// RateVault — Native-Feel Offline Mobile PWA
// Complete & Persistent CRUD with localStorage ('ratevault_items')
// Multi-Page Native Scrollable PDF.js Viewer with Mobile Pinch-to-Zoom

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const STORAGE_KEY = 'ratevault_items';

// -------------------------------------------------------------
// 1. Persistent Storage Engine (localStorage)
// -------------------------------------------------------------

function getStoredItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return [];

    // Filter out any lingering hardcoded fallback cards
    const cleaned = items.filter(i =>
      i &&
      i.name !== 'BALTRA_SHA_PRICE_LIST.pdf' &&
      i.id !== 'baltra-sha-price-list' &&
      !String(i.id).includes('baltra-sha') &&
      i.filePath !== './BALTRA_SHA_PRICE_LIST.pdf'
    );

    if (cleaned.length !== items.length) {
      saveStoredItems(cleaned);
    }
    return cleaned;
  } catch (err) {
    console.error('Error reading localStorage:', err);
    return [];
  }
}

function saveStoredItems(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    console.error('Error writing to localStorage:', err);
    toast('Storage full or error saving data', true);
  }
}

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'item-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
}

const cleanName = (value, fallback = 'Untitled') => {
  const out = String(value || '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '').trim().slice(0, 120);
  return out || fallback;
};

const uniqueName = (items, name, parentId, type, excludeId) => {
  const taken = items.some(i => i.id !== excludeId && i.parentId === parentId && i.type === type && i.name.toLowerCase() === name.toLowerCase());
  if (!taken) return name;
  const dot = type === 'file' ? name.lastIndexOf('.') : -1;
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (items.some(i => i.id !== excludeId && i.parentId === parentId && i.type === type && i.name.toLowerCase() === `${base} (${n})${ext}`.toLowerCase())) {
    n++;
  }
  return `${base} (${n})${ext}`;
};

function descendantIds(items, folderId) {
  const ids = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    items.forEach(i => {
      if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) {
        ids.add(i.id);
        changed = true;
      }
    });
  }
  return ids;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// -------------------------------------------------------------
// App State
// -------------------------------------------------------------

const state = {
  items: [],
  folderId: null,
  view: 'all',
  query: '',
  sort: 'updated-desc',
  layout: localStorage.getItem('rv-layout') || 'grid',
  uploadFiles: [],
  editId: null,
  deleteIds: [],
  selected: new Set()
};

let activeUpload = null;
let currentPdfDoc = null;
let activePdfRenderTasks = [];

const els = {
  grid: $('#itemsGrid'),
  tree: $('#folderTree'),
  empty: $('#emptyState'),
  breadcrumb: $('#breadcrumb'),
  filePicker: $('#filePicker'),
  uploadDialog: $('#uploadDialog'),
  folderDialog: $('#folderDialog'),
  editDialog: $('#editDialog'),
  previewDialog: $('#previewDialog'),
  confirmDialog: $('#confirmDialog'),
  search: $('#searchInput'),
  dropZone: $('#dropZone')
};

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c]);

const formatBytes = bytes => {
  if (!bytes) return '0 B';
  const units = ['B','KB','MB','GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

const formatDate = iso => new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: new Date(iso).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
}).format(new Date(iso));

const isImage = item => item.mime?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(item.name);
const folders = () => state.items.filter(i => i.type === 'folder');
const childrenOf = id => state.items.filter(i => i.parentId === id);
const currentFolder = () => state.items.find(i => i.id === state.folderId);

function toast(message, error = false) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  $('#toastStack').append(el);
  setTimeout(() => el.remove(), 3200);
}

// -------------------------------------------------------------
// Dynamic Status Update for Help ('?') Button & Modal
// -------------------------------------------------------------

function updateHelpButtonStatus() {
  const files = state.items.filter(i => i.type === 'file');
  const folderList = state.items.filter(i => i.type === 'folder');
  const totalBytes = state.items.reduce((sum, i) => sum + (i.size || 0), 0);

  const helpBtn = $('#helpButton');
  if (helpBtn) {
    helpBtn.title = `Vault Status: ${files.length} file${files.length === 1 ? '' : 's'}, ${folderList.length} folder${folderList.length === 1 ? '' : 's'} (${formatBytes(totalBytes)}) • Tap for guide`;
    helpBtn.setAttribute('aria-label', helpBtn.title);
  }

  const helpStatus = $('#helpVaultStatus');
  if (helpStatus) {
    helpStatus.textContent = `${state.items.length} item${state.items.length === 1 ? '' : 's'} in vault`;
  }

  const helpDetail = $('#helpVaultDetail');
  if (helpDetail) {
    helpDetail.textContent = `localStorage: ${files.length} files (${formatBytes(totalBytes)}), ${folderList.length} folders`;
  }
}

// -------------------------------------------------------------
// 2. Dynamic UI View Function (Reads strictly from localStorage)
// -------------------------------------------------------------

function load() {
  state.items = getStoredItems();
  render();
}

function folderPath(id) {
  const path = [];
  let cursor = state.items.find(i => i.id === id && i.type === 'folder');
  while (cursor) {
    path.unshift(cursor);
    cursor = state.items.find(i => i.id === cursor.parentId && i.type === 'folder');
  }
  return path;
}

function folderOptions(selected, exclude) {
  const invalid = exclude ? descendantIds(state.items, exclude) : new Set();
  const rows = ['<option value="">Library root</option>'];
  const walk = (parent, depth) => folders()
    .filter(f => f.parentId === parent && !invalid.has(f.id))
    .sort((a,b) => a.name.localeCompare(b.name))
    .forEach(f => {
      rows.push(`<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${'— '.repeat(depth)}${escapeHtml(f.name)}</option>`);
      walk(f.id, depth + 1);
    });
  walk(null, 0);
  return rows.join('');
}

function filteredItems() {
  let items = state.folderId ? childrenOf(state.folderId) : state.items.filter(i => i.parentId === null);
  if (state.view !== 'all') {
    if (state.view === 'recent') items = state.items.filter(i => i.type === 'file' && Date.now() - new Date(i.updatedAt) < 1000 * 60 * 60 * 24 * 30);
    if (state.view === 'favorites') items = state.items.filter(i => i.favorite);
    if (state.view === 'pdf') items = state.items.filter(i => i.type === 'file' && (i.mime === 'application/pdf' || i.name.toLowerCase().endsWith('.pdf')));
    if (state.view === 'image') items = state.items.filter(i => i.type === 'file' && isImage(i));
  }
  if (state.query) {
    const q = state.query.toLowerCase();
    items = state.items.filter(i => i.name.toLowerCase().includes(q) || (i.tags || []).some(t => t.toLowerCase().includes(q)));
  }
  const [key, dir] = state.sort.split('-');
  const sign = dir === 'asc' ? 1 : -1;
  return [...items].sort((a,b) => {
    if (!state.query && state.view === 'all' && a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (key === 'name') return sign * a.name.localeCompare(b.name);
    if (key === 'size') return sign * ((a.size || 0) - (b.size || 0));
    return sign * (new Date(a[key === 'created' ? 'createdAt' : 'updatedAt']) - new Date(b[key === 'created' ? 'createdAt' : 'updatedAt']));
  });
}

function renderTree() {
  const counts = id => childrenOf(id).filter(i => i.type === 'file').length;
  const rows = [];
  const walk = (parent, depth) => folders()
    .filter(f => f.parentId === parent)
    .sort((a,b) => a.name.localeCompare(b.name))
    .forEach(f => {
      rows.push(`<button class="tree-row ${state.folderId === f.id && state.view === 'all' ? 'active' : ''}" style="--depth:${depth}" data-folder="${f.id}"><i class="folder-dot ${f.color}"></i><span>${escapeHtml(f.name)}</span><small>${counts(f.id)}</small></button>`);
      walk(f.id, depth + 1);
    });
  walk(null, 0);
  els.tree.innerHTML = rows.join('') || '<p style="color:#788178;font-size:11px;padding:0 9px">No folders yet</p>';
}

function card(item, index) {
  const selected = state.selected.has(item.id);
  const imageSrc = item.dataUrl || item.filePath || '';
  const thumb = item.type === 'folder'
    ? `<div class="folder-thumb" data-open="${item.id}"><div class="folder-shape ${item.color}"><b>${childrenOf(item.id).length}</b></div></div>`
    : `<div class="thumb" data-preview="${item.id}">${isImage(item)
        ? `<img src="${imageSrc}" alt="${escapeHtml(item.name)}">`
        : '<div class="pdf-sheet">PDF</div>'}</div>`;
  const meta = item.type === 'folder' ? `${childrenOf(item.id).length} items` : `${item.mime === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'IMAGE'} · ${formatBytes(item.size)}`;

  return `<article class="item-card ${selected ? 'selected' : ''}" data-id="${item.id}" style="animation-delay:${Math.min(index * 35, 280)}ms">
    <button class="select-btn" data-select="${item.id}" title="Select" aria-label="${selected ? 'Deselect' : 'Select'} ${escapeHtml(item.name)}">${selected ? '✓' : ''}</button>${thumb}
    <div class="card-body">
      <div class="card-title-row">
        <span class="card-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <button class="favorite-btn ${item.favorite ? 'active' : ''}" data-favorite="${item.id}" title="Favorite">${item.favorite ? '★' : '☆'}</button>
        <button class="more-btn" data-more="${item.id}" title="More actions">•••</button>
      </div>
      <div class="card-meta"><span>${meta}</span><span>${formatDate(item.updatedAt)}</span></div>
      ${item.tags?.length ? `<div class="tags">${item.tags.slice(0,3).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="card-menu hidden" data-menu="${item.id}">
      ${item.type === 'file' ? `<button data-preview="${item.id}">Preview</button><button data-download="${item.id}">Download</button>` : `<button data-open="${item.id}">Open folder</button>`}
      <button data-edit="${item.id}">Rename & move</button>
      <button class="danger-text" data-delete="${item.id}">Delete</button>
    </div>
  </article>`;
}

function render() {
  state.selected.forEach(id => { if (!state.items.some(item => item.id === id)) state.selected.delete(id); });
  renderTree();
  const files = state.items.filter(i => i.type === 'file');
  const total = files.reduce((n,i) => n + (i.size || 0), 0);
  const items = filteredItems();

  $('#allCount').textContent = files.length;
  $('#pdfCount').textContent = files.filter(i => i.mime === 'application/pdf' || i.name.toLowerCase().endsWith('.pdf')).length;
  $('#imageCount').textContent = files.filter(isImage).length;
  $('#favoriteCount').textContent = state.items.filter(i => i.favorite).length;
  $('#storageLabel').textContent = formatBytes(total);

  const latest = [...files].sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  $('#lastActivity').textContent = latest ? `${latest.name} · ${formatDate(latest.updatedAt)}` : 'No files yet';

  const titles = { all:'All files', recent:'Recent files', favorites:'Favorites', pdf:'PDF documents', image:'Rate images' };
  const folder = currentFolder();
  $('#pageTitle').textContent = state.query ? `Results for “${state.query}”` : folder && state.view === 'all' ? folder.name : titles[state.view];
  $('#pageSubtitle').textContent = state.query ? 'Searching file names, folder names, and tags.' : folder ? `${childrenOf(folder.id).length} organized items in this folder.` : 'Everything important, stored safely on your device.';
  $('#eyebrow').textContent = folder ? 'CURRENT FOLDER' : state.view === 'all' ? 'YOUR ARCHIVE' : 'SMART COLLECTION';
  $('#resultCount').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
  $('#selectionLabel').textContent = state.selected.size ? `· ${state.selected.size} selected` : '';
  $('#bulkCount').textContent = state.selected.size;
  $('#bulkBar').classList.toggle('hidden', state.selected.size === 0);
  $('#selectModeButton').textContent = state.selected.size ? 'Select shown' : 'Select';

  els.grid.className = `items-grid ${state.layout}`;
  els.grid.innerHTML = items.map(card).join('');
  els.empty.classList.toggle('hidden', items.length > 0);
  $('#emptyTitle').textContent = state.query ? 'No matches found' : 'Your vault is ready';
  $('#emptyText').textContent = state.query ? 'Try a different file name or tag.' : 'Create a folder or upload your first rate list to get organized.';

  $$('.view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.layout === state.layout));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === state.view && !state.folderId && !state.query));

  const crumbs = [`<button data-crumb="root">Library</button>`];
  folderPath(state.folderId).forEach((f,i,a) => {
    crumbs.push('<i>/</i>', i === a.length-1 ? `<span>${escapeHtml(f.name)}</span>` : `<button data-crumb="${f.id}">${escapeHtml(f.name)}</button>`);
  });
  els.breadcrumb.innerHTML = crumbs.join('');

  $('#uploadFolder').innerHTML = folderOptions(state.folderId);
  $('#editFolder').innerHTML = folderOptions();

  // Dynamically update the '?' button status whenever items render
  updateHelpButtonStatus();
}

function openFolder(id) {
  state.folderId = id;
  state.view = 'all';
  state.query = '';
  els.search.value = '';
  state.selected.clear();
  render();
  $('#sidebar').classList.remove('open');
}

function openUpload(files = []) {
  state.uploadFiles = [...files].filter(f =>
    ['application/pdf','image/jpeg','image/png','image/webp','image/gif'].includes(f.type) ||
    /\.(pdf|jpg|jpeg|png|webp|gif)$/i.test(f.name)
  );
  renderUploadQueue();
  $('#uploadFolder').innerHTML = folderOptions(state.folderId);
  els.uploadDialog.showModal();
}

function renderUploadQueue() {
  $('#uploadQueue').innerHTML = state.uploadFiles.map((f,i) => {
    const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    return `<div class="queue-item"><span>${isPdf ? 'PDF' : 'IMG'}</span><p><b>${escapeHtml(f.name)}</b><small>${formatBytes(f.size)}</small></p><button type="button" data-remove-upload="${i}">×</button></div>`;
  }).join('');
}

function openFolderDialog() {
  $('#folderDialogTitle').textContent = 'Create a folder';
  $('#folderSubmit').textContent = 'Create folder';
  $('#folderName').value = '';
  $('#folderDialog').showModal();
  setTimeout(() => $('#folderName').focus(), 30);
}

function openEdit(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  state.editId = id;
  $('#editName').value = item.name;
  $('#editFolder').innerHTML = folderOptions(item.parentId, item.type === 'folder' ? item.id : null);
  $('#editFolder').value = item.parentId || '';
  $('#editTagsWrap').classList.toggle('hidden', item.type !== 'file');
  $('#editTags').value = (item.tags || []).join(', ');
  els.editDialog.showModal();
}

// -------------------------------------------------------------
// 3. Complete CRUD Operations (localStorage Backend)
// -------------------------------------------------------------

// CREATE: Add Folder
$('#folderForm').addEventListener('submit', e => {
  e.preventDefault();
  const rawName = $('#folderName').value.trim();
  if (!rawName) return;

  const parentId = state.folderId || null;
  const name = uniqueName(state.items, cleanName(rawName, 'New folder'), parentId, 'folder');
  const color = new FormData(e.target).get('folderColor') || 'amber';

  const newFolder = {
    id: generateId(),
    type: 'folder',
    name,
    parentId,
    color,
    favorite: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const items = getStoredItems();
  items.push(newFolder);
  saveStoredItems(items);

  state.items = items;
  els.folderDialog.close();
  toast('Folder created');
  render();
});

// CREATE: Upload Files
$('#uploadForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!state.uploadFiles.length) return toast('Choose at least one file', true);

  const button = $('#uploadSubmit');
  const cancel = $('#cancelUpload');
  button.disabled = true;
  button.textContent = 'Saving…';
  cancel.textContent = 'Cancel';

  const folderId = $('#uploadFolder').value || null;
  const tags = $('#uploadTags').value.split(',').map(t => t.trim()).filter(Boolean);
  let added = 0;
  const uploadToken = { cancelled: false };
  activeUpload = uploadToken;

  const items = getStoredItems();

  try {
    for (let i = 0; i < state.uploadFiles.length; i++) {
      if (uploadToken.cancelled) break;
      const file = state.uploadFiles[i];
      button.textContent = `Saving ${i + 1}/${state.uploadFiles.length}…`;

      const id = generateId();
      const mime = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
      const name = uniqueName(items, cleanName(file.name, 'File'), folderId, 'file');
      const dataUrl = await readFileAsDataUrl(file);

      const newItem = {
        id,
        type: 'file',
        name,
        parentId: folderId,
        mime,
        size: file.size,
        tags: [...new Set(tags)].slice(0, 8),
        favorite: false,
        dataUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      items.push(newItem);
      added++;
    }

    saveStoredItems(items);
    state.items = items;

    els.uploadDialog.close();
    toast(`${added} file${added === 1 ? '' : 's'} added to vault`);
    state.uploadFiles = [];
    $('#uploadTags').value = '';
    render();
  } catch (err) {
    toast(uploadToken.cancelled ? 'Upload cancelled.' : err.message, !uploadToken.cancelled);
    render();
  } finally {
    if (activeUpload === uploadToken) activeUpload = null;
    button.disabled = false;
    button.textContent = 'Save to vault';
    cancel.textContent = 'Cancel';
  }
});

// UPDATE: Edit Item
$('#editForm').addEventListener('submit', e => {
  e.preventDefault();
  const id = state.editId;
  const items = getStoredItems();
  const item = items.find(i => i.id === id);
  if (!item) return;

  const newName = $('#editName').value;
  const newParentId = $('#editFolder').value || null;

  if (newParentId && !items.some(i => i.id === newParentId && i.type === 'folder')) {
    return toast('Destination folder not found', true);
  }
  if (item.type === 'folder' && newParentId && descendantIds(items, item.id).has(newParentId)) {
    return toast('A folder cannot be moved inside itself', true);
  }

  item.parentId = newParentId;
  item.name = uniqueName(items, cleanName(newName, item.name), item.parentId, item.type, item.id);
  if (item.type === 'file') {
    item.tags = $('#editTags').value.split(',').map(t => t.trim()).filter(Boolean).slice(0, 8);
  }
  item.updatedAt = new Date().toISOString();

  saveStoredItems(items);
  state.items = items;
  els.editDialog.close();
  toast('Changes saved');
  render();
});

// UPDATE: Favorite Toggle
function toggleFavorite(id) {
  const items = getStoredItems();
  const item = items.find(i => i.id === id);
  if (!item) return;

  item.favorite = !item.favorite;
  item.updatedAt = new Date().toISOString();

  saveStoredItems(items);
  state.items = items;
  toast(item.favorite ? 'Added to favorites' : 'Removed from favorites');
  render();
}

// DELETE: Confirmation & Permanent Removal from localStorage and DOM
function askDelete(value) {
  const ids = Array.isArray(value) ? value : [value];
  const chosen = new Set(ids);
  state.deleteIds = ids.filter(id => {
    let item = state.items.find(i => i.id === id);
    while (item?.parentId) {
      if (chosen.has(item.parentId)) return false;
      item = state.items.find(i => i.id === item.parentId);
    }
    return true;
  });
  const items = state.items.filter(i => state.deleteIds.includes(i.id));
  if (!items.length) return;
  $('#confirmText').textContent = items.length === 1
    ? items[0].type === 'folder'
      ? `“${items[0].name}” and everything inside it will be permanently deleted from local storage.`
      : `“${items[0].name}” will be permanently deleted from local storage.`
    : `${items.length} selected items will be permanently deleted from local storage.`;
  els.confirmDialog.showModal();
}

$('#confirmForm').addEventListener('submit', e => {
  e.preventDefault();
  els.confirmDialog.close();

  // Hide any open context menus to prevent ghost elements
  $$('.card-menu').forEach(m => m.classList.add('hidden'));

  let items = getStoredItems();
  const allIdsToRemove = new Set();

  for (const rootId of state.deleteIds) {
    const target = items.find(i => i.id === rootId);
    if (!target) continue;
    if (target.type === 'folder') {
      descendantIds(items, target.id).forEach(id => allIdsToRemove.add(id));
    } else {
      allIdsToRemove.add(target.id);
    }
  }

  if (!allIdsToRemove.size) return;

  // Cleanly remove corresponding DOM elements immediately
  allIdsToRemove.forEach(id => {
    const el = document.querySelector(`.item-card[data-id="${id}"]`);
    if (el && el.parentNode) {
      el.remove();
    }
    state.selected.delete(id);
  });

  const beforeCount = items.length;
  // Instantly filter out targeted items by their unique IDs
  items = items.filter(i => !allIdsToRemove.has(i.id));
  const deletedCount = beforeCount - items.length;

  // Persist updated array to localStorage immediately
  saveStoredItems(items);

  // Update in-memory state and clear delete queue
  state.items = items;
  state.deleteIds = [];

  // Reset folder view if current folder was deleted
  if (state.folderId && allIdsToRemove.has(state.folderId)) {
    state.folderId = null;
  }

  // Complete clean UI re-render
  render();

  if (deletedCount > 0) {
    toast(`${deletedCount} item${deletedCount === 1 ? '' : 's'} deleted permanently`);
  }
});

// Bulk Actions
async function bulkFavorite() {
  const ids = new Set(state.selected);
  const items = getStoredItems();
  let count = 0;
  items.forEach(item => {
    if (ids.has(item.id)) {
      item.favorite = true;
      item.updatedAt = new Date().toISOString();
      count++;
    }
  });
  saveStoredItems(items);
  state.items = items;
  state.selected.clear();
  toast(`${count} items added to favorites`);
  render();
}

function bulkDownload() {
  const files = state.items.filter(i => state.selected.has(i.id) && i.type === 'file');
  if (!files.length) return toast('Select at least one file to download', true);
  files.forEach((file, index) => setTimeout(() => download(file.id), index * 180));
  toast(`Downloading ${files.length} file${files.length === 1 ? '' : 's'}`);
}

// -------------------------------------------------------------
// Native Browser-Like Multi-Page PDF.js Viewer
// -------------------------------------------------------------

function cancelPdfRendering() {
  activePdfRenderTasks.forEach(task => {
    try { task.cancel(); } catch {}
  });
  activePdfRenderTasks = [];
}

async function renderAllPdfPages(pdfDoc) {
  const container = document.getElementById('pdf-container');
  if (!container) return;

  cancelPdfRendering();
  container.innerHTML = '';

  currentPdfDoc = pdfDoc;
  const numPages = pdfDoc.numPages;

  // Render each page sequentially into the scrollable container
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    try {
      const page = await pdfDoc.getPage(pageNum);

      const pageWrapper = document.createElement('div');
      pageWrapper.className = 'pdf-page-wrapper';
      pageWrapper.dataset.pageNumber = pageNum;

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      pageWrapper.appendChild(canvas);
      container.appendChild(pageWrapper);

      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      // High-resolution rendering (1.5x) ensures crisp text on Retina / mobile displays
      const viewport = page.getViewport({ scale: 1.5 });

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = '100%';
      canvas.style.maxWidth = `${Math.floor(viewport.width)}px`;
      canvas.style.height = 'auto';

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const renderTask = page.render({
        canvasContext: ctx,
        viewport: viewport
      });
      activePdfRenderTasks.push(renderTask);

      await renderTask.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error(`Error rendering PDF page ${pageNum}:`, err);
      }
    }
  }
}

// Preview Dialog: Native multi-page scrollable PDF and dynamic image preview
async function openPreview(id) {
  const item = state.items.find(i => i.id === id && i.type === 'file');
  if (!item) return toast('Document not found', true);

  const pdfContainer = $('#pdf-container');
  const imagePreview = $('#imagePreview');
  const isPdf = item.mime === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf');

  $('#previewName').textContent = item.name;
  $('#previewMeta').textContent = `${isPdf ? 'PDF document' : 'Image'} · ${formatBytes(item.size)}`;
  $('#previewDownload').onclick = () => download(item.id);

  if (isPdf) {
    imagePreview.classList.add('hidden');
    pdfContainer.classList.remove('hidden');
    pdfContainer.innerHTML = '<div style="color:#b8c3cf;padding:40px;font-size:13px;text-align:center">Loading pages…</div>';
    els.previewDialog.showModal();

    try {
      if (!window.pdfjsLib) throw new Error('PDF.js library is not loaded');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

      const source = item.dataUrl || item.filePath;
      if (!source) throw new Error('No PDF file data available');

      const loadingTask = window.pdfjsLib.getDocument(source);
      const pdfDoc = await loadingTask.promise;
      await renderAllPdfPages(pdfDoc);
    } catch (err) {
      pdfContainer.innerHTML = `<div style="color:#ff8e86;padding:40px;font-size:13px;text-align:center"><p>Could not render PDF document</p><small>${escapeHtml(err.message)}</small></div>`;
      toast(err.message, true);
    }
  } else {
    // Image Preview
    pdfContainer.classList.add('hidden');
    imagePreview.classList.remove('hidden');

    const src = item.dataUrl || item.filePath;
    if (!src) {
      toast('Could not load image preview', true);
      return;
    }
    imagePreview.src = src;
    imagePreview.alt = item.name;
    els.previewDialog.showModal();
  }
}

function closePreview() {
  cancelPdfRendering();
  currentPdfDoc = null;
  const container = document.getElementById('pdf-container');
  if (container) container.innerHTML = '';
  if (els.previewDialog && els.previewDialog.open) {
    els.previewDialog.close();
  }
}

function download(id) {
  const item = state.items.find(i => i.id === id && i.type === 'file');
  if (!item) return toast('File not found', true);

  const href = item.dataUrl || item.filePath;
  if (!href) return toast('File data not available', true);

  const a = document.createElement('a');
  a.href = href;
  a.download = item.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function cancelUploadDialog() {
  if (activeUpload) {
    activeUpload.cancelled = true;
  }
  state.uploadFiles = [];
  renderUploadQueue();
  $('#uploadTags').value = '';
  els.filePicker.value = '';
  if (els.uploadDialog.open) els.uploadDialog.close();
}

// -------------------------------------------------------------
// Global Click Event Delegation
// -------------------------------------------------------------

document.addEventListener('click', e => {
  const closeId = e.target.closest('[data-close]')?.dataset.close;
  if (closeId) {
    if (closeId === 'uploadDialog') cancelUploadDialog();
    else if (closeId === 'previewDialog') closePreview();
    else document.getElementById(closeId)?.close();
    return;
  }

  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'upload') openUpload();
  if (action === 'new-folder') openFolderDialog();

  const view = e.target.closest('[data-view]')?.dataset.view;
  if (view) {
    state.view = view;
    state.folderId = null;
    state.query = '';
    state.selected.clear();
    els.search.value = '';
    render();
  }

  const folder = e.target.closest('[data-folder]')?.dataset.folder || e.target.closest('[data-open]')?.dataset.open;
  if (folder) openFolder(folder);

  const crumb = e.target.closest('[data-crumb]')?.dataset.crumb;
  if (crumb) openFolder(crumb === 'root' ? null : crumb);

  const layout = e.target.closest('[data-layout]')?.dataset.layout;
  if (layout) {
    state.layout = layout;
    localStorage.setItem('rv-layout', layout);
    render();
  }

  const preview = e.target.closest('[data-preview]')?.dataset.preview;
  if (preview) openPreview(preview);

  const edit = e.target.closest('[data-edit]')?.dataset.edit;
  if (edit) openEdit(edit);

  const del = e.target.closest('[data-delete]')?.dataset.delete;
  if (del) askDelete(del);

  const dl = e.target.closest('[data-download]')?.dataset.download;
  if (dl) download(dl);

  const fav = e.target.closest('[data-favorite]')?.dataset.favorite;
  if (fav) toggleFavorite(fav);

  const select = e.target.closest('[data-select]')?.dataset.select;
  if (select) {
    state.selected.has(select) ? state.selected.delete(select) : state.selected.add(select);
    render();
  }

  const more = e.target.closest('[data-more]')?.dataset.more;
  if (more) {
    e.stopPropagation();
    const menu = $(`[data-menu="${more}"]`);
    $$('.card-menu').filter(m => m !== menu).forEach(m => m.classList.add('hidden'));
    menu?.classList.toggle('hidden');
  } else if (!e.target.closest('.card-menu')) {
    $$('.card-menu').forEach(m => m.classList.add('hidden'));
  }

  const remove = e.target.closest('[data-remove-upload]')?.dataset.removeUpload;
  if (remove !== undefined) {
    state.uploadFiles.splice(Number(remove), 1);
    renderUploadQueue();
  }

  const bulk = e.target.closest('[data-bulk]')?.dataset.bulk;
  if (bulk === 'clear') {
    state.selected.clear();
    render();
  }
  if (bulk === 'select-visible') {
    const visible = filteredItems().map(i => i.id);
    const allSelected = visible.length && visible.every(id => state.selected.has(id));
    visible.forEach(id => allSelected ? state.selected.delete(id) : state.selected.add(id));
    render();
  }
  if (bulk === 'delete' && state.selected.size) askDelete([...state.selected]);
  if (bulk === 'favorite' && state.selected.size) bulkFavorite();
  if (bulk === 'download' && state.selected.size) bulkDownload();
});

// File picker and search listeners
$('#uploadWell').addEventListener('click', () => els.filePicker.click());
els.filePicker.addEventListener('change', () => {
  if (els.filePicker.files.length) {
    if (!els.uploadDialog.open) openUpload(els.filePicker.files);
    else {
      state.uploadFiles.push(...els.filePicker.files);
      renderUploadQueue();
    }
    els.filePicker.value = '';
  }
});

$('#sortSelect').addEventListener('change', e => {
  state.sort = e.target.value;
  render();
});

els.search.addEventListener('input', e => {
  state.query = e.target.value.trim();
  render();
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    els.search.focus();
  }
  if (e.key === 'Escape') {
    $('#sidebar').classList.remove('open');
    if (els.previewDialog && els.previewDialog.open) closePreview();
  }
});

$('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#helpButton').addEventListener('click', () => $('#helpDialog').showModal());
$('#previewClose').addEventListener('click', closePreview);
els.previewDialog.addEventListener('cancel', e => {
  e.preventDefault();
  closePreview();
});

$('#sidebarBackdrop').addEventListener('click', () => $('#sidebar').classList.remove('open'));
els.uploadDialog.addEventListener('cancel', e => {
  e.preventDefault();
  cancelUploadDialog();
});

// Drag & drop support
let dragDepth = 0;
document.addEventListener('dragenter', e => {
  if ([...e.dataTransfer.types].includes('Files')) {
    dragDepth++;
    els.dropZone.classList.add('visible');
  }
});
document.addEventListener('dragleave', () => {
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    els.dropZone.classList.remove('visible');
  }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  els.dropZone.classList.remove('visible');
  if (e.dataTransfer.files.length) openUpload(e.dataTransfer.files);
});

// Network status indication
function updateNetworkStatus() {
  const offline = !navigator.onLine;
  $('#networkStatus').classList.toggle('hidden', !offline);
  document.body.classList.toggle('is-offline', offline);
}
window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
updateNetworkStatus();

// PWA Install prompt handling
let installPrompt;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#installButton').classList.remove('hidden');
});
$('#installButton').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#installButton').classList.add('hidden');
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#installButton').classList.add('hidden');
  toast('RateVault installed');
});

// Register service worker if supported and not running in native Capacitor
if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform?.()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Initial load: strictly reads from localStorage and dynamically renders cards
load();
