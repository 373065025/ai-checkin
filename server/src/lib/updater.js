/**
 * 应用内自动更新（参照飞牛音乐下载 app 的更新模式，适配零依赖 Node 后端）
 *
 * 流程：拉取更新清单（updateUrl）→ 比对版本 → 下载 app.tgz → 校验 sha256
 *      → 备份旧版本（mv）→ 热替换 server/web/ui/manifest → 自重启
 *
 * 更新源（可同时配主源 / 备用源）：
 *   1. GitHub Releases（默认）：https://github.com/<owner>/<repo>/releases/latest
 *      在 Release 里上传 app-<版本>.tgz 即可；传的是 .fpk 也会自动拆出内部 app.tgz。
 *   2. 自定义清单：{ version, notes, url, sha256, size, publishedAt }
 *
 * 与音乐 app 的差异：
 *   - 用 Node 内置 fetch 取代 axios 的 client.get
 *   - 更新配置存到 store.js 的 settings.update（不污染 /api/state）
 *   - 默认更新源指向 GitHub 仓库（开源后即可用），也支持用户自建源
 *   - 自重启脚本适配 ai-checkin 的端口与路径
 */
import { readFile, rename, mkdir, rm, writeFile, access } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { get, save } from './store.js';
import { extractTgz } from './tar.js';

// 服务目录：server/src/lib/updater.js → ../../../ = APP_ROOT（target 目录，含 server/ web/ ui/ manifest）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, '../../..');
const WIN = process.platform === 'win32';

// ===== 更新配置（默认走 GitHub Releases，用户在设置页可改） =====
// 开源后把新版本打包成 app-<版本>.tgz 传到 GitHub Release，
// 客户端启动时 + 每 6 小时自动检查本仓库的 releases/latest 即可。
const DEFAULT_UPDATE = {
  url: 'https://github.com/373065025/ai-checkin/releases/latest', // GitHub 仓库更新源（可改成自定义 update.json 地址）
  altUrl: '',       // 备用更新源（主源不可用时自动切换）
  autoCheck: true,  // 启动时 + 每 6 小时自动检查
  token: '',        // GitHub 个人访问令牌（可选，仅用于提升 API 限额 / 私有仓库）
  user: '',         // Basic 认证用户名（自建更新源 / OpenList / WebDAV 时用）
  password: '',     // Basic 认证密码
};

// ai-checkin 没有内置私有更新源；默认源即上面的 GitHub 仓库。
export const BUILTIN_UPDATE_SOURCES = [];
const BUILTIN_UPDATE_AUTH = { user: '', password: '' };
const BUILTIN_UPDATE_HOSTS = [];

