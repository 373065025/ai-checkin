// AI签到管家 — 零依赖 Node 后端（node:http + 内置 fetch，需 Node 18+）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION, load, get, save, saveNow, addLog, getLogs, clearLogs, configDir, isAgreementAccepted, getAgreementState, acceptAgreement, revokeAgreement } from './lib/store.js';
import { agreementPayload, AGREEMENT_REVISION } from './lib/agreement.js';
import { runProvider, liveSnapshot, readLive, slimLive, dropLive } from './lib/providers.js';
import { startScheduler } from './lib/scheduler.js';
import { sendNotify } from './lib/notify.js';
import { authState, login, logout, setPassword, isAuthorized, isEnabled as adminEnabled, clientIp } from './lib/auth.js';
import { maskToken, accountOfToken, maskPhone, uid, tryJson, parseCurl, nowText, mapLimit } from './lib/util.js';
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
    // 账号标识（昵称 + 打码手机号）用于多账号区分；查询类接口不返回账号信息，
    // 所以只在导入/保存时从 JWT 解析一次并落盘，界面只读展示
    out.account = p.account
      ? { uid: p.account.uid || '', nickname: p.account.nickname || '', phoneMasked: p.account.phoneMasked || '' }
      : (p.token ? accountOfToken(p.token) || null : null);
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
    delete c.lastTrigger;
    if (!secrets) {
      // 不带凭据的备份常常被拿去发给别人排查 → 连账号昵称/手机号也一并去掉
      if (c.token) c.token = '';
      delete c.account;
    }
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
      + '协议同意状态、管理员密码与版本更新源保持本机设置不变。',
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
    let id = str(raw.id, 40);
    if (!id || usedIds.has(id)) id = uid();
    usedIds.add(id);

    const rawType = raw.type === 'workbuddy' ? 'workbuddy' : 'http';
    const rawAccount = rawType === 'workbuddy' && raw.account && typeof raw.account === 'object' ? raw.account : null;
    const rawAccountUid = str(rawAccount?.uid, 64);
    // 多账号时的匹配次序：任务 id → 账号 uid（同一账号换个任务 id 也能续上登录态）→ 无
    const prev = existing.find((x) => x.id === id)
      || (rawAccountUid ? existing.find((x) => x.type === 'workbuddy' && x.account?.uid === rawAccountUid) : null);

    const base = {
      id,
      type: rawType,
      name: str(raw.name, 60) || (rawType === 'workbuddy' ? 'WorkBuddy 加油站' : '未命名任务'),
      enabled: bool(raw.enabled, true),
      schedule: {
        times: Array.isArray(raw.schedule?.times)
          ? raw.schedule.times.filter((t) => /^\d{1,2}:\d{2}$/.test(String(t))).slice(0, 12)
          : ['09:00'],
      },
      lastRun: prev?.lastRun || null,
      lastLive: prev?.lastLive || null,
      // 「今天这个时间点已经跑过了」的标记不进备份文件，但恢复时从本机同 id 任务继承，
      // 否则恢复到同一台机器会让当天的时间点再触发一次
      lastTrigger: prev?.lastTrigger || null,
    };
    if (!base.schedule.times.length) base.schedule.times = ['09:00'];

    if (rawType === 'workbuddy') {
      const token = str(raw.token, 8192);
      const account = token
        ? accountOfToken(token)
        : (prev?.account ? { ...prev.account } : (rawAccountUid ? { uid: rawAccountUid, nickname: str(rawAccount?.nickname, 60), phoneMasked: str(rawAccount?.phoneMasked, 30) } : null));
      out.push({
        ...base,
        // 空 token → 保留本机现有登录态（导入「不含凭据」的备份时不会把凭据清掉）
        token: token || prev?.token || '',
        account: (token || prev?.token) ? account : null,
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

  // ===== 管理员密码（可选，默认关闭） =====
  // 没设密码 → 行为与旧版一致，全部放行；设了密码 → 除登录相关接口外都要有效 session。
  // 定时调度与自动更新是进程内部调用，不走 HTTP，不受密码影响。
  const PUBLIC_API = ['/api/health', '/api/auth/status', '/api/auth/login'];
  if (!PUBLIC_API.includes(p) && !isAuthorized(req)) {
    return json(res, 401, { ok: false, needAuth: true, message: '请先登录管理员密码' });
  }

  if (req.method === 'GET' && p === '/api/auth/status') {
    return json(res, 200, authState(req));
  }

  if (req.method === 'POST' && p === '/api/auth/login') {
    const body = await readJson(req);
    const r = login(req, String(body.password || ''));
    if (!r.ok) {
      if (r.locked) {
        addLog({
          providerName: '系统', trigger: 'manual', ok: false, durationMs: 0,
          message: `管理员密码连续错误已达上限，来源 ${clientIp(req)} 已锁定 1 小时`,
        });
      }
      return json(res, r.locked ? 429 : 401, {
        ok: false,
        needAuth: true,
        locked: !!r.locked,
        lockSeconds: r.lockSeconds || 0,
        remaining: r.remaining || 0,
        message: r.locked
          ? `错误次数过多，已锁定 ${Math.ceil((r.lockSeconds || 0) / 60)} 分钟`
          : `密码错误，还可尝试 ${r.remaining} 次`,
      });
    }
    addLog({ providerName: '系统', trigger: 'manual', ok: true, durationMs: 0, message: `管理员登录成功（来源 ${clientIp(req)}）` });
    return json(res, 200, r);
  }

  if (req.method === 'POST' && p === '/api/auth/logout') {
    return json(res, 200, logout(req));
  }

  // 设置 / 修改 / 关闭密码：newPassword 为空 = 关闭（需验证旧密码）
  if (req.method === 'POST' && p === '/api/auth/password') {
    const body = await readJson(req);
    const np = String(body.newPassword || '');
    const r = setPassword(String(body.oldPassword || ''), np);
    if (!r.ok) return json(res, 400, r);
    addLog({ providerName: '系统', trigger: 'manual', ok: true, durationMs: 0, message: r.message });
    // 刚设完密码就给自己发一个 session，免得保存后立刻被踢出去重新登录
    const l = np ? login(req, np) : { token: '' };
    return json(res, 200, { ...r, token: l.token || '' });
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
      adminEnabled: adminEnabled(),
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
    const selfId = str(body.id, 40);
    if (!raw) return json(res, 400, { ok: false, message: '内容为空' });
    let token = '';
    let domain = '';
    let fileAccounts = [];
    const j = tryJson(raw);
    if (j) {
      const auth = j.auth || j.data?.auth || j;
      const rawToken = auth.accessToken ?? auth.access_token ?? j.accessToken ?? '';
      // 新版桌面端（实测）把 accessToken 加密成了 { $wbEncrypted, envelope } 对象，
      // 本地拿不到明文 JWT —— 必须明确报错，否则会被当作导入成功但实际存了空登录态
      if (rawToken && typeof rawToken === 'object') {
        return json(res, 422, {
          ok: false,
          encryptedToken: true,
          message: '检测到新版 WorkBuddy 桌面端的加密登录态（accessToken 已加密存储），无法直接导入。'
            + '请粘贴从网络请求里复制的 accessToken 明文（以 eyJ 开头的三段式 JWT），或使用仍以明文保存登录态的桌面端版本导出。',
        });
      }
      token = typeof rawToken === 'string' ? rawToken : '';
      domain = auth.domain || '';
      if (!token) token = j.accessToken || '';
      // 桌面端登录态文件里会列出该机器上登录过的所有账号（只有当前账号带 token），
      // 用来提示用户「还差哪几个账号要单独导出」
      const arr = j.allAccounts || j.accounts;
      if (Array.isArray(arr)) {
        fileAccounts = arr
          .map((a) => ({ nickname: str(a?.nickname, 60), phoneMasked: maskPhone(a?.phoneNumber || a?.phone || '') }))
          .filter((a) => a.nickname || a.phoneMasked);
      }
    }
    if (!token && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(raw)) token = raw;
    if (!token) {
      const m = raw.match(/"accessToken"\s*:\s*"([^"]+)"/);
      if (m) token = m[1];
    }
    if (!token) return json(res, 400, { ok: false, message: '未找到 accessToken，请确认粘贴的是完整登录态 JSON 或 token 本体' });
    if (!domain) domain = 'www.codebuddy.cn';

    const account = accountOfToken(token);
    // 同一个账号被重复添加是常见误操作 → 提前告诉用户它已经存在
    const dup = account?.uid
      ? s.providers.find((x) => x.type === 'workbuddy' && x.id !== selfId && x.account?.uid === account.uid)
      : null;
    // 文件里有、但当前登录态没带 token 的其它账号（需要用户切换账号后再各导出一次）
    const selfLabel = account?.phoneMasked || '';
    const otherAccounts = fileAccounts.filter((a) => !selfLabel || a.phoneMasked !== selfLabel);

    return json(res, 200, {
      ok: true,
      token,
      domain,
      masked: maskToken(token),
      account,
      duplicateOf: dup ? { id: dup.id, name: dup.name } : null,
      otherAccounts,
    });
  }

  // 新增 / 更新任务（WorkBuddy 支持多账号：每个账号一个任务，各自独立的登录态与执行时间）
  if (req.method === 'POST' && p === '/api/providers') {
    const body = await readJson(req);
    delete body.tokenMasked;
    delete body.tokenPresent;
    const idx = body.id ? s.providers.findIndex((x) => x.id === body.id) : -1;
    if (idx >= 0) {
      const old = s.providers[idx];
      const next = { ...old, ...body, id: old.id };
      // token 语义：'__CLEAR__' 显式清除；空值/'__KEEP__' 保留旧值（前端不回传明文）
      if (old.type === 'workbuddy') {
        if (next.token === '__CLEAR__') next.token = '';
        else if (!next.token || next.token === '__KEEP__') next.token = old.token;
        // 账号标识只从「这次真正传来的明文 token」重算，避免前端把旧值写回
        if (body.token && body.token !== '__KEEP__' && body.token !== '__CLEAR__') {
          const acc = accountOfToken(body.token);
          if (acc) next.account = acc;
        }
        if (!next.token) next.account = null;
      }
      s.providers[idx] = next;
    } else {
      const isWb = body.type === 'workbuddy';
      const token = isWb ? str(body.token, 8192) : '';
      const account = isWb ? accountOfToken(token) : null;
      const np = {
        id: uid(),
        type: isWb ? 'workbuddy' : 'http',
        // 没填名字时用账号昵称兜底，多账号才不会都叫「WorkBuddy 加油站」
        name: str(body.name, 60) || account?.nickname || (isWb ? 'WorkBuddy 加油站' : '未命名任务'),
        enabled: body.enabled !== false,
        schedule: body.schedule || { times: ['09:00'] },
        ...(isWb
          ? {
              token,
              account,
              domain: str(body.domain, 120) || 'www.codebuddy.cn',
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
    // WorkBuddy 允许删除（多账号时），但必须保留至少一个内置任务
    if (s.providers[idx].type === 'workbuddy'
      && s.providers.filter((x) => x.type === 'workbuddy').length <= 1) {
      return json(res, 400, { ok: false, message: '至少要保留一个 WorkBuddy 任务（可停用）' });
    }
    s.providers.splice(idx, 1);
    dropLive(body.id); // 顺手清掉它的实时快照缓存
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
    // 多账号时串行执行要几十秒（每个任务要好几个远端请求）→ 并发跑，但限制并发数
    // 免得一次打爆上游；结果顺序仍与任务列表一致
    const results = await mapLimit(targets, 4, async (prov) => ({
      id: prov.id, name: prov.name, ...(await runProvider(prov, s, 'manual')),
    }));
    save();
    const allOk = results.every((r) => r.ok);
    return json(res, 200, { ok: allOk, results });
  }

  // 总览实时数据（只读）。多账号：用 ?id=<任务id> 指定；不传则取第一个 WorkBuddy 任务
  if (req.method === 'GET' && p === '/api/wb/live') {
    const id = url.searchParams.get('id');
    const prov = id
      ? s.providers.find((x) => x.id === id && x.type === 'workbuddy')
      : s.providers.find((x) => x.type === 'workbuddy');
    if (!prov) return json(res, 404, { ok: false, message: 'WorkBuddy 任务不存在' });
    if (!prov.token) return json(res, 200, { ok: false, message: '未配置 token' });
    const domain = prov.domain || 'www.codebuddy.cn';
    try {
      const [status, growth, travel] = await Promise.all([
        fetchStatus(domain, prov.token),
        fetchGrowth(domain, prov.token),
        fetchTravel(prov.token),
      ]);
      return json(res, 200, { ok: true, account: maskProvider(prov).account, status, growth, travel });
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
