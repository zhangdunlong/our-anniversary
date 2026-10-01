# 我们的纪念日 · Our Anniversary

一个**零依赖**的浪漫纪念日主页：相爱实时计时、纪念日倒计时、恋爱时间轴、每日情话、一键生成分享海报、昼夜双主题。

纯前端静态站点，不需要后端、不需要数据库、不需要构建工具。克隆下来改一个配置文件就能变成你自己的。

> 项目用原生 ES Modules 写成分层模块化架构，不含任何框架、不含任何运行时依赖。首次加载的全部代码约 60 KB（gzip 后更小）。

---

## 功能

### 核心功能

| 功能 | 说明 |
| --- | --- |
| 星空背景 | Canvas 绘制，按屏幕面积自适应星点数量，支持高 DPI，页面隐藏时自动停帧省电 |
| 浮动爱心 | 爱心粒子循环上升，节点用完即回收，DOM 数量恒定 |
| 相爱计时 | 天 / 时 / 分 / 秒 实时跳动，对齐整秒边界，长期运行不漂移 |
| 情书 | 进入信纸范围后逐行手写般浮现，支持「重读一遍」 |
| 记忆卡片 | 数据驱动的四张卡片，可点击展开详情 |
| 背景音乐 | 播放进度环、进度条、音量、记忆播放位置、首次交互自动续播 |

### 新增功能

| 功能 | 说明 |
| --- | --- |
| 纪念日倒计时 | 在一起纪念日 + 公共节日 + 自定义（生日等），按临近程度排序，当天自动撒花 |
| 恋爱时间轴 | 自动推算百天里程碑 + 自定义真实事件，按时间轴呈现「来路—此刻—去向」 |
| 每日情话 | 以日期为种子确定性选取，同一天永远同一句；支持「换一句」「复制」 |
| 里程碑进度条 | 距离下一个整百天还有多远，达成当天撒花庆祝 |
| 分享海报 | Canvas 手绘 1080×1620 海报，配色跟随主题，可下载 / 调起系统分享 |
| 昼夜双主题 | 星夜 / 晨光一键切换，默认跟随系统，选择会被记住 |
| 点击彩蛋 | 每次点击散出小簇爱心，连点 7 次触发满屏爱心爆炸 |
| 访问足迹 | 本地记录来访次数与连续天数（纯 localStorage，不联网、不上报） |

另外还带 **PWA**（可安装到手机桌面 + 离线可用）、**键盘可达**、**`prefers-reduced-motion` 适配**、**打印排版**。

---

## 快速开始

```bash
# 1. 起一个本地静态服务器（ES Modules 不能用 file:// 打开）
npm run dev            # → http://127.0.0.1:5173

# 2. 改配置（只改这一个文件就能完成个性化）
#    src/config/site.config.js

# 3. 打包成可双击打开的单文件版
npm run build:standalone            # dist/love-standalone.html（约 140 KB，不含音频）
npm run build:standalone:audio      # 含内嵌音频，体积取决于 mp3 大小
```

> 为什么必须用本地服务器：浏览器对 `<script type="module">` 执行同源策略检查，
> 直接双击 `index.html`（`file://`）会被 CORS 拦死。
> 项目自带一个零依赖的静态服务器（`scripts/dev-server.mjs`），不需要装任何东西。
> 如果你确实想要「双击就能打开」的形态，用 `npm run build:standalone`。

### 换成你自己的内容

只需要编辑 `src/config/site.config.js`：

```js
couple: {
  nameA: '小美',
  nameB: '小杰',
  togetherAt: '2023-05-20T20:00:00',   // 你们在一起的那一刻
  signature: '爱你的小杰'
}
```

情书正文、每日情话、记忆卡片、纪念日、时间轴、点击彩蛋文案全部在同一个文件里，都有注释说明。

放背景音乐：把 mp3 丢进 `assets/audio/`，然后把 `music.src` 指向它。留空字符串则自动隐藏播放按钮。

---

## 目录结构

```
.
├── index.html                    页面骨架（只有结构 + 挂载点，没有任何内容）
├── manifest.webmanifest          PWA 清单
├── sw.js                         Service Worker（导航网络优先 / 资源缓存优先）
├── robots.txt                    禁止收录
├── _headers                      Cloudflare Pages 安全响应头
│
├── src/
│   ├── config/
│   │   └── site.config.js        ★ 全站唯一配置源
│   │
│   ├── core/                     基础能力层（不含任何业务逻辑）
│   │   ├── dom.js                $ / $$ / create / on / setText / clear / safe
│   │   ├── time.js               日期解析、时长拆分、下一个纪念日、确定性随机
│   │   ├── store.js              localStorage 封装（命名空间 + 内存降级）
│   │   ├── bus.js                事件总线 + 事件名常量表
│   │   ├── raf.js                可暂停的动画帧调度 + 可见性感知
│   │   └── reveal.js             滚动进场（IntersectionObserver）
│   │
│   ├── modules/                  业务模块（每个都独立可插拔）
│   │   ├── starfield.js          星空背景
│   │   ├── hearts.js             浮动爱心
│   │   ├── counter.js            相爱计时
│   │   ├── letter.js             情书逐行书写
│   │   ├── gallery.js            记忆卡片
│   │   ├── music.js              音乐播放器
│   │   ├── anniversaries.js      纪念日倒计时
│   │   ├── timeline.js           恋爱时间轴
│   │   ├── daily-quote.js        每日情话
│   │   ├── milestone.js          里程碑进度
│   │   ├── share-poster.js       分享海报
│   │   ├── theme.js              昼夜主题
│   │   ├── easter-egg.js         点击彩蛋
│   │   ├── visit-stats.js        访问足迹
│   │   └── confetti.js           共享特效层（爱心粒子 / 撒花 / 提示条）
│   │
│   ├── styles/                   样式四层
│   │   ├── tokens.css            设计令牌（颜色 / 圆角 / 动效 / 双主题变量）
│   │   ├── base.css              重置 / 排版 / 关键帧 / 无障碍
│   │   ├── layout.css            容器 / 栅格 / 响应式断点
│   │   └── components.css        组件样式
│   │
│   └── main.js                   组合根：只做装配，不含业务逻辑
│
├── assets/
│   ├── audio/                    背景音乐（放你自己的 mp3，勿提交版权音乐）
│   └── icons/                    PWA 图标
│
└── scripts/                      开发工具（零依赖，全部用 Node 标准库）
    ├── dev-server.mjs            本地静态服务器
    ├── check.mjs                 静态自检（id 对齐 / import 解析 / 语法 / 漏 import）
    ├── smoke.mjs                 真实浏览器端到端冒烟（直连 CDP，不用 playwright）
    ├── build-site.mjs            产出干净的部署目录
    ├── build-standalone.mjs      自研微型打包器 → 单文件 HTML
    └── gen-icons.py              纯 Python 生成 PWA 图标（不用 Pillow）
```

