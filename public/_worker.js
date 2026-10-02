/**
 * ============================================================================
 *  _worker.js —— Cloudflare Pages 的单一 Worker 后端
 * ============================================================================
 *
 *  为什么用单文件 `_worker.js` 而不是 `functions/api/[[path]].js`：
 *    Pages 的 Functions 目录约定要求文件名里带方括号（catch-all 路由），
 *    这在 Windows 文件系统 / Git 上经常出问题（.gitignore 通配、路径解析歧义）。
 *    `_worker.js` 是 Pages 官方另一种一等公民形态：整个站点走同一个 Worker，
 *    静态资源通过 `env.ASSETS.fetch()` 回退。语义清晰、行为可预测。
 *
 *  架构：请求分流
 *    /api/*        → 本 Worker 处理（JSON）
 *    其它一切路径  → env.ASSETS.fetch()（静态文件）+ SPA 式回退
 *
 *  接口一览
 *    GET    /api/anniversaries              前台读取（仅 visible:true，已排序）
 *    POST   /api/login                      管理员登录 → token
 *    POST   /api/logout                     注销 token
 *    GET    /api/admin/anniversaries        后台读取全量（需鉴权）
 *    POST   /api/admin/anniversaries        新增（需鉴权）
 *    PUT    /api/admin/anniversaries/:id    编辑（需鉴权）
 *    DELETE /api/admin/anniversaries/:id    删除（需鉴权）
 *    POST   /api/admin/password             修改管理员密码（需鉴权）
 *
 *  安全设计
 *    - 管理员密码不落在代码里，只存哈希到 KV，校验用恒定时间比较。
 *      哈希格式（版本化，便于日后平滑升级算法）：
 *        v2  pbkdf2$<迭代次数>$<盐 hex>$<派生密钥 hex>   ← 当前写入的格式
 *        v1  <盐 hex>:<sha256 hex>                      ← 历史格式，登录时自动升级
 *    - PBKDF2 迭代次数通过环境变量 PBKDF2_ITERATIONS 配置。默认值偏保守：
 *      Workers 免费版每请求只有 10ms CPU，而 PBKDF2 是纯 CPU 开销，
 *      100000 次迭代会直接触发 Error 1102（Worker exceeded resource limits）。
 *      付费版（30s CPU）可以把该值调到 600000。
 *    - 登录成功签发 32 字节随机 token，存 KV 并带 TTL（默认 7 天），过期自动清除。
 *    - token 绑定的不是「密码」而是「密码世代」（KV: admin:tokenEpoch）。
 *      改密码时把 epoch 换成新的随机值 → 所有已签发 token 立刻全部失效，
 *      不需要依赖 KV list 的最终一致性。这是「改密码后强制重新登录」的实现基础。
 *    - 登录与改密码都带失败限流（按 CF-Connecting-IP 计数），防在线暴力破解。
 *    - 所有写操作强制走鉴权中间件；错误信息不泄漏内部细节。
 *    - 响应统一带 no-store，避免中间层缓存到带 token 的内容。
 * ============================================================================
 */

/* ------------------------------------------------------------------ 常量 */

const KV_KEY_PASSWORD = 'admin:password';   // 见上方「哈希格式」说明
const KV_KEY_EPOCH = 'admin:tokenEpoch';    // 当前密码世代；改密码后轮换
const KV_KEY_PWD_CHANGED = 'admin:pwdChangedAt'; // 上次改密码时间（防抖冷却用）
const KV_KEY_DATA = 'anniversaries';        // 纪念日数组
const KV_TOKEN_PREFIX = 'token:';           // token:<value> → epoch
const KV_RATE_PREFIX = 'rl:';               // rl:<scope>:<ip> → { fails, resetAt }
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 天

/** 密码哈希：PBKDF2-SHA256 默认迭代次数（可被 env.PBKDF2_ITERATIONS 覆盖） */
const PBKDF2_DEFAULT_ITERATIONS = 10000;
/** 上限兜底：防止有人把环境变量写成 10 亿导致请求必超时 */
const PBKDF2_MAX_ITERATIONS = 1000000;

/** 新密码的长度约束（与前端 admin.js 的 PWD_MIN/PWD_MAX 必须一致） */
const PWD_MIN = 8;
const PWD_MAX = 64;

