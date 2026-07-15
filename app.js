// ==========================================
// AETHER JOURNAL - CORE LOGIC WITH G-DRIVE
// ==========================================

// --- State Variables ---
let entries = [];
let selectedDate = new Date(); // Current day viewed in Daily Log
let currentMonth = selectedDate.getMonth(); // Month viewed on Calendar
let currentYear = selectedDate.getFullYear(); // Year viewed on Calendar
let deferredPrompt = null; // PWA installation handler

// Google Drive Sync State
let gdriveToken = null;
let gdriveClientId = localStorage.getItem('aether_gdrive_client_id') || '';
let syncStatus = 'disconnected'; // 'disconnected', 'connected', 'syncing'

// --- DOM Cache ---
const DOM = {
  // Navigation
  navToday: document.getElementById('nav-today'),
  navCalendarToggle: document.getElementById('nav-calendar-toggle'),
  navSearch: document.getElementById('nav-search'),
  navSettings: document.getElementById('nav-settings'),
  installBtn: document.getElementById('install-btn'),
  appContainer: document.querySelector('.app-container'),
  
  // Header Sync Indicator
  syncIndicator: document.getElementById('sync-indicator'),
  
  // Calendar panel
  calendarView: document.getElementById('calendar-view'),
  currentMonthYear: document.getElementById('current-month-year'),
  prevMonthBtn: document.getElementById('prev-month'),
  nextMonthBtn: document.getElementById('next-month'),
  goToTodayBtn: document.getElementById('go-to-today'),
  calendarDays: document.getElementById('calendar-days'),
  statCompletedCount: document.getElementById('stat-completed-count'),
  statPendingCount: document.getElementById('stat-pending-count'),
  
  // Daily Log panel
  selectedDateTitle: document.getElementById('selected-date-title'),
  selectedDateSubtitle: document.getElementById('selected-date-subtitle'),
  newEntryForm: document.getElementById('new-entry-form'),
  entryTypeSelect: document.getElementById('entry-type'),
  selectIndicator: document.querySelector('.select-indicator'),
  entryTextInput: document.getElementById('entry-text'),
  journalEntriesList: document.getElementById('journal-entries-list'),
  
  // Modals
  settingsModal: document.getElementById('settings-modal'),
  searchModal: document.getElementById('search-modal'),
  closeModalBtns: document.querySelectorAll('.close-modal-btn'),
  
  // Settings actions
  exportBackupBtn: document.getElementById('export-backup-btn'),
  importBackupFile: document.getElementById('import-backup-file'),
  clearAllDataBtn: document.getElementById('clear-all-data-btn'),
  
  // Google Drive DOM elements
  gdriveStatus: document.getElementById('gdrive-status'),
  gdriveClientIdInput: document.getElementById('gdrive-client-id'),
  gdriveConnectBtn: document.getElementById('gdrive-connect-btn'),
  gdriveSyncBtn: document.getElementById('gdrive-sync-btn'),
  toggleInstructionsBtn: document.getElementById('toggle-instructions-btn'),
  setupInstructions: document.getElementById('setup-instructions'),
  
  // Search actions
  searchInput: document.getElementById('search-input'),
  searchResultsList: document.getElementById('search-results-list'),
  noResultsMsg: document.getElementById('no-results-msg')
};

// --- Helper Functions ---

