// AI签到管家 — 零依赖 Node 后端（node:http + 内置 fetch，需 Node 18+）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION, load, get, save, saveNow, addLog, getLogs, clearLogs, configDir, isAgreementAccepted, getAgreementState, acceptAgreement, revokeAgreement } from './lib/store.js';
import { agreementPayload, AGREEMENT_REVISION } from './lib/agreement.js';
import { runProvider, liveSnapshot, readLive, slimLive } from './lib/providers.js';
import { startScheduler } from './lib/scheduler.js';
import { sendNotify } from './lib/notify.js';
import { maskToken, uid, tryJson, parseCurl, nowText } from './lib/util.js';
import { fetchStatus, fetchGrowth, fetchTravel, TRAVEL_DOMAIN } from './lib/wb.js';
import {
  APP_ROOT, getCurrentVersion, checkUpdate, performUpdate, getUpdateStatus,
  getLastCheck, listBackups, rollback, saveUpdateConfig, getUpdateSources, startAutoUpdateCheck,
} from './lib/updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dirname, '..', '..', 'web', 'dist');
const PORT = Number(process.env.PORT || 8630);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** 以附件形式下发 JSON（用于导出备份） */
function jsonDownload(res, filename, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const j = tryJson(raw);
  return j || {};
}

function maskProvider(p) {
  const out = { ...p };
  if (p.type === 'workbuddy') {
    out.tokenMasked = maskToken(p.token);
    out.tokenPresent = !!p.token;
    delete out.token;
  }
  // 带上「上次已知的实时快照」：签到中心首屏即可渲染状态，不必先等远端
  // 内存缓存优先（最新），其次用上次持久化的精简值（重启后依然秒开）
  const live = readLive(p.id);
  if (live) out.lastLive = { ...slimLive(live, live.at), age: live.age, fresh: live.fresh };
  return out;
}

// ---------- 配置备份与恢复 ----------

const BACKUP_KIND = 'ai-checkin-backup';
const NOTIFY_FORMATS = ['generic', 'dingtalk', 'feishu', 'wecom', 'bark', 'pushplus'];
const MAX_BACKUP_PROVIDERS = 50;

/** 生成备份对象。secrets=false 时不导出凭据，便于把配置发给别人排查 */
function buildBackup(secrets) {
  const s = get();
  const providers = s.providers.map((p) => {
    const c = { ...p };
    delete c.lastRun;   // 运行期状态不进备份
    delete c.lastLive;
    if (!secrets && c.token) c.token = '';
    return c;
  });
  return {
    kind: BACKUP_KIND,
    app: 'ai-checkin',
    version: VERSION,
    exportedAt: nowText(),
    includesSecrets: !!secrets,
    settings: {
      providers,
      notify: secrets ? { ...s.notify } : { ...s.notify, url: '' },
      scheduler: { ...s.scheduler },
      update: { autoCheck: s.update?.autoCheck !== false },
    },
    // 明确写出「恢复时不会覆盖什么」，避免用户以为换机后连同意状态也一起带过去
    restoreScope: '恢复时会应用：任务（含登录态）、通知配置、定时策略、自动检查更新开关；'
      + '协议同意状态与版本更新源保持本机设置不变。',
  };
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const bool = (v, dflt = true) => (typeof v === 'boolean' ? v : dflt);

/** 校验并净化备份里的任务列表；token 为空表示「保留本机现有登录态」 */
function sanitizeProviders(list, existing) {
  const out = [];
  const usedIds = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const type = raw.type === 'workbuddy' ? 'workbuddy' : 'http';
    let id = str(raw.id, 40);
    if (!id || usedIds.has(id)) id = uid();
    usedIds.add(id);

    const prev = existing.find((x) => x.id === id)
      || (type === 'workbuddy' ? existing.find((x) => x.type === 'workbuddy') : null);

    const base = {
      id,
      type,
      name: str(raw.name, 60) || (type === 'workbuddy' ? 'WorkBuddy 加油站' : '未命名任务'),
      enabled: bool(raw.enabled, true),
      schedule: {
        times: Array.isArray(raw.schedule?.times)
          ? raw.schedule.times.filter((t) => /^\d{1,2}:\d{2}$/.test(String(t))).slice(0, 12)
          : ['09:00'],
      },
      lastRun: prev?.lastRun || null,
      lastLive: prev?.lastLive || null,
    };
    if (!base.schedule.times.length) base.schedule.times = ['09:00'];

    if (type === 'workbuddy') {
      const token = str(raw.token, 8192);
      out.push({
        ...base,
        // 空 token → 保留本机现有登录态（导入「不含凭据」的备份时不会把凭据清掉）
        token: token || prev?.token || '',
        domain: str(raw.domain, 120) || prev?.domain || 'www.codebuddy.cn',
        autoCheckin: bool(raw.autoCheckin, true),
        travelAuto: bool(raw.travelAuto, true),
        locationId: Number.isFinite(Number(raw.locationId)) ? Number(raw.locationId) : 0,
      });
    } else {
      const h = raw.http || {};
      out.push({
        ...base,
        http: {
          url: str(h.url, 2000),
          method: str(h.method, 10).toUpperCase() || 'GET',
          headers: (h.headers && typeof h.headers === 'object' && !Array.isArray(h.headers))
            ? Object.fromEntries(Object.entries(h.headers).slice(0, 30).map(([k, v]) => [str(k, 200), str(v, 2000)]))
            : {},
          body: str(h.body, 20000),
          successRule: {
            kind: ['status', 'contains', 'json', 'always'].includes(h.successRule?.kind) ? h.successRule.kind : 'status',
            expr: str(h.successRule?.expr, 200) || '200',
            value: str(h.successRule?.value, 200),
          },
        },
      });
    }
    if (out.length >= MAX_BACKUP_PROVIDERS) break;
  }
  return out;
}

