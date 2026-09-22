#!/usr/bin/env node
/**
 * 打包飞牛 fnOS 安装包 .fpk（两层 tar.gz）
 *
 * 结构（与官方要求一致）：
 *   ai-checkin<版本>.fpk
 *     ├─ app.tgz                # 应用运行时（server/ web/ ui/ config/ manifest）
 *     ├─ cmd/                   # 安装/卸载/升级钩子（需可执行位 755）
 *     ├─ config/                # privilege / resource
 *     ├─ wizard/index.json      # 安装向导（默认端口）
 *     ├─ ICON.PNG  ICON_256.PNG # 应用中心图标
 *     └─ manifest
 *
 * 关键点：cmd/ 下的脚本必须带可执行位，否则安装时钩子不会执行。
 *
 * 用法：
 *   node tools/build-fpk.js                 # 默认项目根目录
 *   node tools/build-fpk.js --ws <目录> --out <文件>
 */
import { statSync } from 'node:fs';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packTar, gzip, walk } from './lib/tar-pack.js';
import { buildAppTgzBuffer, readManifestVersion } from './build-app-tgz.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const EXCLUDE_FILE = /(_probe\.mjs$|\.log$|\.DS_Store$|Thumbs\.db$|\.tmp$)/i;
const EXCLUDE_DIR = /^(node_modules|\.git|\.workbuddy|__pycache__)$/i;

const ws = path.resolve(arg('ws', path.join(HERE, '..')));
const version = readManifestVersion(ws);
if (!version) {
  console.error('✗ 读不到版本号：' + path.join(ws, 'manifest'));
  process.exit(1);
}
const out = path.resolve(arg('out', path.join(ws, `ai-checkin${version}.fpk`)));

console.log(`→ 打包 fpk  ${ws}`);
console.log(`  版本    ${version}`);
console.log(`  输出    ${out}`);

// 1) 内层 app.tgz
const { gz: appTgz, tarSize, count } = await buildAppTgzBuffer(ws);
console.log(`  app.tgz ${count} 条目，${(tarSize / 1048576).toFixed(2)} MB → ${(appTgz.length / 1048576).toFixed(2)} MB`);

// 2) 外层 fpk
const entries = [];
const add = (name, abs, mode) => entries.push({ name, abs, stat: statSync(abs), mode });
const addDir = (name) => entries.push({ name: name + '/', abs: null, stat: statSync(path.join(ws, name)), mode: 0o755 });

// 内层包（内存数据）
entries.push({ name: 'app.tgz', abs: null, data: appTgz, mode: 0o644 });

// cmd/ 钩子（必须 755）
if (statSync(path.join(ws, 'cmd'), { throwIfNoEntry: false })) {
  addDir('cmd');
  const cmdEntries = [];
  walk(path.join(ws, 'cmd'), 'cmd', cmdEntries, { excludeFile: EXCLUDE_FILE, excludeDir: EXCLUDE_DIR });
  for (const e of cmdEntries) entries.push({ ...e, mode: e.name.endsWith('/') ? 0o755 : 0o755 });
}

// 其他静态目录 / 文件
for (const part of ['config', 'wizard']) {
  if (statSync(path.join(ws, part), { throwIfNoEntry: false })) {
    addDir(part);
    walk(path.join(ws, part), part, entries, { excludeFile: EXCLUDE_FILE, excludeDir: EXCLUDE_DIR });
  }
}
for (const f of ['ICON.PNG', 'ICON_256.PNG', 'manifest']) {
  if (statSync(path.join(ws, f), { throwIfNoEntry: false })) add(f, path.join(ws, f), 0o644);
}

console.log(`  fpk 外层 ${entries.length} 个成员`);

const tar = await packTar(entries);
const fpk = await gzip(tar);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, fpk);
const st = await stat(out);
console.log(`✓ fpk ${(tar.length / 1048576).toFixed(2)} MB → gzip ${(st.size / 1048576).toFixed(2)} MB`);
console.log(`\n安装：飞牛应用中心 → 手动安装 → 选择该文件（端口保持 8630）`);