// Get date string in Local YYYY-MM-DD format without timezone shift
function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Convert a YYYY-MM-DD string back to local Date object
function parseDateKey(dateStr) {
  const parts = dateStr.split('-');
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

// Format date nicely for header (e.g. "Tuesday, July 14, 2026")
function formatNiceDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

// Generate unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// Save entries to localStorage
function saveToStorage() {
  localStorage.setItem('aether_journal_entries', JSON.stringify(entries));
  updateStats();
  renderCalendar();
  
  // Trigger auto-sync if connected
  if (gdriveToken) {
    autoSync();
  }
}

// Load entries from localStorage
function loadFromStorage() {
  const data = localStorage.getItem('aether_journal_entries');
  if (data) {
    try {
      entries = JSON.parse(data);
      // Migrate old entries that do not have updatedAt
      let migrated = false;
      entries = entries.map(item => {
        if (!item.updatedAt) {
          item.updatedAt = item.createdAt || Date.now();
          migrated = true;
        }
        return item;
      });
      if (migrated) {
        localStorage.setItem('aether_journal_entries', JSON.stringify(entries));
      }
    } catch (e) {
      console.error('Error parsing localStorage data', e);
      entries = [];
    }
  } else {
    // Populate default helpful tutorial tasks for a brand new user
    entries = getTutorialEntries();
    localStorage.setItem('aether_journal_entries', JSON.stringify(entries));
  }
}

// Default items for first-time launch
function getTutorialEntries() {
  const todayKey = formatDateKey(new Date());
  const now = Date.now();
  return [
    {
      id: 'tut1',
      date: todayKey,
      type: 'task',
      text: 'Welcome to Aether Journal! This is a task. Click the dot to check it off.',
      status: 'pending',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'tut2',
      date: todayKey,
      type: 'event',
      text: 'Project launch day! Events are marked with a circle symbol (○).',
      status: 'pending',
      createdAt: now + 1,
      updatedAt: now + 1
    },
    {
      id: 'tut3',
      date: todayKey,
      type: 'note',
      text: 'Notes are marked with a dash (─). Click any text to edit it in place.',
      status: 'pending',
      createdAt: now + 2,
      updatedAt: now + 2
    },
    {
      id: 'tut4',
      date: todayKey,
      type: 'task',
      text: 'Set up Google Drive Sync in Settings to synchronize your data automatically.',
      status: 'pending',
      createdAt: now + 3,
      updatedAt: now + 3
    }
  ];
}

// --- Render Operations ---

// Render the Monthly Calendar
function renderCalendar() {
  DOM.calendarDays.innerHTML = '';
  
  const tempDate = new Date(currentYear, currentMonth, 1);
  DOM.currentMonthYear.textContent = tempDate.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  });
  
  const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay();
  const lastDay = new Date(currentYear, currentMonth + 1, 0).getDate();
  const prevLastDay = new Date(currentYear, currentMonth, 0).getDate();
  const todayStr = formatDateKey(new Date());
  const selectedStr = formatDateKey(selectedDate);
  
  // Create mapping of active (non-deleted) entries for quick lookups
  const entriesByDate = {};
  entries.forEach(entry => {
    if (entry.deleted) return;
    if (!entriesByDate[entry.date]) {
      entriesByDate[entry.date] = [];
    }
    entriesByDate[entry.date].push(entry);
  });
  
  // Render cells from previous month
  for (let i = firstDayIndex; i > 0; i--) {
    const day = prevLastDay - i + 1;
    const cell = document.createElement('div');
    cell.classList.add('day-cell', 'outside-month');
    cell.innerHTML = `<span class="day-num">${day}</span>`;
    DOM.calendarDays.appendChild(cell);
  }
  
  // Render active month cells
  for (let day = 1; day <= lastDay; day++) {
    const cellDate = new Date(currentYear, currentMonth, day);
    const dateStr = formatDateKey(cellDate);
    const cell = document.createElement('div');
    cell.classList.add('day-cell');
    cell.setAttribute('data-date', dateStr);
    
    if (dateStr === todayStr) cell.classList.add('today');
    if (dateStr === selectedStr) cell.classList.add('selected');
    
    const numSpan = document.createElement('span');
    numSpan.classList.add('day-num');
    numSpan.textContent = day;
    cell.appendChild(numSpan);
    
    const dayEntries = entriesByDate[dateStr] || [];
    if (dayEntries.length > 0) {
      const indicatorsDiv = document.createElement('div');
      indicatorsDiv.classList.add('day-indicators');
      
      const maxIndicators = 4;
      const shownEntries = dayEntries.slice(0, maxIndicators);
      
      shownEntries.forEach(entry => {
        const dot = document.createElement('span');
        dot.classList.add('ind-dot', entry.type);
        if (entry.type === 'task' && entry.status === 'completed') {
          dot.classList.remove('task');
          dot.classList.add('completed');
        }
        indicatorsDiv.appendChild(dot);
      });
      cell.appendChild(indicatorsDiv);
    }
    
    cell.addEventListener('click', () => {
      selectedDate = cellDate;
      renderCalendar();
      renderDailyLog();
      
      if (window.innerWidth <= 900) {
        DOM.appContainer.classList.remove('show-calendar');
        DOM.navCalendarToggle.classList.remove('active');
        DOM.navToday.classList.add('active');
      }
    });
    
    DOM.calendarDays.appendChild(cell);
  }
  
  const totalCellsRendered = firstDayIndex + lastDay;
  const trailingCells = 42 - totalCellsRendered;
  for (let i = 1; i <= trailingCells; i++) {
    const cell = document.createElement('div');
    cell.classList.add('day-cell', 'outside-month');
    cell.innerHTML = `<span class="day-num">${i}</span>`;
    DOM.calendarDays.appendChild(cell);
  }
  
  updateStats();
}

