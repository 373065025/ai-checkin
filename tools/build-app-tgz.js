#!/usr/bin/env node
/**
 * 打包「应用内热更新」用的 app.tgz（不是 fpk）
 *
 * app.tgz 会解压到应用根目录，覆盖 server/ web/ ui/ config/ manifest，
 * 用作 GitHub Release 的更新附件（app-<版本>.tgz）。
 * ai-checkin 后端零依赖，包内不需要 node_modules，体积很小。
 *
 * 用法：
 *   node tools/build-app-tgz.js                      # 默认从项目根目录（本文件上一级）打包
 *   node tools/build-app-tgz.js --ws <源码目录> --out <输出文件>
 *   node tools/build-app-tgz.js --manifest-only      # 只打印版本号
 */
import { readFileSync, statSync } from 'node:fs';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packTar, gzip, walk } from './lib/tar-pack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// tools/ → 上一级即项目根目录（含 manifest / server / web / cmd / config / ui）
const DEFAULT_WS = path.resolve(path.join(HERE, '..'));

const EXCLUDE_FILE = /(_probe\.mjs$|\.log$|\.DS_Store$|Thumbs\.db$|\.tmp$)/i;
const EXCLUDE_DIR = /^(node_modules|\.git|\.workbuddy|__pycache__)$/i;

/** 应用运行时目录（与 updater.js 的替换集合一致） */
const PARTS = ['server', 'web/dist', 'ui', 'config'];

export function readManifestVersion(ws) {
  try {
    const man = readFileSync(path.join(ws, 'manifest'), 'utf-8');
    const m = man.match(/^version\s*=\s*(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

/** 收集 app.tgz 的 tar entries */
export function collectAppEntries(ws) {
  const out = [];
  for (const part of PARTS) {
    const abs = path.join(ws, part);
    let st;
    try { st = statSync(abs); } catch { console.warn(`  ! 跳过不存在的目录 ${part}（前端可能还没构建）`); continue; }
    if (st.isDirectory()) {
      out.push({ name: part + '/', abs: null, stat: st });
      walk(abs, part, out, { excludeFile: EXCLUDE_FILE, excludeDir: EXCLUDE_DIR });
    } else {
      out.push({ name: part, abs, stat: st });
    }
  }
  const manAbs = path.join(ws, 'manifest');
  out.push({ name: 'manifest', abs: manAbs, stat: statSync(manAbs) });
  return out;
}

/** 生成 app.tgz（gzip 后的 Buffer） */
export async function buildAppTgzBuffer(ws) {
  const entries = collectAppEntries(ws);
  const tar = await packTar(entries);
  return { gz: await gzip(tar), tarSize: tar.length, count: entries.length };
}

// ---- CLI（仅当作为入口运行时执行，被 import 时不跑） ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && process.argv.includes('--manifest-only')) {
  console.log(readManifestVersion(DEFAULT_WS));
  process.exit(readManifestVersion(DEFAULT_WS) ? 0 : 1);
}

if (isMain) {
  const ws = path.resolve(arg('ws', DEFAULT_WS));
  const ver = readManifestVersion(ws);
  if (!ver) {
    console.error('✗ 读不到版本号：' + path.join(ws, 'manifest'));
    process.exit(1);
  }
  const out = path.resolve(arg('out', path.join(ws, 'build', `app-${ver}.tgz`)));

  console.log(`→ 打包 app.tgz  ${ws}`);
  console.log(`  版本    ${ver}`);
  console.log(`  输出    ${out}`);

  const { gz, tarSize, count } = await buildAppTgzBuffer(ws);
  console.log(`  条目    ${count}`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, gz);
  const st = await stat(out);
  console.log(`✓ tar ${(tarSize / 1048576).toFixed(2)} MB → gzip ${(st.size / 1048576).toFixed(2)} MB`);
  console.log(`\n下一步：把该文件上传到 GitHub Release（tag 建议 v${ver}）`);
  console.log(`  ${path.relative(process.cwd(), out).split(path.sep).join('/')}`);
  console.log(`  也可直接上传 .fpk，客户端会自动拆出里面的 app.tgz。`);
}
