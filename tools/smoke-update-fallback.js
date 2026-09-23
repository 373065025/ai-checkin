/**
 * 更新检查「免配额通道 + 端点差异」端到端测试
 *
 * 背景（实测确认的两个真实问题）：
 *   A. api.github.com 对未认证请求按出口 IP 限流 60 次/小时；国内共享出口的 NAS 很容易被用光，
 *      一旦 403，旧逻辑只报「检查失败」，新版本永远发现不了。
 *   B. GitHub 三种端点的资产信息不一致：/releases/latest 带 assets+digest ✅，
 *      而 /releases（列表）与 /releases/tags/<tag> 会把 assets 稳定漏成 [] ❌ ——
 *      旧代码只信 d.assets，会把这两种地址误判成「该 Release 没有更新包」。
 *
 * 用例（远端最新版本先自己查出来，不写死）：
 *   1. 垫片强制 API 403 + 本地版本调低 → 免配额通道必须发现远端最新（via=pages）
 *   2. 垫片开 + 本地=远端最新          → 必须判定「已是最新」（防误报）
 *   3. 真实网络                        → 能发现新版本；走 API 时必须带官方 sha256
 *   4. 更新源填 /releases 列表地址     → assets 被漏成 [] 也要能解析出更新包
 *   5. 远端资产直链 HEAD 可用、大小与本地同版本构建一致
 *
 * 用法：npm run smoke:update
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { extractTar, maybeGunzip } from './lib/tar-read.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = '373065025/ai-checkin';
const REPO_URL = `https://github.com/${REPO}`;
const NODE = process.execPath;

let pass = 0, fail = 0;
const chk = (ok, msg, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  —— ' + extra : '')); }
};

const LOCAL = (fs.readFileSync(path.join(root, 'manifest'), 'utf8').match(/^version\s*=\s*(\S+)/m) || [])[1];
const tgz = path.join(root, 'build', `app-${LOCAL}.tgz`);
if (!fs.existsSync(tgz)) { console.error(`✗ 找不到 ${tgz}，先跑 node tools/build-app-tgz.js`); process.exit(1); }

const portFree = (port) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(false) });
  s.on('error', () => res(true));
});

/**
 * 独立查一次远端最新版本（与被测代码无关，用来自证断言基准）。
 * 国内网络里 github.com 的 HTML 端点常被重置，所以依次尝试：直连重定向 → 镜像重定向 → GitHub API。
 */
async function remoteLatest() {
  const tries = [
    `${REPO_URL}/releases/latest`,
    `https://ghproxy.net/${REPO_URL}/releases/latest`,
    `https://ghfast.top/${REPO_URL}/releases/latest`,
  ];
  for (const url of tries) {
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'ai-checkin-test' } });
        const m = (r.headers.get('location') || '').match(/\/releases\/tag\/([^/?#]+)/);
        if (m) return decodeURIComponent(m[1]).replace(/^v/, '');
      } catch { await new Promise((s) => setTimeout(s, 700 * i)) }
    }
  }
  // 最后退一步问 API（需要匿名配额）
  try {
    const d = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'ai-checkin-test', Accept: 'application/vnd.github+json' },
    }).then((r) => r.json());
    if (d && d.tag_name) return String(d.tag_name).replace(/^v/, '');
  } catch {}
  return '';
}
const REMOTE = await remoteLatest();
console.log(`本地构建版本 ${LOCAL} | 远端最新 ${REMOTE || '(查询失败)'}`);
if (!REMOTE) { console.error('✗ 无法确认远端最新版本，测试中止'); process.exit(1); }

const FORCE_403 = `// 预加载垫片：把 api.github.com 的请求强制变成 403（模拟匿名配额耗尽）
const orig = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (/api\\.github\\.com/.test(url)) {
    return Promise.resolve(new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    }));
  }
  return orig(input, init);
};
`;

