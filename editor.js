const STORAGE_KEYS = {
  LATEST: "snaplite_latest_capture",
  SETTINGS: "snaplite_settings",
  HISTORY: "snaplite_history"
};

const DEFAULT_SETTINGS = {
  format: "png",
  keepHistory: true,
  historyLimit: 20,
  uploadEnabled: false,
  uploadConfig: { endpoint: "", token: "" }
};

const stage = document.getElementById("stage");
const ctx = stage.getContext("2d");
const msgBar = document.getElementById("msgBar");

const state = {
  baseImage: null,
  tool: "rect",
  color: "#ef4444",
  size: 4,
  actions: [],
  redoStack: [],
  drawing: false,
  currentAction: null,
  settings: DEFAULT_SETTINGS,
  meta: null
};

void init();

async function init() {
  bindUI();

  const [captureData, settingsData] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEYS.LATEST),
    chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  ]);

  state.settings = { ...DEFAULT_SETTINGS, ...(settingsData[STORAGE_KEYS.SETTINGS] || {}) };

  const capture = captureData[STORAGE_KEYS.LATEST];
  if (!capture?.imageDataUrl) {
    setMessage("没有可编辑的截图，请重新截图", true);
    return;
  }
  state.meta = capture;
  state.baseImage = await loadImage(capture.imageDataUrl);
  stage.width = state.baseImage.width;
  stage.height = state.baseImage.height;
  redraw();
  if (capture.meta?.scaleApplied && capture.meta.scaleApplied < 1) {
    setMessage(`页面过长，已自动压缩为 ${capture.meta.outputWidth}x${capture.meta.outputHeight}`);
  }
}

function bindUI() {
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    if (btn.getAttribute("data-tool") === state.tool) btn.classList.add("active");
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-tool]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.tool = btn.getAttribute("data-tool");
    });
  });

  const colorInput = document.getElementById("color");
  const sizeSelect = document.getElementById("size");
  colorInput.addEventListener("change", (e) => {
    state.color = e.target.value;
  });
  sizeSelect.addEventListener("change", (e) => {
    state.size = Number(e.target.value);
  });

  stage.addEventListener("mousedown", onPointerDown);
  stage.addEventListener("mousemove", onPointerMove);
  window.addEventListener("mouseup", onPointerUp);

  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("redoBtn").addEventListener("click", redo);
  document.getElementById("clearBtn").addEventListener("click", clearAll);
  document.getElementById("copyBtn").addEventListener("click", () => void copyImage());
  document.getElementById("downloadBtn").addEventListener("click", () => void downloadImage());

  window.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const ctrl = isMac ? e.metaKey : e.ctrlKey;
    if (!ctrl) return;
    if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); redo(); }
  });
}

function onPointerDown(event) {
  if (!state.baseImage) return;
  const p = getPoint(event);
  state.drawing = true;

  if (state.tool === "text") {
    const content = window.prompt("输入文字");
    if (content) {
      state.redoStack = [];
      state.actions.push({
        type: "text",
        x: p.x,
        y: p.y,
        color: state.color,
        size: state.size,
        text: content
      });
      redraw();
    }
    state.drawing = false;
    return;
  }

  if (state.tool === "pen") {
    state.currentAction = {
      type: "pen",
      color: state.color,
      size: state.size,
      points: [p]
    };
    return;
  }

  state.currentAction = {
    type: state.tool,
    color: state.color,
    size: state.size,
    x1: p.x,
    y1: p.y,
    x2: p.x,
    y2: p.y
  };
}

function onPointerMove(event) {
  if (!state.drawing || !state.currentAction) return;
  const p = getPoint(event);
  if (state.currentAction.type === "pen") {
    state.currentAction.points.push(p);
  } else {
    state.currentAction.x2 = p.x;
    state.currentAction.y2 = p.y;
  }
  redraw(state.currentAction);
}

function onPointerUp() {
  if (!state.drawing) return;
  state.drawing = false;
  if (state.currentAction) {
    state.redoStack = [];
    state.actions.push(state.currentAction);
    state.currentAction = null;
    redraw();
  }
}

function redraw(tempAction = null) {
  if (!state.baseImage) return;
  ctx.clearRect(0, 0, stage.width, stage.height);
  ctx.drawImage(state.baseImage, 0, 0);
  for (const action of state.actions) drawAction(action);
  if (tempAction) drawAction(tempAction);
}

function drawAction(action) {
  if (action.type === "rect") return drawRect(action);
  if (action.type === "circle") return drawCircle(action);
  if (action.type === "arrow") return drawArrow(action);
  if (action.type === "pen") return drawPen(action);
  if (action.type === "text") return drawText(action);
  if (action.type === "mosaic") return drawMosaic(action);
}

function drawRect(a) {
  const { x, y, w, h } = normalizeRect(a.x1, a.y1, a.x2, a.y2);
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.size;
  ctx.strokeRect(x, y, w, h);
}

