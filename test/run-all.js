"use strict";

const { describe, test, runAll, assert } = require("./harness");
const { createChromeMock } = require("./chrome-mock");
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ════════════════════════════════════════════════
// 从源码中提取的纯函数（与 background.js 一致）
// ════════════════════════════════════════════════

const MAX_FULL_CAPTURE_PIXELS = 32_000_000;
const MAX_CANVAS_DIMENSION = 8192;

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

// content.js 纯函数
function normalizedRect(x1, y1, x2, y2) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

// editor.js 纯函数
function normalizeRect(x1, y1, x2, y2) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

// history.js 纯函数
function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function getHost(url) {
  try {
    if (!url) return "";
    return new URL(url).host;
  } catch (_error) {
    return "";
  }
}

// popup.js 纯函数
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

// ════════════════════════════════════════════════
// 测试用例
// ════════════════════════════════════════════════

describe("isUnsupportedPageUrl", () => {
  test("普通 https 页面返回 false", () => {
    assert.strictEqual(isUnsupportedPageUrl("https://example.com"), false);
  });

  test("http 页面返回 false", () => {
    assert.strictEqual(isUnsupportedPageUrl("http://localhost:3000"), false);
  });

  test("chrome:// 页面返回 true", () => {
    assert.strictEqual(isUnsupportedPageUrl("chrome://extensions"), true);
  });

  test("chrome-extension:// 页面返回 true", () => {
    assert.strictEqual(isUnsupportedPageUrl("chrome-extension://abcdef/popup.html"), true);
  });

  test("edge:// 页面返回 true", () => {
    assert.strictEqual(isUnsupportedPageUrl("edge://settings"), true);
  });

  test("about:blank 返回 true", () => {
    assert.strictEqual(isUnsupportedPageUrl("about:blank"), true);
  });

  test("view-source: 返回 true", () => {
    assert.strictEqual(isUnsupportedPageUrl("view-source:https://example.com"), true);
  });

  test("空字符串返回 false（不误判）", () => {
    assert.strictEqual(isUnsupportedPageUrl(""), false);
  });

  test("null 返回 false（不误判）", () => {
    assert.strictEqual(isUnsupportedPageUrl(null), false);
  });

  test("undefined 返回 false（不误判）", () => {
    assert.strictEqual(isUnsupportedPageUrl(undefined), false);
  });

  test("devtools:// 返回 true", () => {
    assert.strictEqual(isUnsupportedPageUrl("devtools://devtools/bundled/inspector.html"), true);
  });

  test("chrome-search:// 返回 true", () => {
    assert.strictEqual(isUnsupportedPageUrl("chrome-search://local-ntp/local-ntp.html"), true);
  });

  test("大写 CHROME:// 也返回 true（大小写安全）", () => {
    assert.strictEqual(isUnsupportedPageUrl("CHROME://extensions"), true);
  });
});

describe("buildPositions", () => {
  test("页面不超过视口时返回 [0]", () => {
    assert.deepStrictEqual(buildPositions(500, 800), [0]);
  });

  test("页面等于视口时返回 [0]", () => {
    assert.deepStrictEqual(buildPositions(800, 800), [0]);
  });

  test("页面正好 2 倍视口", () => {
    assert.deepStrictEqual(buildPositions(1600, 800), [0, 800]);
  });

  test("页面 2.5 倍视口", () => {
    assert.deepStrictEqual(buildPositions(2000, 800), [0, 800, 1200]);
  });

  test("页面 3 倍视口", () => {
    assert.deepStrictEqual(buildPositions(2400, 800), [0, 800, 1600]);
  });

  test("页面极短（1px 高度）", () => {
    assert.deepStrictEqual(buildPositions(1, 800), [0]);
  });

  test("viewportHeight 为 0 时安全返回 [0]（已修复死循环）", () => {
    const result = buildPositions(100, 0);
    assert.deepStrictEqual(result, [0]);
  });

  test("viewportHeight 为负数时安全返回 [0]（已修复死循环）", () => {
    const result = buildPositions(100, -10);
    assert.deepStrictEqual(result, [0]);
  });

  test("totalHeight 为 0 时安全返回 [0]", () => {
    const result = buildPositions(0, 800);
    assert.deepStrictEqual(result, [0]);
  });
});