// Render Daily Journal Log List
function renderDailyLog() {
  const dateKey = formatDateKey(selectedDate);
  DOM.selectedDateTitle.textContent = formatNiceDate(selectedDate);
  
  const todayStr = formatDateKey(new Date());
  if (dateKey === todayStr) {
    DOM.selectedDateSubtitle.textContent = 'Today\'s Daily Log';
  } else {
    DOM.selectedDateSubtitle.textContent = 'Daily Log';
  }
  
  // Filter active entries (exclude tombstones)
  const dayEntries = entries
    .filter(e => e.date === dateKey && !e.deleted)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    
  DOM.journalEntriesList.innerHTML = '';
  
  if (dayEntries.length === 0) {
    DOM.journalEntriesList.innerHTML = `
      <div class="info-msg">
        <p>No entries for this day.</p>
        <p style="font-size: 0.75rem; margin-top: 0.5rem; color: var(--text-muted);">Jot down a task or note above to begin.</p>
      </div>
    `;
    return;
  }
  
  dayEntries.forEach(entry => {
    const li = document.createElement('li');
    li.classList.add('entry-item');
    li.setAttribute('data-id', entry.id);
    li.setAttribute('data-type', entry.type);
    li.setAttribute('data-status', entry.status || 'pending');
    
    let bulletChar = '•';
    if (entry.type === 'event') bulletChar = '○';
    if (entry.type === 'note') bulletChar = '─';
    if (entry.type === 'task' && entry.status === 'completed') bulletChar = '×';
    if (entry.type === 'task' && entry.status === 'migrated') bulletChar = '›';
    
    li.innerHTML = `
      <button class="bullet-btn" title="Toggle status">${bulletChar}</button>
      <div class="entry-content">
        <span class="entry-text" contenteditable="true" spellcheck="false">${escapeHtml(entry.text)}</span>
      </div>
      <button class="delete-entry-btn" title="Delete entry">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    `;
    
    // Toggle Status
    const bulletBtn = li.querySelector('.bullet-btn');
    bulletBtn.addEventListener('click', () => {
      toggleEntryStatus(entry.id);
    });
    
    // Inline Edit Text
    const textSpan = li.querySelector('.entry-text');
    textSpan.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        textSpan.blur();
      }
    });
    
    textSpan.addEventListener('blur', () => {
      const updatedText = textSpan.innerText.trim();
      if (updatedText === '') {
        deleteEntry(entry.id);
      } else if (updatedText !== entry.text) {
        updateEntryText(entry.id, updatedText);
      }
    });
    
    // Delete
    const deleteBtn = li.querySelector('.delete-entry-btn');
    deleteBtn.addEventListener('click', () => {
      deleteEntry(entry.id);
    });
    
    DOM.journalEntriesList.appendChild(li);
  });
}

