const OVERLAY_ID = "snaplite-capture-overlay";
const DOM_OVERLAY_ID = "snaplite-dom-overlay";
let isSelecting = false;
let isDomSelecting = false;
const hiddenNodesForFullCapture = [];
let previousScrollBehaviors = [];
let scrollContainer = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === "snaplite:ping") {
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "snaplite:start-dom-select") {
      startDomSelection();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "snaplite:start-area-select") {
      startAreaSelection();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "snaplite:get-page-info") {
      sendResponse({
        ok: true,
        data: getPageInfo()
      });
      return;
    }
    if (message?.type === "snaplite:prepare-full-capture") {
      prepareFullCapture(message.hideFixedSticky !== false);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "snaplite:scroll-to") {
      scrollToY(message.y || 0);
      await waitForStableScroll();
      sendResponse({ ok: true, y: getCurrentScrollY() });
      return;
    }
    if (message?.type === "snaplite:restore-scroll") {
      scrollToY(message.y || 0);
      await waitForStableScroll();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "snaplite:cleanup-full-capture") {
      cleanupFullCapture();
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false });
  })();
  return true;
});

function findScrollableContainer() {
  const doc = document.documentElement;
  const body = document.body;
  if (Math.max(doc.scrollHeight, body?.scrollHeight || 0) > window.innerHeight + 1) return null;

  const probes = [
    [window.innerWidth * 0.4, window.innerHeight * 0.5],
    [window.innerWidth * 0.5, window.innerHeight * 0.5],
    [window.innerWidth * 0.3, window.innerHeight * 0.4],
  ];
  let best = null;
  let bestArea = 0;
  const checked = new WeakSet();

  for (const [px, py] of probes) {
    let el = document.elementFromPoint(px, py);
    while (el && el !== body && el !== doc) {
      if (!checked.has(el)) {
        checked.add(el);
        if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 50) {
          const cs = getComputedStyle(el);
          if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
            const r = el.getBoundingClientRect();
            const a = r.width * r.height;
            if (a > bestArea) { bestArea = a; best = el; }
          }
        }
      }
      el = el.parentElement;
    }
  }
  return best;
}

function getPageInfo() {
  const doc = document.documentElement;
  const body = document.body;

  const container = findScrollableContainer();
  scrollContainer = container;

  if (container) {
    container.setAttribute("data-snaplite-scroll-target", "1");
    const rect = container.getBoundingClientRect();
    return {
      totalHeight: container.scrollHeight,
      viewportHeight: Math.round(rect.height),
      dpr: window.devicePixelRatio || 1,
      scrollY: container.scrollTop,
      hasScrollContainer: true,
      containerRect: {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height)
      },
      windowHeight: window.innerHeight
    };
  }

  const totalHeight = Math.max(
    doc.scrollHeight,
    body?.scrollHeight || 0,
    doc.offsetHeight,
    body?.offsetHeight || 0
  );

  return {
    totalHeight,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    scrollY: window.scrollY,
    hasScrollContainer: false
  };
}

function scrollToY(y) {
  if (scrollContainer) {
    scrollContainer.scrollTop = y;
  } else {
    window.scrollTo({ top: y, left: 0, behavior: "auto" });
  }
}

function getCurrentScrollY() {
  return scrollContainer ? scrollContainer.scrollTop : window.scrollY;
}

function prepareFullCapture(hideFixedSticky) {
  cleanupFullCapture();
  previousScrollBehaviors = [];

  const targets = [document.documentElement, document.body];
  if (scrollContainer) targets.push(scrollContainer);
  for (const el of targets) {
    if (!el) continue;
    previousScrollBehaviors.push({ el, value: el.style.scrollBehavior || "" });
    el.style.scrollBehavior = "auto";
  }

  if (!hideFixedSticky) return;

  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const vpArea = vpW * vpH;
  const all = document.querySelectorAll("body *");
  for (const node of all) {
    if (node === scrollContainer) continue;
    const style = window.getComputedStyle(node);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 30) continue;
    const area = rect.width * rect.height;
    if (area > vpArea * 0.5) continue;
    hiddenNodesForFullCapture.push({
      node,
      visibility: node.style.visibility || ""
    });
    node.style.visibility = "hidden";
  }
}

