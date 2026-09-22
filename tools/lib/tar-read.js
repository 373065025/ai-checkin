/**
 * 零依赖 tar / gzip 读取工具（校验用，Windows 也能跑）
 * 只依赖 node 内置模块，与 tar-pack.js 对称：
 *   - 支持 ustar 头
 *   - 支持 GNU/PAX 长路径扩展头（typeflag 'x'，key 为 path）
 *   - 支持目录('5')、普通文件('0' / '\0')、符号链接('2')
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const isZeroBlock = (b) => b.every((x) => x === 0);

/**
 * 遍历 tar 内存 Buffer。
 * @param {Buffer} buf 未压缩的 tar 数据
 * @param {(entry:{name:string,size:number,mode:number,type:string,data:Buffer})=>void} visit
 */
export function walkTar(buf, visit) {
  let off = 0;
  let pendingPath = '';
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (isZeroBlock(h)) break;

    let name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOct = h.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOct, 8) || 0;
    const modeOct = h.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim();
    const mode = parseInt(modeOct, 8) || 0;
    const type = String.fromCharCode(h[156] || 0);
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);

    if (type === 'x' || type === 'g') {
      // PAX 扩展头：从里面的 path= 记录取真实路径，作用于下一个条目
      const rec = data.toString('utf8');
      const m = rec.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      if (m) pendingPath = m[1];
    } else {
      const full = pendingPath || (prefix ? prefix + '/' + name : name);
      pendingPath = '';
      visit({ name: full, size, mode, type, data });
    }

    off = dataStart + Math.ceil(size / 512) * 512;
  }
}

/** 若 Buffer 是 gzip 则解压，否则原样返回 */
export function maybeGunzip(buf) {
  return buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
}

/**
 * 把未压缩的 tar Buffer 解到 destDir。
 * 注意：会拒绝绝对路径与 `..`，避免解出目录之外。
 */
export function extractTar(buf, destDir) {
  walkTar(buf, (e) => {
    const rel = path.posix.normalize(e.name.replace(/\\/g, '/'));
    if (path.posix.isAbsolute(rel) || rel.split('/').includes('..')) return;
    const target = path.join(destDir, rel);
    if (e.type === '5' || /\/$/.test(rel)) {
      fs.mkdirSync(target, { recursive: true });
    } else if (e.type === '0' || e.type === '\0' || e.type === '') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data, { mode: e.mode || 0o644 });
    }
  });
  return destDir;
}

/** 读取 manifest 的 `key = value` 文本格式 */
export function parseManifest(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}
