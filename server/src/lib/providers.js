// 任务引擎：内置 WorkBuddy + 通用 HTTP 签到
import { tryJson, pickPath, nowText } from './util.js';
import { runWorkBuddy, fetchStatus, fetchGrowth, fetchTravel } from './wb.js';
import { addLog } from './store.js';

/**
 * 执行单个 HTTP 签到任务
 * opts: { url, method, headers, body, successRule: {kind:'status'|'contains'|'json'|'always', expr, value} }
 */
export async function runHttpProvider(opts) {
  const steps = [];
  const method = (opts.method || 'GET').toUpperCase();
  if (!opts.url) return { ok: false, message: '未配置签到 URL', steps };
  const headers = {};
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (!k) continue;
    headers[k] = v;
  }
  if (opts.body && !headers['Content-Type'] && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let status = 0;
  let text = '';
  try {
    const res = await fetch(opts.url, {
      method,
      headers,
      body: method === 'GET' ? undefined : (opts.body || undefined),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    steps.push({ action: 'HTTP 请求', ok: false, message: e.message });
    return { ok: false, message: `请求失败：${e.message}`, steps };
  }
  clearTimeout(timer);

  const rule = opts.successRule || { kind: 'status', expr: '200' };
  let ok = false;
  let detail = '';
  if (rule.kind === 'status') {
    const want = String(rule.expr || '200').split(',').map((s) => s.trim());
    ok = want.includes(String(status));
    detail = `HTTP ${status}`;
  } else if (rule.kind === 'contains') {
    ok = text.includes(rule.expr || '');
    detail = `HTTP ${status}，${ok ? '包含' : '不包含'}「${rule.expr}」`;
  } else if (rule.kind === 'json') {
    const j = tryJson(text);
    const actual = j == null ? undefined : pickPath(j, rule.expr || '');
    ok = String(actual) === String(rule.value ?? '');
    detail = `HTTP ${status}，${rule.expr} = ${actual === undefined ? '(不存在)' : JSON.stringify(actual)}`;
  } else {
    ok = status >= 200 && status < 400;
    detail = `HTTP ${status}`;
  }
  steps.push({ action: 'HTTP 请求', ok, message: detail });

  let snippet = '';
  const j = tryJson(text);
  if (j) {
    const msg = pickPath(j, 'msg') ?? pickPath(j, 'message') ?? pickPath(j, 'data.msg');
    if (msg != null) snippet = String(msg);
    if (snippet.length > 80) snippet = snippet.slice(0, 80);
  }
  const message = ok ? `签到成功（${detail}${snippet ? '：' + snippet : ''}）` : `签到判定失败（${detail}${snippet ? '：' + snippet : ''}）`;
  return { ok, message, steps };
}

/**
 * 执行任务（调度器和手动运行共用入口）
 */
export async function runProvider(provider, settings, trigger = 'manual') {
  const started = Date.now();
  let result;
  if (provider.type === 'workbuddy') {
    if (!provider.token) {
      result = { ok: false, message: '尚未配置 WorkBuddy accessToken，请在「设置」中导入', steps: [] };
    } else {
      try {
        result = await runWorkBuddy(provider);
      } catch (e) {
        result = { ok: false, message: `执行异常：${e.message}`, steps: [] };
      }
    }
  } else {
    try {
      result = await runHttpProvider(provider.http || {});
    } catch (e) {
      result = { ok: false, message: `执行异常：${e.message}`, steps: [] };
    }
  }

  const durationMs = Date.now() - started;
  provider.lastRun = {
    ts: new Date().toISOString(),
    day: new Date().toISOString().slice(0, 10),
    trigger,
    ok: result.ok,
    message: result.message,
    durationMs,
  };

  addLog({
    providerId: provider.id,
    providerName: provider.name,
    type: provider.type,
    trigger,
    ok: result.ok,
    message: result.message,
    steps: result.steps || [],
    durationMs,
    time: nowText(),
  });

  return result;
}

/**
 * 安全取实时快照（只读），用于 Dashboard 卡片展示；HTTP 任务不支持
 */
export async function liveSnapshot(provider) {
  if (provider.type === 'workbuddy') {
    if (!provider.token) return { ok: false, message: '未配置 token' };
    const domain = provider.domain || 'www.codebuddy.cn';
    try {
      const status = await fetchStatus(domain, provider.token);
      const growth = await fetchGrowth(domain, provider.token);
      const travel = await fetchTravel(provider.token);
      return { ok: true, status, growth, travel };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }
  return { ok: false, message: 'HTTP 任务不支持实时查询' };
}
