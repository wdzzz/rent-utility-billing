'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../app/calc.js');

// —— 与《房租水电费计算.xlsx》逐项对账 ——
// 电费区：房号 201/202/301/302/401/402，系数 30/30/30/24/(空)/20，
//         总额 760.62，单价 = 760.62 / 134
// 水费区：房号 101/201/202/301/302/401/402，系数 59/140/178/59/59/(空)/118，
//         总额 361.90，单价 = 361.90 / 613

const SHEET_ROOMS = [
  { id: 1, room_no: '101', fixed_electric_weight: null, fixed_water_weight: 59 },
  { id: 2, room_no: '201', fixed_electric_weight: 30, fixed_water_weight: 140 },
  { id: 3, room_no: '202', fixed_electric_weight: 30, fixed_water_weight: 178 },
  { id: 4, room_no: '301', fixed_electric_weight: 30, fixed_water_weight: 59 },
  { id: 5, room_no: '302', fixed_electric_weight: 24, fixed_water_weight: 59 },
  { id: 6, room_no: '401', fixed_electric_weight: null, fixed_water_weight: null },
  { id: 7, room_no: '402', fixed_electric_weight: 20, fixed_water_weight: 118 },
];

function roomByNo(result, no) {
  return result.rooms.find((r) => r.room_no === no);
}

function feeOf(result, key) {
  return result.fees.find((f) => f.key === key);
}

test('期间天数：首尾都算（2026-06-15 ~ 2026-08-14 = 61 天）', () => {
  assert.equal(calc.periodDays('2026-06-15', '2026-08-14'), 61);
  // 表格 G15 = 46126 - 46068 = 58，是"相差天数"，含首尾为 59 天
  assert.equal(calc.periodDays('2026-02-15', '2026-04-14'), 59);
  assert.equal(calc.periodDays('2026-10-01', '2026-10-31'), 31);
  assert.equal(calc.periodDays('2026-10-31', '2026-10-01'), 0);
  // 水费常见周期：2026-08-14 ~ 2026-10-15 = 63 天
  assert.equal(calc.periodDays('2026-08-14', '2026-10-15'), 63);
});

test('租客在住天数：2 月 11 离开、2 月 24 返回 => 13 天（对应表格 G20=46077-46064）', () => {
  const tenant = { name: '孙丽', active: 1, move_in: '2023-01-01', move_out: '2026-02-24' };
  assert.equal(calc.tenantDaysInPeriod(tenant, '2026-02-11', '2026-04-14'), 14);
  assert.equal(calc.periodDays('2026-02-11', '2026-02-24'), 14);
  assert.equal(calc.periodDays('2026-02-12', '2026-02-24'), 13);
});

test('离住记录（回老家）从在住天数中扣除，期间外的记录不影响', () => {
  const base = { id: 1, room_id: 1, name: 'A', active: 1, move_in: '2023-01-01', move_out: null };
  const away = { ...base, absences: [{ start_date: '2026-09-05', end_date: '2026-09-14' }] };
  assert.equal(calc.tenantDaysInPeriod(away, '2026-09-01', '2026-09-30'), 20); // 30 - 10
  const outside = { ...base, absences: [{ start_date: '2026-07-01', end_date: '2026-07-10' }] };
  assert.equal(calc.tenantDaysInPeriod(outside, '2026-09-01', '2026-09-30'), 30);
  // 部分重叠：09-25 ~ 10-05 只扣掉 09-25~09-30 共 6 天
  const partial = { ...base, absences: [{ start_date: '2026-09-25', end_date: '2026-10-05' }] };
  assert.equal(calc.tenantDaysInPeriod(partial, '2026-09-01', '2026-09-30'), 24);
});

