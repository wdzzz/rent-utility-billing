'use strict';

/**
 * 水电费分摊计算核心（纯函数，无 IO，便于单测）
 *
 * 来自《房租水电费计算.xlsx》的规则：
 *   - 每类费用（电费 / 水费）各有一个「总额」和每个房间的「系数」；
 *   - 单价 = 费用总额 ÷ Σ系数；
 *   - 每个房间的费用 = 该房间系数 × 单价；
 *   - 各房间费用之和必须严格等于总额（分位差额用最大余数法补齐，不是「大概相等」）。
 *
 * 实际计费规则：
 *   - 电费：按自然月记账，按「房间系数 × 房间在住天数」分摊，房间空着的日子不计电费；
 *   - 水费：按水表账单周期（一般是两个月：上月 14 号 ~ 次两月 15 号），按「人天」分摊；
 *   - 两张账单的期间不同，所以**每种费用各自带自己的计费期间**，分别计算天数；
 *   - 租客回老家等临时不在住的时段用「离住记录」扣除，不计入在住天数。
 *
 * 系数来源（每种费用可单独选择）：
 *   room-days   : 房间固定系数 × 房间在住天数（电费默认）
 *   person-days : Σ 每位租客在住天数（水费默认）
 *   persons     : 期间内在住人数（不按天折算）
 *   fixed       : 房间固定系数（不按天折算）
 *   manual      : 手工指定每个房间的系数
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 单个计费期间最大天数，防止误输入导致建立超大的按天日历 */
const MAX_PERIOD_DAYS = 10000;

/** 元 -> 分（整数），同时容忍浮点误差 */
function toCents(yuan) {
  const n = Number(yuan);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100);
}

/** 分 -> 元（两位小数的数字） */
function toYuan(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function round4(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 10000) / 10000;
}

/** 'YYYY-MM-DD' -> UTC 毫秒（只用于日期差，避免时区偏移） */
function parseDate(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  return t;
}

