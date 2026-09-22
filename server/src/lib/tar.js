/**
 * 极简 tar.gz 解包器（零依赖，支持 ustar / PAX / GNU 长文件名）
 * 只用于应用自更新的小体积包（几 MB），不做流式处理。
 *
 * 安全：所有条目必须在 destDir 内，拒绝 ../ 与绝对路径、跳过符号链接/设备文件。
 */
import { gunzipSync } from 'zlib';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'fs';
import path from 'path';

function readString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? len : end).toString('utf8');
}

function readNumeric(buf, start, len) {
  const field = buf.subarray(start, start + len);
  // GNU base-256 扩展
  if (field[0] & 0x80) {
    let n = field[0] & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + field[i];
    return n;
  }
  const s = readString(buf, start, len).trim().replace(/[^0-7]/g, '');
  return s ? parseInt(s, 8) : 0;
}

/** 解析 PAX 扩展头里的 path / linkpath */
function parsePax(buf) {
  const out = {};
  const text = buf.toString('utf8');
  const re = /(\d+)\s+([^=]+)=([^\n]*)\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const declared = parseInt(m[1], 10);
    const key = m[2];
    let value = m[3];
    if (value.length > declared - m[2].length - 3) value = value.slice(0, declared - m[2].length - 3);
    out[key] = value;
  }
  return out;
}

/**
 * @param {Buffer} gzBuffer .tar.gz 内容
 * @param {string} destDir  解包目标目录（必须已存在）
 * @param {(name:string)=>void} [onEntry]
 * @returns {{files:number, dirs:number, entries:string[]}}
 */
export function extractTgz(gzBuffer, destDir, onEntry) {
  const buf = gunzipSync(gzBuffer);
  const dest = path.resolve(destDir);
  let offset = 0;
  let files = 0;
  let dirs = 0;
  const entries = [];

  let paxName = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    offset += 512;

    // 全零块 = 归档结束
    let empty = true;
    for (let i = 0; i < 512; i++) { if (header[i] !== 0) { empty = false; break } }
    if (empty) break;

    let name = readString(header, 0, 100);
    const size = readNumeric(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const prefix = readString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    const dataStart = offset;
    const dataSize = Math.ceil(size / 512) * 512;
    const data = buf.subarray(dataStart, dataStart + size);
    offset += dataSize;

    // PAX 扩展头 / GNU 长文件名
    if (typeflag === 'x' || typeflag === 'g') {
      const pax = parsePax(data);
      if (pax.path) paxName = pax.path;
      continue;
    }
    if (typeflag === 'L' || typeflag === 'K') {
      const s = data.toString('utf8');
      paxName = s.slice(0, s.indexOf(0) < 0 ? undefined : s.indexOf(0));
      continue;
    }
    if (paxName) { name = paxName; paxName = null }

    if (!name) continue;
    // 归一化：去掉前导 ./ 和反斜杠
    name = name.replace(/^\.\//, '').replace(/\\/g, '/');

    const target = path.resolve(dest, name);
    if (target !== dest && !target.startsWith(dest + path.sep)) {
      throw new Error(`更新包包含非法路径: ${name}`);
    }

    if (typeflag === '5') {
      if (!existsSync(target)) mkdirSync(target, { recursive: true });
      dirs++;
      continue;
    }
    if (typeflag === '0' || typeflag === '\u0000' || typeflag === '7') {
      const parent = path.dirname(target);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(target, data);
      try {
        const mode = readNumeric(header, 100, 8) & 0o777;
        if (mode) chmodSync(target, mode);
      } catch {}
      files++;
      entries.push(name);
      if (onEntry) onEntry(name);
      continue;
    }
    // 其他类型（符号链接 / 设备）一律跳过，避免越权写文件
  }

  return { files, dirs, entries };
}
