// AI签到管家 — 零依赖 Node 后端（node:http + 内置 fetch，需 Node 18+）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION, load, get, save, addLog, getLogs, clearLogs, configDir } from './lib/store.js';
import { runProvider, liveSnapshot } from './lib/providers.js';
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
  return out;
}

// ---------- API 路由 ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const s = get();

  if (req.method === 'GET' && p === '/api/health') {
    return json(res, 200, { ok: true, version: VERSION, time: nowText() });
  }

  if (req.method === 'GET' && p === '/api/state') {
    return json(res, 200, {
      version: VERSION,
      time: nowText(),
      configDir: configDir(),
      providers: s.providers.map(maskProvider),
      notify: s.notify,
      scheduler: s.scheduler,
      logs: getLogs(300),
    });
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
      // token 为空 → 保留旧值（前端不回传明文）
      if (old.type === 'workbuddy' && (!next.token || next.token === '__KEEP__')) next.token = old.token;
      if (old.type === 'workbuddy' && !next.token) next.token = old.token;
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
  if (req.method === 'POST' && p === '/api/providers/live') {
    const body = await readJson(req);
    const prov = s.providers.find((x) => x.id === body.id);
    if (!prov) return json(res, 404, { ok: false, message: '任务不存在' });
    return json(res, 200, await liveSnapshot(prov));
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