function isValidDate(value) {
  return parseDate(value) !== null;
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 计费期间包含首尾两天 */
function periodDays(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (s === null || e === null || e < s) return 0;
  return Math.floor((e - s) / MS_PER_DAY) + 1;
}

function absenceRange(absence) {
  const s = parseDate(absence.start_date !== undefined ? absence.start_date : absence.start);
  const e = parseDate(absence.end_date !== undefined ? absence.end_date : absence.end);
  if (s === null || e === null || e < s) return null;
  return { start: s, end: e };
}

/**
 * 计算租客在计费期间内的「在住日集合」（以期间起始日为 0 的偏移量表示）。
 * 在住区间 = [入住日期, 退租日期] ∩ 期间，再减去所有「离住记录」。
 */
function tenantPresenceOffsets(tenant, start, end, absences = []) {
  const s = parseDate(start);
  const e = parseDate(end);
  const offsets = new Set();
  if (s === null || e === null || e < s) return offsets;
  if (tenant.active !== undefined && !Number(tenant.active)) return offsets;

  const movedIn = tenant.move_in ? parseDate(tenant.move_in) : null;
  const movedOut = tenant.move_out ? parseDate(tenant.move_out) : null;
  if (tenant.move_in && movedIn === null) return offsets;
  if (tenant.move_out && movedOut === null) return offsets;

  const from = Math.max(s, movedIn === null ? s : movedIn);
  const to = Math.min(e, movedOut === null ? e : movedOut);
  if (to < from) return offsets;

  for (let t = from; t <= to; t += MS_PER_DAY) {
    offsets.add(Math.round((t - s) / MS_PER_DAY));
  }

  // 扣除离住（回老家）时段
  const list = Array.isArray(absences) ? absences : [];
  for (const absence of list) {
    const r = absenceRange(absence);
    if (!r) continue;
    const aFrom = Math.max(r.start, s);
    const aTo = Math.min(r.end, e);
    if (aTo < aFrom) continue;
    for (let t = aFrom; t <= aTo; t += MS_PER_DAY) {
      offsets.delete(Math.round((t - s) / MS_PER_DAY));
    }
  }
  return offsets;
}

/**
 * 某位租客在期间内的在住天数（已扣除回老家时段）。
 * 没有入住日期时视为期间开始即入住；没有退租日期时视为一直住到期间结束。
 */
function tenantDaysInPeriod(tenant, start, end, absences) {
  // 不显式传 absences 时，使用租客自身的离住记录
  const list = absences === undefined ? tenant.absences || [] : absences;
  return tenantPresenceOffsets(tenant, start, end, list).size;
}

/** 期间内的离住记录（裁剪到计费期间，用于账单里展示） */
function absencesInPeriod(tenant, start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (s === null || e === null || e < s) return [];
  const out = [];
  for (const absence of tenant.absences || []) {
    const r = absenceRange(absence);
    if (!r) continue;
    const from = Math.max(r.start, s);
    const to = Math.min(r.end, e);
    if (to < from) continue;
    out.push({
      start: formatDate(new Date(from)),
      end: formatDate(new Date(to)),
      days: Math.floor((to - from) / MS_PER_DAY) + 1,
      note: String(absence.note || ''),
    });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

/** 期间内的离住天数（用于界面提示，不参与计算） */
function countAbsenceDays(tenant, start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (s === null || e === null) return 0;
  let count = 0;
  for (const absence of tenant.absences || []) {
    const r = absenceRange(absence);
    if (!r) continue;
    const from = Math.max(r.start, s);
    const to = Math.min(r.end, e);
    if (to < from) continue;
    count += Math.floor((to - from) / MS_PER_DAY) + 1;
  }
  return count;
}

/**
 * 统计每个房间在期间内的入住情况：
 *   persons      期间内至少住过一天的人数
 *   personDays   Σ 每位租客在住天数（水费口径）
 *   occupiedDays 房间「有人在住」的天数（电费口径，全员回老家/空置则不计）
 *   tenants      每位租客的姓名与在住天数
 */
function computeOccupancy(rooms, tenants, start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  const total = s !== null && e !== null && e >= s ? Math.floor((e - s) / MS_PER_DAY) + 1 : 0;
  if (total > MAX_PERIOD_DAYS) {
    throw new Error(`计费期间过长（${total} 天），请检查日期`);
  }

  const map = new Map();
  for (const room of rooms) {
    map.set(room.id, {
      room_id: room.id,
      room_no: room.room_no,
      persons: 0,
      personDays: 0,
      occupiedDays: 0,
      tenants: [],
    });
  }

  const roomDaySets = new Map();
  for (const tenant of tenants) {
    const room = map.get(tenant.room_id);
    if (!room) continue;
    if (tenant.active !== undefined && !Number(tenant.active)) continue;

    // 租客在期间内的「入住窗口」，即使整段都在老家也保留，方便账单里展示离住记录
    const movedIn = tenant.move_in ? parseDate(tenant.move_in) : null;
    const movedOut = tenant.move_out ? parseDate(tenant.move_out) : null;
    if (tenant.move_in && movedIn === null) continue;
    if (tenant.move_out && movedOut === null) continue;
    const windowFrom = Math.max(s, movedIn === null ? s : movedIn);
    const windowTo = Math.min(e, movedOut === null ? e : movedOut);
    if (windowTo < windowFrom) continue;

    const offsets = tenantPresenceOffsets(tenant, start, end, tenant.absences || []);
    if (offsets.size > 0) {
      room.persons += 1;
      room.personDays += offsets.size;
      if (!roomDaySets.has(tenant.room_id)) roomDaySets.set(tenant.room_id, new Set());
      const set = roomDaySets.get(tenant.room_id);
      for (const d of offsets) set.add(d);
    }
    room.tenants.push({
      id: tenant.id,
      name: tenant.name,
      days: offsets.size,
      absence_days: countAbsenceDays(tenant, start, end),
      absences: absencesInPeriod(tenant, start, end),
    });
  }
  for (const [roomId, set] of roomDaySets) {
    const room = map.get(roomId);
    if (room) room.occupiedDays = set.size;
  }
  return map;
}

/**
 * 按权重把总金额（分）精确拆分：最大余数法，保证 Σ结果 === totalCents。
 */
function allocateByWeight(totalCents, weights) {
  const total = Math.round(Number(totalCents) || 0);
  const sum = weights.reduce((a, b) => a + (Number(b) || 0), 0);
  if (!(sum > 0) || weights.length === 0) {
    return weights.map(() => 0);
  }
  const exact = weights.map((w) => (total * (Number(w) || 0)) / sum);
  const floored = exact.map((v) => Math.floor(v + 1e-9));
  let remainder = total - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v + 1e-9), w: Number(weights[i]) || 0 }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);

  let k = 0;
  while (remainder > 0 && order.length > 0) {
    floored[order[k % order.length].i] += 1;
    remainder -= 1;
    k += 1;
  }
  while (remainder < 0) {
    // 防御性兜底，理论上不会发生
    const target = order[order.length - 1 - (k % order.length)].i;
    if (floored[target] > 0) {
      floored[target] -= 1;
      remainder += 1;
    } else {
      break;
    }
    k += 1;
  }
  return floored;
}

