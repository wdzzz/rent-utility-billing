'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const calc = require('./calc.js');
const { Store, HttpError, nowLocal } = require('./db.js');
const { Auth } = require('./auth.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(ROOT, 'data', 'billing.db'));
// 数据目录跟随数据库位置（测试用临时库时，配置/备份也落在临时目录，不污染真实数据）
const DATA_DIR = path.dirname(DB_PATH);
const CONFIG_PATH = path.resolve(process.env.CONFIG_PATH || path.join(DATA_DIR, 'config.json'));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function log(...args) {
  console.log(`[${nowLocal()}]`, ...args);
}

// 访问密码：优先 data/config.json；测试/应急可用 APP_PASSWORD 环境变量
const AUTH = new Auth({ configPath: CONFIG_PATH, envPassword: process.env.APP_PASSWORD || '' });
let store = new Store(DB_PATH);

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '备份文件过大（上限 64MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 是否通过 HTTPS 访问（直接 TLS 或反向代理转发 X-Forwarded-Proto: https） */
function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());

/** 客户端 IP：反代场景优先取 X-Forwarded-For（需 TRUST_PROXY=1） */
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

// ---------------- 业务：根据前端参数重算账单（服务端为准，绝不信任前端金额） ----------------
function buildBillResult(payload) {
  const rooms = store.listRooms();
  if (!rooms.length) throw new HttpError(400, '还没有房间，请先在「房间与人员」中添加');

  const tenants = store.listTenants();
  const electricConf = (payload.fees && payload.fees.electric) || {};
  const waterConf = (payload.fees && payload.fees.water) || {};

  // 账单主期间：优先用 payload.period_*，其次用电费期间
  const periodStart = String(payload.period_start || electricConf.period_start || '').trim();
  const periodEnd = String(payload.period_end || electricConf.period_end || '').trim();

  const fees = {
    // 电费默认：房间系数 × 在住天数；水费默认：人天
    electric: {
      total: electricConf.total ?? 0,
      mode: electricConf.mode || 'room-days',
      period_start: electricConf.period_start || periodStart,
      period_end: electricConf.period_end || periodEnd,
    },
    water: {
      total: waterConf.total ?? 0,
      mode: waterConf.mode || 'person-days',
      period_start: waterConf.period_start || periodStart,
      period_end: waterConf.period_end || periodEnd,
    },
  };
  const overrides = {
    electric: normalizeOverrides(payload.overrides && payload.overrides.electric),
    water: normalizeOverrides(payload.overrides && payload.overrides.water),
  };

  let result;
  try {
    result = calc.computeBill({
      rooms,
      tenants,
      period_start: periodStart,
      period_end: periodEnd,
      fees,
      overrides,
    });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  return result;
}

function normalizeOverrides(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

function billToCsv(bill) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const yuan = (cents) => (Number(cents || 0) / 100).toFixed(2);
  const feeKey = bill.fee_key || 'electric';
  const isElectric = feeKey === 'electric';
  const feeName = isElectric ? '电费' : '水费';
  const dayLabel = isElectric ? '房间天数' : '水费人天';
  const items = bill.items || [];

  const lines = [];
  lines.push(`账单,${esc(bill.label)}`);
  lines.push(`类型,${feeName}`);
  lines.push(`期间,${esc(bill.period_start)} ~ ${esc(bill.period_end)}`);
  lines.push(`状态,${bill.status === 'draft' ? '草稿' : '已确认'}`);
  lines.push(`生成时间,${esc(bill.created_at || '')}`);
  lines.push('');
  lines.push(['房号', dayLabel, `${feeName}权重`, `${feeName}(元)`, '离住记录（本期间）'].join(','));

  let sum = 0;
  for (const item of items) {
    sum += item.amount_cents || 0;
    // 账单展示本期各住户的离住（暂离/回老家）记录
    const detail = (item.tenants || [])
      .filter((t) => (t.absences || []).length || t.absence_days)
      .map((t) =>
        (t.absences || []).length
          ? `${t.name}：${t.absences
              .map((a) => `${a.start}~${a.end}(${a.days}天)${a.note ? ' ' + a.note : ''}`)
              .join('；')}`
          : `${t.name}：回老家 ${t.absence_days} 天`
      )
      .join(' ');
    lines.push(
      [
        esc(item.room_no),
        item.days || 0,
        item.weight || 0,
        yuan(item.amount_cents),
        esc(detail || '—'),
      ].join(',')
    );
  }
  lines.push([`${feeName}合计`, '', '', yuan(sum), ''].join(','));
  lines.push('');
  lines.push([`${feeName}总额`, yuan(bill.total_cents)].join(','));
  lines.push(['单价', bill.unit_price].join(','));
  lines.push(['分摊方式', esc(bill.mode || '')].join(','));

  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---------------- 路由 ----------------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, regex, keys, handler, public: Boolean(opts.public) });
}

