<div align="center">

# AI签到管家 · ai-checkin

**飞牛 fnOS 上的 AI 站点自动签到助手**

零依赖 Node.js 后端 + Vue3 前端 · 装在 NAS 上常驻运行 · 支持应用内自动更新

</div>

---

## 简介

AI签到管家是一个跑在**飞牛 fnOS**（或任意 Linux + Node 18+）上的自动签到应用。
它内置了 WorkBuddy「Buddy 加油站」的完整签到闭环，也支持用 cURL 导入任意 AI 站点的签到请求，
每天定时帮你把该点的到点了、该领的积分领了、该派的猫猫派了。

- **零依赖后端**：后端只用 Node 内置模块（`node:http` + 内置 `fetch`），没有 `node_modules`，fpk 仅约 **100KB**，安装不联网。
- **应用内自动更新**：从 GitHub Releases 检查 / 下载 / 校验 / 热替换 / 自动重启，无需重装。
- **数据不出本机**：登录 token 只存在 NAS 本地配置目录，接口对外只返回掩码。

## 功能特性

### WorkBuddy 加油站（内置任务）
- **每日自动签到**：先查后签，已签自动跳过（接口幂等，不会重复发奖）
- **派猫猫旅行闭环**：到达先领积分 → 再自动派遣；到每日派遣上限自动停手
- **成长计划只读展示**：当前 Buddy、成长等级进度、待完成任务清单
- **总览实时看板**：积分余额、连续登录天数、本周 / 本月活跃、连续奖励节点

### 通用 HTTP 签到（适配其他 AI 站点）
浏览器里 F12 → 右键签到请求「复制为 cURL」→ 粘贴导入，自动解析 URL / 方法 / 请求头 / 请求体。
成功判定支持四种：HTTP 状态码、响应包含文本、JSON 字段等于值、2xx 即成功。

### 定时与通知
- 每个任务可配置多个每日执行时间点（默认 09:00），调度器每 30 秒检查一次
- 开启「启动补跑」后，NAS / 应用重启时会补跑当天没跑过的任务
- 结果可推送到 通用 Webhook / 钉钉 / 飞书 / 企业微信 / Bark

### 版本更新
- 设置页「版本更新」卡片：一键检查 / 下载 / 更新 / 回滚
- 更新源默认指向本仓库的 GitHub Releases，也可换成任意自定义清单地址

## 安装（飞牛 fnOS）

1. 到 [Releases](https://github.com/373065025/ai-checkin/releases) 下载最新的 `ai-checkin<版本>.fpk`
2. 飞牛应用中心 → 右上角「手动安装」→ 选择该文件
3. 安装向导端口保持默认 `8630`（桌面图标入口固定指向该端口，改了图标会打不开）
4. 装好后桌面 / 应用列表会出现「AI签到管家」图标，点开即用；也可浏览器访问 `http://<NAS_IP>:8630`

> 升级后若页面像旧版，按 `Ctrl + F5` 强刷一次。

## 使用

### 1. 导入 WorkBuddy 登录态（关键）
NAS 上没有 WorkBuddy 客户端，需要从电脑端导入一次 token：

1. 电脑端登录 WorkBuddy
2. 打开文件
   - Windows：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
   - macOS：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
3. 全选复制 → 在「签到任务」页点开 WorkBuddy 任务的**编辑** → 「登录态」里粘贴（或点「选择 .info 文件」）→ **导入登录态** → 保存

登录态是**按任务保存**的，每个任务各自一份；只保存在 NAS 本机的配置目录，界面只显示掩码，过期后重新导入即可。

### 2. 配置任务
「签到任务」页可新建 / 编辑 / 启停任务，配置每日执行时间点与各自的登录态；
HTTP 签到任务支持从 cURL 一键导入。

## 应用内自动更新（GitHub Releases）

应用默认从 **本仓库的 GitHub Releases** 检查更新：

```
https://github.com/373065025/ai-checkin/releases/latest
```

- 启动后 + 每 6 小时自动检查一次，也可在设置页手动点「检查更新」
- 发现新版本 → 弹窗确认 → 自动备份当前版本（可回滚）→ 下载 → 校验 SHA256 → 热替换 → 自动重启
- 更新源固定在项目仓库，设置页只读展示；GitHub 未登录时 API 限 60 次/小时（对 6 小时一次的检查完全够用）

**发布新版本时**，只需在 GitHub 建一个 Release，附上更新包：

```bash
# 1. 构建前端
npm --prefix web install
npm --prefix web run build

# 2. 生成更新包（app-<版本>.tgz）与安装包（.fpk）
node tools/build-app-tgz.js
node tools/build-fpk.js

# 3. 在 GitHub 上传 build/app-<版本>.tgz（Release 附件）
#    也可直接上传 .fpk，客户端会自动拆出里面的 app.tgz
```

也可以打 tag 让 GitHub Actions 自动构建并发布（见 `.github/workflows/release.yml`）：

```bash
git tag v1.0.4 && git push origin v1.0.4
```

> 更新源默认即本仓库（`https://github.com/373065025/ai-checkin/releases/latest`），
> 在设置页只读展示，无需也不开放额外配置。
> 后端 `updater.js` 仍保留自定义清单（`{ version, notes, url, sha256, size }`）与 GitHub 地址自动换算能力，
> 便于自行 fork 后改用自己的仓库。

## 目录结构

```
.
├── manifest                 # fnOS 应用清单（版本 / 端口 / 入口）
├── cmd/                     # 安装 / 卸载 / 升级钩子（可执行）
├── config/                  # privilege / resource
├── wizard/index.json        # 安装向导（默认端口）
├── ui/                      # 桌面入口：ui/config + ui/images/icon-{64,256}.png
├── ICON.PNG  ICON_256.PNG   # 应用中心图标
├── server/                  # 零依赖后端（node:http，无 node_modules）
│   └── src/lib/updater.js   #   应用内自动更新（GitHub Releases / 自定义源）
├── web/                     # Vue3 + Vite 前端（构建产物 web/dist）
└── tools/                   # 零依赖打包工具（Windows 也能跑）
    ├── build-app-tgz.js     #   生成 app-<版本>.tgz（热更新包）
    ├── build-fpk.js         #   生成 ai-checkin<版本>.fpk（安装包）
    └── lib/tar-pack.js      #   自写 tar + gzip
```

## 本地开发

```bash
# 前端（Vite 开发服务器，代理 /api 到本地后端）
npm --prefix web install
npm --prefix web run dev

# 后端（Node 18+，零依赖）
node server/src/index.js        # 默认端口 8630，可用 PORT 覆盖
```

构建发布产物：

```bash
npm run build          # 构建前端
npm run update:tgz     # 生成热更新包
npm run fpk            # 生成安装包
npm run release        # 一条龙：build + tgz + fpk
```

## 安全说明

- 后端只调用 WorkBuddy 官方已验证的 **3 个写接口**：`daily-checkin`、`travel/claim`、`travel/depart`；**绝不**调用兑换、抽奖等接口
- 派遣前必查 `daily_limit_reached`，达上限不发写请求
- 成长计划、旅行状态、加油站状态均为**只读**查询
- token 与 Cookie 只写本机配置目录，接口对外只返回掩码，日志不回显
- 更新包含完整源码，请通过 GitHub Releases 或你自己的鉴权空间分发

## 免责声明

本项目仅供个人学习与自用，与 WorkBuddy / 飞牛 fnOS 官方无关。
请自行评估使用风险，遵守各平台的服务条款。

## License

[MIT](./LICENSE)