/** 失败限流：同一 IP 在窗口内允许的失败次数 */
const RATE_LIMIT_DEFAULT_MAX = 8;
const RATE_LIMIT_DEFAULT_WINDOW = 300;   // 秒

/** 改密码成功后的冷却：防止脚本化高频改密 */
const PWD_CHANGE_COOLDOWN_DEFAULT = 15;  // 秒

/**
 * 弱密码黑名单（小写比较）。
 * 只放「一眼就知道会被字典攻击命中」的高频口令；
 * 真正的强度靠长度 + 字符类别要求，不靠枚举。
 */
const WEAK_PASSWORDS = [
  '12345678', '123456789', '1234567890', '87654321',
  'password', 'password1', 'passw0rd', 'p@ssword',
  'qwertyui', 'qwerty123', '1qaz2wsx', 'zxcvbnm1',
  'abc12345', 'a1234567', 'abcd1234', 'admin123', 'admin1234',
  'iloveyou', 'loveyou1', '5201314', '1314520', 'woaini1314'
];

/** 允许的纪念日类型（与前台 UI 的标签一一对应） */
const TYPES = ['birthday', 'love', 'festival', 'memorial', 'other'];

/** 字段长度上限，防止有人塞超长内容把 KV 撑爆 */
const LIMITS = {
  name: 30,
  note: 100,
  icon: 4      // emoji 可能是代理对，留 4 个 UTF-16 单元
};

/* ------------------------------------------------------------------ 工具 */

/** 统一 JSON 响应；永远禁止缓存（内容与登录态相关） */
function json(data, status, extraHeaders) {
  const headers = Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'x-content-type-options': 'nosniff'
  }, extraHeaders || {});
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: headers
  });
}

function ok(data, extraHeaders) {
  return json({ ok: true, data: data === undefined ? null : data }, 200, extraHeaders);
}

/**
 * @param {string} code    机器可读错误码
 * @param {string} message 给用户看的中文提示
 * @param {number} [status] HTTP 状态码
 * @param {string} [field] 出错的表单字段名（前端用来定位高亮）
 * @param {object} [headers] 附加响应头（429 时需要 Retry-After）
 */
function fail(code, message, status, field, headers) {
  const error = { code: code, message: message };
  if (field) error.field = field;
  return json({ ok: false, error: error }, status || 400, headers);
}

/** 所有响应都加这几个头：跨域收紧 + 不缓存 + 禁嗅探 */
function harden(response) {
  const h = new Headers(response.headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  // 只允许同源调用 API（配合下面的 preflight 处理）
  h.set('access-control-allow-origin', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h
  });
}

/** WebCrypto SHA-256 → 小写 hex */
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * 恒定时间字符串比较 —— 避免通过响应耗时差异逐字符猜密码。
 * 长度不同直接 false，但依旧走完循环（时间与较长者相关）。
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 生成随机 token（32 字节 → 64 位 hex） */
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 生成 id：短小、可读、冲突概率可忽略 */
function newId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 从请求头取出 Bearer token */
function readBearer(request) {
  const raw = request.headers.get('authorization') || '';
  const m = raw.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}

/* ------------------------------------------------------------------ 密码哈希 */

