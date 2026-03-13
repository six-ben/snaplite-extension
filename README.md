# SnapLite 浏览器截图插件

一个简洁好用的浏览器截图插件（Chrome/Edge，Manifest V3）。

## 功能

- **可视区域截图** — 截取当前视口内容
- **区域截图** — 拖拽框选任意区域
- **整页截图** — 自动滚动拼接完整页面
- **DOM 元素截图** — 悬停选择页面元素，点击截图
- **标注** — 矩形、圆形、箭头、画笔、文字、马赛克
- **导出** — 复制到剪贴板 / 下载 PNG·JPG
- **历史** — 按站点筛选、全选批量删除、预览、复制、下载、再次编辑
- **设置** — 默认模式、格式、历史上限、整页兼容开关、可选上传
- **超长页面保护** — 整页截图自动降采样，避免内存溢出

## 本地安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择当前目录 `snaplite-extension`

## 使用方式

- 点击插件图标，选择截图方式
- 快捷键：
  - `Ctrl/Cmd + Shift + S` — 区域截图
  - `Ctrl/Cmd + Shift + V` — 可视区域截图
- 右键菜单 → SnapLite 子菜单
- 截图后自动打开编辑器进行标注与导出

## 不支持截图的页面

由于浏览器安全限制，以下类型的页面**无法截图**，插件会提示「当前页面受浏览器限制」：

| 页面类型 | URL 示例 | 原因 |
|---------|---------|------|
| Chrome 内置页 | `chrome://extensions`、`chrome://settings`、`chrome://newtab` | 浏览器禁止扩展访问内部页面 |
| 扩展页面 | `chrome-extension://xxx/popup.html` | 扩展之间相互隔离 |
| DevTools | `devtools://devtools/bundled/inspector.html` | 开发者工具内部页面 |
| Edge 内置页 | `edge://settings`、`edge://extensions` | 同 Chrome 限制 |
| about 页 | `about:blank`、`about:config` | 特殊协议页面 |
| 源代码查看 | `view-source:https://...` | 浏览器只读渲染页 |
| Chrome 搜索 | `chrome-search://local-ntp/...` | 内部搜索页面 |
| Chrome 应用商店 | `https://chromewebstore.google.com/...` | Google 额外安全限制，禁止扩展注入脚本 |
| PDF 查看器 | `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/...` | Chrome 内置 PDF 查看器属于扩展页面 |
| `file://` 本地文件 | `file:///Users/.../index.html` | 默认禁止，需在扩展管理页手动勾选「允许访问文件网址」 |

### 其他已知限制

- **整页截图** 在包含大量懒加载、无限滚动或动态渲染内容的页面，可能出现轻微拼接错位
- **整页截图** 在页面高度极大时（> 20000px），会自动降低分辨率以避免内存溢出
- **区域截图 / DOM 截图** 需要向页面注入 content script，某些安全策略严格的页面（如银行网站）可能阻止注入

## 调试方法

1. 打开 `chrome://extensions/`
2. 找到 SnapLite，点击「Service Worker」链接
3. 在弹出的 DevTools Console 面板中查看 `[SnapLite]` 前缀的日志
4. 所有关键操作都有日志输出：截图模式、tabId、URL、滚动位置、captureVisibleTab 结果等

## 运行测试

```bash
node test/run-all.js
```

零依赖，覆盖纯函数逻辑、消息路由、边界值、undo/redo 状态机等 71 个测试用例。
