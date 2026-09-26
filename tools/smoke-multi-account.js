// 冒烟：WorkBuddy 加油站多账号（各自登录态 / 账号识别 / 去重 / 删除规则 / 备份往返）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8641;
const base = `http://127.0.0.1:${PORT}`;

const CUR_VER = (fs.readFileSync(path.join(ROOT, 'manifest'), 'utf8').match(/^version\s*=\s*(\S+)/m) || [])[1];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smk107-'));
const cfg = path.join(work, 'cfg');
fs.mkdirSync(cfg, { recursive: true });

// 本机 WorkBuddy 登录态（仅用于只读接口测试与账号识别）
function findToken() {
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'),
    path.join(os.homedir(), 'AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'),
  ];
  for (const c of cands) {
    if (!c || !fs.existsSync(c)) continue;
    const raw = fs.readFileSync(c, 'utf8');
    try {
      const j = JSON.parse(raw); const a = j.auth || j.data?.auth || j;
      let t = a.accessToken || a.access_token || j.accessToken;
      // 新版桌面端把 accessToken 加密成 { $wbEncrypted, envelope } 对象，文件里已无明文 JWT → 视为不可用
      if (t && typeof t !== 'string') t = '';
      if (t && !/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) t = '';
      if (t) return { token: t, domain: a.domain || 'www.codebuddy.cn', raw };
    } catch {
      const m = raw.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
      if (m) return { token: m[0], domain: 'www.codebuddy.cn', raw };
    }
  }
  return null;
}
const cred = findToken();

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), CONFIG_DIR: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
child.stdout.on('data', (d) => (boot += d));
child.stderr.on('data', (d) => (boot += d));

const j = async (p, opt) => {
  const r = await fetch(base + p, opt);
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const get = (p) => j(p);
const post = (p, obj) => j(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}),
});

let pass = 0, fail = 0;
const chk = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await get('/api/state'); if (r.status === 200) return true; } catch { /* retry */ }
    await wait(300);
  }
  return false;
}