// ---------- 访问密码 ----------
route(
  'GET',
  '/api/auth/status',
  (ctx) => ({ configured: AUTH.isConfigured(), authed: AUTH.isAuthed(ctx.req), publicPath: '/absence' }),
  { public: true }
);

route(
  'POST',
  '/api/auth/setup',
  (ctx) => {
    if (AUTH.isConfigured()) throw new HttpError(400, '已经设置过访问密码，请直接登录');
    AUTH.setPassword(ctx.body.password);
    const token = AUTH.createSession();
    ctx.res.setHeader('Set-Cookie', AUTH.sessionCookie(token, { secure: isHttps(ctx.req) }));
    return { ok: true, configured: true };
  },
  { public: true }
);

route(
  'POST',
  '/api/auth/login',
  (ctx) => {
    if (!AUTH.isConfigured()) throw new HttpError(400, '还没有设置访问密码');
    if (!AUTH.verify(ctx.body.password)) throw new HttpError(401, '密码不正确');
    const token = AUTH.createSession();
    ctx.res.setHeader('Set-Cookie', AUTH.sessionCookie(token, { secure: isHttps(ctx.req) }));
    return { ok: true };
  },
  { public: true }
);

route(
  'POST',
  '/api/auth/logout',
  (ctx) => {
    AUTH.destroySession(AUTH.tokenFromRequest(ctx.req));
    ctx.res.setHeader('Set-Cookie', AUTH.clearCookie({ secure: isHttps(ctx.req) }));
    return { ok: true };
  },
  { public: true }
);

route('POST', '/api/auth/password', (ctx) => {
  AUTH.changePassword(ctx.body.old_password, ctx.body.new_password);
  const token = AUTH.createSession();
  ctx.res.setHeader('Set-Cookie', AUTH.sessionCookie(token, { secure: isHttps(ctx.req) }));
  return { ok: true };
});

// ---------- 公开的离住登记（无需密码） ----------
route(
  'GET',
  '/api/public/rooms',
  () => ({
    // 公开页面只暴露房号与姓名，不带电话、身份证等隐私信息
    rooms: store.listRooms().map((room) => ({
      room_no: room.room_no,
      tenants: (room.tenants || []).filter((t) => t.active).map((t) => ({ id: t.id, name: t.name })),
    })),
  }),
  { public: true }
);

