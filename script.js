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
// 2. GOOGLE IDENTITY SERVICES INITIALIZATION
// ==========================================

function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (tokenResponse) => {
      if (tokenResponse.error) {
        console.error('Authentication Error:', tokenResponse);
        syncBtn.textContent = '❌ Auth Failed';
        return;
      }
      
      accessToken = tokenResponse.access_token;
      console.log("Google Authentication successful. Access token received.");
      
      syncBtn.textContent = '🔄 Syncing...';
      syncBtn.disabled = true;
      
      await downloadAndMergeFromDrive();
    },
  });

  syncBtn.disabled = false;
}

syncBtn.addEventListener('click', () => {
  if (!tokenClient) return;
  tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
});

// ==========================================
// 3. IMPROVED GOOGLE DRIVE REST OPERATIONS
// ==========================================

// Search appDataFolder and download or create the journal file
async function downloadAndMergeFromDrive() {
  try {
    const query = encodeURIComponent("name='bujo_data.json' and trashed=false");
    const listUrl = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`;
    
    const response = await fetch(listUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const data = await response.json();

    if (!response.ok) {
      console.error("Google Drive List Error:", data);
      syncBtn.textContent = `❌ Error ${response.status}`;
      syncBtn.disabled = false;
      return;
    }
    
    if (data.files && data.files.length > 0) {
      driveFileId = data.files[0].id;
      console.log(`Found existing file in appDataFolder. File ID: ${driveFileId}`);
      
      const fileUrl = `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`;
      const fileResponse = await fetch(fileUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!fileResponse.ok) {
        console.error("Error downloading file contents:", await fileResponse.json());
        syncBtn.textContent = '❌ Download Error';
        syncBtn.disabled = false;
        return;
      }

      const cloudData = await fileResponse.json();
      console.log("Downloaded cloud data successfully:", cloudData);
      
      // Merge cloud entries with local entries (preserving tombstone deletions)
      journalData = mergeJournalData(journalData, cloudData);
      localStorage.setItem('bujo_data', JSON.stringify(journalData));
      
      // Save unified data back to Drive
      await uploadToDrive();
      
      renderMonthlyTasks();
      renderDailyTasks();
    } else {
      console.log("No existing file found. Creating new file in appDataFolder...");
      await uploadToDrive();
    }
  } catch (err) {
    console.error("Network error during Drive sync:", err);
    syncBtn.textContent = '❌ Sync Failed';
    syncBtn.disabled = false;
  }
}

// Smart merger function combining local and cloud datasets using Tombstones
function mergeJournalData(local, cloud) {
  const merged = { monthly: {}, daily: {} };

  function mergeLists(localList = [], cloudList = []) {
    const itemMap = new Map();

    // 1. Add all local items
    localList.forEach(item => {
      const key = item.id || item.text;
      itemMap.set(key, { ...item });
    });

    // 2. Combine cloud items
    cloudList.forEach(cloudItem => {
      const key = cloudItem.id || cloudItem.text;
      if (!itemMap.has(key)) {
        itemMap.set(key, { ...cloudItem });
      } else {
        const localItem = itemMap.get(key);
        // CRITICAL FIX: If deleted in EITHER local OR cloud, mark as deleted!
        const isDeleted = Boolean(localItem.deleted || cloudItem.deleted);

        itemMap.set(key, {
          ...localItem,
          status: cloudItem.status || localItem.status,
          deleted: isDeleted
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

// Upload journal data to Google Drive
async function uploadToDrive() {
  if (!accessToken) return;

  if (driveFileId) {
    // UPDATE EXISTING FILE: Simple media PATCH request
    try {
      const url = `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`;
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `application/json`
        },
        body: JSON.stringify(journalData)
      });

      const result = await response.json();

      if (!response.ok) {
        console.error("Google Drive Update Error Details:", result);
        syncBtn.textContent = `❌ Update Error ${response.status}`;
        syncBtn.disabled = false;
        return;
      }

      console.log(`Successfully updated file in Drive! ID: ${driveFileId}`);
      syncBtn.textContent = '✅ Synced to Drive';
      syncBtn.disabled = false;
    } catch (err) {
      console.error("Network upload error:", err);
      syncBtn.textContent = '❌ Upload Failed';
      syncBtn.disabled = false;
    }
  } else {
    // CREATE NEW FILE: Multipart POST request
    try {
      const metadata = {
        name: 'bujo_data.json',
        mimeType: 'application/json',
        parents: ['appDataFolder']
      };

      const boundary = 'bujo_multipart_boundary';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const multipartBodyParts = [
        delimiter,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(metadata),
        delimiter,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(journalData),
        closeDelimiter
      ];

      const bodyBlob = new Blob(multipartBodyParts, {
        type: `multipart/related; boundary=${boundary}`
      });

      const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: bodyBlob
      });

      const result = await response.json();

      if (!response.ok) {
        console.error("Google Drive Create Error Details:", result);
        syncBtn.textContent = `❌ Create Error ${response.status}`;
        syncBtn.disabled = false;
        return;
      }

      if (result.id) {
        driveFileId = result.id;
        console.log(`Successfully created file in Drive! ID: ${driveFileId}`);
        syncBtn.textContent = '✅ Synced to Drive';
        syncBtn.disabled = false;
      }
    } catch (err) {
      console.error("Network create error:", err);
      syncBtn.textContent = '❌ Create Failed';
      syncBtn.disabled = false;
    }
  }
}

// ==========================================
// 4. CORE APPLICATION STATE & HELPERS
// ==========================================
let currentDate = new Date();
let selectedDateStr = formatDateKey(new Date());
const todayStr = formatDateKey(new Date());

let journalData = JSON.parse(localStorage.getItem('bujo_data')) || {
  monthly: {},
  daily: {}    
};

const monthYearDisplay = document.getElementById('month-year-display');
const calendarGrid = document.getElementById('calendar-grid');
const selectedDateDisplay = document.getElementById('selected-date-display');
const monthlyForm = document.getElementById('monthly-form');
const monthlyInput = document.getElementById('monthly-input');
const monthlyList = document.getElementById('monthly-list');
const dailyForm = document.getElementById('daily-form');
const dailyInput = document.getElementById('daily-input');
const dailyList = document.getElementById('daily-list');

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

function saveData() {
  localStorage.setItem('bujo_data', JSON.stringify(journalData));
  uploadToDrive();
}

function getSymbol(status) {
  switch (status) {
    case 'todo': return '•';
    case 'done': return '✓';
    case 'migrated': return '>';
    case 'note': return '–';
    default: return '•';
  }
}

function getNextStatus(currentStatus) {
  const sequence = ['todo', 'done', 'migrated', 'note'];
  const currentIndex = sequence.indexOf(currentStatus);
  return sequence[(currentIndex + 1) % sequence.length];
}

// ==========================================
// 5. RENDERING LOGIC
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
    const dayCell = document.createElement('div');
    dayCell.classList.add('day-cell');

    const dateObj = new Date(year, month, day);
    const weekdayAbbr = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
    const cellDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    dayCell.innerHTML = `
      <span class="weekday-tag">${weekdayAbbr}</span>
      <span class="day-num">${day}</span>
    `;
    
    if (cellDateStr === selectedDateStr) {
      dayCell.classList.add('active');
    }

    if (cellDateStr === todayStr) {
      dayCell.classList.add('today');
    }

    dayCell.addEventListener('click', () => {
      selectedDateStr = cellDateStr;
      renderCalendar();
      renderDailyTasks();
    });

    calendarGrid.appendChild(dayCell);
  }
}

function renderMonthlyTasks() {
  monthlyList.innerHTML = '';
  const monthKey = formatMonthKey(currentDate);
  const tasks = journalData.monthly[monthKey] || [];

  // Filter out any tombstoned/deleted entries
  const activeTasks = tasks.filter(task => !task.deleted);

  activeTasks.forEach((task) => {
    const li = createTaskElement(task, () => {
      task.status = getNextStatus(task.status);
      saveData();
      renderMonthlyTasks();
    }, () => {
      // Soft-delete task (set tombstone)
      task.deleted = true;
      saveData();
      renderMonthlyTasks();
    });
    monthlyList.appendChild(li);
  });
}

function renderDailyTasks() {
  selectedDateDisplay.textContent = formatFriendlyDate(selectedDateStr);
  dailyList.innerHTML = '';
  const tasks = journalData.daily[selectedDateStr] || [];

  // Filter out any tombstoned/deleted entries
  const activeTasks = tasks.filter(task => !task.deleted);

  activeTasks.forEach((task) => {
    const li = createTaskElement(task, () => {
      task.status = getNextStatus(task.status);
      saveData();
      renderDailyTasks();
    }, () => {
      // Soft-delete task (set tombstone)
      task.deleted = true;
      saveData();
      renderDailyTasks();
    });
    dailyList.appendChild(li);
  });
}

function createTaskElement(item, onToggleSymbol, onDelete) {
  const li = document.createElement('li');
  li.className = `task-item status-${item.status}`;

  const leftDiv = document.createElement('div');
  leftDiv.className = 'task-left';

  const symbolBtn = document.createElement('button');
  symbolBtn.className = 'symbol-btn';
  symbolBtn.textContent = getSymbol(item.status);
  symbolBtn.addEventListener('click', onToggleSymbol);

  const textSpan = document.createElement('span');
  textSpan.className = 'text';
  textSpan.textContent = item.text;

  leftDiv.appendChild(symbolBtn);
  leftDiv.appendChild(textSpan);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '✕';
  deleteBtn.addEventListener('click', onDelete);

  li.appendChild(leftDiv);
  li.appendChild(deleteBtn);

  return li;
}

function changeMonth(delta) {
  currentDate.setMonth(currentDate.getMonth() - 1 + delta + 1); // standard month math
  
  const isCurrentMonth = currentDate.getFullYear() === new Date().getFullYear() &&
                         currentDate.getMonth() === new Date().getMonth();

  if (isCurrentMonth) {
    selectedDateStr = todayStr;
  } else {
    selectedDateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`;
  }

  renderCalendar();
  renderMonthlyTasks();
  renderDailyTasks();
}

// ==========================================
// 6. EVENT LISTENERS & INITIALIZATION
// ==========================================

document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
document.getElementById('next-month').addEventListener('click', () => changeMonth(1));

monthlyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = monthlyInput.value.trim();
  if (!text) return;

  const monthKey = formatMonthKey(currentDate);
  if (!journalData.monthly[monthKey]) {
    journalData.monthly[monthKey] = [];
  }

  journalData.monthly[monthKey].push({ id: Date.now(), text: text, status: 'todo', deleted: false });
  saveData();
  monthlyInput.value = '';
  renderMonthlyTasks();
});

dailyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = dailyInput.value.trim();
  if (!text) return;

  if (!journalData.daily[selectedDateStr]) {
    journalData.daily[selectedDateStr] = [];
  }

  journalData.daily[selectedDateStr].push({ id: Date.now(), text: text, status: 'todo', deleted: false });
  saveData();
  dailyInput.value = '';
  renderDailyTasks();
});

// Initial renders
renderCalendar();
renderMonthlyTasks();
renderDailyTasks();