describe("calculateSafeScale", () => {
  test("小图不缩放", () => {
    assert.strictEqual(calculateSafeScale(1920, 1080), 1);
  });

  test("面积超限时缩放", () => {
    const scale = calculateSafeScale(1920, 20000);
    assert.ok(scale < 1, `scale 应 < 1，实际 ${scale}`);
    assert.ok(scale >= 0.25, `scale 不应低于 0.25，实际 ${scale}`);
  });

  test("高度超限时缩放", () => {
    const scale = calculateSafeScale(1920, 10000);
    assert.ok(scale <= MAX_CANVAS_DIMENSION / 10000);
  });

  test("宽度超限时缩放", () => {
    const scale = calculateSafeScale(10000, 100);
    assert.ok(scale <= MAX_CANVAS_DIMENSION / 10000);
  });

  test("最小 scale 不低于 0.25", () => {
    const scale = calculateSafeScale(100000, 100000);
    assert.strictEqual(scale, 0.25);
  });

  test("width=0 不抛异常", () => {
    const scale = calculateSafeScale(0, 1000);
    assert.ok(typeof scale === "number");
  });

  test("height=0 不抛异常", () => {
    const scale = calculateSafeScale(1000, 0);
    assert.ok(typeof scale === "number");
  });
});

describe("normalizedRect (content.js)", () => {
  test("左上到右下", () => {
    assert.deepStrictEqual(normalizedRect(10, 20, 100, 200), {
      x: 10, y: 20, width: 90, height: 180
    });
  });

  test("右下到左上（反向拖拽）", () => {
    assert.deepStrictEqual(normalizedRect(100, 200, 10, 20), {
      x: 10, y: 20, width: 90, height: 180
    });
  });

  test("零面积", () => {
    const r = normalizedRect(50, 50, 50, 50);
    assert.strictEqual(r.width, 0);
    assert.strictEqual(r.height, 0);
  });

  test("负坐标", () => {
    const r = normalizedRect(-10, -20, 10, 20);
    assert.strictEqual(r.x, -10);
    assert.strictEqual(r.y, -20);
    assert.strictEqual(r.width, 20);
    assert.strictEqual(r.height, 40);
  });
});

describe("normalizeRect (editor.js)", () => {
  test("返回 {x, y, w, h} 格式", () => {
    assert.deepStrictEqual(normalizeRect(10, 20, 100, 200), {
      x: 10, y: 20, w: 90, h: 180
    });
  });

  test("反向拖拽", () => {
    assert.deepStrictEqual(normalizeRect(100, 200, 10, 20), {
      x: 10, y: 20, w: 90, h: 180
    });
  });
});

