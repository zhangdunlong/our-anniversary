/**
 * ============================================================================
 *  admin.js —— 纪念日管理后台
 * ============================================================================
 *
 *  架构：单文件、无依赖、原生 ES Module。
 *  两个视图（登录 / 管理）通过切换 hidden 属性实现，不做路由跳转，
 *  避免整页刷新丢失状态，也避免额外一次 HTML 请求。
 *
 *  关注点分离：
 *    · api()      —— 唯一与后端通信的出口，统一注入 token、统一处理 401
 *    · state      —— 单一状态对象，任何变更都走 render()
 *    · render()   —— 纯渲染，只读 state，不发请求
 *    · 校验        —— 前端即时反馈（体验），后端最终把关（安全），两边同一套规则
 *
 *  安全说明：
 *    token 存 localStorage。后台页面本身已被 robots 与 _headers 双重禁止索引，
 *    且 API 侧所有写操作都要求有效 token，前端存储仅作为「免重复登录」的便利。
 * ============================================================================
 */

/* ==========================================================================
   常量
   ========================================================================== */

const API = {
  list: '/api/anniversaries',
  login: '/api/login',
  logout: '/api/logout',
  admin: '/api/admin/anniversaries',
  password: '/api/admin/password'
};

const TOKEN_KEY = 'love-admin-token';

/** 与后端 validateItem 保持同一套规则 —— 改规则时两边都要动 */
const LIMITS = { name: 30, note: 100 };

/** 与后端 validatePasswordStrength 保持同一套规则 —— 改规则时两边都要动 */
const PWD_MIN = 8;
const PWD_MAX = 64;

/** 强度条文案（索引 = scorePassword 的返回值） */
const STRENGTH_LABEL = {
  0: '至少 8 位，需包含大写字母、小写字母、数字、符号中的至少两类',
  1: '强度：弱 —— 至少 8 位，并混用多种字符',
  2: '强度：一般 —— 再长一些会更安全',
  3: '强度：较强',
  4: '强度：强'
};

const TYPE_LABEL = {
  birthday: '生日',
  love: '恋爱纪念日',
  festival: '节日',
  memorial: '纪念日',
  other: '其它'
};

const TYPE_ICON = {
  birthday: '🎂',
  love: '❤️',
  festival: '🎉',
  memorial: '📌',
  other: '✨'
};

/* ==========================================================================
   DOM 快捷方式
   ========================================================================== */

const $ = function (sel, root) { return (root || document).querySelector(sel); };
const $$ = function (sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
};

/** 建元素：el('div', { class: 'x' }, [child, 'text']) */
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'class') node.className = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
  }
  if (children) {
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number'
        ? document.createTextNode(String(c)) : c);
    });
  }
  return node;
}

/* ==========================================================================
   状态
   ========================================================================== */

const state = {
  token: '',
  items: [],            // 全量数据（含隐藏）
  keyword: '',
  sort: 'date',
  filter: 'all',
  editing: null,        // 正在编辑的条目 id；null 表示新增
  deleting: null,       // 待删除的条目
  loading: false
};

/* ==========================================================================
   提示条
   ========================================================================== */

const toastHost = $('#toast-host');

function toast(message, kind) {
  const icons = { success: '✅', error: '⚠️', info: 'ℹ️' };
  const node = el('div', { class: 'toast toast--' + (kind || 'info') }, [
    el('span', { 'aria-hidden': 'true', text: icons[kind] || icons.info }),
    el('span', { text: message })
  ]);
  toastHost.appendChild(node);

  // 3.2 秒后淡出移除；提前退出时也要清理定时器，避免残留节点
  const timer = window.setTimeout(function () {
    node.classList.add('is-out');
    node.addEventListener('animationend', function () { node.remove(); }, { once: true });
    // 兜底：动画被 prefers-reduced-motion 关掉时 animationend 可能不触发
    window.setTimeout(function () { if (node.parentNode) node.remove(); }, 400);
  }, 3200);

  node.addEventListener('click', function () {
    window.clearTimeout(timer);
    node.remove();
  });
}

/* ==========================================================================
   API 层
   ========================================================================== */

/**
 * 统一请求出口。
 * @param {string} path
 * @param {{ method?: string, body?: any, auth?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, data?: any, error?: { code, message, field? }, status: number }>}
 */