async function runCase({ label, fakeVersion, port, forceApi, sourceUrl = REPO_URL }) {
  console.log(`\n=== ${label} ===`);
  if (!(await portFree(port))) { chk(false, `端口 ${port} 被占用（请先清理再跑）`); return null }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aick-upd-'));
  extractTar(maybeGunzip(fs.readFileSync(tgz)), work);

  if (fakeVersion) {
    const man = path.join(work, 'manifest');
    fs.writeFileSync(man, fs.readFileSync(man, 'utf8').replace(/^version\s*=.*$/m, `version          = ${fakeVersion}`));
  }
  const declared = (fs.readFileSync(path.join(work, 'manifest'), 'utf8').match(/^version\s*=\s*(\S+)/m) || [])[1];

  const cfgDir = path.join(work, 'cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({
    update: { url: sourceUrl, autoCheck: false },
  }));
  const shim = path.join(work, '_shim.mjs');
  fs.writeFileSync(shim, FORCE_403);

  const args = forceApi
    ? ['--import', pathToFileURL(shim).href, path.join(work, 'server', 'src', 'index.js')]
    : [path.join(work, 'server', 'src', 'index.js')];

  const child = spawn(NODE, args, {
    env: { ...process.env, PORT: String(port), CONFIG_DIR: cfgDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (d) => (boot += d));
  child.stderr.on('data', (d) => (boot += d));

  const base = `http://127.0.0.1:${port}`;
  try {
    let state = null, lastErr = '';
    for (let i = 0; i < 70 && !state; i++) {
      try { const r = await fetch(base + '/api/state'); if (r.status) state = await r.json() } catch (e) { lastErr = e.message }
      if (!state) await new Promise((s) => setTimeout(s, 400));
    }
    if (!state) { chk(false, '服务启动', `${lastErr} :: ${boot.slice(-200)}`); return null }

    // 身份确认：/api/state 的 version 来自 store.js（不打进 manifest 的假版本号），
    // 用它确认应答的是「本源码树构建出来的实例」，而不是端口上的残留进程。
    console.log(`  实例 store 版本 ${state.version}（本源码树 ${LOCAL}；manifest 已改为 ${declared}）| 更新源 ${sourceUrl} | API 垫片 ${forceApi ? '开' : '关'}`);
    if (state.version !== LOCAL) { chk(false, `应答实例身份不符（${state.version} ≠ ${LOCAL}），疑似端口被残留进程占用`); return null }

    const r = await fetch(base + '/api/system/update/check', { method: 'POST' });
    const info = await r.json();
    console.log('  check →', JSON.stringify({
      current: info.current, latest: info.latest, hasUpdate: info.hasUpdate, via: info.via,
      pageBase: info.pageBase, size: info.size, sha256Present: info.sha256Present, error: info.error,
    }));
    if (info.attempts?.length) console.log('  降级原因 →', info.attempts.map((a) => a.error).join(' | ').slice(0, 240));
    return info;
  } catch (e) {
    console.log('  ✗ 运行失败:', e.message);
    return null;
  } finally {
    try { child.kill('SIGKILL') } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }) } catch {}
    for (let i = 0; i < 20 && !(await portFree(port)); i++) await new Promise((s) => setTimeout(s, 200));
  }
}

// —— 用例 1：API 全 403 → 免配额通道必须生效
const c1 = await runCase({ label: `用例 1：API 强制 403 + 本地 0.0.1 → 应发现 v${REMOTE}`, fakeVersion: '0.0.1', port: 8651, forceApi: true });
if (c1) {
  chk(c1.current === '0.0.1', `识别当前版本 0.0.1（实际 ${c1.current}）`);
  chk(c1.latest === REMOTE, `发现远端最新 ${REMOTE}（实际 ${c1.latest}）`);
  chk(c1.hasUpdate === true, '限流下正确判定「有更新」（不再误报为已是最新）');
  chk(c1.via === 'pages', `标记走免配额通道（via=${c1.via}）`);
  chk(!c1.error, '没有残留错误信息', c1.error || '');
  chk(!!c1.size, `解析出更新包大小（${c1.size} 字节）`);
  chk(c1.sha256Present === false, '免配额通道无官方 sha256（已降级为按大小校验）');
} else chk(false, '用例 1 未能运行');