function cleanupFullCapture() {
  while (hiddenNodesForFullCapture.length) {
    const item = hiddenNodesForFullCapture.pop();
    if (item?.node) {
      item.node.style.visibility = item.visibility;
    }
  }
  for (const entry of previousScrollBehaviors) {
    if (entry?.el) entry.el.style.scrollBehavior = entry.value;
  }
  previousScrollBehaviors = [];
  scrollContainer = null;
}

function waitForStableScroll() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function startAreaSelection() {
  if (isSelecting) return;
  isSelecting = true;

  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    cursor: crosshair;
    background: rgba(0, 0, 0, 0.08);
  `;

  const hint = document.createElement("div");
  hint.textContent = "拖拽选择截图区域，ESC 取消";
  hint.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 10px;
    border-radius: 6px;
    color: #fff;
    background: rgba(0, 0, 0, 0.72);
    font-size: 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;
  overlay.appendChild(hint);

  const box = document.createElement("div");
  box.style.cssText = `
    position: fixed;
    border: 2px solid #2f80ed;
    background: rgba(47, 128, 237, 0.15);
    display: none;
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  const onMouseDown = (event) => {
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    box.style.display = "block";
    updateBox(event.clientX, event.clientY);
  };

  const onMouseMove = (event) => {
    if (!dragging) return;
    updateBox(event.clientX, event.clientY);
  };

  const onMouseUp = async (event) => {
    if (!dragging) return;
    dragging = false;
    const rect = normalizedRect(startX, startY, event.clientX, event.clientY);
    cleanup();
    if (rect.width < 4 || rect.height < 4) return;

    await chrome.runtime.sendMessage({
      type: "snaplite:area-selected",
      payload: {
        rect,
        dpr: window.devicePixelRatio || 1
      }
    });
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      cleanup();
    }
  };

  function updateBox(currentX, currentY) {
    const rect = normalizedRect(startX, startY, currentX, currentY);
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function cleanup() {
    overlay.removeEventListener("mousedown", onMouseDown, true);
    overlay.removeEventListener("mousemove", onMouseMove, true);
    overlay.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
    isSelecting = false;
  }

  overlay.addEventListener("mousedown", onMouseDown, true);
  overlay.addEventListener("mousemove", onMouseMove, true);
  overlay.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("keydown", onKeyDown, true);
}

function normalizedRect(x1, y1, x2, y2) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}

/* ─── DOM 元素选择 ─── */
function startDomSelection() {
  if (isDomSelecting) return;
  isDomSelecting = true;

  const existing = document.getElementById(DOM_OVERLAY_ID);
  if (existing) existing.remove();

  const highlight = document.createElement("div");
  highlight.id = DOM_OVERLAY_ID;
  highlight.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483646;
    border: 2px solid #6366f1;
    background: rgba(99,102,241,0.08);
    border-radius: 3px;
    transition: top 0.08s, left 0.08s, width 0.08s, height 0.08s;
    display: none;
  `;
  document.body.appendChild(highlight);

  const badge = document.createElement("div");
  badge.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    padding: 5px 10px;
    background: rgba(15,23,42,0.82);
    color: #fff;
    font-size: 12px;
    border-radius: 6px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: none;
  `;
  badge.textContent = "悬停选择元素，点击截图，ESC 取消";
  document.body.appendChild(badge);

  let currentTarget = null;

  function updateHighlight(el) {
    if (!el || el === document.body || el === document.documentElement) {
      highlight.style.display = "none";
      return;
    }
    const rect = el.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.top = `${rect.top}px`;
    highlight.style.left = `${rect.left}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  }

  const onMouseMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== highlight && el !== badge && el !== currentTarget) {
      currentTarget = el;
      updateHighlight(el);
    }
  };

  const onClick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentTarget) return;
    const rect = currentTarget.getBoundingClientRect();
    cleanup();
    await chrome.runtime.sendMessage({
      type: "snaplite:dom-selected",
      payload: {
        rect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        },
        dpr: window.devicePixelRatio || 1
      }
    });
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") cleanup();
  };

  function cleanup() {
    highlight.remove();
    badge.remove();
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKeyDown, true);
    isDomSelecting = false;
  }

  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
}