async function api(path, opts) {
  const o = opts || {};
  const headers = { 'accept': 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.auth !== false && state.token) headers['authorization'] = 'Bearer ' + state.token;

  let res;
  try {
    res = await fetch(path, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      cache: 'no-store'
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: { code: 'NETWORK_ERROR', message: '网络连接失败，请检查网络后重试' }
    };
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (err) { payload = null; }
  }

  // 401 → 清掉失效 token 并回到登录视图（只在已登录时提示，避免打扰）
  if (res.status === 401) {
    if (state.token) {
      clearToken();
      showLogin();
      toast(payload && payload.error ? payload.error.message : '登录已过期，请重新登录', 'error');
    }
    return {
      ok: false,
      status: 401,
      error: (payload && payload.error) || { code: 'UNAUTHORIZED', message: '登录已过期' }
    };
  }

  if (!payload) {
    return {
      ok: false,
      status: res.status,
      error: { code: 'BAD_RESPONSE', message: '服务器返回异常（HTTP ' + res.status + '）' }
    };
  }

  return {
    ok: !!payload.ok,
    status: res.status,
    data: payload.data,
    error: payload.error
  };
}

/* ==========================================================================
   校验（与后端对齐）
   ========================================================================== */

function isRealDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * @returns {{ ok: boolean, errors: Record<string,string>, value?: object }}
 */
function validateForm() {
  const errors = {};

  const name = $('#edit-name').value.trim();
  if (!name) errors.name = '名称不能为空';
  else if ([...name].length > LIMITS.name) errors.name = '名称不能超过 ' + LIMITS.name + ' 个字';

  const date = $('#edit-date').value.trim();
  if (!date) {
    errors.date = '日期不能为空';
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    if (m < 1 || m > 12) errors.date = '月份必须在 1–12 之间';
    else if (d < 1 || d > 31) errors.date = '日期必须在 1–31 之间';
    else if (!isRealDate(y, m, d)) errors.date = '该日期不存在，请检查月份天数或闰年';
    else if (y < 1900 || y > 2200) errors.date = '年份需在 1900–2200 之间';
  } else if (/^\d{2}-\d{2}$/.test(date)) {
    const m = Number(date.slice(0, 2));
    const d = Number(date.slice(3, 5));
    if (m < 1 || m > 12) errors.date = '月份必须在 1–12 之间';
    else if (d < 1 || d > 31) errors.date = '日期必须在 1–31 之间';
    else if (!isRealDate(2000, m, d)) errors.date = '该日期不存在（已按闰年校验，2-29 合法）';
  } else {
    errors.date = '格式须为 YYYY-MM-DD 或 MM-DD';
  }

  const note = $('#edit-note').value.trim();
  if ([...note].length > LIMITS.note) errors.note = '备注不能超过 ' + LIMITS.note + ' 个字';

  const ok = Object.keys(errors).length === 0;
  const value = ok ? {
    name: name,
    date: date,
    type: $('#edit-type').value,
    note: note,
    icon: $('#edit-icon').value.trim() || TYPE_ICON[$('#edit-type').value] || '🎂',
    visible: $('#edit-visible').checked,
    // MM-DD 必然是每年重复；完整日期时尊重用户勾选
    recurring: /^\d{2}-\d{2}$/.test(date) ? true : $('#edit-recurring').checked
  } : null;

  return { ok: ok, errors: errors, value: value };
}