function drawCircle(a) {
  const { x, y, w, h } = normalizeRect(a.x1, a.y1, a.x2, a.y2);
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.size;
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawArrow(a) {
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.size;
  ctx.beginPath();
  ctx.moveTo(a.x1, a.y1);
  ctx.lineTo(a.x2, a.y2);
  ctx.stroke();

  const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const len = 10 + a.size * 1.2;
  ctx.beginPath();
  ctx.moveTo(a.x2, a.y2);
  ctx.lineTo(a.x2 - len * Math.cos(angle - Math.PI / 6), a.y2 - len * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(a.x2 - len * Math.cos(angle + Math.PI / 6), a.y2 - len * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawPen(a) {
  if (!a.points?.length) return;
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.size;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.points[0].x, a.points[0].y);
  for (let i = 1; i < a.points.length; i += 1) {
    ctx.lineTo(a.points[i].x, a.points[i].y);
  }
  ctx.stroke();
}

function drawText(a) {
  ctx.fillStyle = a.color;
  ctx.font = `${12 + a.size * 2}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillText(a.text, a.x, a.y);
}

function drawMosaic(a) {
  const { x, y, w, h } = normalizeRect(a.x1, a.y1, a.x2, a.y2);
  const pixelSize = Math.max(6, a.size * 4);
  for (let by = y; by < y + h; by += pixelSize) {
    for (let bx = x; bx < x + w; bx += pixelSize) {
      const sampleX = Math.min(stage.width - 1, bx + Math.floor(pixelSize / 2));
      const sampleY = Math.min(stage.height - 1, by + Math.floor(pixelSize / 2));
      const imageData = ctx.getImageData(sampleX, sampleY, 1, 1).data;
      ctx.fillStyle = `rgba(${imageData[0]},${imageData[1]},${imageData[2]},1)`;
      ctx.fillRect(bx, by, pixelSize, pixelSize);
    }
  }
}

function undo() {
  if (!state.actions.length) return;
  const action = state.actions.pop();
  state.redoStack.push(action);
  redraw();
}

function redo() {
  if (!state.redoStack.length) return;
  const action = state.redoStack.pop();
  state.actions.push(action);
  redraw();
}

function clearAll() {
  state.actions = [];
  state.redoStack = [];
  redraw();
}

async function copyImage() {
  const blob = await canvasToBlob(stage, "png");
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setMessage("已复制到剪贴板 ✓");
    await saveHistory();
  } catch (_error) {
    setMessage("复制失败，请使用下载按钮", true);
  }
}

async function downloadImage() {
  const format = state.settings.format === "jpg" ? "jpeg" : "png";
  const blob = await canvasToBlob(stage, format);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ext = format === "jpeg" ? "jpg" : "png";
  a.download = `snaplite_${Date.now()}.${ext}`;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
  setMessage("已下载 ✓");
  await saveHistory();
  if (state.settings.uploadEnabled) {
    await uploadIfEnabled(blob);
  }
}

async function saveHistory() {
  if (!state.settings.keepHistory) return;
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  const history = data[STORAGE_KEYS.HISTORY] || [];
  const thumb = stage.toDataURL("image/png");
  const next = [
    {
      id: `${Date.now()}`,
      imageDataUrl: thumb,
      createdAt: Date.now(),
      sourceTitle: state.meta?.sourceTitle || "",
      sourceUrl: state.meta?.sourceUrl || ""
    },
    ...history
  ].slice(0, state.settings.historyLimit || 20);
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: next });
}

async function uploadIfEnabled(blob) {
  const endpoint = state.settings.uploadConfig?.endpoint?.trim();
  if (!endpoint) {
    setMessage("已下载；上传地址未配置");
    return;
  }

  const formData = new FormData();
  formData.append("file", blob, `snaplite_${Date.now()}.png`);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: state.settings.uploadConfig?.token
        ? { Authorization: state.settings.uploadConfig.token }
        : undefined,
      body: formData
    });
    if (!response.ok) throw new Error(`UPLOAD_${response.status}`);
    setMessage("已下载并上传成功");
  } catch (_error) {
    setMessage("已下载；上传失败");
  }
}

function setMessage(text, isError = false) {
  if (!msgBar) return;
  msgBar.textContent = text;
  msgBar.className = "msg-bar visible" + (isError ? " error" : "");
  clearTimeout(msgBar._timer);
  msgBar._timer = setTimeout(() => {
    msgBar.classList.remove("visible");
  }, 2200);
}

function getPoint(event) {
  const rect = stage.getBoundingClientRect();
  const sx = stage.width / rect.width;
  const sy = stage.height / rect.height;
  return {
    x: Math.round((event.clientX - rect.left) * sx),
    y: Math.round((event.clientY - rect.top) * sy)
  };
}

function normalizeRect(x1, y1, x2, y2) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return {
    x,
    y,
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1)
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function canvasToBlob(canvas, format) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("BLOB_EMPTY"));
        return;
      }
      resolve(blob);
    }, `image/${format}`, 0.92);
  });
}
