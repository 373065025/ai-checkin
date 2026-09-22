/**
 * 一键发布 GitHub Release（零依赖）
 *
 * 用法：
 *   node tools/release.js                     # 只做检查（dry-run）
 *   node tools/release.js --publish           # 创建/更新 Release 并上传附件
 *   node tools/release.js --publish --prune   # 发布后删除其它旧 Release，只留最新
 *   node tools/release.js --prune-only        # 只清理旧 Release
 *
 * 凭据获取顺序：
 *   1. 环境变量 GH_TOKEN / GITHUB_TOKEN
 *   2. git credential fill（复用本机已保存的 GitHub 凭据，不落盘）
 *
 * 附件：build/app-<版本>.tgz + ai-checkin<版本>.fpk（同名附件会先删后传）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseManifest } from './lib/tar-read.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const DO_PUBLISH = has('--publish');
const DO_PRUNE = has('--prune') || has('--prune-only');
const PRUNE_ONLY = has('--prune-only');

const version = parseManifest(fs.readFileSync(path.join(root, 'manifest'), 'utf8')).version;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repoUrl = (pkg.repository && pkg.repository.url) || pkg.homepage || '';
const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
if (!m) {
  console.error(`✗ 无法从 package.json 解析 GitHub 仓库地址：${repoUrl}`);
  process.exit(1);
}
const [owner, repo] = [m[1], m[2]];
const tag = `v${version}`;
const API = 'https://api.github.com';

// ---------- 凭据 ----------
function resolveToken() {
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN.trim(), from: 'GH_TOKEN' };
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN.trim(), from: 'GITHUB_TOKEN' };
  // 本机 Bash/PowerShell 的 PATH 里常常没有 git，逐条尝试候选路径
  const candidates = [
    process.env.GIT_BIN,
    'git',
    'C:/Users/AGG/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
  ].filter(Boolean);
  for (const git of candidates) {
    try {
      const out = execFileSync(git, ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const pm = out.match(/^password=(.*)$/m);
      if (pm && pm[1].trim()) return { token: pm[1].trim(), from: 'git credential fill' };
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

const cred = resolveToken();
if (!cred) {
  console.error('✗ 未找到 GitHub 凭据。请设置 GH_TOKEN 环境变量，或先配置 git 凭据。');
  process.exit(1);
}

// ---------- API ----------
const H = {
  Authorization: `Bearer ${cred.token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'ai-checkin-release',
  'X-GitHub-Api-Version': '2022-11-28',
};

// 网络抖动（GFW / TLS 重置）常见，对幂等请求做有限重试
const RETRYABLE = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network/i;
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function withRetry(label, fn, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const retryable = RETRYABLE.test(e.message) || RETRYABLE.test((e.cause && e.cause.code) || '');
      if (i === tries || !retryable) break;
      console.log(`  ! ${label} 第 ${i} 次失败（${e.message.slice(0, 80)}），${i * 1200}ms 后重试`);
      await sleep(i * 1200);
    }
  }
  throw last;
}

async function api(method, endpoint, body, extraHeaders = {}) {
  // 仅对幂等语义（GET/DELETE/PATCH）自动重试；POST 交给调用方按需重试
  const idempotent = method !== 'POST';
  const run = async () => {
    const r = await fetch(API + endpoint, {
      method,
      headers: { ...H, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const msg = (data && data.message) || text || r.statusText;
      throw new Error(`${method} ${endpoint} → ${r.status} ${msg}`);
    }
    return data;
  };
  return idempotent ? withRetry(`${method} ${endpoint}`, run) : run();
}

async function listReleases() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const chunk = await api('GET', `/repos/${owner}/${repo}/releases?per_page=100&page=${page}`);
    out.push(...chunk);
    if (chunk.length < 100) break;
  }
  return out;
}

function assetFiles() {
  const files = [
    path.join(root, 'build', `app-${version}.tgz`),
    path.join(root, `ai-checkin${version}.fpk`),
  ];
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error('✗ 缺少待上传文件，请先执行  npm run release\n  ' + missing.map((f) => path.relative(root, f)).join('\n  '));
    process.exit(1);
  }
  return files;
}

async function uploadAsset(release, file) {
  const name = path.basename(file);
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) {
    await api('DELETE', `/repos/${owner}/${repo}/releases/assets/${existing.id}`);
    console.log(`  · 已删除同名旧附件 ${name}`);
  }
  const buf = fs.readFileSync(file);
  const ct = /\.fpk$|\.tgz$/i.test(name) ? 'application/gzip' : 'application/octet-stream';
  const base = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets`;
  const data = await withRetry(`上传 ${name}`, async () => {
    const r = await fetch(`${base}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': ct, 'Content-Length': String(buf.length) },
      body: buf,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`上传 ${name} 失败 → ${r.status} ${t.slice(0, 300)}`);
    }
    return r.json();
  });
  console.log(`  ✓ 已上传 ${name}  (${(data.size / 1024).toFixed(1)} KB)`);
  return data;
}

// 同名附件去重：只保留最新一个（上传重试可能产生重复）
async function dedupeAssets(releaseId) {
  const assets = await api('GET', `/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100`);
  const byName = new Map();
  for (const a of assets) {
    const list = byName.get(a.name) || [];
    list.push(a);
    byName.set(a.name, list);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    for (const dup of list.slice(1)) {
      await api('DELETE', `/repos/${owner}/${repo}/releases/assets/${dup.id}`);
      console.log(`  · 去重：删除多余附件 ${name} (id ${dup.id})`);
    }
  }
}

// ---------- 主流程 ----------
console.log(`仓库   ${owner}/${repo}`);
console.log(`版本   ${version}  →  tag ${tag}`);
console.log(`凭据   来自 ${cred.from}\n`);

if (PRUNE_ONLY) {
  await prune();
} else if (DO_PUBLISH) {
  await publish();
  if (DO_PRUNE) await prune();
} else {
  await dryRun();
}

// 只保留 tag 对应的 Release，其余全部删除（含 tag）
async function prune() {
  const releases = await listReleases();
  const keep = releases.filter((r) => r.tag_name === tag);
  const drop = releases.filter((r) => r.tag_name !== tag);

  if (!keep.length) {
    console.error(`✗ 未找到 ${tag} 的 Release，已中止清理（避免误删全部版本）`);
    process.exit(1);
  }
  if (!drop.length) {
    console.log('· 没有需要清理的旧 Release');
    return;
  }

  console.log(`· 清理旧 Release（保留 ${tag}，共 ${drop.length} 个）`);
  for (const r of drop) {
    await api('DELETE', `/repos/${owner}/${repo}/releases/${r.id}`);
    console.log(`  ✓ 已删除 Release ${r.tag_name}`);
    // 顺带删除对应的 git tag（失败不致命：可能 tag 不存在或已被删）
    try {
      await api('DELETE', `/repos/${owner}/${repo}/git/refs/tags/${encodeURIComponent(r.tag_name)}`);
      console.log(`    · 已删除 tag ${r.tag_name}`);
    } catch (e) {
      if (!/404/.test(e.message)) console.log(`    ! tag ${r.tag_name} 删除失败：${e.message}`);
    }
  }
}

async function dryRun() {
  const releases = await listReleases();
  console.log(`GitHub 上现有 ${releases.length} 个 Release：`);
  for (const r of releases) {
    const names = (r.assets || []).map((a) => a.name).join(', ') || '(无附件)';
    console.log(`  ${r.tag_name.padEnd(10)} ${r.draft ? '[草稿] ' : ''}${names}`);
  }
  const exists = releases.some((r) => r.tag_name === tag);
  console.log(`\n${tag} ：${exists ? '已存在（--publish 会更新其附件）' : '尚不存在（--publish 会创建）'}`);
  console.log('\n这只是检查。真正发布请加 --publish；清理旧版本加 --prune。');
}

async function publish() {
  const releases = await listReleases();
  let rel = releases.find((r) => r.tag_name === tag);

  if (rel) {
    console.log(`· 更新已有 Release ${tag}`);
    rel = await api('PATCH', `/repos/${owner}/${repo}/releases/${rel.id}`, {
      name: `AI签到管家 ${tag}`,
      body: rel.body || '',
      draft: false,
      prerelease: false,
    });
  } else {
    console.log(`· 创建 Release ${tag}`);
    rel = await api('POST', `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: `AI签到管家 ${tag}`,
      draft: false,
      prerelease: false,
      generate_release_notes: true,
    });
  }
  console.log(`  Release: ${rel.html_url}`);

  console.log('· 上传附件');
  const files = assetFiles();
  for (const f of files) await uploadAsset(rel, f);

  await dedupeAssets(rel.id);
  await verifyAssets(rel.id, files);

  console.log(`\n✓ 发布完成：${rel.html_url}`);
}

// 校验远端附件与本地一致。
// 先比 sha256；不一致时**下载回来做内容比对**——tag 推送会触发 CI 重建并覆盖附件，
// 两份包可能只差 tar 头里的 mtime（内容完全相同），此时不应报错，而应说明清楚。
async function verifyAssets(releaseId, files) {
  const assets = await api('GET', `/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100`);
  const local = new Map(files.map((f) => {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    return [path.basename(f), { path: f, sha256 }];
  }));
  console.log('· 校验远端附件');
  let bad = 0;
  for (const [name, { path: p, sha256 }] of local) {
    const a = assets.find((x) => x.name === name);
    if (!a) { console.log(`  ✗ 远端缺少 ${name}`); bad++; continue; }
    const remote = (a.digest || '').replace(/^sha256:/, '');
    if (remote && remote === sha256) { console.log(`  ✓ ${name} sha256 完全一致`); continue; }
    if (!remote) { console.log(`  ? ${name} 远端无 digest，改为下载内容比对`); }

    const verdict = await compareContent(a.id, p);
    if (verdict === 'same-tar') {
      console.log(`  ~ ${name} sha256 不同，但解包内容一致（仅 tar 头时间戳差异，通常来自 CI 重建覆盖）`);
    } else if (verdict === 'same') {
      console.log(`  ✓ ${name} 下载比对完全一致（远端 digest 未更新，可忽略）`);
    } else {
      console.log(`  ✗ ${name} 内容不一致（${verdict}），需重新 --publish`);
      bad++;
    }
  }
  if (bad) {
    console.error(`\n✗ ${bad} 个附件校验失败，请重新执行 node tools/release.js --publish`);
    process.exitCode = 1;
  }
}

/** 下载远端资产，与本地文件比对解压后的 tar（忽略 mtime 与校验和字段） */
async function compareContent(assetId, localPath) {
  const r = await fetch(`${API}/repos/${owner}/${repo}/releases/assets/${assetId}`, {
    headers: { ...H, Accept: 'application/octet-stream' },
  });
  if (!r.ok) return `下载失败 ${r.status}`;
  const remote = Buffer.from(await r.arrayBuffer());
  const localBuf = fs.readFileSync(localPath);
  if (remote.equals(localBuf)) return 'same';
  const a = maybeGunzip(localBuf);
  const b = maybeGunzip(remote);
  if (a.length !== b.length) return `解压长度不同 ${a.length} vs ${b.length}`;
  return maskTarMeta(a).equals(maskTarMeta(b)) ? 'same-tar' : '字节内容不同';
}

function maybeGunzip(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf); } catch { /* 落到原样比较 */ }
  }
  return buf;
}

/** 把每个 tar 头块的 mtime(136..147) 与 checksum(148..155) 清零，用于忽略时间戳比较 */
function maskTarMeta(tar) {
  const out = Buffer.from(tar);
  for (let off = 0; off + 512 <= out.length; off += 512) {
    const isZero = out.subarray(off, off + 512).every((x) => x === 0);
    if (isZero) continue;
    out.fill(0, off + 136, off + 156);
  }
  return out;
}