/** 把错误写到对应字段下方 */
function paintErrors(errors) {
  ['name', 'date', 'note'].forEach(function (f) {
    const box = $('#err-' + f);
    const input = $('#edit-' + f);
    if (box) box.textContent = errors[f] || '';
    if (input) {
      if (errors[f]) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  });
}

/** 焦点落到第一个出错的字段，方便键盘/移动端继续修 */
function focusFirstError(errors) {
  const order = ['name', 'date', 'note'];
  for (let i = 0; i < order.length; i++) {
    if (errors[order[i]]) {
      const input = $('#edit-' + order[i]);
      if (input) { input.focus(); input.select && input.select(); }
      return;
    }
  }
}

/* ==========================================================================
   密码强度与改密码校验
   ========================================================================== */

/** 改密码表单的三个字段（DOM id 后缀 / state key 共用） */
const PWD_FIELDS = ['old', 'new', 'confirm'];

/** 统计密码包含的字符类别数（小写/大写/数字/符号） */
function countKinds(pwd) {
  let kinds = 0;
  if (/[a-z]/.test(pwd)) kinds++;
  if (/[A-Z]/.test(pwd)) kinds++;
  if (/[0-9]/.test(pwd)) kinds++;
  if (/[^A-Za-z0-9]/.test(pwd)) kinds++;
  return kinds;
}

/**
 * 一眼就能猜到的规律片段：连号、键盘序、重复字符。
 * 命中不阻止提交（准入规则由 validatePasswordForm 决定），只是把强度分压低，
 * 避免 "Abcd1234" 这种被标成「强」——评分虚高比不给分更糟。
 */
const OBVIOUS_PATTERN = /(0123|1234|2345|3456|4567|5678|6789|7890|abcd|bcde|cdef|qwer|asdf|zxcv|0000|1111|2222|123456|654321)/i;

/**
 * 给密码打 0–4 分，**只用于画强度条**（体验），不参与准入判定。
 * 准入由 validatePasswordForm / 后端 validatePasswordStrength 决定。
 *
 * 分级语义：
 *   0 = 还没输入（不点亮任何一格，也不显示「弱」以免误导）
 *   1 = 已经输入但不达标或很弱
 *   2~4 = 依次更强
 */
function scorePassword(pwd) {
  if (!pwd) return 0;

  const len = [...pwd].length;
  const kinds = countKinds(pwd);

  let score = 0;
  if (len >= PWD_MIN) score++;
  if (len >= 12) score++;
  if (kinds >= 2) score++;
  if (kinds >= 3) score++;

  // 有规律 → 最多「一般」，再多字符类别也不该显示成强
  if (OBVIOUS_PATTERN.test(pwd)) score = Math.min(score, 2);

  // 只要输入了内容就至少点亮 1 格 —— 用户敲了密码却毫无反馈是最糟的体验
  return Math.max(1, Math.min(4, score));
}

/**
 * 改密码表单校验。
 * 只产出 oldPassword / newPassword —— 「确认新密码」纯粹是防输错的前端护具，
 * 不需要也不应该发给后端（后端收到两份同样的值没有意义，反而多一个可被绕过的字段）。
 * @returns {{ ok: boolean, errors: Record<string,string>, value?: object }}
 */
function validatePasswordForm() {
  const errors = {};
  const oldPassword = $('#pwd-old').value;
  const newPassword = $('#pwd-new').value;
  const confirm = $('#pwd-confirm').value;

  if (!oldPassword) errors.old = '请输入当前密码';

  if (!newPassword) {
    errors.new = '请输入新密码';
  } else {
    const len = [...newPassword].length;
    if (len < PWD_MIN) errors.new = '新密码至少 ' + PWD_MIN + ' 位';
    else if (len > PWD_MAX) errors.new = '新密码不能超过 ' + PWD_MAX + ' 位';
    else if (/^\s|\s$/.test(newPassword)) errors.new = '新密码的首尾不能是空格';
    else if (countKinds(newPassword) < 2) {
      errors.new = '新密码需包含大写字母、小写字母、数字、符号中的至少两类';
    }
  }

  if (!confirm) errors.confirm = '请再输入一次新密码';
  else if (confirm !== newPassword) errors.confirm = '两次输入的新密码不一致';

  // 新旧相同：优先级排在「格式不合法」之后，避免两条错误同时糊在屏幕上
  if (!errors.old && !errors.new && newPassword === oldPassword) {
    errors.new = '新密码不能与当前密码相同';
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok: ok,
    errors: errors,
    value: ok ? { oldPassword: oldPassword, newPassword: newPassword } : null
  };
}

/** 把错误写到对应字段下方；同时切换 aria-invalid 供样式与读屏使用 */
function paintPwdErrors(errors) {
  PWD_FIELDS.forEach(function (f) {
    const box = $('#err-pwd-' + f);
    const input = $('#pwd-' + f);
    if (box) box.textContent = errors[f] || '';
    if (input) {
      if (errors[f]) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  });
}

function focusFirstPwdError(errors) {
  for (let i = 0; i < PWD_FIELDS.length; i++) {
    const f = PWD_FIELDS[i];
    if (!errors[f]) continue;
    const input = $('#pwd-' + f);
    if (input) { input.focus(); if (input.select) input.select(); }
    return;
  }
}

/** 刷新强度条与文案 */
function updatePwdMeter() {
  const level = scorePassword($('#pwd-new').value);
  $('#pwd-meter').setAttribute('data-level', String(level));
  const text = $('#pwd-strength');
  text.textContent = STRENGTH_LABEL[level] || STRENGTH_LABEL[0];
  text.className = 'field-hint' + (level > 0 ? ' pw-strength-' + level : '');
}

/* ==========================================================================
   天数计算（与前台同一套语义，保证显示一致）
   ========================================================================== */

function todayMidnight() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/**
 * 计算某条纪念日的「距今天数」。
 * 返回值：
 *   { isToday: true }                      今天
 *   { days: 12, future: true }             还有 12 天
 *   { days: 30, future: false, passed:true } 已过去 30 天（仅非重复条目）
 */
function computeDays(item) {
  const today = todayMidnight();
  const d = item.date;

  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(5, 7));
    const day = Number(d.slice(8, 10));
    const thisYear = new Date(today.getFullYear(), m - 1, day);

    if (item.recurring === false) {
      // 一次性事件：直接算绝对差
      const target = new Date(y, m - 1, day);
      const diff = Math.round((target - today) / 86400000);
      if (diff === 0) return { isToday: true };
      return diff > 0
        ? { days: diff, future: true }
        : { days: -diff, future: false, passed: true };
    }

    // 每年重复：今年没到用今年，过了用明年（2-29 在非闰年顺延到 3-1）
    let occ = thisYear;
    if (occ.getMonth() !== m - 1) occ = new Date(today.getFullYear(), m - 1, day + 1);
    if (occ < today) {
      occ = new Date(today.getFullYear() + 1, m - 1, day);
      if (occ.getMonth() !== m - 1) occ = new Date(today.getFullYear() + 1, m - 1, day + 1);
    }
    const diff = Math.round((occ - today) / 86400000);
    return diff === 0 ? { isToday: true } : { days: diff, future: true };
  }

  // MM-DD：每年重复
  const m = Number(d.slice(0, 2));
  const day = Number(d.slice(3, 5));
  let occ = new Date(today.getFullYear(), m - 1, day);
  if (occ.getMonth() !== m - 1) occ = new Date(today.getFullYear(), m - 1, day + 1);
  if (occ < today) {
    occ = new Date(today.getFullYear() + 1, m - 1, day);
    if (occ.getMonth() !== m - 1) occ = new Date(today.getFullYear() + 1, m - 1, day + 1);
  }
  const diff = Math.round((occ - today) / 86400000);
  return diff === 0 ? { isToday: true } : { days: diff, future: true };
}

