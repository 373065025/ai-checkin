<script setup>
import { ref, onMounted, provide } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { VERSION, getState, getUpdateInfo } from './api/index.js'

const router = useRouter()
const route = useRoute()
const state = ref(null)
const toastMsg = ref(null)
const hasUpdate = ref(false)

provide('state', state)
provide('refresh', refresh)
provide('toast', showToast)

let toastTimer = null
function showToast(text, kind = 'ok') {
  toastMsg.value = { text, kind }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = null), 4000)
}

async function refresh() {
  try { state.value = await getState() } catch { /* ignore */ }
}

async function checkNavUpdate() {
  try { const r = await getUpdateInfo(); hasUpdate.value = !!r?.hasUpdate } catch {}
}

onMounted(() => { refresh(); checkNavUpdate() })
</script>

<template>
  <div class="sidebar">
    <div class="logo">📌 AI签到管家<small>{{ VERSION }} · 飞牛 fnOS</small></div>
    <router-link class="nav-item" :class="{ active: route.path === '/' }" to="/"><span class="icon">🏠</span>签到中心</router-link>
    <router-link class="nav-item" :class="{ active: route.path === '/tasks' }" to="/tasks"><span class="icon">✅</span>平台任务</router-link>
    <router-link class="nav-item" :class="{ active: route.path === '/logs' }" to="/logs"><span class="icon">📋</span>执行日志</router-link>
    <router-link class="nav-item" :class="{ active: route.path === '/settings' }" to="/settings"><span class="icon">⚙️</span>设置<span v-if="hasUpdate" class="nav-dot"></span></router-link>
    <div class="sidebar-footer">
      <div>零依赖 Node 后端</div>
      <div>数据目录见「设置」页</div>
    </div>
  </div>
  <div class="main">
    <router-view v-if="state" />
    <div v-else class="hint">加载中…</div>
    <div v-if="toastMsg" class="toast" :class="toastMsg.kind">{{ toastMsg.text }}</div>
  </div>
</template>
