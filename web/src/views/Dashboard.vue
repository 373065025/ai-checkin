<script setup>
import { ref, inject, onMounted, computed, watch, onUnmounted } from 'vue'
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

// 是否有任务正在后台拉取最新数据（用于显示「更新中」而不是让人干等）
const syncing = computed(() => enabledProviders.value.some((p) => liveOf(p)?.refreshing))

function platformMeta(p) {
  if (p.type === 'workbuddy') {
    return { icon: '🐾', color: '#30d158', alias: 'WorkBuddy' }
  }
  const n = p.name.toLowerCase()
  if (n.includes('千帆') || n.includes('百度')) return { icon: '🌊', color: '#0a84ff', alias: '百度千帆' }
  if (n.includes('minimax') || n.includes('mini')) return { icon: '🤖', color: '#bf5af2', alias: 'MiniMax' }
  if (n.includes('tree')) return { icon: '🌳', color: '#30d158', alias: 'Tree Work' }
  if (n.includes('wps')) return { icon: '📄', color: '#ff453a', alias: 'WPS' }
  if (n.includes('link')) return { icon: '🔗', color: '#64d2ff', alias: 'Link AI' }
  return { icon: '⚙️', color: '#8e8e93', alias: '自定义' }
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
      // 本月 / 本周打卡天数（后端会把上游的 checkin_dates 归一成本月数组）
      const monthDays = st.checkin_dates_this_month?.length
      if (monthDays != null) out.push(`本月 <b>${monthDays}</b> 天`)
      if (st.week_checkin_days != null) out.push(`本周 <b>${st.week_checkin_days}</b> 天`)
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

// ===== 加载策略：先渲染已知状态，再后台拉最新 =====
//
// 一次实时快照要打 7 个远端请求（并行也要 1.5s 左右）。为了不再让页面卡着转圈：
//   1) 后端 /api/state 会带上每个任务「上次已知的快照」→ 首屏立刻渲染（含「今日已签到」）
//   2) 后端 /api/providers/live 有缓存就直接返回，过期则先返回旧值 + 后台刷新
//   3) 后台刷新完成后前端自动补拉一次，全程不需要用户等待或手动点刷新
const stampOf = (o) => (o && (o.ts || o.at || 0)) || 0
let settleTimer = null
let settleRounds = 0

/** 用 state 里带回的上次快照填充 liveMap（只在更新时间更新时才覆盖） */
function seedFromState() {
  const ps = state.value?.providers || []
  const next = new Map(liveMap.value)
  let changed = false
  for (const p of ps) {
    if (!p.lastLive) continue
    if (stampOf(p.lastLive) > stampOf(next.get(p.id))) {
      next.set(p.id, p.lastLive)
      changed = true
    }
  }
  if (changed) liveMap.value = next
}

async function loadLives({ force = false } = {}) {
  const ps = enabledProviders.value.filter((p) => p.type === 'workbuddy' && p.tokenPresent)
  if (!ps.length) return
  const out = await Promise.all(ps.map(async (p) => {
    try { return [p.id, await getProviderLive(p.id, force)] } catch { return null }
  }))
  const next = new Map(liveMap.value)
  let pending = false
  for (const r of out) {
    if (!r) continue
    const [id, data] = r
    if (stampOf(data) >= stampOf(next.get(id))) next.set(id, data)
    if (data?.refreshing) pending = true
  }
  liveMap.value = next

  // 服务端还在后台拉 → 稍后自动补拉，最多 3 轮（避免远端异常时无限轮询）
  if (pending && !force && settleRounds < 3) {
    settleRounds++
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => { loadLives() }, 1800)
  }
}

function manualRefresh() {
  settleRounds = 0
  loadLives({ force: true })
}

watch(state, () => seedFromState())

onMounted(async () => {
  seedFromState()      // 首屏：用上次已知状态立即渲染，零等待
  await refresh()      // 拉本地 state（很快，不发远端请求）
  seedFromState()
  loadLives()          // 后台静默刷新
})

onUnmounted(() => clearTimeout(settleTimer))

async function doRunAll() {
  runningAll.value = true
  try {
    const r = await runAll()
    const fail = r.results.filter((x) => !x.ok).length
    toast(fail ? `一键签到完成，${fail} 个失败` : `全部 ${r.results.length} 个平台签到成功 ✅`, fail ? 'err' : 'ok')
    await refresh()
    seedFromState()
    settleRounds = 0
    loadLives({ force: true })
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
    seedFromState()
    settleRounds = 0
    loadLives({ force: true })
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
        <span v-if="syncing" class="sync-hint">更新中…</span>
        <button class="btn" @click="manualRefresh">刷新</button>
        <button class="btn primary" :disabled="runningAll" @click="doRunAll">
          {{ runningAll ? '签到中…' : '一键签到' }}
        </button>
      </div>
    </div>

    <!-- 卡片墙 -->
    <div class="checkin-grid">
      <div v-for="p in state.providers" :key="p.id" class="checkin-card" :class="{ disabled: !p.enabled }"
        :style="{ '--brand': platformMeta(p).color }">
        <div class="card-head">
          <div class="brand-icon">{{ platformMeta(p).icon }}</div>
          <div class="card-title">{{ p.name }}</div>
          <div class="status-dot" :class="cardStatus(p).dot"></div>
          <span class="tag" :class="cardStatus(p).cls">{{ cardStatus(p).text }}</span>
        </div>
        <div class="card-body">
          <div class="big" :class="{ placeholder: bigValue(p).text === '—' }">{{ bigValue(p).text }}<small>{{ bigValue(p).unit }}</small></div>
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
      <h3>WorkBuddy 尚未配置登录态</h3>
      <div class="hint" style="margin-bottom:12px">
        到「签到任务」页点开 WorkBuddy 任务的<b>编辑</b>，在<b>登录态</b>里粘贴一次即可（每个任务独立配置）。NAS 上没有 WorkBuddy
        客户端，需要把电脑端 <code>workbuddy-desktop.info</code> 的文件内容复制过来。
      </div>
      <button class="btn primary" @click="goTasks">去配置</button>
    </div>
  </div>
</template>