// Update general stats (tasks completed, etc.)
function updateStats() {
  const activeTasks = entries.filter(e => e.type === 'task' && !e.deleted);
  const completed = activeTasks.filter(e => e.status === 'completed').length;
  const pending = activeTasks.length - completed;
  
  DOM.statCompletedCount.textContent = completed;
  DOM.statPendingCount.textContent = pending;
}

// --- Entry Operations ---

// Add a new entry to the active day
function addEntry(text, type) {
  const dateKey = formatDateKey(selectedDate);
  const now = Date.now();
  const newEntry = {
    id: generateId(),
    date: dateKey,
    type: type,
    text: text,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  };
  
  entries.push(newEntry);
  saveToStorage();
  renderDailyLog();
}

// Cycle status of tasks
function toggleEntryStatus(id) {
  const index = entries.findIndex(e => e.id === id);
  if (index === -1) return;
  
  const entry = entries[index];
  if (entry.type === 'task') {
    if (entry.status === 'pending') {
      entry.status = 'completed';
    } else if (entry.status === 'completed') {
      entry.status = 'migrated';
    } else {
      entry.status = 'pending';
    }
  } else if (entry.type === 'event') {
    entry.status = entry.status === 'completed' ? 'pending' : 'completed';
  } else {
    return;
  }
  
  entry.updatedAt = Date.now();
  saveToStorage();
  renderDailyLog();
}

// Update text in place
function updateEntryText(id, newText) {
  const index = entries.findIndex(e => e.id === id);
  if (index === -1) return;
  entries[index].text = newText;
  entries[index].updatedAt = Date.now();
  saveToStorage();
}

// Delete entry (tombstone pattern for sync)
function deleteEntry(id) {
  const index = entries.findIndex(e => e.id === id);
  if (index === -1) return;
  
  entries[index].deleted = true;
  entries[index].updatedAt = Date.now();
  saveToStorage();
  renderDailyLog();
}

// Helper to escape HTML tags
function escapeHtml(text) {
  const div = document.createElement('div');
  div.innerText = text;
  return div.innerHTML;
}

// --- Search Engine ---
function handleSearch(query) {
  DOM.searchResultsList.innerHTML = '';
  const cleanQuery = query.toLowerCase().trim();
  
  if (cleanQuery === '') {
    DOM.noResultsMsg.classList.add('hidden');
    return;
  }
  
  const matched = entries.filter(e => !e.deleted && e.text.toLowerCase().includes(cleanQuery));
  
  if (matched.length === 0) {
    DOM.noResultsMsg.classList.remove('hidden');
    return;
  }
  
  DOM.noResultsMsg.classList.add('hidden');
  
  matched.forEach(entry => {
    const li = document.createElement('li');
    li.classList.add('entry-item');
    li.style.cursor = 'pointer';
    
    let bulletChar = '•';
    if (entry.type === 'event') bulletChar = '○';
    if (entry.type === 'note') bulletChar = '─';
    if (entry.type === 'task' && entry.status === 'completed') bulletChar = '×';
    if (entry.type === 'task' && entry.status === 'migrated') bulletChar = '›';
    
    const displayDate = parseDateKey(entry.date).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    
    li.innerHTML = `
      <span class="bullet-symbol ${entry.type} ${entry.status === 'completed' ? 'completed' : ''}" style="margin-right: 0.5rem; font-size: 1.2rem;">${bulletChar}</span>
      <div class="entry-content">
        <span class="entry-text" style="text-decoration: ${entry.status === 'completed' ? 'line-through' : 'none'}; color: ${entry.status === 'completed' ? 'var(--text-muted)' : 'var(--text-main)'}">${escapeHtml(entry.text)}</span>
        <div class="entry-meta" style="margin-top: 0.25rem;">
          <span class="date-badge">${displayDate}</span>
        </div>
      </div>
    `;
    
    li.addEventListener('click', () => {
      selectedDate = parseDateKey(entry.date);
      currentMonth = selectedDate.getMonth();
      currentYear = selectedDate.getFullYear();
      
      renderCalendar();
      renderDailyLog();
      closeModals();
      
      if (window.innerWidth <= 900) {
        DOM.appContainer.classList.remove('show-calendar');
        DOM.navCalendarToggle.classList.remove('active');
        DOM.navToday.classList.add('active');
      }
    });
    
    DOM.searchResultsList.appendChild(li);
  });
}

