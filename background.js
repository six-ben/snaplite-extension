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

const STORAGE_KEYS = {
  SETTINGS: "snaplite_settings",
  LATEST: "snaplite_latest_capture",
  HISTORY: "snaplite_history"
};
const MAX_FULL_CAPTURE_PIXELS = 32_000_000;
const MAX_CANVAS_DIMENSION = 8192;

const log = (...args) => console.log("[SnapLite]", ...args);
const logError = (...args) => console.error("[SnapLite]", ...args);

chrome.runtime.onInstalled.addListener(async () => {
  log("onInstalled");
  const existing = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!existing[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  await ensureContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  log("onStartup");
  void ensureContextMenus();
});

void ensureContextMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  log("contextMenu clicked:", info.menuItemId, "tab:", tab.id, "url:", tab.url);
  try {
    if (info.menuItemId === "snaplite-capture-area") {
      await startAreaCapture(tab.id);
    } else if (info.menuItemId === "snaplite-capture-visible") {
      await startVisibleCapture(tab.id);
    } else if (info.menuItemId === "snaplite-capture-full") {
      await startFullPageCapture(tab.id);
    }
  } catch (err) {
    logError("context-menu capture failed:", err.message);
    notifyUser(tab.id, err.message);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  log("command:", command);
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    if (command === "capture-area") {
      await startAreaCapture(tab.id);
    } else if (command === "capture-visible") {
      await startVisibleCapture(tab.id);
    } else if (command === "capture-full") {
      await startFullPageCapture(tab.id);
    }
  } catch (err) {
    logError("command capture failed:", err.message);
    notifyUser(tab.id, err.message);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      if (message?.type === "snaplite:start-capture") {
        let tabId = message.tabId;
        log("start-capture mode:", message.mode, "tabId:", tabId);
        if (!tabId) {
          const tab = await getActiveTab();
          if (!tab?.id) throw new Error("NO_ACTIVE_TAB");
          tabId = tab.id;
          log("fallback tabId from getActiveTab:", tabId);
        }
        const tab = await chrome.tabs.get(tabId);
        if (isUnsupportedPageUrl(tab.url)) {
          log("page unsupported:", tab.url);
          sendResponse({ ok: false, error: "CAPTURE_PAGE_UNSUPPORTED" });
          return;
        }
        const mode = message.mode;
        if (mode === "area" || mode === "dom") {
          await routeCapture(mode, tabId);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: true });
          routeCapture(mode, tabId).catch((err) => {
            logError(mode, "capture failed:", err.message);
            notifyUser(tabId, err.message);
          });
        }
        return;
      }

      if (message?.type === "snaplite:area-selected" || message?.type === "snaplite:dom-selected") {
        const tabId = sender.tab?.id;
        log(message.type, "from tab:", tabId, "rect:", JSON.stringify(message.payload?.rect));
        if (!tabId) throw new Error("NO_TAB");
        await completeAreaCapture(tabId, message.payload);
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "snaplite:open-settings") {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
    } catch (error) {
      logError("onMessage error:", error.message);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true;
});

async function routeCapture(mode, tabId) {
  log("routeCapture:", mode, "tabId:", tabId);
  if (mode === "visible") return startVisibleCapture(tabId);
  if (mode === "area") return startAreaCapture(tabId);
  if (mode === "full") return startFullPageCapture(tabId);
  if (mode === "dom") return startDomCapture(tabId);
  throw new Error("UNKNOWN_MODE");
}

async function startVisibleCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  log("startVisibleCapture tab:", tabId, "url:", tab.url, "windowId:", tab.windowId);
  if (isUnsupportedPageUrl(tab.url)) {
    throw new Error("CAPTURE_PAGE_UNSUPPORTED");
  }
  try {
    const dataUrl = await captureWithRetry(tab.windowId, 2);
    log("visible capture ok, dataUrl length:", dataUrl.length);
    await saveLatestAndOpenEditor({
      mode: "visible",
      imageDataUrl: dataUrl,
      sourceUrl: tab.url || "",
      sourceTitle: tab.title || "Untitled",
      createdAt: Date.now()
    });
  } catch (err) {
    logError("startVisibleCapture failed:", err.message);
    throw new Error("CAPTURE_PERMISSION_DENIED");
  }
}