const FEE_DEFS = [
  { key: 'electric', name: '电费' },
  { key: 'water', name: '水费' },
];

const WEIGHT_MODES = ['room-days', 'person-days', 'persons', 'fixed', 'manual'];

const WEIGHT_MODE_LABELS = {
  'room-days': '按房间系数 × 在住天数',
  'person-days': '按人天（人数 × 在住天数）',
  persons: '按人数',
  fixed: '按房间固定系数（不按天折算）',
  manual: '手动填写系数',
};

function fixedWeightOf(room, feeKey) {
  const fixed = feeKey === 'electric' ? room.fixed_electric_weight : room.fixed_water_weight;
  if (fixed === null || fixed === undefined || fixed === '') return 0;
  return Math.max(0, Number(fixed) || 0);
}

/**
 * 计算某个房间在某项费用上的原始权重。
 */
function resolveWeight(mode, room, occupancy, feeKey, manualValue) {
  const occ = occupancy || { persons: 0, personDays: 0, occupiedDays: 0 };
  // 房间固定系数：电费系数 / 水费系数，都参与计算（默认 1，商户可手动改 0 或 0.5）
  const coef = fixedWeightOf(room, feeKey);
  switch (mode) {
    case 'room-days':
      // 按房间 + 按天：系数 × 该房间有人住的天数
      return coef * (Number(occ.occupiedDays) || 0);
    case 'person-days':
      // 按人数 + 按天：系数 × 人天
      return coef * (Number(occ.personDays) || 0);
    case 'persons':
      return coef * (Number(occ.persons) || 0);
    case 'manual':
      // 未手工填写时按该费用的常规口径预填：电费 = 系数×天数，水费 = 系数×人天
      if (manualValue === null || manualValue === undefined) {
        return feeKey === 'electric'
          ? coef * (Number(occ.occupiedDays) || 0)
          : coef * (Number(occ.personDays) || 0);
      }
      return Math.max(0, Number(manualValue) || 0);
    case 'fixed':
    default:
      return coef;
  }
}

/** 期间是否正好是一个自然月（用于把账单名写成「2026年9月电费」） */
function isFullNaturalMonth(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (s === null || e === null) return false;
  const sd = new Date(s);
  const ed = new Date(e);
  const lastDay = new Date(Date.UTC(ed.getUTCFullYear(), ed.getUTCMonth() + 1, 0)).getUTCDate();
  return (
    sd.getUTCDate() === 1 &&
    sd.getUTCFullYear() === ed.getUTCFullYear() &&
    sd.getUTCMonth() === ed.getUTCMonth() &&
    ed.getUTCDate() === lastDay
  );
}

/**
 * 自动生成账单名称：日期 + 电费/水费
 *   整月   -> 2026年9月电费
 *   非整月 -> 2026-08-16 ~ 2026-10-14 水费
 */
