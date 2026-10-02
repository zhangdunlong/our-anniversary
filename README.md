# 我们的纪念日 · Our Anniversary

一个**零依赖**的浪漫纪念日主页：相爱实时计时、纪念日倒计时、恋爱时间轴、每日情话、一键生成分享海报、昼夜双主题，**外加一个纪念日后台管理系统**。

前端是纯静态站点，不需要构建工具。后台可选 —— 接上 Cloudflare Pages + KV 后，就能在网页上直接增删改纪念日，不用再改代码重新部署。

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
| **顶部倒计时条** | 页面顶部常驻「距离最近的纪念日还有 N 天」，当天切换为高亮 |
| 恋爱时间轴 | 自动推算百天里程碑 + 自定义真实事件，按时间轴呈现「来路—此刻—去向」 |
| 每日情话 | 以日期为种子确定性选取，同一天永远同一句；支持「换一句」「复制」 |
| 里程碑进度条 | 距离下一个整百天还有多远，达成当天撒花庆祝 |
| 分享海报 | Canvas 手绘 1080×1620 海报，配色跟随主题，可下载 / 调起系统分享 |
| 昼夜双主题 | 星夜 / 晨光一键切换，默认跟随系统，选择会被记住 |
| 点击彩蛋 | 每次点击散出小簇爱心，连点 7 次触发满屏爱心爆炸 |
| 访问足迹 | 本地记录来访次数与连续天数（纯 localStorage，不联网、不上报） |

### 后台管理（可选）

| 功能 | 说明 |
| --- | --- |
| 独立登录页 | 管理员密码认证，未登录不能访问任何管理页面，支持退出登录 |
| 修改登录密码 | 顶栏 🔑 打开弹窗，需验证原密码；带明文切换、实时强度条、逐字段错误提示；成功后自动退出登录，旧密码立即失效 |
| 日期日历选择 | 新增 / 编辑弹窗点 📅 弹出零依赖日历：完整日期（YYYY-MM-DD）与只选月日（MM-DD = 每年重复）两种模式一键切换，翻月 / 年份下拉 / 今天描边 / 选中高亮，手输依然可用 |
| 纪念日增删改查 | 列表展示，支持按日期 / 创建时间 / 名称排序，支持关键词搜索与显示状态筛选 |
| 字段完整 | 名称、日期、类型（生日 / 恋爱纪念日 / 节日 / 纪念日 / 其它）、备注、图标、是否显示在首页、是否每年重复 |
| 数据校验 | 前后端同一套规则：日期必须真实存在（`2023-02-29` 会被拒）、名称不能为空；操作有明确成功 / 失败提示 |
| 删除二次确认 | 弹出确认框并显示待删条目名，点「取消」不会误删 |
| 响应式 | 手机端表格自动转为卡片，操作按钮换行放大，无横向滚动 |

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

## 启用后台管理（可选）

后台需要一点服务端能力（存数据 + 验密码），用 **Cloudflare Pages + KV** 实现，仍然在免费额度内。
不需要后台的话完全跳过这一节，站点会正常以 `site.config.js` 里的数据运行。

```bash
# 1. 建 KV 命名空间，把返回的 id 填进 wrangler.toml
npx wrangler kv namespace create LOVE_DATA

# 2. 设置管理员密码（交互式输入，不回显；密码不会写进任何文件）
npm run init-admin

# 3. 本地跑完整环境（含 Worker + KV）验证
npm run dev:pages            # → http://127.0.0.1:8788
npm run smoke:admin -- http://127.0.0.1:8788 <你的密码>

# 4. 部署
npm run build
npx wrangler pages deploy dist/site --project-name=our-anniversary --branch=main
```

登录地址：`https://<你的域名>/admin/`

### 后台是怎么工作的

```
浏览器
  ├── /                前台纪念页
  │     └── GET /api/anniversaries   ← 读后台维护的纪念日
  ├── /admin/          后台管理页（登录 + CRUD + 修改密码）
  │     └── /api/login · /api/logout · /api/admin/password · /api/admin/anniversaries[/:id]
  └── 其余一切 → 静态资源
                    ▲
              _worker.js（单一 Worker，约 890 行）
                    │
              Cloudflare KV
                ├── anniversaries       纪念日数组
                ├── admin:password      "pbkdf2$<迭代次数>$<盐hex>$<哈希hex>"
                ├── admin:tokenEpoch    令牌世代（改密时轮换 → 旧 token 集体失效）
                ├── admin:pwdChangedAt  上次改密时间（防抖冷却用）
                ├── token:<value>       登录令牌（值为签发时的 epoch，7 天 TTL）
                └── rl:<scope>:<ip>     失败计数（软限流）
```