async function startAreaCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  log("startAreaCapture tab:", tabId, "url:", tab.url);
  if (isUnsupportedPageUrl(tab.url)) {
    throw new Error("CAPTURE_PAGE_UNSUPPORTED");
  }
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "snaplite:start-area-select" });
    log("area select overlay injected");
  } catch (err) {
    logError("startAreaCapture failed:", err.message);
    throw new Error("AREA_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE");
  }
}

async function completeAreaCapture(tabId, payload) {
  const tab = await chrome.tabs.get(tabId);
  log("completeAreaCapture tab:", tabId, "windowId:", tab.windowId);
  try {
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    log("captureVisibleTab ok, raw length:", raw.length);
    const cropped = await cropDataUrl(raw, payload.rect, payload.dpr || 1);
    log("crop ok, cropped length:", cropped.length);
    await saveLatestAndOpenEditor({
      mode: "area",
      imageDataUrl: cropped,
      sourceUrl: tab.url || "",
      sourceTitle: tab.title || "Untitled",
      createdAt: Date.now()
    });
  } catch (err) {
    logError("completeAreaCapture failed:", err.message);
    throw new Error("CAPTURE_PERMISSION_DENIED");
  }
}

async function startFullPageCapture(tabId) {
  let pageInfo;
  let info;
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId);
  log("startFullPageCapture tab:", tabId, "url:", tab.url, "windowId:", tab.windowId);
  if (isUnsupportedPageUrl(tab.url)) {
    throw new Error("CAPTURE_PAGE_UNSUPPORTED");
  }
  try {
    await ensureContentScript(tabId);
    log("content script ready");

    pageInfo = await chrome.tabs.sendMessage(tabId, { type: "snaplite:get-page-info" });
    if (!pageInfo?.ok) throw new Error(pageInfo?.error || "FULL_CAPTURE_PAGE_INFO_FAILED");
    info = pageInfo.data;
    log("pageInfo:", JSON.stringify(info));

    const needsScroll = info.totalHeight > info.viewportHeight + 1;
    log("needsScroll:", needsScroll, "hasScrollContainer:", info.hasScrollContainer);

    if (!needsScroll) {
      log("single-shot: no scroll needed, direct capture (zero DOM touch)");
      const dataUrl = await captureWithRetry(tab.windowId, 2);
      log("single-shot ok, dataUrl length:", dataUrl.length);
      await saveLatestAndOpenEditor({
        mode: "full",
        imageDataUrl: dataUrl,
        sourceUrl: tab.url || "",
        sourceTitle: tab.title || "Untitled",
        createdAt: Date.now()
      });
      log("full capture complete (single-shot)");
      return;
    }

    if (info.hasScrollContainer) {
      return await captureInternalContainer(tabId, tab, info);
    }

    if (settings.hideFixedStickyInFullCapture !== false) {
      await chrome.tabs.sendMessage(tabId, {
        type: "snaplite:prepare-full-capture",
        hideFixedSticky: true
      });
      log("prepared: hid fixed/sticky elements");
    } else {
      await chrome.tabs.sendMessage(tabId, {
        type: "snaplite:prepare-full-capture",
        hideFixedSticky: false
      });
      log("prepared: keep fixed/sticky visible");
    }

    const shots = [];
    const positions = buildPositions(info.totalHeight, info.viewportHeight);
    log("scroll positions:", JSON.stringify(positions));

    for (let i = 0; i < positions.length; i++) {
      const y = positions[i];
      const scrolled = await chrome.tabs.sendMessage(tabId, { type: "snaplite:scroll-to", y }).catch(() => null);
      if (!scrolled?.ok && typeof scrolled?.y !== "number") {
        logError("scroll failed at y:", y, "response:", JSON.stringify(scrolled));
        throw new Error("FULL_CAPTURE_SCROLL_FAILED");
      }
      await sleep(300);
      log(`capture shot ${i + 1}/${positions.length}, scrollY: ${scrolled?.y ?? y}`);
      const imageDataUrl = await captureWithRetry(tab.windowId, 3);
      shots.push({ y: Math.max(0, scrolled?.y ?? y), imageDataUrl });
      log(`shot ${i + 1} ok, dataUrl length: ${imageDataUrl.length}`);
    }

    log("stitching", shots.length, "shots...");
    const stitched = await stitchVerticalShots(shots, info.totalHeight, info.viewportHeight, info.dpr).catch((err) => {
      logError("stitch error:", err.message);
      return null;
    });
    if (!stitched) throw new Error("FULL_CAPTURE_STITCH_FAILED");
    log("stitch ok, output:", stitched.meta.outputWidth, "x", stitched.meta.outputHeight,
      "scale:", stitched.meta.scaleApplied);

    await saveLatestAndOpenEditor({
      mode: "full",
      imageDataUrl: stitched.imageDataUrl,
      sourceUrl: tab.url || "",
      sourceTitle: tab.title || "Untitled",
      createdAt: Date.now(),
      meta: stitched.meta
    });
    log("full capture complete");
  } catch (error) {
    logError("startFullPageCapture error:", error.message);
    const code = String(error?.message || "");
    if (code.startsWith("FULL_CAPTURE_")) {
      throw error;
    }
    throw new Error("FULL_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE");
  } finally {
    if (info) {
      await chrome.tabs.sendMessage(tabId, { type: "snaplite:restore-scroll", y: info.scrollY }).catch(() => {});
    }
    await chrome.tabs.sendMessage(tabId, { type: "snaplite:cleanup-full-capture" }).catch(() => {});
  }
}

