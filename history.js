const STORAGE_KEYS = {
  HISTORY: "snaplite_history",
  LATEST: "snaplite_latest_capture"
};

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const filterEl = document.getElementById("siteFilter");
const toastEl = document.getElementById("toast");
let allHistory = [];
let toastTimer = 0;
const selectedIds = new Set();

document.getElementById("refreshBtn").addEventListener("click", () => void render());
document.getElementById("clearBtn").addEventListener("click", () => void clearHistory());
document.getElementById("selectAllBtn").addEventListener("click", () => toggleSelectAllCurrent());
document.getElementById("deleteSelectedBtn").addEventListener("click", () => void deleteSelected());
filterEl.addEventListener("change", () => renderList());

void render();

async function render() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  allHistory = data[STORAGE_KEYS.HISTORY] || [];
  renderFilterOptions();
  renderList();
}

function renderList() {
  listEl.innerHTML = "";
  const history = getFilteredHistory();

  if (!history.length) {
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";

  for (const item of history) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <img src="${item.imageDataUrl}" alt="history" />
      <div class="card-body">
        <div class="card-top">
          <p class="title">${escapeHtml(item.sourceTitle || "Untitled")}</p>
          <input type="checkbox" class="card-check" data-id="${item.id}" ${selectedIds.has(item.id) ? "checked" : ""} />
        </div>
        <p class="time">${new Date(item.createdAt).toLocaleString()}</p>
        <div class="ops">
          <button data-id="${item.id}" data-op="edit">打开编辑</button>
          <button data-id="${item.id}" data-op="copy">复制</button>
          <button data-id="${item.id}" data-op="download">下载</button>
          <button data-id="${item.id}" data-op="delete">删除</button>
        </div>
      </div>
    `;
    listEl.appendChild(card);
  }

  listEl.querySelectorAll("button[data-op]").forEach((btn) => {
    btn.addEventListener("click", () => void onOperate(btn));
  });
  listEl.querySelectorAll("input.card-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const id = checkbox.getAttribute("data-id");
      if (!id) return;
      if (checkbox.checked) {
        selectedIds.add(id);
      } else {
        selectedIds.delete(id);
      }
    });
  });
}

async function onOperate(btn) {
  const id = btn.getAttribute("data-id");
  const op = btn.getAttribute("data-op");
  const found = allHistory.find((i) => i.id === id);
  if (!found) return;

  if (op === "delete") {
    const next = allHistory.filter((i) => i.id !== id);
    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: next });
    selectedIds.delete(id);
    await render();
    showToast("已删除");
    return;
  }

  if (op === "copy") {
    await copyImage(found.imageDataUrl);
    return;
  }

  if (op === "download") {
    downloadImage(found.imageDataUrl);
    return;
  }

  if (op === "edit") {
    await chrome.storage.local.set({
      [STORAGE_KEYS.LATEST]: {
        mode: "history",
        imageDataUrl: found.imageDataUrl,
        sourceUrl: found.sourceUrl || "",
        sourceTitle: found.sourceTitle || "Untitled",
        createdAt: Date.now()
      }
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
  }
}

async function clearHistory() {
  const ok = window.confirm("确认清空全部历史截图吗？");
  if (!ok) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
  selectedIds.clear();
  await render();
  showToast("已清空历史");
}

function toggleSelectAllCurrent() {
  const visible = getFilteredHistory();
  if (!visible.length) return;
  const allSelected = visible.every((item) => selectedIds.has(item.id));
  for (const item of visible) {
    if (allSelected) {
      selectedIds.delete(item.id);
    } else {
      selectedIds.add(item.id);
    }
  }
  renderList();
  showToast(allSelected ? "已取消全选" : `已选择 ${visible.length} 项`);
}

async function deleteSelected() {
  if (!selectedIds.size) {
    showToast("请先选择记录");
    return;
  }
  const ok = window.confirm(`确认删除选中的 ${selectedIds.size} 条记录吗？`);
  if (!ok) return;
  const next = allHistory.filter((item) => !selectedIds.has(item.id));
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: next });
  selectedIds.clear();
  await render();
  showToast("已删除选中记录");
}

function renderFilterOptions() {
  const previous = filterEl.value || "all";
  const hosts = Array.from(
    new Set(
      allHistory
        .map((item) => getHost(item.sourceUrl))
        .filter(Boolean)
    )
  ).sort();

  const options = ['<option value="all">全部站点</option>'];
  for (const host of hosts) {
    options.push(`<option value="${escapeHtml(host)}">${escapeHtml(host)}</option>`);
  }
  filterEl.innerHTML = options.join("");
  filterEl.value = hosts.includes(previous) || previous === "all" ? previous : "all";
}

function getFilteredHistory() {
  const selectedHost = filterEl.value || "all";
  return selectedHost === "all"
    ? allHistory
    : allHistory.filter((item) => getHost(item.sourceUrl) === selectedHost);
}

function getHost(url) {
  try {
    if (!url) return "";
    return new URL(url).host;
  } catch (_error) {
    return "";
  }
}

async function copyImage(dataUrl) {
  try {
    const blob = await dataUrlToBlob(dataUrl);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    showToast("已复制");
  } catch (_error) {
    showToast("复制失败");
  }
}

function downloadImage(dataUrl) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `snaplite_history_${Date.now()}.png`;
  a.click();
  showToast("已下载");
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function showToast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 1200);
}
