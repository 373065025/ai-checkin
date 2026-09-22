const VERSION = 'v1.0.6'

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`)
  return data
}

export const getState = () => api('/api/state')
export const saveSettings = (body) => api('/api/settings', { method: 'POST', body: JSON.stringify(body) })
export const importWb = (raw) => api('/api/wb/import', { method: 'POST', body: JSON.stringify({ raw }) })
export const saveProvider = (p) => api('/api/providers', { method: 'POST', body: JSON.stringify(p) })
export const deleteProvider = (id) => api('/api/providers/delete', { method: 'POST', body: JSON.stringify({ id }) })
export const toggleProvider = (id) => api('/api/providers/toggle', { method: 'POST', body: JSON.stringify({ id }) })
export const runProvider = (id) => api('/api/providers/run', { method: 'POST', body: JSON.stringify({ id }) })
export const runAll = () => api('/api/run-all', { method: 'POST', body: '{}' })
export const parseCurl = (curl) => api('/api/curl-parse', { method: 'POST', body: JSON.stringify({ curl }) })
export const testNotify = (content) => api('/api/notify/test', { method: 'POST', body: JSON.stringify({ content }) })
export const clearLogs = () => api('/api/logs/clear', { method: 'POST', body: '{}' })
export const getWbLive = () => api('/api/wb/live')

// force=true 强制拉最新（用户点「刷新」）；默认拿缓存、过期则后台刷新，页面不等待
export const getProviderLive = (id, force = false) =>
  api('/api/providers/live', { method: 'POST', body: JSON.stringify({ id, force }) })

// ===== 系统 / 自动更新 =====
export const getSystemInfo = () => api('/api/system/info')
export const getUpdateInfo = () => api('/api/system/update')
export const checkUpdate = () => api('/api/system/update/check', { method: 'POST', body: '{}' })
export const getUpdateStatus = () => api('/api/system/update/status')
export const getUpdateBackups = () => api('/api/system/update/backups')
export const applyUpdate = () => api('/api/system/update/apply', { method: 'POST', body: '{}' })
export const rollbackUpdate = (version) => api('/api/system/update/rollback', { method: 'POST', body: JSON.stringify({ version }) })
export const saveUpdateConfig = (patch) => api('/api/system/update/config', { method: 'PUT', body: JSON.stringify(patch) })

// ===== 用户协议与免责声明 =====
export const getAgreement = () => api('/api/agreement')
export const acceptAgreement = () => api('/api/agreement/accept', { method: 'POST', body: '{}' })
export const revokeAgreement = () => api('/api/agreement/revoke', { method: 'POST', body: '{}' })

// ===== 配置备份与恢复 =====
// 导出走浏览器原生下载（附件响应），secrets=false 时不带登录凭据，便于分享排查
export const backupExportUrl = (secrets = true) => `/api/backup/export?secrets=${secrets ? 1 : 0}`
export const previewRestore = (backup) => api('/api/backup/restore', { method: 'POST', body: JSON.stringify({ backup }) })
export const applyRestore = (backup) => api('/api/backup/restore', { method: 'POST', body: JSON.stringify({ backup, confirm: true }) })

export { VERSION }

export function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fmtTime(iso) {
  if (!iso) return '从未'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
