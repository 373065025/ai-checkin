// 任务引擎：内置 WorkBuddy + 通用 HTTP 签到
import { tryJson, pickPath, nowText } from './util.js';
import { runWorkBuddy, fetchStatus, fetchGrowth, fetchTravel } from './wb.js';
import { addLog, save } from './store.js';

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

  // 刚跑过一次签到，加油站状态是现成的 → 直接灌进缓存与 lastLive，
  // 这样签到中心不需要再等一次远端请求就能显示「今日已签到」
  if (provider.type === 'workbuddy' && result.statusData) {
    const prev = liveCache.get(provider.id)?.data || {};
    const merged = {
      ...prev,
      ok: true,
      status: { ...(prev.status || {}), ...result.statusData },
      fetchedAt: Date.now(),
    };
    if (!merged.travel) merged.travel = prev.travel || null;
    liveCache.set(provider.id, { at: Date.now(), data: merged });
    provider.lastLive = slimLive(merged, Date.now());
  }

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

// ============ 实时快照缓存（签到中心「秒开」的关键） ============
//
// 背景：一次实时快照要打 7 个远端请求（加油站状态 1 + 成长计划 3 + 旅行 3）。
// 即使全部并行也有 1.5s 左右，串行更是 3s+。所以不再让页面「等」远端：
//   · 90 秒内命中缓存 → 直接返回（0 等待）
//   · 缓存过期但仍可用 → 「先返回旧值 + 后台静默刷新」，页面照样瞬间出内容
//   · 精简后的快照持久化到 provider.lastLive，即使应用重启，首屏也能立刻显示「今日已签到」
const LIVE_TTL_MS = 90 * 1000;
const liveCache = new Map(); // providerId -> { at, data }
const liveInflight = new Map(); // providerId -> Promise

/**
 * 补齐界面要用的派生字段。
 * 上游加油站状态给的是 `checkin_dates`（全部打卡日期），而界面需要「本月已签 N 天」，
 * 之前直接读 `checkin_dates_this_month` 恒为 undefined → 一直显示 0 天（已修）。
 */
function normalizeStatus(st) {
  if (!st || typeof st !== 'object') return st;
  if (Array.isArray(st.checkin_dates_this_month)) return st;
  const dates = Array.isArray(st.checkin_dates) ? st.checkin_dates : [];
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const prefix = `${now.getFullYear()}-${p(now.getMonth() + 1)}`;
  return { ...st, checkin_dates_this_month: dates.filter((d) => String(d).startsWith(prefix)) };
}

/** 精简快照：只留界面用得上的字段，与完整快照保持同样的取值路径 */
export function slimLive(snap, ts = Date.now()) {
  if (!snap || !snap.ok) return { ok: false, message: snap?.message || '', ts };
  const st = snap.status || {};
  return {
    ok: true,
    ts,
    status: {
      today_checked_in: !!st.today_checked_in,
      today_credit: st.today_credit,
      daily_credit: st.daily_credit,
      total_credits: st.total_credits,
      streak_days: st.streak_days,
      next_streak_day: st.next_streak_day,
      week_checkin_days: st.week_checkin_days,
      checkin_dates_this_month: Array.isArray(st.checkin_dates_this_month)
        ? st.checkin_dates_this_month.slice(-31)
        : [],
    },
    travel: { status: { state: snap.travel?.status?.state || '' } },
  };
}

/** 纯读缓存，不触发任何远端请求 */
export function readLive(id) {
  const c = liveCache.get(id);
  if (!c) return null;
  const age = Date.now() - c.at;
  return { ...c.data, at: c.at, age, fresh: age < LIVE_TTL_MS, cached: true };
}

/** 真正打远端（三路并行） */
async function fetchLiveSnapshot(provider) {
  const domain = provider.domain || 'www.codebuddy.cn';
  const [st, gr, tr] = await Promise.allSettled([
    fetchStatus(domain, provider.token),
    fetchGrowth(domain, provider.token),
    fetchTravel(provider.token),
  ]);
  if (st.status !== 'fulfilled') {
    // 状态查不到才是真失败（通常 token 失效）；成长/旅行属锦上添花，失败静默降级
    return { ok: false, message: st.reason?.message || '查询加油站状态失败' };
  }
  return {
    ok: true,
    status: normalizeStatus(st.value),
    growth: gr.status === 'fulfilled' ? gr.value : null,
    travel: tr.status === 'fulfilled' ? tr.value : null,
    fetchedAt: Date.now(),
  };
}

/**
 * 刷新实时快照：写内存缓存 + 持久化精简版。同一任务并发调用会复用同一个 Promise。
 */
export function refreshLive(provider) {
  const id = provider.id;
  if (liveInflight.has(id)) return liveInflight.get(id);
  const task = (async () => {
    try {
      const data = await fetchLiveSnapshot(provider);
      liveCache.set(id, { at: Date.now(), data });
      // 持久化精简版：重启后首屏立刻可用（不含 growth 明细，避免撑大 settings.json）
      provider.lastLive = slimLive(data, Date.now());
      save();
      return liveCache.get(id);
    } finally {
      liveInflight.delete(id);
    }
  })();
  liveInflight.set(id, task);
  return task;
}

/**
 * 安全取实时快照（只读），用于 Dashboard 卡片展示；HTTP 任务不支持。
 *
 * opts.force = true → 强制刷新并等待（用户主动点「刷新」时用）
 * 默认行为 → 有缓存就立刻返回，过期了顺手在后台刷新，绝不阻塞页面
 */
export async function liveSnapshot(provider, { force = false } = {}) {
  if (provider.type !== 'workbuddy') return { ok: false, message: 'HTTP 任务不支持实时查询' };
  if (!provider.token) return { ok: false, message: '未配置 token' };

  if (force) {
    await refreshLive(provider);
    const out = readLive(provider.id);
    // 这次响应是真的回源拉取的 → cached 明确为 false，避免调用方误判
    return out
      ? { ...out, cached: false, age: 0, refreshing: false }
      : { ok: false, message: '刷新失败，请稍后重试' };
  }

  const hit = readLive(provider.id);
  if (hit) {
    if (!hit.fresh) refreshLive(provider).catch(() => { /* 静默 */ });
    return { ...hit, refreshing: !hit.fresh };
  }

  // 首次访问，手头没有任何数据，只能等这一次
  await refreshLive(provider).catch(() => { /* 静默 */ });
  const fresh = readLive(provider.id);
  return fresh
    ? { ...fresh, refreshing: false }
    : { ok: false, message: '查询失败，请稍后重试' };
}
