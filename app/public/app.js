'use strict';

/* ------------------------------------------------------------------ *
 * 房租水电费计算 - 前端逻辑（原生 JS，无依赖）
 * 计算全部由服务端 /api/bills/preview 完成，前端只负责展示与录入，
 * 避免前后端两套公式产生分位差异。
 * ------------------------------------------------------------------ */

const state = {
  rooms: [],
  bills: [],
  meta: null,
  preview: null,
  previewPayload: null,
  overrides: { electric: {}, water: {} },
  tenantFilter: '',
  previewSeq: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// 初始化幂等保护：避免脚本被重复执行或 DOMContentLoaded 重复触发时绑定两次事件
let booted = false;

/* ---------------- 工具 ---------------- */
function escapeHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtYuan(n) {
  return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 单价：保留较多有效位，避免 5.676268… 显示成 5.68 造成误解 */
function fmtUnitPrice(n) {
  const v = Number(n || 0);
  if (!v) return '0';
  return v.toFixed(4).replace(/0{1,3}$/, '').replace(/\.$/, '');
}

function fmtNum(n, digits = 2) {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/\.?0+$/, '');
}

function isoDate(d) {
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function lastMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  return { start: isoDate(start), end: isoDate(end) };
}

/**
 * 水费默认周期：两个月一结，「上上月 16 号 ~ 本月 14 号」。
 * 例：2026-10-21 时 => 2026-08-16 ~ 2026-10-14。
 * 本月 15 号之前（本期还没结束）则截止到上月 14 号。
 */
function waterCycleRange() {
  const now = new Date();
  let endMonth = now.getMonth(); // 0-based
  if (now.getDate() < 15) {
    endMonth -= 1;
  }
  const end = new Date(now.getFullYear(), endMonth, 14);
  const start = new Date(now.getFullYear(), endMonth - 2, 16);
  return { start: isoDate(start), end: isoDate(end) };
}

function dayCount(start, end) {
  if (!start || !end) return 0;
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  return Math.floor((e - s) / 86400000) + 1;
}

let toastTimer = null;
function toast(message, isError = false) {
  const box = $('#toast');
  box.textContent = message;
  box.className = 'toast' + (isError ? ' error' : '');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (res.status === 401) {
    if (location.pathname !== '/login') location.replace('/login');
    throw new Error('登录已失效，请重新登录');
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

/* ---------------- 视图切换 ---------------- */
function switchView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'bills') loadBills();
  if (name === 'rooms') loadRooms();
  if (name === 'absences') loadAbsences();
}

/* ---------------- 初始化 ---------------- */
async function init() {
  if (booted) return;
  booted = true;

  // 未登录时先跳转到登录页（页面本身不返回数据，但仍在这里兜底）
  try {
    const status = await api('/api/auth/status');
    if (!status.authed) {
      location.replace('/login');
      return;
    }
  } catch {
    location.replace('/login');
    return;
  }

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));

  const eRange = lastMonthRange();
  const wRange = waterCycleRange();
  $('#electric_period_start').value = eRange.start;
  $('#electric_period_end').value = eRange.end;
  $('#water_period_start').value = wRange.start;
  $('#water_period_end').value = wRange.end;

  $('#btn-preview').addEventListener('click', () => previewBill());
  $('#btn-save-bill').addEventListener('click', () => saveBill('final'));
  $('#btn-save-draft').addEventListener('click', () => saveBill('draft'));
  $('#btn-reset-form').addEventListener('click', resetForm);
  $('#btn-fill-example').addEventListener('click', fillExample);
  $('#btn-refresh-bills').addEventListener('click', loadBills);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-refresh-absences').addEventListener('click', loadAbsences);
  $('#btn-open-public').addEventListener('click', () => window.open('/absence', '_blank'));
  ['#absence-start', '#absence-end', '#absence-room'].forEach((sel) => {
    $(sel).addEventListener('change', loadAbsences);
  });
  $$('.quick-ranges [data-range]').forEach((btn) => {
    btn.addEventListener('click', () => applyAbsenceRange(btn.dataset.range));
  });
  initAbsenceFilters();
  $('#btn-add-room').addEventListener('click', () => openRoomModal(null));
  $('#btn-add-tenant').addEventListener('click', () => openTenantModal(null));
  $('#tenant-filter').addEventListener('change', (e) => {
    state.tenantFilter = e.target.value;
    renderTenants();
  });
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-mask').addEventListener('click', (e) => {
    if (e.target === $('#modal-mask')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  try {
    state.meta = await api('/api/meta');
    await loadRooms();
    await loadBills();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 房间 / 人员数据 ---------------- */
async function loadRooms() {
  const data = await api('/api/rooms');
  state.rooms = data.rooms || [];
  renderRooms();
  renderTenants();
  fillRoomFilter();
}

function fillRoomFilter() {
  const sel = $('#tenant-filter');
  const current = state.tenantFilter;
  sel.innerHTML =
    '<option value="">全部房间</option>' +
    state.rooms.map((r) => `<option value="${r.id}">${escapeHtml(r.room_no)}</option>`).join('');
  sel.value = current;
}

function renderRooms() {
  const table = $('#rooms-table');
  const rows = state.rooms
    .map((room) => {
      const tenants = room.tenants || [];
      const active = tenants.filter((t) => t.active).length;
      const excluded = Number(room.exclude_electric);
      const electricCell = `${
        room.fixed_electric_weight === null || room.fixed_electric_weight === undefined
          ? '—'
          : fmtNum(room.fixed_electric_weight)
      }${excluded ? '<span class="row-sub">独立电表</span>' : ''}`;
      const waterCell =
        room.fixed_water_weight === null || room.fixed_water_weight === undefined
          ? '—'
          : fmtNum(room.fixed_water_weight);
      return `<tr>
        <td class="room-cell">${escapeHtml(room.room_no)}</td>
        <td class="num">${electricCell}</td>
        <td class="num">${waterCell}</td>
        <td class="num">${active} 人</td>
        <td>${
          tenants
            .filter((t) => t.active)
            .map((t) => `<span class="chip">${escapeHtml(t.name)}</span>`)
            .join('') || '<span class="muted">空置</span>'
        }</td>
        <td class="muted">${escapeHtml(room.note || '')}</td>
        <td class="nowrap">
          <button class="btn-link" data-act="edit-room" data-id="${room.id}">编辑</button>
          <button class="btn-link danger" data-act="del-room" data-id="${room.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('');

  table.innerHTML = `
    <thead><tr>
      <th>房号</th><th class="num">电费系数</th><th class="num">水费系数</th>
      <th class="num">在住人数</th><th>人员</th><th>备注</th><th>操作</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted">暂无房间</td></tr>'}</tbody>`;

  $$('#rooms-table [data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      if (btn.dataset.act === 'edit-room') {
        openRoomModal(state.rooms.find((r) => r.id === id));
      } else if (btn.dataset.act === 'del-room') {
        deleteRoom(state.rooms.find((r) => r.id === id));
      }
    });
  });
}