async function captureInternalContainer(tabId, tab, info) {
  log("container capture: MAIN-world scroll, zero content-script DOM touch");
  const savedScrollY = info.scrollY;
  try {
    await execInMainWorld(tabId, freezePage);
    log("page frozen (sortable disabled, events blocked)");

    const shots = [];
    const positions = buildPositions(info.totalHeight, info.viewportHeight);
    log("container scroll positions:", JSON.stringify(positions));

    for (let i = 0; i < positions.length; i++) {
      const y = positions[i];
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (scrollY) => {
          const el = document.querySelector("[data-snaplite-scroll-target]");
          if (!el) return -1;
          el.scrollTop = scrollY;
          return el.scrollTop;
        },
        args: [y]
      });
      const actualY = result?.result ?? y;
      await sleep(350);
      log(`container shot ${i + 1}/${positions.length}, scrollY: ${actualY}`);
      const imageDataUrl = await captureWithRetry(tab.windowId, 3);
      shots.push({ y: Math.max(0, actualY), imageDataUrl });
      log(`container shot ${i + 1} ok, dataUrl length: ${imageDataUrl.length}`);
    }

    log("stitching", shots.length, "container shots...");
    const stitched = await stitchContainerShots(shots, info, info.dpr).catch((err) => {
      logError("container stitch error:", err.message);
      return null;
    });
    if (!stitched) throw new Error("FULL_CAPTURE_STITCH_FAILED");
    log("container stitch ok, output:", stitched.meta.outputWidth, "x", stitched.meta.outputHeight);

    await saveLatestAndOpenEditor({
      mode: "full",
      imageDataUrl: stitched.imageDataUrl,
      sourceUrl: tab.url || "",
      sourceTitle: tab.title || "Untitled",
      createdAt: Date.now(),
      meta: stitched.meta
    });
    log("container full capture complete");
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (origY) => {
        const el = document.querySelector("[data-snaplite-scroll-target]");
        if (el) { el.scrollTop = origY; el.removeAttribute("data-snaplite-scroll-target"); }
      },
      args: [savedScrollY]
    }).catch(() => {});
    await execInMainWorld(tabId, unfreezePage).catch(() => {});
    log("page unfrozen, scroll restored");
  }
}

