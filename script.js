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

function saveTokenToCache(token, expiresInSeconds) {
  accessToken = token;
  const expirationTime = Date.now() + (expiresInSeconds * 1000) - 60000;
  localStorage.setItem('bujo_gdrive_token', token);
  localStorage.setItem('bujo_gdrive_token_exp', expirationTime.toString());
}

function loadCachedToken() {
  const cachedToken = localStorage.getItem('bujo_gdrive_token');
  const cachedExp = localStorage.getItem('bujo_gdrive_token_exp');

  if (cachedToken && cachedExp) {
    if (Date.now() < parseInt(cachedExp, 10)) {
      accessToken = cachedToken;
      console.log("Valid cached access token restored.");
      return true;
    } else {
      console.log("Cached access token has expired.");
      localStorage.removeItem('bujo_gdrive_token');
      localStorage.removeItem('bujo_gdrive_token_exp');
    }
  }
  return false;
}

// ==========================================
// 3. GOOGLE IDENTITY SERVICES INITIALIZATION
// ==========================================

function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (tokenResponse) => {
      if (tokenResponse.error) {
        console.error('Authentication Error:', tokenResponse);
        syncBtn.textContent = '❌ Auth Failed';
        syncBtn.disabled = false;
        return;
      }
      
      const expiresIn = tokenResponse.expires_in || 3600;
      saveTokenToCache(tokenResponse.access_token, expiresIn);
      
      console.log("Google Authentication successful. Token cached.");
      syncBtn.textContent = '🔄 Syncing...';
      syncBtn.disabled = true;
      
      await downloadAndMergeFromDrive();
    },
  });

  syncBtn.disabled = false;

  if (loadCachedToken()) {
    syncBtn.textContent = '✅ Connected (Drive)';
  }
}

syncBtn.addEventListener('click', () => {
  if (!tokenClient) return;

  if (loadCachedToken()) {
    syncBtn.textContent = '🔄 Syncing...';
    syncBtn.disabled = true;
    downloadAndMergeFromDrive();
  } else {
    const hasConsented = localStorage.getItem('bujo_gdrive_consented') === 'true';
    localStorage.setItem('bujo_gdrive_consented', 'true');
    
    tokenClient.requestAccessToken({ prompt: hasConsented ? '' : 'consent' });
  }
});

// ==========================================
// 4. IMPROVED GOOGLE DRIVE REST OPERATIONS
// ==========================================

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
      
      journalData = mergeJournalData(journalData, cloudData);
      localStorage.setItem('bujo_data', JSON.stringify(journalData));
      
      await uploadToDrive();
      
      renderAllViews();
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

