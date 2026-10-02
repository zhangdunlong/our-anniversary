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

/**
 * 用 API 把密码改回去，并处理服务端的防抖冷却（429 + Retry-After）。
 *
 * 为什么不继续在界面上点：界面测试要断言的是「入口 / 校验 / 提示 / 强制登出」，
 * 而「还原环境」只是善后。善后放在 CLI 侧可以精确读 Retry-After、按需等待、
 * 失败时拿到明确错误码 —— 比在浏览器里反复点可靠得多。
 */
async function restorePasswordViaApi(token, oldPw, newPw) {
  if (!token) return { ok: false, detail: '未取到 token' };

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(BASE + '/api/admin/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw })
    });
    if (res.status === 200) return { ok: true, detail: '' };

    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    const code = (body && body.error && body.error.code) || '';

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 16;
      console.log('    ⏳ 还原时命中 ' + code + '，等待 ' + wait + ' 秒…');
      await sleep((wait + 1) * 1000);
      continue;
    }
    return { ok: false, detail: 'HTTP ' + res.status + (code ? ' ' + code : '') };
  }
  return { ok: false, detail: '重试 5 次仍失败' };
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

    /* --- 清理本套用例产生的数据，避免污染真实 KV --- */
    // 从 Node 侧顺序删除：后台的 DELETE 是「读-改-写」，
    // 并发删除会互相覆盖（丢更新），所以必须一条一条来。
    const adminToken = await cdp.eval('return localStorage.getItem("love-admin-token") || "";');
    const JUNK_PREFIX = ['联动测试-', 'UI测试-', '冒烟测试-', '冒烟-MMDD-'];
    const isJunk = (x) => JUNK_PREFIX.some((p) => String(x.name || '').indexOf(p) === 0);

    async function fetchAdmin() {
      const r = await fetch(BASE + '/api/admin/anniversaries', {
        headers: { authorization: 'Bearer ' + adminToken }
      });
      return r.json();
    }

    let cleanedCount = 0;
    if (adminToken) {
      for (let pass = 0; pass < 4; pass++) {
        const snap = await fetchAdmin();
        const junk = (snap.data || []).filter(isJunk);
        if (!junk.length) break;
        for (const it of junk) {
          await fetch(BASE + '/api/admin/anniversaries/' + encodeURIComponent(it.id), {
            method: 'DELETE', headers: { authorization: 'Bearer ' + adminToken }
          });
          cleanedCount++;
        }
      }
    }

    check('测试数据已自动清理（不在 KV 里留残留）', cleanedCount >= 1,
      adminToken ? '清理了 ' + cleanedCount + ' 条' : '未取到 token');

    const finalSnap = adminToken ? await fetchAdmin() : { data: [] };
    const leftover = (finalSnap.data || []).filter(isJunk);
    check('清理后 KV 中确无测试残留', leftover.length === 0,
      '仍残留 ' + leftover.length + ' 条：' + leftover.map((x) => x.name).join(', '));

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

    /* ================= I. 修改密码 ================= */
    console.log('\n  【I】修改密码界面');

    // 前面的用例可能已经把会话换成别的状态，这里重新登录一次拿干净的起点
    await cdp.eval('try{localStorage.removeItem("love-admin-token");}catch(e){}');
    await cdp.send('Page.navigate', { url: BASE + '/admin/' });
    await sleep(1800);
    await cdp.eval(
      'document.getElementById("login-password").value = ' + JSON.stringify(PASSWORD) + ';' +
      'document.getElementById("login-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(2400);

    const entryVisible = await cdp.eval(
      'var b=document.getElementById("pwd-btn");' +
      'return !!b && getComputedStyle(b).display !== "none" && b.getBoundingClientRect().width > 0;'
    );
    check('后台顶部有可点击的「修改密码」入口', entryVisible === true);

    await cdp.eval('document.getElementById("pwd-btn").click();');
    await sleep(600);
    const pwdModalOpen = await cdp.eval('return document.getElementById("pwd-modal").hidden === false;');
    check('点击入口后弹出改密码对话框', pwdModalOpen === true);

    const threeMasked = await cdp.eval(
      'var ids=["pwd-old","pwd-new","pwd-confirm"];' +
      'return ids.every(function(id){var e=document.getElementById(id);return !!e && e.type==="password";});'
    );
    check('三个密码框默认都是掩码', threeMasked === true);

    /* --- 显示 / 隐藏切换 --- */
    await cdp.eval('document.querySelectorAll(".pw-toggle")[0].click();');
    await sleep(250);
    const revealed = await cdp.eval('return document.getElementById("pwd-old").type === "text";');
    check('点击 👁 后密码变为明文', revealed === true);

    await cdp.eval('document.querySelectorAll(".pw-toggle")[0].click();');
    await sleep(250);
    const remasked = await cdp.eval('return document.getElementById("pwd-old").type === "password";');
    check('再次点击恢复掩码', remasked === true);

    /* --- 强度指示条 --- */
    await cdp.eval(
      'var i=document.getElementById("pwd-new");i.value="abc";' +
      'i.dispatchEvent(new Event("input",{bubbles:true}));'
    );
    await sleep(250);
    const weakLevel = await cdp.eval('return document.getElementById("pwd-meter").getAttribute("data-level");');
    const weakText = await cdp.eval('return document.getElementById("pwd-strength").textContent;');
    check('弱密码 → 强度条 1 格', weakLevel === '1', 'level=' + weakLevel);
    check('弱密码 → 文案提示强度弱', weakText.indexOf('弱') > -1, '"' + weakText + '"');

    await cdp.eval(
      'var i=document.getElementById("pwd-new");i.value="Str0ng-Pass!";' +
      'i.dispatchEvent(new Event("input",{bubbles:true}));'
    );
    await sleep(250);
    const strongLevel = await cdp.eval('return document.getElementById("pwd-meter").getAttribute("data-level");');
    check('强密码 → 强度条 4 格', strongLevel === '4', 'level=' + strongLevel);

    await cdp.screenshot(path.join(SHOT_DIR, 'admin-pwd-modal.png'));
    console.log('      → 截图 admin-pwd-modal.png');

    /* --- 校验：两次输入不一致 --- */
    await cdp.eval(
      'document.getElementById("pwd-old").value = ' + JSON.stringify(PASSWORD) + ';' +
      'document.getElementById("pwd-new").value = "Str0ng-Pass!";' +
      'document.getElementById("pwd-confirm").value = "Str0ng-Pass?!";' +
      'document.getElementById("pwd-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(600);
    const mismatchErr = await cdp.eval('return document.getElementById("err-pwd-confirm").textContent;');
    check('两次新密码不一致 → 提示不一致', mismatchErr.indexOf('不一致') > -1, '"' + mismatchErr + '"');

    /* --- 校验：新密码太弱 --- */
    await cdp.eval(
      'document.getElementById("pwd-old").value = ' + JSON.stringify(PASSWORD) + ';' +
      'document.getElementById("pwd-new").value = "abcdefgh";' +
      'document.getElementById("pwd-confirm").value = "abcdefgh";' +
      'document.getElementById("pwd-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(600);
    const weakErr = await cdp.eval('return document.getElementById("err-pwd-new").textContent;');
    check('单一字符类别的新密码被拦下', weakErr.length > 0, '"' + weakErr + '"');

    /* --- 原密码错误 --- */
    await cdp.eval(
      'document.getElementById("pwd-old").value = "definitely-wrong-old-pw";' +
      'document.getElementById("pwd-new").value = "Str0ng-Pass!";' +
      'document.getElementById("pwd-confirm").value = "Str0ng-Pass!";' +
      'document.getElementById("pwd-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(2600);
    const oldErr = await cdp.eval('return document.getElementById("err-pwd-old").textContent;');
    check('原密码错误 → 该字段下方显示提示', oldErr.length > 0, '"' + oldErr + '"');
    const stillOpen = await cdp.eval('return document.getElementById("pwd-modal").hidden === false;');
    check('原密码错误时对话框保持打开', stillOpen === true);

    /* --- 成功修改（并验证强制登出）--- */
    const UI_NEW_PW = 'UiTest' + Date.now() + '!aZ';

    /**
     * 在界面上提交改密码表单。
     * 改密成功后前端会强制登出 → 回到登录页，这就是「成功」的判据。
     * 提示条 3.2 秒后会自动消失，所以这里边等边轮询，避免因慢网络而漏判。
     */
    async function submitPwdForm(oldPw, newPw) {
      await cdp.eval('document.getElementById("pwd-btn").click();');
      await sleep(500);
      const modalUp = await cdp.eval('return document.getElementById("pwd-modal").hidden === false;');
      if (!modalUp) return { changed: false, sawToast: false, msg: '对话框未打开' };

      await cdp.eval(
        'document.getElementById("pwd-old").value = ' + JSON.stringify(oldPw) + ';' +
        'document.getElementById("pwd-new").value = ' + JSON.stringify(newPw) + ';' +
        'document.getElementById("pwd-confirm").value = ' + JSON.stringify(newPw) + ';' +
        'document.getElementById("pwd-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
      );

      let changed = false;
      let sawToast = false;
      let lastMsg = '';

      for (let i = 0; i < 35; i++) {
        await sleep(200);
        const st = await cdp.eval(
          'var ts=document.querySelectorAll("#toast-host .toast");' +
          'return {' +
          '  loggedOut: document.getElementById("view-login").hidden === false,' +
          '  toast: Array.prototype.some.call(ts,function(x){return x.textContent.indexOf("密码")>-1;}),' +
          '  msg: ts.length ? ts[ts.length-1].textContent : ""' +
          '};'
        );
        if (!st) continue;
        if (st.toast) sawToast = true;
        if (st.msg) lastMsg = st.msg;
        if (st.loggedOut) { changed = true; break; }
      }
      return { changed: changed, sawToast: sawToast, msg: lastMsg };
    }

    let result = await submitPwdForm(PASSWORD, UI_NEW_PW);

    // 可能撞上服务端的 15 秒防抖冷却（上一个测试脚本刚改过密码）→ 等一等再来
    for (let retry = 0; retry < 2 && !result.changed; retry++) {
      console.log('    ⏳ 首次未生效（' + (result.msg || '无提示') + '），等待 18 秒后重试…');
      await sleep(18000);
      await cdp.eval('try{document.getElementById("pwd-cancel").click();}catch(e){}');
      await sleep(400);
      result = await submitPwdForm(PASSWORD, UI_NEW_PW);
    }

    check('原密码正确 → 改密成功并自动回到登录页', result.changed === true, result.msg);
    check('显示改密成功提示条', result.sawToast === true, result.msg);

    const tokenCleared = await cdp.eval('return !localStorage.getItem("love-admin-token");');
    check('改密后本地登录态已清除', tokenCleared === true);

    /* --- 新密码可登录 --- */
    await cdp.eval(
      'document.getElementById("login-password").value = ' + JSON.stringify(UI_NEW_PW) + ';' +
      'document.getElementById("login-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));'
    );
    await sleep(2800);
    const loginWithNew = await cdp.eval('return document.getElementById("view-admin").hidden === false;');
    check('可以用新密码登录', loginWithNew === true);

    /* --- 还原环境：用生效中的 token 走 API 改回原密码 --- */
    const restoreToken = await cdp.eval('return localStorage.getItem("love-admin-token") || "";');
    const restore = await restorePasswordViaApi(restoreToken, UI_NEW_PW, PASSWORD);
    check('已把密码改回原值（环境还原）', restore.ok === true, restore.detail);

    const relogin = await fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD })
    });
    check('原密码恢复可用', relogin.status === 200, 'HTTP ' + relogin.status);

    const staleLogin = await fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: UI_NEW_PW })
    });
    check('临时新密码已失效', staleLogin.status === 401, 'HTTP ' + staleLogin.status);

    /* ================= J. 控制台干净 ================= */
    console.log('\n  【J】运行环境');

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
