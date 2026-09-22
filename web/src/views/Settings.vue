<script setup>
import { ref, inject, computed, onMounted, onUnmounted } from 'vue'
import { saveSettings, importWb, saveProvider, testNotify, getSystemInfo, getUpdateInfo, checkUpdate, getUpdateStatus, getUpdateBackups, applyUpdate, rollbackUpdate, saveUpdateConfig } from '../api/index.js'

const state = inject('state')
const refresh = inject('refresh')
const toast = inject('toast')

const rawToken = ref('')
const importing = ref(false)
const fileInput = ref(null)
const notifyForm = ref(JSON.parse(JSON.stringify(state.value.notify || {})))
const schedulerForm = ref(JSON.parse(JSON.stringify(state.value.scheduler || {})))
const testing = ref(false)

const wb = () => state.value.providers.find((p) => p.type === 'workbuddy')

function onFile(e) {
  const f = e.target.files?.[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => { rawToken.value = String(reader.result || '') }
  reader.readAsText(f)
}

async function doImport() {
  if (!rawToken.value.trim()) { toast('请先粘贴登录态内容或 token', 'err'); return }
  importing.value = true
  try {
    const r = await importWb(rawToken.value)
    const p = wb()
    await saveProvider({ ...p, token: r.token, domain: r.domain })
    rawToken.value = ''
    await refresh()
    toast(`导入成功（${r.masked}）`)
  } catch (e) { toast(e.message, 'err') }
  importing.value = false
}

async function clearToken() {
  if (!confirm('确定清除已保存的 token？清除后自动签到将停止。')) return
  await saveProvider({ ...wb(), token: '' })
  await refresh()
  toast('已清除')
}

async function saveNotify() {
  try {
    await saveSettings({ notify: notifyForm.value, scheduler: schedulerForm.value })
    await refresh()
    toast('设置已保存')
  } catch (e) { toast(e.message, 'err') }
}

async function testPush() {
  testing.value = true
  try {
    await saveSettings({ notify: notifyForm.value })
    const r = await testNotify()
    toast(r.ok ? '测试推送已发送 ✅' : `推送失败：${r.message}`, r.ok ? 'ok' : 'err')
  } catch (e) { toast(e.message, 'err') }
  testing.value = false
}

// ===== 自动更新（同一张卡片：没新版本=检查，有新版本=更新） =====
const version = ref('')
const updateInfo = ref(null)
const checking = ref(false)
const showUpdate = ref(false)
const backups = ref([])
const updateUrl = ref('')
const updateAltUrl = ref('')
const autoCheck = ref(true)
const showAdvanced = ref(false)
const usingBuiltin = ref(true)
const updateSources = ref([])
const updateToken = ref('')
const updateUser = ref('')
const updatePassword = ref('')
const hasToken = ref(false)
const hasBasic = ref(false)
const upState = ref({ state: 'idle', progress: 0, message: '', error: '' })
const saved = ref(false)
const savedTimer = ref(null)

const UPDATE_BUSY = ['downloading', 'verifying', 'installing', 'restarting']
const hasUpdate = computed(() => !!updateInfo.value?.hasUpdate)
const busy = computed(() => UPDATE_BUSY.includes(upState.value.state))
const canClose = computed(() => !UPDATE_BUSY.includes(upState.value.state))

const mainButtonText = computed(() => {
  if (checking.value) return '检查中…'
  if (busy.value) return '更新中…'
  if (hasUpdate.value) return `更新到 v${updateInfo.value.latest}`
  return '检查更新'
})

const sourceNote = computed(() => {
  if (updateUrl.value) {
    return /github\.com|api\.github\.com/i.test(updateUrl.value)
      ? 'GitHub Releases 更新源'
      : '自定义更新源'
  }
  return updateSources.value.length > 1
    ? '内置更新源（主源不可用时自动切换备用源）'
    : '未配置更新源（请在高级设置填写）'
})

const statusText = computed(() => {
  switch (upState.value.state) {
    case 'downloading': return '正在下载更新包…'
    case 'verifying': return '正在校验文件完整性…'
    case 'installing': return '正在安装并备份旧版本…'
    case 'restarting': return '更新完成，应用正在重启…'
    case 'done': return '更新完成'
    case 'error': return '更新失败'
    default: return ''
  }
})

async function loadSystemInfo() {
  try {
    const info = await getSystemInfo()
    version.value = info.version
    backups.value = info.backups || []
    updateUrl.value = info.updateUrl || ''
    updateAltUrl.value = info.updateAltUrl || ''
    autoCheck.value = info.autoCheckUpdate !== false
    hasToken.value = !!info.hasUpdateToken
    hasBasic.value = !!info.hasBasicAuth
    usingBuiltin.value = info.usingBuiltinSource !== false
    updateSources.value = info.updateSources || []
  } catch {}
  try { backups.value = await getUpdateBackups() } catch {}
}

async function doCheck() {
  checking.value = true
  try {
    updateInfo.value = await checkUpdate()
  } catch (err) {
    updateInfo.value = { hasUpdate: false, error: err.message }
  } finally { checking.value = false }
}

function onMainAction() {
  if (hasUpdate.value) showUpdate.value = true
  else doCheck()
}

async function saveUpdateUrl() {
  try {
    await saveUpdateConfig({ url: updateUrl.value, altUrl: updateAltUrl.value })
    flashSaved()
    await loadSystemInfo()
    updateInfo.value = null
  } catch {}
}

async function saveAuto() {
  try { await saveUpdateConfig({ autoCheck: autoCheck.value }); flashSaved() } catch {}
}

async function saveAuth() {
  const patch = { user: updateUser.value, password: updatePassword.value }
  if (updateToken.value) patch.token = updateToken.value
  try {
    const r = await saveUpdateConfig(patch)
    hasToken.value = !!r.hasToken
    hasBasic.value = !!r.hasBasic
    updateToken.value = ''
    flashSaved()
    await loadSystemInfo()
  } catch {}
}

async function startUpdate() {
  try {
    const r = await applyUpdate()
    if (r.error) { toast(r.error, 'err'); return }
    pollTimer = setInterval(pollUpdate, 800)
    pollUpdate()
  } catch (err) {
    upState.value = { state: 'error', progress: 0, message: '无法开始更新', error: err.message }
  }
}

async function pollUpdate() {
  try {
    const s = await getUpdateStatus()
    upState.value = s
    if (s.state === 'done' || s.state === 'error') {
      if (pollTimer) clearInterval(pollTimer)
    }
  } catch (err) {
    upState.value = { state: 'error', progress: 0, message: '更新状态读取失败', error: err.message }
  }
}

async function doRollback() {
  if (!confirm(`确定回滚到 v${backups.value[0]}？应用将重启。`)) return
  try {
    const r = await rollbackUpdate(backups.value[0])
    toast(r.needManualRestart ? `已回滚到 v${r.version}，请手动重启` : `已回滚到 v${r.version}`)
    await loadSystemInfo()
  } catch (e) { toast(e.message, 'err') }
}

function flashSaved() {
  saved.value = true
  clearTimeout(savedTimer.value)
  savedTimer.value = setTimeout(() => { saved.value = false }, 2000)
}

let pollTimer = null
onMounted(async () => {
  await loadSystemInfo()
  try { updateInfo.value = await getUpdateInfo() } catch {}
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<template>
  <div>
    <div class="page-title">设置</div>
    <div class="page-sub">WorkBuddy 登录态、定时策略与结果推送</div>

    <div class="panel">
      <h3>🔑 WorkBuddy 登录态</h3>
      <div class="hint" style="margin-bottom:12px">
        NAS 上没有 WorkBuddy 客户端，需要从电脑端导入一次登录 token：<br />
        1. 电脑端登录 WorkBuddy 后，打开文件
        <code>%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info</code>
        （macOS：<code>~/Library/Application Support/CodeBuddyExtension/.../workbuddy-desktop.info</code>）；<br />
        2. 把整个文件内容粘贴到下面（或直接选择该文件），系统自动提取 <code>accessToken</code> 与 <code>domain</code>；也支持直接粘贴 token 本体（以 <code>eyJ</code> 开头）。<br />
        token 只保存在 NAS 本机配置目录，界面仅显示掩码。token 过期时重新导入一次即可。
      </div>
      <div class="field">
        <label>当前状态</label>
        <div>
          <span class="tag" :class="wb()?.tokenPresent ? 'ok' : 'err'">{{ wb()?.tokenPresent ? wb().tokenMasked : '未配置' }}</span>
          <span class="tag" v-if="wb()?.domain" style="margin-left:6px">{{ wb().domain }}</span>
        </div>
      </div>
      <div class="field">
        <label>粘贴登录态 JSON 或 token</label>
        <textarea v-model="rawToken" placeholder='{"auth":{"accessToken":"eyJ...","domain":"www.codebuddy.cn"}}'></textarea>
      </div>
      <div class="inline">
        <button class="btn primary" :disabled="importing" @click="doImport">{{ importing ? '导入中…' : '导入并保存' }}</button>
        <label class="btn" style="cursor:pointer">选择 .info 文件<input ref="fileInput" type="file" style="display:none" @change="onFile" /></label>
        <button class="btn danger" v-if="wb()?.tokenPresent" @click="clearToken">清除已保存 token</button>
      </div>
    </div>

    <div class="panel">
      <h3>⏰ 定时策略</h3>
      <div class="inline" style="margin-bottom:12px">
        <label class="switch">
          <input type="checkbox" v-model="schedulerForm.runOnStart" />
          <span class="track"></span>
        </label>
        <span style="font-size:13.5px">应用启动 / NAS 重启后，当天还没跑过的启用任务自动补跑一次（不怕漏签）</span>
      </div>
      <div class="hint">每个任务自己的每日执行时间点在「签到任务 → 编辑」里配置；调度器每 30 秒检查一次。</div>
    </div>

    <div class="panel">
      <h3>📤 结果推送（可选）</h3>
      <div class="hint" style="margin-bottom:12px">定时执行后把结果推送到你的消息渠道；仅推送结果文本，不含任何 token。</div>
      <div class="inline" style="margin-bottom:12px">
        <label class="switch"><input type="checkbox" v-model="notifyForm.enabled" /><span class="track"></span></label>
        <span style="font-size:13.5px">启用推送</span>
      </div>
      <div class="row">
        <div class="field">
          <label>渠道格式</label>
          <select v-model="notifyForm.format">
            <option value="generic">通用 JSON POST</option>
            <option value="dingtalk">钉钉机器人</option>
            <option value="feishu">飞书机器人</option>
            <option value="wecom">企业微信机器人</option>
            <option value="bark">Bark（iPhone）</option>
          </select>
        </div>
        <div class="field">
          <label>Webhook URL</label>
          <input type="text" v-model="notifyForm.url" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
        </div>
      </div>
      <div class="inline">
        <button class="btn primary" @click="saveNotify">保存设置</button>
        <button class="btn" :disabled="testing" @click="testPush">{{ testing ? '发送中…' : '发送测试推送' }}</button>
      </div>
    </div>

    <div class="panel">
      <h3>📁 数据与安全</h3>
      <div class="hint">
        配置目录：<code>{{ state.configDir }}</code>（settings.json 存任务与 token，logs.json 存日志）<br />
        安全边界：后端只调用 WorkBuddy 官方已验证的 3 个写接口（签到 / 旅行领取 / 旅行派遣），绝不调用兑换、抽奖等接口；成长计划与旅行状态均为只读查询；token 永不回传给前端。
      </div>
    </div>

    <!-- 版本与更新 -->
    <div class="update-card">
      <div class="update-head">
        <div class="update-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <div class="setting-label" style="flex:1">
          <div>
            <div class="label-main">版本更新 <span v-if="hasUpdate" class="ver-dot"></span></div>
            <div class="label-sub">
              当前 v{{ version }}
              <template v-if="checking"> · 检查中…</template>
              <template v-else-if="busy"> · {{ statusText }}</template>
              <template v-else-if="updateInfo?.hasUpdate"> · 发现新版本 v{{ updateInfo.latest }}</template>
              <template v-else-if="updateInfo?.error"> · 检查失败</template>
              <template v-else-if="updateInfo"> · 已是最新</template>
            </div>
          </div>
        </div>
        <div class="update-actions">
          <button class="btn primary up-main-btn" :disabled="checking || busy" @click="onMainAction">
            {{ mainButtonText }}
          </button>
        </div>
      </div>

      <div v-if="busy" class="up-bar">
        <div class="dl-track"><div class="dl-fill" :style="{ width: upState.progress + '%' }"></div></div>
        <span class="up-bar-txt">{{ upState.message }} · {{ upState.progress }}%</span>
      </div>
      <div v-else-if="upState.state === 'error'" class="up-bar-err">{{ upState.error || '更新失败' }}</div>

      <div class="update-foot">
        <span class="up-src-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          {{ sourceNote }}
        </span>
        <button class="link-btn" @click="showAdvanced = !showAdvanced">{{ showAdvanced ? '收起高级设置' : '高级设置' }}</button>
      </div>

      <div v-if="showAdvanced" class="update-advanced">
        <p class="auth-hint">
          从 GitHub 更新：把新版本在 Release 里上传 <code>app-&lt;版本&gt;.tgz</code>（上传 .fpk 也可以，会自动拆包），
          下面填你的仓库地址即可。改动 <b>https://github.com/&lt;用户名&gt;/&lt;仓库&gt;</b> 会自动换算成 releases/latest。
        </p>
        <div class="auth-row">
          <label class="auth-label">更新源</label>
          <input v-model="updateUrl" class="setting-input" autocomplete="off" placeholder="GitHub 仓库：https://github.com/373065025/ai-checkin/releases/latest" @change="saveUpdateUrl" />
        </div>
        <div class="auth-row">
          <label class="auth-label">备用源</label>
          <input v-model="updateAltUrl" class="setting-input" autocomplete="off" placeholder="主源失败时自动切换（可选）" @change="saveUpdateUrl" />
        </div>
        <div class="auth-row">
          <label class="auth-label">访问令牌</label>
          <input
            v-model="updateToken" type="password" class="setting-input" autocomplete="off"
            :placeholder="hasToken ? '已保存，留空表示不修改' : 'GitHub 令牌（可选，仅用于提升 API 限额 / 私有仓库）'" @change="saveAuth" />
        </div>
        <div class="auth-row">
          <label class="auth-label">用户名</label>
          <input v-model="updateUser" class="setting-input" autocomplete="off" placeholder="仅自建更新源（Basic 认证）时需要" @change="saveAuth" />
          <label class="auth-label">密码</label>
          <input v-model="updatePassword" type="password" class="setting-input" autocomplete="new-password" placeholder="对应密码" @change="saveAuth" />
        </div>
        <p class="auth-hint">
          <template v-if="hasToken">当前：访问令牌已配置</template>
          <template v-else-if="hasBasic">当前：Basic 认证已配置</template>
          <template v-else>GitHub 公开仓库无需令牌（未登录时 GitHub API 每小时限 60 次，够用；填令牌可提到 5000 次）</template>
        </p>
        <div class="adv-row">
          <label class="opt"><input type="checkbox" v-model="autoCheck" @change="saveAuto" /><span>自动检查更新（启动 + 每 6 小时）</span></label>
          <button v-if="backups.length" class="btn small" @click="doRollback">回滚到 v{{ backups[0] }}</button>
        </div>
      </div>
    </div>

    <!-- 更新弹窗 -->
    <transition name="fade">
      <div v-if="showUpdate" class="modal-mask" @click.self="canClose && (showUpdate = false)">
        <div class="modal-panel" style="max-width: 520px">
          <div class="modal-header">
            <h3 class="modal-title">更新到 v{{ updateInfo?.latest }}</h3>
            <button class="modal-close" v-if="canClose" @click="showUpdate = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="up-meta">
              <span class="chip">当前 v{{ version }}</span>
              <span class="chip chip-accent">新版本 v{{ updateInfo?.latest }}</span>
              <span v-if="updateInfo?.size" class="chip">{{ (updateInfo.size / 1048576).toFixed(2) }} MB</span>
              <span v-if="updateInfo?.publishedAt" class="chip">{{ updateInfo.publishedAt.slice(0, 10) }}</span>
            </div>
            <div v-if="updateInfo?.notes" class="up-notes">{{ updateInfo.notes }}</div>

            <div v-if="upState.state !== 'idle'" class="up-progress">
              <div class="dl-track"><div class="dl-fill" :style="{ width: upState.progress + '%' }"></div></div>
              <span class="up-bar-txt">{{ upState.message }} · {{ upState.progress }}%</span>
            </div>

            <p class="up-tip">
              更新会自动备份当前版本（可回滚），下载完成后应用将自动重启，页面约 5 秒后自动刷新。
            </p>
          </div>
          <div class="modal-foot">
            <span class="foot-note">
              更新源：{{ updateInfo?.sourceLabel || (updateInfo?.source === 'github' ? 'GitHub Releases' : '自定义') }}
              <template v-if="updateInfo?.fallback">（主源不可用，已自动切到备用源）</template>
            </span>
            <div class="foot-actions">
              <button class="btn small" v-if="canClose" @click="showUpdate = false">稍后</button>
              <button class="btn small primary" :disabled="!canClose" @click="startUpdate">
                {{ upState.state === 'idle' ? '下载并更新' : '更新中…' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>