**安全设计**：密码用 **PBKDF2-SHA256**（默认 10 000 次迭代）派生后存入 KV，**永不落盘、永不进仓库**；
哈希串自带版本前缀（`pbkdf2$…`），旧版 `salt:sha256(...)` 会在登录成功时自动重算升级；
校验用恒定时间比较防时序攻击；登录签发 32 字节随机 token，带 TTL，过期自动清除；
**改密码会轮换令牌世代**，所有旧 token 立即失效（不依赖遍历删除，因为 KV 的 list 是最终一致的）；
登录与改密共用按 IP 的失败限流（窗口 300 s / 上限 8 次），改密另有 15 s 冷却；
所有写操作强制鉴权；错误文案不区分「密码错」与「账号不存在」。

> **关于迭代次数**：Workers 免费版每请求只有 10 ms CPU，迭代次数调太高会直接触发 Error 1102。
> 默认取 10 000（本机实测约 1.5 ms）。付费版可在 `wrangler.toml` 的 `[vars] PBKDF2_ITERATIONS`
> 单调调到 600 000（OWASP 对 PBKDF2-SHA256 的建议值），无需改代码。

**关于缓存**：`sw.js` 对 `/api/*` **与 `/admin/*` 完全不接管**（直接走网络）。否则后台会读到过期数据，
含鉴权信息的响应会被长期写进 Cache Storage；后台脚本被缓存还会导致「部署新版后按钮看得见、点不动」
（浏览器执行的是旧 JS，事件没绑定）。

**降级策略**：前台读取数据是三级兜底 —— 后台 API → `site.config.js` 的 `anniversaries.custom` → 内置公共节日。
任何网络异常都被静默吞掉，用户看到的永远是内容而不是加载失败。所以**后台挂了，前台照常可用**。

---

## 目录结构

```
.
├── index.html                    页面骨架（只有结构 + 挂载点，没有任何内容）
├── manifest.webmanifest          PWA 清单
├── sw.js                         Service Worker（导航网络优先 / 资源缓存优先）
├── robots.txt                    禁止收录
├── _headers                      Cloudflare Pages 安全响应头
├── wrangler.toml                 Pages 项目配置 + KV 绑定
│
├── public/                       ★ 会被摊平到部署根目录
│   ├── _worker.js                后端：API + KV + 鉴权（不想用后台可以删掉整个 public/）
│   └── admin/                    后台管理页
│       ├── index.html            登录视图 + 管理视图 + 三个模态框（新增/编辑、删除确认、修改密码）
│       ├── admin.css             后台样式（复用前台 tokens.css）
│       └── admin.js              API 层 / 状态 / 渲染 / 校验 / 强度评估 / 事件
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
│   │   ├── anniversaries.js      纪念日倒计时（含后台数据接入 + 降级）
│   │   ├── top-countdown.js      顶部倒计时条
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
    ├── check.mjs                 静态自检 5 项 / 13 条校验（id 对齐 / import 解析 / 语法 / 漏 import / KV 绑定 / 密码规则一致）
    ├── smoke.mjs                 真实浏览器端到端冒烟（直连 CDP，不用 playwright）
    ├── smoke-admin.mjs           后台 API 冒烟（58 项断言，--with-ratelimit 追加 5 项限流断言）
    ├── smoke-admin-ui.mjs        后台界面冒烟（55 项断言，真实浏览器，结束自动清理测试数据）
    ├── init-admin.mjs            初始化 / 重置管理员密码 → PBKDF2 哈希写入 KV
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

   后端          _worker.js           与前端完全解耦：只认 HTTP 契约，不关心谁调用
```

**依赖方向严格单向向下**：模块可以依赖 core，core 绝不依赖模块；模块之间不互相 import，需要通信就走 `core/bus.js`。这样删掉任意一个模块，其余代码都不会报错。

### 三条设计原则

**1. 内容与代码彻底分离。**
所有会变的文案、日期、人名都收敛进 `src/config/site.config.js`。`index.html` 里没有任何一句真实内容，只有结构骨架。想改情书不用翻 760 行 HTML。
启用后台之后，纪念日这部分内容进一步从「改文件」变成「在网页上改」，连重新部署都不需要。

**2. 一个模块坏掉，不能拖垮整页。**
`main.js` 里每个模块都用 `safe()` 包裹：

```js
mount('starfield', safe('星空背景', () => initStarfield(config)));
```

某个模块抛异常只会打印一条 warning，其余模块照常工作。浏览器端冒烟测试正是靠这条机制，在页面「看起来正常」的情况下抓出了两个模块的崩溃。