/** 读取当前版本（APP_ROOT/manifest 优先，其次 server/package.json） */
export async function getCurrentVersion() {
  try {
    const man = await readFile(path.join(APP_ROOT, 'manifest'), 'utf-8');
    const m = man.match(/^version\s*=\s*(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  try {
    const pkg = JSON.parse(await readFile(path.join(APP_ROOT, 'server', 'package.json'), 'utf-8'));
    if (pkg.version) return pkg.version;
  } catch {}
  return '0.0.0';
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// ===== 状态 =====
let lastCheck = null;        // { at, hasUpdate, current, latest, ... }
let lastGoodSource = null;   // 最近一次成功的更新源（含鉴权头，不下发给前端）
let task = {
  state: 'idle',          // idle | downloading | verifying | installing | restarting | done | error
  progress: 0,
  message: '',
  latest: '',
  error: '',
  finishedAt: 0,
};

export function getUpdateStatus() { return { ...task }; }
export function getLastCheck() { return lastCheck; }

// ===== 更新源 =====

/** tar.gz 的魔数检查：1f 8b */
function looksLikeGzip(buf) {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function absoluteUrl(baseUrl, u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  try { return new URL(u, baseUrl).toString() } catch { return u }
}

/**
 * 把 GitHub 仓库地址换算成 GitHub API 地址。
 * 注意：API 形式必须在域名后带 /repos/，否则 api.github.com/owner/repo 会 404。
 * 支持这几种输入：
 *   https://github.com/OWNER/REPO                    → .../repos/OWNER/REPO/releases/latest
 *   https://github.com/OWNER/REPO/releases           → .../repos/OWNER/REPO/releases
 *   https://github.com/OWNER/REPO/releases/latest    → .../repos/OWNER/REPO/releases/latest
 *   https://github.com/OWNER/REPO/releases/tag/vX    → .../repos/OWNER/REPO/releases/tag/vX
 *   https://api.github.com/repos/OWNER/REPO/...      → 原样返回
 */
function normalizeGitHub(url) {
  const u = String(url || '').trim();
  if (!u) return u;
  if (/api\.github\.com\/repos\//i.test(u)) return u; // 已经是 API 形式

  // 仓库首页
  let m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)\/?$/i);
  if (m) return `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`;

  // 带 releases 的地址
  m = u.match(/github\.com\/([^/]+)\/([^/]+)\/(releases(?:\/latest|\/tag\/[^/?#]+)?)/i);
  if (m) return `https://api.github.com/repos/${m[1]}/${m[2]}/${m[3]}`;

  return u.replace(/github\.com/i, 'api.github.com');
}

function isBuiltinHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BUILTIN_UPDATE_HOSTS.some(h => host === h.toLowerCase());
  } catch { return false }
}

/** 把错误信息里的自有域名 / 内网 IP 抹掉，避免接口把私有地址回显出去 */
function scrub(text) {
  let t = String(text || '');
  for (const h of BUILTIN_UPDATE_HOSTS) {
    t = t.split(h).join('***');
  }
  t = t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, '***');
  return t;
}

function authHeadersFor(url, settings = getSettings()) {
  const headers = {};
  const token = (settings.token || '').trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }
  const user = (settings.user || '').trim();
  const pwd = settings.password || '';
  if (user || pwd) {
    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pwd}`, 'utf-8').toString('base64');
    return headers;
  }
  if (isBuiltinHost(url)) {
    const { user: bu, password: bp } = BUILTIN_UPDATE_AUTH;
    if (bu || bp) headers.Authorization = 'Basic ' + Buffer.from(`${bu}:${bp}`, 'utf-8').toString('base64');
  }
  return headers;
}

function resolveSources() {
  const s = getSettings();
  const seen = new Set();
  const out = [];
  const add = (url, label, timeout = 12000) => {
    const u = (url || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ url: normalizeGitHub(u), label, timeout, headers: authHeadersFor(u, s) });
  };
  add(s.url, '主更新源');
  add(s.altUrl, '备用更新源');
  for (const b of BUILTIN_UPDATE_SOURCES) add(b.url, b.label, b.timeout);
  return out;
}

export function getUpdateSources() {
  const s = getSettings();
  return {
    sources: resolveSources().map(x => ({ label: x.label, builtin: isBuiltinHost(x.url) })),
    usingBuiltinAuth: !((s.token || '').trim() || (s.user || '').trim() || s.password)
      && !(s.url || '').trim(),
  };
}

// ===== 网络（Node 内置 fetch） =====

async function fetchText(url, { headers = {}, timeout = 15000, method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method,
      headers: { 'User-Agent': 'ai-checkin', ...headers },
      signal: ctrl.signal,
    });
    const text = await resp.text();
    return { status: resp.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchManifest(url, headers = {}, timeout = 15000) {
  const isGh = /api\.github\.com\/repos\/[^/]+\/[^/]+\/releases/.test(url);
  const { status, text } = await fetchText(url, {
    headers: { ...headers, Accept: isGh ? 'application/vnd.github+json' : 'application/json' },
    timeout,
  });

  // 先把 HTTP 层错误说清楚，避免被后续 JSON 解析掩盖成莫名其妙的报错
  if (status === 404) {
    throw new Error(isGh
      ? 'GitHub 仓库或 Release 不存在（404）—— 请确认仓库已创建、且已发布带 app-<版本>.tgz 的 Release'
      : '更新清单不存在（404）—— 请检查更新源地址');
  }
  if (status === 401 || status === 403) {
    throw new Error(`更新源拒绝访问（HTTP ${status}）${isGh ? '：私有仓库或触发限流时，请在「访问令牌」填入 GitHub Token' : '：请检查访问令牌 / 用户名密码'}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`更新源返回 HTTP ${status}`);
  }

  let d;
  try { d = JSON.parse(text); } catch { throw new Error('更新清单解析失败（返回的不是 JSON）'); }
  if (!d || typeof d !== 'object') throw new Error('更新清单不是合法的 JSON');

  if (isGh) {
    const assets = d.assets || [];
    const asset =
      assets.find(a => /^app-.*\.tgz$/i.test(a.name)) ||
      assets.find(a => /\.tgz$/i.test(a.name)) ||
      assets.find(a => /\.fpk$/i.test(a.name)) ||
      null;
    if (!asset) {
      throw new Error('该 Release 没有可下载的更新包（请在 Release 里上传 app-<版本>.tgz 或 .fpk）');
    }
    return {
      version: String(d.tag_name || '').replace(/^v/, ''),
      notes: (d.body || '').slice(0, 3000),
      url: asset.browser_download_url,
      assetName: asset.name,
      size: asset.size || 0,
      sha256: '',
      publishedAt: d.published_at || '',
      source: 'github',
    };
  }

  if (!d.version || !d.url) throw new Error('更新清单格式不正确（需要 version 与 url 字段）');
  return {
    version: String(d.version).replace(/^v/, ''),
    notes: d.notes || '',
    url: absoluteUrl(url, d.url),
    size: d.size || 0,
    sha256: d.sha256 || '',
    publishedAt: d.publishedAt || '',
    source: 'custom',
  };
}

export async function checkUpdate({ force = false } = {}) {
  const current = await getCurrentVersion();
  const sources = resolveSources();

  if (!sources.length) {
    lastCheck = { at: Date.now(), hasUpdate: false, current, latest: current, disabled: true, notes: '' };
    return lastCheck;
  }

  if (!force && lastCheck && Date.now() - lastCheck.at < 30 * 60 * 1000) return lastCheck;

  const attempts = [];
  for (const src of sources) {
    try {
      const latest = await fetchManifest(src.url, src.headers, src.timeout);
      const has = cmpVersion(latest.version, current) > 0;
      lastCheck = {
        at: Date.now(),
        hasUpdate: has,
        current,
        disabled: false,
        latest: latest.version,
        notes: latest.notes,
        size: latest.size,
        publishedAt: latest.publishedAt,
        source: latest.source,
        sourceLabel: src.label,
        fallback: attempts.length,
        attempts,
      };
      lastGoodSource = src;
      return lastCheck;
    } catch (err) {
      attempts.push({ label: src.label, error: scrub(err.message) });
    }
  }

  lastGoodSource = null;
  lastCheck = {
    at: Date.now(), hasUpdate: false, current, latest: current, disabled: false, notes: '',
    error: '所有更新源都不可用：' + attempts.map(a => `${a.label}（${a.error}）`).join('；'),
    attempts,
  };
  return lastCheck;
}

// ===== 执行更新 =====

async function backupsDir() {
  const dir = path.join(process.env.CONFIG_DIR || path.join(APP_ROOT, '..', 'var'), 'backups');
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

async function updatesDir() {
  const dir = path.join(process.env.CONFIG_DIR || path.join(APP_ROOT, '..', 'var'), 'updates');
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

export async function listBackups() {
  const dir = await backupsDir();
  const { readdir } = await import('fs/promises');
  try {
    const items = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const i of items) {
      if (!i.isDirectory()) continue;
      if (existsSync(path.join(dir, i.name, '.backup.json'))) out.push(i.name);
    }
    return out.sort().reverse();
  } catch { return [] }
}

async function isWritable(dir) {
  try { await access(dir, 2); return true } catch { return false }
}

export async function performUpdate() {
  if (task.state === 'downloading' || task.state === 'installing' || task.state === 'restarting') {
    return { error: '已有更新任务在进行中' };
  }
  const check = lastCheck && lastCheck.hasUpdate ? lastCheck : await checkUpdate({ force: true });
  if (!check?.hasUpdate) return { error: '当前已是最新版本' };

  const current = await getCurrentVersion();
  task = { state: 'downloading', progress: 0, message: '正在下载更新包…', latest: check.latest, error: '', finishedAt: 0 };

  runUpdate(check, current).catch(err => {
    task = { ...task, state: 'error', error: scrub(err.message), message: '更新失败', finishedAt: Date.now() };
  });
  return { started: true, version: check.latest };
}

async function downloadFromSource(src) {
  const man = await fetchManifest(src.url, src.headers, src.timeout);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000);
  let resp;
  try {
    resp = await fetch(man.url, { headers: src.headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`下载更新包 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('下载到的更新包为空');
  if (!looksLikeGzip(buf)) throw new Error('返回的不是更新包（鉴权失败或地址错误）');
  return { buf, man };
}

/**
 * fpk 是「安装外壳」：本身是 tar.gz，内部才装着热更新要用的 app.tgz。
 * 若 Release 里上传的是 .fpk，这里自动拆出里面的 app.tgz 再安装。
 */
async function unwrapIfFpk(buf, assetName) {
  if (!/\.fpk$/i.test(assetName || '')) return buf;
  const tmp = path.join(await updatesDir(), `fpk-${Date.now()}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    extractTgz(buf, tmp);
    const inner = path.join(tmp, 'app.tgz');
    if (!existsSync(inner)) throw new Error('fpk 里没有找到 app.tgz');
    return await readFile(inner);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function runUpdate(check, current) {
  const tmpDir = await updatesDir();

  const sources = resolveSources();
  const ordered = lastGoodSource
    ? [lastGoodSource, ...sources.filter(s => s.url !== lastGoodSource.url)]
    : sources;

  let pkg = null;
  let latest = null;
  const errors = [];
  for (const src of ordered) {
    try {
      task = { ...task, message: `正在下载更新包…（${src.label}）` };
      const r = await downloadFromSource(src);
      pkg = r.buf;
      latest = r.man;
      break;
    } catch (err) {
      errors.push(`${src.label}：${scrub(err.message)}`);
      if (ordered.length > 1) task = { ...task, message: `${src.label}失败，正在换源重试…` };
    }
  }
  if (!pkg) {
    throw new Error('所有更新源都下载失败 — ' + errors.join('；'));
  }

  // Release 里传的是 .fpk 的话，先拆出里面的 app.tgz 再安装
  if (/\.fpk$/i.test(latest.assetName || '')) {
    task = { ...task, message: '正在解包 fpk…' };
    pkg = await unwrapIfFpk(pkg, latest.assetName);
  }

  const file = path.join(tmpDir, `update-${latest.version}.tgz`);
  const buf = pkg;
  await writeFile(file, buf);
  task = { ...task, state: 'verifying', progress: 45, latest: latest.version, message: '校验更新包…' };

  if (latest.sha256) {
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha.toLowerCase() !== latest.sha256.toLowerCase()) {
      await rm(file, { force: true });
      throw new Error('校验失败：文件 SHA256 与更新清单不一致，已中止');
    }
  }

  if (!(await isWritable(APP_ROOT))) {
    throw new Error(`应用目录不可写：${APP_ROOT}（请检查应用权限，或改用应用中心手动安装）`);
  }

  // 备份（mv 是原子操作，不额外占空间）；先把工作目录切出去，避免进程占用目录导致 rename 失败
  try { process.chdir(path.dirname(APP_ROOT)) } catch {}
  task = { ...task, state: 'installing', progress: 60, message: '备份当前版本…' };
  const bDir = path.join(await backupsDir(), current);
  await rm(bDir, { recursive: true, force: true });
  await mkdir(bDir, { recursive: true });

  const moved = [];
  let backupError = '';
  for (const d of ['server', 'web', 'ui', 'manifest']) {
    const from = path.join(APP_ROOT, d);
    if (!existsSync(from)) continue;
    try {
      await rename(from, path.join(bDir, d));
      moved.push(d);
    } catch (err) {
      backupError = err.message;
      break;
    }
  }
  if (moved.length) {
    try { await writeFile(path.join(bDir, '.backup.json'), JSON.stringify({ version: current, at: Date.now(), parts: moved })) } catch {}
  }
  const rollbackAvailable = moved.length >= 3;
  if (!rollbackAvailable) {
    await rm(bDir, { recursive: true, force: true }).catch(() => {});
  }

  task = { ...task, progress: 75, message: '安装新版本…' };
  try {
    extractTgz(buf, APP_ROOT);
  } catch (err) {
    for (const d of moved) {
      try { await rename(path.join(bDir, d), path.join(APP_ROOT, d)) } catch {}
    }
    throw new Error('解包失败，已自动回滚：' + err.message);
  }

  if (!rollbackAvailable) {
    task = { ...task, message: '安装中（未能创建可回滚备份：' + (backupError || '目录被占用') + '）' };
  }

  await rm(file, { force: true }).catch(() => {});

  task = { ...task, state: 'restarting', progress: 92, message: '正在重启应用…' };
  let restarted = false;
  let restartError = '';
  try {
    await restart();
    restarted = true;
  } catch (err) {
    restartError = err.message;
  }

  if (restarted) {
    task = { ...task, state: 'done', progress: 100, message: '更新完成，正在重启…', finishedAt: Date.now() };
    setTimeout(() => process.exit(0), 1500);
  } else {
    task = {
      ...task, state: 'done', progress: 100,
      message: '新版本已安装，请手动重启应用',
      error: restartError,
      finishedAt: Date.now(),
    };
  }
}

/** 回滚到指定版本（默认最新备份） */
export async function rollback(version) {
  const list = await listBackups();
  const target = version && list.includes(version) ? version : list[0];
  if (!target) return { error: '没有可回滚的备份' };

  const bDir = path.join(await backupsDir(), target);
  for (const d of ['server', 'web', 'ui']) {
    const from = path.join(bDir, d);
    if (!existsSync(from)) continue;
    await rm(path.join(APP_ROOT, d), { recursive: true, force: true });
    await rename(from, path.join(APP_ROOT, d));
  }
  const man = path.join(bDir, 'manifest');
  if (existsSync(man)) {
    await rm(path.join(APP_ROOT, 'manifest'), { force: true });
    await rename(man, path.join(APP_ROOT, 'manifest'));
  }
  await rm(bDir, { recursive: true, force: true }).catch(() => {});
  let restarted = false;
  try { await restart(); restarted = true } catch {}
  if (restarted) setTimeout(() => process.exit(0), 1500);
  return { rolledBack: true, version: target, needManualRestart: !restarted };
}

/** 自重启：spawn 一个脱离父进程的脚本，等本进程退出后重新拉起 node */
function restart() {
  return new Promise((resolve, reject) => {
    if (WIN) return reject(new Error('Windows 环境不支持自重启，请手动重启应用'));

    const serverDir = path.join(APP_ROOT, 'server');
    const node = process.execPath;
    const port = process.env.PORT || '8630';
    const configDir = process.env.CONFIG_DIR || '';
    const log = '/tmp/ai-checkin.log';
    const pidFile = '/tmp/ai-checkin.pid';
    const myPid = process.pid;

    const script = `
sleep 2
kill -9 ${myPid} 2>/dev/null
sleep 1
cd "${serverDir}"
export NODE_ENV=production
export PORT=${port}
export CONFIG_DIR="${configDir}"
nohup "${node}" src/index.js >> ${log} 2>&1 &
echo $! > ${pidFile}
`.trim();

    const child = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      cwd: serverDir,
      env: { ...process.env },
    });
    child.on('error', reject);
    child.unref();
    resolve(true);
  });
}

/** 启动时自动检查（每 6 小时一次） */
export function startAutoUpdateCheck() {
  const tick = async () => {
    const s = getSettings();
    if (s.autoCheck === false) return;
    try { await checkUpdate({ force: true }) } catch {}
  };
  setTimeout(tick, 15000);
  setInterval(tick, 6 * 60 * 60 * 1000);
}

// ===== 配置读写（存到 store.js 的 settings.update） =====

function getSettings() {
  return { ...DEFAULT_UPDATE, ...(get().update || {}) };
}

async function updateSettings(patch) {
  const s = get();
  s.update = { ...(s.update || {}), ...patch };
  save();
  return getSettings();
}

export async function saveUpdateConfig(patch) {
  const allowed = {};
  if (typeof patch.url === 'string') allowed.url = patch.url.trim();
  if (typeof patch.altUrl === 'string') allowed.altUrl = patch.altUrl.trim();
  if (typeof patch.autoCheck === 'boolean') allowed.autoCheck = patch.autoCheck;
  if (typeof patch.token === 'string') allowed.token = patch.token.trim();
  if (typeof patch.user === 'string') allowed.user = patch.user.trim();
  if (typeof patch.password === 'string') allowed.password = patch.password;
  const s = await updateSettings(allowed);
  lastCheck = null;
  lastGoodSource = null;
  return {
    url: s.url,
    altUrl: s.altUrl,
    autoCheck: s.autoCheck,
    hasToken: !!s.token,
    hasBasic: !!(s.user || s.password),
    usingBuiltin: getUpdateSources().usingBuiltinAuth,
    sources: getUpdateSources().sources,
  };
}