/** 排序用的月日键 */
function monthDay(item) {
  const d = item.date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return { m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) };
  return { m: Number(d.slice(0, 2)), d: Number(d.slice(3, 5)) };
}

/* ==========================================================================
   过滤 + 排序
   ========================================================================== */

function visibleItems() {
  let list = state.items.slice();

  if (state.filter === 'visible') list = list.filter(function (it) { return it.visible !== false; });
  else if (state.filter === 'hidden') list = list.filter(function (it) { return it.visible === false; });

  const kw = state.keyword.trim().toLowerCase();
  if (kw) {
    list = list.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(kw) > -1 ||
             (it.note || '').toLowerCase().indexOf(kw) > -1 ||
             (it.date || '').indexOf(kw) > -1 ||
             (TYPE_LABEL[it.type] || '').indexOf(kw) > -1;
    });
  }

  if (state.sort === 'name') {
    list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); });
  } else if (state.sort === 'created') {
    list.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
  } else {
    // 按日期（月日）排序：已过去的非重复条目沉底
    list.sort(function (a, b) {
      const ia = computeDays(a);
      const ib = computeDays(b);
      const pa = ia.passed ? 1 : 0;
      const pb = ib.passed ? 1 : 0;
      if (pa !== pb) return pa - pb;
      const ka = monthDay(a);
      const kb = monthDay(b);
      if (ka.m !== kb.m) return ka.m - kb.m;
      if (ka.d !== kb.d) return ka.d - kb.d;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
  }

  return list;
}

/* ==========================================================================
   渲染
   ========================================================================== */

const listBox = $('#list');

function render() {
  // 统计
  const total = state.items.length;
  const visCount = state.items.filter(function (it) { return it.visible !== false; }).length;
  $('#stat-total').textContent = String(total);
  $('#stat-visible').textContent = String(visCount);

  // 主题按钮图标
  const themeBtn = $('#theme-btn');
  if (themeBtn) {
    const isNight = document.documentElement.getAttribute('data-theme') !== 'dawn';
    themeBtn.textContent = isNight ? '🌙' : '☀️';
    themeBtn.title = isNight ? '切换到晨光主题' : '切换到星夜主题';
  }

  if (state.loading) {
    listBox.innerHTML = '';
    listBox.appendChild(el('div', { class: 'skeleton' }));
    listBox.appendChild(el('div', { class: 'skeleton' }));
    listBox.appendChild(el('div', { class: 'skeleton' }));
    return;
  }

  const list = visibleItems();

  if (!list.length) {
    listBox.innerHTML = '';
    const isEmpty = state.items.length === 0;
    listBox.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'empty-icon', 'aria-hidden': 'true', text: isEmpty ? '📭' : '🔍' }),
      el('p', { class: 'empty-title', text: isEmpty ? '还没有任何纪念日' : '没有匹配的纪念日' }),
      el('p', {
        class: 'empty-sub',
        text: isEmpty ? '点击右上角「+ 新增纪念日」添加第一条' : '试试换个关键词，或清除筛选条件'
      })
    ]));
    return;
  }

  listBox.innerHTML = '';
  list.forEach(function (item) { listBox.appendChild(renderItem(item)); });
}

