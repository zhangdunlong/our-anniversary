#!/usr/bin/env node
/**
 * dev-server.mjs —— 零依赖本地静态服务器
 *
 * 为什么必须有它：本项目用 ES Modules（<script type="module">），
 * 浏览器对模块脚本执行同源策略检查，直接用 file:// 双击打开会被 CORS 拦死。
 * 所以本地预览必须走 http。这里手写一个 ~100 行的服务器，
 * 不引入 express / http-server 等任何依赖。
 *
 * 用法：node scripts/dev-server.mjs [端口]
 *   默认 http://127.0.0.1:5173
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

/** 阻止路径穿越：解析后必须仍在 ROOT 之内 */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = path.join(root, decoded);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(root))) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  let filePath = safeJoin(ROOT, req.url === '/' ? '/index.html' : req.url);
  if (!filePath) {
    res.writeHead(403).end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + req.url);
      return;
    }

    // 目录 → index.html
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404).end('404 Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // 开发时禁用缓存，改代码刷新即可见效
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ❤  本地预览已启动');
  console.log('     http://127.0.0.1:' + PORT + '/');
  console.log('     根目录：' + ROOT);
  console.log('     Ctrl+C 停止');
  console.log('');
});
