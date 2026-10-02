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
/* 需要做语法检查的文件：src 下全部模块 + sw.js + 后台脚本 + 后端 Worker。
   `_worker.js` 用了 `export default { ... }`，stripModuleSyntax 只处理
   具名 export，所以额外把 `export default` 也剥掉。 */
const syntaxTargets = jsFiles.concat([
  path.join(ROOT, 'sw.js'),
  path.join(ROOT, 'public', 'admin', 'admin.js'),
  path.join(ROOT, 'public', '_worker.js')
].filter((f) => fs.existsSync(f)));

for (const file of syntaxTargets) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const code = fs.readFileSync(file, 'utf8');
  const stripped = stripModuleSyntax(code).replace(/^[ \t]*export\s+default\s+/gm, 'var __default__ = ');
  try {
    // eslint-disable-next-line no-new-func
    new Function(stripped);
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
  const rel = lm[1];
  linkCount++;
  // 目录链接（以 / 结尾）在构建时会由 public/ 摊平到部署根，
  // 源码阶段该目录可能不在仓库根下，因此按「根目录 或 public/ 目录」两处找。
  const candidates = [path.join(ROOT, rel), path.join(ROOT, 'public', rel)];
  const found = candidates.some((p) => fs.existsSync(p));
  if (!found) fail('index.html 引用了不存在的文件：' + rel);
}
if (errors === 0) ok('index.html 中 ' + linkCount + ' 个本地外链均可解析');

// 后台与后端的关键文件必须存在，否则部署后是「装好的门没有锁」
const adminRequired = [
  'public/_worker.js',
  'public/admin/index.html',
  'public/admin/admin.css',
  'public/admin/admin.js'
];
const adminMissing = adminRequired.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (adminMissing.length) adminMissing.forEach((f) => fail('缺少后台/后端文件：' + f));
else ok('后台与后端文件齐全（_worker.js + admin 三件套）');

// 后台页面引用的本地资源也要存在。
// 注意解析基准：部署时 public/ 的内容被摊平到站点根目录，
// 所以 admin/index.html 里的 ../src/styles/tokens.css 实际指向 <站点根>/src/styles/tokens.css，
// 也就是源码里的 <ROOT>/src/styles/tokens.css —— 不能按 public/admin/ 去解析。
const adminHtmlPath = path.join(ROOT, 'public', 'admin', 'index.html');
if (fs.existsSync(adminHtmlPath)) {
  const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
  const adminLinkRe = /(?:href|src)="((?!data:|https?:|#)[^"]+)"/g;
  let am;
  let adminLinkCount = 0;
  let adminLinkBad = 0;

  // 模拟部署布局：public/admin/ → 站点根/admin/，public/* → 站点根/*
  // 因此「相对于 public/ 的路径」就是「相对于站点根的路径」，
  // 需要映射回源码位置：站点根下的 admin/* 来自 public/admin/*，
  // 其余（src/、assets/…）来自仓库根目录。
  const SITE_ROOT = path.join(ROOT, 'public');

  while ((am = adminLinkRe.exec(adminHtml))) {
    const rel = am[1];
    adminLinkCount++;

    const resolved = path.resolve(SITE_ROOT, 'admin', rel);   // 站点根下的绝对布局
    const relToSite = path.relative(SITE_ROOT, resolved);      // 站点根下的相对路径

    let target;
    if (relToSite === 'admin' || relToSite.startsWith('admin' + path.sep)) {
      target = resolved;                                       // 后台自身资源
    } else if (relToSite === '_worker.js') {
      target = resolved;
    } else {
      target = path.join(ROOT, relToSite);                     // 前台共享资源
    }

    if (!fs.existsSync(target)) {
      fail('后台页面引用了不存在的文件：' + rel + '（解析为 ' + path.relative(ROOT, target) + '）');
      adminLinkBad++;
    }
  }

  if (!adminLinkBad) ok('后台页面中 ' + adminLinkCount + ' 个本地外链均可解析');
}