try {
  if (!(await waitUp())) throw new Error('服务未启动：' + boot.slice(0, 400));
  // 同意协议，避免执行类接口被 403 拦住（本用例主要测配置，不涉及执行）
  await post('/api/agreement/accept');

  console.log('=== 内置任务与多账号创建 ===');
  let st = await get('/api/state');
  chk(st.body.version === CUR_VER, `版本号 ${CUR_VER}（实际 ${st.body.version}）`);
  const wb0 = st.body.providers.filter((p) => p.type === 'workbuddy');
  chk(wb0.length === 1, `全新安装只有 1 个内置 WorkBuddy 任务（实际 ${wb0.length}）`);
  chk(wb0[0].tokenPresent === false, '内置任务初始未配置登录态');

  // 新增第 2 个 WorkBuddy 账号
  const c1 = await post('/api/providers', {
    type: 'workbuddy', name: 'WorkBuddy 加油站', enabled: true,
    schedule: { times: ['09:00'] },
    token: cred ? cred.token : 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVpZC0xIiwibmlja25hbWUiOiLmtaHoi7HlsYAiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiIxNzcyNTE0MjU3MyJ9.x',
    domain: cred ? cred.domain : 'www.codebuddy.cn',
  });
  chk(c1.status === 200, '新增 WorkBuddy 任务成功');
  let all = c1.body.providers.filter((p) => p.type === 'workbuddy');
  chk(all.length === 2, `现在有 2 个 WorkBuddy 任务（实际 ${all.length}）`);
  const created = all.find((p) => p.id !== wb0[0].id);
  chk(!!created, '能取到新建的那个账号任务');

  console.log('\n=== 账号识别（从 JWT 解析昵称 / 手机号掩码） ===');
  chk(!!created.account, '新建任务带上了账号标识', JSON.stringify(created.account));
  if (created.account) {
    chk(!!created.account.uid, `账号 uid 已解析（${String(created.account.uid).slice(0, 8)}…）`);
    chk(!!created.account.nickname, `账号昵称已解析（${created.account.nickname}）`);
    chk(/^\d{3}\*{4}\d{4}$/.test(created.account.phoneMasked || ''), `手机号已打码（${created.account.phoneMasked}）`);
  }
  const phone = created.account?.phoneMasked?.replace(/\*/g, '') || '';
  chk(!JSON.stringify(c1.body).includes('1772514257'), '接口没有回显完整手机号');
  chk(!cred || !JSON.stringify(c1.body).includes(String(cred.token).slice(0, 40)), '/api/state 未泄露明文 token');

  console.log('\n=== 导入登录态：账号回显 + 重复添加提醒 ===');
  if (cred) {
    const imp = await post('/api/wb/import', { raw: cred.raw, id: wb0[0].id });
    chk(imp.status === 200 && imp.body.ok, '导入登录态成功');
    chk(!!imp.body.account?.nickname, `导入返回账号昵称（${imp.body.account?.nickname}）`);
    chk(imp.body.duplicateOf?.id === created.id, '同一账号加第二次会被识别为重复',
      JSON.stringify(imp.body.duplicateOf));
    const impSelf = await post('/api/wb/import', { raw: cred.raw, id: created.id });
    chk(impSelf.body.duplicateOf === null, '在它自己的任务里导入不算重复');
    chk(Array.isArray(impSelf.body.otherAccounts), '导入结果带 otherAccounts 字段');
  } else {
    console.log('  (跳过：本机没有 workbuddy-desktop.info)');
  }
  const bad = await post('/api/wb/import', { raw: 'not-a-token' });
  chk(bad.status === 400, '无效登录态被拒绝（400）');
  // 新版桌面端把 accessToken 加密成对象：必须明确拒绝，而不是当成导入成功但存了空登录态
  const enc = await post('/api/wb/import', {
    raw: JSON.stringify({ auth: { accessToken: { $wbEncrypted: 'v1', envelope: 'cGxhY2Vob2xkZXI=' }, domain: 'www.codebuddy.cn' } }),
  });
  chk(enc.status === 422 && enc.body.encryptedToken === true, '加密登录态（新版桌面端）被明确拒绝（422）',
    JSON.stringify(enc.body).slice(0, 120));

  console.log('\n=== 按 id 查询实时快照（多账号路由） ===');
  const liveNoId = await get('/api/wb/live?id=__nope__');
  chk(liveNoId.status === 404, '未知 id 返回 404');
  if (cred) {
    // created 用的是真实 token，只有它能真的打通远端
    const live = await get('/api/wb/live?id=' + encodeURIComponent(created.id));
    chk(live.body.ok === true, '按 id 查询实时数据成功', JSON.stringify(live.body).slice(0, 160));
    chk(!!live.body.status, '返回了加油站状态');
    chk(!!live.body.account?.nickname, `返回里带账号标识（${live.body.account?.nickname}）`);
    const other = await get('/api/wb/live?id=' + encodeURIComponent(wb0[0].id));
    chk(other.body.ok === false, '没配登录态的那个账号返回明确错误，而不是串号');
  } else {
    console.log('  (跳过：本机没有登录态)');
  }

  console.log('\n=== 多账号：删除规则 ===');
  const delOne = await post('/api/providers/delete', { id: created.id });
  chk(delOne.status === 200, '有两个时可删除其中一个 WorkBuddy 账号');
  chk(delOne.body.providers.filter((p) => p.type === 'workbuddy').length === 1, '删除后剩 1 个');
  const delLast = await post('/api/providers/delete', { id: wb0[0].id });
  chk(delLast.status === 400, '最后一个 WorkBuddy 任务不允许删除（400）');

  console.log('\n=== 多账号：各自独立的登录态 ===');
  // 重建第 2 个账号，写入各自的 token
  const cA = await post('/api/providers', {
    type: 'workbuddy', name: '主号', enabled: true, schedule: { times: ['09:00'] },
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LUEiLCJuaWNrbmFtZSI6IuS4u-WPtyIsInByZWZlcnJlZF91c2VybmFtZSI6IjE3NzI1MTQyNTczIn0.sig-a',
  });
  const aId = cA.body.providers.filter((p) => p.type === 'workbuddy').find((p) => p.name === '主号')?.id;
  const cB = await post('/api/providers', {
    type: 'workbuddy', name: '小号', enabled: true, schedule: { times: ['21:00'] },
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LUIiLCJuaWNrbmFtZSI6IuWwj-WPtyIsInByZWZlcnJlZF91c2VybmFtZSI6IjE4ODEyMzQ1Njc4In0.sig-b',
  });
  chk(cB.status === 200, '可继续添加第 3 个 WorkBuddy 任务');
  const wbs = cB.body.providers.filter((p) => p.type === 'workbuddy');
  chk(wbs.length === 3, `共 3 个 WorkBuddy 任务（实际 ${wbs.length}）`);
  const A = wbs.find((p) => p.name === '主号');
  const B = wbs.find((p) => p.name === '小号');
  chk(A?.account?.uid === 'account-A', `主号账号 uid 正确（${A?.account?.uid}）`);
  chk(B?.account?.uid === 'account-B', `小号账号 uid 正确（${B?.account?.uid}）`);
  chk(A?.tokenMasked !== B?.tokenMasked, '两个账号的 token 掩码不同（可区分）');
  chk(A?.schedule?.times?.[0] === '09:00' && B?.schedule?.times?.[0] === '21:00', '两个账号的执行时间各自独立');

  console.log('\n=== 备份 / 恢复：多账号往返 ===');
  const exp = await get('/api/backup/export?secrets=1');
  chk(exp.status === 200, '导出备份成功');
  const bk = typeof exp.body === 'string' ? JSON.parse(exp.body) : exp.body;
  chk(Array.isArray(bk.settings?.providers), '备份里 providers 是数组');
  const bkHb = bk.settings.providers.filter((p) => p.type === 'workbuddy');
  chk(bkHb.length === 3, `备份含 3 个 WorkBuddy 账号（实际 ${bkHb.length}）`);
  chk(bkHb.filter((p) => p.token).length === 2, '备份保留了这两个账号的登录态');
  chk(bkHb.some((p) => p.account?.uid === 'account-A'), '备份保留了账号标识');

  const expNo = await get('/api/backup/export?secrets=0');
  const bkNo = typeof expNo.body === 'string' ? JSON.parse(expNo.body) : expNo.body;
  const noHb = bkNo.settings.providers.filter((p) => p.type === 'workbuddy');
  chk(noHb.every((p) => !p.token), '不含凭据的备份里没有 token');
  chk(noHb.every((p) => !p.account), '不含凭据的备份里也没有账号昵称/手机号');

  // 人为改坏本机的任务，再用备份恢复
  await post('/api/providers', { id: A.id, name: '被改坏的名字', token: '__CLEAR__' });
  const before = (await get('/api/state')).body.providers.find((p) => p.id === A.id);
  chk(before.name === '被改坏的名字' && before.tokenPresent === false, '本机配置已被人为改坏');

  const prev = await post('/api/backup/restore', { backup: bk });
  chk(prev.body.preview === true, '未带 confirm 时只返回预览');
  chk(prev.body.summary?.workbuddy === 3, `预览统计 WorkBuddy 账号数（${prev.body.summary?.workbuddy}）`);

  const applied = await post('/api/backup/restore', { backup: bk, confirm: true });
  chk(applied.body.ok === true, '恢复成功');
  const after = (await get('/api/state')).body.providers;
  const A2 = after.find((p) => p.id === A.id);
  chk(A2?.name === '主号', `恢复后任务名回到备份里的值（${A2?.name}）`);
  chk(A2?.tokenPresent === true, '恢复后登录态回来了');
  chk(after.filter((p) => p.type === 'workbuddy').length === 3, '恢复后仍是 3 个 WorkBuddy 账号');

  // 用「不含凭据」的备份恢复：token 必须保留（按账号 uid 续上）
  await post('/api/providers', { id: B.id, token: '__CLEAR__' });
  const applied2 = await post('/api/backup/restore', { backup: bkNo, confirm: true });
  chk(applied2.body.ok === true, '用不含凭据的备份恢复成功');
  const after2 = (await get('/api/state')).body.providers.filter((p) => p.type === 'workbuddy');
  const A3 = after2.find((p) => p.account?.uid === 'account-A');
  chk(A3?.tokenPresent === true, '不含凭据的备份不会清空本机登录态（按账号 uid 续上）');

  console.log('\n=== 协议门禁仍然生效 ===');
  await post('/api/agreement/revoke');
  const guarded = await post('/api/backup/restore', { backup: bk, confirm: true });
  chk(guarded.status === 403 && guarded.body.needAgreement === true, '未同意协议时恢复备份被拦截（403）');
  await post('/api/agreement/accept');
} catch (e) {
  fail++;
  console.log('\n✗ 测试异常：', e.message);
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await wait(300);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('\n--- 服务输出 ---\n' + boot.slice(-2000)); process.exit(1); }
