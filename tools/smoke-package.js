/**
 * 打包产物冒烟测试（零依赖）
 *
 * 把 build/app-<版本>.tgz 解到临时目录真跑一遍，验证：
 *   - 服务能正常启动、/api/state 版本号与 manifest 一致
 *   - 全新安装时协议为「未同意」
 *   - 未同意时执行类接口被 403 + needAgreement 拦截（法律风控闭环）
 *   - 同意 / 撤销协议接口生效，且门禁随之开合
 *
 * 用法：
 *   node tools/smoke-package.js
 *   node tools/smoke-package.js 8640        # 指定测试端口
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractTar, maybeGunzip, parseManifest } from './lib/tar-read.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = parseManifest(fs.readFileSync(path.join(root, 'manifest'), 'utf8')).version;
const PORT = Number(process.argv[2] || 8639);

const tgzPath = path.join(root, 'build', `app-${version}.tgz`);
if (!fs.existsSync(tgzPath)) {
  console.error(`✗ 找不到 ${tgzPath}\n  先执行  node tools/build-app-tgz.js`);
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aick-smoke-'));
extractTar(maybeGunzip(fs.readFileSync(tgzPath)), work);

const cfgDir = path.join(work, 'cfg');
fs.mkdirSync(cfgDir, { recursive: true });

console.log(`冒烟测试 app-${version}.tgz  →  端口 ${PORT}\n`);

const child = spawn(process.execPath, [path.join(work, 'server', 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), CONFIG_DIR: cfgDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
child.stdout.on('data', (d) => (boot += d));
child.stderr.on('data', (d) => (boot += d));

const base = `http://127.0.0.1:${PORT}`;
const req = async (p, opt) => {
  const r = await fetch(base + p, opt);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const post = (p, obj) => req(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj || {}),
});

let pass = 0, fail = 0;
const chk = (ok, msg, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  —— ' + extra : '')); }
};

const cleanup = () => {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
};

// 等端口就绪
let up = false;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(base + '/api/state'); if (r.ok) { up = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

try {
  chk(up, '服务启动并响应 /api/state', boot.trim().slice(0, 400));
  if (!up) throw new Error('boot failed');

  const st = await req('/api/state');
  chk(st.body && st.body.version === version, `版本号 = ${version}（实际 ${st.body && st.body.version}）`);
  chk(st.body && st.body.agreementAccepted === false, '全新安装：协议未同意');

  const ag = await req('/api/agreement');
  chk(ag.status === 200 && ag.body && ag.body.revision, `协议接口可用（revision=${ag.body && ag.body.revision}）`);
  chk(Array.isArray(ag.body && ag.body.sections) && ag.body.sections.length >= 5, `协议含 ${ag.body && ag.body.sections && ag.body.sections.length} 个条款`);
  chk(typeof (ag.body && ag.body.title) === 'string' && ag.body.title.length > 0, '协议含标题');

  const b1 = await post('/api/run-all');
  chk(b1.status === 403 && b1.body && b1.body.needAgreement === true, `未同意时 /api/run-all 被拦截（${b1.status}）`, JSON.stringify(b1.body));
  const b2 = await post('/api/notify/test');
  chk(b2.status === 403 && b2.body && b2.body.needAgreement === true, `未同意时 /api/notify/test 被拦截（${b2.status}）`);

  const acc = await post('/api/agreement/accept');
  chk(acc.status === 200 && acc.body && acc.body.accepted === true, '同意接口生效');
  const st2 = await req('/api/state');
  chk(st2.body && st2.body.agreementAccepted === true, '同意后 agreementAccepted = true');

  const after = await post('/api/notify/test', { notify: { format: 'pushplus', url: 'invalid-token-for-test' } });
  chk(after.status !== 403, `同意后不再 403（实际 ${after.status}）`);

  const rev = await post('/api/agreement/revoke');
  chk(rev.status === 200 && rev.body && rev.body.accepted === false, '撤销接口生效');
  const st3 = await req('/api/state');
  chk(st3.body && st3.body.agreementAccepted === false, '撤销后 agreementAccepted = false');
} catch (e) {
  fail++;
  console.log('  ✗ 执行中断: ' + e.message);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
cleanup();
process.exit(fail ? 1 : 0);
