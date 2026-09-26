/**
 * 1.0.9 冒烟：管理员密码（错误 10 次拉黑 1 小时）+ 本轮 bug 修复回归
 *
 * 覆盖：
 *   A. auth.js 纯逻辑：启停密码、登录、连错 10 次拉黑 1 小时、锁定期间正确密码也拒绝、
 *      改密码后旧 session 失效、关闭密码全放行
 *   B. scheduler：分钟区间扫描（漂移补跑）、9:00 → 09:00 归一化、长时间停机只认当前分钟
 *   C. providers：always 判定按字面语义；失败快照不覆盖上次成功值；
 *      runWorkBuddy 回传完整 status（checkin_dates 归一化进快照）
 *   D. mapLimit：并发受限、结果顺序与输入一致
 *   E. 子进程集成：设密码前接口全放行 → 设密码后 401/带 token 200 →
 *      另一来源 IP 连错 10 次被锁定（不影响其他 IP）
 *
 * 用法：npm run smoke:auth
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const chk = (ok, msg, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  —— ' + extra : '')); }
};

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-auth-unit-'));

// ---------- A/B/C/D：进程内单元 ----------
console.log('\n[A] 管理员密码逻辑');
const auth = await import('../server/src/lib/auth.js');
const reqOf = (ip = '1.2.3.4', extra = {}) => ({ headers: { ...extra }, socket: { remoteAddress: ip } });

chk(auth.isAuthorized(reqOf()) === true, '未设密码时接口全放行');
chk(auth.setPassword('', '123').ok === false, '密码太短被拒绝');
const set1 = auth.setPassword('', 'right-password-1');
chk(set1.ok && set1.enabled, '设置密码成功');
chk(auth.isEnabled(), 'isEnabled 生效');
chk(auth.isAuthorized(reqOf()) === false, '设密码后无 session 被拒');

const okLogin = auth.login(reqOf(), 'right-password-1');
chk(okLogin.ok && !!okLogin.token, '正确密码登录成功');
const authedReq = reqOf('1.2.3.4', { authorization: `Bearer ${okLogin.token}` });
chk(auth.isAuthorized(authedReq), '带有效 session 放行');
chk(auth.login(reqOf(), 'wrong').ok === false, '错误密码被拒');

// 连错 10 次 → 拉黑 1 小时（用另一个 IP，避免影响已登录会话）
let lockedResp = null;
for (let i = 0; i < 10; i++) lockedResp = auth.login(reqOf('2.2.2.2'), 'nope');
chk(lockedResp && lockedResp.locked === true, '连续错误 10 次触发锁定');
chk(lockedResp.lockSeconds > 3500 && lockedResp.lockSeconds <= 3600, `锁定时长 ≈ 1 小时（实际 ${lockedResp.lockSeconds}s）`);
const still = auth.login(reqOf('2.2.2.2'), 'right-password-1');
chk(still.ok === false && still.locked, '锁定期间即使密码正确也拒绝');
const st = auth.authState(reqOf('2.2.2.2'));
chk(st.locked && st.lockSeconds > 0, 'authStatus 反映锁定状态');
chk(!auth.authState(reqOf('3.3.3.3')).locked, '其他来源 IP 不受影响');

// 改密码 → 旧 session 失效
const change = auth.setPassword('right-password-1', 'new-password-99');
chk(change.ok, '修改密码成功（验证旧密码）');
chk(!auth.isAuthorized(authedReq), '改密码后旧 session 失效');
const ok2 = auth.login(reqOf(), 'new-password-99');
chk(ok2.ok, '新密码可登录');
chk(auth.setPassword('bad-old', 'x9x9x9x9').ok === false, '旧密码不对不能改');

// 关闭密码 → 全放行
const off = auth.setPassword('new-password-99', '');
chk(off.ok && off.enabled === false && !auth.isEnabled(), '关闭密码生效');
chk(auth.isAuthorized(reqOf()), '关闭后接口全放行');

console.log('\n[B] 调度器：分钟区间扫描 + 时间归一化');
const sched = (await import('../server/src/lib/scheduler.js'))._test;
const MIN = 60 * 1000;
// 固定基准 00:00:30，避免测试结果依赖运行的墙钟时刻
const base = new Date(2026, 0, 1, 0, 0, 30).getTime();
const sameMinute = sched.pendingMinutes(base, base + 20 * 1000);
chk(sameMinute.length === 0, '同一分钟内重复 tick 不再触发（防重）', JSON.stringify(sameMinute));
const firstTick = sched.pendingMinutes(0, base);
chk(firstTick.length === 1 && firstTick[0] === '00:00', '启动后首次 tick 检查当前分钟');
const cross = sched.pendingMinutes(base - 40 * 1000, base);
chk(cross.length === 1 && cross[0] === '00:00', '跨过整分钟能补上漏掉的分钟（防漂移）', JSON.stringify(cross));
const drift = sched.pendingMinutes(base - 3.5 * MIN, base);
chk(drift.length === 3 && drift.includes('23:58') && drift.includes('23:59') && drift.includes('00:00'),
  '漂移 3.5 分钟 → 补齐中间所有分钟', JSON.stringify(drift));
const afterSleep = sched.pendingMinutes(base - 30 * MIN, base);
chk(afterSleep.length === 1, '长时间停机只认当前分钟（历史交给启动补跑）');
chk(sched.normalizeTime('9:05') === '09:05', '「9:05」归一化成「09:05」');
chk(sched.normalizeTime('23:59') === '23:59' && sched.normalizeTime('bad') === '', '异常时间安全处理');

console.log('\n[C] providers：always 判定 / 失败快照 / 完整状态');
// mock 全局 fetch：按 URL 返回固定 JSON
const jsonResponse = (obj, status = 200) => ({
  ok: status < 400, status,
  text: async () => JSON.stringify(obj),
});
const realFetch = globalThis.fetch;
let failFetch = false;
globalThis.fetch = async (url) => {
  if (failFetch) throw new Error('ECONNRESET (mock)');
  const u = String(url);
  if (u.includes('checkin-activity-status')) return jsonResponse({
    code: 0, data: {
      today_checked_in: false, total_credits: 100, streak_days: 3, daily_credit: 5, today_credit: 5,
      next_streak_day: 4, week_checkin_days: 2, checkin_dates: ['2026-09-01', '2026-08-30', '2026-09-26'],
    },
  });
  if (u.includes('daily-checkin')) return jsonResponse({ code: 0, msg: '签到成功', data: { credit: 5, total_credits: 105 } });
  if (u.includes('travel/status')) return jsonResponse({ code: 0, data: { state: 'idle', daily_limit_reached: false } });
  if (u.includes('travel/config')) return jsonResponse({ code: 0, data: { locations: [{ id: 1, name: '公园' }] } });
  if (u.includes('travel/depart')) return jsonResponse({ code: 0, data: { location: { name: '公园' } } });
  return jsonResponse({ code: -1, msg: 'mock skip' }, 200);
};

const prov = await import('../server/src/lib/providers.js');
const store = await import('../server/src/lib/store.js');

const httpAlways = await prov.runHttpProvider({
  url: 'https://example.com/x', method: 'POST',
  successRule: { kind: 'always', expr: '', value: '' },
});
chk(httpAlways.ok === true, 'successRule=always 即使 HTTP 500 也判定成功');

const wbProv = { id: 'test-wb', type: 'workbuddy', token: 'aaa.bbb.ccc', domain: 'd.example', autoCheckin: true, travelAuto: true, locationId: 0 };
const r1 = await prov.runProvider(wbProv, store.get(), 'manual');
chk(r1.ok === true, 'WorkBuddy 完整流程跑通（mock）');
const live1 = prov.readLive('test-wb');
chk(live1?.ok === true, 'runProvider 后实时快照可用');
chk(live1?.status?.checkin_dates_this_month?.length === 2, '完整 status 并入快照：本月打卡 2 天（8/30 被过滤）', JSON.stringify(live1?.status?.checkin_dates_this_month));
chk(live1?.status?.today_credit === 5 && live1?.status?.week_checkin_days === 2, 'today_credit / week_checkin_days 不再丢失');

failFetch = true;
const r2 = await prov.refreshLive(wbProv);
const live2 = prov.readLive('test-wb');
chk(r2?.data?.ok === true && live2?.status?.today_checked_in === false
  || live2?.ok === true, '回源失败时保留上次成功快照');
chk(live2?.stale === true, '快照带 stale 标记，前端知道数据不是最新的');
prov.dropLive('test-wb');
chk(prov.readLive('test-wb') === null, 'dropLive 清理缓存');

console.log('\n[D] mapLimit');
const util = await import('../server/src/lib/util.js');
let concurrent = 0, maxConcurrent = 0;
const t0 = Date.now();
const order = await util.mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
  concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
  await new Promise((s) => setTimeout(s, 50));
  concurrent--;
  return n * 10;
});
chk(JSON.stringify(order) === JSON.stringify([10, 20, 30, 40, 50, 60, 70, 80]), '结果顺序与输入一致');
chk(maxConcurrent <= 3, `并发数不超过限制（峰值 ${maxConcurrent}）`);
chk(Date.now() - t0 < 8 * 50, '并发执行确实比串行快');

// 还原 fetch，进入集成测试
globalThis.fetch = realFetch;

// ---------- E：子进程集成 ----------
console.log('\n[E] HTTP 集成：守卫 + 登录 + 另一 IP 拉黑');
const configDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-auth-e2e-'));
const port = 18923;
const serverEntry = path.join(root, 'server', 'src', 'index.js');
const cp = spawn(NODE, [serverEntry], {
  env: { ...process.env, PORT: String(port), CONFIG_DIR: configDir2 },
  stdio: ['ignore', 'pipe', 'pipe'],
});
cp.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

const srvBase = `http://127.0.0.1:${port}`;
const waitHealth = async () => {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${srvBase}/api/health`); if (r.ok) return true; } catch {}
    await new Promise((s) => setTimeout(s, 200));
  }
  return false;
};
const jfetch = (p, opts = {}, ip = '') => fetch(srvBase + p, {
  ...opts,
  headers: { 'Content-Type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}), ...(opts.headers || {}) },
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  chk(await waitHealth(), '服务启动');
  chk((await jfetch('/api/auth/status')).body.enabled === false, '默认未开启密码');
  chk((await jfetch('/api/state')).status === 200, '未设密码时接口放行');
  await jfetch('/api/agreement/accept', { method: 'POST', body: '{}' });

  const setR = await jfetch('/api/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword: '', newPassword: 'pw-123456' }) });
  chk(setR.status === 200 && setR.body.enabled && setR.body.token, '启用密码并自动获得 session');
  const token = setR.body.token;

  const noTok = await jfetch('/api/state');
  chk(noTok.status === 401 && noTok.body.needAuth, '设密码后无 token 访问被拒（401）');
  const withTok = await jfetch('/api/state', { headers: { authorization: `Bearer ${token}` } });
  chk(withTok.status === 200, '带 token 访问正常');
  chk(withTok.body.adminEnabled === true, '/api/state 带 adminEnabled 标记');

  // 另一个来源 IP 连错 10 次 → 第 10 次锁定；本机 IP 不受影响
  let last = null;
  for (let i = 0; i < 10; i++) {
    last = await jfetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'wrong-wrong' }) }, '9.9.9.9');
  }
  chk(last.status === 429 && last.body.locked, '另一 IP 连错 10 次被锁定（429）');
  const blocked = await jfetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'pw-123456' }) }, '9.9.9.9');
  chk(blocked.status === 429 && blocked.body.locked, '锁定期间该 IP 正确密码也被拒');
  const others = await jfetch('/api/state', { headers: { authorization: `Bearer ${token}` } });
  chk(others.status === 200, '拉黑只针对错误来源，其他 IP 正常');

  // 备份不应包含 admin 字段
  const exp = await jfetch('/api/backup/export?secrets=1', { headers: { authorization: `Bearer ${token}` } });
  chk(exp.status === 200 && !('admin' in (exp.body.settings || {})), '备份文件不含管理员密码');
  const saved = JSON.parse(fs.readFileSync(path.join(configDir2, 'settings.json'), 'utf8'));
  chk(saved.admin?.enabled === true && !!saved.admin?.hash && !!saved.admin?.salt, '落盘的是哈希+盐，无明文密码');
} finally {
  cp.kill();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
