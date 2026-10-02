#!/usr/bin/env node
/**
 * build-site.mjs —— 产出部署目录 dist/site/
 *
 * 为什么需要「构建」而不是直接部署根目录：
 *   根目录里还有 _legacy/（原始备份）、scripts/、docs/、node_modules 等
 *   与运行时无关的内容。直接部署会把它们一起传上去，既浪费流量，
 *   也可能暴露不必要的信息。
 *   本脚本只挑选运行必需的 5 项，产出干净、可复现的部署目录。
 *
 * 用法：node scripts/build-site.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'site');

/**
 * 需要进入部署目录的顶层条目。
 * public/ 里的内容会被「摊平」到部署根目录 —— 这样 admin/ 落在 /admin/，
 * _worker.js 落在站点根（Pages 只认根目录下的 _worker.js）。
 */
const INCLUDE = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'robots.txt',
  '_headers',
  'src',
  'assets'
];

/** public/ 下的条目：源路径 → 部署根目录下的目标名 */
const PUBLIC_INCLUDE = [
  '_worker.js',
  'admin'
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (fs.statSync(full).isDirectory()) walk(full, base, out);
    else out.push(rel);
  }
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  let missing = [];

  for (const name of INCLUDE) {
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) { missing.push(name); continue; }
    copyRecursive(src, path.join(OUT, name));
  }

  // public/ 的内容摊平到部署根目录
  for (const name of PUBLIC_INCLUDE) {
    const src = path.join(ROOT, 'public', name);
    if (!fs.existsSync(src)) { missing.push('public/' + name); continue; }
    copyRecursive(src, path.join(OUT, name));
  }

  const files = [];
  walk(OUT, OUT, files);

  let total = 0;
  files.forEach((f) => { total += fs.statSync(path.join(OUT, f)).size; });

  console.log('');
  console.log('  ✔ 部署目录已生成：' + OUT);
  console.log('    文件数：' + files.length + '   总体积：' + (total / 1024 / 1024).toFixed(2) + ' MB');
  if (missing.length) console.log('    ⚠ 缺失条目：' + missing.join(', '));
  console.log('');
}

main();
