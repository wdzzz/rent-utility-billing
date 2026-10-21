'use strict';

/**
 * 接口级集成测试：真实启动 HTTP 服务（临时数据库 + 随机端口），
 * 覆盖房间/人员 CRUD、预览计算、保存账单、历史查询、CSV 导出、参数校验。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-test-'));

let child = null;
const TEST_PASSWORD = 'test-pass-2026';
let sessionCookie = '';

async function raw(method, p, body, headers = {}) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers, text };
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'app/server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: path.join(TMP, 'billing.db'),
      APP_PASSWORD: TEST_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) {
        const login = await fetch(BASE + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        });
        const setCookie = login.headers.get('set-cookie') || '';
        const m = setCookie.match(/sid=([^;]+)/);
        if (!m) throw new Error('测试登录失败');
        sessionCookie = `sid=${m[1]}`;
        return;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('服务未能在 15 秒内启动');
});

test.after(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('首次启动导入 7 个房间、10 位住户（含 101 商户）', async () => {
  const { status, data } = await req('GET', '/api/rooms');
  assert.equal(status, 200);
  assert.equal(data.rooms.length, 7);
  const tenants = data.rooms.flatMap((r) => r.tenants);
  assert.equal(tenants.length, 10);
  assert.deepEqual(
    data.rooms.map((r) => r.room_no),
    ['101', '201', '202', '301', '302', '401', '402']
  );
  const room201 = data.rooms.find((r) => r.room_no === '201');
  assert.equal(room201.fixed_electric_weight, 1); // 新口径：正常房间电费系数 1
  assert.equal(room201.fixed_water_weight, 1); // 水费系数默认 1（按人天）
  assert.deepEqual(room201.tenants.map((t) => t.name), ['张伟', '王芳']);

  const room101 = data.rooms.find((r) => r.room_no === '101');
  assert.equal(room101.exclude_electric, 1); // 商户独立电表
  assert.equal(room101.fixed_electric_weight, 0);
  assert.equal(room101.fixed_water_weight, 0.5); // 商户水费系数 0.5（手动控制）
});

test('预览：默认口径 = 电费系数1 × 房间天数、水费 = 入住人数 × 天数（101 商户特殊）', async () => {
  const { status, data } = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 760.62 }, water: { total: 361.9 } },
  });
  assert.equal(status, 200);
  const electric = data.fees.find((f) => f.key === 'electric');
  const water = data.fees.find((f) => f.key === 'water');
  assert.equal(electric.mode, 'room-days');
  assert.equal(water.mode, 'person-days');

  // 电费：6 间正常房 × 1 × 30 天 = 180（101 独立电表不参与）
  assert.equal(electric.weight_sum, 180);
  assert.ok(!electric.items.some((i) => i.room_no === '101'));
  // 水费：其他房间 9 位住户 × 30 天 = 270，加 101 商户「0.5 系数 × 30 人天」= 15
  assert.equal(water.weight_sum, 285);

  const byNo = Object.fromEntries(data.rooms.map((r) => [r.room_no, r]));
  assert.equal(byNo['201'].electric.amount_cents, 12677); // 76062 / 6
  assert.equal(byNo['201'].water.person_days, 60);
  assert.equal(byNo['201'].water.amount_cents, 7619);
  assert.equal(byNo['101'].water.person_days, 30);
  assert.equal(byNo['101'].water.weight, 15); // 0.5 × 30
  assert.equal(byNo['101'].water.amount_cents, 1905);

  // 分位闭合 + 合计
  assert.equal(electric.items.reduce((a, i) => a + i.amount_cents, 0), 76062);
  assert.equal(water.items.reduce((a, i) => a + i.amount_cents, 0), 36190);
  assert.equal(data.total_cents, 112252);
});

test('预览：人天模式按在住天数自动生成系数', async () => {
  const { status, data } = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 600, mode: 'person-days' }, water: { total: 0, mode: 'person-days' } },
  });
  assert.equal(status, 200);
  const electric = data.fees.find((f) => f.key === 'electric');
  // 9 位住户整月都在住（101 商户不参与电费）：9 × 30 = 270
  assert.equal(electric.weight_sum, 270);
  assert.equal(electric.items.reduce((a, i) => a + i.amount_cents, 0), 60000);
});

test('预览：手动模式使用指定系数，未指定的房间按电费口径预填', async () => {
  const { status, data } = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 100, mode: 'manual' }, water: { total: 0, mode: 'manual' } },
    overrides: { electric: { 2: 1, 3: 1 } },
  });
  assert.equal(status, 200);
  const electric = data.fees.find((f) => f.key === 'electric');
  const byNo = Object.fromEntries(data.rooms.map((r) => [r.room_no, r]));
  assert.equal(byNo['201'].electric.weight, 1);
  assert.equal(byNo['202'].electric.weight, 1);
  assert.equal(byNo['301'].electric.weight, 30); // 未指定 => 电费口径建议值（系数 1 × 30 天）
  assert.equal(electric.items.reduce((a, i) => a + i.amount_cents, 0), 10000);
});

test('默认分摊方式：电费=房间系数×在住天数，水费=人天', async () => {
  const { status, data } = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 600 }, water: { total: 60 } },
  });
  assert.equal(status, 200);
  const electric = data.fees.find((f) => f.key === 'electric');
  const water = data.fees.find((f) => f.key === 'water');
  assert.equal(electric.mode, 'room-days');
  assert.equal(water.mode, 'person-days');
  // 电费权重：6 间正常房 × 系数1 × 30 天 = 180（101 独立电表不参与）
  assert.equal(electric.weight_sum, 180);
  // 水费权重：9 位住户 × 30 天 + 101 商户（系数 0.5 × 30 人天）= 270 + 15
  assert.equal(water.weight_sum, 285);
  // 101 是商户：不参与电费分摊
  assert.ok(!electric.items.some((i) => i.room_no === '101'), '101 不出现在电费明细中');
  assert.equal(data.rooms.find((r) => r.room_no === '101').water.weight, 15);
  assert.equal(data.rooms.find((r) => r.room_no === '201').electric.occupied_days, 30);
  assert.equal(data.rooms.find((r) => r.room_no === '201').water.person_days, 60);
  assert.equal(data.fees[0].period.days, 30);
});

test('电费与水费可用不同期间，保存为两条独立账单', async () => {
  const created = await req('POST', '/api/bills', {
    label: '不同期间测试',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: {
      electric: { total: 300, mode: 'room-days', period_start: '2026-09-01', period_end: '2026-09-30' },
      water: { total: 64, mode: 'person-days', period_start: '2026-07-14', period_end: '2026-09-15' },
    },
  });
  assert.equal(created.status, 200);
  const bills = created.data.bills;
  assert.equal(bills.length, 2);

  const eBill = bills.find((b) => b.fee_key === 'electric');
  const wBill = bills.find((b) => b.fee_key === 'water');
  assert.ok(eBill && wBill, '电费、水费各自一条账单');
  assert.equal(eBill.label, '不同期间测试（电费）');
  assert.equal(wBill.label, '不同期间测试（水费）');
  assert.equal(eBill.period_start, '2026-09-01');
  assert.equal(eBill.period_end, '2026-09-30');
  assert.equal(wBill.period_start, '2026-07-14');
  assert.equal(wBill.period_end, '2026-09-15');
  assert.equal(eBill.total_cents, 30000);
  assert.equal(wBill.total_cents, 6400);

  // 201 房 2 位租客整月都在住：电费房间天数 30 天，水费人天 2 × 64 = 128
  assert.equal(eBill.items.find((i) => i.room_no === '201').days, 30);
  assert.equal(wBill.items.find((i) => i.room_no === '201').days, 128);

  const eCsv = await req('GET', `/api/bills/${eBill.id}/csv`);
  assert.match(eCsv.text, /类型,电费/);
  assert.match(eCsv.text, /2026-09-01/);
  assert.match(eCsv.text, /房间天数/);
  const wCsv = await req('GET', `/api/bills/${wBill.id}/csv`);
  assert.match(wCsv.text, /类型,水费/);
  assert.match(wCsv.text, /2026-07-14/);
  assert.match(wCsv.text, /水费人天/);

  for (const b of bills) await req('DELETE', `/api/bills/${b.id}`);
  assert.equal((await req('GET', '/api/bills')).data.bills.length, 0);
});

test('不填名称时自动生成「日期 + 电费/水费」账单名', async () => {
  const created = await req('POST', '/api/bills', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: {
      electric: { total: 300, period_start: '2026-09-01', period_end: '2026-09-30' },
      water: { total: 64, period_start: '2026-08-16', period_end: '2026-10-14' },
    },
  });
  assert.equal(created.status, 200);
  const bills = created.data.bills;
  const eBill = bills.find((b) => b.fee_key === 'electric');
  const wBill = bills.find((b) => b.fee_key === 'water');
  assert.equal(eBill.label, '2026年9月电费');
  assert.equal(wBill.label, '2026-08-16 ~ 2026-10-14 水费');
  for (const b of bills) await req('DELETE', `/api/bills/${b.id}`);
});

test('离住记录：新增后自动减少人天，删除后恢复', async () => {
  const rooms = (await req('GET', '/api/rooms')).data.rooms;
  const room201 = rooms.find((r) => r.room_no === '201');
  const tenant = room201.tenants.find((t) => t.name === '张伟');

  const created = await req('POST', `/api/tenants/${tenant.id}/absences`, {
    start_date: '2026-09-01',
    end_date: '2026-09-10',
    note: '回老家',
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.start_date, '2026-09-01');

  const list = await req('GET', `/api/tenants/${tenant.id}/absences`);
  assert.equal(list.data.absences.length, 1);

  // 张伟少住 10 天 => 房间 201 人天 50；同屋王芳仍在住，房间仍算 30 天有人
  const preview = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 600 }, water: { total: 60 } },
  });
  const r201 = preview.data.rooms.find((r) => r.room_no === '201');
  assert.equal(r201.water.person_days, 50);
  assert.equal(r201.electric.occupied_days, 30);
  assert.equal(preview.data.fees.find((f) => f.key === 'water').weight_sum, 275);
  assert.equal(r201.water.tenants.find((t) => t.name === '张伟').days, 20);
  assert.equal(r201.water.tenants.find((t) => t.name === '张伟').absence_days, 10);
  // 明细里带期间内的离住记录，供水费账单展示
  const hhj = preview.data.fees
    .find((f) => f.key === 'water')
    .items.find((i) => i.room_no === '201')
    .tenants.find((t) => t.name === '张伟');
  assert.deepEqual(hhj.absences, [
    { start: '2026-09-01', end: '2026-09-10', days: 10, note: '回老家' },
  ]);

  const del = await req('DELETE', `/api/absences/${created.data.id}`);
  assert.equal(del.status, 200);
  const restored = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 600 }, water: { total: 60 } },
  });
  assert.equal(restored.data.fees.find((f) => f.key === 'water').weight_sum, 285);
});

test('离住记录：日期校验（结束早于开始 / 格式错误）', async () => {
  const rooms = (await req('GET', '/api/rooms')).data.rooms;
  const tenant = rooms.find((r) => r.room_no === '202').tenants[0];
  const bad = await req('POST', `/api/tenants/${tenant.id}/absences`, {
    start_date: '2026-09-20',
    end_date: '2026-09-10',
  });
  assert.equal(bad.status, 400);
  const malformed = await req('POST', `/api/tenants/${tenant.id}/absences`, {
    start_date: '2026/09/10',
    end_date: '2026-09-20',
  });
  assert.equal(malformed.status, 400);
});

test('保存账单：电费、水费各一条，分别记录天数/系数/金额', async () => {
  const created = await req('POST', '/api/bills', {
    label: '房间天数测试',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 600, mode: 'room-days' }, water: { total: 60, mode: 'person-days' } },
  });
  assert.equal(created.status, 200);
  const bills = created.data.bills;
  assert.equal(bills.length, 2);

  const eBill = bills.find((b) => b.fee_key === 'electric');
  const wBill = bills.find((b) => b.fee_key === 'water');
  const item201 = eBill.items.find((i) => i.room_no === '201');
  assert.equal(item201.days, 30); // 电费：房间天数
  assert.equal(item201.weight, 30); // 系数 1 × 30 天
  assert.equal(item201.amount_cents, 10000); // 600 元 / 6 间
  assert.equal(eBill.items.reduce((a, i) => a + i.amount_cents, 0), 60000);

  const w201 = wBill.items.find((i) => i.room_no === '201');
  assert.equal(w201.days, 60); // 水费：2 人 × 30 天
  assert.equal(wBill.items.reduce((a, i) => a + i.amount_cents, 0), 6000);

  const csv = await req('GET', `/api/bills/${eBill.id}/csv`);
  assert.match(csv.text, /房间天数/);
  assert.match(csv.text, /电费合计/);

  for (const b of bills) await req('DELETE', `/api/bills/${b.id}`);
});

test('预览：参数校验失败返回 400', async () => {
  const bad = await req('POST', '/api/bills/preview', {
    period_start: '2026-13-01',
    period_end: '2026-13-31',
    fees: { electric: { total: 1, mode: 'fixed' } },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /格式错误|不早于/);

  const reversed = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-30',
    period_end: '2026-09-01',
    fees: { electric: { total: 1, mode: 'fixed' } },
  });
  assert.equal(reversed.status, 400);
});

test('保存账单 -> 历史列表（分电费/水费两行） -> 详情 -> CSV -> 删除', async () => {
  const created = await req('POST', '/api/bills', {
    label: '2026年9月水电费',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 760.62 }, water: { total: 361.9 } },
    status: 'final',
  });
  assert.equal(created.status, 200);
  const bills = created.data.bills;
  assert.equal(bills.length, 2);
  const eBill = bills.find((b) => b.fee_key === 'electric');
  const wBill = bills.find((b) => b.fee_key === 'water');
  assert.equal(eBill.label, '2026年9月电费');
  assert.equal(wBill.label, '2026年9月水费');
  assert.equal(eBill.total_cents, 76062);
  assert.equal(wBill.total_cents, 36190);
  // 101 是商户（独立电表），电费明细只有 6 间房
  assert.equal(eBill.items.length, 6);
  assert.equal(eBill.items.reduce((a, i) => a + i.amount_cents, 0), 76062);
  assert.ok(!eBill.items.some((i) => i.room_no === '101'), '电费账单不含 101');
  assert.equal(wBill.items.reduce((a, i) => a + i.amount_cents, 0), 36190);

  const list = await req('GET', '/api/bills');
  assert.equal(list.data.bills.length, 2);
  assert.equal(
    list.data.bills.reduce((a, b) => a + b.total_cents, 0),
    112252
  );
  assert.deepEqual(
    list.data.bills.map((b) => b.fee_key).sort(),
    ['electric', 'water']
  );

  const detail = await req('GET', `/api/bills/${eBill.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.fee_key, 'electric');
  assert.equal(detail.data.snapshot.fees.length, 2);
  assert.equal(detail.data.items.find((i) => i.room_no === '201').tenants.length, 2);
  assert.equal(detail.data.items.find((i) => i.room_no === '201').amount_cents, 12677);

  const csv = await req('GET', `/api/bills/${eBill.id}/csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /房号/);
  assert.match(csv.text, /201/);
  assert.match(csv.text, /电费合计/);
  assert.match(csv.text, /126\.77/); // 760.62 / 6 间
  assert.match(csv.text, /离住记录（本期间）/); // 与预览一致，不再导出住户分摊

  const wCsv = await req('GET', `/api/bills/${wBill.id}/csv`);
  assert.match(wCsv.text, /水费合计/);
  assert.match(wCsv.text, /19\.05/); // 101 商户 0.5 人

  for (const b of bills) {
    const del = await req('DELETE', `/api/bills/${b.id}`);
    assert.equal(del.status, 200);
  }
  assert.equal((await req('GET', '/api/bills')).data.bills.length, 0);
});

test('人员改动会影响后续账单的人天计算', async () => {
  const rooms = (await req('GET', '/api/rooms')).data.rooms;
  const room301 = rooms.find((r) => r.room_no === '301');
  const tenant = room301.tenants[0];

  const update = await req('PUT', `/api/tenants/${tenant.id}`, {
    move_out: '2026-09-15',
  });
  assert.equal(update.status, 200);
  assert.equal(update.data.move_out, '2026-09-15');

  const preview = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 100, mode: 'person-days' } },
  });
  const r301 = preview.data.rooms.find((r) => r.room_no === '301');
  assert.equal(r301.water.person_days, 15); // 9/1 ~ 9/15

  // 复原
  await req('PUT', `/api/tenants/${tenant.id}`, { move_out: null });
});

test('房间 CRUD：新增/改名/重复校验/删除', async () => {
  const created = await req('POST', '/api/rooms', {
    room_no: '501',
    fixed_electric_weight: 10,
    fixed_water_weight: 20,
    note: '测试房间',
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.room_no, '501');

  const dup = await req('POST', '/api/rooms', { room_no: '501' });
  assert.equal(dup.status, 409);

  const renamed = await req('PUT', `/api/rooms/${created.data.id}`, { room_no: '502' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.room_no, '502');

  const tenant = await req('POST', '/api/tenants', {
    room_id: created.data.id,
    name: '测试住户',
    phone: '13800000000',
    move_in: '2026-01-01',
  });
  assert.equal(tenant.status, 200);

  const del = await req('DELETE', `/api/rooms/${created.data.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, true);

  const rooms = (await req('GET', '/api/rooms')).data.rooms;
  assert.equal(rooms.find((r) => r.room_no === '502'), undefined);
});

test('被历史账单引用的房间删除时只停用，历史仍可查', async () => {
  const bill = await req('POST', '/api/bills', {
    label: '停用测试',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    // 101 不参与电费，所以用「水费」账单制造对 101 的引用
    fees: { electric: { total: 10, mode: 'fixed' }, water: { total: 10, mode: 'person-days' } },
  });
  const rooms = (await req('GET', '/api/rooms')).data.rooms;
  const room = rooms.find((r) => r.room_no === '101');
  const del = await req('DELETE', `/api/rooms/${room.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.deactivated, true);

  const afterList = (await req('GET', '/api/rooms')).data.rooms;
  assert.equal(afterList.find((r) => r.room_no === '101'), undefined);

  const waterBill = bill.data.bills.find((b) => b.fee_key === 'water');
  const detail = await req('GET', `/api/bills/${waterBill.id}`);
  assert.ok(detail.data.items.some((i) => i.room_no === '101'), '水费账单里仍有 101 的历史明细');
});

test('系数全为 0 时拒绝保存账单（防止分配合计与总额不一致）', async () => {
  const rooms = (await req('GET', '/api/rooms')).data.rooms;
  const overrides = { electric: {}, water: {} };
  for (const r of rooms) {
    overrides.electric[r.id] = 0;
    overrides.water[r.id] = 0;
  }
  const preview = await req('POST', '/api/bills/preview', {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 100, mode: 'manual' }, water: { total: 0, mode: 'manual' } },
    overrides,
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.data.warnings.some((w) => w.includes('不一致')));

  const created = await req('POST', '/api/bills', {
    label: '零系数测试',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 100, mode: 'manual' }, water: { total: 0, mode: 'manual' } },
    overrides,
  });
  assert.equal(created.status, 400);
  assert.match(created.data.error, /不一致/);
});

test('未知接口与 404', async () => {
  const r = await req('GET', '/api/not-exist');
  assert.equal(r.status, 404);
  const page = await req('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /房租水电费计算/);
});

// ---------------- 访问密码 / 公开登记 / 备份恢复 ----------------

test('访问密码：未登录时接口 401，页面跳转登录；登录页与登记页可公开访问', async () => {
  const unauth = await raw('GET', '/api/rooms');
  assert.equal(unauth.status, 401);

  const home = await fetch(BASE + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login');

  const loginPage = await fetch(BASE + '/login');
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /访问密码/);

  const absencePage = await fetch(BASE + '/absence');
  assert.equal(absencePage.status, 200);
  const absenceHtml = await absencePage.text();
  assert.match(absenceHtml, /离住记录登记/);
  assert.doesNotMatch(absenceHtml, /身份证/); // 公开页不含隐私字段
});

test('访问密码：错误密码被拒绝，正确密码下发会话 Cookie', async () => {
  const bad = await raw('POST', '/api/auth/login', { password: 'wrong-password' });
  assert.equal(bad.status, 401);

  const ok = await raw('POST', '/api/auth/login', { password: TEST_PASSWORD });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') || '', /sid=/);

  const status = await req('GET', '/api/auth/status');
  assert.equal(status.data.configured, true);
  assert.equal(status.data.authed, true);
  assert.equal(status.data.publicPath, '/absence');
});

test('公开登记：只暴露房号+姓名，可新增离住记录且无需登录', async () => {
  const res = await fetch(BASE + '/api/public/rooms');
  assert.equal(res.status, 200);
  const data = await res.json();
  const room201 = data.rooms.find((r) => r.room_no === '201');
  assert.ok(room201 && room201.tenants.length > 0);
  assert.deepEqual(Object.keys(room201.tenants[0]).sort(), ['id', 'name']);
  assert.equal(room201.phone, undefined);

  const tenant = room201.tenants[0];
  const created = await fetch(BASE + '/api/public/absences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: tenant.id,
      start_date: '2026-11-02',
      end_date: '2026-11-04',
      note: '公开登记测试',
    }),
  });
  assert.equal(created.status, 200);
  const payload = await created.json();
  assert.equal(payload.room_no, '201');
  assert.equal(payload.tenant_name, tenant.name);

  const list = await req('GET', '/api/absences?start=2026-11-01&end=2026-11-30');
  assert.equal(list.status, 200);
  const found = list.data.absences.find((a) => a.note === '公开登记测试');
  assert.ok(found, '公开登记的记录能在总览里查到');
  assert.equal(found.days, 3);
  assert.equal(found.room_no, '201');

  await req('DELETE', `/api/absences/${found.id}`);
});

test('离住记录总览：默认按范围过滤（最近三个月 / 今年 / 全部）', async () => {
  const rooms = (await req('GET', '/api/rooms')).data.rooms;
  const tenant = rooms.find((r) => r.room_no === '302').tenants[0];
  const created = await req('POST', `/api/tenants/${tenant.id}/absences`, {
    start_date: '2026-12-01',
    end_date: '2026-12-05',
    note: '范围过滤测试',
  });
  assert.equal(created.status, 200);

  const inRange = await req('GET', '/api/absences?start=2026-11-01&end=2026-12-31');
  assert.ok(inRange.data.absences.some((a) => a.note === '范围过滤测试'));

  const outRange = await req('GET', '/api/absences?start=2026-01-01&end=2026-06-30');
  assert.ok(!outRange.data.absences.some((a) => a.note === '范围过滤测试'));

  const byRoom = await req('GET', `/api/absences?start=2026-11-01&end=2026-12-31&room_id=${tenant.room_id}`);
  assert.ok(byRoom.data.absences.every((a) => a.room_id === tenant.room_id));

  await req('DELETE', `/api/absences/${created.data.id}`);
});

test('备份下载 + 从备份恢复（数据保留）', async () => {
  const before = (await req('GET', '/api/rooms')).data.rooms.length;

  const res = await fetch(BASE + '/api/backup', {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 16).toString('latin1'), 'SQLite format 3\u0000');
  assert.ok(buf.length > 1000);

  const restore = await fetch(BASE + '/api/restore', {
    method: 'POST',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  assert.equal(restore.status, 200);
  const restored = await restore.json();
  assert.equal(restored.ok, true);
  assert.ok(restored.bytes > 0);

  const after = (await req('GET', '/api/rooms')).data.rooms.length;
  assert.equal(after, before);

  // 恢复非 SQLite 文件应被拒绝
  const bad = await fetch(BASE + '/api/restore', {
    method: 'POST',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('this is not a sqlite file'),
  });
  assert.equal(bad.status, 400);
});

test('HTTPS 反向代理：X-Forwarded-Proto=https 时 Cookie 加 Secure 并返回 HSTS', async () => {
  const proxied = await raw(
    'POST',
    '/api/auth/login',
    { password: TEST_PASSWORD },
    { 'X-Forwarded-Proto': 'https' }
  );
  assert.equal(proxied.status, 200);
  const cookie = proxied.headers.get('set-cookie') || '';
  assert.match(cookie, /; Secure/);
  assert.equal(proxied.headers.get('strict-transport-security'), 'max-age=31536000');

  // 直连 HTTP 时不能带 Secure，否则本地登录会丢 Cookie
  const plain = await raw('POST', '/api/auth/login', { password: TEST_PASSWORD });
  assert.doesNotMatch(plain.headers.get('set-cookie') || '', /; Secure/);
  assert.equal(plain.headers.get('strict-transport-security'), null);
});

test('公开近期费用查询：最近 6 份账单，只含房号与金额', async () => {
  const created = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await req('POST', '/api/bills', {
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      fees: {
        electric: { total: 300 + i, period_start: '2026-09-01', period_end: '2026-09-30' },
        water: { total: 100 + i, period_start: '2026-08-16', period_end: '2026-10-14' },
      },
    });
    assert.equal(res.status, 200);
    created.push(...res.data.bills);
  }

  const publicRes = await fetch(BASE + '/api/public/bills');
  assert.equal(publicRes.status, 200);
  const payload = await publicRes.json();
  assert.equal(payload.bills.length, 6);
  assert.ok(payload.bills[0].id > payload.bills[1].id, '按最新在前排序');

  for (const bill of payload.bills) {
    assert.equal(typeof bill.label, 'string');
    assert.ok(['electric', 'water'].includes(bill.fee_key));
    assert.ok(Array.isArray(bill.rooms) && bill.rooms.length > 0);
    assert.equal(
      bill.rooms.reduce((a, r) => a + r.amount_cents, 0),
      bill.total_cents
    );
    assert.deepEqual(Object.keys(bill.rooms[0]).sort(), ['amount_cents', 'room_no']);
  }
  const rawText = JSON.stringify(payload);
  assert.doesNotMatch(rawText, /tenants|tenant_name|phone|id_card/);

  // 公开页面上能看到这个区块
  const page = await fetch(BASE + '/absence');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /近期费用查询/);

  for (const bill of created) await req('DELETE', `/api/bills/${bill.id}`);
});
