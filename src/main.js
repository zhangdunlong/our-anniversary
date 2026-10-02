/**
 * ============================================================================
 *  main.js —— 应用入口（组合根 / Composition Root）
 * ============================================================================
 *
 *  职责边界：只做「装配」，不含任何业务逻辑。
 *    · 读取配置
 *    · 渲染静态文案
 *    · 按依赖顺序初始化各模块
 *    · 把需要互相通信的模块用事件或返回值接起来
 *
 *  设计原则：
 *    1. 任何单个模块初始化失败都不影响其余模块 —— 全部包在 safe() 里，
 *       一个彩蛋写崩了，情书照样能读；
 *    2. 模块统一返回 { destroy } 之类的句柄，集中登记到 app.modules，
 *       未来做局部热更新 / 卸载时不用改各模块代码；
 *    3. 初始化顺序按「先基础后装饰」：主题 → 背景 → 内容 → 交互特效，
 *       保证用户第一眼看到的是正确配色和内容，动画最后进场。
 * ============================================================================
 */

import { SITE_CONFIG } from './config/site.config.js';
import { $, setText, safe } from './core/dom.js';
import * as bus from './core/bus.js';

import { initTheme } from './modules/theme.js';
import { initStarfield } from './modules/starfield.js';
import { initHearts } from './modules/hearts.js';
import { initCounter } from './modules/counter.js';
import { initLetter } from './modules/letter.js';
import { initGallery } from './modules/gallery.js';
import { initMusic } from './modules/music.js';
import { initAnniversaries } from './modules/anniversaries.js';
import { initTopCountdown } from './modules/top-countdown.js';
import { initTimeline } from './modules/timeline.js';
import { initDailyQuote } from './modules/daily-quote.js';
import { initMilestone } from './modules/milestone.js';
import { initSharePoster } from './modules/share-poster.js';
import { initEasterEgg } from './modules/easter-egg.js';
import { initVisitStats } from './modules/visit-stats.js';

const config = SITE_CONFIG;

/* ==========================================================================
   模块登记表 —— 供调试与未来扩展（退出时统一 destroy）
   ========================================================================== */
const app = {
  config: config,
  modules: {},
  ready: false
};

function mount(name, api) {
  app.modules[name] = api;
  return api;
}

/* ==========================================================================
   1. 静态文案渲染 —— 让 HTML 不承担任何内容
   ========================================================================== */
function renderStatic() {
  const meta = config.meta || {};
  const couple = config.couple || {};

  if (meta.title) document.title = meta.title;
  setText('#site-title', meta.title || '');
  setText('#site-subtitle', meta.subtitle || '');

  // 计时器上方的双人署名
  setText('#couple-names', (couple.nameA || '') + ' & ' + (couple.nameB || ''));

  // 页脚年份：与「在一起」的年份对齐，形成时间跨度
  const from = couple.togetherAt ? couple.togetherAt.slice(0, 4) : String(new Date().getFullYear());
  setText('#footer-year', from);
}

/* ==========================================================================
   2. 启动
   ========================================================================== */
function boot() {
  renderStatic();

  // ---- 基础层：主题必须最先跑，否则会看到错误的配色一闪 ----
  mount('theme', safe('主题', function () { return initTheme(config); }));

  // ---- 背景层（纯装饰，出错也不影响内容）----
  mount('starfield', safe('星空背景', function () { return initStarfield(config); }));
  mount('hearts', safe('浮动爱心', function () { return initHearts(config); }));

  // ---- 内容层 ----
  mount('counter', safe('相爱计时', function () { return initCounter(config); }));
  // 顶部倒计时条依赖 anniversaries 暴露的 fetchAnniversaries（同向 import，符合分层）
  mount('topCountdown', safe('顶部倒计时', function () { return initTopCountdown(config); }));
  mount('quote', safe('每日情话', function () { return initDailyQuote(config); }));
  mount('milestone', safe('里程碑进度', function () { return initMilestone(config); }));
  mount('letter', safe('情书', function () { return initLetter(config); }));
  mount('timeline', safe('恋爱时间轴', function () { return initTimeline(config); }));
  mount('anniversaries', safe('纪念日', function () { return initAnniversaries(config); }));
  mount('gallery', safe('记忆卡片', function () { return initGallery(config); }));

  // ---- 交互层 ----
  mount('music', safe('音乐播放器', function () { return initMusic(config); }));
  mount('poster', safe('纪念海报', function () { return initSharePoster(config); }));
  mount('visitStats', safe('访问足迹', function () { return initVisitStats(config); }));
  mount('easterEgg', safe('点击彩蛋', function () { return initEasterEgg(config); }));

  // ---- 次级交互：把 UI 按钮接到模块能力上 ----
  safe('按钮绑定', function () { bindActions(); });

  // ---- PWA ----
  safe('离线缓存', function () { registerServiceWorker(); });

  app.ready = true;
  bus.emit('app:ready', app);

  console.log(
    '%c❤ ' + (config.meta.title || 'Love') + ' ❤',
    'color:#ff6b6b;font-size:13px;',
    '\n模块已加载：' + Object.keys(app.modules).filter(function (k) { return app.modules[k]; }).join(' / ')
  );
}

/* ==========================================================================
   3. 次级交互绑定
   ========================================================================== */
function bindActions() {
  // 「重读情书」
  const replayBtn = $('#letter-replay');
  const letter = app.modules.letter;
  if (replayBtn && letter && letter.replay) {
    replayBtn.addEventListener('click', function () {
      letter.replay();
      const box = $('#letter');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // 音乐面板在触屏设备上的展开开关
  const group = $('#music-group');
  const expand = $('#music-expand');
  if (group && expand) {
    expand.addEventListener('click', function (e) {
      e.stopPropagation();
      group.classList.toggle('is-expanded');
    });
    document.addEventListener('click', function (e) {
      if (!group.contains(e.target)) group.classList.remove('is-expanded');
    });
  }

  // 打印（保留成纸质纪念册的可能）
  const printBtn = $('#print-page');
  if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

  // 主题切换后重绘海报（若弹窗开着）
  bus.on(bus.EVENTS.THEME_CHANGE, function () {
    const poster = app.modules.poster;
    if (poster && poster.draw) poster.draw();
  });
}

/* ==========================================================================
   4. Service Worker 注册
   ========================================================================== */
function registerServiceWorker() {
  // 单文件离线版（build-standalone 产物）没有 sw.js，直接跳过
  if (window.__LOVE_STANDALONE__) return;
  // file:// 协议下 SW 不可用，直接跳过（本地双击打开也能正常浏览）
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('[love] Service Worker 注册失败（不影响正常使用）：', err);
    });
  });
}

/* ==========================================================================
   5. 启动时机 —— DOM 就绪即启动
   ========================================================================== */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/* 暴露给开发者工具，便于排查与扩展 */
window.__LOVE__ = app;