// --- Modal Utilities ---
function openModal(modal) {
  modal.classList.add('active');
}

function closeModals() {
  DOM.settingsModal.classList.remove('active');
  DOM.searchModal.classList.remove('active');
}

// --- Data Export & Import ---

function exportData() {
  const dataStr = JSON.stringify(entries, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const tempLink = document.createElement('a');
  tempLink.href = url;
  tempLink.download = `aether_journal_backup_${formatDateKey(new Date())}.json`;
  document.body.appendChild(tempLink);
  tempLink.click();
  document.body.removeChild(tempLink);
  URL.revokeObjectURL(url);
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const importedEntries = JSON.parse(e.target.result);
      if (Array.isArray(importedEntries)) {
        const isValid = importedEntries.every(item => 
          item.id && item.date && item.type && item.text
        );
        
        if (isValid) {
          if (confirm('Importing this backup will overwrite your current logs. Proceed?')) {
            // Overwrite and set timestamps if missing
            entries = importedEntries.map(item => {
              if (!item.updatedAt) item.updatedAt = item.createdAt || Date.now();
              return item;
            });
            saveToStorage();
            renderCalendar();
            renderDailyLog();
            alert('Journal entries restored successfully!');
            closeModals();
          }
        } else {
          alert('Invalid backup file structure.');
        }
      } else {
        alert('Invalid backup file. Must be a JSON array.');
      }
    } catch (err) {
      alert('Error parsing JSON backup file.');
      console.error(err);
    }
  };
  reader.readAsText(file);
}

function clearAllData() {
  if (confirm('Are you absolutely sure you want to delete ALL journal logs? This cannot be undone.')) {
    entries = [];
    saveToStorage();
    renderCalendar();
    renderDailyLog();
    alert('All journal logs have been deleted.');
    closeModals();
  }
}

// ==========================================
// GOOGLE DRIVE SYNC ENGINE
// ==========================================

// Parse OAuth Access Token from URL redirect hash
function parseGoogleHash() {
  const hash = window.location.hash;
  if (!hash) return;
  
  const params = new URLSearchParams(hash.substring(1));
  const token = params.get('access_token');
  const error = params.get('error');
  
  if (error) {
    console.error('Google OAuth redirect error:', error);
    alert('Failed to connect to Google: ' + error);
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }
  
  if (token) {
    gdriveToken = token;
    // Cache token in sessionStorage (lasts as long as tab is open)
    sessionStorage.setItem('aether_gdrive_token', token);
    
    // Clear hash for clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
    
    setGDriveStatus('connected');
    console.log('Connected to Google Drive successfully!');
    
    // Trigger initial sync automatically
    syncWithGoogleDrive();
  }
}

// Set status on UI badge and icons
function setGDriveStatus(status) {
  syncStatus = status;
  
  // Reset classes
  DOM.gdriveStatus.className = 'status-badge';
  DOM.gdriveStatus.classList.add(status);
  
  if (status === 'disconnected') {
    DOM.gdriveStatus.textContent = 'Disconnected';
    DOM.gdriveConnectBtn.textContent = 'Connect Google Drive';
    DOM.gdriveConnectBtn.className = 'btn primary';
    DOM.gdriveSyncBtn.classList.add('hidden');
    DOM.syncIndicator.classList.add('hidden');
  } else if (status === 'connected') {
    DOM.gdriveStatus.textContent = 'Connected';
    DOM.gdriveConnectBtn.textContent = 'Disconnect';
    DOM.gdriveConnectBtn.className = 'btn secondary';
    DOM.gdriveSyncBtn.classList.remove('hidden');
    
    DOM.syncIndicator.classList.remove('hidden');
    DOM.syncIndicator.className = 'sync-indicator-icon';
    DOM.syncIndicator.classList.remove('syncing');
    DOM.syncIndicator.title = 'Connected to Google Drive';
  } else if (status === 'syncing') {
    DOM.gdriveStatus.textContent = 'Syncing...';
    DOM.gdriveSyncBtn.classList.remove('hidden');
    
    DOM.syncIndicator.classList.remove('hidden');
    DOM.syncIndicator.classList.add('syncing');
    DOM.syncIndicator.title = 'Synchronizing entries with Google Drive...';
  }
}