function renderItem(item) {
  const info = computeDays(item);

  // ---- 名称 + 备注（宽屏一列，窄屏一整行）----
  const nameRow = el('div', { class: 'item-name' }, [item.name]);
  if (item.visible === false) {
    nameRow.appendChild(el('span', { class: 'tag-hidden', text: '已隐藏' }));
  }
  const main = el('div', { class: 'item-main' }, [
    nameRow,
    item.note ? el('div', { class: 'item-note item-note--desktop', text: item.note }) : null
  ]);

  // ---- 日期 ----
  const dateCell = el('div', { class: 'item-date', text: item.date });

  // ---- 类型徽章 ----
  const badge = el('span', {
    class: 'badge badge--' + (TYPE_LABEL[item.type] ? item.type : 'other'),
    text: (TYPE_ICON[item.type] || '✨') + ' ' + (TYPE_LABEL[item.type] || '其它')
  });

  // ---- 距今天数 ----
  let daysNode;
  if (info.isToday) {
    daysNode = el('div', { class: 'item-days is-today' }, [el('strong', { text: '今天' })]);
  } else if (info.passed) {
    daysNode = el('div', { class: 'item-days is-passed' }, [
      el('strong', { text: String(info.days) }),
      el('span', { text: ' 天前' })
    ]);
  } else {
    daysNode = el('div', { class: 'item-days' }, [
      el('strong', { text: String(info.days) }),
      el('span', { text: ' 天后' })
    ]);
  }

  // ---- 操作 ----
  const actions = el('div', { class: 'item-actions' }, [
    el('button', {
      class: 'btn btn--sm', type: 'button', 'data-act': 'edit', 'data-id': item.id,
      title: '编辑', 'aria-label': '编辑「' + item.name + '」', text: '编辑'
    }),
    el('button', {
      class: 'btn btn--sm btn--danger', type: 'button', 'data-act': 'delete', 'data-id': item.id,
      title: '删除', 'aria-label': '删除「' + item.name + '」', text: '删除'
    })
  ]);

  // 窄屏专用：日期 + 徽章 + 备注折叠成一行（宽屏由 CSS 隐藏）
  const meta = el('div', { class: 'item-meta' }, [
    el('span', { class: 'item-date item-date--mobile', text: item.date }),
    badge.cloneNode(true),
    item.note ? el('span', { class: 'item-note', text: item.note }) : null
  ]);

  return el('div', {
    class: 'item' + (item.visible === false ? ' is-hidden' : ''),
    role: 'listitem',
    'data-id': item.id
  }, [
    el('span', { class: 'item-icon', 'aria-hidden': 'true', text: item.icon || TYPE_ICON[item.type] || '🎂' }),
    main,
    dateCell,
    badge,
    daysNode,
    actions,
    meta
  ]);
}

/* ==========================================================================
   视图切换
   ========================================================================== */

function showLogin() {
  $('#view-login').hidden = false;
  $('#view-admin').hidden = true;
  const pw = $('#login-password');
  if (pw) pw.value = '';
  // 切回登录视图时把滚动位置复位，避免「登录卡片跑到屏幕外」
  window.scrollTo(0, 0);
  window.setTimeout(function () { if (pw) pw.focus(); }, 60);
}

function showAdmin() {
  $('#view-login').hidden = true;
  $('#view-admin').hidden = false;
  // 从登录页切过来时页面高度变化很大，复位到顶部保证表头和工具条可见
  window.scrollTo(0, 0);
}

/* ==========================================================================
   Token 管理
   ========================================================================== */

function saveToken(t) {
  state.token = t;
  try { window.localStorage.setItem(TOKEN_KEY, t); } catch (err) { /* 隐私模式：仅本次会话有效 */ }
}

function loadToken() {
  try {
    state.token = window.localStorage.getItem(TOKEN_KEY) || '';
  } catch (err) { state.token = ''; }
  return state.token;
}

function clearToken() {
  state.token = '';
  try { window.localStorage.removeItem(TOKEN_KEY); } catch (err) { /* ignore */ }
}

