<script setup>
import { ref, inject, computed, onMounted, onUnmounted } from 'vue'
import { saveSettings, testNotify, getSystemInfo, getUpdateInfo, checkUpdate, getUpdateStatus, getUpdateBackups, applyUpdate, rollbackUpdate, saveUpdateConfig, fmtTime } from '../api/index.js'

const state = inject('state')
const refresh = inject('refresh')
const toast = inject('toast')
const openAgreement = inject('openAgreement')

const notifyForm = ref(JSON.parse(JSON.stringify(state.value.notify || {})))
const schedulerForm = ref(JSON.parse(JSON.stringify(state.value.scheduler || {})))
const testing = ref(false)

// 推送渠道的输入框文案随渠道变化（PushPlus 填的是 Token，不是 Webhook 地址）
const notifyFieldLabel = computed(() => (notifyForm.value.format === 'pushplus' ? 'PushPlus Token' : 'Webhook URL'))
const notifyPlaceholder = computed(() => {
  switch (notifyForm.value.format) {
    case 'dingtalk': return 'https://oapi.dingtalk.com/robot/send?access_token=...'
    case 'feishu': return 'https://open.feishu.cn/open-apis/bot/v2/hook/...'
    case 'wecom': return 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'
    case 'pushplus': return 'PushPlus token，或 https://www.pushplus.plus/send?token=你的token'
    case 'bark': return 'https://api.day.app/你的Key'
    default: return 'https://你的地址/webhook'
  }
})

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

// ===== 版本更新（更新源固定为项目仓库，不开放其他配置） =====
const version = ref('')
const updateInfo = ref(null)
const checking = ref(false)
const showUpdate = ref(false)
const backups = ref([])
const updateUrl = ref('')
const autoCheck = ref(true)
const upState = ref({ state: 'idle', progress: 0, message: '', error: '' })
const saved = ref(false)
const savedTimer = ref(null)

const UPDATE_BUSY = ['downloading', 'verifying', 'installing', 'restarting']
const hasUpdate = computed(() => !!updateInfo.value?.hasUpdate)
const busy = computed(() => UPDATE_BUSY.includes(upState.value.state))
const canClose = computed(() => !UPDATE_BUSY.includes(upState.value.state))

const repoMatch = computed(() => (updateUrl.value || '').match(/github\.com\/([^/]+)\/([^/?#]+)/i))
const repoLabel = computed(() => (repoMatch.value ? `GitHub · ${repoMatch.value[1]}/${repoMatch.value[2]}` : '未配置更新源'))
const repoHref = computed(() => (repoMatch.value ? `https://github.com/${repoMatch.value[1]}/${repoMatch.value[2]}` : ''))

const mainButtonText = computed(() => {
  if (checking.value) return '检查中…'
  if (busy.value) return '更新中…'
  if (hasUpdate.value) return `更新到 v${updateInfo.value.latest}`
  return '检查更新'
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
    autoCheck.value = info.autoCheckUpdate !== false
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

async function saveAuto() {
  try { await saveUpdateConfig({ autoCheck: autoCheck.value }); flashSaved() } catch {}
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
    <div class="page-sub">程序自身的运行策略与版本更新</div>

    <div class="panel">
      <h3>定时策略</h3>
      <div class="inline" style="margin-bottom:12px">
        <label class="switch">
          <input type="checkbox" v-model="schedulerForm.runOnStart" />
          <span class="track"></span>
        </label>
        <span style="font-size:13.5px">应用启动 / NAS 重启后，当天还没跑过的启用任务自动补跑一次（不怕漏签）</span>
      </div>
      <div class="hint">每个任务自己的每日执行时间与登录态，都在「签到任务 → 编辑」里单独配置；调度器每 30 秒检查一次。</div>
    </div>

    <div class="panel">
      <h3>结果推送（可选）</h3>
      <div class="hint" style="margin-bottom:12px">定时执行后把结果推送到你的消息渠道；仅推送结果文本，不含任何凭据。</div>
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
            <option value="pushplus">PushPlus（ 微信公众号 ）</option>
            <option value="bark">Bark（iPhone）</option>
          </select>
        </div>
        <div class="field">
          <label>{{ notifyFieldLabel }}</label>
          <input type="text" v-model="notifyForm.url" :placeholder="notifyPlaceholder" />
        </div>
      </div>
      <div v-if="notifyForm.format === 'pushplus'" class="hint" style="margin-bottom:12px">
        在 <code>pushplus.plus</code> 用微信登录后，「一对一推送」页可直接复制 token，粘贴到上面即可；
        也支持直接粘贴官方 <code>send</code> 地址。若使用群组推送，可在地址里附带 <code>&amp;topic=群组编码</code>，
        需要 HTML/Markdown 排版可加 <code>&amp;template=html</code>。
      </div>
      <div class="inline">
        <button class="btn primary" @click="saveNotify">保存设置</button>
        <button class="btn" :disabled="testing" @click="testPush">{{ testing ? '发送中…' : '发送测试推送' }}</button>
      </div>
    </div>

    <div class="panel">
      <h3>数据与安全</h3>
      <div class="hint">
        配置目录：<code>{{ state.configDir }}</code>（settings.json 存任务与凭据，logs.json 存日志）<br />
        所有凭据只保存在 NAS 本机配置目录，Web 界面仅显示掩码、日志中永不出现；后端只调用各平台已验证的写入接口，不做兑换、抽奖等操作。
      </div>
    </div>

    <div class="panel">
      <h3>免责声明与用户协议</h3>
      <div class="hint" style="margin-bottom:12px">
        首次安装后需阅读并同意《用户协议与免责声明》才能使用；未同意时后端不会执行任何签到或自动化操作。<br />
        协议状态：<span class="tag" :class="state.agreementAccepted ? 'ok' : 'err'">{{ state.agreementAccepted ? '已同意' : '未同意' }}</span>
        <template v-if="state.agreement?.acceptedRevision"> · 已同意条款版本 {{ state.agreement.acceptedRevision }}</template>
        <template v-if="state.agreement?.acceptedAt"> · 同意于 {{ fmtTime(state.agreement.acceptedAt) }}</template>
      </div>
      <button class="btn" @click="openAgreement()">查看协议全文</button>
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
          更新源：<template v-if="repoHref"><a :href="repoHref" target="_blank" rel="noreferrer">{{ repoLabel }}</a></template><template v-else>{{ repoLabel }}</template>
        </span>
        <div class="foot-actions" style="align-items:center;gap:14px">
          <label class="opt">
            <span class="switch"><input type="checkbox" v-model="autoCheck" @change="saveAuto" /><span class="track"></span></span>
            自动检查更新
          </label>
          <span v-if="saved" class="hint" style="margin:0">已保存</span>
          <button v-if="backups.length" class="link-btn" @click="doRollback">回滚到 v{{ backups[0] }}</button>
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
            <span class="foot-note">更新源：{{ repoLabel }}</span>
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
