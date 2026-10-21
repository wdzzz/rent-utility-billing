// 前端 DOM 冒烟测试（依赖 jsdom，仅用于本地验证，不进入运行时依赖）
//
// 会自己起一个临时服务（独立端口 + 临时数据库），测试结束自动清理，
// 不会碰到 data/billing.db 里的真实账单数据。
//
// 用法: node tools/ui-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('SKIP: 未安装 jsdom，跳过前端冒烟测试（npm i -D jsdom）');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 19000 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
const errors = [];

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('ok  :', msg);
  }
}

async function waitFor(fn, timeout = 5000, label = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await sleep(50);
  }
  throw new Error(`等待超时: ${label}`);
}

async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'app/server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: path.join(TMP, 'smoke.db'),
      APP_PASSWORD: 'smoke-pass-2026',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok, 15000, '临时服务启动');
}

let sessionCookie = '';

async function api(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    ...options,
  });
  return res.json();
}

async function login() {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'smoke-pass-2026' }),
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/sid=([^;]+)/);
  if (!m) throw new Error('冒烟测试登录失败');
  sessionCookie = `sid=${m[1]}`;
}

await startServer();
await login();

const html = fs.readFileSync(path.join(ROOT, 'app/public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app/public/app.js'), 'utf8');

const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

