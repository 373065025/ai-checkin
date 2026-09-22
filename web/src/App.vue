<script setup>
import { ref, computed, onMounted, provide } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { VERSION, getState, getUpdateInfo, getAgreement, acceptAgreement } from './api/index.js'
import AgreementContent from './components/AgreementContent.vue'

const router = useRouter()
const route = useRoute()
const state = ref(null)
const toastMsg = ref(null)
const hasUpdate = ref(false)

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
  await loadAgreement()
  await refresh()
  checkNavUpdate()
})
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
