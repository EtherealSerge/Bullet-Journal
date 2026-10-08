// ==========================================
// 1. GOOGLE DRIVE API CONFIGURATION
// ==========================================
const CLIENT_ID = '208914720664-6ji1lrrk86q9m74s9kungttr0a7f3dlg.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';

let tokenClient;
let accessToken = null;
let driveFileId = null;

const syncBtn = document.getElementById('sync-btn');

// ==========================================
// 2. TOKEN CACHING & HELPER FUNCTIONS
// ==========================================

let tokenExpiryTimer = null;
let tokenExpiresAt = 0;

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function clearToken() {
  accessToken = null;
  tokenExpiresAt = 0;
  clearTimeout(tokenExpiryTimer);
  try {
    localStorage.removeItem('bujo_gdrive_token');
    localStorage.removeItem('bujo_gdrive_token_exp');
  } catch { /* A storage failure must not prevent using the journal. */ }
}

function updateSyncStatus() {
  if (syncRunning) {
    syncBtn.textContent = 'Syncing...';
  } else if (!accessToken || Date.now() >= tokenExpiresAt) {
    syncBtn.textContent = unsyncedChanges ? 'Sign in to sync (changes pending)' : 'Sign in to sync';
  } else {
    syncBtn.textContent = unsyncedChanges ? 'Retry sync (changes pending)' : 'Synced to Drive';
  }
  // GSI is needed only for signing in, not for a valid cached token.
  syncBtn.disabled = syncRunning || (!accessToken && !tokenClient);
}

function armTokenExpiry() {
  clearTimeout(tokenExpiryTimer);
  tokenExpiryTimer = setTimeout(() => {
    clearToken();
    updateSyncStatus();
    notify('Google sign-in expired. Local edits are kept; sign in again to sync.');
  }, Math.max(0, tokenExpiresAt - Date.now()));
}

function saveTokenToCache(token, expiresInSeconds) {
  accessToken = token;
  tokenExpiresAt = Date.now() + Math.max(1, Number(expiresInSeconds) - 60) * 1000;
  try {
    localStorage.setItem('bujo_gdrive_token', token);
    localStorage.setItem('bujo_gdrive_token_exp', String(tokenExpiresAt));
  } catch { /* The in-memory token still works for this session. */ }
  armTokenExpiry();
}

function loadCachedToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return true;
  const cachedToken = readStorage('bujo_gdrive_token');
  const expiration = Number(readStorage('bujo_gdrive_token_exp'));
  if (cachedToken && Number.isFinite(expiration) && Date.now() < expiration) {
    accessToken = cachedToken;
    tokenExpiresAt = expiration;
    armTokenExpiry();
    return true;
  }
  clearToken();
  return false;
}

// ==========================================
// 3. GOOGLE IDENTITY SERVICES INITIALIZATION
// ==========================================

function gisLoaded() {
  if (tokenClient || !window.google?.accounts?.oauth2) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (response) => {
      if (response.error || !response.access_token) {
        notify('Google sign-in failed. Local edits are kept.');
        updateSyncStatus();
        return;
      }
      saveTokenToCache(response.access_token, response.expires_in || 3600);
      await downloadAndMergeFromDrive();
    },
    error_callback: () => {
      notify('Google sign-in was closed or failed. Local edits are kept.');
      updateSyncStatus();
    }
  });
  updateSyncStatus();
}

syncBtn.addEventListener('click', () => {
  if (loadCachedToken()) {
    downloadAndMergeFromDrive();
  } else if (tokenClient) {
    const hasConsented = readStorage('bujo_gdrive_consented') === 'true';
    try { localStorage.setItem('bujo_gdrive_consented', 'true'); } catch { /* optional */ }
    tokenClient.requestAccessToken({ prompt: hasConsented ? '' : 'consent' });
  }
});

// ==========================================
// 4. SERIALIZED, MERGE-BEFORE-UPLOAD DRIVE SYNC
// ==========================================
let syncRunning = false;
let syncRequested = false;
let unsyncedChanges = readStorage('bujo_unsynced') !== 'false';
let changeGeneration = 0;

async function driveRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    if (response.status === 401) clearToken();
    throw new Error(`Drive request failed (${response.status}).`);
  }
  return response;
}

