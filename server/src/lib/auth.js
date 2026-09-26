// 管理员鉴权（可选）：设置密码后，Web 界面的接口需要登录才能访问
//
// 设计要点：
// - 不设密码时行为与旧版完全一致（全部放行），老用户升级后不会被突然锁在外面
// - 密码只存 scrypt 派生的哈希 + 随机盐，明文永不落盘
// - 防爆破：同一来源 IP 连续输错 10 次 → 拉黑 1 小时，期间即使密码正确也拒绝
// - 拉黑状态只在内存里（重启即解封），不落盘，避免把自己永久锁死
// - 定时任务 / 自动更新走的是进程内部调用，不经 HTTP，不受密码影响
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { get, saveNow } from './store.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 登录有效期 12 小时（有操作则自动续期）
const MAX_FAILS = 10;                        // 连续错误次数上限
const BAN_MS = 60 * 60 * 1000;               // 超限后拉黑 1 小时
const MIN_PASSWORD_LEN = 6;
const KEY_LEN = 64;

const sessions = new Map();  // token -> { exp, ip }
const attempts = new Map();  // ip -> { fails, bannedUntil, lastAt }

/** 客户端 IP（兼容反向代理透传的 X-Forwarded-For 与 IPv4-mapped IPv6） */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd) || req.socket?.remoteAddress || 'unknown';
  return String(raw).split(',')[0].trim().replace(/^::ffff:/, '');
}

function derive(password, salt) {
  return scryptSync(String(password), String(salt), KEY_LEN).toString('hex');
}

/** 生成密码哈希记录（只在设置密码时调用一次） */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: derive(password, salt) };
}

/** 恒定时间比较，避免通过响应耗时侧信道猜测密码 */
export function verifyPassword(password, rec) {
  const salt = rec?.salt;
  const hash = rec?.hash;
  if (!salt || !hash) return false;
  const a = Buffer.from(derive(password, salt), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function adminRecord() {
  return get().admin || {};
}

/** 是否已启用管理员密码 */
export function isEnabled() {
  const a = adminRecord();
  return !!(a.enabled && a.salt && a.hash);
}

function cleanAttempts(now = Date.now()) {
  for (const [ip, rec] of attempts) {
    // 拉黑早过期且近期没有再错 → 丢掉，避免字典无限增长
    if (!rec.bannedUntil && now - (rec.lastAt || 0) > BAN_MS) attempts.delete(ip);
  }
}

function cleanSessions(now = Date.now()) {
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
}

// 每小时清理一次过期记录；unref 保证不会拖住进程退出
const cleaner = setInterval(() => { cleanAttempts(); cleanSessions(); }, 60 * 60 * 1000);
cleaner.unref?.();

/** 取请求里的 session token（Authorization: Bearer xxx） */
export function sessionToken(req) {
  const h = req.headers['authorization'];
  const raw = Array.isArray(h) ? h[0] : h || '';
  const m = /^Bearer[ \t]+(.+)$/i.exec(String(raw));
  return m ? m[1].trim() : '';
}

/** 校验 session（有效则顺手续期） */
export function isValidSession(req) {
  const t = sessionToken(req);
  if (!t) return false;
  const s = sessions.get(t);
  if (!s) return false;
  const now = Date.now();
  if (s.exp < now) { sessions.delete(t); return false; }
  s.exp = now + SESSION_TTL_MS;
  return true;
}

/** 接口是否放行：没设密码 → 全放行；设了密码 → 必须有有效 session */
export function isAuthorized(req) {
  if (!isEnabled()) return true;
  return isValidSession(req);
}

/** 登录页需要的信息（不涉及任何凭据，可公开调用） */
export function authState(req) {
  const ip = clientIp(req);
  const rec = attempts.get(ip);
  const now = Date.now();
  const locked = !!rec && rec.bannedUntil > now;
  return {
    enabled: isEnabled(),
    authed: isValidSession(req),
    locked,
    lockSeconds: locked ? Math.ceil((rec.bannedUntil - now) / 1000) : 0,
    fails: rec?.fails || 0,
    maxFails: MAX_FAILS,
    minLen: MIN_PASSWORD_LEN,
    sessionHours: SESSION_TTL_MS / 3600000,
  };
}

/**
 * 登录。
 * 已拉黑时直接拒绝；密码错误计数，达到上限即刻拉黑 1 小时。
 */
export function login(req, password) {
  if (!isEnabled()) return { ok: true, noPassword: true };
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip) || { fails: 0, bannedUntil: 0, lastAt: 0 };
  if (rec.bannedUntil > now) {
    return { ok: false, locked: true, lockSeconds: Math.ceil((rec.bannedUntil - now) / 1000), remaining: 0 };
  }
  if (verifyPassword(password, adminRecord())) {
    attempts.delete(ip);
    const token = randomBytes(24).toString('hex');
    sessions.set(token, { exp: now + SESSION_TTL_MS, ip });
    return { ok: true, token, expiresAt: now + SESSION_TTL_MS };
  }
  rec.fails += 1;
  rec.lastAt = now;
  let locked = false;
  if (rec.fails >= MAX_FAILS) {
    rec.bannedUntil = now + BAN_MS;
    rec.fails = 0; // 解封后重新计 10 次
    locked = true;
  }
  attempts.set(ip, rec);
  cleanAttempts(now);
  return {
    ok: false,
    locked,
    lockSeconds: locked ? Math.ceil((rec.bannedUntil - now) / 1000) : 0,
    remaining: locked ? 0 : MAX_FAILS - rec.fails,
  };
}

export function logout(req) {
  const t = sessionToken(req);
  if (t) sessions.delete(t);
  return { ok: true };
}

/**
 * 设置 / 修改 / 关闭管理员密码。
 * newPassword 为空字符串 = 关闭密码（需要验证旧密码）。
 * 改密码会让所有已登录的设备重新登录。
 */
export function setPassword(oldPassword, newPassword) {
  const had = isEnabled();
  if (had && !verifyPassword(oldPassword, adminRecord())) {
    return { ok: false, message: '当前密码不正确' };
  }
  const next = String(newPassword || '');
  if (!next) {
    const s = get();
    s.admin = { enabled: false, salt: '', hash: '', updatedAt: Date.now() };
    sessions.clear();
    saveNow();
    return { ok: true, enabled: false, message: '已关闭管理员密码' };
  }
  if (next.length < MIN_PASSWORD_LEN) {
    return { ok: false, message: `密码至少 ${MIN_PASSWORD_LEN} 位` };
  }
  const { salt, hash } = hashPassword(next);
  const s = get();
  s.admin = { enabled: true, salt, hash, updatedAt: Date.now() };
  sessions.clear(); // 换密码后旧 session 全部失效
  saveNow();
  return { ok: true, enabled: true, message: had ? '管理员密码已更新，其他设备需要重新登录' : '管理员密码已启用' };
}