test('固定系数模式：电费 760.62/134、水费 361.90/613，与表格逐项一致', () => {
  const result = calc.computeBill({
    rooms: SHEET_ROOMS,
    tenants: [],
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: {
      electric: { total: 760.62, mode: 'fixed', period_start: '2026-09-01', period_end: '2026-09-30' },
      water: { total: 361.9, mode: 'fixed', period_start: '2026-07-14', period_end: '2026-09-15' },
    },
  });

  const electric = feeOf(result, 'electric');
  const water = feeOf(result, 'water');
  assert.equal(electric.weight_sum, 134); // 表格 B10
  assert.equal(water.weight_sum, 613); // 表格 B23
  assert.equal(electric.unit_price, Math.round((760.62 / 134) * 1e6) / 1e6); // 表格 F2
  assert.equal(water.unit_price, Math.round((361.9 / 613) * 1e6) / 1e6); // 表格 F14

  assert.equal(roomByNo(result, '201').electric.amount_cents, 17029);
  assert.equal(roomByNo(result, '202').electric.amount_cents, 17029);
  assert.equal(roomByNo(result, '301').electric.amount_cents, 17029);
  assert.equal(roomByNo(result, '302').electric.amount_cents, 13623);
  assert.equal(roomByNo(result, '402').electric.amount_cents, 11352);
  assert.equal(roomByNo(result, '401').electric.amount_cents, 0); // 空系数 => 0 元

  assert.equal(roomByNo(result, '101').water.amount_cents, 3483);
  assert.equal(roomByNo(result, '201').water.amount_cents, 8265);
  assert.equal(roomByNo(result, '202').water.amount_cents, 10509);
  assert.equal(roomByNo(result, '402').water.amount_cents, 6967);

  // 分位精确闭合
  assert.equal(electric.items.reduce((a, i) => a + i.amount_cents, 0), 76062);
  assert.equal(water.items.reduce((a, i) => a + i.amount_cents, 0), 36190);
  assert.equal(result.total_cents, 112252);
  // 两种费用各自的期间被保留
  assert.equal(result.periods.electric.start, '2026-09-01');
  assert.equal(result.periods.water.start, '2026-07-14');
});

test('两种费用可以使用不同计费期间（电费自然月 / 水费两月周期）', () => {
  const rooms = [{ id: 1, room_no: '201', fixed_electric_weight: 30, fixed_water_weight: 1 }];
  const tenants = [{ id: 11, room_id: 1, name: 'A', active: 1, move_in: '2026-08-01', move_out: null }];

  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: {
      electric: { total: 300, mode: 'room-days', period_start: '2026-09-01', period_end: '2026-09-30' },
      water: { total: 64, mode: 'person-days', period_start: '2026-07-14', period_end: '2026-09-15' },
    },
  });

  // 电费期间 30 天，人 9 月整月在住 => 房间天数 30
  assert.equal(roomByNo(result, '201').electric.occupied_days, 30);
  // 水费期间 64 天，但人 8 月 1 日才入住 => 8/1~9/15 = 46 天
  assert.equal(result.periods.water.days, 64);
  assert.equal(roomByNo(result, '201').water.person_days, 46);
  assert.equal(feeOf(result, 'water').weight_sum, 46);
  assert.equal(roomByNo(result, '201').water.amount_cents, 6400);
  assert.equal(feeOf(result, 'electric').weight_sum, 900); // 30 × 30
});

test('费用未指定期间时回落到账单期间', () => {
  const rooms = [{ id: 1, room_no: '201', fixed_electric_weight: 10 }];
  const tenants = [{ id: 11, room_id: 1, name: 'A', active: 1, move_in: '2026-01-01', move_out: null }];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 100, mode: 'room-days' }, water: { total: 0 } },
  });
  assert.equal(result.fees[0].period.start, '2026-09-01');
  assert.equal(result.fees[0].period.days, 30);
  assert.equal(result.rooms[0].electric.occupied_days, 30);
});

test('人天模式：按在住天数自动生成系数，缺省未入住房间为 0', () => {
  const rooms = [
    { id: 1, room_no: '201', fixed_water_weight: 1 },
    { id: 2, room_no: '202', fixed_water_weight: 1 },
  ];
  const tenants = [
    { id: 11, room_id: 1, name: '张伟', active: 1, move_in: '2023-02-01', move_out: null },
    { id: 12, room_id: 1, name: '王芳', active: 1, move_in: '2024-02-27', move_out: null },
    { id: 13, room_id: 2, name: '李娜', active: 1, move_in: '2026-05-01', move_out: '2026-05-15' },
  ];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    fees: { water: { total: 300, mode: 'person-days' }, electric: { total: 0 } },
  });
  assert.equal(roomByNo(result, '201').water.person_days, 62); // 31 + 31
  assert.equal(roomByNo(result, '202').water.person_days, 15);
  const water = feeOf(result, 'water');
  assert.equal(water.weight_sum, 77);
  // 300 元 / 77 人天，合计仍是 300.00
  assert.equal(water.items.reduce((a, i) => a + i.amount_cents, 0), 30000);
  assert.equal(roomByNo(result, '201').water.amount_cents, 24156);
});

