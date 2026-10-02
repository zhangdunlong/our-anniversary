#!/usr/bin/env node
/**
 * ============================================================================
 *  init-admin.mjs —— 初始化 / 重置管理员密码
 * ============================================================================
 *
 *  作用：把 PBKDF2-SHA256 派生出的哈希写入 Cloudflare KV（key: admin:password）。
 *        密码本身永不落盘、永不进代码仓库，这是本脚本存在的唯一理由。
 *
 *  存储格式（与 _worker.js 的 parseStoredHash 保持一致）：
 *    v2  pbkdf2$<迭代次数>$<盐 hex>$<派生密钥 hex>   ← 本脚本写入的格式
 *    v1  <盐 hex>:<sha256 hex>                      ← 历史格式；后台登录时会自动升级为 v2
 *
 *  为什么用「盐 + 慢哈希」而不是直接存密码：
 *    · KV 虽然只有你能访问，但明文密码一旦泄漏（比如截图、日志、误导出）
 *      就是直接可用的凭据；加盐哈希让泄漏的内容无法直接登录。
 *    · 每个环境用独立随机盐，避免彩虹表。
 *    · 单轮 SHA-256 太快，GPU 每秒能算上百亿次，离线爆破成本极低；
 *      PBKDF2 靠迭代把单次校验的成本拉高若干个数量级。
 *
 *  ⚠ 迭代次数的取值受 Workers CPU 配额限制（详见 wrangler.toml 的 [vars] 注释）：
 *      Free 计划每请求 10ms CPU，默认 10000 次；Paid 计划可调到 600000。
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
 * PBKDF2 迭代次数。默认值与 wrangler.toml 的 [vars] 保持一致，
 * 可用环境变量覆盖（注意：改这个值只影响**新写入**的哈希，
 * 已有密码的校验次数是从存储串里读的，不会被影响）。
 */
const PBKDF2_ITERATIONS = (function () {
  const n = Number(process.env.PBKDF2_ITERATIONS);
  return isFinite(n) && n >= 1 ? Math.floor(n) : 10000;
})();

/* 与 _worker.js 的 validatePasswordStrength / admin.js 的 validatePasswordForm 同一套规则 */
const PWD_MIN = 8;
const PWD_MAX = 64;
const WEAK_PASSWORDS = [
  '12345678', '123456789', '1234567890', '87654321',
  'password', 'password1', 'passw0rd', 'p@ssword',
  'qwertyui', 'qwerty123', '1qaz2wsx', 'zxcvbnm1',
  'abc12345', 'a1234567', 'abcd1234', 'admin123', 'admin1234',
  'iloveyou', 'loveyou1', '5201314', '1314520', 'woaini1314'
];

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

function randomSalt(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 小写 hex → Uint8Array */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** PBKDF2-SHA256 → 小写 hex（与 _worker.js 的 pbkdf2Hex 完全一致） */
async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    key,
    256
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 生成 v2 存储串：pbkdf2$<迭代次数>$<盐>$<哈希> */
async function hashPassword(password, iterations) {
  const salt = randomSalt();
  const hash = await pbkdf2Hex(password, salt, iterations);
  return 'pbkdf2$' + iterations + '$' + salt + '$' + hash;
}

/** 判断存储串用的是哪一代格式 */
function detectScheme(raw) {
  if (!raw) return 'unknown';
  if (raw.indexOf('pbkdf2$') === 0) return 'v2 (PBKDF2-SHA256)';
  if (raw.indexOf(':') > -1) return 'v1 (SHA-256，登录时会自动升级为 v2)';
  return 'unknown';
}

/**
 * 新密码强度校验 —— 与 _worker.js / admin.js 同一套规则。
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function validatePasswordStrength(pwd) {
  if (!pwd) return { ok: false, message: '密码不能为空' };

  const chars = Array.from(pwd);
  if (chars.length < PWD_MIN) return { ok: false, message: '密码至少 ' + PWD_MIN + ' 位' };
  if (chars.length > PWD_MAX) return { ok: false, message: '密码不能超过 ' + PWD_MAX + ' 位' };
  if (/^\s|\s$/.test(pwd)) return { ok: false, message: '密码的首尾不能是空格' };

  let kinds = 0;
  if (/[a-z]/.test(pwd)) kinds++;
  if (/[A-Z]/.test(pwd)) kinds++;
  if (/[0-9]/.test(pwd)) kinds++;
  if (/[^A-Za-z0-9]/.test(pwd)) kinds++;
  if (kinds < 2) {
    return { ok: false, message: '密码需包含大写字母、小写字母、数字、符号中的至少两类' };
  }

  if (/^(.)\1*$/.test(pwd)) return { ok: false, message: '密码不能是同一个字符的重复' };
  if (WEAK_PASSWORDS.indexOf(pwd.toLowerCase()) > -1) {
    return { ok: false, message: '该密码过于常见，容易被猜到，请换一个' };
  }

  return { ok: true };
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
    const raw = res.status === 200 ? res.raw : '';
    const initialized = !!raw && (raw.indexOf('pbkdf2$') === 0 || raw.indexOf(':') > -1);

    console.log('');
    if (initialized) {
      console.log('  ✔ 管理员密码已初始化（KV 中已有 admin:password）');
      console.log('    存储格式：' + detectScheme(raw));
      if (raw.indexOf('pbkdf2$') === 0) {
        console.log('    PBKDF2 迭代次数：' + raw.split('$')[1]);
      } else {
        console.log('    ⚠ 仍是旧格式，下次成功登录时会自动升级为 PBKDF2');
      }
    } else {
      console.log('  ⚠ 尚未初始化，请运行：node scripts/init-admin.mjs');
    }
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

  const strength = validatePasswordStrength(password);
  if (!strength.ok) {
    console.log('\n  ✖ ' + strength.message + '\n');
    process.exitCode = 1;
    return;
  }

  /* ---- 生成盐 + 哈希，写 KV ---- */
  console.log('');
  console.log('  正在派生密钥（PBKDF2-SHA256 × ' + PBKDF2_ITERATIONS + ' 次）…');

  const value = await hashPassword(password, PBKDF2_ITERATIONS);

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
  console.log('    格式：v2 (PBKDF2-SHA256 × ' + PBKDF2_ITERATIONS + ')');
  console.log('    值  ：' + value.slice(0, 24) + '…（' + value.length + ' 字符）');
  console.log('');
  console.log('  现在可以登录了：');
  console.log('    https://our-anniversary.pages.dev/admin/');
  console.log('');
  console.log('  想改密码？可以直接登录后在后台点 🔑 修改，也可以再跑一次本脚本覆盖。');
  console.log('» 注意：本脚本只改密码，不会吊销已登录的会话；');
  console.log('  在后台里改密码则会强制所有设备重新登录。');
  console.log('');
}

main().catch((err) => {
  console.error('\n  ✖ 未预期的错误：', err && err.message ? err.message : err);
  process.exitCode = 1;
});