const publicAbsenceHits = new Map(); // 简单限流：每个 IP 每小时最多 30 条
function checkPublicRate(ip) {
  const now = Date.now();
  const list = (publicAbsenceHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (list.length >= 30) throw new HttpError(429, '提交太频繁，请稍后再试');
  list.push(now);
  publicAbsenceHits.set(ip, list);
}

route(
  'POST',
  '/api/public/absences',
  (ctx) => {
    checkPublicRate(clientIp(ctx.req));
    const tenantId = Number(ctx.body.tenant_id);
    const tenant = store.getTenant(tenantId);
    if (!tenant) throw new HttpError(400, '请选择住户');
    const row = store.createAbsence(tenantId, ctx.body);
    return {
      ok: true,
      absence: row,
      tenant_name: tenant.name,
      room_no: (store.getRoom(tenant.room_id) || {}).room_no || '',
    };
  },
  { public: true }
);

// 近期费用查询（公开）：最近 6 份账单，只含房号与金额
route('GET', '/api/public/bills', () => ({ bills: store.listRecentBills(6) }), { public: true });

// ---------- 离住记录总览 ----------
route('GET', '/api/absences', (ctx) => ({
  absences: store.listAllAbsences({
    start: ctx.query.start || null,
    end: ctx.query.end || null,
    roomId: ctx.query.room_id ? Number(ctx.query.room_id) : null,
  }),
}));

// 健康检查保持公开，供 scripts/status.sh 等运维脚本使用（不含业务数据）
route('GET', '/api/health', () => ({ ok: true, time: nowLocal() }), { public: true });
route('GET', '/api/meta', () => ({
  feeTypes: calc.FEE_DEFS,
  weightModes: calc.WEIGHT_MODES,
  weightModeLabels: calc.WEIGHT_MODE_LABELS,
  defaults: { electric: 'room-days', water: 'person-days' },
  today: new Date().toISOString().slice(0, 10),
}));

route('GET', '/api/rooms', () => ({ rooms: store.listRooms() }));
route('POST', '/api/rooms', (ctx) => store.createRoom(ctx.body));
route('PUT', '/api/rooms/:id', (ctx) => store.updateRoom(Number(ctx.params.id), ctx.body));
route('DELETE', '/api/rooms/:id', (ctx) => store.deleteRoom(Number(ctx.params.id)));

route('GET', '/api/tenants', (ctx) => ({ tenants: store.listTenants(ctx.query.room_id ? Number(ctx.query.room_id) : null) }));
route('POST', '/api/tenants', (ctx) => store.createTenant(ctx.body));
route('PUT', '/api/tenants/:id', (ctx) => store.updateTenant(Number(ctx.params.id), ctx.body));
route('DELETE', '/api/tenants/:id', (ctx) => store.deleteTenant(Number(ctx.params.id)));

// 离住记录（回老家）
route('GET', '/api/tenants/:id/absences', (ctx) => ({ absences: store.listAbsences(Number(ctx.params.id)) }));
route('POST', '/api/tenants/:id/absences', (ctx) => store.createAbsence(Number(ctx.params.id), ctx.body));
route('DELETE', '/api/absences/:id', (ctx) => store.deleteAbsence(Number(ctx.params.id)));

route('POST', '/api/bills/preview', (ctx) => buildBillResult(ctx.body));

route('GET', '/api/bills', () => ({ bills: store.listBills() }));
route('POST', '/api/bills', (ctx) => {
  const result = buildBillResult(ctx.body);
  // 分配合计必须与费用总额严格一致，否则说明某项费用系数全为 0，拒绝落库以免产生错账
  const allocated = result.rooms.reduce((a, r) => a + r.total_cents, 0);
  if (allocated !== result.total_cents) {
    throw new HttpError(
      400,
      `各房间分配合计 ${(allocated / 100).toFixed(2)} 元与费用总额 ${(result.total_cents / 100).toFixed(
        2
      )} 元不一致：请检查系数（很可能是某项费用所有房间系数都是 0），或改用「按人天」分摊`
    );
  }
  const bills = store.createBills(result, {
    label: ctx.body.label,
    status: ctx.body.status,
    note: ctx.body.note,
  });
  if (!bills.length) {
    throw new HttpError(400, '电费、水费总额都是 0，没有可保存的账单');
  }
  return { bills };
});
route('GET', '/api/bills/:id', (ctx) => {
  const bill = store.getBill(Number(ctx.params.id));
  if (!bill) throw new HttpError(404, '账单不存在');
  return bill;
});
route('DELETE', '/api/bills/:id', (ctx) => store.deleteBill(Number(ctx.params.id)));

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function pruneBackups(keep = 30) {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => path.join(BACKUP_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files.slice(keep)) fs.rmSync(f, { force: true });
  } catch {
    /* ignore */
  }
}