/* ==========================================================================
   数据加载
   ========================================================================== */

async function loadItems(silent) {
  if (!silent) { state.loading = true; render(); }

  const res = await api(API.admin);
  state.loading = false;

  if (!res.ok) {
    // 401 已由 api() 处理（切视图 + 提示）
    if (res.status !== 401) toast(res.error.message || '加载失败', 'error');
    render();
    return false;
  }

  state.items = Array.isArray(res.data) ? res.data : [];
  render();
  return true;
}

/* ==========================================================================
   模态框
   ========================================================================== */

const editModal = $('#edit-modal');
const delModal = $('#del-modal');
const pwdModal = $('#pwd-modal');

function openEdit(item) {
  state.editing = item ? item.id : null;

  $('#edit-title').textContent = item ? '编辑纪念日' : '新增纪念日';
  $('#edit-id').value = item ? item.id : '';
  $('#edit-name').value = item ? item.name : '';
  $('#edit-date').value = item ? item.date : '';
  $('#edit-type').value = item ? (item.type || 'other') : 'birthday';
  $('#edit-note').value = item ? (item.note || '') : '';
  $('#edit-icon').value = item ? (item.icon || '') : '';
  $('#edit-visible').checked = item ? item.visible !== false : true;
  $('#edit-recurring').checked = item ? item.recurring !== false : true;

  paintErrors({});
  updateNoteCount();
  updateRecurringHint();

  editModal.hidden = false;
  document.body.style.overflow = 'hidden';

  window.setTimeout(function () { $('#edit-name').focus(); }, 60);
}

function closeEdit() {
  editModal.hidden = true;
  document.body.style.overflow = '';
  state.editing = null;
}

function openDelete(item) {
  state.deleting = item;
  $('#del-name').textContent = '「' + item.name + '」';
  delModal.hidden = false;
  document.body.style.overflow = 'hidden';
  window.setTimeout(function () { $('#del-confirm').focus(); }, 60);
}

function closeDelete() {
  delModal.hidden = true;
  document.body.style.overflow = '';
  state.deleting = null;
}

/* ---------- 修改密码 ---------- */

function openPassword() {
  $('#pwd-old').value = '';
  $('#pwd-new').value = '';
  $('#pwd-confirm').value = '';

  // 每次打开都把「显示密码」复位为隐藏，避免上次的状态带到这次会话
  $$('.pw-toggle').forEach(function (btn) { setPwVisible(btn, false); });

  paintPwdErrors({});
  updatePwdMeter();

  pwdModal.hidden = false;
  document.body.style.overflow = 'hidden';
  window.setTimeout(function () { $('#pwd-old').focus(); }, 60);
}

function closePassword() {
  pwdModal.hidden = true;
  document.body.style.overflow = '';
  // 关闭即清空：不让密码以明文形式留在 DOM 里
  $('#pwd-old').value = '';
  $('#pwd-new').value = '';
  $('#pwd-confirm').value = '';
}

/** 切换某个密码框的明文/掩码显示 */
function setPwVisible(btn, visible) {
  const input = $('#' + btn.getAttribute('data-toggle'));
  if (!input) return;
  input.type = visible ? 'text' : 'password';
  btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
}

/** 提交中禁用按钮，防止连点造成重复请求（服务端还有 15 秒冷却兜底） */
function setPwdSaving(flag) {
  const btn = $('#pwd-save');
  btn.disabled = flag;
  btn.innerHTML = '';
  if (flag) {
    btn.appendChild(el('span', { class: 'spinner' }));
    btn.appendChild(document.createTextNode(' 提交中…'));
  } else {
    btn.appendChild(document.createTextNode('确认修改'));
  }
}

/** 保存中禁用按钮，防止重复提交产生两条数据 */
function setSaving(flag) {
  const btn = $('#edit-save');
  btn.disabled = flag;
  btn.innerHTML = '';
  if (flag) {
    btn.appendChild(el('span', { class: 'spinner' }));
    btn.appendChild(document.createTextNode(' 保存中…'));
  } else {
    btn.appendChild(document.createTextNode('保存'));
  }
}

function updateNoteCount() {
  const n = [...$('#edit-note').value].length;
  $('#note-count').textContent = String(n);
}

/**
 * MM-DD 天然是每年重复 → 禁用『每年重复』开关并给出说明；
 * 关闭重复后，日期必须带年份。这里只做提示，不强制改写用户输入。
 */