function freezePage() {
  const w = window;
  if (w.__snaplite_frozen) return;
  w.__snaplite_frozen = true;
  w.__snaplite_saved = {};
  const blocker = (e) => { e.stopImmediatePropagation(); e.stopPropagation(); };
  w.__snaplite_saved.blocker = blocker;
  for (const evt of ["scroll", "resize", "transitionend", "animationend"]) {
    document.addEventListener(evt, blocker, { capture: true });
  }
  if (w.jQuery) {
    try {
      const $ = w.jQuery;
      $(".ui-sortable").each(function () {
        try { $(this).sortable("disable"); } catch (_) {}
      });
      w.__snaplite_saved.hadSortable = true;
    } catch (_) {}
  }
}

function unfreezePage() {
  const w = window;
  if (!w.__snaplite_frozen) return;
  const saved = w.__snaplite_saved || {};
  if (saved.blocker) {
    for (const evt of ["scroll", "resize", "transitionend", "animationend"]) {
      document.removeEventListener(evt, saved.blocker, { capture: true });
    }
  }
  if (w.jQuery && saved.hadSortable) {
    try {
      const $ = w.jQuery;
      $(".ui-sortable").each(function () {
        try { $(this).sortable("enable"); } catch (_) {}
      });
    } catch (_) {}
  }
  delete w.__snaplite_frozen;
  delete w.__snaplite_saved;
}

async function execInMainWorld(tabId, func) {
  return chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func });
}

function buildPositions(totalHeight, viewportHeight) {
  if (viewportHeight <= 0 || totalHeight <= 0) return [0];
  if (totalHeight <= viewportHeight) return [0];
  const out = [];
  let y = 0;
  while (y < totalHeight - viewportHeight) {
    out.push(y);
    y += viewportHeight;
  }
  out.push(totalHeight - viewportHeight);
  return out;
}

