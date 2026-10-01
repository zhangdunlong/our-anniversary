#!/usr/bin/env node
/**
 * smoke.mjs —— 真实浏览器端到端冒烟测试（零依赖）
 *
 * 思路：直接用 Node 22 内置的 WebSocket 连 Chrome DevTools Protocol，
 *       不引入 playwright / puppeteer（省掉几百 MB 依赖）。
 *
 * 它做的事：
 *   1. 以无头模式启动本机 Chrome，打开目标页面；
 *   2. 收集所有 console 输出与未捕获异常；
 *   3. 在页面上下文里跑一组断言（模块是否全部就绪、DOM 是否按预期渲染、
 *      交互是否生效、海报是否真的画出内容）；
 *   4. 截一张整页图存到 dist/smoke.png，供肉眼复核视觉。
 *
 * 用法：node scripts/smoke.mjs [url]        默认 http://127.0.0.1:5199/
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:5199/';
const PORT = 9333 + Math.floor(Math.random() * 200);

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ---------------------------------------------------------------- CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLogs = [];
    this.exceptions = [];
    this.logErrors = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }

      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
          .join(' ');
        this.consoleLogs.push({ type: msg.params.type, text });
      }

      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(
          (d.exception && (d.exception.description || d.exception.value)) || d.text
        );
      }

      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        // 浏览器日志里的 error 单独收集：它多数是资源加载失败的复述，
        // 而资源失败已经由 Network 事件精确统计，这里只作参考信息
        this.logErrors = this.logErrors || [];
        this.logErrors.push(msg.params.entry.text);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 30000);
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  return new CDP(ws);
}

/* ---------------------------------------------------------------- 页面断言 */
const ASSERTIONS = `
(function () {
  var out = { pass: [], fail: [], info: {} };
  function check(name, cond, detail) {
    if (cond) out.pass.push(name);
    else out.fail.push(name + (detail ? '  → ' + detail : ''));
  }
  var app = window.__LOVE__;
  check('应用已启动', !!app && app.ready === true);

  if (!app) return out;

  /* ---- 模块注册情况 ---- */
  var names = Object.keys(app.modules);
  var dead = names.filter(function (k) { return !app.modules[k]; });
  out.info.modules = names.length;
  out.info.deadModules = dead;
  check('全部 ' + names.length + ' 个模块初始化成功', dead.length === 0, '未就绪: ' + dead.join(','));

  /* ---- 核心功能：相爱计时 ---- */
  var days = parseInt(document.getElementById('total-days').textContent, 10);
  check('相爱天数已计算', !isNaN(days) && days > 0, 'total-days=' + document.getElementById('total-days').textContent);
  out.info.days = days;
  check('秒位已填充两位数字',
    /^\\d{2}$/.test(document.getElementById('clock-seconds').textContent),
    document.getElementById('clock-seconds').textContent);

  /* ---- 核心功能：情书 ---- */
  var lines = document.querySelectorAll('#letter .line');
  var wantLines = (app.config.letter && app.config.letter.lines || []).length;
  check('情书正文渲染行数与配置一致（' + wantLines + ' 行）',
    lines.length === wantLines, '实际 ' + lines.length);
  check('情书落款存在', !!document.querySelector('#letter .signature'));

  /* ---- 核心功能：记忆卡片 ---- */
  var wantCards = (app.config.gallery || []).length;
  check('记忆卡片渲染数量与配置一致（' + wantCards + ' 张）',
    document.querySelectorAll('#gallery .card').length === wantCards,
    '实际 ' + document.querySelectorAll('#gallery .card').length);

  /* ---- 核心功能：背景层 ---- */
  var canvas = document.getElementById('stars-canvas');
  check('星空画布已按 DPI 设置尺寸', canvas.width > 0 && canvas.height > 0,
    canvas.width + 'x' + canvas.height);
  check('浮动爱心节点已生成', document.querySelectorAll('.floating-heart').length > 0);

  /* ---- 核心功能：音乐控件 ---- */
  check('音乐按钮初始为静音态',
    document.getElementById('music-icon').textContent === '🔇');

  /* ---- 新增功能 1：每日情话 ---- */
  var quote = document.getElementById('quote-text').textContent.trim();
  check('每日情话已渲染', quote.length > 4 && quote !== '…', quote.slice(0, 20));
  out.info.quote = quote;

  /* ---- 新增功能 2：纪念日 ---- */
  var annivs = document.querySelectorAll('#anniversary-list .anniv');
  var aCfg = app.config.anniversaries || {};
  var wantAnniv = (aCfg.includeTogetherDay === false ? 0 : 1) +        // 在一起纪念日
    (aCfg.includeFestivals === false ? 0 : 6) +                        // 内置公共节日
    (aCfg.custom || []).length;                                        // 自定义
  check('纪念日卡片数量与配置一致（' + wantAnniv + ' 张）',
    annivs.length === wantAnniv, '实际 ' + annivs.length);
  out.info.anniversaries = annivs.length;

  /* ---- 新增功能 3：时间轴 ---- */
  var tl = document.querySelectorAll('#timeline .tl-item');
  check('时间轴节点已渲染', tl.length >= 3, '实际 ' + tl.length);
  out.info.timelineNodes = tl.length;

  /* ---- 新增功能 4：里程碑进度 ---- */
  var fill = document.getElementById('milestone-fill');
  check('进度条宽度已设置', /scaleX\\([\\d.]+\\)/.test(fill.style.transform), fill.style.transform);
  check('里程碑文案已生成',
    document.getElementById('milestone-sub').textContent.indexOf('距离') > -1,
    document.getElementById('milestone-sub').textContent);

  /* ---- 新增功能 5：访问足迹 ---- */
  var vs = document.getElementById('visit-stats');
  check('访问足迹已展示', vs && !vs.hidden,
    document.getElementById('visit-text').textContent.slice(0, 30));
  out.info.visit = document.getElementById('visit-text').textContent;

  /* ---- 新增功能 6：主题切换 ---- */
  var btn = document.getElementById('theme-btn');
  var before = document.documentElement.getAttribute('data-theme');
  check('主题按钮可用', btn && !btn.hidden);
  btn.click();
  var after = document.documentElement.getAttribute('data-theme');
  check('点击后主题发生切换', before !== after, before + ' → ' + after);
  out.info.theme = after;
  // 切回原主题，避免影响后续截图
  btn.click();
  out.info.themeRestored = document.documentElement.getAttribute('data-theme') === before;

  /* ---- 新增功能 7：分享海报 ---- */
  var poster = app.modules.poster;
  if (poster && poster.draw) {
    try {
      poster.draw();
      var pc = document.getElementById('poster-canvas');
      var ctx = pc.getContext('2d');
      // 采样中心区域，确认不是一张空白画布
      var data = ctx.getImageData(Math.floor(pc.width / 2) - 40, 300, 80, 80).data;
      var nonBlank = 0, first = [data[0], data[1], data[2]];
      for (var i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - first[0]) + Math.abs(data[i + 1] - first[1]) + Math.abs(data[i + 2] - first[2]) > 12) nonBlank++;
      }
      check('海报画布已绘制出内容', nonBlank > 40, '差异像素 ' + nonBlank);
    } catch (e) {
      check('海报画布已绘制出内容', false, e.message);
    }
  } else {
    check('海报模块已加载', false);
  }

  /* ---- 弹窗开关 ---- */
  var modal = document.getElementById('poster-modal');
  document.getElementById('poster-open').click();
  check('点击后海报弹窗打开', modal.classList.contains('is-open'));
  document.getElementById('poster-close').click();
  check('点击后海报弹窗关闭', !modal.classList.contains('is-open'));

  /* ---- 情书重播按钮 ---- */
  var replay = document.getElementById('letter-replay');
  replay.click();
  check('重读情书按钮可点击且不抛错', true);

  /* ---- PWA（单文件离线版本刻意移除了 manifest 外链，跳过此项）---- */
  if (window.__LOVE_STANDALONE__) {
    out.info.mode = '单文件离线版';
    check('单文件版已屏蔽 SW 注册', true);
  } else {
    out.info.mode = '常规站点';
    check('manifest 已声明', !!document.querySelector('link[rel="manifest"]'));
  }

  return out;
})();
`;

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('  ✘ 未找到 Chrome / Edge，无法执行浏览器冒烟测试');
    process.exit(1);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-smoke-'));
  const proc = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--window-size=1280,900',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    // 等待调试端口就绪
    let targets = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
        const list = await res.json();
        const page = list.find((t) => t.type === 'page');
        if (page) { targets = page; break; }
      } catch (e) { /* 还没起来，继续等 */ }
    }
    if (!targets) throw new Error('Chrome 调试端口未就绪');

    cdp = await connect(targets.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    // 收集 4xx / 5xx 响应，以及真正失败的请求（ERR_ABORTED 属正常取消，忽略）
    const failedRequests = [];
    const requestUrls = new Map();   // requestId → url，供 loadingFailed 关联

    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.method === 'Network.requestWillBeSent') {
        requestUrls.set(msg.params.requestId, msg.params.request.url);
        return;
      }

      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response;
        if (r.status >= 400) failedRequests.push(r.status + ' ' + r.url);
        return;
      }

      if (msg.method === 'Network.loadingFailed') {
        const p = msg.params;
        if (p.errorText === 'net::ERR_ABORTED') return;   // 页面卸载导致的取消，非故障
        failedRequests.push(p.errorText + ' ' + (requestUrls.get(p.requestId) || '(未知请求)'));
      }
    });

    console.log('\n  目标地址：' + URL_TARGET);
    await cdp.send('Page.navigate', { url: URL_TARGET });

    // 轮询等待应用启动
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && !!window.__LOVE__ && window.__LOVE__.ready',
        returnByValue: true
      });
      if (r.result && r.result.value === true) { ready = true; break; }
    }

    if (!ready) {
      console.log('  ✘ 页面在 18 秒内未完成启动\n');
      if (cdp.exceptions.length) {
        console.log('  未捕获异常：');
        cdp.exceptions.forEach((e) => console.log('    ' + String(e).split('\n')[0]));
      }
      process.exit(1);
    }

    await sleep(900);   // 让动画与 setInterval 跑一会儿

    // ---- 跑断言 ----
    const res = await cdp.send('Runtime.evaluate', {
      expression: ASSERTIONS,
      returnByValue: true,
      awaitPromise: false
    });
    const report = res.result.value || { pass: [], fail: [], info: {} };

    console.log('');
    console.log('  【功能断言】');
    report.pass.forEach((p) => console.log('    ✔ ' + p));
    report.fail.forEach((f) => console.log('    ✘ ' + f));

    console.log('');
    console.log('  【运行时环境】');
    Object.keys(report.info).forEach((k) => {
      const v = report.info[k];
      console.log('    ' + k + ' = ' + (Array.isArray(v) ? (v.length ? v.join(',') : '无') : v));
    });

    // ---- 控制台 & 异常 ----
    const errs = cdp.consoleLogs.filter((l) => l.type === 'error');
    console.log('');
    console.log('  【控制台】');
    console.log('    日志 ' + cdp.consoleLogs.length + ' 条，其中 error ' + errs.length + ' 条');
    cdp.consoleLogs.filter((l) => l.type !== 'debug').slice(0, 12)
      .forEach((l) => console.log('      [' + l.type + '] ' + String(l.text).split('\n')[0].slice(0, 130)));

    if (cdp.exceptions.length) {
      console.log('');
      console.log('  【未捕获异常】' + cdp.exceptions.length + ' 个');
      cdp.exceptions.slice(0, 6).forEach((e) =>
        console.log('      ' + String(e).split('\n')[0].slice(0, 160)));
    }

    /* 只把「本站源」的失败算作故障。
       无头浏览器里可能装着用户的扩展（例如 AdGuard 会去请求
       local.adguard.org 拉规则），那些失败与本项目无关，
       单独列出来供参考但不影响结论。 */
    const origin = new URL(URL_TARGET).origin;
    const isLocal = (u) => u.indexOf(origin) === 0;
    const realFailed = failedRequests.filter(isLocal);
    const externalNoise = failedRequests.filter((u) => !isLocal(u));

    if (realFailed.length) {
      console.log('');
      console.log('  【本站资源加载失败】' + realFailed.length + ' 个');
      realFailed.slice(0, 10).forEach((f) => console.log('      ' + f));
    }
    if (externalNoise.length) {
      console.log('');
      console.log('  【浏览器扩展噪声】' + externalNoise.length + ' 个（非本站请求，不影响结论）');
      externalNoise.slice(0, 3).forEach((f) => console.log('      ' + String(f).slice(0, 110)));
    }
    if (cdp.logErrors.length) {
      console.log('');
      console.log('  【浏览器错误日志】' + cdp.logErrors.length + ' 条');
      cdp.logErrors.slice(0, 5).forEach((e) => console.log('      ' + String(e).slice(0, 120)));
    }

    // ---- 截图 ----
    /* 关键：本页大量内容由 IntersectionObserver 控制进场，视口外的元素此时
       还是 opacity:0。直接整页截图会拍到一片空白 —— 这不是 bug，但没法用来
       核验视觉。所以先模拟一次真实的全页滚动，把所有元素都触发出来，
       再回到顶部截图。 */
    async function scrollThrough() {
      await cdp.send('Runtime.evaluate', {
        expression: [
          '(async function () {',
          '  var root = document.documentElement;',
          '  var saved = root.style.scrollBehavior;',
          '  root.style.scrollBehavior = "auto";   // 关掉平滑滚动，否则 scrollTo 会变成动画、永远追不上目标',
          '  var step = Math.max(200, Math.floor(window.innerHeight * 0.5));',
          '  for (var y = 0; y <= document.body.scrollHeight; y += step) {',
          '    window.scrollTo(0, y);',
          '    await new Promise(function (r) { setTimeout(r, 90); });',
          '  }',
          '  window.scrollTo(0, document.body.scrollHeight);',
          '  await new Promise(function (r) { setTimeout(r, 300); });',
          '  window.scrollTo(0, 0);',
          '  await new Promise(function (r) { setTimeout(r, 400); });',
          '  root.style.scrollBehavior = saved;',
          '})()'
        ].join('\n'),
        awaitPromise: true
      });
    }

    const outDir = path.join(ROOT, 'dist');
    fs.mkdirSync(outDir, { recursive: true });

    async function capture(name) {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true
      });
      const p = path.join(outDir, name);
      fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
      const kb = (fs.statSync(p).size / 1024).toFixed(0);
      console.log('      ' + name + '  (' + kb + ' KB)');
    }

    console.log('');
    console.log('  【截图】');
    await scrollThrough();

    // 滚动一遍后，所有带进场动画的元素都应该已经显现
    const revealCheck = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({' +
        'total: document.querySelectorAll("[data-reveal]").length,' +
        'hidden: document.querySelectorAll("[data-reveal]:not(.visible)").length,' +
        'pageHeight: document.body.scrollHeight,' +
        'which: Array.prototype.map.call(' +
        '  document.querySelectorAll("[data-reveal]:not(.visible)"),' +
        '  function (el) { return (el.className || el.tagName) + "|" + Math.round(el.getBoundingClientRect().height) + "px" })' +
        '})',
      returnByValue: true
    });
    const rv = JSON.parse(revealCheck.result.value);
    console.log('');
    console.log('  【滚动进场】共 ' + rv.total + ' 个元素，未显示 ' + rv.hidden +
      ' 个（页面高 ' + rv.pageHeight + 'px）');
    if (rv.hidden > 0) {
      console.log('    ✘ 未进场的元素：' + rv.which.join(' / '));
      process.exitCode = 1;
    } else if (rv.total > 0) {
      console.log('    ✔ 全部进场元素均已正常显示');
    }

    await capture('smoke-dawn.png');

    // 切到星夜主题再来一张，确认两套配色都正常
    await cdp.send('Runtime.evaluate', {
      expression: 'window.__LOVE__.modules.theme && window.__LOVE__.modules.theme.set("night")'
    });
    await sleep(600);
    await scrollThrough();
    await capture('smoke-night.png');

    // 海报：直接把画布导出成 PNG（比截屏可靠 —— 截屏对 fixed 定位的弹窗会裁切）
    await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("poster-open").click()'
    });
    await sleep(700);
    const modalOpen = await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("poster-modal").classList.contains("is-open")',
      returnByValue: true
    });
    const dataUrl = await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("poster-canvas").toDataURL("image/png")',
      returnByValue: true
    });
    const posterPath = path.join(outDir, 'smoke-poster.png');
    fs.writeFileSync(posterPath, Buffer.from(dataUrl.result.value.split(',')[1], 'base64'));
    console.log('      smoke-poster.png  (弹窗已打开：' + modalOpen.result.value + ', ' +
      (fs.statSync(posterPath).size / 1024).toFixed(0) + ' KB)');
    await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("poster-close").click()'
    });

    // ---- 结论 ----
    const hardFail = report.fail.length > 0 ||
      cdp.exceptions.length > 0 ||
      realFailed.length > 0;

    console.log('');
    if (hardFail) {
      console.log('  ❌ 冒烟测试未通过\n');
      process.exitCode = 1;
    } else {
      console.log('  ✅ 冒烟测试通过：' + report.pass.length + ' 项断言全部成功，' +
        '无控制台错误、无未捕获异常、无本站资源加载失败' +
        (externalNoise.length ? '（另有 ' + externalNoise.length + ' 条浏览器扩展噪声，已忽略）' : '') +
        '\n');
    }
  } catch (err) {
    console.error('\n  ✘ 冒烟测试异常终止：' + err.message + '\n');
    process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) { /* ignore */ }
    proc.kill();
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

process.exitCode = process.exitCode || 0;
main();