test('房间内再按租客人天拆分，且与房间金额闭合', () => {
  const rooms = [{ id: 1, room_no: '201', fixed_water_weight: 1 }];
  const tenants = [
    { id: 11, room_id: 1, name: 'A', active: 1, move_in: '2026-05-01', move_out: null },
    { id: 12, room_id: 1, name: 'B', active: 1, move_in: '2026-05-01', move_out: '2026-05-16' },
  ];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    fees: { water: { total: 100, mode: 'person-days' }, electric: { total: 0 } },
  });
  const room = result.rooms[0];
  assert.equal(room.tenants.reduce((a, t) => a + t.total_share_cents, 0), 10000);
  assert.equal(room.water.tenants[0].share_cents + room.water.tenants[1].share_cents, 10000);
});

test('参数校验：日期非法、结束早于开始、负总额', () => {
  const base = { rooms: [], tenants: [], fees: {} };
  assert.throws(
    () => calc.computeBill({ ...base, period_start: '2026-13-01', period_end: '2026-13-02' }),
    /格式错误/
  );
  assert.throws(() => calc.computeBill({ ...base, period_start: '2026-05-31', period_end: '2026-05-01' }), /不早于/);
  assert.throws(
    () =>
      calc.computeBill({
        ...base,
        period_start: '2026-05-01',
        period_end: '2026-05-31',
        fees: { electric: { total: -1, mode: 'fixed' } },
      }),
    /不能为负数/
  );
  // 单项费用的期间不合法也要报错
  assert.throws(
    () =>
      calc.computeBill({
        ...base,
        period_start: '2026-05-01',
        period_end: '2026-05-31',
        fees: { water: { total: 10, mode: 'person-days', period_start: '2026-09-31', period_end: '2026-10-01' } },
      }),
    /水费的计费期间格式错误/
  );
});

test('总额为 0 或系数全为 0 时给出警告而不是崩溃', () => {
  const rooms = [{ id: 1, room_no: '201', fixed_electric_weight: 0 }];
  const result = calc.computeBill({
    rooms,
    tenants: [],
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    fees: { electric: { total: 100, mode: 'fixed' }, water: { total: 0, mode: 'fixed' } },
  });
  assert.equal(result.rooms[0].total_cents, 0);
  assert.ok(result.warnings.some((w) => w.includes('系数之和为 0')));
  // 金额口径不一致必须显式告警，避免把错账当成正常结果
  assert.ok(result.warnings.some((w) => w.includes('不一致')));
});

test('电费按「房间系数 × 在住天数」：有人住且在住天数不同，分摊不同', () => {
  const rooms = [
    { id: 1, room_no: '201', fixed_electric_weight: 30 },
    { id: 2, room_no: '202', fixed_electric_weight: 30 },
  ];
  const tenants = [
    // 201 有 10 天全员回老家 => 房间在住 20 天
    {
      id: 11,
      room_id: 1,
      name: 'A',
      active: 1,
      move_in: '2023-01-01',
      absences: [{ start_date: '2026-09-11', end_date: '2026-09-20' }],
    },
    { id: 12, room_id: 2, name: 'B', active: 1, move_in: '2023-01-01' },
  ];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 100, mode: 'room-days' }, water: { total: 0 } },
  });
  assert.equal(roomByNo(result, '201').electric.occupied_days, 20);
  assert.equal(roomByNo(result, '202').electric.occupied_days, 30);
  assert.equal(roomByNo(result, '201').water.person_days, 20);
  assert.equal(roomByNo(result, '202').water.person_days, 30);

  const electric = feeOf(result, 'electric');
  // 权重 = 系数 30 × 天数：600 : 900，总 100 元 => 40 : 60
  assert.equal(electric.weight_sum, 1500);
  assert.equal(roomByNo(result, '201').electric.amount_cents, 4000);
  assert.equal(roomByNo(result, '202').electric.amount_cents, 6000);
  assert.equal(electric.items.reduce((a, i) => a + i.amount_cents, 0), 10000);
});