/** Uint8Array → 小写 hex */
function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 小写 hex → Uint8Array（输入必须已通过 /^[a-f0-9]+$/ 校验） */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function randomBytes(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** PBKDF2-SHA256 → 小写 hex（256 bit 派生密钥） */
async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iterations, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

/** 读环境变量里的迭代次数，非法值一律回落到默认值 */
function resolveIterations(env) {
  const raw = env && env.PBKDF2_ITERATIONS;
  const n = Number(raw);
  if (!isFinite(n) || n < 1) return PBKDF2_DEFAULT_ITERATIONS;
  return Math.min(Math.floor(n), PBKDF2_MAX_ITERATIONS);
}

/** 用当前算法生成一条新哈希记录 */
async function hashPassword(password, iterations) {
  const salt = bytesToHex(randomBytes(16));
  const hash = await pbkdf2Hex(password, salt, iterations);
  return 'pbkdf2$' + iterations + '$' + salt + '$' + hash;
}

/**
 * 解析 KV 里存的哈希记录。
 * @returns {null | { scheme: 'pbkdf2'|'sha256', iterations: number, salt: string, hash: string }}
 */
function parseStoredHash(stored) {
  if (typeof stored !== 'string' || !stored) return null;

  if (stored.indexOf('pbkdf2$') === 0) {
    const parts = stored.split('$');
    if (parts.length !== 4) return null;
    const iterations = Number(parts[1]);
    if (!isFinite(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) return null;
    if (!/^[a-f0-9]+$/i.test(parts[2]) || !/^[a-f0-9]+$/i.test(parts[3])) return null;
    return { scheme: 'pbkdf2', iterations: Math.floor(iterations), salt: parts[2], hash: parts[3] };
  }

  // v1：<盐 hex>:<sha256 hex>
  const sep = stored.indexOf(':');
  if (sep > 0) {
    const salt = stored.slice(0, sep);
    const hash = stored.slice(sep + 1);
    if (/^[a-f0-9]+$/i.test(salt) && /^[a-f0-9]+$/i.test(hash)) {
      return { scheme: 'sha256', iterations: 0, salt: salt, hash: hash };
    }
  }

  return null;
}

/**
 * 校验密码。
 * @returns {Promise<{ ok: boolean, legacy: boolean, malformed?: boolean }>}
 *   legacy=true 表示命中的是 v1（单轮 SHA-256）记录，调用方可顺手升级到 v2。
 */
async function verifyPassword(stored, password) {
  const parsed = parseStoredHash(stored);
  if (!parsed) return { ok: false, legacy: false, malformed: true };

  if (parsed.scheme === 'pbkdf2') {
    const attempt = await pbkdf2Hex(password, parsed.salt, parsed.iterations);
    return { ok: timingSafeEqual(attempt, parsed.hash), legacy: false };
  }

  const attempt = await sha256Hex(parsed.salt + password);
  return { ok: timingSafeEqual(attempt, parsed.hash), legacy: true };
}

/**
 * 新密码强度校验 —— 与前端 admin.js 的 validatePasswordForm 同一套规则。
 * 后端是唯一权威：前端校验只为体验，绕过前端也必须被拦住。
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function validatePasswordStrength(pwd) {
  if (typeof pwd !== 'string' || !pwd) return { ok: false, message: '请输入新密码' };

  const chars = Array.from(pwd);           // 按码点计数，emoji 不会被算成两位
  if (chars.length < PWD_MIN) return { ok: false, message: '新密码至少 ' + PWD_MIN + ' 位' };
  if (chars.length > PWD_MAX) return { ok: false, message: '新密码不能超过 ' + PWD_MAX + ' 位' };
  if (/^\s|\s$/.test(pwd)) return { ok: false, message: '新密码的首尾不能是空格' };

  let kinds = 0;
  if (/[a-z]/.test(pwd)) kinds++;
  if (/[A-Z]/.test(pwd)) kinds++;
  if (/[0-9]/.test(pwd)) kinds++;
  if (/[^A-Za-z0-9]/.test(pwd)) kinds++;
  if (kinds < 2) {
    return { ok: false, message: '新密码需包含大写字母、小写字母、数字、符号中的至少两类' };
  }

  if (/^(.)\1*$/.test(pwd)) return { ok: false, message: '新密码不能是同一个字符的重复' };
  if (WEAK_PASSWORDS.indexOf(pwd.toLowerCase()) > -1) {
    return { ok: false, message: '该密码过于常见，容易被猜到，请换一个' };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ 限流 */

/**
 * 取客户端 IP。
 * CF-Connecting-IP 由 Cloudflare 边缘注入，客户端伪造不了（直连源站才会缺失）。
 */
function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

function envInt(env, name, fallback, min, max) {
  const n = Number(env && env[name]);
  if (!isFinite(n) || n < 0) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function rateLimitKey(scope, ip) {
  return KV_RATE_PREFIX + scope + ':' + ip;
}

/**
 * 判断该 IP 是否已被限流。
 * 说明：KV 是最终一致的，所以这是「尽力而为」的软限流 —— 分布式攻击可能短暂超出。
 * 真正抗量的是 Cloudflare 边缘的 Rate Limiting 规则；这一层负责挡住
 * 「单机脚本反复猜密码」这类最常见的情形。
 */
async function checkRateLimit(env, scope, ip, maxFails) {
  const raw = await env.LOVE_DATA.get(rateLimitKey(scope, ip));
  if (!raw) return { limited: false, retryAfter: 0 };

  let rec = null;
  try { rec = JSON.parse(raw); } catch (err) { rec = null; }
  if (!rec || typeof rec.fails !== 'number' || typeof rec.resetAt !== 'number') {
    return { limited: false, retryAfter: 0 };
  }

  const now = Date.now();
  if (now >= rec.resetAt) return { limited: false, retryAfter: 0 };
  if (rec.fails < maxFails) return { limited: false, retryAfter: 0 };

  return { limited: true, retryAfter: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) };
}

/** 记一次失败；窗口内首次失败时开启新窗口 */
async function recordFailure(env, scope, ip, windowSeconds) {
  const key = rateLimitKey(scope, ip);
  const now = Date.now();

  let rec = null;
  try { rec = JSON.parse((await env.LOVE_DATA.get(key)) || 'null'); } catch (err) { rec = null; }
  if (!rec || typeof rec.resetAt !== 'number' || now >= rec.resetAt) {
    rec = { fails: 0, resetAt: now + windowSeconds * 1000 };
  }
  rec.fails += 1;

  const ttl = Math.max(60, Math.ceil((rec.resetAt - now) / 1000) + 60);
  await env.LOVE_DATA.put(key, JSON.stringify(rec), { expirationTtl: ttl });
  return rec;
}

/** 认证成功后清零失败计数，避免正常用户被自己的手误锁住 */
async function clearRateLimit(env, scope, ip) {
  try { await env.LOVE_DATA.delete(rateLimitKey(scope, ip)); } catch (err) { /* 尽力而为 */ }
}

/* ------------------------------------------------------------------ 密码世代（token 吊销） */

/** 当前密码世代。从未轮换过时用 '1'，保证与 v1 时期签发的 token 不匹配。 */
async function readEpoch(env) {
  const v = await env.LOVE_DATA.get(KV_KEY_EPOCH);
  return v || '1';
}

/**
 * 轮换世代 —— 一次性让所有已签发 token 失效。
 * 用「随机值」而不是「自增」：KV 没有原子自增，读-改-写会有竞态；
 * 随机值只需一次 put，天然无竞态（并发轮换也各是一个合法的新世代）。
 */
async function rotateEpoch(env) {
  const next = randomToken();
  await env.LOVE_DATA.put(KV_KEY_EPOCH, next);
  return next;
}

/**
 * 顺手清掉旧的 token 记录（KV 卫生）。
 * 注意：吊销的**权威依据**是 epoch 比对，不是这里的删除 ——
 * KV list 是最终一致的，靠它做安全判定不可靠。删失败也不影响安全性。
 */
async function purgeTokens(env) {
  try {
    let cursor = undefined;
    for (let i = 0; i < 10; i++) {
      const res = await env.LOVE_DATA.list({ prefix: KV_TOKEN_PREFIX, cursor: cursor });
      const keys = (res && res.keys) || [];
      for (const k of keys) {
        try { await env.LOVE_DATA.delete(k.name); } catch (err) { /* ignore */ }
      }
      if (!res || res.list_complete !== false) break;
      cursor = res.cursor;
    }
  } catch (err) {
    console.warn('[love] 清理旧 token 失败（不影响吊销，epoch 已轮换）');
  }
}

/* ------------------------------------------------------------------ 数据校验 */

/** 判断某一年某月某日是否真实存在（拒绝 2-30、4-31 这类） */
function isRealDate(year, month, day) {
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/**
 * 校验并归一化一条纪念日。
 * @returns {{ ok: true, value: object } | { ok: false, field: string, message: string }}
 */
function validateItem(raw, existing) {
  const src = raw && typeof raw === 'object' ? raw : {};

  /* ---- name ---- */
  const name = String(src.name === undefined || src.name === null ? '' : src.name).trim();
  if (!name) return { ok: false, field: 'name', message: '名称不能为空' };
  if ([...name].length > LIMITS.name) {
    return { ok: false, field: 'name', message: '名称不能超过 ' + LIMITS.name + ' 个字' };
  }

  /* ---- date ---- */
  const date = String(src.date === undefined || src.date === null ? '' : src.date).trim();
  let recurring;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // 完整日期：年份必须真实存在
    const y = Number(date.slice(0, 4));
    const mo = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    if (mo < 1 || mo > 12) return { ok: false, field: 'date', message: '月份必须在 1–12 之间' };
    if (d < 1 || d > 31) return { ok: false, field: 'date', message: '日期必须在 1–31 之间' };
    if (!isRealDate(y, mo, d)) return { ok: false, field: 'date', message: '该日期不存在（请检查是否为闰年或月份天数）' };
    if (y < 1900 || y > 2200) return { ok: false, field: 'date', message: '年份需在 1900–2200 之间' };
    // 带年份 + 默认 recurring=true → 表示「每年这一天」，年份只作锚点
    recurring = src.recurring === undefined ? true : !!src.recurring;
  } else if (/^\d{2}-\d{2}$/.test(date)) {
    const mo = Number(date.slice(0, 2));
    const d = Number(date.slice(3, 5));
    if (mo < 1 || mo > 12) return { ok: false, field: 'date', message: '月份必须在 1–12 之间' };
    if (d < 1 || d > 31) return { ok: false, field: 'date', message: '日期必须在 1–31 之间' };
    // 用闰年 2000 做存在性校验，让 02-29 合法
    if (!isRealDate(2000, mo, d)) return { ok: false, field: 'date', message: '该日期不存在' };
    recurring = true; // 只写月日 → 必然是每年重复
  } else {
    return { ok: false, field: 'date', message: '日期格式须为 YYYY-MM-DD 或 MM-DD' };
  }

  /* ---- type ---- */
  let type = String(src.type === undefined || src.type === null ? '' : src.type).trim();
  if (!type) type = 'other';
  if (TYPES.indexOf(type) === -1) {
    return { ok: false, field: 'type', message: '类型不合法' };
  }

  /* ---- note ---- */
  const note = String(src.note === undefined || src.note === null ? '' : src.note).trim();
  if ([...note].length > LIMITS.note) {
    return { ok: false, field: 'note', message: '备注不能超过 ' + LIMITS.note + ' 个字' };
  }

  /* ---- icon ---- */
  let icon = String(src.icon === undefined || src.icon === null ? '' : src.icon).trim();
  if (!icon) icon = '🎂';
  if (icon.length > LIMITS.icon) icon = [...icon][0] || '🎂';

  /* ---- visible ---- */
  const visible = src.visible === undefined ? true : !!src.visible;

  const now = new Date().toISOString();
  const item = {
    id: (existing && existing.id) || newId(),
    name: name,
    date: date,
    type: type,
    note: note,
    icon: icon,
    recurring: recurring,
    visible: visible,
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now
  };

  return { ok: true, value: item };
}

/** 排序：先按「下一次出现的自然日」升序，同日按名称 */
function sortItems(list) {
  return list.slice().sort(function (a, b) {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka.month !== kb.month) return ka.month - kb.month;
    if (ka.day !== kb.day) return ka.day - kb.day;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

function sortKey(item) {
  const d = item.date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return { month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)) };
  return { month: Number(d.slice(0, 2)), day: Number(d.slice(3, 5)) };
}

/* ------------------------------------------------------------------ KV 读写 */

async function readAll(env) {
  const raw = await env.LOVE_DATA.get(KV_KEY_DATA);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // 数据被写坏时不让整站挂掉，返回空数组并留一条日志
    console.error('[love] anniversaries KV 数据解析失败：', err);
    return [];
  }
}

async function writeAll(env, list) {
  await env.LOVE_DATA.put(KV_KEY_DATA, JSON.stringify(list));
  return list;
}

/* ------------------------------------------------------------------ 鉴权 */

/**
 * 校验请求的 token。
 * 两道关卡：
 *   ① token 必须存在于 KV（且未过 TTL）；
 *   ② token 记录里的「密码世代」必须等于当前世代 —— 改密码后 epoch 轮换，
 *      所有旧 token 立刻失效，无需依赖 KV list 的最终一致性。
 * @returns {Promise<{ authed: boolean, token: string }>}
 */
async function checkAuth(request, env) {
  const token = readBearer(request);
  if (!token) return { authed: false, token: '' };

  // token 值本身当 key，KV 直接命中即可，不需要再比一次
  const hit = await env.LOVE_DATA.get(KV_TOKEN_PREFIX + token);
  if (!hit) return { authed: false, token: token };

  const epoch = await readEpoch(env);
  if (String(hit) !== String(epoch)) return { authed: false, token: token };

  return { authed: true, token: token };
}

/* ------------------------------------------------------------------ 路由处理 */

/** GET /api/anniversaries —— 前台公开接口，只吐可见项 */
async function handlePublicList(env) {
  const list = await readAll(env);
  const visible = sortItems(list.filter(function (it) { return it.visible !== false; }));
  // 前台只需要展示字段，id/createdAt 之类不外抛
  const payload = visible.map(function (it) {
    return {
      name: it.name,
      date: it.date,
      type: it.type,
      note: it.note,
      icon: it.icon,
      recurring: it.recurring !== false
    };
  });
  return ok(payload);
}

/** POST /api/login */
async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return fail('BAD_REQUEST', '请求体必须是合法 JSON', 400);
  }

  const ip = clientIp(request);
  const maxFails = envInt(env, 'RATE_LIMIT_MAX_FAILS', RATE_LIMIT_DEFAULT_MAX, 1, 100);
  const windowSec = envInt(env, 'RATE_LIMIT_WINDOW_SECONDS', RATE_LIMIT_DEFAULT_WINDOW, 30, 86400);

  const limited = await checkRateLimit(env, 'login', ip, maxFails);
  if (limited.limited) {
    return fail('RATE_LIMITED',
      '登录尝试过于频繁，请 ' + limited.retryAfter + ' 秒后再试',
      429, null, { 'retry-after': String(limited.retryAfter) });
  }

  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!password) return fail('EMPTY_PASSWORD', '请输入管理员密码', 400);
  if (password.length > 200) {
    // 超长输入只会在哈希阶段白烧 CPU，直接挡掉
    await recordFailure(env, 'login', ip, windowSec);
    return fail('BAD_CREDENTIALS', '密码错误，请重新输入', 401);
  }

  const stored = await env.LOVE_DATA.get(KV_KEY_PASSWORD);
  if (!stored) {
    return fail('NOT_INITIALIZED', '管理员密码尚未初始化，请先运行 scripts/init-admin.mjs', 503);
  }

  const verified = await verifyPassword(stored, password);
  if (!verified.ok) {
    // 统一文案，不区分「密码错」和「账号不存在」
    await recordFailure(env, 'login', ip, windowSec);
    return fail('BAD_CREDENTIALS', '密码错误，请重新输入', 401);
  }

  // v1（单轮 SHA-256）记录 → 趁这次明文在手，静默升级成 v2（PBKDF2）
  if (verified.legacy) {
    try {
      await env.LOVE_DATA.put(KV_KEY_PASSWORD, await hashPassword(password, resolveIterations(env)));
    } catch (err) {
      console.warn('[love] 密码哈希升级失败，不影响本次登录');
    }
  }

  const epoch = await readEpoch(env);
  const token = randomToken();
  await env.LOVE_DATA.put(KV_TOKEN_PREFIX + token, epoch, {
    expirationTtl: TOKEN_TTL_SECONDS
  });

  await clearRateLimit(env, 'login', ip);

  return ok({
    token: token,
    expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString()
  });
}