/** 解析备份文件 → { ok, error?, settings?, summary? } */
function parseBackup(input) {
  const data = input && typeof input === 'object' ? input : null;
  if (!data) return { ok: false, error: '备份内容不是有效的 JSON 对象' };
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : null;
  if (!settings) return { ok: false, error: '备份文件缺少 settings 字段，可能不是本应用导出的备份' };
  if (data.app && data.app !== 'ai-checkin') return { ok: false, error: `备份来自其它应用（${data.app}），已拒绝导入` };
  if (!Array.isArray(settings.providers)) return { ok: false, error: '备份里的 providers 不是数组，文件可能已损坏' };

  const s = get();
  const providers = sanitizeProviders(settings.providers, s.providers);
  if (!providers.some((p) => p.type === 'workbuddy')) {
    return { ok: false, error: '备份里没有 WorkBuddy 任务，已拒绝导入（避免清空内置任务）' };
  }

  const rawNotify = settings.notify && typeof settings.notify === 'object' ? settings.notify : null;
  const notify = rawNotify
    ? {
        enabled: bool(rawNotify.enabled, false),
        format: NOTIFY_FORMATS.includes(rawNotify.format) ? rawNotify.format : 'generic',
        // 空值 → 保留本机现有推送地址
        url: str(rawNotify.url, 2000) || s.notify?.url || '',
      }
    : null;

  return {
    ok: true,
    providers,
    notify,
    scheduler: settings.scheduler && typeof settings.scheduler === 'object'
      ? { runOnStart: bool(settings.scheduler.runOnStart, true) }
      : null,
    updateAutoCheck: typeof settings.update?.autoCheck === 'boolean' ? settings.update.autoCheck : null,
    meta: {
      app: data.app || '',
      version: str(data.version, 30),
      exportedAt: str(data.exportedAt, 40),
      includesSecrets: !!data.includesSecrets,
    },
  };
}

