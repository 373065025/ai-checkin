/**
 * 零依赖 tar / gzip 打包工具（构建用，Windows 也能跑）
 * 只依赖 node 内置模块；长路径（>100 字节）自动改用 GNU 风格的 PAX 扩展头。
 *
 * 可复现构建：所有条目的 mtime 固定为 SOURCE_DATE_EPOCH（默认 0），
 * 不再取源文件 mtime。这样本机构建与 GitHub Actions 构建产出的字节完全一致
 * —— 否则 tag 触发 CI 重建后会「覆盖」本机上测试过的包，两份包的 tar 头时间戳
 * 不同、sha256 对不上，让人误以为上传损坏（v1.0.5 / v1.0.6 各踩过一次）。
 */
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import path from 'node:path';

const SOURCE_DATE_EPOCH = Number.isFinite(Number(process.env.SOURCE_DATE_EPOCH))
  ? Number(process.env.SOURCE_DATE_EPOCH)
  : 0;

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header({ name, mode, size, mtime, typeflag, linkname = '' }) {
  const buf = Buffer.alloc(512, 0);
  const write = (s, off, len) => buf.write(s.slice(0, len), off, 'latin1');
  write(name, 0, 100);
  write(mode.toString(8).padStart(6, '0') + ' \0', 100, 8);
  write('000000 \0', 108, 8);   // uid
  write('000000 \0', 116, 8);   // gid
  write(octal(size, 12), 124, 12);
  write(octal(mtime, 12), 136, 12);
  buf.write('        ', 148, 8, 'latin1'); // checksum 占位
  buf.write(typeflag, 156, 1, 'latin1');
  write(linkname, 157, 100);
  buf.write('ustar\0', 257, 6, 'latin1');
  buf.write('00', 263, 2, 'latin1');

  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return buf;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  for (;;) {
    const candidate = `${len}${body}`;
    if (candidate.length === len) return Buffer.from(candidate, 'utf-8');
    len = candidate.length;
  }
}

function pad(size) {
  const rest = size % 512;
  return rest ? Buffer.alloc(512 - rest, 0) : Buffer.alloc(0);
}

/**
 * 打包成未压缩的 tar Buffer。
 * entries: [{ name, abs?, stat?, mode?, data? }]
 *   - name 以 '/' 结尾视为目录
 *   - abs 为源文件绝对路径；或直接给 data(Buffer) 内嵌内容
 *   - stat 用于取大小/时间；给 data 时可省略（用 data.length 兜底）
 *   - mode 可选，覆盖默认权限
 */
export async function packTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const isDir = e.name.endsWith('/');
    const mode = e.mode != null ? e.mode : (isDir ? 0o755 : 0o644);
    const data = isDir ? null : (e.data != null ? e.data : await readFile(e.abs));
    const size = isDir ? 0 : data.length;
    const mtime = SOURCE_DATE_EPOCH; // 固定，见文件头「可复现构建」说明

    if (Buffer.byteLength(e.name, 'utf-8') > 100) {
      const record = paxRecord('path', e.name);
      chunks.push(header({ name: '././@PaxHeader', mode: 0o644, size: record.length, mtime: 0, typeflag: 'x' }));
      chunks.push(record, pad(record.length));
    }

    chunks.push(header({ name: e.name, mode, size, mtime, typeflag: isDir ? '5' : '0' }));
    if (!isDir) chunks.push(data, pad(data.length));
  }
  chunks.push(Buffer.alloc(1024, 0)); // 结束标记
  return Buffer.concat(chunks);
}

/**
 * gzip 压缩。
 *
 * 注意末尾那 1 个字节的修补：Node 的 zlib 会把 gzip 头的 **OS 字段（第 10 字节）**
 * 按当前平台写入（Windows 0x0a / Linux 0x03 …）。这会让「本机 Windows 打的包」
 * 与「GitHub Actions 在 ubuntu 上打的包」即使内容完全相同、sha256 也对不上
 * （实测两份包长度一模一样、解压后 tar 逐字节相同，只差这一个字节）。
 * 统一写成 0x03（Unix）后，跨平台构建即可产出完全相同的字节。
 */
export function gzip(buf, level = 9) {
  return new Promise((resolve, reject) => {
    const parts = [];
    createGzip({ level })
      .on('data', (c) => parts.push(c))
      .on('end', () => {
        const out = Buffer.concat(parts);
        if (out.length > 9 && out[0] === 0x1f && out[1] === 0x8b) out[9] = 0x03; // OS = Unix
        resolve(out);
      })
      .on('error', reject)
      .end(buf);
  });
}

/**
 * 递归收集目录下所有文件/子目录，输出 tar entries。
 * @param {string} absDir 源目录绝对路径
 * @param {string} relDir 包内相对路径（posix 风格，不带结尾 /）
 * @param {Array} out 输出数组
 * @param {{excludeFile?: RegExp, excludeDir?: RegExp, dirMode?: number}} [opt]
 */
export function walk(absDir, relDir, out, opt = {}) {
  const excludeFile = opt.excludeFile || /(^|[\\/])$/;
  const excludeDir = opt.excludeDir || /$^/;
  for (const name of readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    const rel = relDir ? relDir + '/' + name : name;
    if (st.isDirectory()) {
      if (excludeDir.test(name)) continue;
      out.push({ name: rel + '/', abs: null, stat: st });
      walk(abs, rel, out, opt);
    } else {
      if (excludeFile.test(name)) continue;
      out.push({ name: rel, abs, stat: st });
    }
  }
}