// —— 用例 2：已是最新 → 不能误报
const c2 = await runCase({ label: `用例 2：API 强制 403 + 本地 ${REMOTE}（=远端最新）→ 应判定已是最新`, fakeVersion: REMOTE, port: 8652, forceApi: true });
if (c2) {
  chk(c2.current === REMOTE && c2.latest === REMOTE, `版本识别一致（${c2.current} / ${c2.latest}）`);
  chk(c2.hasUpdate === false, '正确判定「已是最新」（不误报新版本）');
  chk(c2.via === 'pages', `同样走免配额通道（via=${c2.via}）`);
} else chk(false, '用例 2 未能运行');

// —— 用例 3：真实网络
const c3 = await runCase({ label: '用例 3：真实网络 → 能发现新版本；走 API 时须带官方 sha256', fakeVersion: '0.0.1', port: 8653, forceApi: false });
if (c3) {
  chk(c3.hasUpdate === true, '正确判定「有更新」');
  chk(c3.latest === REMOTE, `发现远端最新 ${REMOTE}（实际 ${c3.latest}）`);
  chk(['api', 'pages'].includes(c3.via), `标记了取数通道（via=${c3.via}）`);
  if (c3.via === 'api') chk(c3.sha256Present === true, '走 API 时拿到官方 sha256（完整性校验最强）');
  else console.log('  （匿名配额已耗尽，真实网络也降级到免配额通道）');
} else chk(false, '用例 3 未能运行');

// —— 用例 4：更新源填成 /releases 列表地址（该端点恒返回 assets: []）
const c4 = await runCase({ label: '用例 4：更新源填 /releases 列表地址（assets 被漏成 [] 的端点）', fakeVersion: '0.0.1', port: 8654, forceApi: false, sourceUrl: `${REPO_URL}/releases` });
if (c4) {
  chk(c4.latest === REMOTE, `列表地址也能解析出最新版本 ${REMOTE}（实际 ${c4.latest}）`);
  chk(c4.hasUpdate === true, '正确判定「有更新」（不再被 assets:[] 误判为「没有更新包」）');
  chk(!!c4.size, `解析出更新包大小（${c4.size} 字节）`);
} else chk(false, '用例 4 未能运行');

// —— 用例 5：远端资产直链（直连不通时依次换镜像，与实际下载通道一致）
console.log('\n=== 用例 5：远端资产直链可用性 ===');
const MIRRORS = ['', 'https://ghproxy.net/', 'https://ghfast.top/'];
let hit = null;
outer:
for (const name of [`app-${REMOTE}.tgz`, `ai-checkin${REMOTE}.fpk`]) {
  for (const prefix of MIRRORS) {
    const u = prefix ? prefix + `${REPO_URL}/releases/download/v${REMOTE}/${name}` : `${REPO_URL}/releases/download/v${REMOTE}/${name}`;
    const label = (prefix ? prefix.replace(/^https:\/\//, '').replace(/\/$/, '') + ' ' : '直连 ') + name;
    try {
      const h = await fetch(u, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'ai-checkin' } });
      console.log(`  HEAD ${label.padEnd(34)} → ${h.status} | ${h.headers.get('content-length') || '-'} | ${h.headers.get('content-type') || '-'}`);
      if (h.ok) { hit = { name, size: Number(h.headers.get('content-length') || 0), type: h.headers.get('content-type'), prefix }; break outer }
    } catch (e) { console.log(`  HEAD ${label.padEnd(34)} → ERR ${(e.cause && e.cause.code) || e.message}`) }
  }
}
chk(!!hit, `远端 v${REMOTE} 至少有一个可下载资产`);
if (hit) {
  chk(hit.type === 'application/octet-stream', `Content-Type 正常（${hit.type}）`);
  console.log(`  命中入口：${hit.prefix ? hit.prefix + '（镜像）' : '直连'}`);
  if (hit.name === `app-${LOCAL}.tgz`) {
    const localSize = fs.statSync(tgz).size;
    chk(hit.size === localSize, `远端大小与本地同版本构建一致（${hit.size} vs ${localSize}）`);
  } else console.log(`  （命中 ${hit.name}，与本地构建版本不同，跳过大小比对）`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
