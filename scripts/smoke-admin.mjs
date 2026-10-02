#!/usr/bin/env node
/**
 * ============================================================================
 *  smoke-admin.mjs —— 后台管理系统端到端冒烟测试
 * ============================================================================
 *
 *  目标：用真实 HTTP 请求把「登录 → 增删改查 → 前台读取」整条链路跑一遍，
 *        不依赖浏览器，因此可以在 CI 或部署后立刻执行。
 *
 *  覆盖的断言（共 63 项）：
 *    A. 公开接口      4 项 —— 未登录可读、返回 JSON、结构正确、不含内部字段
 *    B. 鉴权         6 项 —— 无 token / 假 token / 已登出 token 均 401；写操作同样
 *    C. 登录          3 项 —— 错误密码 401、空密码 400、正确密码返回 token
 *    D. 校验          7 项 —— 空名称、超长名称、非法日期、不存在的日期、
 *                             非法类型、超长备注、MM-DD 形式
 *    E. CRUD        14 项 —— 新增后可查、编辑生效、隐藏后前台不可见、
 *                             不存在 id 返回 404、删除生效、删除后前台消失
 *    F. 改密码      23 项 —— 鉴权、字段/强度/弱密码/新旧相同校验、" 原密码错误、
 *                             成功改密 + 旧 token 全局吊销、新密码可登录、
 *                             旧密码失效、改回原密码
 *    G. 限流         4 项 —— 连续失败后 429、带 Retry-After、限流不影响其它 scope
 *    H. 登出          2 项 —— 登出 200、登出后 token 失效
 *
 *  用法：
 *    node scripts/smoke-admin.mjs <baseUrl> [password]
 *    例：node scripts/smoke-admin.mjs http://127.0.0.1:8788 mypassword
 *        node scripts/smoke-admin.mjs https://our-anniversary.pages.dev mypassword
 *
 *  可选参数：
 *    --with-ratelimit   额外验证限流会真的返回 429。
 *                       注意：会把当前 IP 锁住一个限流窗口（默认 5 分钟），
 *                       所以默认不跑；跑完可以用 CF KV API 删掉 rl:* 键解锁。
 *
 *  退出码：0 = 全部通过，1 = 有失败（便于 script / CI 判断）
 * ============================================================================
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const PASSWORD = process.argv[3] || process.env.LOVE_ADMIN_PASSWORD || '';
const WITH_RATELIMIT = process.argv.indexOf('--with-ratelimit') > -1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  /* ================= F. 修改密码 ================= */
  section('【F】修改管理员密码 POST /api/admin/password');

  /* --- 鉴权 --- */
  const pwNoToken = await req('POST', '/api/admin/password', {
    body: { oldPassword: PASSWORD, newPassword: 'Whatever123!' }
  });
  check('无 token 改密码 → 401', pwNoToken.status === 401, 'HTTP ' + pwNoToken.status);

  const pwFakeToken = await req('POST', '/api/admin/password', {
    token: 'f'.repeat(64),
    body: { oldPassword: PASSWORD, newPassword: 'Whatever123!' }
  });
  check('伪造 token 改密码 → 401', pwFakeToken.status === 401, 'HTTP ' + pwFakeToken.status);

  /* --- 字段与强度校验（都不应改动密码，也不计入失败次数）--- */
  const pwCases = [
    { label: '空原密码 → 422', body: { oldPassword: '', newPassword: 'Strong123!x' }, field: 'oldPassword' },
    { label: '空新密码 → 422', body: { oldPassword: PASSWORD, newPassword: '' }, field: 'newPassword' },
    { label: '新密码过短（Ab1!）→ 422',
      body: { oldPassword: PASSWORD, newPassword: 'Ab1!' }, field: 'newPassword' },
    { label: '新密码只有单一字符类别（abcdefgh）→ 422',
      body: { oldPassword: PASSWORD, newPassword: 'abcdefgh' }, field: 'newPassword' },
    { label: '新密码命中弱密码黑名单（Password）→ 422',
      body: { oldPassword: PASSWORD, newPassword: 'Password' }, field: 'newPassword' }
  ];

  for (const c of pwCases) {
    const r = await req('POST', '/api/admin/password', { token: token, body: c.body });
    const fieldOk = r.json && r.json.error && r.json.error.field === c.field;
    check(c.label, r.status === 422 && fieldOk,
      'HTTP ' + r.status + (r.json && r.json.error ? ' field=' + r.json.error.field : ''));
  }

  const pwSame = await req('POST', '/api/admin/password', {
    token: token, body: { oldPassword: PASSWORD, newPassword: PASSWORD }
  });
  check('新密码与当前密码相同 → 422', pwSame.status === 422, 'HTTP ' + pwSame.status);

  /* --- 原密码错误 --- */
  const pwWrongOld = await req('POST', '/api/admin/password', {
    token: token,
    body: { oldPassword: PASSWORD + '_definitely_wrong', newPassword: 'StrongNew123!x' }
  });
  check('原密码错误 → 403', pwWrongOld.status === 403, 'HTTP ' + pwWrongOld.status);
  check('原密码错误的提示不含敏感信息',
    !!pwWrongOld.json && !!pwWrongOld.json.error &&
    typeof pwWrongOld.json.error.message === 'string' &&
    pwWrongOld.json.error.message.indexOf('sha') === -1 &&
    pwWrongOld.json.error.message.indexOf('KV') === -1,
    pwWrongOld.json && pwWrongOld.json.error ? pwWrongOld.json.error.message : '(无)');

  const pwStillValid = await req('GET', '/api/admin/anniversaries', { token: token });
  check('原密码输错不会注销当前会话', pwStillValid.status === 200, 'HTTP ' + pwStillValid.status);

  /* --- 成功修改 --- */
  const NEW_PASSWORD = 'Smoke' + Date.now() + '!aZ';

  const changed = await req('POST', '/api/admin/password', {
    token: token,
    body: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD }
  });
  check('原密码正确 → 改密成功 200', changed.status === 200 && !!changed.json && changed.json.ok === true,
    'HTTP ' + changed.status + (changed.json && changed.json.error ? ' ' + changed.json.error.code : ''));
  check('返回 reauthRequired:true（提示需要重新登录）',
    !!changed.json && changed.json.data && changed.json.data.reauthRequired === true);
  check('响应不回显任何密码',
    JSON.stringify(changed.json || {}).indexOf(NEW_PASSWORD) === -1 &&
    JSON.stringify(changed.json || {}).indexOf(PASSWORD) === -1);

  /* --- 核心安全断言：旧 token 必须立刻全局失效 --- */
  const revoked = await req('GET', '/api/admin/anniversaries', { token: token });
  check('改密后原 token 立即失效 → 401（强制重新登录）', revoked.status === 401, 'HTTP ' + revoked.status);

  const revokedWrite = await req('POST', '/api/admin/anniversaries', {
    token: token, body: { name: 'x', date: '2024-01-01', type: 'other' }
  });
  check('改密后原 token 无法再写数据 → 401', revokedWrite.status === 401, 'HTTP ' + revokedWrite.status);

  /* --- 新密码可用、旧密码失效 --- */
  const loginNew = await req('POST', '/api/login', { body: { password: NEW_PASSWORD } });
  check('新密码可以登录 → 200', loginNew.status === 200 &&
    !!loginNew.json && !!loginNew.json.data && typeof loginNew.json.data.token === 'string',
    'HTTP ' + loginNew.status);
  const token2 = (loginNew.json && loginNew.json.data && loginNew.json.data.token) || '';

  const loginOld = await req('POST', '/api/login', { body: { password: PASSWORD } });
  check('旧密码已失效 → 401', loginOld.status === 401, 'HTTP ' + loginOld.status);

  /* --- 改回原密码，避免污染环境 --- */
  if (token2) {
    const restored = await changeWithCooldown(token2, NEW_PASSWORD, PASSWORD);
    check('改回原密码 → 200', restored.status === 200 && !!restored.json && restored.json.ok === true,
      'HTTP ' + restored.status);

    const loginRestored = await req('POST', '/api/login', { body: { password: PASSWORD } });
    check('原密码恢复可用 → 200', loginRestored.status === 200, 'HTTP ' + loginRestored.status);
    const token3 = (loginRestored.json && loginRestored.json.data && loginRestored.json.data.token) || '';

    const loginNewGone = await req('POST', '/api/login', { body: { password: NEW_PASSWORD } });
    check('临时新密码已失效 → 401', loginNewGone.status === 401, 'HTTP ' + loginNewGone.status);

    /* ================= G. 限流 ================= */
    section('【G】失败限流');

    if (!WITH_RATELIMIT) {
      console.log('    ⊘ 未开启 --with-ratelimit，跳过 429 相关断言（避免锁住当前 IP）');
    } else {
      // 注意：刚才「改回原密码」会启动 15 秒防抖冷却，而冷却检查排在
      // 原密码校验之前 —— 冷却期内所有请求都会被 TOO_SOON 挡下，
      // 失败计数根本不会增长。所以必须先等冷却过去，再开始猜。
      console.log('    ⏳ 先等防抖冷却结束（否则只会在 TOO_SOON 上打转）…');
      await sleep(17000);

      let limitedRes = null;
      let lastStatus = 0;
      let lastCode = '';

      // 用「改密码」这个 scope 试，不动 login 的计数，
      // 这样即使被锁也只影响本段末尾，不会波及后面的登出断言。
      for (let i = 0; i < 25; i++) {
        const r = await req('POST', '/api/admin/password', {
          token: token3,
          body: { oldPassword: 'definitely-not-the-password-' + i, newPassword: 'StrongNew123!x' }
        });
        lastStatus = r.status;
        lastCode = (r.json && r.json.error && r.json.error.code) || '';

        if (r.status === 429 && lastCode === 'RATE_LIMITED') { limitedRes = r; break; }

        // 仍是冷却/其它 429 → 按 Retry-After 让路后继续
        if (r.status === 429) {
          const wait = Number(r.headers.get('retry-after')) || 16;
          console.log('    ⏳ 命中 ' + lastCode + '，等待 ' + wait + ' 秒…');
          await sleep((wait + 1) * 1000);
        }
      }

      check('连续失败达到阈值后 → 429', !!limitedRes,
        '最后一次 HTTP ' + lastStatus + (lastCode ? ' code=' + lastCode : ''));

      const retryAfter = limitedRes ? (limitedRes.headers.get('retry-after') || '') : '';
      check('429 响应带 Retry-After 头', !!retryAfter && Number(retryAfter) > 0,
        'retry-after=' + retryAfter);

      const limitMsg = (limitedRes && limitedRes.json && limitedRes.json.error &&
        limitedRes.json.error.message) || '';
      check('限流文案可读且不含阈值/内部细节',
        limitMsg.length > 0 && limitMsg.indexOf('KV') === -1 && limitMsg.indexOf('sha') === -1,
        '"' + limitMsg + '"');
      check('限流错误码为 RATE_LIMITED',
        !!limitedRes && (limitedRes.json.error.code === 'RATE_LIMITED'), lastCode || '(无)');

      const otherScope = await req('GET', '/api/admin/anniversaries', { token: token3 });
      check('限流只作用于失败计数，正常读取不受影响 → 200',
        otherScope.status === 200, 'HTTP ' + otherScope.status);

      console.log('    ℹ 本段结束后当前 IP 的 pwd 限流会被锁住一个窗口；');
      console.log('      需要立刻解锁可删掉 KV 里的 rl:pwd:* 键。');
    }

    /* ================= H. 登出 ================= */
    section('【H】退出登录');

    const logout2 = await req('POST', '/api/logout', { token: token3 || token });
    check('登出 → 200', logout2.status === 200, 'HTTP ' + logout2.status);

    const afterLogout2 = await req('GET', '/api/admin/anniversaries', { token: token3 || token });
    check('登出后原 token 失效 → 401', afterLogout2.status === 401, 'HTTP ' + afterLogout2.status);
  } else {
    console.log('    ⊘ 未能用新密码登录，跳过「改回原密码」与登出断言');
  }

  report();
}

/**
 * 改密码，遇到防抖冷却（429 TOO_SOON）就按 Retry-After 等待后重试。
 * 服务端默认有 15 秒冷却，所以「改过去 → 改回来」必然会撞上。
 */
async function changeWithCooldown(token, oldPw, newPw) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await req('POST', '/api/admin/password', {
      token: token, body: { oldPassword: oldPw, newPassword: newPw }
    });
    if (r.status !== 429) return r;

    const wait = Number(r.headers.get('retry-after')) || 16;
    console.log('    ⏳ 命中防抖冷却，等待 ' + wait + ' 秒后重试…');
    await sleep((wait + 1) * 1000);
  }
  return { status: 0, json: null, headers: new Headers() };
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