window.fetch = (input, init = {}) =>
  fetch(new URL(input, window.location.href), {
    ...init,
    headers: { ...(init.headers || {}), ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
  });
window.confirm = () => true;
window.alert = () => {};
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

window.eval(appJs);
document.dispatchEvent(new window.Event('DOMContentLoaded'));

try {
  // 以接口数据为准（临时库 = 表格初始数据：7 房间 / 9 人）
  const roomsNow = (await api('/api/rooms')).rooms;
  const expectRooms = roomsNow.length;
  const expectTenants = roomsNow.reduce((a, r) => a + (r.tenants || []).length, 0);

  await waitFor(
    () => document.querySelectorAll('#rooms-table tbody tr').length === expectRooms,
    8000,
    '房间列表'
  );
  assert(expectRooms >= 1, `房间表渲染 ${expectRooms} 行`);
  assert(
    document.querySelectorAll('#tenants-table tbody tr').length === expectTenants,
    `人员表渲染 ${expectTenants} 行`
  );
  assert(
    roomsNow.find((r) => r.room_no === '101').exclude_electric === 1,
    '101 默认为独立电表商户（不参与电费）'
  );

  // 水费默认周期 = 上上月 16 号 ~ 本月 14 号
  const now = new Date();
  let endMonth = now.getMonth();
  if (now.getDate() < 15) endMonth -= 1;
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const expectWaterEnd = iso(new Date(now.getFullYear(), endMonth, 14));
  const expectWaterStart = iso(new Date(now.getFullYear(), endMonth - 2, 16));
  assert(
    document.getElementById('water_period_end').value === expectWaterEnd,
    `水费默认结束 = ${expectWaterEnd}（本月 14 号）`
  );
  assert(
    document.getElementById('water_period_start').value === expectWaterStart,
    `水费默认开始 = ${expectWaterStart}（上上月 16 号）`
  );
  assert(
    document.getElementById('electric_period_end').value ===
      iso(new Date(now.getFullYear(), now.getMonth(), 0)),
    '电费默认结束 = 上月最后一天'
  );

  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  set('electric_period_start', '2026-09-01');
  set('electric_period_end', '2026-09-30');
  set('water_period_start', '2026-07-14');
  set('water_period_end', '2026-09-15');
  document.getElementById('btn-fill-example').click();
  assert(document.getElementById('electric_total').value === '760.62', '示例按钮填入电费 760.62');
  assert(document.getElementById('water_total').value === '361.9', '示例按钮填入水费 361.90');
  // 默认口径：电费按房间系数×天数，水费按人天
  assert(document.getElementById('electric_mode').value === 'room-days', '电费默认按房间系数×天数');
  assert(document.getElementById('water_mode').value === 'person-days', '水费默认按人天');

  document.getElementById('btn-preview').click();
  await waitFor(
    () =>
      !document.getElementById('preview-card').hidden &&
      document.querySelectorAll('#preview-tables .fee-block').length === 3,
    8000,
    '预览表格'
  );

  assert(
    document.getElementById('preview-summary').textContent.includes('1,122.52'),
    '预览合计 = 1,122.52 元（与表格一致）'
  );
  assert(
    (() => {
      const blocks = Array.from(document.querySelectorAll('#preview-tables .fee-block'));
      const electric = blocks[0] ? blocks[0].textContent : '';
      const water = blocks[1] ? blocks[1].textContent : '';
      return (
        electric.includes('电费分摊') &&
        electric.includes('房间天数') &&
        !electric.includes('101') &&
        water.includes('水费分摊') &&
        water.includes('人天') &&
        water.includes('101')
      );
    })(),
    '电费表排除 101（独立电表），水费表包含 101（商户 0.5 系数）'
  );
  const previewText = document.getElementById('preview-tables').textContent;
  assert(
    (previewText.match(/离住记录（本期间）/g) || []).length === 2,
    '电费、水费两张表都显示本期间离住记录'
  );
  assert(!previewText.includes('住户分摊'), '两张表都不再显示住户分摊列');
  // 电费：760.62 / 6 间 = 126.77；水费 202（2 人 × 64 天）≈ 76.19
  assert(previewText.includes('126.77'), '电费 201 房 = 126.77 元（760.62 ÷ 6 间）');
  assert(previewText.includes('76.19'), '水费 202 房 = 76.19 元（按人天）');
  assert(document.querySelectorAll('#preview-tables .weight-input').length === 0, '默认模式无手工输入框');

  // 保存（电费、水费各一条）
  document.getElementById('btn-save-bill').click();
  const findSmokeRows = () => Array.from(document.querySelectorAll('#bills-table tbody tr'));
  await waitFor(
    () => document.getElementById('view-bills').classList.contains('active') && findSmokeRows().length === 2,
    8000,
    '历史账单列表'
  );
  const smokeRows = findSmokeRows();
  assert(smokeRows.some((r) => r.textContent.includes('2026年9月电费')), '电费账单名自动生成：2026年9月电费');
  assert(
    smokeRows.some((r) => r.textContent.includes('2026-07-14 ~ 2026-09-15 水费')),
    '水费账单名自动生成：起止日期 + 水费'
  );
  const rowText = smokeRows.map((r) => r.textContent).join(' ');
  assert(/760\.62/.test(rowText), '历史账单出现电费 760.62');
  assert(/361\.90/.test(rowText), '历史账单出现水费 361.90');
  assert(
    smokeRows.some((r) => r.textContent.includes('电费')) &&
      smokeRows.some((r) => r.textContent.includes('水费')),
    '历史账单按电费/水费分成两行'
  );

  const electricRow = smokeRows.find((r) => r.textContent.includes('电费'));
  electricRow.querySelector('[data-act="view"]').click();
  await waitFor(
    () =>
      !document.getElementById('modal-mask').hidden &&
      document.querySelectorAll('#modal-body .fee-block').length === 1,
    8000,
    '账单详情'
  );
  assert(document.getElementById('modal-body').textContent.includes('760.62'), '详情显示电费总额');
  assert(document.getElementById('modal-body').textContent.includes('126.77'), '详情显示 201 电费分摊');
  document.getElementById('modal-close').click();
  assert(document.getElementById('modal-mask').hidden, '弹窗可关闭');

  // 删除冒烟创建的两条账单
  while (findSmokeRows().length > 0) {
    const before = findSmokeRows().length;
    findSmokeRows()[0].querySelector('[data-act="del"]').click();
    await waitFor(() => findSmokeRows().length < before, 8000, '账单删除');
  }
  assert(findSmokeRows().length === 0, '冒烟测试账单已删除（不影响真实账单）');

  // 房间与人员
  document.querySelector('.tab[data-view="rooms"]').click();
  await waitFor(() => document.getElementById('view-rooms').classList.contains('active'), 3000, '房间视图');
  assert(document.querySelector('#rooms-table').textContent.includes('101'), '房间表含 101');
  assert(document.querySelector('#rooms-table').textContent.includes('独立电表'), '房间表显示独立电表标记');
  assert(document.querySelector('#rooms-table').textContent.includes('0.5'), '房间表显示商户水费系数 0.5');
  assert(document.querySelector('#tenants-table').textContent.includes('张伟'), '人员表含张伟');

  // 离住记录增删（选一个没有离住记录的住户）
  const freeTenant = roomsNow
    .flatMap((r) => (r.tenants || []).map((t) => ({ ...t, room_no: r.room_no })))
    .find((t) => (t.absences || []).length === 0);
  if (freeTenant) {
    const tenantRow = Array.from(document.querySelectorAll('#tenants-table tbody tr')).find(
      (tr) =>
        tr.cells[0].textContent.trim() === freeTenant.room_no &&
        tr.cells[1].textContent.trim() === freeTenant.name
    );
    tenantRow.querySelector('[data-act="absences"]').click();
    await waitFor(
      () =>
        !document.getElementById('modal-mask').hidden &&
        document.getElementById('absence-list') &&
        !document.getElementById('absence-list').textContent.includes('加载中'),
      8000,
      '离住记录弹窗'
    );
    assert(document.getElementById('absence-list').textContent.includes('还没有离住记录'), '初始无离住记录');

    document.getElementById('abs-modal-start').value = '2026-09-01';
    document.getElementById('abs-modal-end').value = '2026-09-10';
    document.getElementById('abs-modal-note').value = '回老家';
    document.getElementById('abs-modal-add').click();
    await waitFor(() => document.querySelectorAll('#absence-list tbody tr').length === 1, 8000, '离住记录新增');
    assert(document.querySelector('#absence-list').textContent.includes('回老家'), '离住记录显示备注');

    document.getElementById('modal-close').click();
    await waitFor(
      () => document.querySelector('#tenants-table').textContent.includes('1 段 / 共 10 天'),
      8000,
      '人员表离住统计'
    );

    tenantRow.querySelector('[data-act="absences"]').click();
    await waitFor(() => document.querySelectorAll('#absence-list [data-del]').length === 1, 8000, '离住记录列表');
    document.querySelector('#absence-list [data-del]').click();
    await waitFor(
      () => document.getElementById('absence-list').textContent.includes('还没有离住记录'),
      8000,
      '离住记录删除'
    );
    document.getElementById('modal-close').click();
  } else {
    console.log('skip: 所有住户都已有离住记录，跳过离住记录增删测试');
  }

  // 房间编辑弹窗包含商户相关设置
  document.querySelector('#rooms-table [data-act="edit-room"]').click();
  assert(!document.getElementById('modal-mask').hidden, '房间编辑弹窗打开');
  assert(
    document.getElementById('room-form').querySelector('[name="exclude_electric"]') !== null,
    '弹窗含电费分摊设置'
  );
  assert(
    document.getElementById('room-form').querySelector('[name="fixed_water_weight"]') !== null,
    '弹窗含水费系数'
  );
  document.getElementById('modal-close').click();

  // 离住记录总览页
  document.querySelector('.tab[data-view="absences"]').click();
  await waitFor(
    () => document.getElementById('view-absences').classList.contains('active'),
    4000,
    '离住记录视图'
  );
  await waitFor(() => document.getElementById('absence-start').value !== '', 6000, '离住记录默认范围');
  const today = new Date();
  const threeAgo = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());
  const expect3m = `${threeAgo.getFullYear()}-${pad(threeAgo.getMonth() + 1)}-${pad(threeAgo.getDate())}`;
  assert(
    document.getElementById('absence-start').value === expect3m,
    '离住记录默认显示最近三个月'
  );
  await waitFor(
    () =>
      document.getElementById('absences-empty').hidden === false ||
      document.querySelectorAll('#absences-table tbody tr').length > 0,
    6000,
    '离住记录列表'
  );

  // 设置弹窗：密码 / 备份 / 恢复 / 登记链接 / 退出
  document.getElementById('btn-settings').click();
  await waitFor(
    () => !document.getElementById('modal-mask').hidden && document.getElementById('pw-form') !== null,
    5000,
    '设置弹窗'
  );
  assert(document.querySelector('#pw-form #pw-old') !== null, '设置里有修改密码');
  assert(document.querySelector('a[href="/api/backup"]') !== null, '设置里有下载备份');
  assert(document.getElementById('restore-file') !== null, '设置里有恢复上传');
  assert(document.getElementById('public-url').value.endsWith('/absence'), '设置里显示离住登记链接');
  assert(document.getElementById('btn-logout') !== null, '设置里有退出登录');
  document.getElementById('modal-close').click();

  assert(errors.length === 0, `页面无 JS 异常${errors.length ? '：' + errors.join(' | ') : ''}`);
  console.log(process.exitCode ? '\n结果: 存在失败项' : '\n结果: 前端冒烟测试全部通过');
} catch (err) {
  console.error('FAIL:', err.message);
  if (errors.length) console.error('页面错误:', errors);
  process.exitCode = 1;
} finally {
  window.close();
  if (server) server.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(TMP, { recursive: true, force: true });
}
