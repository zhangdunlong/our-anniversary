#!/usr/bin/env node
/**
 * build-standalone.mjs —— 把整个工程打包成一个**可双击打开的 HTML 文件**
 *
 * 使用场景：把这一页当作礼物发出去时，对方不一定愿意点链接，
 *   但一个 HTML 文件发过去就能直接看。产物是 dist/love-standalone.html。
 *
 * 实现方式（自研微型打包器，零依赖）：
 *   1. 从 src/main.js 出发，正则解析 import 语句，建立模块依赖图；
 *   2. 深度优先拓扑排序，保证父模块不会先于依赖执行；
 *   3. 把每个模块源码做三项改写：
 *        a. import  → __req('模块id')     得到依赖的导出对象
 *        b. export  → 去掉关键字，并记录导出名
 *        c. 模块整体包进 __def(id, function(__exp, __req){...})
 *      —— 关键点：每个模块保留独立函数作用域，
 *         所以各模块里同名的内部常量（比如三处 MS_DAY）不会互相覆盖；
 *   4. 4 个 CSS 文件合并成一段 <style> 内联；
 *   5. 可选把 mp3 转 base64 内联（--with-audio）。
 *
 * 用法：
 *   node scripts/build-standalone.mjs              # 不含音频（推荐，产物约 60KB）
 *   node scripts/build-standalone.mjs --with-audio # 含音频（产物约 10MB）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const ENTRY = 'main.js';
const WITH_AUDIO = process.argv.includes('--with-audio');

const CSS_FILES = ['tokens.css', 'base.css', 'layout.css', 'components.css'];

/* ==========================================================================
   0. 配置预处理 —— 单文件版没有 assets/ 目录，音频地址必须改写
   ========================================================================== */
let audioDataUrl = null;

function preprocess(id, raw) {
  if (id !== 'config/site.config.js') return raw;

  // 把 music.src 这一行整体替换掉，避免改到别处的同名字符串
  const lineRe = /^[ \t]*src:\s*'[^']*',[ \t]*$/m;

  if (WITH_AUDIO && audioDataUrl) {
    return raw.replace(lineRe, () => "    src: '" + audioDataUrl + "',");
  }
  // 不含音频时置空 —— music.js 会据此隐藏播放按钮，
  // 这样单文件版里不会留下一个指向不存在文件的地址
  return raw.replace(lineRe, () => "    src: '',");
}

/* ==========================================================================
   1. 模块解析
   ========================================================================== */

/** 把相对路径 specifier 解析成「相对 src/ 的模块 id」 */
function resolveId(fromId, spec) {
  const base = fromId.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return base.join('/');
}

/** 读取并改写单个模块源码 */
function transform(id, rawSource) {
  const deps = [];
  const exports = [];
  let src = preprocess(id, rawSource);

  // ---- import { a, b as c } from './x.js' ----
  src = src.replace(
    /^[ \t]*import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm,
    (m, names, spec) => {
      const depId = resolveId(id, spec);
      deps.push(depId);
      const pairs = names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((n) => {
          const as = n.split(/\s+as\s+/);
          return as.length === 2 ? as[1] + ': ' + as[0] : n;
        });
      return 'const { ' + pairs.join(', ') + ' } = __req(' + JSON.stringify(depId) + ');';
    }
  );

  // ---- import * as ns from './x.js' ----
  src = src.replace(
    /^[ \t]*import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm,
    (m, name, spec) => {
      const depId = resolveId(id, spec);
      deps.push(depId);
      return 'const ' + name + ' = __req(' + JSON.stringify(depId) + ');';
    }
  );

  // ---- export function / const / let / var / class ----
  src = src.replace(
    /^[ \t]*export\s+(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
    (m, asyncKw, kind, name) => {
      exports.push({ local: name, exported: name });
      return (asyncKw || '') + kind + ' ' + name;
    }
  );

  // ---- export { a, b as c } ----
  src = src.replace(/^[ \t]*export\s*\{([^}]*)\};?[ \t]*$/gm, (m, names) => {
    names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => {
        const as = n.split(/\s+as\s+/);
        if (as.length === 2) exports.push({ local: as[0], exported: as[1] });
        else exports.push({ local: n, exported: n });
      });
    return '';
  });

  // 安全网：如果还有残留的 import/export 语句，说明写法超出了本打包器的支持范围
  const leftover = src.match(/^[ \t]*(import|export)\s/m);
  if (leftover) {
    throw new Error(
      '模块 ' + id + ' 中仍有未被处理的 ' + leftover[1] + ' 语句。\n' +
      '本打包器只支持单行具名/命名空间 import 与顶层 export 声明。'
    );
  }

  const tail = exports
    .map((e) => '__exp[' + JSON.stringify(e.exported) + '] = ' + e.local + ';')
    .join(' ');

  const body = '__def(' + JSON.stringify(id) + ', function (__exp, __req) {\n' +
    src + '\n' + tail + '\n});\n';

  return { code: body, deps };
}

/* ==========================================================================
   2. 依赖图 + 拓扑排序
   ========================================================================== */
function buildGraph() {
  const modules = new Map();   // id -> { code, deps }
  const order = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('检测到循环依赖：' + id);

    visiting.add(id);

    const file = path.join(SRC, id);
    if (!fs.existsSync(file)) throw new Error('找不到模块：' + file);

    const raw = fs.readFileSync(file, 'utf8');
    const { code, deps } = transform(id, raw);
    modules.set(id, code);

    deps.forEach(visit);       // 先处理依赖（深度优先）

    visiting.delete(id);
    visited.add(id);
    order.push(id);            // 后序 → 依赖永远排在父模块之前
  }

  visit(ENTRY);
  return { order, modules };
}

