<script setup>
import { inject } from 'vue'
import { fmtTime, clearLogs } from '../api/index.js'

const state = inject('state')
const refresh = inject('refresh')
const toast = inject('toast')

const triggerText = { manual: '手动', schedule: '定时', startup: '启动补跑' }

// 定时/补跑失败后的自动重试会记录成 schedule-retry1 这类标记
function triggerLabel(t) {
  if (triggerText[t]) return triggerText[t]
  const m = /^(schedule|startup|manual)-retry(\d+)$/.exec(String(t || ''))
  if (m) return `${triggerText[m[1]] || m[1]}·重试${m[2]}`
  return t
}

async function clear() {
  if (!confirm('确定清空全部日志？')) return
  await clearLogs()
  await refresh()
  toast('日志已清空')
}
</script>

<template>
  <div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="page-title">执行日志</div>
        <div class="page-sub">最多保留 600 条，保存在 NAS 配置目录 logs.json</div>
      </div>
      <button class="btn" @click="clear">清空日志</button>
    </div>

    <div class="panel">
      <table v-if="state.logs.length">
        <thead>
          <tr><th style="width:150px">时间</th><th style="width:170px">任务</th><th style="width:70px">方式</th><th>结果</th></tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in state.logs" :key="i">
            <td style="color:var(--muted);font-size:12px">{{ l.time || fmtTime(l.ts) }}</td>
            <td>{{ l.providerName }}<div style="font-size:11px;color:var(--muted)">{{ (l.durationMs / 1000).toFixed(1) }}s</div></td>
            <td><span class="tag">{{ triggerLabel(l.trigger) }}</span></td>
            <td>
              <span class="tag" :class="l.ok ? 'ok' : 'err'">{{ l.ok ? '成功' : '失败' }}</span>
              <div style="margin-top:4px">{{ l.message }}</div>
              <div class="steps" v-if="l.steps?.length">
                <div v-for="(s, j) in l.steps" :key="j"><b>{{ s.action }}</b> — {{ s.message }}</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="hint">暂无日志，运行一次任务试试。</div>
    </div>
  </div>
</template>
