const VERSION = 'v1.0.9'

// ===== 管理员登录态 =====
// 后端开启管理员密码后，所有接口要带 Bearer token；没设密码时后端全放行，这里无感。
const TOKEN_KEY = 'ai-checkin-admin-token'
let adminToken = ''
try { adminToken = localStorage.getItem(TOKEN_KEY) || '' } catch { /* 隐私模式等 */ }

export function getAdminToken() { return adminToken }
export function hasAdminToken() { return !!adminToken }

export function setAdminToken(t) {
  adminToken = String(t || '')
  try {
    if (adminToken) localStorage.setItem(TOKEN_KEY, adminToken)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* ignore */ }
}

// 401 时由 App.vue 注册回调，弹出登录界面
let unauthorizedHandler = null
export function onUnauthorized(fn) { unauthorizedHandler = typeof fn === 'function' ? fn : null }

function authHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra }
  if (adminToken) h['Authorization'] = `Bearer ${adminToken}`
  return h
}

export async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: authHeaders(options.headers) })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && data.needAuth) {
    setAdminToken('')
    unauthorizedHandler?.(data)
    throw new Error(data.message || '请先登录管理员密码')
  }
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`)
  return data
}

export const authStatus = () => api('/api/auth/status')
export const authLogin = (password) => api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
export const authLogout = () => api('/api/auth/logout', { method: 'POST', body: '{}' })
export const authSetPassword = (oldPassword, newPassword) =>
  api('/api/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) })

export const getState = () => api('/api/state')
export const saveSettings = (body) => api('/api/settings', { method: 'POST', body: JSON.stringify(body) })
// id = 当前正在编辑的任务 id（用于识别「这个账号是不是已经加过了」）
export const importWb = (raw, id = '') => api('/api/wb/import', { method: 'POST', body: JSON.stringify({ raw, id }) })
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
// 开启管理员密码后 <a href> 带不了鉴权头 → 改为 fetch blob 下载
export async function backupExportUrl(secrets = true) {
  const res = await fetch(`/api/backup/export?secrets=${secrets ? 1 : 0}`, { headers: authHeaders() })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && data.needAuth) {
    setAdminToken('')
    unauthorizedHandler?.(data)
    throw new Error(data.message || '请先登录管理员密码')
  }
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`)
  const blob = await res.blob()
  const dispo = res.headers.get('content-disposition') || ''
  const m = dispo.match(/filename="?([^";]+)"?/i)
  return { blob, fileName: m ? m[1] : 'ai-checkin-backup.json' }
}
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