/* ==========================================================================
   3. 组装
   ========================================================================== */
function build() {
  // 先准备音频 data URL —— preprocess() 依赖它
  if (WITH_AUDIO) {
    const mp3 = path.join(ROOT, 'assets', 'audio', 'renxi.mp3');
    if (!fs.existsSync(mp3)) {
      throw new Error('指定了 --with-audio，但找不到 assets/audio/renxi.mp3');
    }
    audioDataUrl = 'data:audio/mpeg;base64,' + fs.readFileSync(mp3).toString('base64');
  }

  const { order, modules } = buildGraph();

  const runtime = [
    '(function () {',
    '  "use strict";',
    '  window.__LOVE_STANDALONE__ = true;',
    '  var __registry = {};',
    '  var __cache = {};',
    '  function __def(id, factory) { __registry[id] = factory; }',
    '  function __req(id) {',
    '    if (__cache[id]) return __cache[id];',
    '    var mod = {};',
    '    __cache[id] = mod;',
    '    var factory = __registry[id];',
    '    if (!factory) { console.warn("[love] 模块缺失：" + id); return mod; }',
    '    factory(mod, __req);',
    '    return mod;',
    '  }'
  ].join('\n');

  const moduleCode = order.map((id) => modules.get(id)).join('\n');

  const bootstrap = '\n  __req(' + JSON.stringify(ENTRY) + ');\n})();\n';

  const js = runtime + '\n\n' + moduleCode + bootstrap;

  // ---- CSS 合并 ----
  const css = CSS_FILES.map((name) => {
    const file = path.join(SRC, 'styles', name);
    return '/* ===== ' + name + ' ===== */\n' + fs.readFileSync(file, 'utf8');
  }).join('\n\n');

  // ---- HTML 改写 ----
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // ---- 内联 CSS ----
  /* ⚠️ 关键细节：这里必须用「函数式替换」而不是字符串替换。
     String.replace 的字符串替换值会把 $$ 解释成一个字面 $，
     而 JS 产物里到处是 $$（DOM 工具函数名），一旦被吞掉整份 bundle 就废了。
     传一个函数则返回值按字面量处理，彻底规避这个坑。 */
  const linkRe = /\s*<link rel="stylesheet" href="src\/styles\/[^"]+">/g;
  if (!linkRe.test(html)) throw new Error('未能在 index.html 中定位到样式链接，打包中止');
  linkRe.lastIndex = 0;
  html = html.replace(linkRe, () => '');
  html = html.replace('</head>', () => '  <style>\n' + css + '\n  </style>\n</head>');

  // ---- 内联 JS 入口（同样必须用函数式替换）----
  const entryRe = /\s*<script type="module" src="src\/main.js"><\/script>/;
  if (!entryRe.test(html)) throw new Error('未能在 index.html 中定位到模块入口，打包中止');
  html = html.replace(entryRe, () => '\n  <script>\n' + js + '\n  </script>');

  // 单文件版没有独立的 manifest / 图标文件，去掉相关外链避免 404
  html = html
    .replace(/\s*<link rel="manifest" href="manifest\.webmanifest">/, () => '')
    .replace(/\s*<link rel="apple-touch-icon" href="assets\/icons\/icon-192\.png">/, () => '');

  /* ---- 自检：确认 $$ 这类含 $ 的标识符没有被替换逻辑吃掉 ----
     踩过一次坑：字符串式 replace 会把替换值里的 $$ 折叠成 $，
     产物在浏览器里直接报「Identifier '$' has already been declared」。
     这里做一次硬断言，让同类问题在打包阶段就暴露，而不是等用户打开才发现。 */
  const dollarsInSource = order
    .map((id) => (modules.get(id).match(/\$\$/g) || []).length)
    .reduce((a, b) => a + b, 0);
  const dollarsInHtml = (html.match(/\$\$/g) || []).length;
  if (dollarsInHtml < dollarsInSource) {
    throw new Error(
      '打包自检失败：源码中有 ' + dollarsInSource + ' 处 $$，产物中只剩 ' +
      dollarsInHtml + ' 处 —— 替换过程吞掉了 $ 字符'
    );
  }

  // ---- 音频 ----
  // 音频地址已在 preprocess() 阶段写进配置；这里只负责把文件读成 data URL
  let audioNote = '（不含音频，播放按钮自动隐藏）';
  if (WITH_AUDIO && audioDataUrl) {
    audioNote = '（已内嵌音频 ' + (fs.statSync(path.join(ROOT, 'assets', 'audio', 'renxi.mp3')).size / 1024 / 1024).toFixed(1) + ' MB）';
  }

  const outDir = path.join(ROOT, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'love-standalone.html');
  fs.writeFileSync(outFile, html, 'utf8');

  const size = fs.statSync(outFile).size;
  console.log('');
  console.log('  ✔ 单文件版已生成 ' + audioNote);
  console.log('    ' + outFile);
  console.log('    模块数：' + order.length + '   体积：' + (size / 1024).toFixed(1) + ' KB');
  console.log('    模块加载顺序：' + order.join(' → '));
  console.log('');
}

try {
  build();
} catch (err) {
  console.error('\n  ✘ 打包失败：' + err.message + '\n');
  process.exit(1);
}
