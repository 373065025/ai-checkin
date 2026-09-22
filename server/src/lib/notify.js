// 结果推送：支持通用 JSON / 钉钉 / 飞书 / 企业微信 / Bark / PushPlus
import { fetchRetry, nowText, tryJson } from './util.js';

const PUSHPLUS_ENDPOINT = 'https://www.pushplus.plus/send';

/**
 * 解析 PushPlus 的配置：用户既可只填 token，也可直接粘贴官方地址。
 * 支持：
 *   abcdef123456...                                  （纯 token）
 *   https://www.pushplus.plus/send/abcdef123456...   （token 在路径里）
 *   https://www.pushplus.plus/send?token=xxx&topic=yyy&template=txt
 */
export function parsePushPlus(raw) {
  const s = String(raw || '').trim();
  if (!s) return { token: '', topic: '', template: '' };
  if (!/^https?:\/\//i.test(s)) return { token: s, topic: '', template: '' };
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/send\/([^/?#]+)/);
    return {
      token: u.searchParams.get('token') || (m ? m[1] : ''),
      topic: u.searchParams.get('topic') || '',
      template: u.searchParams.get('template') || '',
    };
  } catch {
    return { token: s, topic: '', template: '' };
  }
}

/** PushPlus 走固定接口 + JSON body，需要单独组装 */
async function sendPushPlus(raw, title, content) {
  const { token, topic, template } = parsePushPlus(raw);
  if (!token) {
    return { ok: false, message: '请填写 PushPlus 的 token（也支持直接粘贴 https://www.pushplus.plus/send?token=... 地址）' };
  }
  const body = {
    token,
    title,
    content,
    // 正文是纯文本，用 txt 模板才能保留换行；想用别的模板可在填写的地址里带 &template=html
    template: template || 'txt',
  };
  if (topic) body.topic = topic;
  const r = await fetchRetry(PUSHPLUS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 1 });
  const d = tryJson(r.text) || {};
  const codeOk = String(d.code) === '200';
  const good = r.status < 300 && codeOk;
  return { ok: good, message: good ? 'PushPlus 已发送' : `PushPlus 失败：${d.msg || `HTTP ${r.status}`}` };
}

export function formatMessage(format, title, content) {
  const text = `${title}\n${content}`;
  switch (format) {
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } };
    case 'feishu':
      return { msg_type: 'text', content: { text } };
    case 'wecom':
      return { msgtype: 'text', text: { content: `${title}\n${content}` } };
    case 'bark':
      return null; // bark 走 URL 拼接
    case 'pushplus':
      return null; // pushplus 走固定接口，见 sendPushPlus
    case 'generic':
    default:
      return { title, content, time: nowText() };
  }
}

export async function sendNotify(settings, title, content) {
  const n = settings?.notify;
  if (!n?.enabled || !n.url) return { ok: false, skipped: true, message: '推送未启用' };
  const format = n.format || 'generic';
  try {
    if (format === 'bark') {
      const base = n.url.replace(/\/+$/, '');
      const url = `${base}/${encodeURIComponent(`${title} ${content}`.slice(0, 200))}`;
      const r = await fetchRetry(url, { method: 'GET' }, { retries: 1 });
      return { ok: r.status < 300, message: `Bark HTTP ${r.status}` };
    }
    if (format === 'pushplus') {
      return await sendPushPlus(n.url, title, content);
    }
    const payload = formatMessage(format, title, content);
    const r = await fetchRetry(n.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { retries: 1 });
    return { ok: r.status < 300, message: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
