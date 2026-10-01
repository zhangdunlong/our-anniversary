#!/usr/bin/env node
/**
 * check.mjs —— 静态自检（部署前必跑）
 *
 * 覆盖三类最容易在重构中悄悄出现的错误：
 *   ① JS 里引用了 HTML 中不存在的元素 id（拼写错误 → 功能静默失效）
 *   ② import 路径写错 / 模块文件缺失（运行时 404）
 *   ③ 模块语法错误（由 node --check 兜底）
 *
 * 用法：node scripts/check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let errors = 0;
let warnings = 0;

function fail(msg) { console.log('  ✘ ' + msg); errors++; }
function warn(msg) { console.log('  ⚠ ' + msg); warnings++; }
function ok(msg) { console.log('  ✔ ' + msg); }

/* ---------------------------------------------------------------- 收集文件 */
function walk(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 剥离注释与字符串字面量。
 * 用途：符号检查必须只看「真实代码」——否则注释里提到的函数名
 * （例如配置文件的说明文字里写了 parseLocal()）会造成误报。
 */
function stripCommentsAndStrings(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')           // 块注释
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')      // 行注释（避开 http:// 里的 //）
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")       // 单引号字符串
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')       // 双引号字符串
    .replace(/`(?:\\.|[^`\\])*`/g, '``');        // 模板字符串
}

/** 把符号名转义成安全的正则片段（$ 等字符不能直接塞进 RegExp） */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const jsFiles = walk(SRC);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

console.log('\n  【1/5】HTML 中的 id 与 JS 引用的一致性');

/* ---------------------------------------------------------------- ① id 对齐 */
const htmlIds = new Set();
const idRe = /\sid="([^"]+)"/g;
let m;
while ((m = idRe.exec(html))) htmlIds.add(m[1]);

const referenced = new Map();   // id -> 引用它的文件们
for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  // 只认「DOM 查询函数里传的 #id」，避免把 '#ff6b6b' 这类颜色值误判成 id
  const re = /(?:\$|\$\$|setText|getElementById|querySelector|querySelectorAll)\s*\(\s*['"]#?([A-Za-z][\w-]*)['"]/g;
  let mm;
  while ((mm = re.exec(code))) {
    const id = mm[1];
    if (!referenced.has(id)) referenced.set(id, new Set());
    referenced.get(id).add(path.relative(ROOT, file).split(path.sep).join('/'));
  }
}

// 这些是运行时动态生成的元素，不来自 index.html
const DYNAMIC_ALLOWLIST = new Set();
for (const [id, files] of referenced) {
  if (htmlIds.has(id)) continue;
  if (DYNAMIC_ALLOWLIST.has(id)) continue;
  fail('JS 引用了 HTML 中不存在的 id #' + id + '   ← ' + Array.from(files).join(', '));
}
if (errors === 0) ok('全部 ' + referenced.size + ' 个 id 引用均能在 index.html 中找到');

/* ---------------------------------------------------------------- 未被使用的 id */
const unused = [];
for (const id of htmlIds) {
  if (!referenced.has(id)) unused.push(id);
}
if (unused.length) warn('HTML 中定义但 JS 未引用（可能是纯样式锚点）：' + unused.join(', '));
else ok('HTML 中的 id 无冗余');

/* ---------------------------------------------------------------- ② import 解析 */
console.log('\n  【2/5】import 路径可解析性');
let importCount = 0;
for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let mm;
  while ((mm = re.exec(code))) {
    importCount++;
    const target = path.resolve(path.dirname(file), mm[1]);
    if (!fs.existsSync(target)) {
      fail(path.relative(ROOT, file) + ' → ' + mm[1] + '（文件不存在）');
    }
  }
}
if (errors === 0) ok('全部 ' + importCount + ' 条 import 路径均有效');

/* ---------------------------------------------------------------- ③ 语法检查 */
console.log('\n  【3/5】模块语法检查');
/* 说明：不用 `node --check` 起子进程 —— 在 Windows 上会被占用锁影响（EBUSY），
   而且 check 会把 ESM 当脚本解析、对 import/export 报错。
   这里复用与打包器相同的改写规则，把模块降级成函数体后用 new Function 编译，
   既能真正验证语法，又顺带验证了「模块是否符合打包器约束」。 */
function stripModuleSyntax(code) {
  return code
    .replace(/^[ \t]*import\s[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\};?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ');
}

let checked = 0;
for (const file of jsFiles.concat([path.join(ROOT, 'sw.js')])) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const code = fs.readFileSync(file, 'utf8');
  try {
    // eslint-disable-next-line no-new-func
    new Function(stripModuleSyntax(code));
    checked++;
  } catch (err) {
    fail('语法错误：' + rel + '\n      ' + err.message);
  }
}
if (errors === 0) ok(checked + ' 个脚本语法全部通过');

/* ---------------------------------------------------------------- ④ 资源配置 */
console.log('\n  【4/5】配置与静态资源');
const configPath = path.join(SRC, 'config', 'site.config.js');
const config = fs.readFileSync(configPath, 'utf8');

if (/togetherAt:\s*'([^']+)'/.test(config)) {
  const value = RegExp.$1;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) ok('在一起时间格式正确：' + value);
  else fail('togetherAt 格式应为 YYYY-MM-DDTHH:mm:ss，当前为：' + value);
} else {
  fail('配置中找不到 togetherAt');
}

const required = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'robots.txt',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png'
];
const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) missing.forEach((f) => fail('缺少运行时文件：' + f));
else ok('运行时静态资源齐全');

// 音频是可选的（开源示例版不含音频，music.js 会自动隐藏播放按钮）
const audioPath = ['assets/audio/renxi.mp3', 'assets/audio/bgm.mp3']
  .map((f) => path.join(ROOT, f))
  .find((f) => fs.existsSync(f));
if (audioPath) ok('背景音乐文件存在：' + path.basename(audioPath));
else warn('未找到背景音乐文件，页面会自动隐藏播放按钮（不影响其它功能）');

// index.html 里引用的 CSS / 图标等外链必须真实存在
const linkRe = /(?:href|src)="((?!data:|https?:|#)[^"]+)"/g;
let lm;
let linkCount = 0;
while ((lm = linkRe.exec(html))) {
  const target = path.join(ROOT, lm[1]);
  linkCount++;
  if (!fs.existsSync(target)) fail('index.html 引用了不存在的文件：' + lm[1]);
}
if (errors === 0) ok('index.html 中 ' + linkCount + ' 个本地外链均可解析');

/* ---------------------------------------------------------------- ⑤ 符号绑定 */
console.log('\n  【5/5】跨模块符号绑定（漏 import 检查）');
/* 背景：ESM 里忘了 import 就直接调用某个工具函数，浏览器只会在运行时抛
   ReferenceError，而 safe() 会把它吞成一条 warning，页面看起来「只是少了
   一个模块」。这个检查专门堵这类漏洞：以「本文件调用了某个 core 层导出、
   但既没 import 也没本地定义」为判定条件。 */
const CORE_DIRS = ['core', 'modules'];
const exportedBy = new Map();     // 文件名 → 导出名集合
const coreExports = new Map();    // 导出名 → 提供它的文件

for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  const names = new Set();
  const re = /^[ \t]*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let mm;
  while ((mm = re.exec(code))) names.add(mm[1]);
  exportedBy.set(file, names);

  const dir = path.basename(path.dirname(file));
  if (CORE_DIRS.indexOf(dir) > -1) {
    names.forEach((n) => {
      if (!coreExports.has(n)) coreExports.set(n, []);
      coreExports.get(n).push(path.relative(ROOT, file).split(path.sep).join('/'));
    });
  }
}

// 这些名字太泛，被别的模块当作局部变量/参数用是正常现象，跳过以免误报
const TOO_COMMON = new Set([
  'get', 'set', 'add', 'count', 'clear', 'once', 'create', 'safe',
  'remove', 'disconnect', 'isPersistent', 'clearAll'
]);

let bindErrors = 0;
for (const file of jsFiles) {
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripCommentsAndStrings(raw);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');

  // 本文件能看到的名字 = 本文件导出 + import 进来的 + 本地声明的
  const visible = new Set(exportedBy.get(file) || []);

  const ire = /^[ \t]*import\s*\{([^}]+)\}\s*from[ \t]*['"][^'"]+['"]/gm;
  let mm;
  while ((mm = ire.exec(raw))) {
    mm[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => {
      const as = n.split(/\s+as\s+/);
      visible.add(as.length === 2 ? as[1] : n);
    });
  }

  const nre = /^[ \t]*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/gm;
  while ((mm = nre.exec(raw))) visible.add(mm[1]);

  const lre = /(?:^|[^\w.$])(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((mm = lre.exec(code))) visible.add(mm[1]);

  // 形参、箭头函数参数也视为可见
  const pre = /\(([^)]*)\)\s*(?:=>|\{)/g;
  while ((mm = pre.exec(code))) {
    mm[1].split(',').forEach((p) => {
      const name = p.trim().replace(/^\.\.\./, '').split(/[\s=:]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) visible.add(name);
    });
  }

  for (const [name, providers] of coreExports) {
    if (TOO_COMMON.has(name) || visible.has(name)) continue;
    // 只关心「被当函数调用」的用法
    const callRe = new RegExp('(?:^|[^\\w.$])' + escapeRe(name) + '\\s*\\(', 'm');
    if (!callRe.test(code)) continue;
    fail(rel + ' 调用了 ' + name + '()，但既没有 import 也没有本地定义' +
      '   ← 应来自 ' + providers.join(' / '));
    bindErrors++;
  }
}
if (bindErrors === 0) ok('全部模块的跨模块调用都能找到对应 import');

/* ---------------------------------------------------------------- 汇总 */
console.log('');
if (errors === 0) {
  console.log('  ✅ 自检通过（' + warnings + ' 条提示）\n');
  process.exit(0);
} else {
  console.log('  ❌ 自检失败：' + errors + ' 个错误，' + warnings + ' 条提示\n');
  process.exit(1);
}
