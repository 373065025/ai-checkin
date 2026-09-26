<script setup>
import { ref, computed, onMounted, onUnmounted, provide } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { VERSION, getState, getUpdateInfo, getAgreement, acceptAgreement, authStatus, authLogin, setAdminToken, onUnauthorized } from './api/index.js'
import AgreementContent from './components/AgreementContent.vue'

const router = useRouter()
const route = useRoute()
const state = ref(null)
const toastMsg = ref(null)
const hasUpdate = ref(false)

// ===== 管理员密码登录 =====
// 后端开启了管理员密码（设置页可配）时，未登录会先弹出这里；没设密码则永远不会出现
const auth = ref(null)          // /api/auth/status 的结果
const loginPwd = ref('')
const loginBusy = ref(false)
const loginErr = ref('')
const lockLeft = ref(0)
let lockTimer = null

const needLogin = computed(() => !!auth.value?.enabled && !auth.value?.authed)

function startLockCountdown(sec) {
  lockLeft.value = sec
  clearInterval(lockTimer)
  if (sec <= 0) return
  lockTimer = setInterval(() => {
    lockLeft.value -= 1
    if (lockLeft.value <= 0) {
      clearInterval(lockTimer)
      loadAuth().catch(() => {})
    }
  }, 1000)
}

async function loadAuth() {
  try {
    auth.value = await authStatus()
    if (auth.value.locked) startLockCountdown(auth.value.lockSeconds)
  } catch { /* 拿不到就不拦 */ }
}

async function doLogin() {
  if (lockLeft.value > 0) return
  loginBusy.value = true
  loginErr.value = ''
  try {
    const r = await authLogin(loginPwd.value)
    if (r.token) setAdminToken(r.token)
    loginPwd.value = ''
    loginErr.value = ''
    await loadAuth()
    await refresh()
    showToast('已登录')
  } catch (e) {
    loginErr.value = e.message
    try { await loadAuth() } catch {}
    if (lockLeft.value > 0) loginErr.value = `错误次数过多，已锁定 ${Math.ceil(lockLeft.value / 60)} 分钟`
  }
  loginBusy.value = false
}

// ===== 用户协议与免责声明 =====
const agreement = ref(null)      // 条款内容
const agreed = ref(false)        // 本次是否已勾选
const declined = ref(false)      // 是否点了「不同意」
const viewerOpen = ref(false)    // 设置页主动查看
const accepting = ref(false)

const forced = computed(() => !!agreement.value && !agreement.value.accepted)
const showViewer = computed(() => viewerOpen.value && !forced.value)

async function loadAgreement() {
  try { agreement.value = await getAgreement() } catch { /* 拿不到就不拦 */ }
}

async function doAccept() {
  accepting.value = true
  try {
    const r = await acceptAgreement()
    agreement.value.accepted = true
    agreed.value = false
    declined.value = false
    viewerOpen.value = false
    await refresh()
    showToast(r?.revision ? `已同意《用户协议与免责声明》（条款版本 ${r.revision}）` : '已同意')
  } catch (e) {
    showToast(e.message, 'err')
  }
  accepting.value = false
}

function openAgreement() {
  agreed.value = false
  viewerOpen.value = true
}

provide('state', state)
provide('refresh', refresh)
provide('toast', showToast)
provide('openAgreement', openAgreement)

let toastTimer = null
function showToast(text, kind = 'ok') {
  toastMsg.value = { text, kind }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = null), 4000)
}

async function refresh() {
  try {
    state.value = await getState()
    if (agreement.value && typeof state.value?.agreementAccepted === 'boolean') {
      agreement.value.accepted = state.value.agreementAccepted
    }
  } catch { /* ignore */ }
}

async function checkNavUpdate() {
  try { const r = await getUpdateInfo(); hasUpdate.value = !!r?.hasUpdate } catch {}
}

onMounted(async () => {
  // 401 只负责拉起登录界面；错误文案留给「真的输错了」那次响应，避免一进页面就见红字
  onUnauthorized((info) => {
    if (info?.locked) {
      loginErr.value = info.message || ''
      startLockCountdown(info.lockSeconds || 0)
    }
    loadAuth().catch(() => {})
  })
  await loadAgreement()
  await loadAuth()
  if (!needLogin.value) await refresh()
  checkNavUpdate()
})

onUnmounted(() => clearInterval(lockTimer))
</script>