/** POST /api/logout */
async function handleLogout(request, env, auth) {
  if (auth.token) await env.LOVE_DATA.delete(KV_TOKEN_PREFIX + auth.token);
  return ok({ loggedOut: true });
}

/**
 * POST /api/admin/password —— 修改管理员密码（需鉴权）
 *
 * 流程：
 *   ① 失败限流检查（防用偷来的 token 暴力猜原密码）
 *   ② 字段存在性 → 新密码强度 → 防抖冷却
 *   ③ 校验原密码（恒定时间比较；错误只回「原密码不正确」）
 *   ④ 新密码不得与原密码相同
 *   ⑤ 写入新哈希 → 记录修改时间 → 轮换 epoch（吊销全部会话）→ 清理旧 token
 *
 * 关于「是否强制重新登录」：强制。改密码是凭据变更事件，保留旧会话意味着
 * 一个已被窃取的 token 仍能继续操作，这与改密码的初衷相悖。
 */
async function handleChangePassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return fail('BAD_REQUEST', '请求体必须是合法 JSON', 400);
  }

  const ip = clientIp(request);
  const maxFails = envInt(env, 'RATE_LIMIT_MAX_FAILS', RATE_LIMIT_DEFAULT_MAX, 1, 100);
  const windowSec = envInt(env, 'RATE_LIMIT_WINDOW_SECONDS', RATE_LIMIT_DEFAULT_WINDOW, 30, 86400);
  const cooldown = envInt(env, 'PWD_CHANGE_COOLDOWN_SECONDS', PWD_CHANGE_COOLDOWN_DEFAULT, 0, 3600);

  /* ---- ① 限流：独立 scope，避免与登录互相影响 ---- */
  const limited = await checkRateLimit(env, 'pwd', ip, maxFails);
  if (limited.limited) {
    return fail('RATE_LIMITED',
      '尝试过于频繁，请 ' + limited.retryAfter + ' 秒后再试',
      429, null, { 'retry-after': String(limited.retryAfter) });
  }

  const oldPassword = body && typeof body.oldPassword === 'string' ? body.oldPassword : '';
  const newPassword = body && typeof body.newPassword === 'string' ? body.newPassword : '';

  /* ---- ② 字段校验 ---- */
  if (!oldPassword) return fail('VALIDATION_ERROR', '请输入当前密码', 422, 'oldPassword');
  if (oldPassword.length > 200) return fail('VALIDATION_ERROR', '当前密码不正确', 422, 'oldPassword');
  if (!newPassword) return fail('VALIDATION_ERROR', '请输入新密码', 422, 'newPassword');

  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) return fail('VALIDATION_ERROR', strength.message, 422, 'newPassword');

  /* ---- ②b 防抖冷却：防止脚本化高频改密 ---- */
  const changedRaw = await env.LOVE_DATA.get(KV_KEY_PWD_CHANGED);
  if (changedRaw && cooldown > 0) {
    const elapsed = (Date.now() - new Date(changedRaw).getTime()) / 1000;
    if (isFinite(elapsed) && elapsed >= 0 && elapsed < cooldown) {
      const wait = Math.ceil(cooldown - elapsed);
      return fail('TOO_SOON',
        '刚刚修改过密码，请 ' + wait + ' 秒后再试',
        429, null, { 'retry-after': String(wait) });
    }
  }

  /* ---- ③ 校验原密码 ---- */
  const stored = await env.LOVE_DATA.get(KV_KEY_PASSWORD);
  if (!stored) {
    return fail('NOT_INITIALIZED', '管理员密码尚未初始化，请先运行 scripts/init-admin.mjs', 503);
  }

  const verified = await verifyPassword(stored, oldPassword);
  if (!verified.ok) {
    await recordFailure(env, 'pwd', ip, windowSec);
    return fail('BAD_OLD_PASSWORD', '当前密码不正确', 403, 'oldPassword');
  }

  /* ---- ④ 新旧不能相同 ---- */
  if (newPassword === oldPassword) {
    return fail('SAME_AS_OLD', '新密码不能与当前密码相同', 422, 'newPassword');
  }

  /* ---- ⑤ 落库 + 全局吊销 ---- */
  const nowIso = new Date().toISOString();
  await env.LOVE_DATA.put(KV_KEY_PASSWORD, await hashPassword(newPassword, resolveIterations(env)));
  await env.LOVE_DATA.put(KV_KEY_PWD_CHANGED, nowIso);
  await rotateEpoch(env);      // 权威吊销手段：所有旧 token 立刻失效
  await purgeTokens(env);      // 卫生：顺手清掉 KV 里的旧 token 记录
  await clearRateLimit(env, 'pwd', ip);

  return ok({ changedAt: nowIso, reauthRequired: true });
}