function updateRecurringHint() {
  const date = $('#edit-date').value.trim();
  const isMonthDay = /^\d{2}-\d{2}$/.test(date);
  const toggle = $('#edit-recurring');
  const hint = $('#recurring-hint');

  if (isMonthDay) {
    toggle.checked = true;
    toggle.disabled = true;
    hint.textContent = '只填写了月日的日期，默认每年重复。';
  } else {
    toggle.disabled = false;
    hint.textContent = toggle.checked
      ? '每年到了这一天都会再次提醒（生日、纪念日常用）。'
      : '只倒计时到指定那一年，之后不再提醒。';
  }
}

/* ==========================================================================
   事件绑定
   ========================================================================== */

/* ---------- 登录 ---------- */
$('#login-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const btn = $('#login-submit');
  const errBox = $('#login-error');
  const password = $('#login-password').value;

  errBox.textContent = '';

  if (!password) {
    errBox.textContent = '请输入管理员密码';
    $('#login-password').focus();
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '';
  btn.appendChild(el('span', { class: 'spinner' }));
  btn.appendChild(document.createTextNode(' 登录中…'));

  const res = await api(API.login, { method: 'POST', body: { password: password }, auth: false });

  btn.disabled = false;
  btn.textContent = '登 录';

  if (!res.ok) {
    errBox.textContent = res.error.message || '登录失败';
    $('#login-password').select();
    return;
  }

  saveToken(res.data.token);
  showAdmin();
  toast('登录成功，欢迎回来 ❤', 'success');
  await loadItems();
});

/* ---------- 退出 ---------- */
$('#logout-btn').addEventListener('click', async function () {
  await api(API.logout, { method: 'POST' });   // 尽力而为：即使失败也本地登出
  clearToken();
  state.items = [];
  showLogin();
  toast('已退出登录', 'info');
});

/* ---------- 刷新 ---------- */
$('#refresh-btn').addEventListener('click', async function () {
  const btn = this;
  btn.disabled = true;
  const done = await loadItems(true);
  btn.disabled = false;
  if (done) toast('列表已刷新', 'success');
});

/* ---------- 主题 ---------- */
$('#theme-btn').addEventListener('click', function () {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dawn' ? 'night' : 'dawn';
  root.setAttribute('data-theme', next);
  try { window.localStorage.setItem('love:theme', JSON.stringify(next)); } catch (err) { /* ignore */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'night' ? '#1a0008' : '#fff5f7');
  render();
});

/* ---------- 搜索 / 排序 / 筛选 ---------- */
let searchTimer = 0;
$('#search-input').addEventListener('input', function () {
  const value = this.value;
  window.clearTimeout(searchTimer);
  // 防抖 160ms：输入过程中不频繁重排整个列表
  searchTimer = window.setTimeout(function () {
    state.keyword = value;
    render();
  }, 160);
});

$('#sort-select').addEventListener('change', function () {
  state.sort = this.value;
  render();
});

$('#filter-select').addEventListener('change', function () {
  state.filter = this.value;
  render();
});

/* ---------- 新增 ---------- */
$('#add-btn').addEventListener('click', function () { openEdit(null); });

/* ---------- 列表委托：编辑 / 删除 ---------- */
listBox.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const item = state.items.filter(function (it) { return it.id === id; })[0];
  if (!item) return;

  if (btn.getAttribute('data-act') === 'edit') openEdit(item);
  else openDelete(item);
});

/* ---------- 编辑表单 ---------- */
$('#edit-form').addEventListener('submit', async function (e) {
  e.preventDefault();

  const result = validateForm();
  paintErrors(result.errors);

  if (!result.ok) {
    toast('请先修正表单中的问题', 'error');
    focusFirstError(result.errors);
    return;
  }

  setSaving(true);
  const isEdit = !!state.editing;

  const res = isEdit
    ? await api(API.admin + '/' + encodeURIComponent(state.editing), { method: 'PUT', body: result.value })
    : await api(API.admin, { method: 'POST', body: result.value });

  setSaving(false);

  if (!res.ok) {
    // 后端可能报出前端没抓到的字段问题（例如数据被并发改动）→ 回填
    if (res.error.field) {
      const errs = {};
      errs[res.error.field] = res.error.message;
      paintErrors(errs);
      focusFirstError(errs);
    }
    toast(res.error.message || (isEdit ? '保存失败' : '新增失败'), 'error');
    return;
  }

  closeEdit();
  toast(isEdit ? '修改已保存' : '纪念日已添加', 'success');
  await loadItems(true);
});

$('#edit-close').addEventListener('click', closeEdit);
$('#edit-cancel').addEventListener('click', closeEdit);