<template>
  <!-- 未同意协议：全屏拦截，除「同意」外无法进入应用 -->
  <div v-if="forced && !declined" class="consent">
    <div class="consent-panel">
      <header class="consent-head">
        <h2>{{ agreement.title }}</h2>
        <p class="consent-sub">AI签到管家 {{ VERSION }} · 首次使用前请完整阅读</p>
      </header>

      <div class="consent-body">
        <AgreementContent :doc="agreement" />
      </div>

      <footer class="consent-foot">
        <label class="consent-check" :class="{ on: agreed }">
          <input type="checkbox" v-model="agreed" />
          <span>我已完整阅读并理解上述全部条款，自愿接受并承担相应风险</span>
        </label>
        <div class="consent-actions">
          <button class="btn" @click="declined = true">不同意</button>
          <button class="btn primary" :disabled="!agreed || accepting" @click="doAccept">
            {{ accepting ? '处理中…' : '同意并开始使用' }}
          </button>
        </div>
      </footer>
    </div>
  </div>

  <!-- 拒绝：拦住并给出卸载指引 -->
  <div v-else-if="forced && declined" class="consent">
    <div class="consent-panel decline">
      <header class="consent-head">
        <h2>已拒绝用户协议</h2>
        <p class="consent-sub">未同意条款时无法使用本软件</p>
      </header>
      <div class="consent-body">
        <p class="hint" style="font-size:13.5px;line-height:1.9">
          您已选择不同意《用户协议与免责声明》，本软件将保持不可用状态（不会执行任何签到或自动化操作）。<br />
          如需继续使用，请返回上一页重新阅读并同意；如果确定不使用，请在飞牛「应用中心」中卸载本应用，
          并自行清理 NAS 上残留的配置目录。
        </p>
      </div>
      <footer class="consent-foot">
        <div class="consent-actions">
          <button class="btn primary" @click="declined = false">返回重新阅读</button>
        </div>
      </footer>
    </div>
  </div>

  <!-- 开启了管理员密码且未登录：全屏登录（协议页之后、进入应用之前） -->
  <div v-else-if="needLogin" class="consent">
    <div class="consent-panel decline">
      <header class="consent-head">
        <h2>管理员验证</h2>
        <p class="consent-sub">本应用已开启管理员密码保护</p>
      </header>
      <div class="consent-body" style="display:flex;flex-direction:column;justify-content:center">
        <div class="field" style="max-width:340px;margin:0 auto;width:100%">
          <input
            v-model="loginPwd"
            type="password"
            placeholder="管理员密码"
            :disabled="lockLeft > 0 || loginBusy"
            @keyup.enter="doLogin"
          />
        </div>
        <p v-if="loginErr" class="hint" style="color:#ff453a;text-align:center;margin:12px 0 0">{{ loginErr }}</p>
        <p v-if="lockLeft > 0" class="hint" style="text-align:center;margin:12px 0 0">
          已锁定，剩余 {{ Math.floor(lockLeft / 60) }} 分 {{ lockLeft % 60 }} 秒
        </p>
      </div>
      <footer class="consent-foot">
        <div class="consent-actions">
          <button class="btn primary" :disabled="!loginPwd || loginBusy || lockLeft > 0" @click="doLogin">
            {{ loginBusy ? '验证中…' : '进入' }}
          </button>
        </div>
        <p class="hint" style="margin:10px 0 0;text-align:center">
          连续输错 10 次将锁定来源 IP 一小时。忘记密码：编辑配置目录下 settings.json，
          删除其中的 <code>admin</code> 字段后重启应用即可重置。
        </p>
      </footer>
    </div>
  </div>

  <!-- 已同意：正常界面 -->
  <template v-else>
    <div class="sidebar">
      <div class="logo">📌 AI签到管家<small>{{ VERSION }} · 飞牛 fnOS</small></div>
      <router-link class="nav-item" :class="{ active: route.path === '/' }" to="/"><span class="icon">🏠</span>签到中心</router-link>
      <router-link class="nav-item" :class="{ active: route.path === '/tasks' }" to="/tasks"><span class="icon">✅</span>签到任务</router-link>
      <router-link class="nav-item" :class="{ active: route.path === '/logs' }" to="/logs"><span class="icon">📋</span>执行日志</router-link>
      <router-link class="nav-item" :class="{ active: route.path === '/settings' }" to="/settings"><span class="icon">⚙️</span>设置<span v-if="hasUpdate" class="nav-dot"></span></router-link>
      <div class="sidebar-footer">
        <div>零依赖 Node 后端 · 数据全在本机</div>
        <div>config 目录见「设置」页</div>
      </div>
    </div>
    <div class="main">
      <router-view v-if="state" />
      <div v-else class="hint">加载中…</div>
      <div v-if="toastMsg" class="toast" :class="toastMsg.kind">{{ toastMsg.text }}</div>
    </div>
  </template>

  <!-- 设置页主动查看协议（只读，可关闭） -->
  <transition name="fade">
    <div v-if="showViewer" class="modal-mask" @click.self="viewerOpen = false">
      <div class="modal-panel" style="max-width: 680px">
        <div class="modal-header">
          <h3 class="modal-title">{{ agreement?.title }}</h3>
          <button class="modal-close" @click="viewerOpen = false">✕</button>
        </div>
        <div class="modal-body">
          <AgreementContent :doc="agreement" />
        </div>
        <div class="modal-foot">
          <span class="foot-note">您已同意本协议（条款版本 {{ agreement?.revision }}）</span>
          <div class="foot-actions">
            <button class="btn small" @click="viewerOpen = false">关闭</button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>