async function stitchContainerShots(shots, info, dpr) {
  if (!shots.length) throw new Error("NO_SHOTS");
  const cr = info.containerRect;
  const containerScrollH = info.totalHeight;
  const windowH = info.windowHeight;
  const outputHeightCss = cr.top + containerScrollH + (windowH - cr.bottom);
  const sortedShots = [...shots].sort((a, b) => a.y - b.y);
  const bitmaps = [];
  for (const s of sortedShots) {
    bitmaps.push({ y: s.y, bitmap: await dataUrlToBitmap(s.imageDataUrl) });
  }

  const width = bitmaps[0].bitmap.width;
  const imgH = bitmaps[0].bitmap.height;
  const outputH = Math.max(1, Math.round(outputHeightCss * dpr));
  const crTopPx = Math.round(cr.top * dpr);
  const crHeightPx = Math.round(cr.height * dpr);
  const scale = calculateSafeScale(width, outputH);
  const outW = Math.max(1, Math.floor(width * scale));
  const outH = Math.max(1, Math.floor(outputH * scale));
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d");

  const first = bitmaps[0].bitmap;
  ctx.drawImage(first, 0, 0, width, crTopPx, 0, 0, outW, Math.floor(crTopPx * scale));

  const last = bitmaps[bitmaps.length - 1].bitmap;
  const crBottomPx = crTopPx + crHeightPx;
  const footerH = imgH - crBottomPx;
  if (footerH > 0) {
    const footerOutY = Math.floor((outputH - footerH) * scale);
    ctx.drawImage(last, 0, crBottomPx, width, footerH, 0, footerOutY, outW, Math.max(1, Math.floor(footerH * scale)));
  }

  for (const item of bitmaps) {
    const srcY = crTopPx;
    const srcH = Math.min(crHeightPx, imgH - crTopPx);
    if (srcH <= 0) continue;
    const destY = crTopPx + Math.round(item.y * dpr);
    const drawH = Math.min(srcH, outputH - destY);
    if (drawH <= 0) continue;
    ctx.drawImage(item.bitmap, 0, srcY, width, drawH, 0, Math.floor(destY * scale), outW, Math.max(1, Math.floor(drawH * scale)));
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return {
    imageDataUrl: await blobToDataUrl(blob),
    meta: {
      scaleApplied: scale < 1 ? scale : 1,
      originalWidth: width,
      originalHeight: outputH,
      outputWidth: outW,
      outputHeight: outH
    }
  };
}

async function stitchVerticalShots(shots, totalHeightCss, viewportHeightCss, dpr) {
  if (!shots.length) throw new Error("NO_SHOTS");
  const bitmaps = [];
  const sortedShots = [...shots].sort((a, b) => a.y - b.y);
  for (const s of sortedShots) {
    bitmaps.push({
      y: s.y,
      bitmap: await dataUrlToBitmap(s.imageDataUrl)
    });
  }

  const width = bitmaps[0].bitmap.width;
  const totalHeight = Math.max(1, Math.round(totalHeightCss * dpr));
  const viewportHeight = Math.max(1, Math.round(viewportHeightCss * dpr));
  const scale = calculateSafeScale(width, totalHeight);
  const outputWidth = Math.max(1, Math.floor(width * scale));
  const outputHeight = Math.max(1, Math.floor(totalHeight * scale));
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const ctx = canvas.getContext("2d");

  for (let i = 0; i < bitmaps.length; i += 1) {
    const item = bitmaps[i];
    const next = bitmaps[i + 1];
    const dy = Math.round(item.y * dpr);
    const nextY = next ? Math.round(next.y * dpr) : dy + viewportHeight;
    const expectedSliceHeight = Math.max(1, nextY - dy);
    const drawHeight = Math.min(item.bitmap.height, totalHeight - dy, expectedSliceHeight);
    if (drawHeight <= 0) continue;
    ctx.drawImage(
      item.bitmap,
      0,
      0,
      item.bitmap.width,
      drawHeight,
      0,
      Math.floor(dy * scale),
      outputWidth,
      Math.max(1, Math.floor(drawHeight * scale))
    );
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return {
    imageDataUrl: await blobToDataUrl(blob),
    meta: {
      scaleApplied: scale < 1 ? scale : 1,
      originalWidth: width,
      originalHeight: totalHeight,
      outputWidth,
      outputHeight
    }
  };
}

async function cropDataUrl(dataUrl, rectCss, dpr) {
  const bitmap = await dataUrlToBitmap(dataUrl);
  const x = Math.max(0, Math.round(rectCss.x * dpr));
  const y = Math.max(0, Math.round(rectCss.y * dpr));
  const w = Math.max(1, Math.round(rectCss.width * dpr));
  const h = Math.max(1, Math.round(rectCss.height * dpr));
  const width = Math.min(w, bitmap.width - x);
  const height = Math.min(h, bitmap.height - y);
  if (width <= 0 || height <= 0) throw new Error("INVALID_CROP_RECT");

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(blob);
}

async function saveLatestAndOpenEditor(capture) {
  log("saveLatestAndOpenEditor, mode:", capture.mode);
  await chrome.storage.local.set({ [STORAGE_KEYS.LATEST]: capture });
  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
}

async function ensureContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "snaplite-capture-area",
    title: "SnapLite: 区域截图",
    contexts: ["page", "selection", "image", "link"]
  });
  chrome.contextMenus.create({
    id: "snaplite-capture-visible",
    title: "SnapLite: 可视区域截图",
    contexts: ["page", "selection", "image", "link"]
  });
  chrome.contextMenus.create({
    id: "snaplite-capture-full",
    title: "SnapLite: 整页截图",
    contexts: ["page", "selection", "image", "link"]
  });
}

function isUnsupportedPageUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  const unsupportedPrefixes = [
    "chrome://",
    "chrome-extension://",
    "chrome-search://",
    "devtools://",
    "edge://",
    "about:",
    "view-source:"
  ];
  return unsupportedPrefixes.some((prefix) => lower.startsWith(prefix));
}

