#!/usr/bin/env node
/**
 * ============================================================================
 *  smoke-admin.mjs —— 后台管理系统端到端冒烟测试
 * ============================================================================
 *
 *  目标：用真实 HTTP 请求把「登录 → 增删改查 → 前台读取」整条链路跑一遍，
 *        不依赖浏览器，因此可以在 CI 或部署后立刻执行。
 *
 *  覆盖的断言（共 26 项）：
 *    A. 公开接口      4 项 —— 未登录可读、返回 JSON、结构正确、不含内部字段
 *    B. 鉴权         6 项 —— 无 token / 假 token / 已登出 token 均 401；写操作同样
 *    C. 登录          3 项 —— 错误密码 401、空密码 400、正确密码返回 token
 *    D. 校验          7 项 —— 空名称、超长名称、非法日期、不存在的日期、
 *                             非法类型、超长备注、MM-DD 形式
 *    E. CRUD         6 项 —— 新增后可查、编辑生效、隐藏后前台不可见、
 *                            不存在 id 返回 404、删除生效、删除后前台消失
 *
 *  用法：
 *    node scripts/smoke-admin.mjs <baseUrl> [password]
 *    例：node scripts/smoke-admin.mjs http://127.0.0.1:8788 mypassword
 *        node scripts/smoke-admin.mjs https://our-anniversary.pages.dev mypassword
 *
 *  退出码：0 = 全部通过，1 = 有失败（便于 script / CI 判断）
 * ============================================================================
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const PASSWORD = process.argv[3] || process.env.LOVE_ADMIN_PASSWORD || '';

/* ------------------------------------------------------------------ 断言框架 */

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('    ✔ ' + label);
  } else {
    failed++;
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('    ✘ ' + label + (detail ? '  → ' + detail : ''));
  }
}

function section(title) {
  console.log('\n  ' + title);
}

/* ------------------------------------------------------------------ HTTP 封装 */