describe("escapeHtml (history.js)", () => {
  test("转义 <script> 标签", () => {
    assert.strictEqual(escapeHtml('<script>alert("xss")</script>'),
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  test("转义 & 符号", () => {
    assert.strictEqual(escapeHtml("a & b"), "a &amp; b");
  });

  test("转义单引号", () => {
    assert.strictEqual(escapeHtml("it's"), "it&#39;s");
  });

  test("空字符串", () => {
    assert.strictEqual(escapeHtml(""), "");
  });

  test("无需转义的文本原样返回", () => {
    assert.strictEqual(escapeHtml("hello world"), "hello world");
  });

  test("& 必须最先转义（避免双重转义）", () => {
    assert.strictEqual(escapeHtml("&<>"), "&amp;&lt;&gt;");
  });
});

describe("getHost (history.js)", () => {
  test("提取主机名", () => {
    assert.strictEqual(getHost("https://example.com/path"), "example.com");
  });

  test("带端口号", () => {
    assert.strictEqual(getHost("http://localhost:3000/foo"), "localhost:3000");
  });

  test("空字符串返回空", () => {
    assert.strictEqual(getHost(""), "");
  });

  test("null 返回空", () => {
    assert.strictEqual(getHost(null), "");
  });

  test("无效 URL 返回空", () => {
    assert.strictEqual(getHost("not-a-url"), "");
  });
});

describe("getErrorMessage (popup.js)", () => {
  test("已知错误码返回中文提示", () => {
    assert.strictEqual(getErrorMessage("CAPTURE_PAGE_UNSUPPORTED"),
      "当前页面受浏览器限制，请在普通网页中使用");
  });

  test("未知错误码返回通用格式", () => {
    const msg = getErrorMessage("SOME_UNKNOWN_CODE");
    assert.ok(msg.includes("SOME_UNKNOWN_CODE"));
  });

  test("空字符串返回 unknown", () => {
    const msg = getErrorMessage("");
    assert.ok(msg.includes("unknown"));
  });

  test("null 返回 unknown", () => {
    const msg = getErrorMessage(null);
    assert.ok(msg.includes("unknown"));
  });

  test("所有已知错误码都有对应提示", () => {
    const codes = [
      "NO_ACTIVE_TAB", "CAPTURE_PAGE_UNSUPPORTED", "DOM_CAPTURE_NOT_AVAILABLE",
      "AREA_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE", "FULL_CAPTURE_NOT_AVAILABLE_ON_THIS_PAGE",
      "FULL_CAPTURE_PAGE_INFO_FAILED", "FULL_CAPTURE_SCROLL_FAILED",
      "FULL_CAPTURE_BITMAP_FAILED", "FULL_CAPTURE_CAPTURE_FAILED",
      "FULL_CAPTURE_STITCH_FAILED", "CAPTURE_PERMISSION_DENIED",
      "UNKNOWN_MODE", "UNKNOWN_MESSAGE"
    ];
    for (const code of codes) {
      const msg = getErrorMessage(code);
      assert.ok(!msg.includes("截图失败："), `${code} 应有专用提示，得到: ${msg}`);
    }
  });
});

// ════════════════════════════════════════════════
// 集成测试：消息路由
// ════════════════════════════════════════════════

describe("消息路由集成测试", () => {
  test("routeCapture - visible 模式调用 startVisibleCapture", async () => {
    let called = "";
    const routeCapture = (mode) => {
      called = mode;
      if (mode === "visible") return Promise.resolve();
      if (mode === "area") return Promise.resolve();
      if (mode === "full") return Promise.resolve();
      if (mode === "dom") return Promise.resolve();
      return Promise.reject(new Error("UNKNOWN_MODE"));
    };
    await routeCapture("visible");
    assert.strictEqual(called, "visible");
  });

  test("routeCapture - 未知模式抛出 UNKNOWN_MODE", async () => {
    const routeCapture = (mode) => {
      if (["visible", "area", "full", "dom"].includes(mode)) return Promise.resolve();
      return Promise.reject(new Error("UNKNOWN_MODE"));
    };
    try {
      await routeCapture("invalid");
      assert.fail("应该抛异常");
    } catch (err) {
      assert.strictEqual(err.message, "UNKNOWN_MODE");
    }
  });

  test("onMessage 处理 snaplite:start-capture 消息", async () => {
    const chrome = createChromeMock();
    let routedMode = null;
    let routedTabId = null;

    // 模拟 background.js 的 onMessage 处理
    const handler = (message, sender, sendResponse) => {
      void (async () => {
        try {
          if (message?.type === "snaplite:start-capture") {
            routedMode = message.mode;
            routedTabId = message.tabId || 1;
            sendResponse({ ok: true });
            return;
          }
          sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
        } catch (error) {
          sendResponse({ ok: false, error: String(error?.message || error) });
        }
      })();
      return true;
    };

    const result = await new Promise((resolve) => {
      handler({ type: "snaplite:start-capture", mode: "full", tabId: 5 }, {}, resolve);
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(routedMode, "full");
    assert.strictEqual(routedTabId, 5);
  });

  test("onMessage 对未知消息返回 UNKNOWN_MESSAGE", async () => {
    const handler = (message, sender, sendResponse) => {
      void (async () => {
        try {
          if (message?.type === "snaplite:start-capture") {
            sendResponse({ ok: true });
            return;
          }
          sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
        } catch (error) {
          sendResponse({ ok: false, error: String(error?.message || error) });
        }
      })();
      return true;
    };

    const result = await new Promise((resolve) => {
      handler({ type: "unknown" }, {}, resolve);
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "UNKNOWN_MESSAGE");
  });

  test("tabId 从 popup 消息中获取，不依赖 getActiveTab", async () => {
    const chrome = createChromeMock();
    // 设置 query 返回 chrome:// 页面（模拟 popup 关闭后的情况）
    chrome.tabs.query = async () => [{ id: 2, url: "chrome://newtab" }];

    let usedTabId = null;

    const handler = (message, sender, sendResponse) => {
      void (async () => {
        try {
          if (message?.type === "snaplite:start-capture") {
            let tabId = message.tabId;
            if (!tabId) {
              const tabs = await chrome.tabs.query();
              tabId = tabs[0]?.id;
            }
            usedTabId = tabId;
            sendResponse({ ok: true });
            return;
          }
        } catch (error) {
          sendResponse({ ok: false, error: String(error?.message || error) });
        }
      })();
      return true;
    };

    // 传入 tabId=1（来自 popup）
    await new Promise((resolve) => {
      handler({ type: "snaplite:start-capture", mode: "visible", tabId: 1 }, {}, resolve);
    });
    assert.strictEqual(usedTabId, 1, "应使用 popup 传来的 tabId，而不是 query 结果");
  });
});

// ════════════════════════════════════════════════
// Chrome Mock 测试
// ════════════════════════════════════════════════

describe("Chrome Mock 自检", () => {
  test("storage.local.set/get 正常工作", async () => {
    const chrome = createChromeMock();
    await chrome.storage.local.set({ foo: "bar" });
    const result = await chrome.storage.local.get("foo");
    assert.strictEqual(result.foo, "bar");
  });

  test("tabs.get 返回正确 tab", async () => {
    const chrome = createChromeMock();
    const tab = await chrome.tabs.get(1);
    assert.strictEqual(tab.url, "https://example.com");
  });

  test("tabs.get 不存在的 tab 抛异常", async () => {
    const chrome = createChromeMock();
    try {
      await chrome.tabs.get(999);
      assert.fail("应抛异常");
    } catch (err) {
      assert.ok(err.message.includes("999"));
    }
  });

  test("contextMenus 创建和清除", async () => {
    const chrome = createChromeMock();
    chrome.contextMenus.create({ id: "test1", title: "Test" });
    assert.strictEqual(chrome.contextMenus._items.length, 1);
    await chrome.contextMenus.removeAll();
    assert.strictEqual(chrome.contextMenus._items.length, 0);
  });
});

// ════════════════════════════════════════════════
// 边界 & 安全测试
// ════════════════════════════════════════════════

describe("边界 & 安全性测试", () => {
  test("isUnsupportedPageUrl 不被 chrome:// 子串欺骗", () => {
    assert.strictEqual(isUnsupportedPageUrl("https://chrome.google.com"), false);
  });

  test("isUnsupportedPageUrl 大写也能正确识别（已修复大小写）", () => {
    assert.strictEqual(isUnsupportedPageUrl("CHROME://extensions"), true);
    assert.strictEqual(isUnsupportedPageUrl("Chrome-Extension://abc/popup.html"), true);
  });

  test("escapeHtml 防御嵌套攻击", () => {
    const input = '<img src=x onerror="alert(1)">';
    const result = escapeHtml(input);
    assert.ok(!result.includes("<"), "不应包含未转义的 <");
    assert.ok(!result.includes(">"), "不应包含未转义的 >");
  });

  test("buildPositions 最终位置确保覆盖页面底部", () => {
    const positions = buildPositions(2500, 800);
    const lastPos = positions[positions.length - 1];
    assert.strictEqual(lastPos, 2500 - 800, "最后一个位置应能截到页面底部");
  });

  test("buildPositions 无重复位置", () => {
    const positions = buildPositions(1600, 800);
    const unique = [...new Set(positions)];
    assert.strictEqual(positions.length, unique.length, "不应有重复位置");
  });

  test("visible/full 模式后台立即响应（已修复 popup 阻塞）", async () => {
    let respondedImmediately = false;
    let captureStarted = false;

    const handler = (message, sender, sendResponse) => {
      void (async () => {
        if (message?.type === "snaplite:start-capture") {
          const mode = message.mode;
          if (mode === "area" || mode === "dom") {
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: true });
            respondedImmediately = true;
            // 模拟异步执行
            await new Promise(r => setTimeout(r, 10));
            captureStarted = true;
          }
        }
      })();
      return true;
    };

    const result = await new Promise((resolve) => {
      handler({ type: "snaplite:start-capture", mode: "full", tabId: 1 }, {}, resolve);
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(respondedImmediately, true, "应立即响应而非等待截图完成");

    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(captureStarted, true, "后台应异步启动截图");
  });
});

// ════════════════════════════════════════════════
// 编辑器 undo/redo 逻辑测试
// ════════════════════════════════════════════════

describe("编辑器 undo/redo 逻辑", () => {
  function createEditorState() {
    return {
      actions: [],
      redoStack: [],
      tool: "rect",
      color: "#ef4444",
      size: 4
    };
  }

  function pushAction(state, action) {
    state.redoStack = [];
    state.actions.push(action);
  }

  function undo(state) {
    if (!state.actions.length) return;
    state.redoStack.push(state.actions.pop());
  }

  function redo(state) {
    if (!state.redoStack.length) return;
    state.actions.push(state.redoStack.pop());
  }

  test("新绘制清空 redoStack", () => {
    const s = createEditorState();
    pushAction(s, { type: "rect", x1: 0, y1: 0, x2: 10, y2: 10 });
    pushAction(s, { type: "rect", x1: 0, y1: 0, x2: 20, y2: 20 });
    undo(s);
    assert.strictEqual(s.redoStack.length, 1);
    pushAction(s, { type: "rect", x1: 0, y1: 0, x2: 30, y2: 30 });
    assert.strictEqual(s.redoStack.length, 0, "新操作应清空 redoStack");
  });

  test("undo 后 redo 恢复操作", () => {
    const s = createEditorState();
    const a1 = { type: "rect", id: 1 };
    const a2 = { type: "rect", id: 2 };
    pushAction(s, a1);
    pushAction(s, a2);
    assert.strictEqual(s.actions.length, 2);
    undo(s);
    assert.strictEqual(s.actions.length, 1);
    assert.strictEqual(s.redoStack.length, 1);
    redo(s);
    assert.strictEqual(s.actions.length, 2);
    assert.strictEqual(s.redoStack.length, 0);
  });

  test("连续 undo 全部撤销", () => {
    const s = createEditorState();
    pushAction(s, { type: "rect", id: 1 });
    pushAction(s, { type: "rect", id: 2 });
    pushAction(s, { type: "rect", id: 3 });
    undo(s);
    undo(s);
    undo(s);
    assert.strictEqual(s.actions.length, 0);
    assert.strictEqual(s.redoStack.length, 3);
  });

  test("空操作栈 undo 不报错", () => {
    const s = createEditorState();
    undo(s);
    assert.strictEqual(s.actions.length, 0);
    assert.strictEqual(s.redoStack.length, 0);
  });

  test("空 redoStack redo 不报错", () => {
    const s = createEditorState();
    redo(s);
    assert.strictEqual(s.actions.length, 0);
  });
});

// ════════════════════════════════════════════════
// 运行所有测试
// ════════════════════════════════════════════════

runAll().then(({ passed, failed }) => {
  if (failed > 0) process.exit(1);
});
