'use strict';

// 离住记录公开登记（无需登录）：只能新增，不能查看别人的记录
const $ = (sel) => document.querySelector(sel);

let roomData = [];

function escapeHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortDate(d) {
  return d ? String(d).slice(5) : '';
}

function absenceText(room) {
  const list = room.absences || [];
  if (!list.length) return '<span class="muted">无离住记录</span>';
  // 每条离住记录单独一行，避免多段记录挤在一起
  return list
    .map((a) => {
      const range = a.start ? `${shortDate(a.start)} ~ ${shortDate(a.end)}` : '回老家';
      return `<div class="abs-line"><span class="chip gray">${escapeHtml(a.name)}：${range}（${
        a.days
      }天）${a.note ? ' ' + escapeHtml(a.note) : ''}</span></div>`;
    })
    .join('');
}

function yuan(cents) {
  return (Number(cents || 0) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dateToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
  return data || {};
}

function fillRooms() {
  const roomSel = $('#pa-room');
  roomSel.innerHTML =
    '<option value="">请选择房间</option>' +
    roomData.map((r) => `<option value="${r.room_no}">${r.room_no}</option>`).join('');
  const tenantSel = $('#pa-tenant');
  tenantSel.innerHTML = '<option value="">先选房间</option>';
  tenantSel.disabled = true;
}

function fillTenants(roomNo) {
  const room = roomData.find((r) => r.room_no === roomNo);
  const tenantSel = $('#pa-tenant');
  if (!room || !room.tenants.length) {
    tenantSel.innerHTML = '<option value="">该房间暂无住户</option>';
    tenantSel.disabled = true;
    return;
  }
  tenantSel.innerHTML =
    '<option value="">请选择住户</option>' +
    room.tenants.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  tenantSel.disabled = false;
}

function showMessage(text, isError) {
  const msg = $('#pa-msg');
  msg.textContent = text;
  msg.style.color = isError ? '#b91c1c' : '#047857';
}

async function submit(event) {
  event.preventDefault();
  showMessage('');
  const tenantId = Number($('#pa-tenant').value);
  const start = $('#pa-start').value;
  const end = $('#pa-end').value;
  const note = $('#pa-note').value.trim();
  if (!tenantId) return showMessage('请选择住户', true);
  if (!start || !end) return showMessage('请选择开始和结束日期', true);
  if (end < start) return showMessage('结束日期不能早于开始日期', true);

  const submitBtn = $('#pa-submit');
  submitBtn.disabled = true;
  try {
    const res = await api('/api/public/absences', {
      method: 'POST',
      body: JSON.stringify({ tenant_id: tenantId, start_date: start, end_date: end, note }),
    });
    const box = $('#pa-success');
    box.hidden = false;
    box.innerHTML = `已登记：<strong>${res.room_no} ${res.tenant_name}</strong>，${start} ~ ${end}${
      note ? `（${note}）` : ''
    }<br /><span class="hint">如填错，请联系房东在后台删除后重新登记。</span>`;
    $('#absence-form').reset();
    $('#pa-tenant').innerHTML = '<option value="">先选房间</option>';
    $('#pa-tenant').disabled = true;
    $('#pa-end').min = dateToday();
    showMessage('提交成功', false);
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
}

function renderBills(bills) {
  const box = $('#pb-list');
  if (!bills.length) {
    box.innerHTML = '<p class="muted">还没有账单</p>';
    return;
  }
  box.innerHTML = bills
    .map(
      (b) => `<details class="public-bill">
        <summary>
          <span class="badge ${b.fee_key === 'water' ? 'water' : 'electric'}">${
        b.fee_key === 'water' ? '水费' : '电费'
      }</span>
          <span class="pb-label">${escapeHtml(b.label)}</span>
          <span class="pb-period">${escapeHtml(b.period_start)} ~ ${escapeHtml(b.period_end)}</span>
          <span class="pb-total">¥ ${yuan(b.total_cents)}</span>
        </summary>
        <table class="data-table bill-rooms-table">
          <thead><tr><th>房号</th><th class="num">金额(元)</th><th>离住记录（本期间）</th></tr></thead>
          <tbody>${
            b.rooms
              .map(
                (r) => `<tr>
                  <td class="room-cell">${escapeHtml(r.room_no)}</td>
                  <td class="num">${yuan(r.amount_cents)}</td>
                  <td class="abs-cell">${absenceText(r)}</td>
                </tr>`
              )
              .join('') || '<tr><td colspan="3" class="muted">暂无房间明细</td></tr>'
          }</tbody>
        </table>
        <p class="hint">离住记录仅显示姓名与日期，方便核对扣减天数；不包含电话、身份证等信息。</p>
        <p class="hint">状态：${b.status === 'draft' ? '草稿' : '已确认'} · 生成时间 ${escapeHtml(
          b.created_at || ''
        )}</p>
      </details>`
    )
    .join('');
}

async function loadBills() {
  try {
    const data = await api('/api/public/bills');
    renderBills(data.bills || []);
  } catch (err) {
    $('#pb-list').innerHTML = `<p class="muted">账单加载失败：${escapeHtml(err.message)}</p>`;
  }
}

async function main() {
  const today = dateToday();
  $('#pa-start').max = today;
  $('#pa-start').value = today;
  $('#pa-end').value = today;
  $('#pa-end').min = $('#pa-start').value;

  $('#pa-start').addEventListener('change', () => {
    $('#pa-end').min = $('#pa-start').value;
    if ($('#pa-end').value && $('#pa-end').value < $('#pa-start').value) {
      $('#pa-end').value = $('#pa-start').value;
    }
  });

  try {
    const data = await api('/api/public/rooms');
    roomData = data.rooms || [];
    fillRooms();
  } catch (err) {
    showMessage(err.message, true);
  }

  $('#pa-room').addEventListener('change', (e) => fillTenants(e.target.value));
  $('#absence-form').addEventListener('submit', submit);
  loadBills();
}

main();
