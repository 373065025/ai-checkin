// 定时调度器：每 30 秒检查一次，按每个任务配置的每日时间点触发
import { get, save, isAgreementAccepted } from './store.js';
import { runProvider } from './providers.js';
import { todayStr, sleep } from './util.js';
import { sendNotify } from './notify.js';

let timer = null;
let lastTickMs = 0;

// 自动执行失败后的退避重试：网络抖一下不该让一整天的签到白丢
// 手动点「立即签到」不走重试 —— 用户当场就要看结果，自己会再点
const RETRY_DELAYS_MS = [60 * 1000, 3 * 60 * 1000];
// 系统休眠 / 进程被挂起很久后恢复：最多补跑最近 5 分钟内漏掉的时间点，
// 再久远的交给「启动补跑」，避免恢复瞬间一次性把历史时间点全跑一遍
const MAX_CATCHUP_MINUTES = 5;

const pad = (n) => String(n).padStart(2, '0');

/** 毫秒 → HH:MM */
function minuteKey(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 用户可能填「9:00」而不是「09:00」，比较前统一补零 */
function normalizeTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? `${pad(Number(m[1]))}:${m[2]}` : '';
}

/**
 * 本次 tick 需要检查哪些分钟。
 * 旧实现只比较「当前这一分钟」，一旦 tick 被阻塞或定时器漂移跨过某个整分钟，
 * 那个时间点就永远不会被触发（表现为「今天莫名没签到」）。
 * 这里改成扫描「上次 tick ~ 现在」之间经过的所有分钟。
 */
function pendingMinutes(lastMs, nowMs) {
  const nowMin = Math.floor(nowMs / 60000);
  if (!lastMs) return [minuteKey(nowMs)];
  const lastMin = Math.floor(lastMs / 60000);
  if (nowMin - lastMin > MAX_CATCHUP_MINUTES) return [minuteKey(nowMs)];
  const out = [];
  for (let m = lastMin + 1; m <= nowMin; m++) out.push(minuteKey(m * 60000));
  return out;
}

/** 定时 / 启动补跑的兜底重试：失败后按退避再试，全失败才算失败 */
async function runWithRetry(prov, settings, trigger) {
  let r = await runProvider(prov, settings, trigger);
  for (let i = 0; i < RETRY_DELAYS_MS.length && !r.ok; i++) {
    await sleep(RETRY_DELAYS_MS[i]);
    r = await runProvider(prov, settings, `${trigger}-retry${i + 1}`);
  }
  return r;
}

function notifyResult(settings, prov, r, prefix) {
  if (!settings.notify?.enabled) return;
  const title = r.ok ? `✅ ${prefix}签到成功` : `❌ ${prefix}签到失败`;
  sendNotify(settings, title, `${prov.name}：${r.message}`).catch(() => {});
}

async function tick() {
  // 未同意用户协议前不执行任何自动化动作
  if (!isAgreementAccepted()) return;
  const s = get();
  const now = Date.now();
  const day = todayStr();
  const minutes = pendingMinutes(lastTickMs, now);
  lastTickMs = now;
  if (!minutes.length) return;
  let dirty = false;

  for (const p of s.providers) {
    if (!p.enabled) continue;
    const times = (Array.isArray(p.schedule?.times) ? p.schedule.times : [])
      .map(normalizeTime).filter(Boolean);
    for (const t of minutes) {
      if (!times.includes(t)) continue;
      const key = `${day} ${t}`;
      if (p.lastTrigger === key) continue; // 同一时间点只跑一次
      p.lastTrigger = key;
      dirty = true;
      // 异步执行，不阻塞 tick
      runWithRetry(p, s, 'schedule').then((r) => {
        save();
        notifyResult(s, p, r, '');
      }).catch(() => {});
    }
  }
  if (dirty) save();
}

/** 启动补跑也走同一套重试；返回 promise 便于测试等待 */
function startupRun() {
  if (!isAgreementAccepted()) return Promise.resolve();
  const s = get();
  if (!s.scheduler?.runOnStart) return Promise.resolve();
  const day = todayStr();
  const jobs = [];
  for (const p of s.providers) {
    if (!p.enabled) continue;
    if (p.lastRun?.day === day) continue;
    jobs.push(runWithRetry(p, s, 'startup').then((r) => {
      save();
      notifyResult(s, p, r, '启动补跑');
    }).catch(() => {}));
  }
  return Promise.all(jobs).then(() => save());
}

export function startScheduler() {
  if (timer) return;
  lastTickMs = Date.now();
  timer = setInterval(tick, 30 * 1000);
  // 启动补跑：runOnStart 且今日未跑过的任务延迟 5 秒执行
  setTimeout(() => { startupRun(); }, 5000);
  console.log('[scheduler] started (30s tick)');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 仅供测试 */
export const _test = { tick, startupRun, pendingMinutes, normalizeTime };
