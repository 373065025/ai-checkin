<script setup>
import { ref, inject, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { runAll, runProvider, getProviderLive, todayStr, fmtTime } from '../api/index.js'

const state = inject('state')
const refresh = inject('refresh')
const toast = inject('toast')
const router = useRouter()

const runningAll = ref(false)
const runningId = ref(null)
const liveMap = ref(new Map())

const today = todayStr()

const enabledProviders = computed(() => state.value?.providers?.filter((p) => p.enabled) || [])
const totalEnabled = computed(() => enabledProviders.value.length)

const signedTodayCount = computed(() => {
  return enabledProviders.value.filter((p) => isSignedToday(p)).length
})

function platformMeta(p) {
  if (p.type === 'workbuddy') {
    return { icon: '🐾', color: '#22c7a9', alias: 'WorkBuddy' }
  }
  const n = p.name.toLowerCase()
  if (n.includes('千帆') || n.includes('百度')) return { icon: '🌊', color: '#2468f2', alias: '百度千帆' }
  if (n.includes('minimax') || n.includes('mini')) return { icon: '🤖', color: '#6b4cff', alias: 'MiniMax' }
  if (n.includes('tree')) return { icon: '🌳', color: '#2ecc71', alias: 'Tree Work' }
  if (n.includes('wps')) return { icon: '📄', color: '#ff4d4d', alias: 'WPS' }
  if (n.includes('link')) return { icon: '🔗', color: '#00d2ff', alias: 'Link AI' }
  return { icon: '⚙️', color: '#5b8cff', alias: '自定义' }
}

function liveOf(p) {
  return liveMap.value.get(p.id) || null
}

function isSignedToday(p) {
  if (!p.enabled) return false
  if (p.type === 'workbuddy') {
    if (!p.tokenPresent) return false
    return !!liveOf(p)?.status?.today_checked_in
  }
  return p.lastRun?.day === today && p.lastRun?.ok
}

function cardStatus(p) {
  if (!p.enabled) return { text: '已停用', cls: 'warn', dot: 'err' }
  if (p.type === 'workbuddy' && !p.tokenPresent) return { text: '未配置 token', cls: 'err', dot: 'err' }
  if (isSignedToday(p)) return { text: '今日已签到', cls: 'ok', dot: 'done' }
  return { text: '今日未签到', cls: 'warn', dot: '' }
}

function bigValue(p) {
  if (p.type === 'workbuddy') {
    const st = liveOf(p)?.status
    if (!st) return { text: '—', unit: '' }
    if (st.today_checked_in) return { text: `+${st.today_credit ?? st.daily_credit ?? 0}`, unit: '分' }
    return { text: st.total_credits ?? '—', unit: '分' }
  }
  if (p.lastRun?.ok) return { text: '已签', unit: '' }
  if (p.lastRun?.day === today && !p.lastRun?.ok) return { text: '失败', unit: '' }
  return { text: '—', unit: '' }
}

function details(p) {
  const out = []
  if (p.type === 'workbuddy') {
    const st = liveOf(p)?.status
    if (st) {
      if (st.today_checked_in) {
        out.push(`累计积分 <b>${st.total_credits ?? '—'}</b>`)
        out.push(`连续签到 <b>${st.streak_days ?? '—'}</b> 天`)
      } else {
        out.push(`每日奖励 <b>${st.daily_credit ?? '—'}</b> 分`)
        out.push(`累计积分 <b>${st.total_credits ?? '—'}</b>`)
        out.push(`连续 <b>${st.streak_days ?? '—'}</b> 天`)
      }
      // 本月打卡天数
      out.push(`本月已签 <b>${st.checkin_dates_this_month?.length ?? 0}</b> 天`)
    }
    const tr = liveOf(p)?.travel?.status
    if (tr) {
      const map = { idle: '空闲', traveling: '旅行中', arrived: '待领取' }
      out.push(`旅行 <b>${map[tr.state] ?? tr.state}</b>`)
    }
  } else {
    const host = (p.http?.url || '').replace(/^https?:\/\//, '').split('/')[0]
    out.push(`接口 <b>${host || '未配置'}</b>`)
    if (p.lastRun) out.push(`上次结果 <b>${p.lastRun.ok ? '成功' : '失败'}</b>`)
  }
  return out
}

async function loadLives() {
  const ps = enabledProviders.value.filter((p) => p.type === 'workbuddy' && p.tokenPresent)
  await Promise.all(ps.map(async (p) => {
    try {
      const r = await getProviderLive(p.id)
      liveMap.value.set(p.id, r)
    } catch { /* ignore */ }
  }))
}

onMounted(async () => { await refresh(); await loadLives() })

async function doRunAll() {
  runningAll.value = true
  try {
    const r = await runAll()
    const fail = r.results.filter((x) => !x.ok).length
    toast(fail ? `一键签到完成，${fail} 个失败` : `全部 ${r.results.length} 个平台签到成功 ✅`, fail ? 'err' : 'ok')
    await refresh()
    await loadLives()
  } catch (e) { toast(e.message, 'err') }
  runningAll.value = false
}

async function runOne(p) {
  runningId.value = p.id
  try {
    const r = await runProvider(p.id)
    const res = r.results?.[0]
    toast(`${p.name}：${res?.message || '完成'}`, res?.ok ? 'ok' : 'err')
    await refresh()
    await loadLives()
  } catch (e) { toast(e.message, 'err') }
  runningId.value = null
}

function goTasks() { router.push('/tasks') }
</script>

<template>
  <div>
    <!-- 顶部 -->
    <div class="checkin-header">
      <div class="left">
        <div class="page-title">签到中心</div>
        <div class="page-sub">多个平台签到一目了然，一键完成</div>
        <div class="progress-summary">
          <span>今日签到进度</span>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: totalEnabled ? (signedTodayCount / totalEnabled * 100) + '%' : '0%' }"></div>
          </div>
          <span><b>{{ signedTodayCount }}</b> / {{ totalEnabled }}</span>
        </div>
      </div>
      <div class="right">
        <button class="btn" @click="refresh(); loadLives()">🔄 刷新</button>
        <button class="btn primary" :disabled="runningAll" @click="doRunAll">
          {{ runningAll ? '签到中…' : '▶ 一键签到' }}
        </button>
      </div>
    </div>

    <!-- 卡片墙 -->
    <div class="checkin-grid">
      <div v-for="p in state.providers" :key="p.id" class="checkin-card" :class="{ disabled: !p.enabled }"
        :style="{ borderTopColor: platformMeta(p).color }">
        <div class="card-head">
          <div class="brand-icon" :style="{ borderColor: platformMeta(p).color + '40' }">{{ platformMeta(p).icon }}</div>
          <div class="card-title">{{ p.name }}</div>
          <div class="status-dot" :class="cardStatus(p).dot"></div>
          <span class="tag" :class="cardStatus(p).cls">{{ cardStatus(p).text }}</span>
        </div>
        <div class="card-body">
          <div class="big">{{ bigValue(p).text }}<small>{{ bigValue(p).unit }}</small></div>
          <div class="detail" v-html="details(p).join(' · ')"></div>
        </div>
        <div class="card-foot">
          <span>上次执行：{{ p.lastRun?.time || fmtTime(p.lastRun?.ts) || '从未' }}</span>
          <button v-if="p.type === 'workbuddy' && !p.tokenPresent" class="btn small" @click="goTasks">去配置</button>
          <button v-else-if="!p.enabled" class="btn small" @click="goTasks">去启用</button>
          <button v-else-if="isSignedToday(p)" class="btn small done" disabled>今日已签到</button>
          <button v-else class="btn small primary" :disabled="runningId === p.id" @click="runOne(p)">
            {{ runningId === p.id ? '执行中…' : '立即签到' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 未配置 WorkBuddy 提示 -->
    <div class="panel" style="margin-top:18px" v-if="!state.providers.find((p)=>p.type==='workbuddy')?.tokenPresent">
      <h3>⚠️ WorkBuddy 尚未配置</h3>
      <div class="hint">
        请到 <b>设置</b> 页导入登录态；NAS 上没有 WorkBuddy 客户端，需要把电脑端的
        <code>workbuddy-desktop.info</code> 文件内容粘贴进去。
      </div>
    </div>
  </div>
</template>
