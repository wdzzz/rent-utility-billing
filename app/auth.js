'use strict';

/**
 * 访问密码（短密码）与会话：
 *  - 密码用 scrypt 加盐哈希后存到 data/config.json，不保存明文
 *  - 登录成功后下发 HttpOnly 会话 Cookie，会话保存在内存里（重启服务需重新登录）
 *  - 未设置密码时（首次使用）调用 setPassword 初始化
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE_NAME = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const MIN_PASSWORD_LEN = 4;
const MAX_PASSWORD_LEN = 64;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

class Auth {
  /**
   * @param {string} configPath 密码配置文件路径
   * @param {string} [envPassword] 环境变量兜底密码（仅用于测试/应急，不写入文件）
   */
  constructor({ configPath, envPassword = '' }) {
    this.configPath = configPath;
    this.envPassword = String(envPassword || '');
    this.sessions = new Map(); // token -> 过期时间戳
    this.config = this.#loadConfig();
  }

  #loadConfig() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const conf = JSON.parse(raw);
      if (conf && typeof conf.password_hash === 'string' && typeof conf.salt === 'string') {
        return conf;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 是否已经设置过访问密码 */
  isConfigured() {
    return Boolean(this.config) || Boolean(this.envPassword);
  }

  validatePassword(password) {
    const pw = String(password ?? '');
    if (pw.length < MIN_PASSWORD_LEN) {
      throw new Error(`密码至少 ${MIN_PASSWORD_LEN} 位`);
    }
    if (pw.length > MAX_PASSWORD_LEN) {
      throw new Error(`密码最多 ${MAX_PASSWORD_LEN} 位`);
    }
    return pw;
  }

  /** 首次设置密码（已设置过则抛出，防止被覆盖） */
  setPassword(password) {
    if (this.isConfigured()) throw new Error('已经设置过访问密码，请直接登录');
    return this.#persist(password);
  }

  /** 修改密码（需要旧密码） */
  changePassword(oldPassword, newPassword) {
    if (!this.verify(oldPassword)) throw new Error('原密码不正确');
    return this.#persist(newPassword);
  }

  #persist(password) {
    const pw = this.validatePassword(password);
    const salt = crypto.randomBytes(16).toString('hex');
    const config = {
      password_hash: hashPassword(pw, salt),
      salt,
      updated_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    this.config = config;
    // 改密码后让所有旧会话失效
    this.sessions.clear();
    return { configured: true };
  }

  verify(password) {
    const pw = String(password ?? '');
    if (this.config) {
      const expected = Buffer.from(this.config.password_hash, 'hex');
      const actual = Buffer.from(hashPassword(pw, this.config.salt), 'hex');
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    // 配置文件还没写入时，允许用环境变量密码（测试或应急）
    return this.envPassword ? pw === this.envPassword : false;
  }

  createSession() {
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    this.#gc();
    return token;
  }

  destroySession(token) {
    if (token) this.sessions.delete(token);
  }

  #gc() {
    const now = Date.now();
    for (const [token, expires] of this.sessions) {
      if (expires <= now) this.sessions.delete(token);
    }
  }

  tokenFromRequest(req) {
    return parseCookies(req.headers.cookie || '')[COOKIE_NAME] || '';
  }

  /** 该请求是否已登录（会顺延会话有效期） */
  isAuthed(req) {
    if (!this.isConfigured()) return false;
    const token = this.tokenFromRequest(req);
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires || expires <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
  }

  /** secure=true 时加 Secure（HTTPS 反向代理场景） */
  sessionCookie(token, { secure = false } = {}) {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}${secure ? '; Secure' : ''}`;
  }

  clearCookie({ secure = false } = {}) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

module.exports = { Auth, COOKIE_NAME };