async function downloadAndMergeFromDrive() {
  if (storageRecoveryRequired) {
    notify('Saved data needs recovery. Export the damaged save before importing a backup.');
    return;
  }
  syncRequested = true;
  if (syncRunning) return;
  if (!loadCachedToken()) {
    updateSyncStatus();
    return;
  }
  syncRunning = true;
  updateSyncStatus();
  try {
    do {
      syncRequested = false;
      // Read before EVERY upload, including debounced edits. Merge all duplicate
      // files too: two devices can both create a file on their first sync.
      const query = encodeURIComponent("name='bujo_data.json' and trashed=false");
      let pageToken = '';
      const files = [];
      do {
        const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime desc&fields=nextPageToken,files(id)&pageSize=100${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
        const result = await (await driveRequest(url)).json();
        if (!Array.isArray(result.files) || result.files.some(file => typeof file.id !== 'string')) {
          throw new Error('Unexpected Drive file list.');
        }
        files.push(...result.files);
        pageToken = result.nextPageToken || '';
      } while (pageToken);
      driveFileId = files[0]?.id || null;
      let cloud = { monthly: {}, daily: {} };
      for (const file of files) {
        const response = await driveRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
        cloud = mergeJournalData(cloud, sanitizeJournalData(await response.json()).data);
      }
      if (document.querySelector('.edit-input')) {
        throw new Error('Finish editing an entry before syncing');
      }
      // journalData may have changed while awaiting the network. Merge with the
      // CURRENT local state, not the state captured at the start of the request.
      journalData = mergeJournalData(journalData, cloud);
      if (!persistJournal()) throw new Error('Local save failed; cloud upload stopped.');
      renderAllViews();
      const generation = changeGeneration;
      await uploadToDrive(JSON.stringify(journalData));
      unsyncedChanges = changeGeneration !== generation;
      try { localStorage.setItem('bujo_unsynced', String(unsyncedChanges)); } catch { /* status only */ }
      if (unsyncedChanges) syncRequested = true;
    } while (syncRequested && loadCachedToken());
    notify(unsyncedChanges ? 'Changes pending. Sign in to finish syncing.' : 'Journal synced to Drive.');
  } catch (error) {
    unsyncedChanges = true;
    try { localStorage.setItem('bujo_unsynced', 'true'); } catch { /* status only */ }
    notify(`${error.message} Local edits are kept. Use Sync to retry.`);
  } finally {
    syncRunning = false;
    updateSyncStatus();
  }
}

function mergeJournalData(local, cloud) {
  local = sanitizeJournalData(local).data;
  cloud = sanitizeJournalData(cloud).data;
  const merged = { monthly: {}, daily: {} };

  function mergeLists(localList = [], cloudList = []) {
    const itemMap = new Map();

    localList.forEach(item => {
      const key = item.id || item.text;
      itemMap.set(key, { ...item });
    });

    cloudList.forEach(cloudItem => {
      const key = cloudItem.id || cloudItem.text;
      if (!itemMap.has(key)) {
        itemMap.set(key, { ...cloudItem });
      } else {
        const localItem = itemMap.get(key);
        // Newest edit wins. Items without updatedAt (older data) count as 0,
        // so a stamped edit always beats an unstamped copy.
        const localTime = localItem.updatedAt || 0;
        const cloudTime = cloudItem.updatedAt || 0;
        const winner = cloudTime > localTime ? cloudItem : localItem;
        const isDeleted = Boolean(localItem.deleted || cloudItem.deleted);

        itemMap.set(key, {
          ...winner,
          deleted: isDeleted,
          updatedAt: Math.max(localTime, cloudTime)
        });
      }
    });

    return Array.from(itemMap.values());
  }

  const allMonthlyKeys = new Set([
    ...Object.keys(local.monthly || {}),
    ...Object.keys(cloud.monthly || {})
  ]);
  allMonthlyKeys.forEach(key => {
    merged.monthly[key] = mergeLists(local.monthly[key], cloud.monthly[key]);
  });

  const allDailyKeys = new Set([
    ...Object.keys(local.daily || {}),
    ...Object.keys(cloud.daily || {})
  ]);
  allDailyKeys.forEach(key => {
    merged.daily[key] = mergeLists(local.daily[key], cloud.daily[key]);
  });

  return merged;
}

// Private upload step: callers must go through downloadAndMergeFromDrive.
// This serializes one tab, but is NOT a cross-device transaction. Truly
// simultaneous writes can still race between download and upload.
async function uploadToDrive(snapshot) {
  if (driveFileId) {
    await driveRequest(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(driveFileId)}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: snapshot
    });
  } else {
    const boundary = 'bujo_' + crypto.randomUUID();
    const metadata = { name: 'bujo_data.json', mimeType: 'application/json', parents: ['appDataFolder'] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${snapshot}\r\n--${boundary}--\r\n`;
    const result = await (await driveRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
    })).json();
    if (typeof result.id !== 'string') throw new Error('Drive did not return a file ID.');
    driveFileId = result.id;
  }
}

// ==========================================
// 5. CORE APPLICATION STATE & HELPERS
// ==========================================
let currentDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDateStr = formatDateKey(new Date());

let storageRecoveryRequired = false;
let damagedSave = null;

function notify(message) {
  document.getElementById('app-status').textContent = message;
}

function validDateKey(key, monthly) {
  if (!(monthly ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(key)) return false;
  const [year, month, day = 1] = key.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// Fail closed: malformed cloud/import data must never overwrite a good save.
// Missing monthly/daily maps are accepted for legacy saves, not bad entries.
function validateJournalData(data) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(data) || (!Object.hasOwn(data, 'monthly') && !Object.hasOwn(data, 'daily'))) {
    throw new Error('Not a journal data file.');
  }
  const normalized = { monthly: {}, daily: {} };
  for (const section of ['monthly', 'daily']) {
    const map = Object.hasOwn(data, section) ? data[section] : {};
    if (!isObject(map)) throw new Error(`Invalid ${section} data.`);
    for (const [key, items] of Object.entries(map)) {
      if (!validDateKey(key, section === 'monthly') || !Array.isArray(items)) {
        throw new Error(`Invalid date or entry list in ${section}.`);
      }
      const ids = new Set();
      normalized[section][key] = items.map(item => {
        if (!isObject(item) || typeof item.text !== 'string' ||
            !['todo', 'done', 'migrated', 'note', 'event'].includes(item.status) ||
            (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
            (item.deleted !== undefined && typeof item.deleted !== 'boolean') ||
            (item.updatedAt !== undefined && (!Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0))) {
          throw new Error('Invalid journal entry. Nothing was imported or uploaded.');
        }
        const identity = item.id || item.text;
        if (ids.has(identity)) throw new Error('Duplicate entry ID in a date list.');
        ids.add(identity);
        return { ...(item.id ? { id: item.id } : {}), text: item.text, status: item.status,
          deleted: item.deleted || false, updatedAt: item.updatedAt || 0 };
      });
    }
  }
  return normalized;
}

// Lenient reader for data that already exists (local save, Drive copy).
// Never throws on a bad entry: fixes what it can and returns the rest in
// `rejected` so nothing is silently lost.
function sanitizeJournalData(data) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(data)) throw new Error('Not a journal data file.');
  const out = { monthly: {}, daily: {} };
  const rejected = [];
  for (const section of ['monthly', 'daily']) {
    const map = isObject(data[section]) ? data[section] : {};
    for (const [key, items] of Object.entries(map)) {
      if (!Array.isArray(items)) { rejected.push({ section, key, items }); continue; }
      const seen = new Set();
      out[section][key] = [];
      items.forEach((item, index) => {
        if (!isObject(item) || typeof item.text !== 'string') {
          rejected.push({ section, key, item }); return;
        }
        const entry = {
          text: item.text,
          status: ['todo', 'done', 'migrated', 'note', 'event'].includes(item.status) ? item.status : 'todo',
          deleted: item.deleted === true,
          updatedAt: Number.isFinite(item.updatedAt) && item.updatedAt >= 0 ? Math.floor(item.updatedAt) : 0
        };
        let id = typeof item.id === 'string' && item.id ? item.id : null;
        // Duplicate ids (or duplicate id-less texts) get a fresh id so both survive.
        if (!id && seen.has(entry.text)) id = crypto.randomUUID();
        if (id && seen.has(id)) id = crypto.randomUUID();
        if (id) { entry.id = id; seen.add(id); } else seen.add(entry.text);
        out[section][key].push(entry);
      });
    }
  }
  return { data: out, rejected };
}

function loadJournal() {
  const raw = localStorage.getItem('bujo_data');
  if (raw === null) return { monthly: {}, daily: {} };
  // One-time untouched copy of whatever was stored before this version ran.
  try {
    if (localStorage.getItem('bujo_data_raw_backup') === null) localStorage.setItem('bujo_data_raw_backup', raw);
  } catch { /* quota: the original bujo_data is still untouched */ }
  try {
    const { data, rejected } = sanitizeJournalData(JSON.parse(raw));
    if (rejected.length) {
      try { localStorage.setItem('bujo_data_rejected', JSON.stringify(rejected)); } catch { /* optional */ }
      notify(`${rejected.length} unreadable item(s) were set aside, the rest loaded. Export a backup.`);
    }
    return data;
  } catch {
    damagedSave = raw;
    storageRecoveryRequired = true;
    notify('Saved data is not valid JSON. The original is untouched. Export the damaged save, then import a backup. Edits cannot be saved yet.');
    return { monthly: {}, daily: {} };
  }
}

let journalData = loadJournal();

const monthYearDisplay = document.getElementById('month-year-display');
const calendarGrid = document.getElementById('calendar-grid');
const selectedDateDisplay = document.getElementById('selected-date-display');
const monthlyForm = document.getElementById('monthly-form');
const monthlyInput = document.getElementById('monthly-input');
const monthlyList = document.getElementById('monthly-list');
const dailyForm = document.getElementById('daily-form');
const dailyInput = document.getElementById('daily-input');
const dailyList = document.getElementById('daily-list');
const glanceForm = document.getElementById('glance-form');
const glanceInput = document.getElementById('glance-input');
const glanceSelect = document.getElementById('glance-day-select');
const glanceList = document.getElementById('glance-list');

function formatDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatMonthKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function formatFriendlyDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  
  return dateObj.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

let saveDebounceTimer = null;

function persistJournal() {
  if (storageRecoveryRequired) {
    notify('Saved data needs recovery. Edits are in memory only; export them before leaving.');
    return false;
  }
  try {
    localStorage.setItem('bujo_data', JSON.stringify(journalData));
    return true;
  } catch {
    notify('Local save failed (storage may be full or unavailable). Export a backup before leaving.');
    return false;
  }
}

function saveData() {
  changeGeneration++;
  unsyncedChanges = true;
  if (!persistJournal()) return;
  try { localStorage.setItem('bujo_unsynced', 'true'); } catch { /* status only */ }
  updateSyncStatus();
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    if (loadCachedToken()) downloadAndMergeFromDrive();
    else updateSyncStatus();
  }, 1000);
}

function getSymbol(status) {
  switch (status) {
    case 'todo': return '•';
    case 'done': return '✓';
    case 'migrated': return '>';
    case 'note': return '–';
    case 'event': return '○';
    default: return '•';
  }
}

function getNextStatus(currentStatus) {
  const sequence = ['todo', 'done', 'migrated', 'note', 'event'];
  const currentIndex = sequence.indexOf(currentStatus);
  if (currentIndex === -1) return 'todo';
  return sequence[(currentIndex + 1) % sequence.length];
}

function renderAllViews() {
  renderCalendar();
  renderMonthlyTasks();
  renderDailyTasks();
  renderAtAGlanceEvents();
}

function goToToday() {
  const now = new Date();
  selectedDateStr = formatDateKey(now);
  currentDate = new Date(now.getFullYear(), now.getMonth(), 1);
  renderAllViews();
}

// Scans past daily entries for uncompleted 'todo' tasks and copies them to Today
function migratePendingTasks() {
  const todayKey = formatDateKey(new Date());
  let migratedCount = 0;

  if (!journalData.daily[todayKey]) {
    journalData.daily[todayKey] = [];
  }

  // Iterate over all dates stored in daily logs
  Object.keys(journalData.daily).forEach(dateStr => {
    // Check if the date is strictly in the past compared to today
    if (dateStr < todayKey) {
      const tasks = journalData.daily[dateStr] || [];

      tasks.forEach(task => {
        // Look for uncompleted tasks that are not soft-deleted
        if (task.status === 'todo' && !task.deleted) {
          // 1. Mark original past task as 'migrated' (>)
          task.status = 'migrated';
          task.updatedAt = Date.now();

          // 2. Add copy to Today's log as 'todo' (•)
          journalData.daily[todayKey].push({
            id: crypto.randomUUID(),
            text: task.text,
            status: 'todo',
            deleted: false,
            updatedAt: Date.now()
          });

          migratedCount++;
        }
      });
    }
  });

  if (migratedCount > 0) {
    saveData();
    // Switch active view to Today so migrated tasks are immediately visible
    goToToday();
    notify(`Migrated ${migratedCount} pending task(s) to Today.`);
  } else {
    notify('No pending tasks found from past days.');
  }
}

// ==========================================
// 6. AUTO-EXPANDING TEXTAREA HELPERS
// ==========================================

function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = (textarea.scrollHeight) + 'px';
}

function resetTextareaHeight(textarea) {
  textarea.value = '';
  textarea.style.height = '40px';
}

function setupAutoExpandingTextarea(textarea, form) {
  textarea.addEventListener('input', () => autoResizeTextarea(textarea));

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
}

// Shared edit handler for task/event items
function setupEditHandler(textSpan, editBtn, leftDiv, item, onSave) {
  let isEditing = false;

  editBtn.addEventListener('click', () => {
    if (!isEditing) {
      isEditing = true;
      editBtn.textContent = '💾';
      editBtn.title = 'Save Changes';
      editBtn.setAttribute('aria-label', 'Save Changes');

      const editInput = document.createElement('textarea');
      editInput.className = 'edit-input';
      editInput.rows = 1;
      editInput.setAttribute('aria-label', 'Edit entry text');
      editInput.value = item.text;

      leftDiv.replaceChild(editInput, textSpan);
      autoResizeTextarea(editInput);
      editInput.focus();

      editInput.addEventListener('input', () => autoResizeTextarea(editInput));

      const commitEdit = () => {
        const newText = editInput.value.trim();
        if (newText && newText !== item.text) {
          item.text = newText;
          item.updatedAt = Date.now();
          onSave();
        } else {
          textSpan.textContent = item.text;
          if (leftDiv.contains(editInput)) {
            leftDiv.replaceChild(textSpan, editInput);
          }
          editBtn.textContent = '✏️';
          editBtn.title = 'Edit Entry';
      editBtn.setAttribute('aria-label', 'Edit Entry');
          isEditing = false;
        }
      };

      editInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          leftDiv.replaceChild(textSpan, editInput);
          editBtn.textContent = '✏️';
          editBtn.title = 'Edit Entry';
          editBtn.setAttribute('aria-label', 'Edit Entry');
          isEditing = false;
          editBtn.focus();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commitEdit();
        }
      });
    } else {
      const editInput = leftDiv.querySelector('.edit-input');
      if (editInput) {
        const newText = editInput.value.trim();
        if (newText && newText !== item.text) {
          item.text = newText;
          item.updatedAt = Date.now();
          onSave();
        } else {
          textSpan.textContent = item.text;
          leftDiv.replaceChild(textSpan, editInput);
          editBtn.textContent = '✏️';
          editBtn.title = 'Edit Entry';
      editBtn.setAttribute('aria-label', 'Edit Entry');
          isEditing = false;
        }
      }
    }
  });
}

// ==========================================
// 7. RENDERING LOGIC
// ==========================================

function renderCalendar() {
  calendarGrid.innerHTML = '';
  
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const monthNames = ["January", "February", "March", "April", "May", "June", 
                      "July", "August", "September", "October", "November", "December"];
  monthYearDisplay.textContent = `${monthNames[month]} ${year}`;

  const firstDayIndex = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < firstDayIndex; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.classList.add('day-cell', 'empty');
    calendarGrid.appendChild(emptyCell);
  }

  for (let day = 1; day <= totalDays; day++) {
    const dayCell = document.createElement('button');
    dayCell.type = 'button';
    dayCell.classList.add('day-cell');

    const dateObj = new Date(year, month, day);
    const weekdayAbbr = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
    const cellDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const dayEntries = journalData.daily[cellDateStr] || [];
    const hasEvents = dayEntries.some(e => e.status === 'event' && !e.deleted);
    const hasTasks = dayEntries.some(e => e.status === 'todo' && !e.deleted);

    let stripHtml = '';
    if (hasEvents || hasTasks) {
      const parts = [];
      if (hasEvents) parts.push('<span class="strip-event"></span>');
      if (hasTasks) parts.push('<span class="strip-task"></span>');
      stripHtml = `<div class="day-strip">${parts.join('')}</div>`;
    }

    dayCell.innerHTML = `
      <span class="weekday-tag">${weekdayAbbr}</span>
      <span class="day-num">${day}</span>
      ${stripHtml}
    `;
    
    if (cellDateStr === selectedDateStr) {
      dayCell.classList.add('active');
    }

    if (cellDateStr === formatDateKey(new Date())) {
      dayCell.classList.add('today');
    }

    dayCell.setAttribute('aria-label', `${formatFriendlyDate(cellDateStr)}${hasEvents ? ', has events' : ''}${hasTasks ? ', has tasks' : ''}`);
    dayCell.setAttribute('aria-pressed', String(cellDateStr === selectedDateStr));
    if (cellDateStr === formatDateKey(new Date())) dayCell.setAttribute('aria-current', 'date');
    dayCell.addEventListener('click', () => {
      selectedDateStr = cellDateStr;
      renderCalendar();
      renderDailyTasks();
      calendarGrid.querySelector('[aria-pressed="true"]')?.focus();
    });

    calendarGrid.appendChild(dayCell);
  }
}

function renderMonthlyTasks() {
  monthlyList.innerHTML = '';
  const monthKey = formatMonthKey(currentDate);
  const tasks = journalData.monthly[monthKey] || [];

  const activeTasks = tasks.filter(task => !task.deleted);

  activeTasks.forEach((task) => {
    const li = createTaskElement(
      task,
      () => {
        task.status = getNextStatus(task.status);
        task.updatedAt = Date.now();
        saveData();
        renderMonthlyTasks();
      },
      () => {
        task.deleted = true;
        task.updatedAt = Date.now();
        saveData();
        renderMonthlyTasks();
      },
      () => {
        saveData();
        renderAllViews();
      }
    );
    monthlyList.appendChild(li);
  });
}

function renderDailyTasks() {
  selectedDateDisplay.textContent = formatFriendlyDate(selectedDateStr);
  dailyList.innerHTML = '';
  const tasks = journalData.daily[selectedDateStr] || [];

  const activeTasks = tasks.filter(task => !task.deleted);

  activeTasks.forEach((task) => {
    const li = createTaskElement(
      task,
      () => {
        task.status = getNextStatus(task.status);
        task.updatedAt = Date.now();
        saveData();
        renderCalendar();
        renderDailyTasks();
        renderAtAGlanceEvents();
      },
      () => {
        task.deleted = true;
        task.updatedAt = Date.now();
        saveData();
        renderCalendar();
        renderDailyTasks();
        renderAtAGlanceEvents();
      },
      () => {
        saveData();
        renderAllViews();
      }
    );
    dailyList.appendChild(li);
  });
}

function populateGlanceDaySelect() {
  glanceSelect.innerHTML = '';
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const totalDays = new Date(year, month + 1, 0).getDate();

  for (let day = 1; day <= totalDays; day++) {
    const dateObj = new Date(year, month, day);
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
    const option = document.createElement('option');
    option.value = day;
    option.textContent = `${day} (${dayName})`;

    const [selY, selM, selD] = selectedDateStr.split('-').map(Number);
    if (selY === year && selM === month + 1 && selD === day) {
      option.selected = true;
    }

    glanceSelect.appendChild(option);
  }
}

function renderAtAGlanceEvents() {
  glanceList.innerHTML = '';
  populateGlanceDaySelect();

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const totalDays = new Date(year, month + 1, 0).getDate();

  let hasEvents = false;

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const tasks = journalData.daily[dateStr] || [];
    const events = tasks.filter(task => task.status === 'event' && !task.deleted);

    events.forEach(event => {
      hasEvents = true;
      const dateObj = new Date(year, month, day);
      const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });

      const li = document.createElement('li');
      li.className = 'task-item status-event';

      const leftDiv = document.createElement('div');
      leftDiv.className = 'task-left';

      const badge = document.createElement('span');
      badge.className = 'event-date-badge';
      badge.textContent = `${day} ${dayName}`;

      const textSpan = document.createElement('span');
      textSpan.className = 'text';
      textSpan.textContent = event.text;

      leftDiv.appendChild(badge);
      leftDiv.appendChild(textSpan);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'task-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'edit-btn';
      editBtn.textContent = '✏️';
      editBtn.title = 'Edit Event';
      editBtn.setAttribute('aria-label', 'Edit Event');

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Delete Event';
      deleteBtn.setAttribute('aria-label', 'Delete Event');
      deleteBtn.addEventListener('click', () => {
        event.deleted = true;
        event.updatedAt = Date.now();
        saveData();
        renderAllViews();
      });

      setupEditHandler(textSpan, editBtn, leftDiv, event, () => {
        saveData();
        renderAllViews();
      });

      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(deleteBtn);

      li.appendChild(leftDiv);
      li.appendChild(actionsDiv);
      glanceList.appendChild(li);
    });
  }

  if (!hasEvents) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'task-item';
    emptyLi.style.color = '#888';
    emptyLi.style.fontStyle = 'italic';
    emptyLi.textContent = 'No events scheduled for this month.';
    glanceList.appendChild(emptyLi);
  }
}

function createTaskElement(item, onToggleSymbol, onDelete, onSaveText) {
  const li = document.createElement('li');
  li.className = `task-item status-${item.status}`;

  const leftDiv = document.createElement('div');
  leftDiv.className = 'task-left';

  const symbolBtn = document.createElement('button');
  symbolBtn.className = 'symbol-btn';
  symbolBtn.textContent = getSymbol(item.status);
  symbolBtn.setAttribute('aria-label', `${getStatusLabel(item.status)}: change status of ${item.text}`);
  symbolBtn.addEventListener('click', onToggleSymbol);

  const textSpan = document.createElement('span');
  textSpan.className = 'text';
  textSpan.textContent = item.text;

  leftDiv.appendChild(symbolBtn);
  leftDiv.appendChild(textSpan);

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'task-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'edit-btn';
  editBtn.textContent = '✏️';
  editBtn.title = 'Edit Entry';
      editBtn.setAttribute('aria-label', 'Edit Entry');

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Delete Entry';
      deleteBtn.setAttribute('aria-label', 'Delete Entry');
  deleteBtn.addEventListener('click', onDelete);

  setupEditHandler(textSpan, editBtn, leftDiv, item, onSaveText);

  actionsDiv.appendChild(editBtn);
  actionsDiv.appendChild(deleteBtn);

  li.appendChild(leftDiv);
  li.appendChild(actionsDiv);

  return li;
}

function changeMonth(delta) {
  // Anchor to the 1st so e.g. Jan 31 + 1 month can't overflow into March.
  currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + delta, 1);
  
  const isCurrentMonth = currentDate.getFullYear() === new Date().getFullYear() &&
                         currentDate.getMonth() === new Date().getMonth();

  if (isCurrentMonth) {
    selectedDateStr = formatDateKey(new Date());
  } else {
    selectedDateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`;
  }

  renderAllViews();
}