function mergeJournalData(local, cloud) {
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
        const isDeleted = Boolean(localItem.deleted || cloudItem.deleted);

        itemMap.set(key, {
          ...localItem,
          text: cloudItem.text || localItem.text,
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

async function uploadToDrive() {
  if (!accessToken) return;

  if (driveFileId) {
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
// 5. CORE APPLICATION STATE & HELPERS
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

function saveData() {
  localStorage.setItem('bujo_data', JSON.stringify(journalData));
  if (loadCachedToken()) {
    uploadToDrive();
  }
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
  return sequence[(currentIndex + 1) % sequence.length];
}

function renderAllViews() {
  renderCalendar();
  renderMonthlyTasks();
  renderDailyTasks();
  renderAtAGlanceEvents();
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

  const activeTasks = tasks.filter(task => !task.deleted);

  activeTasks.forEach((task) => {
    const li = createTaskElement(
      task,
      () => {
        task.status = getNextStatus(task.status);
        saveData();
        renderMonthlyTasks();
      },
      () => {
        task.deleted = true;
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
        saveData();
        renderDailyTasks();
        renderAtAGlanceEvents();
      },
      () => {
        task.deleted = true;
        saveData();
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

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Delete Event';
      deleteBtn.addEventListener('click', () => {
        event.deleted = true;
        saveData();
        renderAllViews();
      });

      let isEditing = false;

      editBtn.addEventListener('click', () => {
        if (!isEditing) {
          isEditing = true;
          editBtn.textContent = '💾';
          editBtn.title = 'Save Changes';

          const editInput = document.createElement('textarea');
          editInput.className = 'edit-input';
          editInput.rows = 1;
          editInput.value = event.text;

          leftDiv.replaceChild(editInput, textSpan);
          autoResizeTextarea(editInput);
          editInput.focus();

          editInput.addEventListener('input', () => autoResizeTextarea(editInput));

          const commitEdit = () => {
            const newText = editInput.value.trim();
            if (newText && newText !== event.text) {
              event.text = newText;
              saveData();
              renderAllViews();
            } else {
              textSpan.textContent = event.text;
              if (leftDiv.contains(editInput)) {
                leftDiv.replaceChild(textSpan, editInput);
              }
              editBtn.textContent = '✏️';
              editBtn.title = 'Edit Event';
              isEditing = false;
            }
          };

          editInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitEdit();
            }
          });
        } else {
          const editInput = leftDiv.querySelector('.edit-input');
          if (editInput) {
            const newText = editInput.value.trim();
            if (newText && newText !== event.text) {
              event.text = newText;
              saveData();
              renderAllViews();
            } else {
              textSpan.textContent = event.text;
              leftDiv.replaceChild(textSpan, editInput);
              editBtn.textContent = '✏️';
              editBtn.title = 'Edit Event';
              isEditing = false;
            }
          }
        }
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

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Delete Entry';
  deleteBtn.addEventListener('click', onDelete);

  let isEditing = false;

  editBtn.addEventListener('click', () => {
    if (!isEditing) {
      isEditing = true;
      editBtn.textContent = '💾';
      editBtn.title = 'Save Changes';

      const editInput = document.createElement('textarea');
      editInput.className = 'edit-input';
      editInput.rows = 1;
      editInput.value = item.text;

      leftDiv.replaceChild(editInput, textSpan);
      autoResizeTextarea(editInput);
      editInput.focus();

      editInput.addEventListener('input', () => autoResizeTextarea(editInput));

      const commitEdit = () => {
        const newText = editInput.value.trim();
        if (newText && newText !== item.text) {
          item.text = newText;
          onSaveText();
        } else {
          textSpan.textContent = item.text;
          if (leftDiv.contains(editInput)) {
            leftDiv.replaceChild(textSpan, editInput);
          }
          editBtn.textContent = '✏️';
          editBtn.title = 'Edit Entry';
          isEditing = false;
        }
      };

      editInput.addEventListener('keydown', (e) => {
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
          onSaveText();
        } else {
          textSpan.textContent = item.text;
          leftDiv.replaceChild(textSpan, editInput);
          editBtn.textContent = '✏️';
          editBtn.title = 'Edit Entry';
          isEditing = false;
        }
      }
    }
  });

  actionsDiv.appendChild(editBtn);
  actionsDiv.appendChild(deleteBtn);

  li.appendChild(leftDiv);
  li.appendChild(actionsDiv);

  return li;
}

function changeMonth(delta) {
  currentDate.setMonth(currentDate.getMonth() + delta);
  
  const isCurrentMonth = currentDate.getFullYear() === new Date().getFullYear() &&
                         currentDate.getMonth() === new Date().getMonth();

  if (isCurrentMonth) {
    selectedDateStr = todayStr;
  } else {
    selectedDateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`;
  }

  renderAllViews();
}

// NEW: Shifts selectedDateStr forward (+1) or backward (-1) by days
function changeDay(delta) {
  const [year, month, day] = selectedDateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  dateObj.setDate(dateObj.getDate() + delta);

  selectedDateStr = formatDateKey(dateObj);

  // If new date moves to a different month/year, update calendar currentDate to match
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

// New Daily Navigation Event Listeners
document.getElementById('prev-day').addEventListener('click', () => changeDay(-1));
document.getElementById('next-day').addEventListener('click', () => changeDay(1));

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

  journalData.monthly[monthKey].push({ id: Date.now(), text: text, status: 'todo', deleted: false });
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

  journalData.daily[selectedDateStr].push({ id: Date.now(), text: text, status: 'todo', deleted: false });
  saveData();
  resetTextareaHeight(dailyInput);
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

  journalData.daily[targetDateStr].push({ id: Date.now(), text: text, status: 'event', deleted: false });
  
  saveData();
  resetTextareaHeight(glanceInput);
  renderDailyTasks();
  renderAtAGlanceEvents();
});

// Initial Master Render
renderAllViews();
