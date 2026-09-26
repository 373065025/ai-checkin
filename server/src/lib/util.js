// 通用小工具：零依赖
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export const todayStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const nowHM = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const nowText = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${todayStr(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const maskToken = (t) => {
  if (!t || typeof t !== 'string') return '';
  if (t.length <= 16) return t.slice(0, 4) + '****';
  return `${t.slice(0, 10)}...${t.slice(-6)}（已保存，长度${t.length}）`;
};

/** 手机号打码：17725142573 → 177****2573 */
export const maskPhone = (p) => {
  const s = String(p || '').replace(/\D/g, '');
  if (s.length < 7) return s ? '****' : '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
};

/**
 * 解析 JWT 的 payload 段（不校验签名，仅用于「认出这是哪个账号」）。
 * WorkBuddy 的 accessToken 是 JWT，payload 里带 nickname / preferred_username / sub，
 * 而查询类接口不返回任何账号信息，所以只能从这里拿标识。
 * 解析失败一律返回 null，绝不抛错。
 */
export function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const p = JSON.parse(json);
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

/**
 * 从 token 推断账号标识（用于多账号区分）。
 * @returns {{uid:string, nickname:string, phoneMasked:string, email:string}|null}
 */
export function accountOfToken(token) {
  const p = decodeJwtPayload(token);
  if (!p) return null;
  const uid = String(p.sub || p.uid || p.oneid_union_id || '').slice(0, 64);
  const nickname = String(p.nickname || p.name || p.preferred_username || '').slice(0, 60);
  const phoneMasked = maskPhone(p.phone_number || p.preferred_username || '');
  const email = String(p.email || '').slice(0, 120);
  if (!uid && !nickname && !phoneMasked) return null;
  return { uid, nickname, phoneMasked, email };
}

// 带重试的 fetch：网络错误 / 5xx / 空响应 重试
export async function fetchRetry(url, options = {}, { retries = 2, timeoutMs = 15000 } = {}) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      const text = await res.text();
      if (res.status >= 500 && i < retries) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      return { status: res.status, text };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) await sleep(800 * (i + 1));
    }
  }
  throw lastErr || new Error('request failed');
}

/**
 * 限制并发的 map：结果顺序与输入一致。
 * 多账号一键签到用它代替串行 for 循环（10 个账号串行要好几十秒）。
 */
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items || []);
  const out = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  const n = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// 安全取 JSON
export function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// 按 a.b.c 取对象路径
export function pickPath(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else cur = cur[key];
  }
  return cur;
}

// 解析 cURL 命令 → { url, method, headers, body }
export function parseCurl(cmd) {
  // 归一化：去换行续行符、统一引号
  let s = String(cmd).replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ').trim();
  if (s.startsWith('curl')) s = s.slice(4);

  const out = { url: '', method: 'GET', headers: {}, body: '' };
  const re = /(-X|--request|--data(?:-raw|-ascii|-binary)?|--data-urlencode|-H|--header|--url|--cookie|-b|--user-agent|-A)\s+("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\s]+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const flag = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\(["'])/g, '$1');
    }
    if (flag === '--url' || (flag === undefined)) { /* not used */ }
    if (flag === '-H' || flag === '--header') {
      const idx = val.indexOf(':');
      if (idx > 0) out.headers[val.slice(0, idx).trim()] = val.slice(idx + 1).trim();
    } else if (flag === '-X' || flag === '--request') {
      out.method = val.toUpperCase();
    } else if (flag.startsWith('--data')) {
      out.method = out.method === 'GET' ? 'POST' : out.method;
      out.body = val;
    } else if (flag === '--url') {
      out.url = val;
    } else if (flag === '-A' || flag === '--user-agent') {
      out.headers['User-Agent'] = val;
    } else if (flag === '-b' || flag === '--cookie') {
      out.headers['Cookie'] = val;
    }
  }
  if (!out.url) {
    // 裸 URL：最后一个非 flag 参数
    const tokens = s.split(/\s+/).filter((t) => t && !t.startsWith('-'));
    const cand = tokens.reverse().find((t) => /^https?:\/\//.test(t.replace(/^["']|["']$/g, '')));
    if (cand) out.url = cand.replace(/^["']|["']$/g, '');
  }
  return out;
}