function changeDay(delta) {
  const [year, month, day] = selectedDateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  dateObj.setDate(dateObj.getDate() + delta);

  selectedDateStr = formatDateKey(dateObj);

  if (dateObj.getFullYear() !== currentDate.getFullYear() || dateObj.getMonth() !== currentDate.getMonth()) {
    currentDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
  }

  renderAllViews();
}

// ==========================================
// 8. EVENT LISTENERS & INITIALIZATION
// ==========================================

document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
document.getElementById('next-month').addEventListener('click', () => changeMonth(1));

document.getElementById('prev-day').addEventListener('click', () => changeDay(-1));
document.getElementById('next-day').addEventListener('click', () => changeDay(1));

// Connect Today Buttons
document.getElementById('today-cal-btn').addEventListener('click', goToToday);
document.getElementById('today-daily-btn').addEventListener('click', goToToday);

// Connect Task Migration Button
document.getElementById('migrate-btn').addEventListener('click', migratePendingTasks);

setupAutoExpandingTextarea(monthlyInput, monthlyForm);
setupAutoExpandingTextarea(dailyInput, dailyForm);
setupAutoExpandingTextarea(glanceInput, glanceForm);

monthlyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = monthlyInput.value.trim();
  if (!text) return;

  const monthKey = formatMonthKey(currentDate);
  if (!journalData.monthly[monthKey]) {
    journalData.monthly[monthKey] = [];
  }

  journalData.monthly[monthKey].push({ id: crypto.randomUUID(), text: text, status: 'todo', deleted: false, updatedAt: Date.now() });
  saveData();
  resetTextareaHeight(monthlyInput);
  renderMonthlyTasks();
});

dailyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = dailyInput.value.trim();
  if (!text) return;

  if (!journalData.daily[selectedDateStr]) {
    journalData.daily[selectedDateStr] = [];
  }

  journalData.daily[selectedDateStr].push({ id: crypto.randomUUID(), text: text, status: 'todo', deleted: false, updatedAt: Date.now() });
  saveData();
  resetTextareaHeight(dailyInput);
  renderCalendar();
  renderDailyTasks();
  renderAtAGlanceEvents();
});

glanceForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = glanceInput.value.trim();
  const day = glanceSelect.value;
  if (!text || !day) return;

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const targetDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  if (!journalData.daily[targetDateStr]) {
    journalData.daily[targetDateStr] = [];
  }

  journalData.daily[targetDateStr].push({ id: crypto.randomUUID(), text: text, status: 'event', deleted: false, updatedAt: Date.now() });
  
  saveData();
  resetTextareaHeight(glanceInput);
  renderCalendar();
  renderDailyTasks();
  renderAtAGlanceEvents();
});

// ==========================================
// 9. QUICK NOTE CAPTURE
// ==========================================

const quickNoteBar = document.getElementById('quick-note-bar');
const quickNoteInput = document.getElementById('quick-note-input');
const quickNoteTrigger = document.getElementById('quick-note-trigger');

