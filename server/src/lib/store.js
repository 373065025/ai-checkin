// 配置与日志持久化（CONFIG_DIR/settings.json + logs.json）
import fs from 'node:fs';
import path from 'node:path';
import { uid } from './util.js';
import { AGREEMENT_REVISION } from './agreement.js';

export const VERSION = '1.0.9';
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(process.cwd(), 'config_data');

export function configDir() { return CONFIG_DIR; }

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const LOGS_FILE = path.join(CONFIG_DIR, 'logs.json');

export function defaultSettings() {
  return {
    providers: [],
    notify: { enabled: false, format: 'generic', url: '' },
    scheduler: { runOnStart: true },
    // 用户协议：安装后首次使用必须同意；记录同意的条款版本，条款修订后会重新提示
    agreement: { revision: '', acceptedAt: 0 },
    // 管理员密码（可选，默认关闭）。只存 scrypt 哈希，明文永不落盘；
    // 不进备份、也不被备份覆盖 —— 换机器恢复配置不会把旧密码带过来
    admin: { enabled: false, salt: '', hash: '', updatedAt: 0 },
    // 应用内自动更新配置（默认走 GitHub Releases；清空 url 即停用自动更新）
    update: {
      url: 'https://github.com/373065025/ai-checkin/releases/latest',
      altUrl: '', autoCheck: true, token: '', user: '', password: '',
    },
  };
}

let settings = null;
let logs = [];
let saveTimer = null;
let logTimer = null;

export function load() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch { settings = null; }
  settings = { ...defaultSettings(), ...(settings || {}) };
  // 老配置没有 admin 字段（1.0.9 新增）→ 补默认值，否则鉴权读不到字段会一直要求登录
  settings.admin = { ...defaultSettings().admin, ...(settings.admin || {}) };
  if (!Array.isArray(settings.providers)) settings.providers = [];
  // 兜底：保证内置 WorkBuddy 任务存在
  if (!settings.providers.some((p) => p.type === 'workbuddy')) {
    settings.providers.push({
      id: uid(),
      type: 'workbuddy',
      name: 'WorkBuddy 加油站',
      enabled: false,
      token: '',
      domain: 'www.codebuddy.cn',
      autoCheckin: true,
      travelAuto: true,
      locationId: 0, // 0 = 随机地点
      schedule: { times: ['09:00'] },
      lastRun: null,
    });
  }
  try {
    logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    if (!Array.isArray(logs)) logs = [];
  } catch { logs = []; }
  return settings;
}

export function get() {
  if (!settings) load();
  return settings;
}

export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const tmp = SETTINGS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
      fs.renameSync(tmp, SETTINGS_FILE);
    } catch (e) {
      console.error('[store] save settings failed:', e.message);
    }
  }, 150);
}

export function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    console.error('[store] save settings failed:', e.message);
  }
}

// ---------- 用户协议 ----------

/** 已同意的条款版本与当前条款版本一致才算通过（条款修订后会重新要求同意） */
export function isAgreementAccepted() {
  const a = get().agreement || {};
  return !!a.revision && a.revision === AGREEMENT_REVISION;
}

export function getAgreementState() {
  const a = get().agreement || {};
  // 字段名刻意与协议正文的 revision（当前条款版本）区分开，避免拼装响应时互相覆盖
  return { accepted: isAgreementAccepted(), acceptedRevision: a.revision || '', acceptedAt: a.acceptedAt || 0 };
}

export function acceptAgreement() {
  const s = get();
  s.agreement = { revision: AGREEMENT_REVISION, acceptedAt: Date.now() };
  saveNow();
  return getAgreementState();
}

export function revokeAgreement() {
  const s = get();
  s.agreement = { revision: '', acceptedAt: 0 };
  saveNow();
  return getAgreementState();
}

// ---------- 日志 ----------
const MAX_LOGS = 600;

export function addLog(entry) {
  logs.unshift({ ts: new Date().toISOString(), ...entry });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  if (logTimer) return;
  logTimer = setTimeout(() => {
    logTimer = null;
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const tmp = LOGS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(logs, null, 2), 'utf8');
      fs.renameSync(tmp, LOGS_FILE);
    } catch (e) {
      console.error('[store] save logs failed:', e.message);
    }
  }, 300);
}

export function getLogs(limit = 300) { return logs.slice(0, limit); }
export function clearLogs() { logs = []; saveLogsNow(); }
export function saveLogsNow() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch { /* ignore */ }
}
