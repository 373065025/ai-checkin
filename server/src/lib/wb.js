// WorkBuddy「Buddy 加油站」客户端（Node 原生 fetch，零依赖）
//
// 安全边界（与积分技能一致的硬规则）：
// - 只使用 3 个已验证写接口：daily-checkin / travel/claim / travel/depart，绝不调用兑换、抽奖等其他写接口
// - 派遣前必查 daily_limit_reached，达上限不发写请求
// - 任何日志/输出不含 token
import { fetchRetry, tryJson } from './util.js';

const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const GROWTH_TASKS_PATH = '/v2/activity/growth/tasks';
const GROWTH_PROFILE_PATH = '/v2/activity/growth/profile';
const GROWTH_BUDDY_PATH = '/v2/activity/growth/buddy/info';
// 注意：旅行接口不带 /v2 前缀，且走独立域名
export const TRAVEL_DOMAIN = 'www.workbuddy.cn';
const TRAVEL_STATUS_PATH = '/activity/growth/buddy/travel/status';
const TRAVEL_CONFIG_PATH = '/activity/growth/buddy/travel/config';
const TRAVEL_CLAIM_PATH = '/activity/growth/buddy/travel/claim';
const TRAVEL_DEPART_PATH = '/activity/growth/buddy/travel/depart';
const ENERGY_PATH = '/activity/growth/energy';

export const STREAK_TIERS = [
  { days: 7, credit: 50, energy: 3, type: '累计发放' },
  { days: 14, credit: 100, energy: 4, type: '累计发放' },
  { days: 28, credit: 150, energy: 5, type: '主动兑换' },
];

export async function apiCall(domain, token, apiPath, method = 'POST', payload = undefined) {
  const url = `https://${domain}${apiPath}`;
  let body;
  if (payload !== undefined) body = JSON.stringify(payload);
  else if (method !== 'GET') body = '{}';
  const { status, text } = await fetchRetry(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ai-checkin/1.0',
    },
    body,
  });
  const json = tryJson(text) || { code: -1, msg: '响应不是有效 JSON' };
  return { status, body: json };
}

export async function fetchStatus(domain, token) {
  const { status, body } = await apiCall(domain, token, CHECKIN_STATUS_PATH);
  if (status !== 200 || body.code !== 0) {
    throw new Error(`查询加油站状态失败：HTTP ${status} ${body.msg || ''}`);
  }
  return body.data || {};
}

export async function doCheckin(domain, token) {
  const data = await fetchStatus(domain, token);
  if (data.today_checked_in) {
    return { action: 'skipped', ok: true, message: '今日已签到，无需重复打卡' };
  }
  const { status, body: chk } = await apiCall(domain, token, CHECKIN_PATH);
  const code = chk.code;
  const msg = chk.msg || '';
  if (status === 200 && code === 0) {
    return { action: 'checked_in', ok: true, message: msg || '签到成功', data: chk.data };
  }
  if (code === 10001 && msg.includes('已签到')) {
    return { action: 'skipped', ok: true, message: msg || '今日已签到' };
  }
  return { action: 'failed', ok: false, message: msg || `HTTP ${status}` };
}

export async function fetchGrowth(domain, token) {
  const out = { tasks: null, profile: null, buddy: null };
  const list = [
    [GROWTH_TASKS_PATH, 'tasks'],
    [GROWTH_PROFILE_PATH, 'profile'],
    [GROWTH_BUDDY_PATH, 'buddy'],
  ];
  // 三个 GET 相互独立 → 并行，避免串行叠加延迟（实测串行 ~2.3s / 并行 ~1.5s）
  const settled = await Promise.allSettled(
    list.map(([p]) => apiCall(domain, token, p, 'GET')),
  );
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const { status, body } = r.value;
    if (status === 200 && body.code === 0) out[list[i][1]] = body.data ?? null;
  });
  out.available = !!(out.tasks || out.profile || out.buddy);
  return out;
}

// ---------- 派猫猫旅行 ----------
function travelGet(token, path) {
  return apiCall(TRAVEL_DOMAIN, token, path, 'GET');
}

export async function fetchTravel(token) {
  const out = {};
  // 三个 GET 相互独立 → 并行
  const [st, cfg, en] = await Promise.allSettled([
    travelGet(token, TRAVEL_STATUS_PATH),
    travelGet(token, TRAVEL_CONFIG_PATH),
    travelGet(token, ENERGY_PATH),
  ]);
  const take = (r, key) => {
    if (r.status !== 'fulfilled') return;
    const { status, body } = r.value;
    if (status === 200 && body.code === 0) out[key] = body.data || {};
  };
  take(st, 'status');
  take(cfg, 'config');
  take(en, 'energy');
  out.available = !!(out.status || out.config);
  return out;
}

function travelStateText(state) {
  if (state === 'idle') return '空闲（可派遣）';
  if (state === 'traveling') return '旅行中';
  if (state === 'arrived') return '已到达，待领取';
  return state || '未知';
}

/**
 * 旅行自动闭环（先领后派）。
 * @returns {{steps: Array<{action:string,ok:boolean,message:string}>, stateText:string, gained:number}}
 */