// Redirect to Google OAuth Consent Page
function connectGoogleDrive() {
  if (syncStatus !== 'disconnected') {
    // Sign out
    gdriveToken = null;
    sessionStorage.removeItem('aether_gdrive_token');
    setGDriveStatus('disconnected');
    alert('Disconnected from Google Drive.');
    return;
  }
  
  const clientId = DOM.gdriveClientIdInput.value.trim();
  if (!clientId) {
    alert('Please enter a Google Client ID first. Follow the setup guide below if you do not have one.');
    DOM.gdriveClientIdInput.focus();
    return;
  }
  
  // Save Client ID
  gdriveClientId = clientId;
  localStorage.setItem('aether_gdrive_client_id', clientId);
  
  // Build Google OAuth Request
  const redirectUri = window.location.origin + window.location.pathname;
  const oauthUrl = 'https://accounts.google.com/o/oauth2/v2/auth' +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=token` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}` +
    `&include_granted_scopes=true` +
    `&prompt=consent`;
    
  console.log('Redirecting to Google OAuth:', oauthUrl);
  window.location.href = oauthUrl;
}

// Auto-sync in background without popping alerts
let autoSyncTimeout = null;
function autoSync() {
  if (autoSyncTimeout) clearTimeout(autoSyncTimeout);
  autoSyncTimeout = setTimeout(() => {
    syncWithGoogleDrive(true);
  }, 2000); // Wait 2s after modifications to avoid spamming Google API
}

