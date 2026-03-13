"use strict";

function createChromeMock(overrides = {}) {
  const storage = {};
  const listeners = {};

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") {
            return { [keys]: storage[keys] };
          }
          const result = {};
          for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) {
            result[k] = storage[k];
          }
          return result;
        },
        async set(obj) {
          Object.assign(storage, obj);
        },
        _data: storage
      }
    },
    runtime: {
      onInstalled: { addListener(fn) { listeners.onInstalled = fn; } },
      onStartup: { addListener(fn) { listeners.onStartup = fn; } },
      onMessage: {
        addListener(fn) { listeners.onMessage = fn; },
        _trigger(message, sender = {}) {
          return new Promise((resolve) => {
            const result = listeners.onMessage(message, sender, resolve);
          });
        }
      },
      getURL(path) { return `chrome-extension://mock-id/${path}`; },
      sendMessage: async () => ({ ok: true }),
      openOptionsPage: async () => {}
    },
    tabs: {
      _tabs: {
        1: { id: 1, url: "https://example.com", title: "Example", windowId: 1 },
        2: { id: 2, url: "chrome://extensions", title: "Extensions", windowId: 1 },
        3: { id: 3, url: "", title: "Empty", windowId: 1 }
      },
      async get(tabId) {
        const tab = chrome.tabs._tabs[tabId];
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return tab;
      },
      async query() {
        return [chrome.tabs._tabs[1]];
      },
      async captureVisibleTab() {
        return "data:image/png;base64,AAAA";
      },
      async sendMessage(tabId, msg) {
        if (msg.type === "snaplite:ping") return { ok: true };
        if (msg.type === "snaplite:get-page-info") {
          return {
            ok: true,
            data: { totalHeight: 2000, viewportHeight: 800, dpr: 2, scrollY: 0 }
          };
        }
        if (msg.type === "snaplite:scroll-to") {
          return { ok: true, y: msg.y };
        }
        if (msg.type === "snaplite:prepare-full-capture") return { ok: true };
        if (msg.type === "snaplite:cleanup-full-capture") return { ok: true };
        if (msg.type === "snaplite:restore-scroll") return { ok: true };
        if (msg.type === "snaplite:start-area-select") return { ok: true };
        if (msg.type === "snaplite:start-dom-select") return { ok: true };
        return { ok: true };
      },
      async create() { return { id: 99 }; }
    },
    contextMenus: {
      _items: [],
      async removeAll() { chrome.contextMenus._items = []; },
      create(opts) { chrome.contextMenus._items.push(opts); },
      onClicked: {
        addListener(fn) { listeners.contextMenuClicked = fn; }
      }
    },
    commands: {
      onCommand: {
        addListener(fn) { listeners.onCommand = fn; }
      }
    },
    scripting: {
      async executeScript() { return []; }
    },
    _listeners: listeners,
    _storage: storage
  };

  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      if (typeof val === "object" && !Array.isArray(val) && chrome[key]) {
        Object.assign(chrome[key], val);
      } else {
        chrome[key] = val;
      }
    }
  }

  return chrome;
}

module.exports = { createChromeMock };
