<script setup>
import { ref, inject } from 'vue'
import { saveProvider, deleteProvider, toggleProvider, runProvider, parseCurl } from '../api/index.js'

const state = inject('state')
const refresh = inject('refresh')
const toast = inject('toast')

const editing = ref(null)
const runningId = ref(null)
const curlText = ref('')
const showCurl = ref(false)

function newHttp() {
  return {
    type: 'http',
    name: '新签到任务',
    enabled: true,
    schedule: { times: ['09:00'] },
    http: { url: '', method: 'GET', headersText: '', body: '', successRule: { kind: 'status', expr: '200', value: '' } },
  }
}

function editProvider(p) {
  const e = JSON.parse(JSON.stringify(p))
  if (e.type === 'http') {
    e.http = e.http || { url: '', method: 'GET', headers: {}, body: '', successRule: { kind: 'status', expr: '200' } }
    e.http.headersText = Object.entries(e.http.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
    e.http.successRule = e.http.successRule || { kind: 'status', expr: '200', value: '' }
  }
  if (!e.schedule) e.schedule = { times: ['09:00'] }
  editing.value = e
  curlText.value = ''
  showCurl.value = false
}

function addTime() {
  editing.value.schedule.times.push('21:00')
}
function rmTime(i) {
  if (editing.value.schedule.times.length > 1) editing.value.schedule.times.splice(i, 1)
}

const TEMPLATES = [
  { key: 'baidu_qianfan', name: '百度千帆每日签到', icon: '🌊', color: '#2468f2',
    desc: '百度智能云千帆平台每日签到领算力/积分',
    method: 'GET', url: 'https://qianfan.baidubce.com/v2/component/check_in', success: { kind: 'json', expr: 'code', value: '0' },
    curlHint: "curl 'https://qianfan.baidubce.com/v2/component/check_in' -H 'authorization: Bearer 你的token' -H 'content-type: application/json' --data '{}'" },
  { key: 'minimax', name: 'MiniMax Code 每日签到', icon: '🤖', color: '#6b4cff',
    desc: 'MiniMax 开放平台每日签到',
    method: 'POST', url: 'https://www.minimaxi.com/portal/api/user/daily/check_in', success: { kind: 'json', expr: 'code', value: '0' },
    curlHint: "curl 'https://www.minimaxi.com/portal/api/user/daily/check_in' -H 'authorization: 你的token' -H 'content-type: application/json' --data '{}'" },
  { key: 'wps', name: 'WPS 灵犀每日签到', icon: '📄', color: '#ff4d4d',
    desc: 'WPS 灵犀 AI 每日签到',
    method: 'POST', url: 'https://ai.wps.cn/api/v1/activity/sign_in', success: { kind: 'json', expr: 'code', value: '0' },
    curlHint: "curl 'https://ai.wps.cn/api/v1/activity/sign_in' -H 'Cookie: 你的Cookie' -H 'content-type: application/json' --data '{}'" },
  { key: 'linkai', name: 'Link AI 每日签到', icon: '🔗', color: '#00d2ff',
    desc: 'Link AI 平台每日签到',
    method: 'POST', url: 'https://www.link-ai.chat/api/user/sign_in', success: { kind: 'json', expr: 'code', value: '0' },
    curlHint: "curl 'https://www.link-ai.chat/api/user/sign_in' -H 'authorization: 你的token' -H 'content-type: application/json' --data '{}'" },
  { key: 'treework', name: 'Tree Work 每日签到', icon: '🌳', color: '#2ecc71',
    desc: 'Tree Work 每日签到',
    method: 'POST', url: 'https://app.treework.cn/api/daily_check_in', success: { kind: 'json', expr: 'code', value: '0' },
    curlHint: "curl 'https://app.treework.cn/api/daily_check_in' -H 'Cookie: 你的Cookie' -H 'content-type: application/json' --data '{}'" },
  { key: 'custom', name: '自定义平台', icon: '⚙️', color: '#5b8cff',
    desc: '任意签到接口，手动填 URL / 请求头 / 成功判定',
    method: 'GET', url: '', success: { kind: 'status', expr: '200', value: '' }, curlHint: '' },
]

function applyTemplate(t) {
  editing.value.name = t.name
  editing.value.http.method = t.method
  editing.value.http.url = t.url
  editing.value.http.body = t.method === 'GET' ? '' : '{}'
  editing.value.http.successRule = { ...t.success }
  editing.value.http.headersText = t.curlHint.includes('authorization') ? 'authorization: 你的token\ncontent-type: application/json' : 'Cookie: 你的Cookie\ncontent-type: application/json'
  curlText.value = t.curlHint
  showCurl.value = !!t.curlHint
  toast(`已选择「${t.name}」模板，请替换示例中的 Token/Cookie 后再保存`)
}


function headersToText(headers) {
  return Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
}

async function doCurlImport() {
  try {
    const r = await parseCurl(curlText.value)
    const e = editing.value
    e.http.url = r.url
    e.http.method = r.method || 'GET'
    e.http.headersText = headersToText(r.headers)
    e.http.body = r.body || ''
    if (!e.name || e.name === '新签到任务') {
      try { e.name = new URL(r.url).hostname } catch { e.name = '导入任务' }
    }
    showCurl.value = false
    toast('cURL 解析成功，已填入请求信息')
  } catch (err) { toast(err.message, 'err') }
}

async function save() {
  const e = JSON.parse(JSON.stringify(editing.value))
  if (e.type === 'http') {
    const headers = {}
    for (const line of (e.http.headersText || '').split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    e.http.headers = headers
    delete e.http.headersText
    if (e.http.successRule.kind === 'json' && !e.http.successRule.expr) {
      toast('JSON 判定需要填写字段路径', 'err'); return
    }
  }
  e.schedule.times = (e.schedule.times || []).map((t) => t.trim()).filter(Boolean)
  if (!e.schedule.times.length) { toast('至少保留一个执行时间', 'err'); return }
  try {
    await saveProvider(e)
    editing.value = null
    await refresh()
    toast('已保存')
  } catch (err) { toast(err.message, 'err') }
}

async function run(p) {
  runningId.value = p.id
  try {
    const r = await runProvider(p.id)
    const res = r.results?.[0]
    toast(`${p.name}：${res?.message || '完成'}`, res?.ok ? 'ok' : 'err')
    await refresh()
  } catch (e) { toast(e.message, 'err') }
  runningId.value = null
}

async function del(p) {
  if (!confirm(`确定删除任务「${p.name}」？`)) return
  try {
    await deleteProvider(p.id)
    await refresh()
    toast('已删除')
  } catch (e) { toast(e.message, 'err') }
}

async function toggle(p) {
  try { await toggleProvider(p.id); await refresh() } catch (e) { toast(e.message, 'err') }
}

const typeText = (t) => (t === 'workbuddy' ? 'WorkBuddy 加油站' : 'HTTP 签到')
</script>

<template>
  <div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="page-title">签到任务</div>
        <div class="page-sub">每个任务可配置多个每日执行时间；WorkBuddy 任务在「设置」页配置 token</div>
      </div>
      <button class="btn primary" @click="editing = newHttp()">＋ 新增平台签到</button>
    </div>

    <div v-for="p in state.providers" :key="p.id" class="task-item">
      <div class="grow">
        <div class="name">
          {{ p.name }}
          <span class="tag">{{ typeText(p.type) }}</span>
          <span class="tag" :class="p.enabled ? 'ok' : ''">{{ p.enabled ? '已启用' : '已停用' }}</span>
          <span v-if="p.type === 'workbuddy' && !p.tokenPresent" class="tag err">未配置 token</span>
        </div>
        <div class="meta">
          每日执行：{{ (p.schedule?.times || []).join('、') || '未设置' }}
          <template v-if="p.type === 'workbuddy'">
            · 自动签到 {{ p.autoCheckin !== false ? '开' : '关' }} · 旅行闭环 {{ p.travelAuto !== false ? '开' : '关' }}
            <template v-if="p.travelAuto !== false">（{{ p.locationId ? `固定地点${p.locationId}` : '随机地点' }}）</template>
          </template>
        </div>
        <div class="meta">
          上次运行：
          <span :class="p.lastRun ? (p.lastRun.ok ? 'ok-text' : 'err-text') : ''" :style="{ color: p.lastRun ? (p.lastRun.ok ? 'var(--ok)' : 'var(--err)') : 'var(--muted)' }">
            {{ p.lastRun ? p.lastRun.message : '从未运行' }}
          </span>
          <span v-if="p.lastRun" style="opacity:0.7">（{{ p.lastRun.time || p.lastRun.ts }}）</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="btn small primary" :disabled="runningId === p.id || (p.type === 'workbuddy' && !p.tokenPresent)" @click="run(p)">
          {{ runningId === p.id ? '运行中…' : '▶ 运行' }}
        </button>
        <button class="btn small" @click="editProvider(p)">编辑</button>
        <button class="btn small" @click="toggle(p)">{{ p.enabled ? '停用' : '启用' }}</button>
        <button v-if="p.type !== 'workbuddy'" class="btn small danger" @click="del(p)">删除</button>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="editing" class="modal-mask" @click.self="editing = null">
      <div class="modal">
        <h3>{{ editing.id ? '编辑任务' : '新增任务' }}（{{ typeText(editing.type) }}）</h3>

        <!-- 新建 HTTP 任务时显示平台模板 -->
        <template v-if="editing.type === 'http' && !editing.id">
          <label style="font-size:12.5px;color:var(--muted);display:block;margin-bottom:8px">选择平台模板（URL / 判定方式 / cURL 示例会自动填入）</label>
          <div class="platform-templates">
            <div v-for="t in TEMPLATES" :key="t.key" class="platform-template" @click="applyTemplate(t)">
              <div class="icon" :style="{ filter: 'grayscale(0)' }">{{ t.icon }}</div>
              <div class="name" :style="{ color: t.color }">{{ t.name }}</div>
              <div class="tip">{{ t.desc }}</div>
            </div>
          </div>
        </template>

        <div class="field">
          <label>任务名称</label>
          <input type="text" v-model="editing.name" />
        </div>

        <div class="field">
          <label>每日执行时间（可多个）</label>
          <div v-for="(t, i) in editing.schedule.times" :key="i" class="inline" style="margin-bottom:8px">
            <input type="time" v-model="editing.schedule.times[i]" style="max-width:160px" />
            <button class="btn small" v-if="editing.schedule.times.length > 1" @click="rmTime(i)">删除</button>
          </div>
          <button class="btn small" @click="addTime">＋ 添加时间点</button>
        </div>

        <template v-if="editing.type === 'workbuddy'">
          <div class="field">
            <label>自动行为</label>
            <div class="inline" style="margin-bottom:8px">
              <label class="switch"><input type="checkbox" v-model="editing.autoCheckin" /><span class="track"></span></label>
              <span style="font-size:13.5px">每日自动签到（幂等，先查后签）</span>
            </div>
            <div class="inline" style="margin-bottom:8px">
              <label class="switch"><input type="checkbox" v-model="editing.travelAuto" /><span class="track"></span></label>
              <span style="font-size:13.5px">派猫猫旅行自动闭环（到达先领积分，再自动派遣）</span>
            </div>
            <div class="row" v-if="editing.travelAuto !== false" style="max-width:260px">
              <select v-model.number="editing.locationId">
                <option :value="0">派遣地点：随机</option>
                <option :value="1">咖啡馆</option>
                <option :value="2">商场店铺</option>
                <option :value="3">健身房</option>
                <option :value="4">古镇客栈</option>
              </select>
            </div>
          </div>
          <div class="hint">
            安全约束：仅调用官方已验证的签到 / 旅行领取 / 旅行派遣 3 个写接口；派遣前先查每日上限，达上限不发包；成长计划仅只读展示。
          </div>
        </template>

        <template v-else>
          <div class="panel" style="padding:12px 14px;background:var(--panel-2)">
            <div class="inline" style="justify-content:space-between">
              <span class="hint" style="margin:0">最快上手：在电脑浏览器登录目标站点 → F12 复制签到请求为 cURL → 粘贴到这里自动填表</span>
              <button class="btn small" @click="showCurl = !showCurl">{{ showCurl ? '收起' : '从 cURL 导入' }}</button>
            </div>
            <div v-if="showCurl" style="margin-top:10px">
              <textarea v-model="curlText" placeholder="curl 'https://example.com/checkin' -H 'Cookie: xxx' --data '{}'"></textarea>
              <button class="btn small" style="margin-top:8px" @click="doCurlImport">解析并填入</button>
            </div>
          </div>

          <div class="field">
            <label>签到 URL</label>
            <input type="text" v-model="editing.http.url" placeholder="https://..." />
          </div>
          <div class="row">
            <div class="field">
              <label>请求方法</label>
              <select v-model="editing.http.method" style="max-width:140px">
                <option>GET</option><option>POST</option><option>PUT</option>
              </select>
            </div>
            <div class="field">
              <label>请求体（POST 时使用）</label>
              <input type="text" v-model="editing.http.body" placeholder='{"a":1}' />
            </div>
          </div>
          <div class="field">
            <label>请求头（每行一条，格式 Key: Value；Cookie / Token 放这里）</label>
            <textarea v-model="editing.http.headersText" placeholder="Cookie: session=xxxx"></textarea>
          </div>
          <div class="row">
            <div class="field">
              <label>成功判定方式</label>
              <select v-model="editing.http.successRule.kind">
                <option value="status">HTTP 状态码</option>
                <option value="contains">响应包含文本</option>
                <option value="json">JSON 字段等于值</option>
                <option value="always">2xx 即成功</option>
              </select>
            </div>
            <div class="field" v-if="editing.http.successRule.kind === 'status'">
              <label>状态码（多个用逗号分隔）</label>
              <input type="text" v-model="editing.http.successRule.expr" placeholder="200,201" />
            </div>
            <div class="field" v-if="editing.http.successRule.kind === 'contains'">
              <label>包含的文本</label>
              <input type="text" v-model="editing.http.successRule.expr" placeholder="success" />
            </div>
            <div class="field" v-if="editing.http.successRule.kind === 'json'">
              <label>字段路径</label>
              <input type="text" v-model="editing.http.successRule.expr" placeholder="code" />
            </div>
            <div class="field" v-if="editing.http.successRule.kind === 'json'">
              <label>期望值</label>
              <input type="text" v-model="editing.http.successRule.value" placeholder="0" />
            </div>
          </div>
          <div class="hint">提示：token / Cookie 类凭据只保存在 NAS 本机配置目录，Web 界面与日志中都不会完整显示。</div>
        </template>

        <div class="modal-foot">
          <button class="btn" @click="editing = null">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