// Perform Google Drive Sync
async function syncWithGoogleDrive(isSilent = false) {
  if (!gdriveToken) return;
  
  setGDriveStatus('syncing');
  
  try {
    // 1. Search for backup file aether_journal_backup.json
    const searchUrl = "https://www.googleapis.com/drive/v3/files" +
      "?q=name='aether_journal_backup.json'+and+trashed=false" +
      "&fields=files(id)";
      
    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${gdriveToken}` }
    });
    
    if (searchRes.status === 401) {
      handleExpiredToken();
      return;
    }
    
    if (!searchRes.ok) {
      const errText = await searchRes.text();
      throw new Error(`Google API Search error: ${searchRes.status} ${searchRes.statusText} - ${errText}`);
    }
    
    const searchData = await searchRes.json();
    const file = searchData.files && searchData.files[0];
    const fileId = file ? file.id : null;
    
    let cloudEntries = [];
    
    // 2. Fetch cloud entries if file exists
    if (fileId) {
      const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${gdriveToken}` }
      });
      
      if (downloadRes.ok) {
        cloudEntries = await downloadRes.json();
      } else {
        const errText = await downloadRes.text();
        console.error('Failed to download cloud backup file:', errText);
        throw new Error(`Google API Download error: ${downloadRes.status} - ${errText}`);
      }
    }
    
    // 3. Merge Local and Cloud Entries
    const merged = mergeEntries(entries, cloudEntries);
    entries = merged;
    
    // Update local storage
    localStorage.setItem('aether_journal_entries', JSON.stringify(entries));
    
    // 4. Save/Upload Merged data back to Google Drive
    if (fileId) {
      // File exists: Update it via PATCH
      const updateRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${gdriveToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(entries)
      });
      
      if (!updateRes.ok) {
        const errText = await updateRes.text();
        throw new Error(`Google API Update error: ${updateRes.status} - ${errText}`);
      }
    } else {
      // File doesn't exist: Create it via Multipart POST
      const metadata = {
        name: 'aether_journal_backup.json',
        mimeType: 'application/json'
      };
      
      const boundary = 'AetherSyncBoundaryString';
      
      const multipartBody = 
        `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        `--${boundary}\r\n` +
        'Content-Type: application/json\r\n\r\n' +
        JSON.stringify(entries) + '\r\n' +
        `--${boundary}--`;
        
      const createRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${gdriveToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      });
      
      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`Google API Create error: ${createRes.status} - ${errText}`);
      }
    }
    
    setGDriveStatus('connected');
    renderCalendar();
    renderDailyLog();
    
    if (!isSilent) {
      alert('Google Drive sync complete! Devices are now aligned.');
    }
  } catch (err) {
    console.error('Google Drive Sync failed:', err);
    setGDriveStatus('connected');
    if (!isSilent) {
      alert('Sync failed: ' + err.message);
    }
  }
}

// Token expired handler
function handleExpiredToken() {
  gdriveToken = null;
  sessionStorage.removeItem('aether_gdrive_token');
  setGDriveStatus('disconnected');
  alert('Your Google login session expired. Please connect again.');
}

// Conflict Resolution: Merge lists by ID, keeping newer updatedAt.
// Discards tutorial entries if cloud data exists to prevent pollution.
function mergeEntries(localList, cloudList) {
  const hasCloudData = Array.isArray(cloudList) && cloudList.length > 0;
  const isLocalOnlyTutorials = localList.length > 0 && localList.every(item => item.id.startsWith('tut'));
  
  // If cloud data exists and we only have tutorial items locally, completely overwrite them
  if (hasCloudData && isLocalOnlyTutorials) {
    console.log('Local data is only tutorial entries. Overwriting with cloud backup.');
    return cloudList;
  }
  
  if (!Array.isArray(cloudList)) {
    // If no cloud data, filter out tutorial entries so they are not uploaded to cloud
    return localList.filter(item => !item.id.startsWith('tut'));
  }
  if (!Array.isArray(localList)) return cloudList;
  
  const map = new Map();
  
  // Process local items (exclude tutorial items from ever being merged into cloud)
  localList.forEach(item => {
    if (!item.id.startsWith('tut')) {
      map.set(item.id, { ...item });
    }
  });
  
  // Process cloud items, keeping the one with newer updatedAt
  cloudList.forEach(cloudItem => {
    if (cloudItem.id.startsWith('tut')) return; // Just in case a tutorial item leaked previously
    
    const localItem = map.get(cloudItem.id);
    if (!localItem) {
      map.set(cloudItem.id, { ...cloudItem });
    } else {
      const localTime = localItem.updatedAt || localItem.createdAt || 0;
      const cloudTime = cloudItem.updatedAt || cloudItem.createdAt || 0;
      
      if (cloudTime > localTime) {
        map.set(cloudItem.id, { ...cloudItem });
      }
    }
  });
  
  return Array.from(map.values());
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  
  // 1. Navigation Panel Switches
  DOM.navToday.addEventListener('click', () => {
    DOM.navToday.classList.add('active');
    DOM.navCalendarToggle.classList.remove('active');
    DOM.appContainer.classList.remove('show-calendar');
    
    selectedDate = new Date();
    currentMonth = selectedDate.getMonth();
    currentYear = selectedDate.getFullYear();
    renderCalendar();
    renderDailyLog();
  });
  
  DOM.navCalendarToggle.addEventListener('click', () => {
    DOM.navCalendarToggle.classList.add('active');
    DOM.navToday.classList.remove('active');
    DOM.appContainer.classList.add('show-calendar');
  });
  
  DOM.navSearch.addEventListener('click', () => {
    DOM.searchInput.value = '';
    DOM.searchResultsList.innerHTML = '';
    DOM.noResultsMsg.classList.add('hidden');
    openModal(DOM.searchModal);
    setTimeout(() => DOM.searchInput.focus(), 150);
  });
  
  DOM.navSettings.addEventListener('click', () => {
    openModal(DOM.settingsModal);
  });
  
  // 2. Calendar Month Switching
  DOM.prevMonthBtn.addEventListener('click', () => {
    currentMonth--;
    if (currentMonth < 0) {
      currentMonth = 11;
      currentYear--;
    }
    renderCalendar();
  });
  
  DOM.nextMonthBtn.addEventListener('click', () => {
    currentMonth++;
    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
    renderCalendar();
  });
  
  DOM.goToTodayBtn.addEventListener('click', () => {
    selectedDate = new Date();
    currentMonth = selectedDate.getMonth();
    currentYear = selectedDate.getFullYear();
    renderCalendar();
    renderDailyLog();
  });
  
  // 3. New Entry Creator Form
  DOM.newEntryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = DOM.entryTextInput.value.trim();
    const type = DOM.entryTypeSelect.value;
    
    if (text === '') return;
    
    addEntry(text, type);
    DOM.entryTextInput.value = '';
    DOM.entryTextInput.focus();
  });
  
  DOM.entryTypeSelect.addEventListener('change', (e) => {
    const selectedOption = e.target.options[e.target.selectedIndex];
    const symbol = selectedOption.getAttribute('data-symbol') || '•';
    DOM.selectIndicator.textContent = symbol;
    
    const colors = {
      task: 'var(--color-task)',
      event: 'var(--color-event)',
      note: 'var(--color-note)'
    };
    DOM.selectIndicator.style.color = colors[e.target.value] || 'var(--text-main)';
  });
  
  // 4. Modals close click
  DOM.closeModalBtns.forEach(btn => {
    btn.addEventListener('click', closeModals);
  });
  
  window.addEventListener('click', (e) => {
    if (e.target === DOM.settingsModal || e.target === DOM.searchModal) {
      closeModals();
    }
  });
  
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModals();
    }
  });
  
  // 5. Settings Modal Actions
  DOM.exportBackupBtn.addEventListener('click', exportData);
  DOM.importBackupFile.addEventListener('change', importData);
  DOM.clearAllDataBtn.addEventListener('click', clearAllData);
  
  // 6. Search Input Listener
  DOM.searchInput.addEventListener('input', (e) => {
    handleSearch(e.target.value);
  });
  
  // 7. PWA Installation Triggers
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    DOM.installBtn.classList.remove('hidden');
    console.log('beforeinstallprompt fired, showing install button');
  });
  
  DOM.installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User response to install prompt: ${outcome}`);
    deferredPrompt = null;
    DOM.installBtn.classList.add('hidden');
  });
  
  window.addEventListener('appinstalled', (evt) => {
    console.log('Aether Journal installed successfully!');
    DOM.installBtn.classList.add('hidden');
  });

  // 8. Google Drive Sync Listeners
  DOM.gdriveConnectBtn.addEventListener('click', connectGoogleDrive);
  
  DOM.gdriveSyncBtn.addEventListener('click', () => {
    syncWithGoogleDrive(false);
  });
  
  DOM.toggleInstructionsBtn.addEventListener('click', () => {
    DOM.setupInstructions.classList.toggle('hidden');
    DOM.toggleInstructionsBtn.textContent = DOM.setupInstructions.classList.contains('hidden') ? 
      'Show Google Setup Guide' : 'Hide Google Setup Guide';
  });
  
  // Save Client ID on change
  DOM.gdriveClientIdInput.addEventListener('change', (e) => {
    gdriveClientId = e.target.value.trim();
    localStorage.setItem('aether_gdrive_client_id', gdriveClientId);
  });
}

// --- Application Entry Point ---
function init() {
  loadFromStorage();
  setupEventListeners();
  
  // Prefill Client ID in UI
  if (gdriveClientId) {
    DOM.gdriveClientIdInput.value = gdriveClientId;
  }
  
  // Process Google OAuth redirect tokens (hash check)
  parseGoogleHash();
  
  // Retrieve token from sessionStorage if already authenticated
  const cachedToken = sessionStorage.getItem('aether_gdrive_token');
  if (cachedToken) {
    gdriveToken = cachedToken;
    setGDriveStatus('connected');
    // Background sync on app launch
    syncWithGoogleDrive(true);
  }
  
  renderCalendar();
  renderDailyLog();
}

window.addEventListener('DOMContentLoaded', init);