async function startDomCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  log("startDomCapture tab:", tabId, "url:", tab.url);
  if (isUnsupportedPageUrl(tab.url)) {
    throw new Error("CAPTURE_PAGE_UNSUPPORTED");
  }
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "snaplite:start-dom-select" });
    log("DOM select overlay injected");
  } catch (err) {
    logError("startDomCapture failed:", err.message);
    throw new Error("AREA_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE");
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "snaplite:ping" });
    log("content script already present in tab:", tabId);
    return;
  } catch (_error) {
    log("injecting content script into tab:", tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

const ERROR_MESSAGES = {
  CAPTURE_PAGE_UNSUPPORTED: "当前页面受浏览器限制，无法截图",
  CAPTURE_PERMISSION_DENIED: "截图权限受限，请检查浏览器权限",
  AREA_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE: "当前页面不支持区域截图",
  FULL_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE: "当前页面不支持整页截图",
  FULL_CAPTURE_SCROLL_FAILED: "整页滚动失败，请重试",
  FULL_CAPTURE_CAPTURE_FAILED: "页面截取失败，请重试",
  FULL_CAPTURE_STITCH_FAILED: "页面拼接失败，请重试",
  FULL_CAPTURE_BITMAP_FAILED: "页面图像处理失败，请重试",
  FULL_CAPTURE_PAGE_INFO_FAILED: "整页截图初始化失败，请重试"
};

async function notifyUser(tabId, errorCode) {
  const text = ERROR_MESSAGES[errorCode] || `截图失败: ${errorCode}`;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => {
        const id = "__snaplite_toast__";
        const existing = document.getElementById(id);
        if (existing) existing.remove();
        const el = document.createElement("div");
        el.id = id;
        el.textContent = msg;
        el.style.cssText = [
          "position:fixed", "top:24px", "left:50%", "transform:translateX(-50%)",
          "z-index:2147483647", "padding:10px 22px", "border-radius:8px",
          "background:rgba(15,23,42,0.9)", "color:#fff", "font-size:14px",
          "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
          "box-shadow:0 4px 20px rgba(0,0,0,0.25)", "pointer-events:none",
          "animation:snaplite-fade 3s ease forwards"
        ].join(";");
        const style = document.createElement("style");
        style.textContent = "@keyframes snaplite-fade{0%,70%{opacity:1}100%{opacity:0}}";
        el.appendChild(style);
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3200);
      },
      args: [text]
    });
  } catch (_err) {
    log("notifyUser: toast injection failed, opening notification popup");
    showNotifyPopup(text);
  }
}

function showNotifyPopup(text) {
  const url = chrome.runtime.getURL(`notify.html?msg=${encodeURIComponent(text)}`);
  chrome.windows.create({
    url,
    type: "popup",
    width: 360,
    height: 170,
    focused: true
  });
}

async function captureWithRetry(windowId, maxAttempts) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      if (dataUrl) return dataUrl;
      logError("captureVisibleTab returned empty, attempt:", attempt);
    } catch (err) {
      lastError = err;
      logError("captureVisibleTab attempt", attempt, "failed:", err.message);
    }
    if (attempt < maxAttempts) await sleep(200 * attempt);
  }
  throw new Error("FULL_CAPTURE_CAPTURE_FAILED");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateSafeScale(width, height) {
  const area = width * height;
  let scale = 1;
  if (area > MAX_FULL_CAPTURE_PIXELS) {
    scale = Math.min(scale, Math.sqrt(MAX_FULL_CAPTURE_PIXELS / area));
  }
  if (width > MAX_CANVAS_DIMENSION) {
    scale = Math.min(scale, MAX_CANVAS_DIMENSION / width);
  }
  if (height > MAX_CANVAS_DIMENSION) {
    scale = Math.min(scale, MAX_CANVAS_DIMENSION / height);
  }
  return Math.max(0.25, Math.min(1, scale));
}

async function dataUrlToBitmap(dataUrl) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch (err) {
    logError("dataUrlToBitmap failed:", err.message);
    throw new Error("FULL_CAPTURE_BITMAP_FAILED");
  }
}

async function blobToDataUrl(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
