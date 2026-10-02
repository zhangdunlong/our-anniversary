#!/usr/bin/env node
/**
 * ============================================================================
 *  init-admin.mjs —— 初始化 / 重置管理员密码
 * ============================================================================
 *
 *  作用：把 sha256(salt + password) 写入 Cloudflare KV（key: admin:password）。
 *        密码本身永不落盘、永不进代码仓库，这是本脚本存在的唯一理由。
 *
 *  为什么用「盐 + 哈希」而不是直接存密码：
 *    · KV 虽然只有你能访问，但明文密码一旦泄漏（比如截图、日志、误导出）
 *      就是直接可用的凭据；加盐哈希让泄漏的内容无法直接登录。
 *    · 每个环境用独立随机盐，避免彩虹表。
 *
 *  用法：
 *    node scripts/init-admin.mjs                  # 交互式输入（推荐，不回显）
 *    node scripts/init-admin.mjs --password xxx   # 命令行传入（注意 shell 历史）
 *    node scripts/init-admin.mjs --check          # 只检查是否已初始化
 *
 *  前置条件：
 *    · 已创建 KV namespace（见 README 的部署章节）
 *    · 环境变量 CLOUDFLARE_API_TOKEN 已设置，且具备 Workers KV Storage 写权限
 *    · 环境变量 CLOUDFLARE_ACCOUNT_ID 已设置
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const getFlag = (name) => argv.indexOf(name) > -1;
const getValue = (name) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : null;
};

const CHECK_ONLY = getFlag('--check');
const CLI_PASSWORD = getValue('--password');

/* ------------------------------------------------------------------ 配置 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'REPLACE_WITH_YOUR_ACCOUNT_ID';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const KV_BINDING = 'LOVE_DATA';
const KV_KEY = 'admin:password';

/**
 * 读取 wrangler.toml / .jsonc / pages 的 KV 绑定来拿 namespace id。
 * 本项目没有 wrangler 配置文件时，退回到环境变量或第二个参数。
 */
function resolveNamespaceId() {
  const fromEnv = process.env.LOVE_KV_NAMESPACE_ID;
  if (fromEnv) return fromEnv;

  const candidates = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'];
  for (const name of candidates) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    // 朴素匹配：id = "xxx" 或 "id": "xxx"
    const re = new RegExp('["\']?id["\']?\\s*[:=]\\s*["\']([a-f0-9]{32})["\']', 'i');
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ 工具 */

/** WebCrypto 在 Node 18+ 是全局可用的 */
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 隐藏回显的密码输入（Node 原生方案，不依赖第三方包） */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdin = process.stdin;

    process.stdout.write(question);

    // 关闭回显：直接把输出流“骗”过去，输入字符不会显示
    const originalWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = function (str) {
      // 只放行我们主动写的问题文本，其余（用户输入）一律吞掉
      if (str.includes(question)) process.stdout.write(str);
    };

    rl.question('', (answer) => {
      rl._writeToOutput = originalWrite || rl._writeToOutput;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });

    if (stdin.isTTY) stdin.resume();
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

async function kvRequest(namespaceId, method, body) {
  const url = 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT_ID +
              '/storage/kv/namespaces/' + namespaceId + '/values/' + encodeURIComponent(KV_KEY);

  const res = await fetch(url, {
    method: method,
    headers: {
      'authorization': 'Bearer ' + API_TOKEN,
      'content-type': 'text/plain'
    },
    body: body
  });

  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (err) { payload = null; }

  return { status: res.status, payload, raw: text };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log('');
  console.log('  ❤  纪念日后台 —— 管理员密码初始化');
  console.log('  ─────────────────────────────────────────────');

  const namespaceId = resolveNamespaceId();

  if (!namespaceId) {
    console.log('');
    console.log('  ✖ 找不到 KV namespace id');
    console.log('');
    console.log('  请先创建 KV namespace：');
    console.log('    npx wrangler kv namespace create LOVE_DATA');
    console.log('');
    console.log('  然后把返回的 id 写入 wrangler.toml，或设置环境变量：');
    console.log('    set LOVE_KV_NAMESPACE_ID=<你的 id>');
    console.log('');
    process.exitCode = 1;
    return;
  }

  console.log('  Account   : ' + ACCOUNT_ID);
  console.log('  KV 命名空间: ' + namespaceId);
  console.log('  ─────────────────────────────────────────────');

  if (!API_TOKEN) {
    console.log('');
    console.log('  ✖ 缺少环境变量 CLOUDFLARE_API_TOKEN');
    console.log('     kv 写权限的 token 是必须的。');
    console.log('');
    process.exitCode = 1;
    return;
  }

  /* ---- 只检查 ---- */
  if (CHECK_ONLY) {
    const res = await kvRequest(namespaceId, 'GET');
    const initialized = res.status === 200 && res.raw && res.raw.indexOf(':') > -1;
    console.log('');
    console.log(initialized
      ? '  ✔ 管理员密码已初始化（KV 中已有 admin:password）'
      : '  ⚠ 尚未初始化，请运行：node scripts/init-admin.mjs');
    console.log('');
    return;
  }

  /* ---- 取密码 ---- */
  let password = CLI_PASSWORD;

  if (!password) {
    password = await askHidden('  请输入管理员密码：');
    if (!password) { console.log('\n  ✖ 密码不能为空\n'); process.exitCode = 1; return; }

    const again = await askHidden('  请再输入一次确认：');
    if (again !== password) {
      console.log('\n  ✖ 两次输入的密码不一致\n');
      process.exitCode = 1;
      return;
    }
  }

  if (password.length < 6) {
    console.log('\n  ✖ 密码至少 6 位（后台无验证码，建议更长）\n');
    process.exitCode = 1;
    return;
  }

  /* ---- 生成盐 + 哈希，写 KV ---- */
  const salt = randomSalt();
  const hash = await sha256Hex(salt + password);
  const value = salt + ':' + hash;

  console.log('');
  console.log('  正在写入 KV…');

  const res = await kvRequest(namespaceId, 'PUT', value);

  if (res.status !== 200 && !(res.payload && res.payload.success)) {
    console.log('');
    console.log('  ✖ 写入失败（HTTP ' + res.status + '）');
    if (res.payload && res.payload.errors) {
      res.payload.errors.forEach((e) => console.log('     · ' + e.code + ' ' + e.message));
    } else {
      console.log('     ' + res.raw.slice(0, 300));
    }
    console.log('');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('  ✔ 管理员密码已写入 KV');
  console.log('    键名：' + KV_KEY);
  console.log('    值  ：' + value.slice(0, 20) + '…（' + value.length + ' 字符）');
  console.log('');
  console.log('  现在可以登录了：');
  console.log('    https://our-anniversary.pages.dev/admin/');
  console.log('');
  console.log('  想改密码？再跑一次本脚本即可覆盖。');
  console.log('');
}

main().catch((err) => {
  console.error('\n  ✖ 未预期的错误：', err && err.message ? err.message : err);
  process.exitCode = 1;
});