quickNoteTrigger.addEventListener('click', () => {
  quickNoteBar.classList.add('open');
  quickNoteInput.focus();
});

quickNoteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = quickNoteInput.value.trim();
    if (text) {
      const todayKey = formatDateKey(new Date());
      if (!journalData.daily[todayKey]) {
        journalData.daily[todayKey] = [];
      }
      journalData.daily[todayKey].push({ id: crypto.randomUUID(), text, status: 'note', deleted: false, updatedAt: Date.now() });
      saveData();
      quickNoteInput.value = '';
      quickNoteBar.classList.remove('open');
      renderAllViews();
    }
  }
});

quickNoteInput.addEventListener('blur', () => {
  if (!quickNoteInput.value.trim()) {
    quickNoteBar.classList.remove('open');
  }
});

// ==========================================
// 10. SEARCH FUNCTIONALITY
// ==========================================

const searchBtn = document.getElementById('search-btn');
const searchExpanded = document.getElementById('search-expanded');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

function highlightMatch(text, query) {
  if (!query) return text;
  const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
  return text.replace(regex, '<mark class="result-highlight">$1</mark>');
}

// Builds a safe DOM fragment: entry text is inserted as text nodes, never HTML.
function buildHighlightedNodes(text, query) {
  const frag = document.createDocumentFragment();
  if (!query) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
  text.split(regex).forEach((part, i) => {
    if (i % 2 === 1) {
      const mark = document.createElement('mark');
      mark.className = 'result-highlight';
      mark.textContent = part;
      frag.appendChild(mark);
    } else if (part) {
      frag.appendChild(document.createTextNode(part));
    }
  });
  return frag;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatResultDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getStatusLabel(status) {
  const labels = { todo: 'Task', done: 'Done', migrated: 'Migrated', note: 'Note', event: 'Event' };
  return labels[status] || status;
}

function searchEntries(query) {
  if (!query || query.trim().length < 2) {
    searchResults.innerHTML = '';
    return;
  }

  const normalizedQuery = query.toLowerCase().trim();
  const results = [];

  Object.entries(journalData.monthly || {}).forEach(([monthKey, tasks]) => {
    tasks.forEach(task => {
      if (task.deleted) return;
      if (task.text.toLowerCase().includes(normalizedQuery)) {
        results.push({
          text: task.text,
          date: monthKey + '-01',
          type: getStatusLabel(task.status),
          status: task.status,
          onSelect: () => {
            currentDate = new Date(monthKey.split('-')[0], parseInt(monthKey.split('-')[1]) - 1, 1);
            selectedDateStr = formatDateKey(currentDate);
            closeSearch();
            renderAllViews();
          }
        });
      }
    });
  });

  Object.entries(journalData.daily || {}).forEach(([dateStr, tasks]) => {
    tasks.forEach(task => {
      if (task.deleted) return;
      if (task.text.toLowerCase().includes(normalizedQuery)) {
        results.push({
          text: task.text,
          date: dateStr,
          type: getStatusLabel(task.status),
          status: task.status,
          onSelect: () => {
            selectedDateStr = dateStr;
            const [year, month] = dateStr.split('-').map(Number);
            currentDate = new Date(year, month - 1, 1);
            closeSearch();
            renderAllViews();
          }
        });
      }
    });
  });

  results.sort((a, b) => b.date.localeCompare(a.date));

  searchResults.innerHTML = '';
  document.getElementById('search-status').textContent = results.length > 50 ? `${results.length} matches. Showing the first 50.` : `${results.length} matches.`;
  if (results.length === 0) {
    searchResults.innerHTML = '<div class="search-empty">No matches found</div>';
    return;
  }

  results.slice(0, 50).forEach(result => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'search-result-item';
    const textDiv = document.createElement('div');
    textDiv.className = 'result-text';
    textDiv.appendChild(buildHighlightedNodes(result.text, normalizedQuery));

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    const dateSpan = document.createElement('span');
    dateSpan.className = 'result-date';
    dateSpan.textContent = formatResultDate(result.date);
    const typeSpan = document.createElement('span');
    typeSpan.className = 'result-type';
    typeSpan.textContent = result.type;
    meta.append(dateSpan, typeSpan);

    item.append(textDiv, meta);
    item.addEventListener('click', result.onSelect);
    searchResults.appendChild(item);
  });
}

