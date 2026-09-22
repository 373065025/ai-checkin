// 定时调度器：每 30 秒检查一次，按每个任务配置的每日时间点触发
import { get, save } from './store.js';
import { runProvider } from './providers.js';
import { nowHM, todayStr } from './util.js';
import { sendNotify } from './notify.js';

let timer = null;
let startedDay = null;

async function tick() {
  const s = get();
  const hm = nowHM();
  const day = todayStr();
  let dirty = false;

  for (const p of s.providers) {
    if (!p.enabled) continue;
    const times = Array.isArray(p.schedule?.times) ? p.schedule.times : [];
    for (const t of times) {
      if (!/^\d{1,2}:\d{2}$/.test(t)) continue;
      if (t !== hm) continue;
      const key = `${day} ${t}`;
      if (p.lastTrigger === key) continue; // 同一时间点只跑一次
      p.lastTrigger = key;
      dirty = true;
      // 异步执行，不阻塞 tick
      runProvider(p, s, 'schedule').then((r) => {
        save();
        if (s.notify?.enabled) {
          sendNotify(s, r.ok ? '✅ 签到成功' : '❌ 签到失败', `${p.name}：${r.message}`).catch(() => {});
        }
      }).catch(() => {});
    }
  }
  if (dirty) save();
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, 30 * 1000);
  // 启动补跑：runOnStart 且今日未跑过的任务延迟 5 秒执行
  setTimeout(async () => {
    const s = get();
    if (!s.scheduler?.runOnStart) return;
    const day = todayStr();
    for (const p of s.providers) {
      if (!p.enabled) continue;
      if (p.lastRun?.day === day) continue;
      runProvider(p, s, 'startup').then((r) => {
        save();
        if (s.notify?.enabled) {
          sendNotify(s, r.ok ? '✅ 启动补跑签到成功' : '❌ 启动补跑签到失败', `${p.name}：${r.message}`).catch(() => {});
        }
      }).catch(() => {});
    }
    save();
  }, 5000);
  console.log('[scheduler] started (30s tick)');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
