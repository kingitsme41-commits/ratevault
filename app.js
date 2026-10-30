// RateVault — Native-Feel Offline Mobile PWA
// 100% Client-Side Local Storage (IndexedDB) — Zero Node / Server Dependencies

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const DB_NAME = 'RateVaultDB';
const DB_VERSION = 1;
let dbInstance = null;

// Object URL cache to prevent memory leaks and ensure snappy thumbnail loads
const blobUrlCache = new Map();

function revokeThumbnailUrl(id) {
  if (blobUrlCache.has(id)) {
    try { URL.revokeObjectURL(blobUrlCache.get(id)); } catch {}
    blobUrlCache.delete(id);
  }
}

// IndexedDB Helper Functions
function getDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (!db.objectStoreNames.contains('items')) {
        const itemStore = db.createObjectStore('items', { keyPath: 'id' });
        itemStore.createIndex('parentId', 'parentId', { unique: false });
        itemStore.createIndex('type', 'type', { unique: false });
        itemStore.createIndex('favorite', 'favorite', { unique: false });
        itemStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        if (dbInstance) {
          dbInstance.close();
          dbInstance = null;
        }
      };
      resolve(dbInstance);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAll(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(storeName, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, val) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put(val);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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

// App State
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

// Load metadata from IndexedDB
async function load() {
  try {
    const items = await dbGetAll('items');
    state.items = items || [];
    localStorage.setItem('rv-metadata', JSON.stringify(state.items));
    render();
  } catch (e) {
    try {
      state.items = JSON.parse(localStorage.getItem('rv-metadata') || '[]');
      render();
      toast('Showing your cached view');
    } catch {
      toast(e.message, true);
    }
  }
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
  const cachedUrl = blobUrlCache.get(item.id);
  const thumb = item.type === 'folder'
    ? `<div class="folder-thumb" data-open="${item.id}"><div class="folder-shape ${item.color}"><b>${childrenOf(item.id).length}</b></div></div>`
    : `<div class="thumb" data-preview="${item.id}">${isImage(item)
        ? `<img data-thumb-id="${item.id}" src="${cachedUrl || 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201%201%22%2F%3E'}" alt="${escapeHtml(item.name)}">`
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

async function loadThumbnails() {
  const images = $$('img[data-thumb-id]');
  for (const img of images) {
    const id = img.dataset.thumbId;
    if (blobUrlCache.has(id)) {
      if (img.src !== blobUrlCache.get(id)) img.src = blobUrlCache.get(id);
      continue;
    }
    try {
      const fileRecord = await dbGet('files', id);
      if (fileRecord && fileRecord.blob) {
        const url = URL.createObjectURL(fileRecord.blob);
        blobUrlCache.set(id, url);
        img.src = url;
      }
    } catch {}
  }
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

  loadThumbnails();
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

async function openPreview(id) {
  const item = state.items.find(i => i.id === id && i.type === 'file');
  if (!item) return;
  $('#previewName').textContent = item.name;
  $('#previewMeta').textContent = `${item.mime === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf') ? 'PDF document' : 'Image'} · ${formatBytes(item.size)}`;

  let url = blobUrlCache.get(id);
  if (!url) {
    const fileRecord = await dbGet('files', id);
    if (fileRecord && fileRecord.blob) {
      url = URL.createObjectURL(fileRecord.blob);
      blobUrlCache.set(id, url);
    }
  }

  if (!url) {
    toast('Could not load file preview', true);
    return;
  }

  if (isImage(item)) {
    $('#previewStage').innerHTML = `<img src="${url}" alt="${escapeHtml(item.name)}">`;
  } else {
    $('#previewStage').innerHTML = `<iframe title="${escapeHtml(item.name)}" src="${url}"></iframe>`;
  }
  $('#previewDownload').onclick = () => download(item.id);
  els.previewDialog.showModal();
}

async function download(id) {
  const item = state.items.find(i => i.id === id && i.type === 'file');
  if (!item) return;
  let url = blobUrlCache.get(id);
  if (!url) {
    const fileRecord = await dbGet('files', id);
    if (fileRecord && fileRecord.blob) {
      url = URL.createObjectURL(fileRecord.blob);
      blobUrlCache.set(id, url);
    }
  }
  if (!url) return toast('File not found', true);

  const a = document.createElement('a');
  a.href = url;
  a.download = item.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function patchItem(id, updates, successMessage) {
  try {
    const item = state.items.find(i => i.id === id);
    if (!item) throw new Error('Item not found');

    if (Object.hasOwn(updates, 'parentId')) {
      const parentId = updates.parentId || null;
      if (parentId && !state.items.some(i => i.id === parentId && i.type === 'folder')) {
        throw new Error('Destination folder not found');
      }
      if (item.type === 'folder' && parentId && descendantIds(state.items, item.id).has(parentId)) {
        throw new Error('A folder cannot be moved inside itself');
      }
      item.parentId = parentId;
    }

    if (Object.hasOwn(updates, 'name')) {
      item.name = uniqueName(state.items, cleanName(updates.name, item.name), item.parentId, item.type, item.id);
    }
    if (Object.hasOwn(updates, 'favorite')) {
      item.favorite = Boolean(updates.favorite);
    }
    if (Object.hasOwn(updates, 'tags') && item.type === 'file') {
      item.tags = [...new Set((updates.tags || []).map(t => String(t).trim()).filter(Boolean))].slice(0, 8);
    }
    if (Object.hasOwn(updates, 'color') && item.type === 'folder') {
      item.color = ['amber','coral','blue','green'].includes(updates.color) ? updates.color : 'amber';
    }
    item.updatedAt = new Date().toISOString();

    await dbPut('items', item);
    if (successMessage) toast(successMessage);
    await load();
  } catch (e) {
    toast(e.message, true);
  }
}

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
      ? `“${items[0].name}” and everything inside it will be deleted. This cannot be undone.`
      : `“${items[0].name}” will be permanently deleted. This cannot be undone.`
    : `${items.length} selected items will be permanently deleted, including anything inside selected folders. This cannot be undone.`;
  els.confirmDialog.showModal();
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

// Global click event delegation
document.addEventListener('click', e => {
  const closeId = e.target.closest('[data-close]')?.dataset.close;
  if (closeId) {
    if (closeId === 'uploadDialog') cancelUploadDialog();
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
  if (fav) {
    const item = state.items.find(i => i.id === fav);
    if (item) patchItem(fav, { favorite: !item.favorite }, item.favorite ? 'Removed from favorites' : 'Added to favorites');
  }

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

async function bulkFavorite() {
  const ids = [...state.selected];
  try {
    for (const id of ids) {
      const item = state.items.find(i => i.id === id);
      if (item) {
        item.favorite = true;
        item.updatedAt = new Date().toISOString();
        await dbPut('items', item);
      }
    }
    toast(`${ids.length} items added to favorites`);
    state.selected.clear();
    await load();
  } catch (error) {
    toast(error.message, true);
  }
}

function bulkDownload() {
  const files = state.items.filter(i => state.selected.has(i.id) && i.type === 'file');
  if (!files.length) return toast('Select at least one file to download', true);
  files.forEach((file, index) => setTimeout(() => download(file.id), index * 180));
  toast(`Downloading ${files.length} file${files.length === 1 ? '' : 's'}`);
}

// Folder Form Submission
$('#folderForm').addEventListener('submit', async e => {
  e.preventDefault();
  const rawName = $('#folderName').value.trim();
  if (!rawName) return;

  const parentId = state.folderId || null;
  const name = uniqueName(state.items, cleanName(rawName, 'New folder'), parentId, 'folder');
  const color = new FormData(e.target).get('folderColor') || 'amber';

  const item = {
    id: generateId(),
    type: 'folder',
    name,
    parentId,
    color,
    favorite: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  try {
    await dbPut('items', item);
    els.folderDialog.close();
    toast('Folder created');
    await load();
  } catch (err) {
    toast(err.message, true);
  }
});

// Edit Form Submission
$('#editForm').addEventListener('submit', async e => {
  e.preventDefault();
  const item = state.items.find(i => i.id === state.editId);
  if (!item) return;

  const updates = {
    name: $('#editName').value,
    parentId: $('#editFolder').value || null
  };
  if (item.type === 'file') {
    updates.tags = $('#editTags').value.split(',').map(t => t.trim()).filter(Boolean);
  }
  els.editDialog.close();
  await patchItem(item.id, updates, 'Changes saved');
});

// Confirm Delete
$('#confirmForm').addEventListener('submit', async e => {
  e.preventDefault();
  els.confirmDialog.close();
  const roots = [...state.deleteIds];
  let deletedCount = 0;

  try {
    for (const rootId of roots) {
      const item = state.items.find(i => i.id === rootId);
      if (!item) continue;

      const allIds = item.type === 'folder'
        ? descendantIds(state.items, item.id)
        : new Set([item.id]);

      for (const id of allIds) {
        const target = state.items.find(i => i.id === id);
        if (target && target.type === 'file') {
          await dbDelete('files', id);
          revokeThumbnailUrl(id);
        }
        await dbDelete('items', id);
        state.selected.delete(id);
        deletedCount++;
      }
    }
    state.deleteIds = [];
    if (deletedCount) toast(`${deletedCount} item${deletedCount === 1 ? '' : 's'} deleted`);
    await load();
  } catch (err) {
    toast(err.message, true);
    await load();
  }
});

// Upload Form Submission (Saving binary files directly to local IndexedDB)
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
  const uploadToken = { cancelled: false, addedIds: [] };
  activeUpload = uploadToken;

  try {
    for (let i = 0; i < state.uploadFiles.length; i++) {
      if (uploadToken.cancelled) break;
      const file = state.uploadFiles[i];
      button.textContent = `Saving ${i + 1}/${state.uploadFiles.length}…`;

      const id = generateId();
      const mime = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
      const name = uniqueName(state.items, cleanName(file.name, 'File'), folderId, 'file');

      const item = {
        id,
        type: 'file',
        name,
        parentId: folderId,
        mime,
        size: file.size,
        tags: [...new Set(tags)].slice(0, 8),
        favorite: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Store binary blob in local 'files' store and metadata in 'items' store
      await dbPut('files', { id, blob: file, mime, name, size: file.size, updatedAt: item.updatedAt });
      await dbPut('items', item);
      state.items.push(item);
      uploadToken.addedIds.push(id);
      added++;
    }

    els.uploadDialog.close();
    toast(`${added} file${added === 1 ? '' : 's'} added to vault`);
    state.uploadFiles = [];
    $('#uploadTags').value = '';
    await load();
  } catch (err) {
    if (uploadToken.addedIds.length) {
      for (const id of uploadToken.addedIds) {
        await dbDelete('files', id);
        await dbDelete('items', id);
        revokeThumbnailUrl(id);
      }
    }
    toast(uploadToken.cancelled ? 'Upload cancelled.' : err.message, !uploadToken.cancelled);
    await load();
  } finally {
    if (activeUpload === uploadToken) activeUpload = null;
    button.disabled = false;
    button.textContent = 'Save to vault';
    cancel.textContent = 'Cancel';
  }
});

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
  if (e.key === 'Escape') $('#sidebar').classList.remove('open');
});

$('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#helpButton').addEventListener('click', () => $('#helpDialog').showModal());
$('#previewClose').addEventListener('click', () => els.previewDialog.close());
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

// Initial load
load();
