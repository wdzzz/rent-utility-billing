'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  room_no               TEXT    NOT NULL UNIQUE,
  note                  TEXT    NOT NULL DEFAULT '',
  fixed_electric_weight REAL,
  fixed_water_weight    REAL,
  -- 独立电表：不参与电费分摊
  exclude_electric      INTEGER NOT NULL DEFAULT 0,
  -- 水费固定人数：设置后水费按「该人数 × 期间天数」计，不再按住户人天（如商户 0.5 人）
  water_fixed_persons   REAL,
  sort                  INTEGER NOT NULL DEFAULT 0,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS tenants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES rooms(id),
  name       TEXT    NOT NULL,
  phone      TEXT    NOT NULL DEFAULT '',
  id_card    TEXT    NOT NULL DEFAULT '',
  move_in    TEXT,
  move_out   TEXT,
  note       TEXT    NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenants_room ON tenants(room_id);

-- 离住记录：租客回老家 / 临时不在住的时间段（计入期间但不计在住天数）
CREATE TABLE IF NOT EXISTS absences (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  start_date TEXT    NOT NULL,
  end_date   TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_absences_tenant ON absences(tenant_id);

CREATE TABLE IF NOT EXISTS bills (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  fee_key               TEXT,
  total_cents           INTEGER NOT NULL DEFAULT 0,
  mode                  TEXT    NOT NULL DEFAULT 'person-days',
  unit_price            REAL    NOT NULL DEFAULT 0,
  label                 TEXT    NOT NULL,
  period_start          TEXT    NOT NULL,
  period_end            TEXT    NOT NULL,
  electric_period_start TEXT,
  electric_period_end   TEXT,
  water_period_start    TEXT,
  water_period_end      TEXT,
  electric_total_cents  INTEGER NOT NULL DEFAULT 0,
  water_total_cents     INTEGER NOT NULL DEFAULT 0,
  electric_mode         TEXT    NOT NULL DEFAULT 'person-days',
  water_mode            TEXT    NOT NULL DEFAULT 'person-days',
  electric_unit_price   REAL    NOT NULL DEFAULT 0,
  water_unit_price      REAL    NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'final',
  note                  TEXT    NOT NULL DEFAULT '',
  snapshot_json         TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS bill_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id         INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  room_id         INTEGER,
  room_no         TEXT    NOT NULL,
  persons         INTEGER NOT NULL DEFAULT 0,
  person_days     REAL    NOT NULL DEFAULT 0,
  days            REAL    NOT NULL DEFAULT 0,
  weight          REAL    NOT NULL DEFAULT 0,
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  electric_days   REAL    NOT NULL DEFAULT 0,
  electric_persons INTEGER NOT NULL DEFAULT 0,
  water_days      REAL    NOT NULL DEFAULT 0,
  water_persons   INTEGER NOT NULL DEFAULT 0,
  electric_weight REAL    NOT NULL DEFAULT 0,
  water_weight    REAL    NOT NULL DEFAULT 0,
  electric_cents  INTEGER NOT NULL DEFAULT 0,
  water_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL DEFAULT 0,
  tenants_json    TEXT    NOT NULL DEFAULT '[]',
  seq             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);
`;

/** 表格中的房间与人员初始数据（来源于《房租水电费计算.xlsx》） */
// 统一口径：房间固定系数（电费系数 / 水费系数）都参与计算，默认都是 1；
// 101 商户：电费 0（独立电表）、水费 0.5，可手动调整
const SEED_ROOMS = [
  { room_no: '101', electric: 0, water: 0.5, sort: 1, note: '商户，独立电表', excludeElectric: 1, waterFixedPersons: null },
  { room_no: '201', electric: 1, water: 1, sort: 2, note: '' },
  { room_no: '202', electric: 1, water: 1, sort: 3, note: '' },
  { room_no: '301', electric: 1, water: 1, sort: 4, note: '9月24离，10月5回' },
  { room_no: '302', electric: 1, water: 1, sort: 5, note: '' },
  { room_no: '401', electric: 1, water: 1, sort: 6, note: '2月11离开，2月24日返回' },
  { room_no: '402', electric: 1, water: 1, sort: 7, note: '9/20离，10月5回' },
];

// 演示用匿名数据（姓名、电话、身份证均为虚构，仅用于首次启动的示例）
const SEED_TENANTS = [
  { room_no: '101', name: '商户', phone: '', id_card: '', move_in: '2026-01-01' },
  { room_no: '201', name: '张伟', phone: '13800000001', id_card: '110101199001010011', move_in: '2023-02-01' },
  { room_no: '201', name: '王芳', phone: '13800000002', id_card: '110101199001010022', move_in: '2024-02-27' },
  { room_no: '202', name: '李娜', phone: '13800000003', id_card: '110101199001010033', move_in: '2024-02-27' },
  { room_no: '202', name: '刘洋', phone: '13800000004', id_card: '110101199001010044', move_in: '2024-02-27' },
  { room_no: '301', name: '陈静', phone: '13800000005', id_card: '110101199001010055', move_in: '2023-05-18' },
  { room_no: '302', name: '赵磊', phone: '13800000006', id_card: '110101199001010066', move_in: '2023-04-10' },
  { room_no: '401', name: '孙丽', phone: '13800000007', id_card: '110101199001010077', move_in: '2025-02-08' },
  { room_no: '402', name: '周涛', phone: '13800000008', id_card: '110101199001010088', move_in: '2023-01-01' },
  { room_no: '402', name: '吴敏', phone: '13800000009', id_card: '110101199001010099', move_in: '2023-01-01' },
];

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** 轻量迁移：给旧数据库补上后加的列（CREATE TABLE IF NOT EXISTS 不会改动已存在的表） */
  #migrate() {
    const itemCols = this.db.prepare('PRAGMA table_info(bill_items)').all().map((c) => c.name);
    const itemAdds = [
      ['occupied_days', 'ALTER TABLE bill_items ADD COLUMN occupied_days REAL NOT NULL DEFAULT 0'],
      ['electric_days', 'ALTER TABLE bill_items ADD COLUMN electric_days REAL NOT NULL DEFAULT 0'],
      ['electric_persons', 'ALTER TABLE bill_items ADD COLUMN electric_persons INTEGER NOT NULL DEFAULT 0'],
      ['water_days', 'ALTER TABLE bill_items ADD COLUMN water_days REAL NOT NULL DEFAULT 0'],
      ['water_persons', 'ALTER TABLE bill_items ADD COLUMN water_persons INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [col, ddl] of itemAdds) {
      if (!itemCols.includes(col)) this.db.exec(ddl);
    }

    const itemAdds2 = [
      ['days', 'ALTER TABLE bill_items ADD COLUMN days REAL NOT NULL DEFAULT 0'],
      ['weight', 'ALTER TABLE bill_items ADD COLUMN weight REAL NOT NULL DEFAULT 0'],
      ['amount_cents', 'ALTER TABLE bill_items ADD COLUMN amount_cents INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [col, ddl] of itemAdds2) {
      if (!itemCols.includes(col)) this.db.exec(ddl);
    }

    const billCols = this.db.prepare('PRAGMA table_info(bills)').all().map((c) => c.name);
    const billAdds = [
      ['electric_period_start', 'ALTER TABLE bills ADD COLUMN electric_period_start TEXT'],
      ['electric_period_end', 'ALTER TABLE bills ADD COLUMN electric_period_end TEXT'],
      ['water_period_start', 'ALTER TABLE bills ADD COLUMN water_period_start TEXT'],
      ['water_period_end', 'ALTER TABLE bills ADD COLUMN water_period_end TEXT'],
      ['fee_key', 'ALTER TABLE bills ADD COLUMN fee_key TEXT'],
      ['total_cents', 'ALTER TABLE bills ADD COLUMN total_cents INTEGER NOT NULL DEFAULT 0'],
      ['mode', "ALTER TABLE bills ADD COLUMN mode TEXT NOT NULL DEFAULT 'person-days'"],
      ['unit_price', 'ALTER TABLE bills ADD COLUMN unit_price REAL NOT NULL DEFAULT 0'],
    ];
    for (const [col, ddl] of billAdds) {
      if (!billCols.includes(col)) this.db.exec(ddl);
    }

    // 独立电表 / 水费固定人数：仅在本列第一次添加时给 101 初始化商户配置
    const roomCols = this.db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
    let roomFieldsAdded = false;
    if (!roomCols.includes('exclude_electric')) {
      this.db.exec('ALTER TABLE rooms ADD COLUMN exclude_electric INTEGER NOT NULL DEFAULT 0');
      roomFieldsAdded = true;
    }
    if (!roomCols.includes('water_fixed_persons')) {
      this.db.exec('ALTER TABLE rooms ADD COLUMN water_fixed_persons REAL');
      roomFieldsAdded = true;
    }
    if (roomFieldsAdded) {
      // 101 室：商户、独立电表、水费按 0.5 人
      this.db
        .prepare(
          `UPDATE rooms SET exclude_electric = 1, water_fixed_persons = 0.5, note = ?
            WHERE room_no = '101'`
        )
        .run('商户，独立电表');
    }

    // 口径升级（只执行一次）：电费系数 商户 0 / 其他 1；水费 商户固定 0.5 人，其他按入住人数
    const upgraded = this.db
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get('coefficients_v2');
    if (!upgraded) {
      this.db
        .prepare(
          `UPDATE rooms SET fixed_electric_weight = 1, exclude_electric = 0, water_fixed_persons = NULL
            WHERE room_no <> '101'`
        )
        .run();
      this.db
        .prepare(
          `UPDATE rooms SET fixed_electric_weight = 0, exclude_electric = 1, water_fixed_persons = 0.5,
                            note = CASE WHEN note = '' THEN '商户，独立电表' ELSE note END
            WHERE room_no = '101'`
        )
        .run();
      this.db
        .prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
        .run('coefficients_v2', nowLocal());
    }

    // 口径升级 v3（只执行一次）：电费系数 / 水费系数默认 1；101 商户电费 0、水费 0.5
    const upgradedV3 = this.db
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get('coefficients_v3');
    if (!upgradedV3) {
      this.db
        .prepare(
          `UPDATE rooms SET fixed_electric_weight = 1, fixed_water_weight = 1,
                            exclude_electric = 0, water_fixed_persons = NULL
            WHERE room_no <> '101'`
        )
        .run();
      this.db
        .prepare(
          `UPDATE rooms SET fixed_electric_weight = 0, fixed_water_weight = 0.5,
                            exclude_electric = 1, water_fixed_persons = NULL,
                            note = CASE WHEN note = '' THEN '商户，独立电表' ELSE note END
            WHERE room_no = '101'`
        )
        .run();
      this.db
        .prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
        .run('coefficients_v3', nowLocal());
    }

    // 旧版「水电合并」账单拆成「电费」「水费」两条记录
    this.#splitLegacyBills();
  }

  /** 把旧版合并账单（fee_key 为空）按费用拆成独立记录，保留原有金额与明细 */
  #splitLegacyBills() {
    const legacy = this.db.prepare('SELECT * FROM bills WHERE fee_key IS NULL').all();
    if (!legacy.length) return;

    const insertBill = this.db.prepare(
      `INSERT INTO bills (fee_key, label, period_start, period_end, total_cents, mode, unit_price,
                          status, note, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertItem = this.db.prepare(
      `INSERT INTO bill_items (bill_id, room_id, room_no, persons, days, weight, amount_cents, tenants_json, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.exec('BEGIN');
    try {
      for (const bill of legacy) {
        const snap = safeJson(bill.snapshot_json, null);
        const fees = snap && Array.isArray(snap.fees) ? snap.fees : [];
        const rooms = snap && Array.isArray(snap.rooms) ? snap.rooms : [];
        let created = 0;

        for (const key of ['electric', 'water']) {
          const fee = fees.find((f) => f.key === key);
          const oldTotal = key === 'electric' ? bill.electric_total_cents : bill.water_total_cents;
          const totalCents = fee ? fee.total_cents : oldTotal;
          if (!totalCents || totalCents <= 0) continue; // 0 元账单不单列

          const period = (fee && fee.period) || {
            start: bill[key + '_period_start'] || bill.period_start,
            end: bill[key + '_period_end'] || bill.period_end,
          };
          const info = insertBill.run(
            key,
            feeLabel(bill.label, key),
            period.start,
            period.end,
            totalCents,
            (fee && fee.mode) || (key === 'electric' ? bill.electric_mode : bill.water_mode) || 'person-days',
            (fee && fee.unit_price) || 0,
            bill.status,
            bill.note,
            bill.snapshot_json,
            bill.created_at
          );
          const billId = Number(info.lastInsertRowid);
          let seq = 0;
          for (const room of rooms) {
            const detail = room[key];
            if (!detail) continue;
            insertItem.run(
              billId,
              room.room_id,
              room.room_no,
              detail.persons || 0,
              key === 'electric' ? detail.occupied_days || 0 : detail.person_days || 0,
              detail.weight || 0,
              detail.amount_cents || 0,
              JSON.stringify(detail.tenants || []),
              seq++
            );
          }
          created += 1;
        }

        // 极少数没有快照的历史数据：保留为一条电费账单，避免丢记录
        if (!created) {
          insertBill.run(
            'electric',
            feeLabel(bill.label, 'electric'),
            bill.period_start,
            bill.period_end,
            bill.electric_total_cents || 0,
            bill.electric_mode || 'person-days',
            bill.electric_unit_price || 0,
            bill.status,
            bill.note,
            bill.snapshot_json,
            bill.created_at
          );
        }

        this.db.prepare('DELETE FROM bill_items WHERE bill_id = ?').run(bill.id);
        this.db.prepare('DELETE FROM bills WHERE id = ?').run(bill.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // ---------- 房间 ----------
  listRooms() {
    const rooms = this.db
      .prepare('SELECT * FROM rooms WHERE active = 1 ORDER BY sort, room_no')
      .all()
      .map((r) => ({ ...r }));
    const absences = this.db
      .prepare('SELECT * FROM absences ORDER BY start_date, id')
      .all()
      .map((a) => ({ ...a }));
    const byTenant = new Map();
    for (const a of absences) {
      if (!byTenant.has(a.tenant_id)) byTenant.set(a.tenant_id, []);
      byTenant.get(a.tenant_id).push(a);
    }
    const tenants = this.db
      .prepare('SELECT * FROM tenants ORDER BY id')
      .all()
      .map((t) => ({ ...t, absences: byTenant.get(t.id) || [] }));
    const byRoom = new Map();
    for (const t of tenants) {
      if (!byRoom.has(t.room_id)) byRoom.set(t.room_id, []);
      byRoom.get(t.room_id).push(t);
    }
    return rooms.map((r) => ({ ...r, tenants: byRoom.get(r.id) || [] }));
  }

  getRoom(id) {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    return row ? { ...row } : null;
  }

  createRoom(data) {
    const roomNo = String(data.room_no || '').trim();
    if (!roomNo) throw new HttpError(400, '房号不能为空');
    const dup = this.db.prepare('SELECT id FROM rooms WHERE room_no = ?').get(roomNo);
    if (dup) throw new HttpError(409, `房号 ${roomNo} 已存在`);
    const info = this.db
      .prepare(
        `INSERT INTO rooms (room_no, note, fixed_electric_weight, fixed_water_weight,
                            exclude_electric, water_fixed_persons, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        roomNo,
        String(data.note || ''),
        nullableNumber(data.fixed_electric_weight),
        nullableNumber(data.fixed_water_weight),
        data.exclude_electric ? 1 : 0,
        nullableNumber(data.water_fixed_persons),
        Number.isFinite(Number(data.sort)) ? Number(data.sort) : 99
      );
    return this.getRoom(Number(info.lastInsertRowid));
  }

  updateRoom(id, data) {
    const room = this.getRoom(id);
    if (!room) throw new HttpError(404, '房间不存在');
    const roomNo = String(data.room_no || room.room_no).trim();
    const dup = this.db.prepare('SELECT id FROM rooms WHERE room_no = ? AND id <> ?').get(roomNo, id);
    if (dup) throw new HttpError(409, `房号 ${roomNo} 已存在`);
    this.db
      .prepare(
        `UPDATE rooms SET room_no = ?, note = ?, fixed_electric_weight = ?, fixed_water_weight = ?,
                          exclude_electric = ?, water_fixed_persons = ?,
                          sort = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        roomNo,
        String(data.note ?? room.note ?? ''),
        data.fixed_electric_weight === undefined
          ? room.fixed_electric_weight
          : nullableNumber(data.fixed_electric_weight),
        data.fixed_water_weight === undefined
          ? room.fixed_water_weight
          : nullableNumber(data.fixed_water_weight),
        data.exclude_electric === undefined ? room.exclude_electric : data.exclude_electric ? 1 : 0,
        data.water_fixed_persons === undefined
          ? room.water_fixed_persons
          : nullableNumber(data.water_fixed_persons),
        data.sort === undefined ? room.sort : Number(data.sort) || 99,
        nowLocal(),
        id
      );
    return this.getRoom(id);
  }

  deleteRoom(id) {
    const room = this.getRoom(id);
    if (!room) throw new HttpError(404, '房间不存在');
    const used = this.db.prepare('SELECT COUNT(*) AS n FROM bill_items WHERE room_id = ?').get(id);
    if (used.n > 0) {
      // 历史账单引用过该房间：只做停用，保证历史可追溯
      this.db.prepare('UPDATE rooms SET active = 0, updated_at = ? WHERE id = ?').run(nowLocal(), id);
      return { deleted: false, deactivated: true };
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM tenants WHERE room_id = ?').run(id);
      this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { deleted: true, deactivated: false };
  }

  // ---------- 租客 ----------
  listTenants(roomId) {
    const rows = roomId
      ? this.db.prepare('SELECT * FROM tenants WHERE room_id = ? ORDER BY id').all(roomId)
      : this.db.prepare('SELECT * FROM tenants ORDER BY room_id, id').all();
    const absences = this.db.prepare('SELECT * FROM absences ORDER BY start_date, id').all();
    const byTenant = new Map();
    for (const a of absences) {
      if (!byTenant.has(a.tenant_id)) byTenant.set(a.tenant_id, []);
      byTenant.get(a.tenant_id).push({ ...a });
    }
    return rows.map((r) => ({ ...r, absences: byTenant.get(r.id) || [] }));
  }

  // ---------- 离住记录（回老家） ----------
  listAbsences(tenantId) {
    return this.db
      .prepare('SELECT * FROM absences WHERE tenant_id = ? ORDER BY start_date, id')
      .all(tenantId)
      .map((a) => ({ ...a }));
  }

  createAbsence(tenantId, data) {
    const tenant = this.getTenant(tenantId);
    if (!tenant) throw new HttpError(404, '人员不存在');
    const start = nullableDate(data.start_date);
    const end = nullableDate(data.end_date);
    if (!start || !end) throw new HttpError(400, '离住开始/结束日期格式应为 YYYY-MM-DD');
    if (end < start) throw new HttpError(400, '离住结束日期不能早于开始日期');
    if (tenant.move_in && end < tenant.move_in) throw new HttpError(400, '离住日期早于入住日期');
    const info = this.db
      .prepare('INSERT INTO absences (tenant_id, start_date, end_date, note) VALUES (?, ?, ?, ?)')
      .run(tenantId, start, end, String(data.note || ''));
    const row = this.db.prepare('SELECT * FROM absences WHERE id = ?').get(Number(info.lastInsertRowid));
    return { ...row };
  }

  /** 全量离住记录（可按时间范围 / 房间过滤），用于「离住记录」总览页 */
  listAllAbsences({ start, end, roomId } = {}) {
    const where = [];
    const params = [];
    if (start) {
      where.push('a.end_date >= ?');
      params.push(start);
    }
    if (end) {
      where.push('a.start_date <= ?');
      params.push(end);
    }
    if (roomId) {
      where.push('t.room_id = ?');
      params.push(roomId);
    }
    const rows = this.db
      .prepare(
        `SELECT a.id, a.tenant_id, a.start_date, a.end_date, a.note, a.created_at,
                t.name AS tenant_name, t.room_id, r.room_no
           FROM absences a
           JOIN tenants t ON t.id = a.tenant_id
           JOIN rooms r ON r.id = t.room_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY a.start_date DESC, a.id DESC`
      )
      .all(...params);
    return rows.map((r) => ({ ...r, days: daysBetween(r.start_date, r.end_date) }));
  }

  deleteAbsence(id) {
    const row = this.db.prepare('SELECT id FROM absences WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, '离住记录不存在');
    this.db.prepare('DELETE FROM absences WHERE id = ?').run(id);
    return { deleted: true };
  }

  getTenant(id) {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    return row ? { ...row } : null;
  }

  createTenant(data) {
    const roomId = Number(data.room_id);
    if (!this.getRoom(roomId)) throw new HttpError(400, '房间不存在');
    const name = String(data.name || '').trim();
    if (!name) throw new HttpError(400, '姓名不能为空');
    const info = this.db
      .prepare(
        `INSERT INTO tenants (room_id, name, phone, id_card, move_in, move_out, note, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        roomId,
        name,
        String(data.phone || ''),
        String(data.id_card || ''),
        nullableDate(data.move_in),
        nullableDate(data.move_out),
        String(data.note || ''),
        data.active === undefined ? 1 : data.active ? 1 : 0
      );
    return this.getTenant(Number(info.lastInsertRowid));
  }

  updateTenant(id, data) {
    const t = this.getTenant(id);
    if (!t) throw new HttpError(404, '人员不存在');
    const roomId = data.room_id === undefined ? t.room_id : Number(data.room_id);
    if (!this.getRoom(roomId)) throw new HttpError(400, '房间不存在');
    const name = data.name === undefined ? t.name : String(data.name).trim();
    if (!name) throw new HttpError(400, '姓名不能为空');
    this.db
      .prepare(
        `UPDATE tenants SET room_id = ?, name = ?, phone = ?, id_card = ?, move_in = ?, move_out = ?,
                            note = ?, active = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        roomId,
        name,
        data.phone === undefined ? t.phone : String(data.phone || ''),
        data.id_card === undefined ? t.id_card : String(data.id_card || ''),
        data.move_in === undefined ? t.move_in : nullableDate(data.move_in),
        data.move_out === undefined ? t.move_out : nullableDate(data.move_out),
        data.note === undefined ? t.note : String(data.note || ''),
        data.active === undefined ? t.active : data.active ? 1 : 0,
        nowLocal(),
        id
      );
    return this.getTenant(id);
  }

  deleteTenant(id) {
    const t = this.getTenant(id);
    if (!t) throw new HttpError(404, '人员不存在');
    this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
    return { deleted: true };
  }

  // ---------- 账单 ----------
  listBills() {
    return this.db
      .prepare(
        `SELECT id, fee_key, label, period_start, period_end, total_cents, mode, unit_price,
                status, created_at
           FROM bills ORDER BY period_end DESC, id DESC`
      )
      .all()
      .map((b) => ({ ...b }));
  }

  /** 公开的近期账单（默认最近 6 份）：只给房号与房间金额，不含住户信息 */
  listRecentBills(limit = 6) {
    const n = Math.max(1, Math.min(12, Number(limit) || 6));
    const bills = this.db
      .prepare(
        `SELECT id, fee_key, label, period_start, period_end, total_cents, status, created_at
           FROM bills ORDER BY period_end DESC, id DESC LIMIT ?`
      )
      .all(n);
    const itemsStmt = this.db.prepare(
      `SELECT room_no, amount_cents FROM bill_items WHERE bill_id = ? ORDER BY seq, id`
    );
    return bills.map((b) => ({
      ...b,
      rooms: itemsStmt.all(b.id).map((i) => ({ room_no: i.room_no, amount_cents: i.amount_cents })),
    }));
  }

  getBill(id) {
    const bill = this.db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!bill) return null;
    const items = this.db
      .prepare('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY seq, id')
      .all(id)
      .map((i) => ({ ...i, tenants: safeJson(i.tenants_json, []) }));
    return { ...bill, items, snapshot: safeJson(bill.snapshot_json, null) };
  }

  /** 保存账单：电费、水费各生成一条独立记录（总额为 0 的不生成） */
  createBills(result, meta) {
    const status = meta.status === 'draft' ? 'draft' : 'final';
    const baseLabel = String(meta.label || '').trim();
    const note = String(meta.note || '');
    const now = nowLocal();
    const created = [];

    this.db.exec('BEGIN');
    try {
      for (const fee of result.fees) {
        if (!(fee.total_cents > 0)) continue; // 0 元不单列
        // 没有手动填名称时，用「日期 + 电费/水费」自动生成（整月 / 跨月两种写法）
        const label = baseLabel
          ? feeLabel(baseLabel, fee.key)
          : fee.label || `${fee.period.start} ~ ${fee.period.end} ${fee.name}`;
        const info = this.db
          .prepare(
            `INSERT INTO bills (fee_key, label, period_start, period_end, total_cents,
                                mode, unit_price, status, note, snapshot_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            fee.key,
            label,
            fee.period.start,
            fee.period.end,
            fee.total_cents,
            fee.mode,
            fee.unit_price,
            status,
            note,
            JSON.stringify(result),
            now
          );
        const billId = Number(info.lastInsertRowid);
        const stmt = this.db.prepare(
          `INSERT INTO bill_items (bill_id, room_id, room_no, persons, days, weight, amount_cents, tenants_json, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        result.rooms.forEach((room, idx) => {
          const detail = room[fee.key];
          if (!detail) return;
          stmt.run(
            billId,
            room.room_id,
            room.room_no,
            detail.persons || 0,
            fee.key === 'electric' ? detail.occupied_days || 0 : detail.person_days || 0,
            detail.weight || 0,
            detail.amount_cents || 0,
            JSON.stringify(detail.tenants || []),
            idx
          );
        });
        created.push(this.getBill(billId));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return created;
  }

  deleteBill(id) {
    const bill = this.db.prepare('SELECT id FROM bills WHERE id = ?').get(id);
    if (!bill) throw new HttpError(404, '账单不存在');
    this.db.prepare('DELETE FROM bill_items WHERE bill_id = ?').run(id);
    this.db.prepare('DELETE FROM bills WHERE id = ?').run(id);
    return { deleted: true };
  }

  // ---------- 初始化 ----------
  seedIfEmpty() {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get();
    if (n > 0) return false;
    this.db.exec('BEGIN');
    try {
      const insertRoom = this.db.prepare(
        `INSERT INTO rooms (room_no, note, fixed_electric_weight, fixed_water_weight,
                            exclude_electric, water_fixed_persons, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const ids = new Map();
      for (const r of SEED_ROOMS) {
        const info = insertRoom.run(
          r.room_no,
          r.note,
          r.electric,
          r.water,
          r.excludeElectric ? 1 : 0,
          r.waterFixedPersons === undefined ? null : r.waterFixedPersons,
          r.sort
        );
        ids.set(r.room_no, Number(info.lastInsertRowid));
      }
      const insertTenant = this.db.prepare(
        `INSERT INTO tenants (room_id, name, phone, id_card, move_in, note) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const t of SEED_TENANTS) {
        insertTenant.run(ids.get(t.room_no), t.name, t.phone, t.id_card, t.move_in, '');
      }
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  resetAll() {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM bill_items; DELETE FROM bills; DELETE FROM tenants; DELETE FROM rooms;');
      this.db.exec(
        "DELETE FROM sqlite_sequence WHERE name IN ('bill_items','bills','tenants','rooms');"
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.seedIfEmpty();
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 账单标题按费用区分：2026年9月水电费 -> 2026年9月电费 / 2026年9月水费 */
function feeLabel(label, feeKey) {
  const name = feeKey === 'water' ? '水费' : '电费';
  const text = String(label || '').trim() || name;
  if (text.includes('水电费')) return text.replace('水电费', name);
  if (text.includes('水电')) return text.replace('水电', name);
  return `${text}（${name}）`;
}

function nullableNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 两个 YYYY-MM-DD 之间的天数（首尾都算） */
function daysBetween(start, end) {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
  return Math.floor((e - s) / 86400000) + 1;
}

function nullableDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

module.exports = { Store, HttpError, SEED_ROOMS, SEED_TENANTS, nowLocal };
