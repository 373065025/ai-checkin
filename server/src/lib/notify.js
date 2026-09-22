// 结果推送：支持通用 JSON / 钉钉 / 飞书 / 企业微信 / Bark
import { fetchRetry, nowText } from './util.js';

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