**3. 主题即变量，切换即改一个属性。**
所有颜色都是 CSS 自定义属性，切换主题只是改 `<html data-theme>`。JS 从不接触具体色值 —— 连 Canvas 绘制的分享海报都是通过 `getComputedStyle` 读取变量取色，所以海报会自动跟随当前主题。**后台也复用同一套变量**，因此风格天然一致、双主题自动生效。

### 性能取舍

- **动画帧统一调度**：所有 `requestAnimationFrame` 走 `core/raf.js`，页面切到后台自动停帧（手机锁屏不再空转耗电）。
- **避免布局抖动**：滚动进场从 `scroll` + `getBoundingClientRect()` 改为 `IntersectionObserver`，滚动时零 layout 开销。
- **减少无谓写入**：计时器只在数值真正变化时才写 DOM，比每秒无条件写四次少 90% 以上的重排。
- **粒子用完即焚**：爱心与撒花粒子监听 `animationend` 自我销毁，不产生 DOM 泄漏。
- **尊重用户偏好**：识别 `prefers-reduced-motion`，开启后关闭所有循环动画。

---

## 部署

任何静态托管都可以跑前台。要用后台则需要 Cloudflare Pages（或任何支持 Workers + KV 的平台）。

### Cloudflare Pages

```bash
npm run check                      # 部署前自检，不通过就别上传
npm run build                      # 产出 dist/site（public/ 会摊平到根目录）
npx wrangler pages project create our-anniversary --production-branch=main
npx wrangler kv namespace create LOVE_DATA      # 把 id 填进 wrangler.toml
npm run init-admin                 # 设置管理员密码
npx wrangler pages deploy dist/site --project-name=our-anniversary --branch=main
```

`_headers` 里已经配好 `X-Robots-Tag: noindex`、CSP、`X-Frame-Options` 等安全头，
`/admin/*` 还有更严的一档（禁缓存、`frame-ancestors 'none'`、`X-Frame-Options: DENY`）。

### 其它平台

`npm run build` 产出的 `dist/site/` 是纯静态目录，扔到 Vercel / Netlify / GitHub Pages / Nginx 都能直接跑
（但只有 Cloudflare 这类支持 Workers 的平台能用后台；其它平台前台会自动降级到 config 数据）。

---

## 开发工具

```bash
# 前台
npm run dev                # 本地预览
npm run check              # 静态自检（5 项）
npm run build              # 部署目录
npm run build:standalone   # 单文件 HTML
npm run icons              # 重新生成 PWA 图标（需要 Python 3）

# 后台
npm run init-admin                       # 设置 / 重置管理员密码（不走 Worker，不吊销会话）
npm run admin:check                      # 只检查密码是否已初始化
npm run dev:pages                        # 本地完整 Pages 环境（含 Worker + KV）
npm run smoke:admin -- <url> <密码>       # 后台 API 冒烟（58 项）
npm run smoke:admin -- <url> <密码> --with-ratelimit   # 追加 5 项限流断言（63 项）
npm run smoke:admin:ui -- <url> <密码>    # 后台界面冒烟（55 项）
```

`npm run check` 会检查：HTML id 与 JS 引用是否对齐、import 路径是否可解析、模块语法、静态资源是否齐全、
**有没有漏写 import 的跨模块调用**，以及后台文件是否齐全、KV 绑定与 Worker 里用的 `env.*` 是否对得上、
**后台 JS 引用的元素 id 是否都存在于后台页面**、**密码长度规则前后端是否一致**。全部零依赖，用 Node 标准库实现。

`npm run smoke` 会真的启动一个无头 Chrome，打开页面、跑 24 项功能断言、收集控制台错误与失败请求、模拟滚动确认所有进场元素都正常显示，最后输出三张截图。同样零依赖 —— 用 Node 22 内置的 `WebSocket` 直连 CDP，不需要装 playwright。

`npm run smoke:admin` 与 `npm run smoke:admin:ui` 则把后台从鉴权、校验、增删改查、**修改密码全链路**
到响应式完整跑一遍（58 + 55 项断言），既能对本地也能对线上地址执行。
界面冒烟在结束时会自动串行清理自己写入的测试数据 —— 后台的删除接口是「读-改-写」，
并行删除会互相覆盖，所以清理必须串行。

---

## 浏览器支持

Chrome / Edge 90+、Firefox 90+、Safari 15+。

用到的现代特性：ES Modules、CSS 自定义属性、`backdrop-filter`、`IntersectionObserver`、`conic-gradient`、`canvas.roundRect`（有降级实现）。老浏览器会自动降级：`IntersectionObserver` 缺失时内容直接显示而不是隐藏。

---

## License

MIT