export async function travelAuto(token, { locationId = 0 } = {}) {
  const steps = [];
  let gained = 0;
  let st = await fetchTravel(token);
  let state = st.status?.state;

  if (state === 'arrived') {
    const { status, body } = await apiCall(TRAVEL_DOMAIN, token, TRAVEL_CLAIM_PATH, 'POST', {});
    const ok = status === 200 && body.code === 0;
    const credit = body.data?.reward_credit ?? 0;
    steps.push({ action: '领取旅行奖励', ok, message: ok ? `领取成功 +${credit} 积分` : (body.msg || `HTTP ${status}`) });
    if (ok) gained += credit;
    st = await fetchTravel(token);
    state = st.status?.state;
  }

  if (state === 'idle') {
    if (st.status?.daily_limit_reached) {
      steps.push({ action: '派遣旅行', ok: true, message: '今日派遣已达上限，跳过（不发请求）' });
    } else {
      const locations = st.config?.locations || [];
      let chosen = Number(locationId) || 0;
      if (!locations.some((l) => l.id === chosen)) {
        chosen = locations.length ? locations[Math.floor(Math.random() * locations.length)].id : 1;
      }
      const { status, body } = await apiCall(TRAVEL_DOMAIN, token, TRAVEL_DEPART_PATH, 'POST', { location_id: chosen });
      const ok = status === 200 && body.code === 0;
      const locName = body.data?.location?.name || `地点${chosen}`;
      steps.push({ action: '派遣旅行', ok, message: ok ? `已派出「${locName}」` : (body.msg || `HTTP ${status}`) });
    }
  } else if (state === 'traveling') {
    const arriveAt = st.status?.arrive_at;
    const nowSec = st.status?.server_now || Math.floor(Date.now() / 1000);
    let remain = '';
    if (arriveAt) {
      const diff = Math.max(0, arriveAt - nowSec);
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      remain = h > 0 ? `约 ${h} 小时 ${m} 分后到达` : `约 ${m} 分后到达`;
    }
    steps.push({ action: '派遣旅行', ok: true, message: `旅行中（${st.status?.location?.name || '-'}），${remain || '等待到达'}` });
  } else if (!state) {
    steps.push({ action: '旅行状态', ok: false, message: '无法获取旅行状态（可能 token 失效）' });
  }

  return { steps, gained, stateText: state ? travelStateText(state) : '未知' };
}

// ---------- 完整自动任务 ----------
export function summarizeStatus(d) {
  const credits = d.total_credits ?? '-';
  const streak = d.streak_days ?? '-';
  return `积分 ${credits}，连续登录 ${streak} 天`;
}

/**
 * 执行一个 WorkBuddy 任务的完整流程
 * @param {{token:string, domain:string, autoCheckin:boolean, travelAuto:boolean, locationId:number}} p
 */
export async function runWorkBuddy(p) {
  const steps = [];
  const notes = [];
  const token = p.token;
  const domain = p.domain || 'www.codebuddy.cn';

  let statusData = {};
  try {
    statusData = await fetchStatus(domain, token);
    steps.push({ action: '加油站状态', ok: true, message: summarizeStatus(statusData) });
  } catch (e) {
    steps.push({ action: '加油站状态', ok: false, message: e.message });
    return { ok: false, message: `状态查询失败：${e.message}`, steps, notes };
  }

  // 1. 签到
  if (p.autoCheckin !== false) {
    try {
      const r = await doCheckin(domain, token);
      steps.push({ action: '每日签到', ok: r.ok, message: r.message });
      notes.push(`签到：${r.ok ? r.message : '失败'}`);
      if (r.action === 'checked_in') statusData.today_checked_in = true;
    } catch (e) {
      steps.push({ action: '每日签到', ok: false, message: e.message });
      notes.push('签到：失败');
    }
  }

  // 2. 旅行闭环（先领后派）
  if (p.travelAuto !== false) {
    try {
      const r = await travelAuto(token, { locationId: p.locationId || 0 });
      for (const s of r.steps) steps.push({ action: s.action, ok: s.ok, message: s.message });
      if (r.gained > 0) notes.push(`旅行：领取 ${r.gained} 积分`);
    } catch (e) {
      steps.push({ action: '旅行闭环', ok: false, message: e.message });
    }
  }

  // 3. 成长计划（只读）
  try {
    const g = await fetchGrowth(domain, token);
    if (g.available) {
      const buddyName = g.buddy?.buddy?.name || g.buddy?.name || '';
      const level = g.profile?.level;
      const done = g.profile?.completed;
      const total = g.profile?.total;
      const pending = Array.isArray(g.tasks) ? g.tasks.filter((t) => !t.status && t.status !== 'done').length : null;
      const parts = [];
      if (buddyName) parts.push(`Buddy「${buddyName}」`);
      if (level != null && total != null) parts.push(`Lv${level} 成长进度 ${done ?? 0}/${total}`);
      if (pending != null) parts.push(`待完成成长任务 ${pending} 个`);
      steps.push({ action: '成长计划', ok: true, message: parts.join('，') || '已获取' });
      if (pending) notes.push(`有 ${pending} 个成长任务待完成（需手动完成）`);
    }
  } catch { /* 静默 */ }

  const ok = steps.filter((s) => s.ok === false).length === 0;
  const summary = [
    `余额 ${statusData.total_credits ?? '-'} 分`,
    `连续 ${statusData.streak_days ?? '-'} 天`,
    notes.join('；') || (statusData.today_checked_in ? '今日已记录' : '今日未记录（完成一次对话即记录）'),
  ].join(' | ');

  return { ok, message: summary, steps, notes, statusData: {
    total_credits: statusData.total_credits,
    streak_days: statusData.streak_days,
    today_checked_in: statusData.today_checked_in,
    next_streak_day: statusData.next_streak_day,
  } };
}