function autoFeeLabel(feeKey, period) {
  const name = feeKey === 'water' ? '水费' : '电费';
  if (isFullNaturalMonth(period.start, period.end)) {
    const d = new Date(parseDate(period.start));
    return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${name}`;
  }
  return `${period.start} ~ ${period.end} ${name}`;
}

/** 解析某项费用的计费期间：优先用该费用自己的，缺省用账单期间 */
function resolveFeePeriod(conf, fallbackStart, fallbackEnd, feeName) {
  const start = (conf && conf.period_start) || fallbackStart;
  const end = (conf && conf.period_end) || fallbackEnd;
  if (!isValidDate(start) || !isValidDate(end)) {
    throw new Error(`${feeName}的计费期间格式错误，应为 YYYY-MM-DD`);
  }
  const days = periodDays(start, end);
  if (days <= 0) throw new Error(`${feeName}的结束日期必须不早于开始日期`);
  if (days > MAX_PERIOD_DAYS) throw new Error(`${feeName}的计费期间过长（${days} 天）`);
  return { start, end, days };
}

/**
 * 计算一张账单（电费、水费各自的计费期间可以不同）。
 *
 * @param {object} input
 * @param {Array} input.rooms 参与分摊的房间
 * @param {Array} input.tenants 全部租客（含 absences 离住记录）
 * @param {string} [input.period_start] 账单默认期间（费用未单独指定时使用）
 * @param {string} [input.period_end]
 * @param {object} input.fees {
 *   electric: { total, mode, period_start?, period_end? },
 *   water:    { total, mode, period_start?, period_end? }
 * }
 * @param {object} [input.overrides] 手工系数 { electric: { [room_id]: weight }, water: {...} }
 */
function computeBill(input) {
  const { rooms = [], tenants = [], period_start, period_end, fees = {}, overrides = {} } = input || {};
  const warnings = [];

  const fallbackStart = period_start;
  const fallbackEnd = period_end;
  if (!isValidDate(fallbackStart) || !isValidDate(fallbackEnd)) {
    throw new Error('账单期间格式错误，应为 YYYY-MM-DD');
  }
  if (periodDays(fallbackStart, fallbackEnd) <= 0) {
    throw new Error('账单结束日期必须不早于开始日期');
  }

  const feeResults = [];
  const roomMap = new Map();
  for (const room of rooms) {
    roomMap.set(room.id, {
      room_id: room.id,
      room_no: room.room_no,
      electric: null,
      water: null,
      total_cents: 0,
      tenants: [],
    });
  }

  for (const fee of FEE_DEFS) {
    const conf = fees[fee.key] || {};
    const period = resolveFeePeriod(conf, fallbackStart, fallbackEnd, fee.name);
    const occupancy = computeOccupancy(rooms, tenants, period.start, period.end);
    const mode = WEIGHT_MODES.includes(conf.mode) ? conf.mode : 'person-days';
    const totalCents = toCents(conf.total === undefined || conf.total === null ? 0 : conf.total);
    if (totalCents < 0) throw new Error(`${fee.name}总额不能为负数`);

    const manual = overrides[fee.key] || {};
    // 独立电表的房间（商户等）不参与电费分摊
    const participants =
      fee.key === 'electric' ? rooms.filter((room) => !Number(room.exclude_electric)) : rooms;

    const rows = participants.map((room) => {
      const occ = occupancy.get(room.id) || { persons: 0, personDays: 0, occupiedDays: 0, tenants: [] };
      const mv = Object.prototype.hasOwnProperty.call(manual, room.id) ? manual[room.id] : manual[String(room.id)];
      const weight = round4(resolveWeight(mode, room, occ, fee.key, mv));
      return { room, occ, weight };
    });

    const weightSum = round4(rows.reduce((a, r) => a + r.weight, 0));

    if (totalCents > 0 && weightSum <= 0) {
      warnings.push(`${fee.name}总额为 ${toYuan(totalCents)} 元，但所有房间系数之和为 0，无法分摊`);
    }
    if (totalCents === 0) {
      warnings.push(`${fee.name}总额为 0`);
    }
    // 有人住却算不出系数，多半是固定系数漏填，提醒但不算错
    for (const r of rows) {
      if (totalCents > 0 && r.weight === 0 && (r.occ.occupiedDays > 0 || r.occ.persons > 0)) {
        warnings.push(
          `房间 ${r.room.room_no} 本期有 ${r.occ.occupiedDays} 天有人住，但${fee.name}系数为 0，未参与${fee.name}分摊（如为漏填请补上房间系数）`
        );
      }
    }

    const amounts = weightSum > 0 ? allocateByWeight(totalCents, rows.map((r) => r.weight)) : rows.map(() => 0);

    const items = rows.map((r, idx) => {
      const entry = roomMap.get(r.room.id);
      // 房间内部按租客在住天数分摊该费用
      const shareCents = allocateByWeight(amounts[idx], r.occ.tenants.map((t) => t.days));
      const tenantsDetail = r.occ.tenants.map((t, i) => ({
        id: t.id,
        name: t.name,
        days: t.days,
        absence_days: t.absence_days || 0,
        absences: t.absences || [],
        share_cents: shareCents[i] || 0,
        share_yuan: toYuan(shareCents[i] || 0),
      }));
      const detail = {
        persons: r.occ.persons,
        occupied_days: r.occ.occupiedDays,
        person_days: round2(r.occ.personDays),
        weight: r.weight,
        amount_cents: amounts[idx],
        amount_yuan: toYuan(amounts[idx]),
        tenants: tenantsDetail,
      };
      if (fee.key === 'electric') {
        entry.electric = detail;
      } else {
        entry.water = detail;
      }
      entry.total_cents += amounts[idx];
      return {
        room_id: r.room.id,
        room_no: r.room.room_no,
        persons: r.occ.persons,
        occupied_days: r.occ.occupiedDays,
        person_days: round2(r.occ.personDays),
        weight: r.weight,
        amount_cents: amounts[idx],
        amount_yuan: toYuan(amounts[idx]),
        tenants: tenantsDetail,
      };
    });

    feeResults.push({
      key: fee.key,
      name: fee.name,
      label: autoFeeLabel(fee.key, period),
      mode,
      mode_label: WEIGHT_MODE_LABELS[mode],
      period,
      total_cents: totalCents,
      total_yuan: toYuan(totalCents),
      weight_sum: weightSum,
      unit_price: weightSum > 0 ? Math.round((toYuan(totalCents) / weightSum) * 1e6) / 1e6 : 0,
      items,
    });
  }

  // 合并每间房的电费 + 水费，并合并住户分摊（同一位租客在两个期间的天数可能不同）
  for (const entry of roomMap.values()) {
    const byTenant = new Map();
    for (const key of ['electric', 'water']) {
      const detail = entry[key];
      if (!detail) continue;
      for (const t of detail.tenants) {
        const key2 = t.id !== undefined && t.id !== null ? `id:${t.id}` : `name:${t.name}`;
        if (!byTenant.has(key2)) {
          byTenant.set(key2, {
            name: t.name,
            electric_days: 0,
            electric_share_cents: 0,
            water_days: 0,
            water_share_cents: 0,
            total_share_cents: 0,
          });
        }
        const agg = byTenant.get(key2);
        if (key === 'electric') {
          agg.electric_days = t.days;
          agg.electric_share_cents += t.share_cents;
        } else {
          agg.water_days = t.days;
          agg.water_share_cents += t.share_cents;
        }
        agg.total_share_cents += t.share_cents;
      }
    }
    entry.tenants = [...byTenant.values()].map((t) => ({
      ...t,
      electric_share_yuan: toYuan(t.electric_share_cents),
      water_share_yuan: toYuan(t.water_share_cents),
      total_share_yuan: toYuan(t.total_share_cents),
    }));
    entry.total_yuan = toYuan(entry.total_cents);
  }

  const roomRows = [...roomMap.values()];
  const totalCents = feeResults.reduce((a, f) => a + f.total_cents, 0);
  const allocatedCents = roomRows.reduce((a, r) => a + r.total_cents, 0);
  if (allocatedCents !== totalCents) {
    warnings.push(
      `各房间分配合计 ${toYuan(allocatedCents)} 元与费用总额 ${toYuan(totalCents)} 元不一致，请检查系数设置`
    );
  }

  return {
    // 账单主期间取电费期间（列表、排序用），两种费用各自的期间见 fees[].period
    period: { start: fallbackStart, end: fallbackEnd, days: periodDays(fallbackStart, fallbackEnd) },
    periods: Object.fromEntries(feeResults.map((f) => [f.key, f.period])),
    fees: feeResults,
    rooms: roomRows,
    total_cents: totalCents,
    total_yuan: toYuan(totalCents),
    warnings,
  };
}

module.exports = {
  FEE_DEFS,
  WEIGHT_MODES,
  WEIGHT_MODE_LABELS,
  toCents,
  toYuan,
  round2,
  round4,
  parseDate,
  isValidDate,
  formatDate,
  periodDays,
  tenantPresenceOffsets,
  tenantDaysInPeriod,
  absencesInPeriod,
  computeOccupancy,
  allocateByWeight,
  resolveWeight,
  resolveFeePeriod,
  isFullNaturalMonth,
  autoFeeLabel,
  computeBill,
};