function renderTenants() {
  const table = $('#tenants-table');
  const list = state.rooms
    .filter((r) => !state.tenantFilter || String(r.id) === String(state.tenantFilter))
    .flatMap((r) => (r.tenants || []).map((t) => ({ ...t, room_no: r.room_no })));

  const rows = list
    .map(
      (t) => `<tr>
        <td class="room-cell">${escapeHtml(t.room_no)}</td>
        <td>${escapeHtml(t.name)}</td>
        <td class="mono">${escapeHtml(t.phone || '')}</td>
        <td class="mono">${escapeHtml(t.id_card || '')}</td>
        <td class="mono">${escapeHtml(t.move_in || '—')}</td>
        <td class="mono">${escapeHtml(t.move_out || '—')}</td>
        <td>${(() => {
          const list = t.absences || [];
          const total = list.reduce((a, x) => a + dayCount(x.start_date, x.end_date), 0);
          if (!list.length) return '<span class="muted">—</span>';
          return `<button class="btn-link" data-act="absences" data-id="${t.id}">${list.length} 段 / 共 ${total} 天</button>`;
        })()}</td>
        <td>${t.active ? '<span class="badge final">在住</span>' : '<span class="badge draft">已退租</span>'}</td>
        <td class="nowrap">
          <button class="btn-link" data-act="edit-tenant" data-id="${t.id}">编辑</button>
          <button class="btn-link" data-act="absences" data-id="${t.id}">离住记录</button>
          <button class="btn-link danger" data-act="del-tenant" data-id="${t.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');

  table.innerHTML = `
    <thead><tr>
      <th>房号</th><th>姓名</th><th>电话</th><th>身份证</th>
      <th>入住日期</th><th>退租日期</th><th>离住记录</th><th>状态</th><th>操作</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="9" class="muted">暂无人员，点击右上角「新增人员」添加</td></tr>'}</tbody>`;

  $$('#tenants-table [data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const all = state.rooms.flatMap((r) => r.tenants || []);
      const tenant = all.find((t) => t.id === id);
      if (btn.dataset.act === 'edit-tenant') openTenantModal(tenant);
      else if (btn.dataset.act === 'del-tenant') deleteTenant(tenant);
      else if (btn.dataset.act === 'absences') openAbsenceModal(tenant);
    });
  });
}

