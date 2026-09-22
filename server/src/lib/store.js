// 配置与日志持久化（CONFIG_DIR/settings.json + logs.json）
import fs from 'node:fs';
import path from 'node:path';
import { uid } from './util.js';

export const VERSION = '1.0.3';
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(process.cwd(), 'config_data');

export function configDir() { return CONFIG_DIR; }

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const LOGS_FILE = path.join(CONFIG_DIR, 'logs.json');

export function defaultSettings() {
  return {
    providers: [],
    notify: { enabled: false, format: 'generic', url: '' },
    scheduler: { runOnStart: true },
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
