'use strict';

const $ = (sel) => document.querySelector(sel);

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

function showError(message) {
  const box = $('#auth-error');
  box.textContent = message;
  box.hidden = !message;
}

async function main() {
  const status = await api('/api/auth/status');
  if (status.authed) {
    location.replace('/');
    return;
  }

  const setupMode = !status.configured;
  if (setupMode) {
    $('#auth-title').textContent = '设置访问密码';
    $('#auth-desc').textContent = '第一次使用，请设置一个访问密码（至少 4 位，短密码即可），之后进入系统需要输入。';
    $('#confirm-field').hidden = false;
    $('#auth-password').placeholder = '设置密码（至少 4 位）';
    $('#auth-password').autocomplete = 'new-password';
    $('#auth-submit').textContent = '设置并进入';
  }

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const password = $('#auth-password').value;
    const submit = $('#auth-submit');
    submit.disabled = true;
    try {
      if (setupMode) {
        const confirm = $('#auth-confirm').value;
        if (password.length < 4) throw new Error('密码至少 4 位');
        if (password !== confirm) throw new Error('两次输入的密码不一致');
        await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password }) });
      } else {
        await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      }
      location.replace('/');
    } catch (err) {
      showError(err.message);
      submit.disabled = false;
    }
  });

  $('#auth-password').focus();
}

main().catch((err) => {
  showError(err.message || '页面加载失败，请刷新重试');
});
