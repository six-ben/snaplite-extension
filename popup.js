const STORAGE_KEYS = {
  SETTINGS: "snaplite_settings"
};

const DEFAULT_SETTINGS = {
  defaultMode: "area"
};
const msgEl = document.getElementById("msg");

document.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.getAttribute("data-mode");
    void startCapture(mode);
  });
});

document.getElementById("defaultCapture").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
  await startCapture(settings.defaultMode || "area");
});

document.getElementById("openSettings").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "snaplite:open-settings" });
  window.close();
});

document.getElementById("openHistory").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
  window.close();
});

async function startCapture(mode) {
  let [targetTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!targetTab) {
    [targetTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  const tabId = targetTab?.id;

  if (!tabId) {
    showMessage(getErrorMessage("NO_ACTIVE_TAB"));
    return;
  }

  if (isUnsupportedUrl(targetTab.url)) {
    showMessage(getErrorMessage("CAPTURE_PAGE_UNSUPPORTED"));
    return;
  }

  const res = await chrome.runtime.sendMessage({ type: "snaplite:start-capture", mode, tabId });
  if (!res?.ok) {
    showMessage(getErrorMessage(res?.error));
    return;
  }
  window.close();
}

function isUnsupportedUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return ["chrome://", "chrome-extension://", "chrome-search://", "devtools://", "edge://", "about:", "view-source:"]
    .some((p) => lower.startsWith(p));
}

function showMessage(text) {
  msgEl.textContent = text;
}

void loadShortcuts();

const SUGGESTED_KEYS = {
  "capture-area": { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
  "capture-visible": { default: "Ctrl+Shift+V", mac: "Command+Shift+V" },
  "capture-full": { default: "Alt+Shift+F", mac: "Alt+Shift+F" }
};

async function loadShortcuts() {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  try {
    const commands = await chrome.commands.getAll();
    for (const cmd of commands) {
      const el = document.querySelector(`.shortcut[data-cmd="${cmd.name}"]`);
      if (!el) continue;
      const key = cmd.shortcut || (SUGGESTED_KEYS[cmd.name] && (isMac ? SUGGESTED_KEYS[cmd.name].mac : SUGGESTED_KEYS[cmd.name].default));
      if (key) el.textContent = formatKey(key, isMac);
    }
  } catch (_e) {
    const isMac2 = navigator.platform.toUpperCase().includes("MAC");
    for (const [name, keys] of Object.entries(SUGGESTED_KEYS)) {
      const el = document.querySelector(`.shortcut[data-cmd="${name}"]`);
      if (el) el.textContent = formatKey(isMac2 ? keys.mac : keys.default, isMac2);
    }
  }
}

function formatKey(shortcut, isMac) {
  const map = isMac
    ? { "Ctrl": "⌃", "Command": "⌘", "Alt": "⌥", "Shift": "⇧", "MacCtrl": "⌃" }
    : {};
  return shortcut.split("+").map((k) => map[k] || k).join(isMac ? "" : "+");
}

function getErrorMessage(code) {
  const table = {
    NO_ACTIVE_TAB: "当前没有可截图的标签页",
    CAPTURE_PAGE_UNSUPPORTED: "当前页面受浏览器限制，请在普通网页中使用",
    DOM_CAPTURE_NOT_AVAILABLE: "DOM 截图不可用，请在普通网页中使用",
    AREA_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE: "当前页面不支持区域截图",
    FULL_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE: "当前页面不支持整页截图",
    FULL_CAPTURE_PAGE_INFO_FAILED: "整页截图初始化失败，请重试",
    FULL_CAPTURE_SCROLL_FAILED: "整页滚动失败，请重试",
    FULL_CAPTURE_BITMAP_FAILED: "页面图像处理失败，请重试",
    FULL_CAPTURE_CAPTURE_FAILED: "页面截取失败，请重试",
    FULL_CAPTURE_STITCH_FAILED: "页面拼接失败，可尝试关闭整页兼容开关后重试",
    CAPTURE_PERMISSION_DENIED: "截图权限受限，请检查浏览器权限",
    UNKNOWN_MODE: "未知截图模式",
    UNKNOWN_MESSAGE: "未知请求"
  };
  return table[code] || `截图失败：${code || "unknown"}`;
}