// wrangler.toml 的 KV binding 必须与 _worker.js 里使用的 env.* 对得上
const wranglerPath = path.join(ROOT, 'wrangler.toml');
const workerPath = path.join(ROOT, 'public', '_worker.js');
if (fs.existsSync(wranglerPath) && fs.existsSync(workerPath)) {
  const wConf = fs.readFileSync(wranglerPath, 'utf8');
  const wCode = fs.readFileSync(workerPath, 'utf8');

  const bindings = [];
  const bindRe = /binding\s*=\s*"([A-Z_][A-Z0-9_]*)"/g;
  let bm;
  while ((bm = bindRe.exec(wConf))) bindings.push(bm[1]);

  // [vars] 里的键同样是合法的 env.* 来源（纯文本变量）。
  // 不收集的话，PBKDF2_ITERATIONS 这类配置会被误判成「未绑定的 env 变量」。
  const varsBlock = wConf.match(/^\[vars\]([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  if (varsBlock) {
    const varRe = /^[ \t]*([A-Z_][A-Z0-9_]*)[ \t]*=/gm;
    let vm;
    while ((vm = varRe.exec(varsBlock[1]))) bindings.push(vm[1]);
  }

  const used = new Set();
  const useRe = /\benv\.([A-Z_][A-Z0-9_]*)/g;
  let um;
  while ((um = useRe.exec(wCode))) used.add(um[1]);

  const unbound = [...used].filter((n) => n !== 'ASSETS' && bindings.indexOf(n) === -1);
  if (unbound.length) {
    fail('_worker.js 使用了未绑定的 env 变量：' + unbound.join(', ') +
         '（wrangler.toml 中已有的 binding / vars：' + (bindings.join(', ') || '无') + '）');
  } else {
    ok('KV 绑定与 Worker 用法一致（' + (bindings.join(', ') || '无绑定') + '）');
  }
} else if (!fs.existsSync(wranglerPath)) {
  warn('未找到 wrangler.toml，KV 需在 Cloudflare Dashboard 手动绑定');
}

// 后台 JS 引用的元素 id 必须存在于后台 HTML —— 与前台那套检查同理：
// id 拼错不会报任何错，只会让某个按钮「点了没反应」。
const adminJsPath = path.join(ROOT, 'public', 'admin', 'admin.js');
if (fs.existsSync(adminHtmlPath) && fs.existsSync(adminJsPath)) {
  const adminHtmlTxt = fs.readFileSync(adminHtmlPath, 'utf8');
  const adminJsTxt = fs.readFileSync(adminJsPath, 'utf8');

  const adminIds = new Set();
  const aIdRe = /\sid="([^"]+)"/g;
  let ai;
  while ((ai = aIdRe.exec(adminHtmlTxt))) adminIds.add(ai[1]);

  // 只认单引号字符串字面量里的 '#id'，且 id 必须以字母数字结尾 ——
  // 这样 '$("#pwd-" + f)' 这类拼接不会被当成 id（否则会误报 "pwd-"）。
  const adminRefs = new Map();
  const refRe = /(?:\$|\$\$)\s*\(\s*'#([A-Za-z][\w-]*[A-Za-z0-9]|[A-Za-z])'/g;
  let ri;
  while ((ri = refRe.exec(adminJsTxt))) {
    if (!adminRefs.has(ri[1])) adminRefs.set(ri[1], true);
  }

  const badIds = [...adminRefs.keys()].filter((id) => !adminIds.has(id));
  if (badIds.length) {
    fail('admin.js 引用了后台 HTML 中不存在的 id：' + badIds.join(', '));
  } else {
    ok('后台 JS 的 ' + adminRefs.size + ' 个 id 引用均能在 admin/index.html 中找到');
  }
}

// 密码规则在前端 / 后端 / 初始化脚本里各写了一份，必须保持一致，
// 否则会出现「前台放行、后端拒绝」这种最难排查的体验问题。
const pwdRuleTargets = [
  { file: path.join(ROOT, 'public', '_worker.js'), label: '_worker.js' },
  { file: path.join(ROOT, 'public', 'admin', 'admin.js'), label: 'admin.js' },
  { file: path.join(ROOT, 'scripts', 'init-admin.mjs'), label: 'init-admin.mjs' }
];
const pwdMins = [];
const pwdMaxes = [];
for (const t of pwdRuleTargets) {
  if (!fs.existsSync(t.file)) continue;
  const code = fs.readFileSync(t.file, 'utf8');
  const mn = code.match(/const PWD_MIN\s*=\s*(\d+)/);
  const mx = code.match(/const PWD_MAX\s*=\s*(\d+)/);
  if (mn) pwdMins.push(t.label + '=' + mn[1]);
  if (mx) pwdMaxes.push(t.label + '=' + mx[1]);
}
if (pwdMins.length >= 2) {
  const mins = new Set(pwdMins.map((s) => s.split('=')[1]));
  const maxes = new Set(pwdMaxes.map((s) => s.split('=')[1]));
  if (mins.size > 1 || maxes.size > 1) {
    fail('密码长度规则不一致：' + pwdMins.concat(pwdMaxes).join('  '));
  } else {
    ok('密码长度规则前后端一致（PWD_MIN=' + [...mins][0] + ', PWD_MAX=' + [...maxes][0] + '）');
  }
}

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
