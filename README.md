# DeepSleep（自建 DeepSeek 网页版）

把 [DeepSeek 官方演示客户端 chat-demo](https://github.com/deepseek-ai/chat-demo) 改造成**多账号、多端共享、Docker 一键部署**的自建网页版，站点名为「DeepSleep」：

- 复刻网页端界面与能力：深度思考、智能搜索（联网 + 边想边搜）、阅读链接、文件/图片上传、语音输入、朗读回答、消息分支（编辑 / 重新生成 / 继续生成）、Markdown / 公式 / Mermaid、中英双语、深浅色主题、**ZIP 历史对话导入导出**
- **账号密码登录**，历史对话、附件原件都存在服务端，换设备登录同一账号即可看到全部历史
- **API Key 绑定在账号下**（服务端加密保存，浏览器永远拿不到明文），也支持「服务器一个 Key 给多人共用」
- **去掉了「模型内容安全」**：请求里不再携带 `safety_check`，服务端代理还会兜底删除该参数
- **费用可见**：每条回答下方显示本次估算费用，侧边栏每条对话显示累计费用（口径与官方计费一致，见[费用估算](#九费用估算口径)）
- **对话管理**：置顶 / 取消置顶、**点击标题就地重命名**、单条对话导出为 ZIP、侧边栏「导入对话」一键导入（默认追加，也可覆盖）
- 品牌标识：站点名「DeepSleep」，使用自定义的睡眠鲸鱼图标
- 全部运行在 Docker 里，宿主机只需要 Docker，不用装 Node / pnpm；**默认通过 `cloudflared` 隧道访问，应用容器不向宿主机暴露任何端口**

> 数据默认落在 `./data`：SQLite（会话、账号、附件 BLOB、API Key 密文）+ 自动生成的 `app-secret`。备份 = 拷走这个目录。

## 界面预览

| 登录 | 对话（含思考、费用） | 账号与 API Key |
|---|---|---|
| ![登录](docs/screenshots/01-login.png) | ![对话](docs/screenshots/03-chat.png) | ![账号](docs/screenshots/08-account-bound.png) |

| 置顶 + 侧边栏费用 | 导入方式（追加 / 覆盖） |
|---|---|
| ![置顶](docs/screenshots/04-pinned.png) | ![导入](docs/screenshots/09-import-append.png) |

| 侧边栏一键导入 | 点击标题就地重命名 |
|---|---|
| ![侧边栏导入](docs/screenshots/12-sidebar-import.png) | ![重命名](docs/screenshots/15-renamed.png) |

截图来自容器内的自动化冒烟测试（mock 模型回复），更多截图见 [`docs/screenshots`](docs/screenshots)。

---

## 一、快速开始

```bash
# 1. 准备配置
cp .env.example .env
# 必填：在 Cloudflare Zero Trust 创建 tunnel 后把 token 填到 CLOUDFLARE_TUNNEL_TOKEN
# 建议同时填 COOKIE_SECURE=true、TRUST_PROXY=true（走 HTTPS 隧道）
# 可选：DEFAULT_DEEPSEEK_API_KEY=sk-...（服务器默认 Key，所有人共用）

# 2. 构建并启动（应用容器不映射宿主机端口，只通过 cloudflared 隧道访问）
docker compose up -d --build

# 3. 浏览器访问 Cloudflare 后台给该 tunnel 配置的域名（Public Hostname 指向 http://deepseek-web:3080）
#    注册第一个账号即可使用
```

> 没有 token 时 `cloudflared` 会反复重启（属正常，日志会提示缺少 token）。
> 想先在本机直连调试：取消 `docker-compose.yml` 里 `deepseek-web` 的 `ports` 注释（仅监听 127.0.0.1:3080），再 `docker compose up -d`。

### 国内网络加速

- **npm 依赖**：构建时默认使用国内 npmmirror（淘宝）源，无需额外配置；海外环境可在 `.env` 里改 `NPM_REGISTRY=https://registry.npmjs.org`。
- **基础镜像**：默认 `node:24-bookworm-slim`。Docker Hub 拉取慢时，二选一：
  1. 在 Docker Desktop / daemon 里配好 registry mirror（推荐，一次配置全局生效）；
  2. 在 `.env` 里指定国内镜像仓库的同名镜像，例如
     `NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim`（或公司/云厂商提供的镜像地址）。
- 依赖层使用了 BuildKit 缓存挂载，重复构建时不会再重新下载 npm 包。

查看状态与日志：

```bash
docker compose ps
docker compose logs -f
```

停止 / 升级：

```bash
docker compose down          # 停止（数据保留在 ./data）
docker compose up -d --build # 重新构建升级
```

服务器上对外开放前，建议放在 Nginx / Caddy 后面加 HTTPS，并把 `COOKIE_SECURE=true`、`TRUST_PROXY=true` 写进 `.env`。

---

## 二、API Key 的三种用法

| 方式 | 配置 | 说明 |
|---|---|---|
| 每人绑定自己的 Key | 不配 `DEFAULT_DEEPSEEK_API_KEY` | 登录后在 **设置 → 账号** 里粘贴自己的 Key；服务端先用 `/models` 校验，再用 AES-256-GCM 加密存库。只有密文，浏览器只拿到 `sk-****abcd` 掩码。 |
| 一个 Key 全站共用 | `.env` 里设 `DEFAULT_DEEPSEEK_API_KEY=sk-...` | 账号没有绑定自己的 Key 时自动使用服务器默认 Key。适合「一个人付费、几个人一起用」。 |
| 混合 | 以上都配 | 默认用服务器 Key；某个账号在设置里绑了自己的 Key，就优先用他自己的。 |

所有对 DeepSeek 的请求都经过后端代理（`/api/ds/*`），由服务端注入 Key 并转发；密钥不会出现在前端代码、localStorage 或浏览器网络请求里。

---

## 三、账号与注册

- 注册 / 登录：用户名 + 密码（密码用 scrypt 加盐哈希）
- 登录态：HttpOnly + SameSite=Lax Cookie，默认 30 天（`SESSION_DAYS`）
- 关闭注册：`ALLOW_REGISTRATION=false`（已有账号仍可登录）
- 邀请码：`REGISTER_INVITE_CODE=xxx`，只有知道邀请码的人能注册（适合只给熟人用）
- 修改密码：设置 → 账号 → 修改密码；改完其他设备上的登录态失效
- 退出登录：设置 → 账号 → 退出登录（会清空本机缓存的对话数据）

> 账号没有「管理员后台」。几个人的小圈子使用够用；如果被陌生人注册，建议直接设邀请码或关闭注册后重建容器。

---

## 四、多端共享与同步

- 会话列表、每条消息、消息分支、附件原件全部存在服务端
- 登录后自动拉取；页面**切回前台 / 重新获得焦点**时会刷新列表与当前会话（生成中或有未保存修改时跳过，避免覆盖本地状态）
- 同一个账号在手机、电脑上可同时登录，互不踢下线
- 冲突策略：同一条会话两端同时改，以最后一次保存为准（个人使用场景足够）

---

## 五、历史对话导入 / 导出（ZIP）

设置 → 数据管理：

- **导出所有历史对话**：下载 ZIP，包含全部会话，以及服务端存有的图片原件；其他附件只保留文件信息（不含 API Key）
- **导出单条对话**：左侧会话列表 →「⋯」→ 导出为 ZIP，只导出这一条（方便单独分享/备份）
- **导入历史对话**：选择 ZIP 后可选两种方式：
  - **追加到现有对话（默认）**：保留现有对话，把导入内容加进来；同一份文件重复导入也不会覆盖，冲突的会话 id 会自动换新
  - **覆盖现有对话**：清空当前账号的全部对话，替换为导入内容
  - 两种方式都支持本应用导出的 ZIP 和 **DeepSeek 网页端导出的历史对话 ZIP**（从免费版搬家用这个）
- 导入是原子的：全部校验通过才提交；失败只清空暂存区，原对话不受影响

---

## 六、已实现 vs 未实现

| 网页端能力 | 状态 |
|---|---|
| 深度思考 / 智能搜索 / 阅读链接 / 引用角标 / 搜索卡片 | ✅（`deepseek-flash`，Anthropic 兼容 Messages API） |
| 文件、图片上传（PDF/Word/PPT/图片等，Files API） | ✅ |
| 朗读回答（TTS）、语音输入（ASR） | ✅ 通过后端代理 |
| 编辑消息、重新生成、继续生成、消息分支切换 | ✅ |
| 自动会话标题、重命名、删除 | ✅（标题支持点击就地重命名） |
| 会话置顶、单条对话导出、侧边栏一键导入 | ✅（本改造新增） |
| Markdown、代码高亮、KaTeX、Mermaid | ✅ |
| 中英双语、深浅色、移动端布局、位置信息 | ✅ |
| 账号密码登录、多端同步、账号级 API Key | ✅（本改造新增） |
| ZIP 导入导出（追加 / 覆盖）、DeepSeek 网页端历史迁移 | ✅ |
| 每条对话 / 每轮回答的费用估算（可按官方价调整） | ✅ 估算值，仅供参考 |
| **模型内容安全（safety_check）** | ❌ 已按要求移除（服务端代理也会删除该参数） |
| 分享对话链接（公开 URL） | ❌ 未做；用单条对话导出 ZIP 替代 |
| 多用户实时协作、团队空间 | ❌ 未做；每个账号数据隔离 |

> 合规提醒：本项目面向自用/熟人小范围使用。若对外提供服务，请自行承担内容安全审核、大模型登记、AI 标识等义务（DeepSeek 文档中的「模型内容安全」指引已在本项目中移除）。

---

## 七、目录结构

```
.
├── Dockerfile               # 多阶段构建：pnpm 构建前端 → 安装后端依赖 → 运行时镜像
├── docker-compose.yml       # 生产用：应用容器 + ./data 数据卷 + 健康检查 + 可选 cloudflared
├── docker-compose.test.yml  # 联调用：mock DeepSeek API，不产生真实费用
├── .env.example
├── web/                     # 前端（基于 deepseek-ai/chat-demo，MIT）
│   └── src/
│       ├── assets/                  # 站点图标（DeepSleep 睡眠鲸鱼）
│       ├── components/auth/         # 登录 / 注册页
│       ├── components/settings/     # 设置：通用 / 账号 / 数据管理（导入追加/覆盖）
│       ├── components/sider/        # 侧边栏：置顶、每条对话的费用
│       └── services/
│           ├── auth.ts              # 登录态、账号、API Key 绑定
│           ├── pricing.ts           # 费用估算（按官方计费口径）
│           ├── api/backend.ts       # 自建后端请求封装
│           └── chat/db.ts           # 会话/附件存储（改为走服务端 API）
├── server/                  # 后端（Node 24 + Express + node:sqlite，无原生依赖）
│   ├── index.js             # 应用组装、静态文件、启动
│   ├── auth.js              # 注册/登录/退出/改密（scrypt + Cookie 会话）
│   ├── account.js           # API Key 绑定（校验 + 加密存储）
│   ├── storage.js           # 会话/附件/置顶/导入暂存与追加接口
│   ├── proxy.js             # DeepSeek API 反向代理（流式、注入 Key、删 safety_check）
│   ├── pricing.js           # 官价单价 + 高峰时段 + 会话用量汇总
│   ├── db.js                # SQLite 数据层
│   └── test/                # node:test 端到端测试 + mock 上游
└── tools/e2e/               # 可选：容器内 headless Chromium 冒烟测试 + 图标渲染脚本
```

---

## 八、数据备份与迁移

- 全部状态在 `./data`：
  - `data/app.db`（SQLite 主库，含账号、会话 JSON、附件 BLOB）
  - `data/app.db-wal` / `-shm`（WAL 文件）
  - `data/app-secret`（未配置 `APP_SECRET` 时自动生成的加密密钥）
- 备份：`docker compose stop && tar -czf backup.tar.gz data && docker compose start`
- 迁移到新机器：拷走 `data/` 目录 + `docker-compose.yml`（如果设置过 `.env`，一起拷走；**换了 `APP_SECRET` 会导致已绑定的 API Key 无法解密，需要重新绑定**）
- 容器入口会以 root 修正 `/data` 的属主后降权到 `node` 运行，Linux 上首次启动也不需要手动改目录权限

---

## 九、费用估算口径

单价与计费口径对齐 DeepSeek 官方文档（[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)、[联网工具 · 用量与计费](https://api-docs.deepseek.com/zh-cn/guides/web_tools#billing)）：

| deepseek-flash（元 / 百万 token） | 空闲时段 | 高峰时段 |
|---|---|---|
| 输入（缓存未命中） | 1 | 2 |
| 输入（缓存命中） | 0.02 | 0.04 |
| 输出 | 4 | 8 |

- `deepseek-v4-pro`：输入缓存未命中 4.5 / 9，缓存命中 0.15 / 0.30，输出 13.5 / 27
- 联网搜索、图片搜索、网页抓取：**5 元 / 1000 次**（即 0.005 元 / 次）
- 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00，其余（含周末）为空闲时段，高峰单价翻倍。法定节假日无法在本地判断，按工作日**近似**处理。

计算方式：

```
费用 = (未命中输入 token × 未命中价
      + 缓存命中输入 token × 命中价
      + 输出 token × 输出价) / 1,000,000 × 高峰倍数
      + 计费联网次数 × 0.005

计费联网次数 = tool_search（文字搜索）+ tool_image_search（图片搜索）+ tool_fetch（网页抓取）
```

两个容易搞错的点（已按官方文档处理）：

1. `usage.input_tokens` 是**未命中缓存**的输入，`cache_read_input_tokens` 才是命中缓存的输入，不能相加后按一个价算；`cache_creation_input_tokens` 目前恒为 0。
2. `server_tool_use.web_search_requests` / `web_fetch_requests` 只是响应里结果块的数量，**不是计费次数**；计费看 `tool_search` / `tool_image_search` / `tool_fetch`。

展示位置：

- 每条回答下方：这一轮的费用（按该回答的 `createdAt` 判断高峰/空闲）
- 左侧会话列表：这条对话的累计费用（服务端把每条消息的用量按高峰/空闲分桶汇总，前端用当前单价换算）
- 设置 → 账号：**当前账号全部对话的累计花费**（服务端汇总所有会话的用量，统一按 deepseek-flash 单价估算）

不包含：TTS、ASR、文件解析 / OCR 的费用，以及官方可能给出的折扣、赠送余额、模型映射等差异。所以是**估算值，仅供参考，以 DeepSeek 账单为准**。

需要改单价时用 `PRICING_JSON` 覆盖（会与默认值合并），例如关闭高峰翻倍、或按自己的实际结算价调整：

```bash
# docker-compose.yml 的 environment 里加：
PRICING_JSON={"peakMultiplier":1}
# 或者只改某个模型价格：
PRICING_JSON={"models":{"deepseek-flash":{"inputCacheHit":0.02,"inputCacheMiss":1,"output":4}}}
```

---

## 十、Cloudflare Tunnel（默认访问方式）

`cloudflared` 是 compose 里的默认服务，随 `docker compose up -d` 一起启动；**应用容器不向宿主机映射任何端口**（只 `expose` 给 compose 内网），唯一入口就是 Cloudflare 隧道：

1. Cloudflare Zero Trust → Networks → Tunnels → 新建 tunnel（选 cloudflared）→ 复制 token
2. 在 `.env` 里填：
   ```bash
   CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
   COOKIE_SECURE=true      # 走 HTTPS，Cookie 需要 Secure
   TRUST_PROXY=true        # 让登录限流拿到真实 IP
   ```
3. Cloudflare 后台给这个 tunnel 配 Public Hostname：子域名 → 服务填 `http://deepseek-web:3080`
4. `docker compose up -d`，然后访问你的域名

说明：

- 没填 token 时 `cloudflared` 容器会反复重启（日志提示缺少 token），填好后 `docker compose up -d` 即恢复，不影响应用容器。
- **本机调试**：`deepseek-web` 默认映射了 `127.0.0.1:3081:3080`，浏览器打开 <http://localhost:3081> 即可（3080 常被其他程序占用，故用 3081）。不需要时可注释掉 `ports`。
- **隧道速度**：`cloudflared` 默认用 `--protocol http2`（国内网络下 QUIC 抖动大时 http2 更稳更快）。若你的线路用 QUIC 更快，可改回 `--protocol quic` 或去掉该参数。
- **为什么隧道可能很慢**：国内访问 Cloudflare 免费隧道通常会被调度到境外节点（如 LAX/FRA），请求要"出国再回来"，实测上传可能只有 ~100KB/s。文字聊天影响不大，但上传大文件建议：
  - 同一局域网/本机直接用 `http://localhost:3081` 或 `http://<内网IP>:3081`（把 ports 改成 `"3081:3080"` 即允许局域网访问）；
  - 或者用一台国内/香港 VPS + frp（或直接把整套 compose 部署到 VPS），速度取决于 VPS 线路；
  - 家庭宽带如果是运营商 NAT（没有公网 IPv4），无法用「域名 A 记录直连家里端口」的方式；有公网 IPv6 的话理论上可以 AAAA + 端口放行 + DDNS，但地址会变、且没有 IPv6 的访客访问不了。
- `cloudflared` 官方镜像是 distroless（没有 shell），所以不支持容器内自动降级成 quick tunnel；临时试用可以在宿主机装一次 cloudflared 二进制跑 `cloudflared tunnel --url http://127.0.0.1:3081`，或按上面的方式配好 token。

---

## 十一、开发与测试（同样全部在 Docker 内）

> 不需要在宿主机安装 Node、pnpm 或任何依赖。

```bash
# 后端端到端测试（mock DeepSeek API，不花钱）
docker build --target test -t deepseek-web-test .
docker run --rm deepseek-web-test

# 前端类型检查 / Lint（在镜像的构建阶段容器里跑）
docker build --target web -t dsw-web .
docker run --rm dsw-web pnpm type
docker run --rm dsw-web pnpm lint

# 本地联调：mock 上游 + 完整应用
docker compose -f docker-compose.test.yml up -d --build

# 可选：浏览器冒烟测试（并截图到 docs/screenshots）
docker build -t dsw-e2e tools/e2e
docker run --rm --network dpsk-self_default \
  -e TARGET_URL=http://deepseek-web-test:3080 \
  -v "$PWD/docs/screenshots:/shots" dsw-e2e

# 可选：重新生成 apple-touch-icon.png（SVG → PNG）
docker run --rm -v "$PWD/web/src/assets:/out" dsw-e2e \
  node render-icon.mjs /out/favicon.svg /out/apple-touch-icon.png 180
```

宿主机一个 Node / pnpm / Chromium 都不用装：上面这些命令只是调用 Docker。

### 已通过的验证

- 后端：**13 项** `node:test` 端到端测试（注册登录、改密、跨账号隔离、会话 CRUD、置顶排序、附件上传下载与回收、导入原子替换、**追加导入与 id 冲突换新**、API Key 加密绑定、SSE 透传、`safety_check` 被删除、默认 Key 回落、CSRF 拦截）
- 前端：`tsc` 类型检查 + `oxlint` 零告警
- 浏览器（headless Chromium）：**35 项**检查全部通过——注册进入对话、流式回答、思考块、消息与侧边栏费用、置顶、**会话菜单定位**、刷新后历史恢复、单条对话导出 ZIP、绑定 Key 后刷新仍生效、**追加导入 / 覆盖导入 / 侧边栏一键导入**、导出全部对话、退出重登、**点击标题重命名**、控制台零报错

> 注意：`server/test/mock-server.mjs` 是常驻 mock 服务，测试命令已显式指定 `test/e2e.test.js`，避免 `node --test` 把它当测试文件加载导致进程不退出。

前端单独热更新（可选，仅开发时）：`docker compose` 里跑后端后，在 `web/` 目录用容器的 Node 跑 `pnpm dev`（`rspack serve` 监听 8090，并把 `/api` 代理到 3080）。日常使用不需要这一步。

---

## 十二、配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3080` | 容器内监听端口（宿主端口在 compose 的 `ports` 改） |
| `DATA_DIR` | `/data` | 数据目录 |
| `DEEPSEEK_API_BASE` | `https://api.deepseek.com` | 上游地址；测试时指向 mock |
| `DEFAULT_DEEPSEEK_API_KEY` | 空 | 服务器默认 Key（账号未绑定时使用） |
| `APP_SECRET` | 自动生成 | 加密 API Key 用；生产建议显式设置并妥善保存 |
| `ALLOW_REGISTRATION` | `true` | 是否允许注册 |
| `REGISTER_INVITE_CODE` | 空 | 非空时注册必须填写 |
| `SESSION_DAYS` | `30` | 登录态有效天数 |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设 `true` |
| `TRUST_PROXY` | `false` | 在反向代理 / tunnel 后面时设 `true`（取真实 IP 用于限流） |
| `MAX_JSON_BYTES` | 48MB | 单条会话 JSON 上限 |
| `MAX_UPLOAD_BYTES` | 96MB | 单个附件原件上限 |
| `PRICING_JSON` | 官方价 | 覆盖费用估算单价，见[费用估算口径](#九费用估算口径) |
| `LOG_REQUESTS` | 空 | 设为 `1` 时打印每个 API 请求的耗时/大小，排查上传或代理慢 |
| `TZ` | `Asia/Shanghai` | 时区（高峰时段判断按北京时间，与容器时区无关） |
| `CLOUDFLARE_TUNNEL_TOKEN` | 空（必填） | cloudflared 的 tunnel token，见[Cloudflare Tunnel](#十cloudflare-tunnel默认访问方式) |
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | 构建时 npm 源（仅构建阶段生效） |
| `NODE_IMAGE` | `node:24-bookworm-slim` | 构建用基础镜像，可替换为国内镜像仓库地址 |

---

## 十三、附件上传与上下文管理

### 附件上传流程

一次附件上传有两段，都经过 Cloudflare 隧道（浏览器 → Cloudflare 边缘 → 你的服务器）：

1. **给模型用**：选中文件时立刻上传到 DeepSeek Files API（`/api/ds/anthropic/v1/files`，由后端代理，multipart 流式转发）。PDF/Word/PPT 会触发服务端版面解析，本身耗时。
2. **给多端预览用**：把原件存进你服务器的 SQLite（图片缩略图、跨设备打开靠它）。

优化点：

- 第 2 段改为**选中文件时就与第 1 段并行上传**（`web/src/services/chat/drafts.ts`），并按附件 id 去重（`web/src/services/chat/db.ts` 的 `storedIds`），发送时不再串行叠加一次上传。
- **非图片原件超过 8MB 不再存第二份**（历史里已有 DeepSeek `file_id`，跨设备只影响「打开原件」，不影响提问），避免大 PDF/PPT 把隧道上行带宽占满。
- 排查慢在哪：`.env` 里设 `LOG_REQUESTS=1`，然后 `docker compose logs -f deepseek-web`，可以看到每个请求的耗时和大小（例如 Files API 代理 vs 本地原件的时间占比）。

> 提示：家用带宽 + 免费 Cloudflare 隧道的上行是主要瓶颈；如果经常传大文件，把 `deepseek-web` 的端口临时映射到本机（compose 里注释的 `ports`）并走局域网访问会明显更快。

### 上下文管理

每轮请求由前端重新组装**当前分支的完整历史**，规则：

- 只保留「用户提问 + 有有效回答」成对的轮次；报错、停止、空回答、拒答的轮次不进上下文
- 历史思考不回传，只回传回答正文；相邻文本合并，引用标记去掉
- 历史联网搜索结果/打开网页块不回传；只有「阅读链接」的调用+结果带 `signature` 原样回传（服务端还原网页正文）
- 附件按 `file_id` 引用（图片 `image` 块 / 文档 `document` 块）；没有 `file_id` 又没有本地原件的附件会跳过
- 继续生成时把最后一条回答作为 assistant 前缀（含思考签名）
- 日期/位置等用户元信息变化时以 `latest_reminder` 插入
- 没有本地截断/摘要：依赖模型 1M 上下文，超限会返回 400；如有需要可以加「按 token 预算丢弃最早轮次」策略

---

## 十四、来源与许可

- 前端基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT License），保留了其 `LICENSE` 与界面代码，改造了登录、存储、代理与设置部分；图标为项目自定义的 DeepSleep 睡眠鲸鱼图。
- 界面协议说明见 [DeepSeek API 文档 · 构建 Chatbot](https://api-docs.deepseek.com/zh-cn/guides/build_a_chatbot)，价格页见 [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)。
- 本项目同样以 MIT License 提供，按「自用/小范围使用」设计，请遵守 DeepSeek 开放平台服务协议。