/** GET /api/admin/anniversaries —— 全量（含隐藏） */
async function handleAdminList(env) {
  const list = await readAll(env);
  return ok(sortItems(list));
}

/** POST /api/admin/anniversaries */
async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return fail('BAD_REQUEST', '请求体必须是合法 JSON', 400);
  }

  const v = validateItem(body, null);
  if (!v.ok) return fail('VALIDATION_ERROR', v.message, 422, v.field);

  const list = await readAll(env);
  list.push(v.value);
  await writeAll(env, list);
  return ok(v.value, { 'x-love-op': 'create' });
}

/** PUT /api/admin/anniversaries/:id */
async function handleUpdate(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return fail('BAD_REQUEST', '请求体必须是合法 JSON', 400);
  }

  const list = await readAll(env);
  const idx = list.findIndex(function (it) { return it.id === id; });
  if (idx === -1) return fail('NOT_FOUND', '找不到该纪念日，可能已被删除', 404);

  const v = validateItem(body, list[idx]);
  if (!v.ok) return fail('VALIDATION_ERROR', v.message, 422, v.field);

  list[idx] = v.value;
  await writeAll(env, list);
  return ok(v.value, { 'x-love-op': 'update' });
}

/** DELETE /api/admin/anniversaries/:id */
async function handleDelete(env, id) {
  const list = await readAll(env);
  const idx = list.findIndex(function (it) { return it.id === id; });
  if (idx === -1) return fail('NOT_FOUND', '找不到该纪念日，可能已被删除', 404);

  const removed = list.splice(idx, 1)[0];
  await writeAll(env, list);
  return ok({ id: removed.id, name: removed.name }, { 'x-love-op': 'delete' });
}