async function req(method, path, opts) {
  const o = opts || {};
  const headers = { 'accept': 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.token) headers['authorization'] = 'Bearer ' + o.token;

  const res = await fetch(BASE + path, {
    method: method,
    headers: headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
    redirect: 'manual'
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }

  return { status: res.status, json: json, text: text, headers: res.headers };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log('');
  console.log('  ❤  后台管理冒烟测试');
  console.log('  ─────────────────────────────────────────────');
  console.log('  目标：' + BASE);
  console.log('  密码：' + (PASSWORD ? '已提供（' + PASSWORD.length + ' 字符）' : '未提供，将跳过登录相关断言'));

  /* ================= A. 公开接口 ================= */
  section('【A】公开接口 GET /api/anniversaries');

  const pub = await req('GET', '/api/anniversaries');
  check('状态码 200', pub.status === 200, 'HTTP ' + pub.status);
  check('返回 JSON 而非 HTML 回退', pub.json !== null, '响应不是合法 JSON（说明路由到了静态资源）');
  check('响应结构为 { ok, data: [] }', !!pub.json && pub.json.ok === true && Array.isArray(pub.json.data));

  const pubItems = (pub.json && pub.json.data) || [];
  const leaks = pubItems.filter(function (it) {
    return 'id' in it || 'createdAt' in it || 'updatedAt' in it || 'visible' in it;
  });
  check('不泄漏内部字段（id/时间戳/visible）', leaks.length === 0,
    '发现 ' + leaks.length + ' 条含内部字段');

  /* ================= B. 鉴权 ================= */
  section('【B】鉴权拦截');

  const noToken = await req('GET', '/api/admin/anniversaries');
  check('无 token 读取后台列表 → 401', noToken.status === 401, 'HTTP ' + noToken.status);

  const fakeToken = await req('GET', '/api/admin/anniversaries', { token: 'deadbeef'.repeat(8) });
  check('伪造 token → 401', fakeToken.status === 401, 'HTTP ' + fakeToken.status);

  const noTokenWrite = await req('POST', '/api/admin/anniversaries', {
    body: { name: 'x', date: '2024-01-01' }
  });
  check('无 token 写入 → 401', noTokenWrite.status === 401, 'HTTP ' + noTokenWrite.status);

  const fakeTokenDelete = await req('DELETE', '/api/admin/anniversaries/whatever', { token: 'a'.repeat(64) });
  check('伪造 token 删除 → 401', fakeTokenDelete.status === 401, 'HTTP ' + fakeTokenDelete.status);

  /* ================= C. 登录 ================= */
  section('【C】管理员登录');

  const emptyPw = await req('POST', '/api/login', { body: { password: '' } });
  check('空密码 → 400', emptyPw.status === 400, 'HTTP ' + emptyPw.status);

  if (!PASSWORD) {
    console.log('    ⊘ 未提供密码，跳过登录成功相关断言');
    console.log('      用法：node scripts/smoke-admin.mjs <url> <密码>');
    report();
    return;
  }

  const badLogin = await req('POST', '/api/login', { body: { password: PASSWORD + '_wrong' } });
  check('错误密码 → 401', badLogin.status === 401, 'HTTP ' + badLogin.status);
  check('错误提示不泄漏是否为密码错误以外的信息',
    !!badLogin.json && badLogin.json.ok === false && typeof badLogin.json.error.message === 'string');

  const login = await req('POST', '/api/login', { body: { password: PASSWORD } });
  check('正确密码 → 200 且返回 token',
    login.status === 200 && !!login.json && login.json.ok === true && 
    typeof (login.json.data && login.json.data.token) === 'string' &&
    login.json.data.token.length >= 32,
    'HTTP ' + login.status);

  const token = (login.json && login.json.data && login.json.data.token) || '';
  if (!token) { report(); return; }

  const authList = await req('GET', '/api/admin/anniversaries', { token: token });
  check('带 token 读取后台列表 → 200', authList.status === 200, 'HTTP ' + authList.status);
  check('后台列表包含完整字段（id/visible/createdAt）',
    Array.isArray(authList.json && authList.json.data) &&
    (authList.json.data.length === 0 ||
      ('id' in authList.json.data[0] && 'visible' in authList.json.data[0] &&
       'createdAt' in authList.json.data[0])));

  /* ================= D. 数据校验 ================= */
  section('【D】数据校验');

  const cases = [
    { label: '空名称 → 422', body: { name: '   ', date: '2024-01-01', type: 'other' }, expectField: 'name' },
    { label: '超长名称（31 字）→ 422',
      body: { name: '很'.repeat(31), date: '2024-01-01', type: 'other' }, expectField: 'name' },
    { label: '非法日期格式 "2024/1/1" → 422',
      body: { name: '测试', date: '2024/1/1', type: 'other' }, expectField: 'date' },
    { label: '不存在的日期 2023-02-29 → 422',
      body: { name: '测试', date: '2023-02-29', type: 'other' }, expectField: 'date' },
    { label: '不存在的日期 2024-04-31 → 422',
      body: { name: '测试', date: '2024-04-31', type: 'other' }, expectField: 'date' },
    { label: '非法类型 → 422',
      body: { name: '测试', date: '2024-01-01', type: 'hacker' }, expectField: 'type' },
    { label: '超长备注（101 字）→ 422',
      body: { name: '测试', date: '2024-01-01', type: 'other', note: '备'.repeat(101) }, expectField: 'note' }
  ];

  for (const c of cases) {
    const r = await req('POST', '/api/admin/anniversaries', { token: token, body: c.body });
    const fieldOk = !c.expectField || (r.json && r.json.error && r.json.error.field === c.expectField);
    check(c.label, r.status === 422 && fieldOk,
      'HTTP ' + r.status + (r.json && r.json.error ? ' field=' + r.json.error.field : ''));
  }

  // MM-DD 应被接受
  const mmdd = await req('POST', '/api/admin/anniversaries', {
    token: token,
    body: { name: '冒烟-MMDD-' + Date.now(), date: '12-25', type: 'festival', icon: '🎄' }
  });
  check('MM-DD 形式（12-25）被接受 → 200',
    mmdd.status === 200 && !!mmdd.json && mmdd.json.ok === true, 'HTTP ' + mmdd.status);

  const mmddId = (mmdd.json && mmdd.json.data && mmdd.json.data.id) || null;
  if (mmddId) await req('DELETE', '/api/admin/anniversaries/' + mmddId, { token: token });

  /* ================= E. CRUD 全链路 ================= */
  section('【E】增删改查 + 前台联动');

  const stamp = Date.now();
  const testName = '冒烟测试-' + stamp;

  // --- 新增 ---
  const created = await req('POST', '/api/admin/anniversaries', {
    token: token,
    body: {
      name: testName,
      date: '2030-06-15',
      type: 'memorial',
      note: '自动化冒烟测试创建',
      icon: '🧪',
      visible: true,
      recurring: false
    }
  });
  check('新增纪念日 → 200', created.status === 200 && !!created.json && created.json.ok === true,
    'HTTP ' + created.status);
  const id = (created.json && created.json.data && created.json.data.id) || '';
  check('返回了新生成的 id', !!id, id ? id : '（空）');

  if (!id) { report(); return; }

  // --- 前台能读到 ---
  const pubAfterCreate = await req('GET', '/api/anniversaries');
  const foundInPublic = ((pubAfterCreate.json && pubAfterCreate.json.data) || [])
    .some(function (it) { return it.name === testName; });
  check('前台接口能读到新条目（前后端联动）', foundInPublic);

  // --- 编辑 ---
  const updated = await req('PUT', '/api/admin/anniversaries/' + id, {
    token: token,
    body: {
      name: testName + '-已改',
      date: '2030-06-15',
      type: 'memorial',
      note: '编辑后的备注',
      icon: '✅',
      visible: true,
      recurring: false
    }
  });
  check('编辑纪念日 → 200', updated.status === 200 && !!updated.json && updated.json.ok === true,
    'HTTP ' + updated.status);
  check('编辑后名称已变更',
    !!updated.json && updated.json.data && updated.json.data.name === testName + '-已改');

  // --- 编辑时 id 不变（防止「编辑变成新建」这类经典 bug）---
  check('编辑保持 id 不变', !!updated.json && updated.json.data && updated.json.data.id === id);

  // --- 隐藏 ---
  const hidden = await req('PUT', '/api/admin/anniversaries/' + id, {
    token: token,
    body: {
      name: testName + '-已改',
      date: '2030-06-15',
      type: 'memorial',
      note: '编辑后的备注',
      icon: '✅',
      visible: false,
      recurring: false
    }
  });
  check('设为隐藏 → 200', hidden.status === 200, 'HTTP ' + hidden.status);

  const pubAfterHide = await req('GET', '/api/anniversaries');
  const stillVisible = ((pubAfterHide.json && pubAfterHide.json.data) || [])
    .some(function (it) { return it.name === testName + '-已改'; });
  check('隐藏后前台不再显示该条目', !stillVisible);

  const adminSees = await req('GET', '/api/admin/anniversaries', { token: token });
  const adminStillHas = ((adminSees.json && adminSees.json.data) || [])
    .some(function (it) { return it.id === id; });
  check('隐藏后后台仍能看到该条目', adminStillHas);

  // --- 不存在的 id ---
  const notFound = await req('PUT', '/api/admin/anniversaries/notexist123', {
    token: token,
    body: { name: 'x', date: '2024-01-01', type: 'other' }
  });
  check('编辑不存在的 id → 404', notFound.status === 404, 'HTTP ' + notFound.status);

  // --- 删除 ---
  const deleted = await req('DELETE', '/api/admin/anniversaries/' + id, { token: token });
  check('删除纪念日 → 200', deleted.status === 200 && !!deleted.json && deleted.json.ok === true,
    'HTTP ' + deleted.status);

  const pubAfterDelete = await req('GET', '/api/anniversaries');
  const goneFromPublic = !((pubAfterDelete.json && pubAfterDelete.json.data) || [])
    .some(function (it) { return it.name === testName + '-已改'; });
  check('删除后前台彻底消失', goneFromPublic);

  const delAgain = await req('DELETE', '/api/admin/anniversaries/' + id, { token: token });
  check('重复删除 → 404', delAgain.status === 404, 'HTTP ' + delAgain.status);

  /* ================= F. 登出 ================= */
  section('【F】退出登录');

  const logout = await req('POST', '/api/logout', { token: token });
  check('登出 → 200', logout.status === 200, 'HTTP ' + logout.status);

  const afterLogout = await req('GET', '/api/admin/anniversaries', { token: token });
  check('登出后原 token 失效 → 401', afterLogout.status === 401, 'HTTP ' + afterLogout.status);

  report();
}

function report() {
  console.log('');
  console.log('  ─────────────────────────────────────────────');
  if (failed === 0) {
    console.log('  ✅ 全部通过：' + passed + ' 项断言');
  } else {
    console.log('  ❌ 失败 ' + failed + ' 项 / 共 ' + (passed + failed) + ' 项');
    failures.forEach(function (f) { console.log('     · ' + f); });
  }
  console.log('');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(function (err) {
  console.error('\n  ❌ 测试执行异常：', err && err.message ? err.message : err);
  process.exitCode = 1;
});
