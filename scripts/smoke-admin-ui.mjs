#!/usr/bin/env node
/**
 * ============================================================================
 *  smoke-admin-ui.mjs —— 后台界面的真实浏览器验证（CDP，零依赖）
 * ============================================================================
 *
 *  smoke-admin.mjs 验证的是 API 契约；本脚本验证的是「人在浏览器里点得动」：
 *    · 登录页渲染正常、未登录时看不到管理界面
 *    · 输错密码有提示、输对密码进入管理界面
 *    · 新增 → 列表出现 → 编辑 → 删除（含二次确认弹窗）
 *    · 顶部倒计时条读取到后台数据（前后端联动）
 *    · 手机尺寸下布局不溢出（响应式）
 *
 *  用法：node scripts/smoke-admin-ui.mjs [url] [password]
 * ============================================================================
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const PASSWORD = process.argv[3] || process.env.LOVE_ADMIN_PASSWORD || '';
const PORT = 9600 + Math.floor(Math.random() * 200);
const SHOT_DIR = path.join(ROOT, 'dist');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { passed++; console.log('    ✔ ' + label); }
  else { failed++; failures.push(label + (detail ? ' — ' + detail : '')); console.log('    ✘ ' + label + (detail ? '  → ' + detail : '')); }
}

/* ---------------------------------------------------------------- CDP */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
      }, 30000);
    });
  }

  /** 在页面上下文求值，返回 JS 值 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){' + expression + '})()',
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面求值异常：' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    }
    return r.result ? r.result.value : undefined;
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
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

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  const browser = findBrowser();
  if (!browser) { console.error('  ✘ 未找到 Chrome / Edge'); process.exit(1); }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-admin-ui-'));
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--window-size=1280,1000',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDataDir, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
        const list = await res.json();
        const page = list.find((t) => t.type === 'page');
        if (page) { target = page; break; }
      } catch (e) { /* 继续等 */ }
    }
    if (!target) throw new Error('调试端口未就绪');

    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    console.log('');
    console.log('  ❤  后台界面浏览器验证');
    console.log('  ─────────────────────────────────────────────');
    console.log('  目标：' + BASE + '/admin/');

    /* ================= A. 登录页 ================= */
    console.log('\n  【A】登录页渲染');

    await cdp.send('Page.navigate', { url: BASE + '/admin/' });
    await sleep(1800);

    const loginVisible = await cdp.eval('return !document.getElementById("view-login").hidden;');
    const adminHidden = await cdp.eval('return document.getElementById("view-admin").hidden;');
    check('未登录时显示登录页', loginVisible === true);
    check('未登录时管理界面隐藏', adminHidden === true);

    const titleOk = await cdp.eval('return document.querySelector(".login-title").textContent.indexOf("纪念日") > -1;');
    check('登录页标题正确', titleOk === true);

    const cssApplied = await cdp.eval(
      'var b=document.querySelector(".login-card");' +
      'var bg=getComputedStyle(b).backgroundColor;' +
      'return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";'
    );
    check('样式表已生效（卡片有背景色）', cssApplied === true);

    await cdp.screenshot(path.join(SHOT_DIR, 'admin-login.png'));
    console.log('      → 截图 admin-login.png');

    if (!PASSWORD) {
      console.log('\n    ⊘ 未提供密码，跳过登录之后的断言');
      report();
      return;
    }

    /* ================= B. 登录流程 ================= */
    console.log('\n  【B】登录流程');

    // 错误密码
    await cdp.eval(
      'document.getElementById("login-password").value = "wrong_password_xyz";' +
      'document.getElementById("login-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(1500);

    const errText = await cdp.eval('return document.getElementById("login-error").textContent;');
    check('错误密码显示提示', errText.length > 0, '"' + errText + '"');

    const stillLogin = await cdp.eval('return !document.getElementById("view-login").hidden;');
    check('错误密码后仍停留在登录页', stillLogin === true);

    // 正确密码
    await cdp.eval(
      'document.getElementById("login-password").value = ' + JSON.stringify(PASSWORD) + ';' +
      'document.getElementById("login-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(2200);

    const enteredAdmin = await cdp.eval('return document.getElementById("view-admin").hidden === false;');
    check('正确密码后进入管理界面', enteredAdmin === true);

    // 回归防护：登录页必须真正不可见。
    // 只看 hidden 属性不够 —— CSS 的 display 可能把它覆盖回去（曾经踩过这个坑）。
    const loginReallyHidden = await cdp.eval(
      'var el=document.getElementById("view-login");' +
      'return el.hidden === true && getComputedStyle(el).display === "none";'
    );
    check('登录页确实不可见（hidden 未被 CSS 覆盖）', loginReallyHidden === true,
      'display=' + (await cdp.eval('getComputedStyle(document.getElementById("view-login")).display;')));

    const adminVisible = await cdp.eval(
      'return getComputedStyle(document.getElementById("view-admin")).display !== "none";'
    );
    check('管理界面确实可见', adminVisible === true);

    const tokenSaved = await cdp.eval('return !!localStorage.getItem("love-admin-token");');
    check('登录态已保存到 localStorage', tokenSaved === true);

    /* ================= C. 新增纪念日 ================= */
    console.log('\n  【C】新增纪念日');

    const testName = 'UI测试-' + Date.now();

    await cdp.eval('document.getElementById("add-btn").click();');
    await sleep(600);
    const modalOpen = await cdp.eval('return document.getElementById("edit-modal").hidden === false;');
    check('点击新增后弹窗打开', modalOpen === true);

    // 先提交空表单，验证校验
    await cdp.eval(
      'document.getElementById("edit-name").value = "";' +
      'document.getElementById("edit-date").value = "";' +
      'document.getElementById("edit-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(500);
    const nameErr = await cdp.eval('return document.getElementById("err-name").textContent;');
    const dateErr = await cdp.eval('return document.getElementById("err-date").textContent;');
    check('空名称显示校验错误', nameErr.length > 0, '"' + nameErr + '"');
    check('空日期显示校验错误', dateErr.length > 0, '"' + dateErr + '"');

    // 非法日期
    await cdp.eval(
      'document.getElementById("edit-name").value = "非法日期测试";' +
      'document.getElementById("edit-date").value = "2023-02-29";' +
      'document.getElementById("edit-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(500);
    const badDateErr = await cdp.eval('return document.getElementById("err-date").textContent;');
    check('2023-02-29 被判定为非法日期', badDateErr.indexOf("不存在") > -1, '"' + badDateErr + '"');

    // 正确填写
    await cdp.eval(
      'document.getElementById("edit-name").value = ' + JSON.stringify(testName) + ';' +
      'document.getElementById("edit-date").value = "2031-03-08";' +
      'document.getElementById("edit-type").value = "memorial";' +
      'document.getElementById("edit-note").value = "浏览器自动化测试创建";' +
      'document.getElementById("edit-visible").checked = true;' +
      'document.getElementById("edit-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(2200);

    const modalClosed = await cdp.eval('return document.getElementById("edit-modal").hidden === true;');
    check('保存成功后弹窗关闭', modalClosed === true);

    const inList = await cdp.eval(
      'return Array.prototype.some.call(document.querySelectorAll("#list .item-name"),' +
      'function(n){return n.textContent.indexOf(' + JSON.stringify(testName) + ') > -1;});'
    );
    check('新增条目出现在列表中', inList === true);

    const toastShown = await cdp.eval(
      'return document.querySelectorAll("#toast-host .toast").length > 0;'
    );
    check('显示成功提示条', toastShown === true);

    // 截图前滚回顶部，保证拍到的是表头 + 列表（而不是残留的滚动位置）
    await cdp.eval('window.scrollTo(0,0);');
    await sleep(400);
    await cdp.screenshot(path.join(SHOT_DIR, 'admin-list.png'));
    console.log('      → 截图 admin-list.png');

    /* ================= D. 搜索 ================= */
    console.log('\n  【D】搜索与筛选');

    await cdp.eval(
      'var i=document.getElementById("search-input");' +
      'i.value=' + JSON.stringify(testName) + ';' +
      'i.dispatchEvent(new Event("input",{bubbles:true}));'
    );
    await sleep(600);

    const searchCount = await cdp.eval('return document.querySelectorAll("#list .item").length;');
    check('搜索后只显示匹配项（1 条）', searchCount === 1, '实际 ' + searchCount + ' 条');

    const searchFound = await cdp.eval(
      'return document.querySelector("#list .item-name").textContent.indexOf(' + JSON.stringify(testName) + ') > -1;'
    );
    check('搜索结果内容正确', searchFound === true);

    // 清空搜索
    await cdp.eval(
      'var i=document.getElementById("search-input");i.value="";' +
      'i.dispatchEvent(new Event("input",{bubbles:true}));'
    );
    await sleep(500);

    /* ================= E. 编辑 ================= */
    console.log('\n  【E】编辑纪念日');

    const editedName = testName + '-已编辑';

    const editClicked = await cdp.eval(
      'var name=' + JSON.stringify(testName) + ';' +
      'var rows=document.querySelectorAll("#list .item");' +
      'for(var i=0;i<rows.length;i++){' +
      '  var n=rows[i].querySelector(".item-name");' +
      '  if(n && n.textContent.indexOf(name)>-1){' +
      '    rows[i].querySelector("[data-act=edit]").click();return true;}' +
      '}' +
      'return false;'
    );
    check('找到并点击编辑按钮', editClicked === true);

    await sleep(700);
    const editModalOpen = await cdp.eval('return document.getElementById("edit-modal").hidden === false;');
    check('编辑弹窗打开', editModalOpen === true);

    const prefilled = await cdp.eval(
      'return document.getElementById("edit-name").value.indexOf(' + JSON.stringify(testName) + ') > -1;'
    );
    check('编辑弹窗预填了原有数据', prefilled === true);

    await cdp.eval(
      'document.getElementById("edit-name").value = ' + JSON.stringify(editedName) + ';' +
      'document.getElementById("edit-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(2200);

    const editApplied = await cdp.eval(
      'return Array.prototype.some.call(document.querySelectorAll("#list .item-name"),' +
      'function(n){return n.textContent.indexOf(' + JSON.stringify(editedName) + ') > -1;});'
    );
    check('编辑结果反映到列表', editApplied === true);

    /* ================= F. 删除（二次确认）================= */
    console.log('\n  【F】删除与二次确认');

    const delClicked = await cdp.eval(
      'var name=' + JSON.stringify(editedName) + ';' +
      'var rows=document.querySelectorAll("#list .item");' +
      'for(var i=0;i<rows.length;i++){' +
      '  var n=rows[i].querySelector(".item-name");' +
      '  if(n && n.textContent.indexOf(name)>-1){' +
      '    rows[i].querySelector("[data-act=delete]").click();return true;}' +
      '}' +
      'return false;'
    );
    check('找到并点击删除按钮', delClicked === true);

    await sleep(600);
    const delModalOpen = await cdp.eval('return document.getElementById("del-modal").hidden === false;');
    check('删除弹出二次确认框', delModalOpen === true);

    const delNameShown = await cdp.eval('return document.getElementById("del-name").textContent.length > 0;');
    check('确认框显示待删除条目的名称', delNameShown === true);

    // 先取消，验证不会误删
    await cdp.eval('document.getElementById("del-cancel").click();');
    await sleep(500);
    const stillThere = await cdp.eval(
      'return Array.prototype.some.call(document.querySelectorAll("#list .item-name"),' +
      'function(n){return n.textContent.indexOf(' + JSON.stringify(editedName) + ') > -1;});'
    );
    check('点击取消后条目仍在（防误删）', stillThere === true);

    // 再真正删除
    await cdp.eval(
      'var name=' + JSON.stringify(editedName) + ';' +
      'var rows=document.querySelectorAll("#list .item");' +
      'for(var i=0;i<rows.length;i++){' +
      '  var n=rows[i].querySelector(".item-name");' +
      '  if(n && n.textContent.indexOf(name)>-1){' +
      '    rows[i].querySelector("[data-act=delete]").click();break;}' +
      '}'
    );
    await sleep(500);
    await cdp.eval('document.getElementById("del-confirm").click();');
    await sleep(2200);

    const goneNow = await cdp.eval(
      'return !Array.prototype.some.call(document.querySelectorAll("#list .item-name"),' +
      'function(n){return n.textContent.indexOf(' + JSON.stringify(editedName) + ') > -1;});'
    );
    check('确认后条目从列表消失', goneNow === true);

    /* ================= G. 前后端联动 ================= */
    console.log('\n  【G】前台读取后台数据');

    // 通过后台新增一条可见的「今天」纪念日，再到前台看顶部条
    const marchName = '联动测试-' + Date.now();
    await cdp.eval(
      'document.getElementById("add-btn").click();'
    );
    await sleep(500);
    await cdp.eval(
      'document.getElementById("edit-name").value = ' + JSON.stringify(marchName) + ';' +
      'document.getElementById("edit-date").value = "01-15";' +
      'document.getElementById("edit-type").value = "other";' +
      'document.getElementById("edit-visible").checked = true;' +
      'document.getElementById("edit-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(2200);

    // 打开前台首页，检查顶部倒计时条存在且非空
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(3200);

    const topText = await cdp.eval(
      'var b=document.getElementById("top-countdown");' +
      'return b && !b.hidden ? b.textContent.trim() : "";'
    );
    check('前台顶部倒计时条已渲染', topText.length > 0, '"' + topText + '"');

    const hasDays = /\d+/.test(topText);
    check('顶部条包含天数数字', hasDays === true, topText);

    await cdp.screenshot(path.join(SHOT_DIR, 'admin-front-topcountdown.png'));
    console.log('      → 截图 admin-front-topcountdown.png');

    /* ================= H. 响应式 ================= */
    console.log('\n  【H】移动端响应式');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });

    await cdp.send('Page.navigate', { url: BASE + '/admin/' });
    await sleep(2600);

    const noOverflow = await cdp.eval(
      'return document.documentElement.scrollWidth <= window.innerWidth + 2;'
    );
    check('手机尺寸下无横向溢出', noOverflow === true,
      'scrollWidth=' + (await cdp.eval('return document.documentElement.scrollWidth;')) +
      ' innerWidth=' + (await cdp.eval('return window.innerWidth;')));

    const loginCardFits = await cdp.eval(
      'var c=document.querySelector(".login-card");var r=c.getBoundingClientRect();' +
      'return r.width <= window.innerWidth && r.left >= -1;'
    );
    check('手机尺寸下登录卡片完整可见', loginCardFits === true);

    await cdp.screenshot(path.join(SHOT_DIR, 'admin-mobile.png'));
    console.log('      → 截图 admin-mobile.png');

    await cdp.send('Emulation.clearDeviceMetricsOverride');

    /* ================= I. 控制台干净 ================= */
    console.log('\n  【I】运行环境');

    check('无未捕获异常', cdp.exceptions.length === 0,
      cdp.exceptions.slice(0, 2).join(' | '));
    check('无控制台 error', cdp.consoleErrors.length === 0,
      cdp.consoleErrors.slice(0, 2).join(' | '));

    report();
  } catch (err) {
    console.error('\n  ❌ 执行异常：', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    if (cdp && cdp.ws) { try { cdp.ws.close(); } catch (e) { /* ignore */ } }
    try { proc.kill(); } catch (e) { /* ignore */ }
  }
}

function report() {
  console.log('');
  console.log('  ─────────────────────────────────────────────');
  if (failed === 0) console.log('  ✅ 全部通过：' + passed + ' 项断言');
  else {
    console.log('  ❌ 失败 ' + failed + ' 项 / 共 ' + (passed + failed) + ' 项');
    failures.forEach((f) => console.log('     · ' + f));
  }
  console.log('');
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
