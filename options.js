const STORAGE_KEYS = {
  SETTINGS: "snaplite_settings",
  HISTORY: "snaplite_history"
};

const DEFAULT_SETTINGS = {
  defaultMode: "area",
  format: "png",
  keepHistory: true,
  historyLimit: 20,
  hideFixedStickyInFullCapture: true,
  uploadEnabled: false,
  uploadConfig: {
    endpoint: "",
    token: ""
  }
};

const refs = {
  defaultMode: document.getElementById("defaultMode"),
  format: document.getElementById("format"),
  keepHistory: document.getElementById("keepHistory"),
  historyLimit: document.getElementById("historyLimit"),
  hideFixedStickyInFullCapture: document.getElementById("hideFixedStickyInFullCapture"),
  uploadEnabled: document.getElementById("uploadEnabled"),
  uploadEndpoint: document.getElementById("uploadEndpoint"),
  uploadToken: document.getElementById("uploadToken"),
  msg: document.getElementById("msg")
};

document.getElementById("saveBtn").addEventListener("click", save);
document.getElementById("resetBtn").addEventListener("click", reset);
document.getElementById("openShortcutPage").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

void init();
void loadShortcuts();

async function init() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
  refs.defaultMode.value = settings.defaultMode;
  refs.format.value = settings.format;
  refs.keepHistory.checked = Boolean(settings.keepHistory);
  refs.historyLimit.value = String(settings.historyLimit || 20);
  refs.hideFixedStickyInFullCapture.checked = settings.hideFixedStickyInFullCapture !== false;
  refs.uploadEnabled.checked = Boolean(settings.uploadEnabled);
  refs.uploadEndpoint.value = settings.uploadConfig?.endpoint || "";
  refs.uploadToken.value = settings.uploadConfig?.token || "";
}

async function save() {
  const settings = {
    defaultMode: refs.defaultMode.value,
    format: refs.format.value,
    keepHistory: refs.keepHistory.checked,
    historyLimit: Math.min(100, Math.max(1, Number(refs.historyLimit.value || 20))),
    hideFixedStickyInFullCapture: refs.hideFixedStickyInFullCapture.checked,
    uploadEnabled: refs.uploadEnabled.checked,
    uploadConfig: {
      endpoint: refs.uploadEndpoint.value.trim(),
      token: refs.uploadToken.value.trim()
    }
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  await trimHistory(settings.historyLimit);
  setMessage("已保存");
}

async function reset() {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  await init();
  setMessage("已恢复默认设置");
}

async function trimHistory(limit) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  const history = data[STORAGE_KEYS.HISTORY] || [];
  if (history.length <= limit) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: history.slice(0, limit) });
}

function setMessage(text) {
  refs.msg.textContent = text;
  setTimeout(() => {
    if (refs.msg.textContent === text) refs.msg.textContent = "";
  }, 1500);
}

const COMMAND_LABELS = {
  "capture-area": "区域截图",
  "capture-visible": "可视区域截图",
  "capture-full": "整页截图"
};

const SUGGESTED_KEYS = {
  "capture-area": { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
  "capture-visible": { default: "Ctrl+Shift+V", mac: "Command+Shift+V" },
  "capture-full": { default: "Alt+Shift+F", mac: "Alt+Shift+F" }
};

async function loadShortcuts() {
  const container = document.getElementById("shortcutList");
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  try {
    const commands = await chrome.commands.getAll();
    container.innerHTML = "";
    const relevant = commands.filter((c) => COMMAND_LABELS[c.name]);
    if (!relevant.length) {
      container.innerHTML = '<div class="shortcut-loading">暂无快捷键</div>';
      return;
    }
    for (const cmd of relevant) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const name = document.createElement("span");
      name.className = "shortcut-name";
      name.textContent = COMMAND_LABELS[cmd.name] || cmd.description || cmd.name;
      row.appendChild(name);

      const shortcut = cmd.shortcut || (SUGGESTED_KEYS[cmd.name] && (isMac ? SUGGESTED_KEYS[cmd.name].mac : SUGGESTED_KEYS[cmd.name].default));
      const keyWrap = document.createElement("span");
      if (shortcut) {
        keyWrap.className = "shortcut-key";
        keyWrap.innerHTML = formatShortcut(shortcut);
        if (!cmd.shortcut) {
          const hint = document.createElement("span");
          hint.className = "shortcut-unset";
          hint.textContent = "（需在浏览器中激活）";
          keyWrap.appendChild(hint);
        }
      } else {
        keyWrap.className = "shortcut-unset";
        keyWrap.textContent = "未设置";
      }
      row.appendChild(keyWrap);
      container.appendChild(row);
    }
  } catch (_e) {
    container.innerHTML = '<div class="shortcut-loading">加载失败</div>';
  }
}

function formatShortcut(shortcut) {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const keyMap = isMac
    ? { "Ctrl": "⌃", "Command": "⌘", "Alt": "⌥", "Shift": "⇧", "MacCtrl": "⌃" }
    : { "Ctrl": "Ctrl", "Command": "Win", "Alt": "Alt", "Shift": "Shift" };
  return shortcut
    .split("+")
    .map((k) => `<kbd>${keyMap[k] || k}</kbd>`)
    .join('<span class="plus">+</span>');
}