/* 输入时清除该字段的错误提示，避免用户改完了红框还留着 */
['name', 'date', 'note'].forEach(function (f) {
  const input = $('#edit-' + f);
  input.addEventListener('input', function () {
    const box = $('#err-' + f);
    if (box && box.textContent) {
      box.textContent = '';
      input.removeAttribute('aria-invalid');
    }
  });
});

$('#edit-note').addEventListener('input', updateNoteCount);
$('#edit-date').addEventListener('input', updateRecurringHint);
$('#edit-recurring').addEventListener('change', updateRecurringHint);

/* 类型变化时，若图标为空则自动带出推荐图标 */
$('#edit-type').addEventListener('change', function () {
  const iconInput = $('#edit-icon');
  iconInput.placeholder = TYPE_ICON[this.value] || '🎂';
});

/* ---------- 删除确认 ---------- */
$('#del-close').addEventListener('click', closeDelete);
$('#del-cancel').addEventListener('click', closeDelete);

$('#del-confirm').addEventListener('click', async function () {
  if (!state.deleting) return;
  const item = state.deleting;
  const btn = this;

  btn.disabled = true;
  btn.innerHTML = '';
  btn.appendChild(el('span', { class: 'spinner' }));
  btn.appendChild(document.createTextNode(' 删除中…'));

  const res = await api(API.admin + '/' + encodeURIComponent(item.id), { method: 'DELETE' });

  btn.disabled = false;
  btn.textContent = '确认删除';

  if (!res.ok) {
    toast(res.error.message || '删除失败', 'error');
    return;
  }

  closeDelete();
  toast('「' + item.name + '」已删除', 'success');
  await loadItems(true);
});

/* ---------- 修改密码 ---------- */
$('#pwd-btn').addEventListener('click', openPassword);
$('#pwd-close').addEventListener('click', closePassword);
$('#pwd-cancel').addEventListener('click', closePassword);

/* 显示 / 隐藏密码 */
$$('.pw-toggle').forEach(function (btn) {
  btn.addEventListener('click', function () {
    setPwVisible(btn, btn.getAttribute('aria-pressed') !== 'true');
  });
});

/* 输入时清掉该字段的错误提示，并实时刷新强度条 */
PWD_FIELDS.forEach(function (f) {
  $('#pwd-' + f).addEventListener('input', function () {
    const box = $('#err-pwd-' + f);
    if (box && box.textContent) {
      box.textContent = '';
      this.removeAttribute('aria-invalid');
    }
    if (f === 'new') updatePwdMeter();
  });
});

$('#pwd-form').addEventListener('submit', async function (e) {
  e.preventDefault();

  const result = validatePasswordForm();
  paintPwdErrors(result.errors);

  if (!result.ok) {
    toast('请先修正表单中的问题', 'error');
    focusFirstPwdError(result.errors);
    return;
  }

  setPwdSaving(true);
  const res = await api(API.password, { method: 'POST', body: result.value });
  setPwdSaving(false);

  if (!res.ok) {
    // 后端带回 field 就精确落到对应输入框（oldPassword / newPassword）
    if (res.error.field === 'oldPassword') paintPwdErrors({ old: res.error.message });
    else if (res.error.field === 'newPassword') paintPwdErrors({ new: res.error.message });
    toast(res.error.message || '修改失败，请稍后重试', 'error');
    return;
  }

  // 服务端已轮换世代 → 包括当前这条在内的所有会话都已失效。
  // 本地同步登出，回到登录页强制重新认证。
  closePassword();
  clearToken();
  state.items = [];
  showLogin();
  toast('密码已修改，请用新密码重新登录', 'success');
});

/* ---------- 模态框：点遮罩关闭 / ESC 关闭 ---------- */
[editModal, delModal, pwdModal].forEach(function (modal) {
  modal.addEventListener('mousedown', function (e) {
    if (e.target !== modal) return;
    if (modal === editModal) closeEdit();
    else if (modal === delModal) closeDelete();
    else closePassword();
  });
});

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (!delModal.hidden) closeDelete();
  else if (!editModal.hidden) closeEdit();
  else if (!pwdModal.hidden) closePassword();
});

/* ==========================================================================
   启动
   ========================================================================== */

async function boot() {
  if (loadToken()) {
    // 有 token：先进管理视图，再用一次请求验证它是否还有效
    showAdmin();
    const okFlag = await loadItems();
    if (!okFlag) {
      // token 失效 → api() 内部已切回登录视图
      render();
    }
  } else {
    showLogin();
  }
}

boot();