/* ---------------- 房间弹窗 ---------------- */
function openRoomModal(room) {
  const coefValue = (v, fallback) => (v === null || v === undefined ? fallback : v);
  openModal(
    room ? `编辑房间 ${room.room_no}` : '新增房间',
    `<form id="room-form" class="form-modal">
      <label class="field"><span>房号 *</span><input name="room_no" required value="${escapeHtml(
        room ? room.room_no : ''
      )}" placeholder="例如 201" /></label>
      <label class="field"><span>排序（越小越靠前）</span><input name="sort" type="number" value="${
        room ? room.sort : 99
      }" /></label>
      <label class="field"><span>电费系数</span>
        <input name="fixed_electric_weight" type="number" step="0.01" min="0" value="${coefValue(
          room && room.fixed_electric_weight,
          1
        )}" placeholder="默认 1；商户填 0" />
      </label>
      <label class="field"><span>水费系数</span>
        <input name="fixed_water_weight" type="number" step="0.01" min="0" value="${coefValue(
          room && room.fixed_water_weight,
          1
        )}" placeholder="默认 1；商户可填 0.5" />
      </label>
      <label class="field"><span>电费分摊</span>
        <select name="exclude_electric">
          <option value="0" ${!room || !Number(room.exclude_electric) ? 'selected' : ''}>参与电费分摊</option>
          <option value="1" ${room && Number(room.exclude_electric) ? 'selected' : ''}>不参与（独立电表 / 商户）</option>
        </select>
      </label>
      <label class="field"><span>备注</span><input name="note" value="${escapeHtml(
        room ? room.note : ''
      )}" /></label>
      <p class="muted" style="font-size:12px;grid-column:1/-1;margin:0">
        电费权重 = 电费系数 × 房间在住天数（正常房间 1，商户 0 并选「不参与」）；
        水费权重 = 水费系数 × 人天（所有人默认 1，商户可手动改成 0.5 减半）。
      </p>
    </form>`,
    `<button class="btn ghost" data-close>取消</button>
     <button class="btn primary" id="room-save">保存</button>`
  );
  $('#room-save').addEventListener('click', async () => {
    const form = $('#room-form');
    if (!form.reportValidity()) return;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.fixed_electric_weight =
      payload.fixed_electric_weight === '' ? null : Number(payload.fixed_electric_weight);
    payload.fixed_water_weight =
      payload.fixed_water_weight === '' ? null : Number(payload.fixed_water_weight);
    payload.exclude_electric = payload.exclude_electric === '1' ? 1 : 0;
    payload.sort = Number(payload.sort) || 99;
    try {
      if (room) await api(`/api/rooms/${room.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/rooms', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await loadRooms();
      toast(room ? '房间已更新' : '房间已添加');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function deleteRoom(room) {
  if (!room) return;
  if (!confirm(`确定删除房间 ${room.room_no} 及其人员吗？\n（如果该房间出现在历史账单中，则只会停用，历史记录保留）`)) return;
  try {
    const res = await api(`/api/rooms/${room.id}`, { method: 'DELETE' });
    await loadRooms();
    toast(res.deactivated ? '该房间已有历史账单，已停用' : '房间已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 人员弹窗 ---------------- */
function openTenantModal(tenant) {
  if (!state.rooms.length) {
    toast('请先添加房间', true);
    return;
  }
  const roomOptions = state.rooms
    .map(
      (r) =>
        `<option value="${r.id}" ${tenant && tenant.room_id === r.id ? 'selected' : ''}>${escapeHtml(r.room_no)}</option>`
    )
    .join('');
  openModal(
    tenant ? `编辑人员 ${tenant.name}` : '新增人员',
    `<form id="tenant-form" class="form-modal">
      <label class="field"><span>房间 *</span><select name="room_id" required>${roomOptions}</select></label>
      <label class="field"><span>姓名 *</span><input name="name" required value="${escapeHtml(tenant ? tenant.name : '')}" /></label>
      <label class="field"><span>电话</span><input name="phone" value="${escapeHtml(tenant ? tenant.phone : '')}" /></label>
      <label class="field"><span>身份证</span><input name="id_card" value="${escapeHtml(tenant ? tenant.id_card : '')}" /></label>
      <label class="field"><span>入住日期</span><input name="move_in" type="date" value="${escapeHtml(tenant && tenant.move_in ? tenant.move_in : '')}" /></label>
      <label class="field"><span>退租日期（留空表示在住）</span><input name="move_out" type="date" value="${escapeHtml(tenant && tenant.move_out ? tenant.move_out : '')}" /></label>
      <label class="field"><span>状态</span>
        <select name="active">
          <option value="1" ${!tenant || tenant.active ? 'selected' : ''}>在住</option>
          <option value="0" ${tenant && !tenant.active ? 'selected' : ''}>已退租</option>
        </select>
      </label>
      <label class="field"><span>备注</span><input name="note" value="${escapeHtml(tenant ? tenant.note : '')}" /></label>
      <p class="muted full" style="font-size:12px;grid-column:1/-1;margin:0">
        分摊时按「入住日期 ~ 退租日期」与计费期间的交叉天数计算在住天数；留空入住日期视为期间开始即在住。
        临时回老家不修改入住/退租日期，请在人员列表点「离住记录」登记，那段时间会从在住天数中扣除。
      </p>
    </form>`,
    `<button class="btn ghost" data-close>取消</button>
     <button class="btn primary" id="tenant-save">保存</button>`
  );
  $('#tenant-save').addEventListener('click', async () => {
    const form = $('#tenant-form');
    if (!form.reportValidity()) return;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.room_id = Number(payload.room_id);
    payload.active = payload.active === '1' ? 1 : 0;
    payload.move_in = payload.move_in || null;
    payload.move_out = payload.move_out || null;
    if (payload.move_in && payload.move_out && payload.move_out < payload.move_in) {
      toast('退租日期不能早于入住日期', true);
      return;
    }
    try {
      if (tenant) await api(`/api/tenants/${tenant.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/tenants', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await loadRooms();
      toast(tenant ? '人员信息已更新' : '人员已添加');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------------- 离住记录（回老家） ---------------- */
function openAbsenceModal(tenant) {
  if (!tenant) return;
  openModal(
    `离住记录 · ${tenant.name}`,
    `<p class="muted" style="margin-top:0">
        登记回老家 / 临时不在住的时段。这些天会从该住户的「人天」中扣除；
        如果整个房间都没人在住，电费也不再按这些天分摊。
      </p>
      <div class="form-modal">
        <label class="field"><span>开始日期 *</span><input type="date" id="abs-modal-start" required /></label>
        <label class="field"><span>结束日期 *</span><input type="date" id="abs-modal-end" required /></label>
        <label class="field full"><span>备注</span><input id="abs-modal-note" placeholder="例如：回老家 / 出差" /></label>
      </div>
      <div class="actions" style="margin:12px 0 16px">
        <button class="btn primary small" id="abs-modal-add">添加离住记录</button>
      </div>
      <div id="absence-list"><p class="muted">加载中…</p></div>`,
    `<button class="btn ghost" data-close>关闭</button>`
  );

  const fetchList = () => api(`/api/tenants/${tenant.id}/absences`);

  async function renderList() {
    const data = await fetchList();
    const list = data.absences || [];
    if (!list.length) {
      $('#absence-list').innerHTML = '<p class="empty">还没有离住记录</p>';
      return;
    }
    $('#absence-list').innerHTML = `
      <div class="table-wrap">
        <table class="data-table" style="min-width:520px">
          <thead><tr><th>开始</th><th>结束</th><th class="num">天数</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>${list
            .map(
              (a) => `<tr>
                <td class="mono">${escapeHtml(a.start_date)}</td>
                <td class="mono">${escapeHtml(a.end_date)}</td>
                <td class="num">${dayCount(a.start_date, a.end_date)}</td>
                <td>${escapeHtml(a.note || '')}</td>
                <td><button class="btn-link danger" data-del="${a.id}">删除</button></td>
              </tr>`
            )
            .join('')}</tbody>
        </table>
      </div>`;
    $$('#absence-list [data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/absences/${Number(btn.dataset.del)}`, { method: 'DELETE' });
          await renderList();
          await loadRooms();
          toast('离住记录已删除');
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  }

  $('#abs-modal-add').addEventListener('click', async () => {
    const start = $('#abs-modal-start').value;
    const end = $('#abs-modal-end').value;
    if (!start || !end) return toast('请选择开始与结束日期', true);
    if (end < start) return toast('结束日期不能早于开始日期', true);
    try {
      await api(`/api/tenants/${tenant.id}/absences`, {
        method: 'POST',
        body: JSON.stringify({ start_date: start, end_date: end, note: $('#abs-modal-note').value.trim() }),
      });
      $('#abs-modal-start').value = '';
      $('#abs-modal-end').value = '';
      $('#abs-modal-note').value = '';
      await renderList();
      await loadRooms();
      toast('离住记录已添加');
    } catch (err) {
      toast(err.message, true);
    }
  });

  renderList().catch((err) => toast(err.message, true));
}

async function deleteTenant(tenant) {
  if (!tenant) return;
  if (!confirm(`确定删除人员 ${tenant.name} 吗？`)) return;
  try {
    await api(`/api/tenants/${tenant.id}`, { method: 'DELETE' });
    await loadRooms();
    toast('人员已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 弹窗通用 ---------------- */
function openModal(title, bodyHtml, footHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-foot').innerHTML = footHtml || '';
  $('#modal-mask').hidden = false;
  $('#modal').classList.toggle('wide', window.innerWidth > 820);
  $$('#modal [data-close]').forEach((b) => b.addEventListener('click', closeModal));
}

function closeModal() {
  $('#modal-mask').hidden = true;
  $('#modal').classList.remove('wide');
  $('#modal-body').innerHTML = '';
  $('#modal-foot').innerHTML = '';
}

/* ---------------- 账单预览 ---------------- */
function collectPayload() {
  const eStart = $('#electric_period_start').value;
  const eEnd = $('#electric_period_end').value;
  const wStart = $('#water_period_start').value;
  const wEnd = $('#water_period_end').value;
  return {
    // 账单主期间取电费期间；两种费用各自的期间放在 fees 里
    period_start: eStart,
    period_end: eEnd,
    note: $('#bill-note').value.trim(),
    fees: {
      electric: {
        total: Number($('#electric_total').value || 0),
        mode: $('#electric_mode').value,
        period_start: eStart,
        period_end: eEnd,
      },
      water: {
        total: Number($('#water_total').value || 0),
        mode: $('#water_mode').value,
        period_start: wStart,
        period_end: wEnd,
      },
    },
    overrides: state.overrides,
  };
}

async function previewBill({ silent = false } = {}) {
  const payload = collectPayload();
  const problems = [];
  if (!payload.fees.electric.period_start || !payload.fees.electric.period_end) {
    problems.push('请选择电费期间');
  } else if (payload.fees.electric.period_end < payload.fees.electric.period_start) {
    problems.push('电费期间结束日期不能早于开始日期');
  }
  if (!payload.fees.water.period_start || !payload.fees.water.period_end) {
    problems.push('请选择水费期间');
  } else if (payload.fees.water.period_end < payload.fees.water.period_start) {
    problems.push('水费期间结束日期不能早于开始日期');
  }
  if (payload.fees.electric.total < 0 || payload.fees.water.total < 0) {
    problems.push('费用总额不能为负数');
  }
  if (problems.length) {
    toast(problems.join('；'), true);
    return;
  }

  const seq = ++state.previewSeq;
  const btn = $('#btn-preview');
  btn.disabled = true;
  try {
    const result = await api('/api/bills/preview', { method: 'POST', body: JSON.stringify(payload) });
    if (seq !== state.previewSeq) return; // 有更新的请求
    state.preview = result;
    state.previewPayload = payload;
    renderPreview();
    if (!silent) $('#preview-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function renderPreview() {
  const card = $('#preview-card');
  const result = state.preview;
  if (!result) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const feeCards = result.fees
    .map(
      (fee) => `<div class="sum-card">
        <div class="k">${escapeHtml(fee.name)}总额</div>
        <div class="v">¥ ${fmtYuan(fee.total_yuan)}</div>
        <div class="s">期间 ${escapeHtml(fee.period.start)} ~ ${escapeHtml(fee.period.end)}（${fee.period.days} 天）</div>
        <div class="s">账单名：${escapeHtml(fee.label || '')}</div>
        <div class="s">${escapeHtml(fee.mode_label || '')}</div>
        <div class="s">Σ权重 ${fmtNum(fee.weight_sum)} · 单价 ${
        fee.weight_sum > 0 ? fmtUnitPrice(fee.unit_price) + ' 元/单位' : '—'
      }</div>
      </div>`
    )
    .join('');

  $('#preview-summary').innerHTML =
    feeCards +
    `<div class="sum-card accent">
      <div class="k">合计应收</div>
      <div class="v">¥ ${fmtYuan(result.total_yuan)}</div>
      <div class="s">电费 ${escapeHtml(fmtRange(result.periods.electric))}</div>
      <div class="s">水费 ${escapeHtml(fmtRange(result.periods.water))}</div>
    </div>`;

  $('#preview-warnings').innerHTML = (result.warnings || [])
    .map((w) => `<div class="warning-item">${escapeHtml(w)}</div>`)
    .join('');

  const modes = state.previewPayload.fees;
  // 电费、水费各自一张分摊表，最后再给一张按房间的合计表
  $('#preview-tables').innerHTML =
    result.fees
      .map((fee) => renderFeeTable(fee, { manual: modes[fee.key].mode === 'manual' }))
      .join('') + renderRoomSummaryTable(result);

  const eFee = result.fees.find((f) => f.key === 'electric');
  const wFee = result.fees.find((f) => f.key === 'water');
  $('#preview-footer').innerHTML = `
    <span>校验：电费 <strong>¥ ${fmtYuan(eFee.total_yuan)}</strong> + 水费 <strong>¥ ${fmtYuan(
    wFee.total_yuan
  )}</strong> = <strong>¥ ${fmtYuan(result.total_yuan)}</strong> ${
    eFee.total_cents + wFee.total_cents === result.total_cents ? '✓' : '≠ 总额，请检查'
  }</span>
    <span class="muted">${
      modes.electric.mode === 'manual' || modes.water.mode === 'manual'
        ? '手动模式下可直接修改系数，表格会自动重算'
        : '切换「手动填写系数」可微调每户系数'
    }</span>`;

  // 手动模式：失焦/回车触发重算，避免每个按键都请求
  $$('#preview-tables .weight-input').forEach((input) => {
    const handler = () => {
      const fee = input.dataset.fee;
      const roomId = Number(input.dataset.room);
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) return;
      state.overrides[fee][roomId] = value;
      previewBill({ silent: true });
    };
    input.addEventListener('change', handler);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
  });
}

/**
 * 渲染某一种费用（电费或水费）的独立分摊表
 * @param {object} fee computeBill 返回的 fees[i]
 * @param {{manual?:boolean}} opts 手动模式时系数可编辑
 */
function renderFeeTable(fee, opts = {}) {
  const manual = Boolean(opts.manual);
  const isElectric = fee.key === 'electric';
  const dayLabel = isElectric ? '房间天数' : '人天';

  const shortDate = (d) => String(d || '').slice(5); // 2026-09-01 -> 09-01
  const absenceCell = (item) => {
    const tenants = item.tenants || [];
    if (!tenants.length) return '<span class="muted">—</span>';
    const lines = [];
    for (const t of tenants) {
      for (const a of t.absences || []) {
        lines.push(
          `<span class="chip gray" title="${escapeHtml(t.name)} ${a.start} ~ ${a.end}，共 ${a.days} 天${
            a.note ? '（' + a.note + '）' : ''
          }">${escapeHtml(t.name)}：${shortDate(a.start)} ~ ${shortDate(a.end)}${
            a.note ? ' ' + escapeHtml(a.note) : ''
          }（${a.days}天）</span>`
        );
      }
      // 兼容旧账单（当时没保存具体日期，只记了天数）
      if (!(t.absences || []).length && t.absence_days > 0) {
        lines.push(
          `<span class="chip gray" title="该账单创建时未保存离住日期">${escapeHtml(t.name)}：回老家 ${
            t.absence_days
          } 天</span>`
        );
      }
    }
    return lines.join(' ') || '<span class="muted">无离住记录</span>';
  };
  const rows = (fee.items || [])
    .map((item) => {
          const days = isElectric ? item.occupied_days : item.person_days;
      const weightCell = manual
        ? `<input class="weight-input" type="number" min="0" step="0.01" data-fee="${fee.key}" data-room="${item.room_id}" value="${item.weight}" />`
        : fmtNum(item.weight);
      return `<tr>
        <td class="room-cell">${escapeHtml(item.room_no)}</td>
        <td class="num">${days || 0}</td>
        <td class="num">${weightCell}</td>
        <td class="num strong">${fmtMoney(item.amount_cents)}</td>
        <td>${absenceCell(item)}</td>
      </tr>`;
    })
    .join('');

  const sum = (fee.items || []).reduce((a, i) => a + i.amount_cents, 0);

  return `<div class="fee-block">
    <div class="fee-block-head">
      <h3>${escapeHtml(fee.name)}分摊</h3>
      <span class="period">${escapeHtml(fee.period.start)} ~ ${escapeHtml(fee.period.end)}（${
    fee.period.days
  } 天）</span>
      <span class="meta">${escapeHtml(fee.mode_label || '')} · Σ权重 ${fmtNum(
    fee.weight_sum
  )} · 单价 ${fee.weight_sum > 0 ? fmtUnitPrice(fee.unit_price) + ' 元/单位' : '—'}</span>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>房号</th><th class="num">${dayLabel}</th><th class="num">${escapeHtml(
    fee.name
  )}权重</th><th class="num">${escapeHtml(fee.name)}(元)</th><th>离住记录（本期间）</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td>${escapeHtml(fee.name)}合计</td><td></td><td></td>
          <td class="num">${fmtMoney(sum)}</td><td></td>
        </tr></tfoot>
      </table>
    </div>
  </div>`;
}

/** 按房间汇总电费 + 水费，方便看每户总共交多少 */
function renderRoomSummaryTable(result) {
  const rows = (result.rooms || [])
    .map((room) => {
      const e = room.electric || { amount_cents: 0 };
      const w = room.water || { amount_cents: 0 };
      return `<tr>
        <td class="room-cell">${escapeHtml(room.room_no)}</td>
        <td class="num">${fmtMoney(e.amount_cents)}</td>
        <td class="num">${fmtMoney(w.amount_cents)}</td>
        <td class="num strong">${fmtMoney(room.total_cents)}</td>
      </tr>`;
    })
    .join('');
  const sums = (result.rooms || []).reduce(
    (acc, r) => ({
      e: acc.e + ((r.electric && r.electric.amount_cents) || 0),
      w: acc.w + ((r.water && r.water.amount_cents) || 0),
      t: acc.t + r.total_cents,
    }),
    { e: 0, w: 0, t: 0 }
  );
  return `<div class="fee-block total-block">
    <div class="fee-block-head">
      <h3>按房间合计</h3>
      <span class="meta">电费 + 水费（每户本期应缴）</span>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>房号</th><th class="num">电费(元)</th><th class="num">水费(元)</th><th class="num">合计(元)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td>合计</td><td class="num">${fmtMoney(sums.e)}</td><td class="num">${fmtMoney(
    sums.w
  )}</td><td class="num">${fmtMoney(sums.t)}</td>
        </tr></tfoot>
      </table>
    </div>
  </div>`;
}

/** 格式化一个期间为「2026-08-14 ~ 2026-10-15」 */
function fmtRange(p) {
  return p ? `${p.start} ~ ${p.end}` : '—';
}

async function saveBill(status) {
  if (!state.preview) {
    toast('请先计算预览', true);
    return;
  }
  const payload = { ...state.previewPayload, status };
  try {
    const res = await api('/api/bills', { method: 'POST', body: JSON.stringify(payload) });
    const bills = res.bills || [];
    const names = bills.map((b) => (b.fee_key === 'water' ? '水费' : '电费')).join(' + ');
    toast(
      `${status === 'draft' ? '已保存草稿' : '已保存'} ${bills.length} 张账单${names ? `（${names}）` : ''}`
    );
    $('#preview-card').hidden = true;
    state.preview = null;
    state.previewPayload = null;
    switchView('bills');
  } catch (err) {
    toast(err.message, true);
  }
}

function resetForm() {
  const eRange = lastMonthRange();
  const wRange = waterCycleRange();
  $('#electric_period_start').value = eRange.start;
  $('#electric_period_end').value = eRange.end;
  $('#water_period_start').value = wRange.start;
  $('#water_period_end').value = wRange.end;
  $('#electric_total').value = '0';
  $('#water_total').value = '0';
  $('#electric_mode').value = 'room-days';
  $('#water_mode').value = 'person-days';
  $('#bill-note').value = '';
  state.overrides = { electric: {}, water: {} };
  state.preview = null;
  state.previewPayload = null;
  $('#preview-card').hidden = true;
  toast('已重置为默认值');
}

/** 填入 Excel 表格中的示例数据，便于核对「电费 760.62 / 水费 361.90」的分摊结果 */
function fillExample() {
  $('#electric_total').value = '760.62';
  $('#water_total').value = '361.9';
  $('#bill-note').value = '示例金额：电费 760.62 元、水费 361.90 元';
  state.overrides = { electric: {}, water: {} };
  toast('已填入示例金额，点击「计算预览」');
}

/* ---------------- 历史账单 ---------------- */
async function loadBills() {
  try {
    const data = await api('/api/bills');
    state.bills = data.bills || [];
    renderBills();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderBills() {
  const table = $('#bills-table');
  const bills = state.bills;
  $('#bills-empty').hidden = bills.length > 0;
  // 没有账单时只显示提示语，避免出现「空表头 + 提示」两套内容
  const wrap = table.closest('.table-wrap');
  if (wrap) wrap.hidden = bills.length === 0;

  table.innerHTML = `
    <thead><tr>
      <th>类型</th><th>账单</th><th>计费期间</th><th class="num">金额(元)</th>
      <th>状态</th><th>创建时间</th><th>操作</th>
    </tr></thead>
    <tbody>${
      bills
        .map(
          (b) => `<tr>
        <td><span class="badge ${b.fee_key === 'water' ? 'water' : 'electric'}">${
            b.fee_key === 'water' ? '水费' : '电费'
          }</span></td>
        <td class="strong">${escapeHtml(b.label)}</td>
        <td class="mono">${escapeHtml(b.period_start)} ~ ${escapeHtml(b.period_end)}</td>
        <td class="num strong">${fmtMoney(b.total_cents)}</td>
        <td><span class="badge ${b.status === 'draft' ? 'draft' : 'final'}">${
            b.status === 'draft' ? '草稿' : '已确认'
          }</span></td>
        <td class="muted mono">${escapeHtml(b.created_at)}</td>
        <td class="nowrap">
          <button class="btn-link" data-act="view" data-id="${b.id}">查看</button>
          <a class="btn-link" href="/api/bills/${b.id}/csv" download>导出 CSV</a>
          <button class="btn-link danger" data-act="del" data-id="${b.id}">删除</button>
        </td>
      </tr>`
        )
        .join('') || ''
    }</tbody>`;

  $$('#bills-table [data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      if (btn.dataset.act === 'view') {
        openBillDetail(id);
      } else if (btn.dataset.act === 'del') {
        const bill = state.bills.find((b) => b.id === id);
        if (!confirm(`确定删除账单「${bill ? bill.label : id}」吗？删除后不可恢复。`)) return;
        try {
          await api(`/api/bills/${id}`, { method: 'DELETE' });
          await loadBills();
          toast('账单已删除');
        } catch (err) {
          toast(err.message, true);
        }
      }
    });
  });
}

async function openBillDetail(id) {
  try {
    const bill = await api(`/api/bills/${id}`);
    const snapshot = bill.snapshot || {};
    const feeKey = bill.fee_key || 'electric';
    const fee = (snapshot.fees || []).find((f) => f.key === feeKey) || {
      key: feeKey,
      name: feeKey === 'water' ? '水费' : '电费',
      period: { start: bill.period_start, end: bill.period_end, days: 0 },
      total_cents: bill.total_cents,
      total_yuan: bill.total_cents / 100,
      weight_sum: 0,
      unit_price: bill.unit_price || 0,
      mode: bill.mode,
      mode_label: '',
      items: [],
    };

    const card = `<div class="sum-card accent">
      <div class="k">${escapeHtml(fee.name)}金额</div>
      <div class="v">¥ ${fmtMoney(bill.total_cents)}</div>
      <div class="s">期间 ${escapeHtml(bill.period_start)} ~ ${escapeHtml(bill.period_end)}</div>
      <div class="s">${bill.status === 'draft' ? '草稿' : '已确认'} · ${escapeHtml(bill.created_at)}</div>
    </div>`;

    openModal(
      bill.label,
      `<div class="summary-grid">${card}</div>
      ${bill.note ? `<div class="warning-item">备注：${escapeHtml(bill.note)}</div>` : ''}
      ${renderFeeTable(fee, { manual: false })}`,
      `<a class="btn ghost" href="/api/bills/${bill.id}/csv" download>导出 CSV</a>
       <button class="btn primary" data-close>关闭</button>`
    );
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 离住记录总览 ---------------- */
function initAbsenceFilters() {
  applyAbsenceRange('3m');
  const roomSel = $('#absence-room');
  roomSel.innerHTML =
    '<option value="">全部房间</option>' +
    state.rooms.map((r) => `<option value="${r.id}">${escapeHtml(r.room_no)}</option>`).join('');
}

function applyAbsenceRange(range) {
  const now = new Date();
  const startInput = $('#absence-start');
  const endInput = $('#absence-end');
  if (range === '3m') {
    const start = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    startInput.value = isoDate(start);
    endInput.value = isoDate(now);
  } else if (range === 'year') {
    startInput.value = `${now.getFullYear()}-01-01`;
    endInput.value = isoDate(now);
  } else {
    startInput.value = '';
    endInput.value = '';
  }
  loadAbsences();
}

async function loadAbsences() {
  const params = new URLSearchParams();
  if ($('#absence-start').value) params.set('start', $('#absence-start').value);
  if ($('#absence-end').value) params.set('end', $('#absence-end').value);
  if ($('#absence-room').value) params.set('room_id', $('#absence-room').value);
  let data;
  try {
    data = await api('/api/absences?' + params.toString());
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const list = data.absences || [];
  const table = $('#absences-table');
  $('#absences-empty').hidden = list.length > 0;
  table.closest('.table-wrap').hidden = list.length === 0;
  table.innerHTML = `
    <thead><tr>
      <th>房号</th><th>姓名</th><th>开始</th><th>结束</th><th class="num">天数</th><th>备注</th><th>操作</th>
    </tr></thead>
    <tbody>${
      list
        .map(
          (a) => `<tr>
        <td class="room-cell">${escapeHtml(a.room_no)}</td>
        <td>${escapeHtml(a.tenant_name)}</td>
        <td class="mono">${escapeHtml(a.start_date)}</td>
        <td class="mono">${escapeHtml(a.end_date)}</td>
        <td class="num strong">${a.days}</td>
        <td class="muted">${escapeHtml(a.note || '')}</td>
        <td><button class="btn-link danger" data-act="del-absence" data-id="${a.id}">删除</button></td>
      </tr>`
        )
        .join('') || '<tr><td colspan="7" class="muted">暂无记录</td></tr>'
    }</tbody>`;
  $$('#absences-table [data-act="del-absence"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除这条离住记录吗？')) return;
      try {
        await api('/api/absences/' + btn.dataset.id, { method: 'DELETE' });
        toast('已删除');
        await loadAbsences();
        await loadRooms();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ---------------- 设置：密码 / 备份 / 恢复 / 退出 ---------------- */
function openSettings() {
  const publicUrl = `${location.origin}/absence`;
  openModal(
    '设置',
    `<div class="settings-grid">
      <section class="settings-block">
        <h3>访问密码</h3>
        <p class="hint">进入系统需要输入密码（短密码即可），修改后需要重新登录。</p>
        <form id="pw-form" class="form-grid compact">
          <label class="field"><span>原密码</span><input type="password" id="pw-old" autocomplete="current-password" /></label>
          <label class="field"><span>新密码</span><input type="password" id="pw-new" autocomplete="new-password" minlength="4" /></label>
          <div class="settings-actions"><button type="submit" class="btn primary small">修改密码</button></div>
        </form>
      </section>

      <section class="settings-block">
        <h3>数据备份</h3>
        <p class="hint">下载完整的 SQLite 备份（含房间、人员、离住记录、历史账单），建议定期保存。</p>
        <a class="btn ghost small" href="/api/backup" download>下载备份文件</a>
      </section>

      <section class="settings-block">
        <h3>从备份恢复</h3>
        <p class="hint">上传之前下载的 .db 备份覆盖当前数据。恢复前会自动先备份当前数据。</p>
        <div class="settings-actions">
          <input type="file" id="restore-file" accept=".db,application/octet-stream" />
          <button class="btn danger small" id="btn-restore">恢复数据</button>
        </div>
      </section>

      <section class="settings-block">
        <h3>离住记录登记链接（无需密码）</h3>
        <p class="hint">把这个链接发给住户，他们可以自己登记回老家/暂离时间。</p>
        <div class="settings-actions">
          <input type="text" class="url-input" id="public-url" readonly value="${escapeHtml(publicUrl)}" />
          <button class="btn ghost small" id="btn-copy-url">复制</button>
          <a class="btn ghost small" href="/absence" target="_blank">打开</a>
        </div>
      </section>

      <section class="settings-block">
        <h3>账号</h3>
        <div class="settings-actions">
          <button class="btn danger small" id="btn-logout">退出登录</button>
        </div>
      </section>
    </div>`,
    '<button class="btn primary" data-close>关闭</button>'
  );

  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          old_password: $('#pw-old').value,
          new_password: $('#pw-new').value,
        }),
      });
      toast('密码已修改，请重新登录');
      setTimeout(() => location.replace('/login'), 900);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#btn-copy-url').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast('链接已复制');
    } catch {
      $('#public-url').select();
      document.execCommand && document.execCommand('copy');
      toast('链接已复制');
    }
  });

  $('#btn-restore').addEventListener('click', async () => {
    const file = $('#restore-file').files[0];
    if (!file) return toast('请先选择备份文件', true);
    if (!confirm('恢复会用备份覆盖当前所有数据（恢复前会自动备份当前数据），确定继续？')) return;
    const btn = $('#btn-restore');
    btn.disabled = true;
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '恢复失败');
      toast('恢复成功，正在刷新…');
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    location.replace('/login');
  });
}

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', init);