test('电费：房间整月空置（全员退租/回老家）则不分摊电费', () => {
  const rooms = [
    { id: 1, room_no: '201', fixed_electric_weight: 30, fixed_water_weight: 1 },
    { id: 2, room_no: '202', fixed_electric_weight: 30, fixed_water_weight: 1 },
  ];
  const tenants = [
    { id: 11, room_id: 1, name: '已搬走', active: 1, move_in: '2023-01-01', move_out: '2026-08-31' },
    { id: 12, room_id: 2, name: '还在住', active: 1, move_in: '2023-01-01' },
  ];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 300, mode: 'room-days' }, water: { total: 60, mode: 'person-days' } },
  });
  assert.equal(roomByNo(result, '201').electric.occupied_days, 0);
  assert.equal(roomByNo(result, '201').electric.amount_cents, 0);
  assert.equal(roomByNo(result, '201').water.amount_cents, 0);
  // 空置房不参与，整笔费用由 202 承担（单位是「分」）
  assert.equal(roomByNo(result, '202').electric.amount_cents, 30000);
  assert.equal(roomByNo(result, '202').water.amount_cents, 6000);
});

test('电费有人住但固定系数漏填时给出提醒', () => {
  const rooms = [{ id: 1, room_no: '401', fixed_electric_weight: null }];
  const tenants = [{ id: 11, room_id: 1, name: 'A', active: 1, move_in: '2023-01-01' }];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 100, mode: 'room-days' }, water: { total: 0 } },
  });
  assert.ok(result.warnings.some((w) => w.includes('电费系数为 0')));
});

test('水费按人天：回老家的人少摊，且房间内分摊闭合', () => {
  const rooms = [{ id: 1, room_no: '201', fixed_water_weight: 1 }];
  const tenants = [
    { id: 11, room_id: 1, name: '住满', active: 1, move_in: '2023-01-01' },
    {
      id: 12,
      room_id: 1,
      name: '回老家',
      active: 1,
      move_in: '2023-01-01',
      absences: [{ start_date: '2026-09-01', end_date: '2026-09-15' }],
    },
  ];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { water: { total: 45, mode: 'person-days' }, electric: { total: 0 } },
  });
  const room = result.rooms[0];
  assert.equal(room.water.person_days, 45); // 30 + 15
  assert.equal(room.water.amount_cents, 4500);
  const byName = Object.fromEntries(room.water.tenants.map((t) => [t.name, t]));
  assert.equal(byName['住满'].days, 30);
  assert.equal(byName['回老家'].days, 15);
  assert.equal(byName['住满'].share_cents + byName['回老家'].share_cents, 4500);
  // 合并后的住户视图
  assert.equal(room.tenants.length, 2);
});

// ---------------- 商户房：独立电表 + 水费固定人数 ----------------

test('独立电表的房间完全不参与电费分摊（不出现在电费明细、不计入 Σ系数）', () => {
  const rooms = [
    { id: 1, room_no: '101', exclude_electric: 1, fixed_electric_weight: 30 },
    { id: 2, room_no: '201', fixed_electric_weight: 30 },
  ];
  const tenants = [
    { id: 11, room_id: 1, name: '商户', active: 1, move_in: '2023-01-01' },
    { id: 12, room_id: 2, name: '住户', active: 1, move_in: '2023-01-01' },
  ];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { electric: { total: 100, mode: 'room-days' }, water: { total: 0 } },
  });
  const electric = feeOf(result, 'electric');
  assert.equal(electric.items.length, 1, '电费明细只有 201');
  assert.equal(electric.items[0].room_no, '201');
  assert.equal(electric.weight_sum, 900); // 30 × 30，101 不参与
  assert.equal(roomByNo(result, '101').electric, null);
  assert.equal(roomByNo(result, '201').electric.amount_cents, 10000);
  // 不产生「有住户但系数为 0」的误报
  assert.ok(!result.warnings.some((w) => w.includes('101')));
});

