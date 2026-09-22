/**
 * fpk 安装包校验（零依赖）
 *
 * 用法：
 *   node tools/verify-fpk.js                # 自动按根 manifest 的 version 找 ai-checkin<版本>.fpk
 *   node tools/verify-fpk.js path/to/x.fpk  # 指定文件
 *
 * 校验项：
 *   - 外层成员齐全（manifest / app.tgz / ICON / cmd / config / wizard）
 *   - cmd/ 下所有文件均已置可执行位（缺了飞牛会启动失败）
 *   - manifest 关键字段（版本、开发者、发布者、端口）
 *   - 内层 app.tgz 可解压，且含 server/ web/dist 与同版本 manifest
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { walkTar, maybeGunzip, parseManifest } from './lib/tar-read.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rootManifest = parseManifest(fs.readFileSync(path.join(root, 'manifest'), 'utf8'));
const version = rootManifest.version;

const arg = process.argv[2];
const fpk = arg ? path.resolve(arg) : path.join(root, `ai-checkin${version}.fpk`);

if (!fs.existsSync(fpk)) {
  console.error(`✗ 找不到安装包：${fpk}\n  先执行  node tools/build-fpk.js`);
  process.exit(1);
}

let pass = 0, fail = 0;
const chk = (ok, msg, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  —— ' + extra : '')); }
};

console.log(`校验 ${path.basename(fpk)}  (${(fs.statSync(fpk).size / 1024).toFixed(1)} KB)\n`);

const raw = maybeGunzip(fs.readFileSync(fpk));
const outer = [];
walkTar(raw, (e) => outer.push(e));

// ---- 外层成员 ----
console.log('· 外层成员');
for (const e of outer.slice().sort((a, b) => a.name.localeCompare(b.name))) {
  const tag = e.type === '5' ? '[D]' : e.type === '2' ? '[L]' : '   ';
  console.log(`    ${tag} ${e.mode.toString(8).padStart(4, '0')} ${String(e.size).padStart(8)}  ${e.name}`);
}

const names = outer.map((e) => e.name);
console.log('\n· 结构校验');
chk(names.includes('manifest'), '含 manifest');
chk(names.includes('app.tgz'), '含 app.tgz');
chk(names.some((n) => /^ICON(_256)?\.PNG$/.test(n)), '含应用图标');
chk(names.some((n) => n.startsWith('cmd/')), '含 cmd/ 启动脚本');
chk(names.some((n) => n === 'wizard/index.json'), '含 wizard/index.json');
chk(names.some((n) => n.startsWith('config/')), '含 config/');

const cmdFiles = outer.filter((e) => e.name.startsWith('cmd/') && e.type !== '5');
const badMode = cmdFiles.filter((e) => (e.mode & 0o111) === 0);
chk(cmdFiles.length > 0 && badMode.length === 0,
  `cmd/ 下 ${cmdFiles.length} 个文件均可执行`,
  badMode.length ? '缺执行位: ' + badMode.map((e) => e.name).join(', ') : '');

// ---- manifest ----
const manEntry = outer.find((e) => e.name === 'manifest');
const man = manEntry ? parseManifest(manEntry.data.toString('utf8')) : {};
console.log('\n· manifest');
for (const k of ['appname', 'version', 'display_name', 'maintainer', 'maintainer_url', 'distributor', 'distributor_url', 'service_port']) {
  if (man[k] !== undefined) console.log(`    ${k.padEnd(16)} = ${man[k]}`);
}
chk(man.version === version, `version 与根 manifest 一致（${version}）`);
chk(!!man.maintainer, `开发者已填写（${man.maintainer || '空'}）`);
chk(!!man.distributor, `发布者已填写（${man.distributor || '空'}）`);
chk(/^https?:\/\//.test(man.maintainer_url || ''), 'maintainer_url 为合法地址');
chk(/^https?:\/\//.test(man.distributor_url || ''), 'distributor_url 为合法地址');
chk(/^\d+$/.test(man.service_port || ''), `service_port 为纯数字（${man.service_port || '空'}）`);

// ---- 内层 app.tgz ----
console.log('\n· 内层 app.tgz');
const appEntry = outer.find((e) => e.name === 'app.tgz');
if (!appEntry) {
  chk(false, 'app.tgz 存在');
} else {
  let inner = [];
  try {
    walkTar(zlib.gunzipSync(appEntry.data), (e) => inner.push(e));
    chk(inner.length > 0, `可解压，共 ${inner.length} 个条目`);
  } catch (e) {
    chk(false, '可解压', e.message);
  }
  const inames = inner.map((e) => e.name);
  chk(inames.some((n) => n === 'server/' || n.startsWith('server/')), '含 server/');
  chk(inames.some((n) => n.startsWith('web/dist/')), '含 web/dist/ 前端产物');
  chk(inames.some((n) => n === 'ui/' || n.startsWith('ui/')), '含 ui/');
  const im = inner.find((e) => e.name === 'manifest' || e.name === './manifest');
  if (im) {
    const iv = parseManifest(im.data.toString('utf8')).version;
    chk(iv === version, `内层 manifest 版本一致（${iv}）`);
  } else {
    chk(false, '内层含 manifest');
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