---

## 架构说明

### 分层

```
   组合根        main.js              只负责「装配」，不含业务
      ↓
   业务层        modules/*.js         每个功能一个模块，独立可插拔
      ↓
   基础层        core/*.js            与业务无关的通用能力
      ↓
   样式层        styles/*.css         tokens → base → layout → components
```

**依赖方向严格单向向下**：模块可以依赖 core，core 绝不依赖模块；模块之间不互相 import，需要通信就走 `core/bus.js`。这样删掉任意一个模块，其余代码都不会报错。

### 三条设计原则

**1. 内容与代码彻底分离。**
所有会变的文案、日期、人名都收敛进 `src/config/site.config.js`。`index.html` 里没有任何一句真实内容，只有结构骨架。想改情书不用翻 760 行 HTML。

**2. 一个模块坏掉，不能拖垮整页。**
`main.js` 里每个模块都用 `safe()` 包裹：

```js
mount('starfield', safe('星空背景', () => initStarfield(config)));
```

某个模块抛异常只会打印一条 warning，其余模块照常工作。浏览器端冒烟测试正是靠这条机制，在页面「看起来正常」的情况下抓出了两个模块的崩溃。

**3. 主题即变量，切换即改一个属性。**
所有颜色都是 CSS 自定义属性，切换主题只是改 `<html data-theme>`。JS 从不接触具体色值 —— 连 Canvas 绘制的分享海报都是通过 `getComputedStyle` 读取变量取色，所以海报会自动跟随当前主题。

### 性能取舍

- **动画帧统一调度**：所有 `requestAnimationFrame` 走 `core/raf.js`，页面切到后台自动停帧（手机锁屏不再空转耗电）。
- **避免布局抖动**：滚动进场从 `scroll` + `getBoundingClientRect()` 改为 `IntersectionObserver`，滚动时零 layout 开销。
- **减少无谓写入**：计时器只在数值真正变化时才写 DOM，比每秒无条件写四次少 90% 以上的重排。
- **粒子用完即焚**：爱心与撒花粒子监听 `animationend` 自我销毁，不产生 DOM 泄漏。
- **尊重用户偏好**：识别 `prefers-reduced-motion`，开启后关闭所有循环动画。

---

## 部署

任何静态托管都可以。项目自带 Cloudflare Pages 的配置（`_headers` / `robots.txt`）。

### Cloudflare Pages

```bash
npm run check                      # 部署前自检，不通过就别上传
npm run build                      # 产出 dist/site
npx wrangler pages project create our-anniversary --production-branch=main
npx wrangler pages deploy dist/site --project-name=our-anniversary --branch=main
```

`_headers` 里已经配好 `X-Robots-Tag: noindex`、CSP、`X-Frame-Options` 等安全头。

### 其它平台

`npm run build` 产出的 `dist/site/` 是纯静态目录，扔到 Vercel / Netlify / GitHub Pages / Nginx 都能直接跑。

---

## 开发工具

```bash
npm run dev                # 本地预览
npm run check              # 静态自检（5 项）
npm run build              # 部署目录
npm run build:standalone   # 单文件 HTML
npm run icons              # 重新生成 PWA 图标（需要 Python 3）
```

`npm run check` 会检查：HTML id 与 JS 引用是否对齐、import 路径是否可解析、模块语法、静态资源是否齐全、**有没有漏写 import 的跨模块调用**。全部零依赖，用 Node 标准库实现。

`npm run smoke` 会真的启动一个无头 Chrome，打开页面、跑 23 项功能断言、收集控制台错误与失败请求、模拟滚动确认所有进场元素都正常显示，最后输出三张截图。同样零依赖 —— 用 Node 22 内置的 `WebSocket` 直连 CDP，不需要装 playwright。

---

## 浏览器支持

Chrome / Edge 90+、Firefox 90+、Safari 15+。

用到的现代特性：ES Modules、CSS 自定义属性、`backdrop-filter`、`IntersectionObserver`、`conic-gradient`、`canvas.roundRect`（有降级实现）。老浏览器会自动降级：`IntersectionObserver` 缺失时内容直接显示而不是隐藏。

---

## License

MIT