test('水费系数参与计算：101 商户水费系数 0.5，权重 = 0.5 × 人天', () => {
  const rooms = [
    { id: 1, room_no: '101', fixed_water_weight: 0.5 },
    { id: 2, room_no: '201', fixed_water_weight: 1 },
  ];
  const tenants = [
    { id: 11, room_id: 1, name: '商户', active: 1, move_in: '2026-01-01' },
    { id: 12, room_id: 2, name: '住户', active: 1, move_in: '2023-01-01' },
  ];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-08-14',
    period_end: '2026-10-15', // 63 天
    fees: { water: { total: 100, mode: 'person-days' }, electric: { total: 0 } },
  });
  const water = feeOf(result, 'water');
  // 101：人天 63 × 系数 0.5 = 31.5；201：63 × 1 = 63；Σ 94.5
  assert.equal(roomByNo(result, '101').water.person_days, 63);
  assert.equal(roomByNo(result, '101').water.weight, 31.5);
  assert.equal(roomByNo(result, '201').water.weight, 63);
  assert.equal(water.weight_sum, 94.5);
  const byNo = Object.fromEntries(water.items.map((i) => [i.room_no, i]));
  assert.equal(byNo['101'].amount_cents, 3333);
  assert.equal(water.items.reduce((a, i) => a + i.amount_cents, 0), 10000);
});

test('水费系数为 0 时该房间不计水费，电费排除标记互不影响', () => {
  const rooms = [
    { id: 1, room_no: '101', exclude_electric: 1, fixed_water_weight: 0 },
    { id: 2, room_no: '201', fixed_water_weight: 1 },
  ];
  const tenants = [{ id: 12, room_id: 2, name: '住户', active: 1, move_in: '2023-01-01' }];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { water: { total: 30, mode: 'person-days' }, electric: { total: 0 } },
  });
  const water = feeOf(result, 'water');
  assert.equal(roomByNo(result, '101').water.weight, 0);
  assert.equal(roomByNo(result, '201').water.amount_cents, 3000);
  assert.equal(water.items.reduce((a, i) => a + i.amount_cents, 0), 3000);
});

// ---------------- 自动账单名称 ----------------

test('自动账单名称：整月写「YYYY年M月电费」，非整月写「起 ~ 止 水费」', () => {
  assert.equal(calc.autoFeeLabel('electric', { start: '2026-09-01', end: '2026-09-30' }), '2026年9月电费');
  assert.equal(calc.autoFeeLabel('water', { start: '2026-02-01', end: '2026-02-28' }), '2026年2月水费');
  assert.equal(
    calc.autoFeeLabel('water', { start: '2026-08-16', end: '2026-10-14' }),
    '2026-08-16 ~ 2026-10-14 水费'
  );
  // 闰年 2 月也算整月
  assert.equal(calc.autoFeeLabel('water', { start: '2028-02-01', end: '2028-02-29' }), '2028年2月水费');

  const result = calc.computeBill({
    rooms: [{ id: 1, room_no: '201', fixed_electric_weight: 1, fixed_water_weight: 1 }],
    tenants: [{ id: 1, room_id: 1, name: 'A', active: 1, move_in: '2026-01-01' }],
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: {
      electric: { total: 100, period_start: '2026-09-01', period_end: '2026-09-30' },
      water: { total: 100, period_start: '2026-08-16', period_end: '2026-10-14' },
    },
  });
  assert.equal(result.fees[0].label, '2026年9月电费');
  assert.equal(result.fees[1].label, '2026-08-16 ~ 2026-10-14 水费');
});

// ---------------- 水费明细里的离住记录 ----------------

test('离住记录按期间裁剪，并保留在租客明细中（供水费账单展示）', () => {
  const rooms = [{ id: 1, room_no: '201', fixed_water_weight: 1, fixed_electric_weight: 1 }];
  const tenants = [
    {
      id: 11,
      room_id: 1,
      name: '张伟',
      active: 1,
      move_in: '2023-01-01',
      absences: [
        { start_date: '2026-08-28', end_date: '2026-09-03', note: '回老家' }, // 与期间部分重叠
        { start_date: '2026-10-01', end_date: '2026-10-05', note: '国庆' }, // 完全在期间外
      ],
    },
  ];
  const result = calc.computeBill({
    rooms,
    tenants,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    fees: { water: { total: 100 }, electric: { total: 0 } },
  });
  const item = result.fees.find((f) => f.key === 'water').items[0];
  assert.deepEqual(item.tenants[0].absences, [
    { start: '2026-09-01', end: '2026-09-03', days: 3, note: '回老家' },
  ]);
  assert.equal(item.tenants[0].days, 27); // 30 - 3
});