// ---------- API 路由 ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const s = get();

  if (req.method === 'GET' && p === '/api/health') {
    return json(res, 200, { ok: true, version: VERSION, time: nowText() });
  }

  // 「同意才能使用」：未同意用户协议前，后端拒绝一切实际执行动作（不只是前端遮挡）
  const AGREEMENT_GUARDED = ['/api/providers/run', '/api/run-all', '/api/notify/test', '/api/backup/restore'];
  if (req.method === 'POST' && AGREEMENT_GUARDED.includes(p) && !isAgreementAccepted()) {
    return json(res, 403, {
      ok: false,
      needAgreement: true,
      message: '请先阅读并同意《用户协议与免责声明》后再使用',
    });
  }

  if (req.method === 'GET' && p === '/api/state') {
    return json(res, 200, {
      version: VERSION,
      time: nowText(),
      configDir: configDir(),
      providers: s.providers.map(maskProvider),
      notify: s.notify,
      scheduler: s.scheduler,
      agreementAccepted: isAgreementAccepted(),
      agreement: getAgreementState(),
      logs: getLogs(300),
    });
  }

  // 用户协议与免责声明：内容由后端下发，前端渲染；同意状态落盘到本机配置
  if (req.method === 'GET' && p === '/api/agreement') {
    return json(res, 200, { ok: true, ...getAgreementState(), ...agreementPayload() });
  }
  if (req.method === 'POST' && p === '/api/agreement/accept') {
    const st = acceptAgreement();
    addLog({ providerName: '系统', trigger: 'manual', ok: true, message: `已同意《${agreementPayload().title}》（条款版本 ${AGREEMENT_REVISION}）`, durationMs: 0 });
    return json(res, 200, { ok: true, ...st, revision: AGREEMENT_REVISION });
  }
  if (req.method === 'POST' && p === '/api/agreement/revoke') {
    return json(res, 200, { ok: true, ...revokeAgreement() });
  }

  if (req.method === 'POST' && p === '/api/settings') {
    const body = await readJson(req);
    if (body.notify) s.notify = { ...s.notify, ...body.notify };
    if (body.scheduler) s.scheduler = { ...s.scheduler, ...body.scheduler };
    save();
    return json(res, 200, { ok: true, notify: s.notify, scheduler: s.scheduler });
  }

  // 导入 WorkBuddy 登录态：支持整个 .info JSON、{"auth":{...}}、裸 JWT
  if (req.method === 'POST' && p === '/api/wb/import') {
    const body = await readJson(req);
    const raw = String(body.raw || '').trim();
    if (!raw) return json(res, 400, { ok: false, message: '内容为空' });
    let token = '';
    let domain = '';
    const j = tryJson(raw);
    if (j) {
      const auth = j.auth || j.data?.auth || j;
      token = auth.accessToken || auth.access_token || '';
      domain = auth.domain || '';
      if (!token) token = j.accessToken || '';
    }
    if (!token && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(raw)) token = raw;
    if (!token) {
      const m = raw.match(/"accessToken"\s*:\s*"([^"]+)"/);
      if (m) token = m[1];
    }
    if (!token) return json(res, 400, { ok: false, message: '未找到 accessToken，请确认粘贴的是完整登录态 JSON 或 token 本体' });
    if (!domain) domain = 'www.codebuddy.cn';
    return json(res, 200, { ok: true, token, domain, masked: maskToken(token) });
  }

  // 新增 / 更新任务
  if (req.method === 'POST' && p === '/api/providers') {
    const body = await readJson(req);
    const idx = body.id ? s.providers.findIndex((x) => x.id === body.id) : -1;
    if (idx >= 0) {
      const old = s.providers[idx];
      const next = { ...old, ...body, id: old.id };
      // token 语义：'__CLEAR__' 显式清除；空值/'__KEEP__' 保留旧值（前端不回传明文）
      if (old.type === 'workbuddy') {
        if (next.token === '__CLEAR__') next.token = '';
        else if (!next.token || next.token === '__KEEP__') next.token = old.token;
      }
      s.providers[idx] = next;
    } else {
      const np = {
        id: uid(),
        type: body.type || 'http',
        name: body.name || '未命名任务',
        enabled: body.enabled !== false,
        schedule: body.schedule || { times: ['09:00'] },
        ...(body.type === 'workbuddy'
          ? {
              token: body.token || '',
              domain: body.domain || 'www.codebuddy.cn',
              autoCheckin: body.autoCheckin !== false,
              travelAuto: body.travelAuto !== false,
              locationId: Number(body.locationId) || 0,
            }
          : {
              http: body.http || { url: '', method: 'GET', headers: {}, body: '', successRule: { kind: 'status', expr: '200' } },
            }),
        lastRun: null,
      };
      s.providers.push(np);
    }
    save();
    return json(res, 200, { ok: true, providers: s.providers.map(maskProvider) });
  }

  if (req.method === 'POST' && p === '/api/providers/delete') {
    const body = await readJson(req);
    const idx = s.providers.findIndex((x) => x.id === body.id);
    if (idx < 0) return json(res, 404, { ok: false, message: '任务不存在' });
    if (s.providers[idx].type === 'workbuddy') return json(res, 400, { ok: false, message: '内置 WorkBuddy 任务不可删除（可停用）' });
    s.providers.splice(idx, 1);
    save();
    return json(res, 200, { ok: true, providers: s.providers.map(maskProvider) });
  }

  if (req.method === 'POST' && p === '/api/providers/toggle') {
    const body = await readJson(req);
    const prov = s.providers.find((x) => x.id === body.id);
    if (!prov) return json(res, 404, { ok: false, message: '任务不存在' });
    prov.enabled = !prov.enabled;
    save();
    return json(res, 200, { ok: true, enabled: prov.enabled });
  }

  if (req.method === 'POST' && (p === '/api/providers/run' || p === '/api/run-all')) {
    const body = p === '/api/run-all' ? {} : await readJson(req);
    const targets = p === '/api/run-all'
      ? s.providers.filter((x) => x.enabled)
      : s.providers.filter((x) => x.id === body.id);
    if (!targets.length) return json(res, 404, { ok: false, message: '没有可执行的任务' });
    const results = [];
    for (const prov of targets) {
      const r = await runProvider(prov, s, 'manual');
      results.push({ id: prov.id, name: prov.name, ...r });
    }
    save();
    const allOk = results.every((r) => r.ok);
    return json(res, 200, { ok: allOk, results });
  }

  // 总览实时数据（只读）
  if (req.method === 'GET' && p === '/api/wb/live') {
    const prov = s.providers.find((x) => x.type === 'workbuddy');
    if (!prov?.token) return json(res, 200, { ok: false, message: '未配置 token' });
    try {
      const status = await fetchStatus(prov.domain || 'www.codebuddy.cn', prov.token);
      const growth = await fetchGrowth(prov.domain || 'www.codebuddy.cn', prov.token);
      const travel = await fetchTravel(prov.token);
      return json(res, 200, { ok: true, status, growth, travel });
    } catch (e) {
      return json(res, 200, { ok: false, message: e.message });
    }
  }

  // 按任务 ID 取实时快照（只读）
  // - 默认：有缓存立刻返回（过期则顺手后台刷新），页面无需等待
  // - body.force=true：强制拉一次最新并等待（用户主动点「刷新」）
  if (req.method === 'POST' && p === '/api/providers/live') {
    const body = await readJson(req);
    const prov = s.providers.find((x) => x.id === body.id);
    if (!prov) return json(res, 404, { ok: false, message: '任务不存在' });
    return json(res, 200, await liveSnapshot(prov, { force: !!body.force }));
  }

  if (req.method === 'POST' && p === '/api/curl-parse') {
    const body = await readJson(req);
    const parsed = parseCurl(String(body.curl || ''));
    if (!parsed.url) return json(res, 400, { ok: false, message: '未能从 cURL 中解析出 URL' });
    return json(res, 200, { ok: true, ...parsed });
  }

  if (req.method === 'POST' && p === '/api/notify/test') {
    const body = await readJson(req);
    const r = await sendNotify(s, 'AI签到管家测试推送', String(body.content || '如果你看到这条消息，说明推送配置成功 ✅'));
    return json(res, 200, r);
  }

  if (req.method === 'POST' && p === '/api/logs/clear') {
    clearLogs();
    return json(res, 200, { ok: true });
  }

  // ===== 配置备份与恢复 =====
  // 导出：GET /api/backup/export?secrets=0|1
  if (req.method === 'GET' && p === '/api/backup/export') {
    const secrets = url.searchParams.get('secrets') !== '0';
    const stamp = nowText().replace(/[^0-9]/g, '').slice(0, 12);
    return jsonDownload(res, `ai-checkin-backup-${stamp}.json`, buildBackup(secrets));
  }

  // 恢复：POST /api/backup/restore  { backup, confirm }
  // confirm !== true 时只做校验与预览，不落盘（前端弹窗二次确认后再真正应用）
  if (req.method === 'POST' && p === '/api/backup/restore') {
    const body = await readJson(req);
    const parsed = parseBackup(body.backup ?? body.data ?? body);
    if (!parsed.ok) return json(res, 400, { ok: false, message: parsed.error });

    const summary = {
      providers: parsed.providers.length,
      workbuddy: parsed.providers.filter((x) => x.type === 'workbuddy').length,
      http: parsed.providers.filter((x) => x.type === 'http').length,
      enabled: parsed.providers.filter((x) => x.enabled).length,
      withToken: parsed.providers.filter((x) => x.type === 'workbuddy' && x.token).length,
      notify: parsed.notify ? parsed.notify.format : null,
      scheduler: parsed.scheduler,
      updateAutoCheck: parsed.updateAutoCheck,
      meta: parsed.meta,
    };

    if (body.confirm !== true) {
      return json(res, 200, { ok: true, preview: true, summary, scope: buildBackup(false).restoreScope });
    }

    s.providers = parsed.providers;
    if (parsed.notify) s.notify = parsed.notify;
    if (parsed.scheduler) s.scheduler = { ...s.scheduler, ...parsed.scheduler };
    if (parsed.updateAutoCheck !== null) s.update = { ...s.update, autoCheck: parsed.updateAutoCheck };
    saveNow(); // 立即落盘：避免重启后配置回退
    addLog({
      providerName: '系统',
      trigger: 'manual',
      ok: true,
      message: `已恢复配置备份（任务 ${summary.providers} 个，含登录态 ${summary.withToken} 个）`,
      durationMs: 0,
    });
    return json(res, 200, { ok: true, applied: summary, providers: s.providers.map(maskProvider) });
  }

  // ===== 系统 / 自动更新 =====
  if (req.method === 'GET' && p === '/api/system/info') {
    const s = get();
    const src = getUpdateSources();
    return json(res, 200, {
      version: await getCurrentVersion(),
      appRoot: APP_ROOT,
      platform: process.platform,
      node: process.version,
      updateUrl: s.update?.url || '',
      updateAltUrl: s.update?.altUrl || '',
      autoCheckUpdate: s.update?.autoCheck !== false,
      hasUpdateToken: !!s.update?.token,
      hasBasicAuth: !!((s.update?.user || '') && (s.update?.password || '')),
      usingBuiltinSource: src.usingBuiltinAuth,
      updateSources: src.sources,
    });
  }

  if (req.method === 'GET' && p === '/api/system/update') {
    return json(res, 200, getLastCheck() || { hasUpdate: false });
  }

  if (req.method === 'POST' && p === '/api/system/update/check') {
    try { return json(res, 200, await checkUpdate({ force: true })); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === 'GET' && p === '/api/system/update/status') {
    return json(res, 200, getUpdateStatus());
  }

  if (req.method === 'GET' && p === '/api/system/update/backups') {
    try { return json(res, 200, await listBackups()); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/system/update/apply') {
    try {
      const r = await performUpdate();
      if (r.error) return json(res, 409, r);
      return json(res, 200, r);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/system/update/rollback') {
    try {
      const body = await readJson(req);
      const r = await rollback(body.version);
      if (r.error) return json(res, 400, r);
      return json(res, 200, r);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === 'PUT' && p === '/api/system/update/config') {
    try { return json(res, 200, await saveUpdateConfig(await readJson(req))); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  return json(res, 404, { ok: false, message: 'not found' });
}

// ---------- 静态资源 ----------
function serveStatic(req, res, url) {
  let fp = decodeURIComponent(url.pathname);
  if (fp === '/' || fp === '') fp = '/index.html';
  const abs = path.join(WEB_DIST, fp);
  if (!abs.startsWith(WEB_DIST)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(abs, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(WEB_DIST, 'index.html'), (e2, index) => {
        if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('未找到页面（请先构建前端：npm run build）'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(index);
      });
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const immutable = fp.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  });
}

// ---------- 启动 ----------
load();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error('[api]', e);
      try { json(res, 500, { ok: false, message: e.message }); } catch { /* ignore */ }
    });
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ai-checkin] v${VERSION} listening on http://0.0.0.0:${PORT}`);
  console.log(`[ai-checkin] config dir: ${configDir()}`);
  startScheduler();
  startAutoUpdateCheck();
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