/* ------------------------------------------------------------------ 主入口 */

export default {
  /**
   * @param {Request} request
   * @param {{ LOVE_DATA: KVNamespace, ASSETS: Fetcher }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    /* ---- 跨域预检（同源下不会触发，但显式处理更稳）---- */
    if (method === 'OPTIONS' && path.indexOf('/api/') === 0) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': 'same-origin',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '86400'
        }
      });
    }

    /* ---- API 分流 ---- */
    if (path.indexOf('/api/') === 0) {
      try {
        return harden(await routeApi(request, env, path, method));
      } catch (err) {
        console.error('[love] API 未捕获异常：', err && err.stack ? err.stack : err);
        return harden(fail('INTERNAL_ERROR', '服务器内部错误，请稍后重试', 500));
      }
    }

    /* ---- 其余交给静态资源 ---- */
    const assetResponse = await env.ASSETS.fetch(request);

    /* Pages 静态资源找不到时返回 404，这里把 admin 的前端路由兜底到 index.html */
    if (assetResponse.status === 404 && (path === '/admin' || path === '/admin/')) {
      const fallback = await env.ASSETS.fetch(new Request(new URL('/admin/index.html', url).toString(), request));
      return harden(fallback);
    }

    return harden(assetResponse);
  }
};

/** API 路由表 —— 与上面的 fetch 分离，便于阅读与测试 */
async function routeApi(request, env, path, method) {
  /* ---------- 公开接口 ---------- */
  if (path === '/api/anniversaries' && method === 'GET') {
    return handlePublicList(env);
  }
  if (path === '/api/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  /* ---------- 以下都需要鉴权 ---------- */
  const auth = await checkAuth(request, env);

  if (path === '/api/logout' && method === 'POST') {
    return handleLogout(request, env, auth);
  }

  /* 改密码：必须已登录。限流/校验都在 handler 内部完成 */
  if (path === '/api/admin/password' && method === 'POST') {
    if (!auth.authed) return fail('UNAUTHORIZED', '登录已过期，请重新登录', 401);
    return handleChangePassword(request, env);
  }

  if (path === '/api/admin/anniversaries') {
    if (!auth.authed) return fail('UNAUTHORIZED', '登录已过期，请重新登录', 401);
    if (method === 'GET') return handleAdminList(env);
    if (method === 'POST') return handleCreate(request, env);
    return fail('METHOD_NOT_ALLOWED', '不支持的方法', 405);
  }

  const m = path.match(/^\/api\/admin\/anniversaries\/([A-Za-z0-9_-]+)$/);
  if (m) {
    if (!auth.authed) return fail('UNAUTHORIZED', '登录已过期，请重新登录', 401);
    const id = m[1];
    if (method === 'PUT' || method === 'PATCH') return handleUpdate(request, env, id);
    if (method === 'DELETE') return handleDelete(env, id);
    return fail('METHOD_NOT_ALLOWED', '不支持的方法', 405);
  }

  return fail('NOT_FOUND', '接口不存在', 404);
}
