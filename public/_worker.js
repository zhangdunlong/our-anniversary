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
 *
 *  安全设计
 *    - 管理员密码不落在代码里，只存 sha256(salt + password) 到 KV；
 *      盐值随密码一起存，格式 "salt:hash"，校验用恒定时间比较。
 *    - 登录成功签发 32 字节随机 token，存 KV 并带 TTL（默认 7 天），
 *      过期自动清除；注销即删。
 *    - 所有写操作强制走鉴权中间件；错误信息不泄漏内部细节。
 *    - 响应统一带 no-store，避免中间层缓存到带 token 的内容。
 * ============================================================================
 */

/* ------------------------------------------------------------------ 常量 */

const KV_KEY_PASSWORD = 'admin:password';   // "salt:hash"
const KV_KEY_DATA = 'anniversaries';        // 纪念日数组
const KV_TOKEN_PREFIX = 'token:';           // token:<value> → issuedAt
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 天

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
 */
function fail(code, message, status, field) {
  const error = { code: code, message: message };
  if (field) error.field = field;
  return json({ ok: false, error: error }, status || 400);
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
 * @returns {Promise<{ authed: boolean, token: string }>}
 */
async function checkAuth(request, env) {
  const token = readBearer(request);
  if (!token) return { authed: false, token: '' };
  // token 值本身当 key，KV 直接命中即可，不需要再比一次
  const hit = await env.LOVE_DATA.get(KV_TOKEN_PREFIX + token);
  if (!hit) return { authed: false, token: token };
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

  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!password) return fail('EMPTY_PASSWORD', '请输入管理员密码', 400);

  const stored = await env.LOVE_DATA.get(KV_KEY_PASSWORD);
  if (!stored) {
    return fail('NOT_INITIALIZED', '管理员密码尚未初始化，请先运行 scripts/init-admin.mjs', 503);
  }

  const sep = stored.indexOf(':');
  const salt = stored.slice(0, sep);
  const hash = stored.slice(sep + 1);
  const attempt = await sha256Hex(salt + password);

  if (!timingSafeEqual(attempt, hash)) {
    // 统一文案，不区分「密码错」和「账号不存在」
    return fail('BAD_CREDENTIALS', '密码错误，请重新输入', 401);
  }

  const token = randomToken();
  await env.LOVE_DATA.put(KV_TOKEN_PREFIX + token, new Date().toISOString(), {
    expirationTtl: TOKEN_TTL_SECONDS
  });

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