/** 下载完整备份（VACUUM INTO 生成一致性快照，同时保留一份在 data/backups） */
function sendBackup(res) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = timestamp();
  const file = path.join(BACKUP_DIR, `billing-${stamp}.db`);
  store.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  pruneBackups(30);
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="billing-${stamp}.db"`,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/** 上传 .db 备份并恢复（恢复前自动备份当前数据库） */
async function restoreFromUpload(req) {
  const buf = await readRaw(req);
  if (!buf || buf.length < 100) throw new HttpError(400, '备份文件为空');
  if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    throw new HttpError(400, '不是有效的 SQLite 备份文件（请上传系统下载的 .db 备份）');
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const tmp = path.join(BACKUP_DIR, `restore-${timestamp()}.db`);
  fs.writeFileSync(tmp, buf, { mode: 0o600 });

  const REQUIRED = ['rooms', 'tenants', 'absences', 'bills', 'bill_items'];
  let check = null;
  try {
    check = new DatabaseSync(tmp);
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    const missing = REQUIRED.filter((t) => !tables.includes(t));
    if (missing.length) throw new HttpError(400, `备份文件缺少数据表：${missing.join('、')}`);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err instanceof HttpError ? err : new HttpError(400, '备份文件无法读取');
  } finally {
    try {
      if (check) check.close();
    } catch {
      /* ignore */
    }
  }

  // 恢复前先备份当前库，避免误操作丢数据
  let preBackup = '';
  try {
    preBackup = path.join(BACKUP_DIR, `pre-restore-${timestamp()}.db`);
    store.db.exec(`VACUUM INTO '${preBackup.replace(/'/g, "''")}'`);
  } catch (err) {
    log('恢复前自动备份失败', err);
    preBackup = '';
  }

  store.close();
  for (const suffix of ['-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
  fs.copyFileSync(tmp, DB_PATH);
  fs.rmSync(tmp, { force: true });
  store = new Store(DB_PATH);
  store.seedIfEmpty();
  log(`已从备份恢复数据（${buf.length} 字节）`);
  return {
    ok: true,
    bytes: buf.length,
    backup_before: preBackup ? path.basename(preBackup) : null,
  };
}

async function handle(req, res) {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  // 备份下载（二进制响应）
  if (pathname === '/api/backup' && req.method === 'GET') {
    if (!AUTH.isAuthed(req)) return json(res, 401, { error: '需要登录', needLogin: true });
    sendBackup(res);
    log(`GET ${pathname} 200 ${Date.now() - started}ms`);
    return;
  }

  // 从备份恢复（上传 .db）
  if (pathname === '/api/restore' && req.method === 'POST') {
    if (!AUTH.isAuthed(req)) return json(res, 401, { error: '需要登录', needLogin: true });
    try {
      const payload = await restoreFromUpload(req);
      json(res, 200, payload);
      log(`POST ${pathname} 200 ${Date.now() - started}ms`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log(`POST ${pathname} ${status}`, err);
      json(res, status, { error: err.message || '恢复失败' });
    }
    return;
  }

  // CSV 导出
  const csvMatch = pathname.match(/^\/api\/bills\/(\d+)\/csv$/);
  if (csvMatch && req.method === 'GET') {
    if (!AUTH.isAuthed(req)) return json(res, 401, { error: '需要登录', needLogin: true });
    const bill = store.getBill(Number(csvMatch[1]));
    if (!bill) return json(res, 404, { error: '账单不存在' });
    const csv = billToCsv(bill);
    const buf = Buffer.from(csv, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="bill-${bill.id}.csv"; filename*=UTF-8''${encodeURIComponent(
        `${bill.label}.csv`
      )}`,
      'Content-Length': buf.length,
    });
    res.end(buf);
    log(`GET ${pathname} 200 (csv)`);
    return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;
    if (!r.public && !AUTH.isAuthed(req)) {
      return json(res, 401, { error: '需要登录', needLogin: true });
    }
    const params = {};
    r.keys.forEach((key, i) => (params[key] = m[i + 1]));
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      const query = Object.fromEntries(url.searchParams.entries());
      const payload = await r.handler({ params, body, query, req, res });
      json(res, 200, payload === undefined ? { ok: true } : payload);
      log(`${req.method} ${pathname} 200 ${Date.now() - started}ms`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log(`${req.method} ${pathname} ${status}`, err);
      json(res, status, { error: err.message || '服务器内部错误' });
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    json(res, 404, { error: '接口不存在' });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/') {
      if (!AUTH.isAuthed(req)) return redirect(res, '/login');
      return serveStatic(req, res, '/index.html');
    }
    if (pathname === '/login') {
      if (AUTH.isAuthed(req)) return redirect(res, '/');
      return serveStatic(req, res, '/login.html');
    }
    if (pathname === '/absence') {
      return serveStatic(req, res, '/absence.html');
    }
    return serveStatic(req, res, pathname);
  }
  json(res, 404, { error: '接口不存在' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // 单页应用兜底
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallback, (e2, data) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 本地工具，前端文件一律让浏览器回源校验，避免改完后页面还在用旧 JS
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Last-Modified': stat.mtime.toUTCString(),
    });
    fs.createReadStream(filePath).pipe(res);
  });
}


// ---------------- 启动 ----------------
function main() {
  if (process.argv.includes('--reset')) {
    store.resetAll();
    log('数据库已重置为表格初始数据：', DB_PATH);
    store.close();
    return;
  }

  const seeded = store.seedIfEmpty();
  if (seeded) log('首次启动：已按 Excel 表格导入房间与人员初始数据');

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('未捕获异常', err);
      if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
    });
  });

  server.listen(PORT, HOST, () => {
    log(`水电费账单服务已启动: http://localhost:${PORT}  (db: ${DB_PATH})`);
    log(
      AUTH.isConfigured()
        ? '访问密码：已启用（登录后才能进入）'
        : '访问密码：未设置（首次打开网页会引导设置）'
    );
    log('离住登记（无需密码）：/absence');
  });

  const shutdown = () => {
    log('正在关闭服务…');
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = {
  buildBillResult,
  billToCsv,
  get store() {
    return store;
  },
};