function openSearch() {
  searchExpanded.classList.add('open');
  searchBtn.setAttribute('aria-expanded', 'true');
  searchInput.focus();
  searchInput.value = '';
  searchResults.innerHTML = '';
}

function closeSearch() {
  searchExpanded.classList.remove('open');
  searchBtn.setAttribute('aria-expanded', 'false');
  searchInput.value = '';
  searchResults.innerHTML = '';
}

function handleOutsideClick(e) {
  if (!searchExpanded.contains(e.target) && !searchBtn.contains(e.target)) {
    closeSearch();
  }
}

searchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (searchExpanded.classList.contains('open')) {
    closeSearch();
  } else {
    openSearch();
  }
});

searchInput.addEventListener('input', (e) => {
  searchEntries(e.target.value);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSearch();
    searchBtn.focus();
  }
});

document.addEventListener('click', handleOutsideClick);

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey &&
      !e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
    e.preventDefault();
    openSearch();
  }
});

// Initial Master Render
renderAllViews();

// ==========================================
// 11. BACKUPS AND OFFLINE APP SHELL
// ==========================================
function downloadJSON(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('export-btn').addEventListener('click', () => {
  downloadJSON(JSON.stringify({ format: 'bujo-backup', version: 1,
    exportedAt: new Date().toISOString(), data: journalData }, null, 2), `bujo-backup-${formatDateKey(new Date())}.json`);
});
document.getElementById('recovery-btn').addEventListener('click', () => {
  if (damagedSave !== null) downloadJSON(damagedSave, 'bujo-damaged-save.json');
  else notify('No damaged save is available to export.');
});
document.getElementById('recovery-btn').hidden = damagedSave === null;

const importInput = document.getElementById('import-file');
document.getElementById('import-btn').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Backup exceeds the 10 MB import limit.');
    const parsed = JSON.parse(await file.text());
    if (parsed?.format === 'bujo-backup' && parsed.version !== 1) throw new Error('Unsupported backup version.');
    const imported = validateJournalData(parsed?.format === 'bujo-backup' ? parsed.data : parsed);
    const message = storageRecoveryRequired
      ? 'Have you exported the damaged save? Importing will replace it with a valid merged journal. Continue?'
      : 'Merge this backup with the journal? Newer entries win; deleted entries stay deleted. Export a backup first if you may need to undo this.';
    if (!window.confirm(message)) return;
    const merged = mergeJournalData(journalData, imported);
    // Persist BEFORE replacing memory state. A quota error leaves both untouched.
    localStorage.setItem('bujo_data', JSON.stringify(merged));
    journalData = merged;
    storageRecoveryRequired = false;
    damagedSave = null;
    document.getElementById('recovery-btn').hidden = true;
    saveData();
    renderAllViews();
    notify('Backup merged and saved locally.');
  } catch (error) {
    notify(`Import failed: ${error.message} Existing data is unchanged.`);
  } finally {
    importInput.value = '';
  }
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      notify('Offline setup failed. Keep a JSON backup; reload online to retry.');
    });
  });
}
window.addEventListener('online', () => {
  if (loadCachedToken()) downloadAndMergeFromDrive();
  else updateSyncStatus();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderCalendar();
    loadCachedToken();
    updateSyncStatus();
  }
});
// script.js loads before the async Google script, avoiding the old onload race.
gisLoaded();
if (loadCachedToken()) downloadAndMergeFromDrive();
else updateSyncStatus();
