# DSH Server Kit 执行计划

> 状态：架构 v2.2，v0.1 基础发行层已实现；真实容器验收由 CI 执行
> 更新：2026-09-04
> 变更：不再自研 DSH 主 Web UI、账户体系或通用 HTTP/WebSocket Gateway；优先复用 DSH 生态的可审计组件，项目收敛为安全、可升级的服务器发行层。
> 历史版本：[采用复用架构前的完整规划](archive/EXECUTION_PLAN_PRE_REUSE_ARCHITECTURE.md)

## 1. 产品定义

**DSH Server Kit 是 DeepSeek Harness 的安全服务器发行层。**

它把本地优先、默认只绑定 loopback 的 DSH，变成一个可在 Docker / Coolify 中部署、经身份验证后远程访问、数据可持久化、版本可验证升级与回滚的单实例服务。

```text
DSH Server Kit ≠ 修改版 DeepSeek Harness
DSH Server Kit ≠ 新的 AI Agent Web UI
DSH Server Kit = 可复现、安全、可运维的 DSH 服务器装配与兼容层
```

产品只承诺五件事：

1. 一个明确版本的镜像可在服务器稳定运行 DSH；
2. 公网访问必须经过认证，HTML、API、WebSocket 和流式连接不能绕过；
3. DSH、认证状态和工作区在镜像更新后仍保留；
4. 每个发布镜像声明精确的 DSH、认证 Bundle 和 UI Bundle 组合；
5. 升级失败不修改 Volume，可用上一镜像 digest 回滚。

## 2. 架构重构后的决定

| 决定 | 结论 | 原因 |
| --- | --- | --- |
| DSH 主 UI | 复用上游 `dsh web` | 不 fork、不维护前端与 Host 协议。 |
| 工作台 UI | 复用 `dsh-web` 生态；首个受支持扩展是 `dsh-better-sidebar` | 文件、编辑、预览、终端、Git、浏览器都不应自研。 |
| 全功能 UI | `@linxin666/dsh-web-all` 只作为显式社区扩展 | 它还带来远程配对、SSH、定时任务等额外攻击面与兼容面。 |
| 浏览器认证 | 优先复用 DSH 原生认证 Bundle；首个 POC 是 `dsh-auth-gate` | 避免重写密码、Cookie、会话和 DSH 内部 HTTP / upgrade 认证。 |
| 反向代理 | 使用 Caddy | 原生支持 WebSocket、SSE、上传和下载；配置比自研 proxy 更可审计。 |
| 自研范围 | 只做启动编排、状态端点、配置生成、升级兼容和端到端测试 | 这是 Server Kit 的唯一产品价值。 |
| 用户模型 | v0.1 仅一个可信管理员 / 共享实例 | 登录身份不等于 DSH、工作区、凭据或 OS 隔离。 |
| 升级 | 只发布锁定版本组合；运行时绝不安装 `@latest` | DSH 与 UI Bundle 均会高频变化。 |

## 3. 复用边界

### 3.1 必须使用的现成组件

| 组件 | 责任 | 使用方式 |
| --- | --- | --- |
| `@deepseek-ai/dsh` | Agent runtime、Web UI、Profile、官方插件协议 | 精确 npm 版本，随镜像安装。 |
| Caddy | :8080 到容器内 loopback DSH 的 HTTP、WebSocket、SSE 代理 | 精确二进制版本，固定 Caddyfile；保留经过 DSH 信任栅栏验证的公开 `Host`。 |
| `tini` | PID 1、信号转发、僵尸进程回收 | 容器入口点。 |
| DSH Auth Bundle | 登录页、密码校验、会话 Cookie、HTTP / WS guard | 先验证 `dsh-auth-gate`，通过后精确锁定。 |
| `dsh-better-sidebar` | 可选 Workbench：文件、编辑、预览、终端、Git、浏览器 | 仅在锁定的 Workbench Profile 中使用。 |
| `dsh-web` / `dsh-web-all` | 社区 UI、任务板、皮肤等功能来源 | 仅作为显式社区扩展和兼容性测试对象。 |
| Coolify / Traefik | TLS、域名、外层限流和部署生命周期 | 外部平台能力；容器不复制 TLS 逻辑。 |

### 3.2 Server Kit 必须自研的最小模块

| 模块 | 具体职责 | 不承担的职责 |
| --- | --- | --- |
| `docker/entrypoint.sh` | 校验输入、初始化 Volume、拷贝 seed Profile、读取持久化运行配置、启动和停止子进程 | 不在运行时从 npm / GitHub 下载插件。 |
| `src/setup-server.mjs` | 仅在未初始化时提供 `/setup`、接受用户名或邮箱、按需验证一次性码、调用 Auth Gate CLI 并原子写入非敏感配置 | 不代理 DSH、不实现密码哈希、会话或通用管理后台。 |
| `src/status-server.mjs` | loopback `/healthz`、`/readyz`、`/versionz`，读取非敏感运行状态 | 不代理 DSH，不保存用户和会话。 |
| `config/Caddyfile` | 只暴露 :8080；路由状态端点并反代其它请求 | 不做认证、不保存状态、不签发 TLS。 |
| `scripts/build-seed-profile.mjs` | 从 release manifest 生成可复现 base / workbench Profile 与锁文件 | 不扫描或修复用户任意插件。 |
| `scripts/preflight-upgrade.mjs` | 检查 marker、Profile manifest 与当前镜像组合 | 不升级未知用户插件。 |
| `tests/integration/` | 真实容器、真实 DSH、真实浏览器与旧 Volume 兼容测试 | 不用 mock 替代安全边界测试。 |

### 3.3 明确不做

- 不 fork 或 patch DeepSeek Harness 源码；
- 不开发聊天、会话、模型、Agent、文件、终端、Git、皮肤或任务板 UI；
- 不实现用户数据库、密码哈希、Cookie 签名、TOTP 或多用户权限系统；
- 不做多租户、每用户实例、OS 隔离、配额或计费；
- 不默认安装 `dsh-web-all`、SSH、Cloudflare Tunnel、移动端配对、定时 Agent 任务；
- 不自动升级 DSH、认证 Bundle 或 UI Bundle；
- 不承诺兼容用户自行安装的全部第三方插件。

## 4. 组件准入清单

| 组件 | 公开来源 | 准入条件 |
| --- | --- | --- |
| DSH | <https://github.com/deepseek-ai/deepseek-harness> | 官方 npm 精确版本；容器启动、Profile dump、浏览器会话均通过。 |
| `dsh-auth-gate` | <https://github.com/zephaniahwang94-cmyk/dsh-auth-gate> | 页面、API、SSE 和 WebSocket 都 fail-closed；公网反代下登录、退出和 Cookie 通过。 |
| `dsh-better-sidebar` | <https://github.com/omdsh-dev/DSH-better-sidebar> | 锁定 DSH 的浏览器、重启、旧 Profile 升级测试通过。 |
| `dsh-web` | <https://github.com/zhu1090093659/dsh-web> | 作为扩展逐项审计；其 `@latest` 安装示例不能进入发行镜像。 |
| `dsh-web-workbench` | <https://github.com/yth1120/dsh-web-workbench> | 不准入：依赖指定 DSH 源码 patch，违背高频核心升级目标。 |

第三方项目的 star、截图、目录收录或“已安装”提示不构成安全与兼容证明。只有本仓库的容器测试通过，组件版本才可写入 release manifest。

## 5. 目标架构

```text
Internet
  │ HTTPS
  ▼
Coolify / Traefik
  │ only container :8080
  ▼
┌──────────────────────── dsh-server-kit container ───────────────────────┐
│ first start only: setup-server :8080 → one-time code + administrator     │
│ after setup: Caddy :8080                                                  │
│   ├─ /healthz, /readyz, /versionz → status-server :9000 (loopback)      │
│   └─ all other HTTP / WebSocket / SSE → DSH :3080 (loopback)            │
│                                                                          │
│ DSH :3080                                                               │
│   ├─ official dsh web                                                    │
│   ├─ native Auth Bundle: login + session + HTTP / WS guard               │
│   └─ optional locked UI Profile: base or workbench                       │
│                                                                          │
│ No host port → :3080 or :9000                                            │
└──────────────────────────────────────────────────────────────────────────┘
  │                 │                       │
  ▼                 ▼                       ▼
+/data/dsh     /data/dsh-server       /data/workspace
```

### 5.1 信任边界

1. Coolify / Traefik 终止 TLS；容器只接受 :8080 请求。
2. Docker 只发布 `8080`；`3080` 和 `9000` 永不发布。
3. 新实例先启动最小的 `/setup` 服务器；管理员在浏览器提交公开 authority 与用户名或邮箱。默认 `open` 模式不显示一次性码；显式设为 `code` 时才验证首启日志的一次性码。配置持久化后，Caddy 才以该 authority 拒绝任意其它 `Host`，并只连接 `127.0.0.1:3080`、保留该公开 Host；启动 DSH 时将同一个、经配置验证的 authority 传入重复的 `--trusted-host` 参数。DSH 自己的浏览器信任栅栏据此做第二次验证；绝不将 Host 改写为 loopback 来绕过该栅栏。
4. Auth Bundle 在 DSH 路由层拦截页面、`/api/*`、WebSocket upgrade、SSE 和未来路由。
5. UI Bundle 不得监听额外公网端口。Tunnel、SSH、remote API 或后台定时运行默认关闭，除非单独准入。
6. 容器以专用非 root 用户运行；持久化目录最小权限为 `0700`；密码和 API Key 不进入镜像、日志或 manifest。

### 5.2 为什么取消自研 Gateway

原方案中的 Node Gateway 同时做密码、Cookie、会话、HTTP proxy、WebSocket proxy、健康检查和 DSH 认证桥接。这会重复 Auth Bundle 与 Caddy，并迫使我们长期追踪 DSH 内部路由变化。

```text
认证：DSH 原生 Auth Bundle
转发：Caddy
DSH UI：上游 dsh web
可选工作台：dsh-better-sidebar / dsh-web 生态
自研：只协调、验证和发布这些组件
```

安全要求没有降低；边界反而由更少、更可审计的组件组成。

## 6. Profile 与 UI 策略

### 6.1 支持等级

| 等级 | Profile 内容 | 发布承诺 |
| --- | --- | --- |
| `base` | 官方 DSH Web UI + Auth Bundle | v0.1 必须支持；唯一默认值。 |
| `workbench` | `base` + 锁定版 `dsh-better-sidebar` | 完整浏览器验收通过后支持。 |
| `community` | 用户显式安装 `dsh-web-all` 或其它 Bundle | 可运行但不承诺自动修复；先备份 Profile。 |

`dsh-web` 是重要的 UI 功能来源，但不是基础运行时。其聚合包包含 remote Web、SSH、定时任务与插件管理；默认安装会把“安全服务器发行层”变成“由强权限社区 Bundle 决定行为的综合工作台”。

### 6.2 Workbench Profile 合约

```text
DSH version              = exact
auth bundle version      = exact
dsh-better-sidebar       = exact
profile lockfile         = generated and committed
bundle mount rows        = generated and deterministic
```

构建镜像时生成 seed Profile。只在 `/data/dsh/profiles/web` 不存在时原子拷贝 seed；已有 Profile 永远不被启动逻辑覆盖。

### 6.3 社区全家桶的受控路径

`dsh-web-all` 不进入 `base` 或 `workbench`。文档只允许：

1. 用户选择精确的 `dsh-web-all` 版本；
2. 先对 `/data/dsh` 创建加密 Volume Snapshot；
3. 在克隆测试 Volume 中安装、重启、登录和验证；
4. 通过本仓库声明的 DSH 组合后，再在生产 Profile 安装；
5. remote、SSH、cron 与自更新维持关闭，直到用户明确开启并接受风险。

Server Kit 不运行 `dsh plugin add ...@latest`，也不调用 UI Bundle 的一键自更新。

## 7. 数据、配置与首次启动

### 7.1 单个持久化根目录

部署只挂载一个 Volume：容器路径 `/data`。其内部目录由启动器创建并保持最小权限：

| 子目录 | 内容 | 规则 |
| --- | --- | --- |
| `/data/dsh` | Profile、Settings、模型凭据、会话、插件及 Auth Bundle 自身状态 | 最高敏感；升级镜像不得覆盖；备份必须加密。 |
| `/data/dsh-server` | 初始化记录、兼容 marker、最后成功的 release metadata、升级锁和诊断摘要 | 不存明文密码、session 或 API Key。 |
| `/data/workspace` | Agent 实际读写的用户项目 | 所有登录者共享；不是隔离边界。 |

### 7.2 环境变量

```dotenv
# New deployments require no environment variables. /setup records the public
# authority and creates the administrator on first browser open.

# Optional runtime values.
DSH_HOME=/data/dsh
DSH_SERVER_HOME=/data/dsh-server
WORKSPACE_ROOT=/data/workspace
DSH_INTERNAL_PORT=3080
DSH_PUBLIC_PORT=8080
DSH_UI_PRESET=base

# Optional. Default open hides setup-code input. Set code to require a random
# one-time code from the first container log before the administrator is made.
DSH_SETUP_PROTECTION=open
```

浏览器不能持久改写 Coolify 的环境变量，因此向导保存的是 `/data/dsh-server/runtime-config.json`，其中只有公开 authority、schema 版本和时间；entrypoint 在每次启动时读取它并为 DSH/Caddy 导出 `DSH_TRUSTED_HOST`。默认 `open` 模式无初始化码；`code` 模式才首次写入受限文件并打印一次，完成初始化后立即删除。它不是管理员密码。`open` 模式必须在首个访问者受控时使用；若域名已公开，生产必须改用 `code`。Auth Bundle 仍通过自己的 `dsh-auth user add --password-stdin` 写入 bcrypt 哈希。若 Auth Bundle 无法保护 WebSocket，或无法在反向代理下 fail-closed，则不准入；届时才评估最小认证适配层。

### 7.3 首次启动状态机

```text
container start
  ↓
validate directory ownership
  ↓ failure → exit non-zero; do not start setup server, Caddy or DSH
create /data/dsh-server with 0700
  ↓
web profile exists?
  ├─ yes → verify manifest and marker only
  └─ no  → atomically copy immutable seed profile
  ↓
runtime-config.json exists?
  ├─ yes → validate persisted trustedHost
  └─ no  → serve /setup :8080; accept username or email; create bcrypt admin; persist trustedHost
             └─ DSH_SETUP_PROTECTION=code only: require one-time code
  ↓
write non-sensitive state = starting
  ↓
start DSH on 127.0.0.1:3080 with --trusted-host "$DSH_TRUSTED_HOST"
  ↓
verify process + config dump + Auth Bundle route guard
  ↓ failure → write failure code, stop; never rewrite profile
start status server :9000 and Caddy :8080
  ↓
write state = ready and current release marker
```

首次启动不生成默认密码。默认 `open` 模式没有额外初始化凭据，因此必须让首个 `/setup` 访问者受控。`code` 模式会生成随机一次性码，仅供操作者从首启容器日志复制到 `/setup` 页面，完成后删除。管理员密码不进入日志、镜像或普通运行配置。

## 8. 公开接口与运行时合约

### 8.1 端口

| 端口 | 监听地址 | 用途 | 可发布 |
| --- | --- | --- | --- |
| 8080 | `0.0.0.0` | Caddy，外部唯一入口 | 是 |
| 3080 | `127.0.0.1` | DSH Web Host | 否 |
| 9000 | `127.0.0.1` | status server | 否 |

### 8.2 状态端点

| 路径 | 登录 | 语义 | 返回 |
| --- | --- | --- | --- |
| `GET /healthz` | 否 | status server 进程存活 | `200 {"status":"ok"}` |
| `GET /readyz` | 否 | DSH 监听、Profile 校验、Auth Bundle 挂载、Caddy 转发均成功 | `200 {"status":"ready"}`；否则 `503` |
| `GET /versionz` | 否 | 已发布版本组合 | 不含凭据、路径、工作区和用户信息 |

Docker `HEALTHCHECK` 与 Coolify 读取 `/readyz`。端点不泄露 DSH 版本细节、插件列表或异常栈。

### 8.3 Caddy 代理契约

```text
/healthz, /readyz, /versionz
  → 127.0.0.1:9000

all other paths, including static assets, /api/*, WebSocket, SSE, uploads and downloads
  → 127.0.0.1:3080
```

实施时必须以真实浏览器验证：

- WebSocket upgrade 不降级、不缓存且不能绕过认证；
- SSE 和 Agent streaming 不被代理缓冲；
- 上传、下载、`Set-Cookie`、`Location` 和 `Origin` 保持 DSH 所需语义；
- Caddy 将浏览器的原始 `Host` 传给 DSH；启动器已验证该值与唯一的 `DSH_TRUSTED_HOST` 一致。反代不得把 Host 改写为 loopback，也不得信任任意客户端提供的 Host；
- Caddy 清除外部 `X-Forwarded-*`、`X-Real-IP` 与自定义代理标记；这些头不能变成 DSH、Auth Bundle 或浏览器信任信号；
- Coolify / Traefik 的真实客户端 IP 和限流语义与 Auth Bundle 一致。

## 9. 认证和用户边界

### 9.1 v0.1 模型

```text
one trusted administrator
  ↓
one DSH instance
  ↓
one shared DSH_HOME
  ↓
one shared /data/workspace
```

即使 Auth Bundle 将来支持多个账号，也不能据此声称数据、会话、Agent、模型凭据或文件已隔离。多用户与多租户是另一个产品，不进入 v0.1。

### 9.2 远程 Settings 限制

DSH 的浏览器客户端把完整 Settings 编辑能力限制在 loopback origin。公开域名即使已经通过 Auth Bundle 登录，也不能直接在页面中编辑模型等 DSH Settings。这是上游的本地优先安全边界，不通过注入前端或伪造 Host 绕过。

v0.1 的运维路径是：在首启或 Coolify Secret 中配置所需的服务端变量；需要完整 Settings 编辑的管理员，通过 SSH 隧道访问 loopback，或在受控本机使用 Auth Bundle 的 loopback proxy。该 proxy 不构成公网服务，也不被 Caddy 暴露。

### 9.3 Auth Bundle 准入测试

1. 未登录页面只能进入登录流程；
2. 未登录 `/api/*` 不能读取或写入；
3. 未登录 WebSocket upgrade 被拒绝；
4. 登录 Cookie 为 `HttpOnly`，HTTPS 时为 `Secure`，SameSite 策略明确；
5. 退出、错误登录、过期会话和重启后的语义可预期；
6. 错误配置、Bundle 失败或 DSH 路由契约变化时 fail-closed；
7. 密码和 token 不出现在 dump、日志、端点和镜像 layer；
8. 认证不只是一个前端 Login 页面。

TOTP、审计归因、设备管理、密码重置和多管理员都不在 v0.1。需要时先评估 upstream Bundle 或外部 IdP。

## 10. 版本、兼容性与升级

### 10.1 Release manifest

每个镜像都随附 `config/release-manifest.json`，并写入 OCI label：

```json
{
  "schemaVersion": 1,
  "serverKitVersion": "0.1.0",
  "dsh": {
    "package": "@deepseek-ai/dsh",
    "version": "exact-version",
    "integrity": "npm-integrity"
  },
  "auth": {
    "package": "approved-auth-bundle",
    "version": "exact-version",
    "integrity": "npm-integrity"
  },
  "uiPresets": {
    "base": [],
    "workbench": [
      {
        "package": "dsh-better-sidebar",
        "version": "exact-version",
        "integrity": "npm-integrity"
      }
    ]
  },
  "runtime": {
    "node": "exact-base-image-digest",
    "caddy": "exact-version"
  }
}
```

不使用版本范围、`next`、`alpha` 或 `latest` 通道。alpha / rc 可以是精确版本号，但不是升级策略。

### 10.2 运行时 marker

`/data/dsh-server/runtime-state.json` 只保存版本和状态：

```json
{
  "schemaVersion": 1,
  "lastKnownGood": {
    "serverKitVersion": "0.1.0",
    "imageDigest": "sha256:...",
    "dshVersion": "exact-version",
    "authVersion": "exact-version",
    "uiPreset": "base"
  },
  "lastAttempt": {
    "imageDigest": "sha256:...",
    "result": "ready"
  }
}
```

marker 禁止保存密码、session、API Key、工作区文件名或用户行为。

### 10.3 升级算法

```text
Renovate detects DSH or approved Bundle release
  ↓
dependency PR records an exact new version
  ↓
CI builds immutable image and seed Profile
  ↓
CI runs fresh-volume and old-volume suites
  ↓
only passing PR creates a release image
  ↓
operator snapshots all three volumes
  ↓
operator changes image digest and restarts
  ↓
entrypoint validates existing Profile without mutation
  ↓
DSH + Auth + Caddy reach readyz
  ↓
write new lastKnownGood marker
```

规则：

- 生产启动时绝不执行 `npm update`、`pnpm update` 或全 Profile 扫描后的 `pnpm install`；
- 不自动升级用户自行安装的 plugin；
- 只对 manifest 中的 `base` / `workbench` Profile 承诺兼容；
- 现有 Profile 需要不可逆迁移时，启动中止并提示先做 Volume Snapshot；
- 新镜像不能 ready 时，用户 Profile 和 marker 保持不变，使用旧 image digest 即可回滚。

### 10.4 备份与回滚

回滚标准动作是“上一 immutable image digest + 原 Volume”。未做迁移时，应立即恢复服务。

每次升级前都对 `/data` 做一个加密 Volume Snapshot；该快照包含 DSH 状态、运行配置和工作区。

`/data/dsh` 可能含模型与插件凭据，备份必须加密。v0.1 不开发自有备份服务，只提供 Docker / Coolify Snapshot 的可验证操作文档。

## 11. 性能与可靠性

| 风险 | 策略 | 验收信号 |
| --- | --- | --- |
| 流式响应卡顿 | Caddy 直通 WebSocket / SSE，不在自研层缓冲或 JSON 包装 | 长任务 streaming 连续，客户端无代理超时。 |
| UI 初始体积 | `base` 无额外 UI；Workbench 利用 `dsh-better-sidebar` 的按需加载 | base 首屏不加载 Workbench 依赖。 |
| 升级不可复现 | 版本、integrity、Profile lockfile 和镜像 digest 共同锁定 | 同 manifest 重建得到相同依赖树。 |
| 启动竞态 | DSH ready 前不写成功 marker；status server 报真实状态 | 启动失败时 `/readyz` 为 503。 |
| 子进程遗留 | `tini` + SIGTERM trap，按 Caddy → DSH 顺序停止 | `docker stop` 后无孤儿 DSH。 |
| 日志泄密或膨胀 | 结构化事件只含版本和状态；Docker 配置轮转 | 日志不含 secret，长时运行不耗尽磁盘。 |
| UI Bundle 失配 | 每个 UI 组合进入浏览器 + old-profile 矩阵 | 失配组合不得标为 supported preset。 |

## 12. 仓库结构

```text
dsh-server-kit/
├── config/
│   ├── release-manifest.json
│   ├── Caddyfile
│   └── presets/
│       ├── base.json
│       └── workbench.json
├── docker/
│   ├── entrypoint.sh
│   └── healthcheck.sh
├── scripts/
│   ├── build-seed-profile.mjs
│   ├── preflight-upgrade.mjs
│   └── verify-release-manifest.mjs
├── src/
│   └── status-server.mjs
├── test-fixtures/
│   └── previous-release-volume/       # no real credentials
├── tests/
│   ├── integration/
│   │   ├── base-container.test.mjs
│   │   ├── auth-boundary.test.mjs
│   │   ├── upgrade.test.mjs
│   │   └── workbench-profile.test.mjs
│   └── browser/
│       └── public-access.spec.ts
├── .github/workflows/
│   ├── verify.yml
│   ├── integration.yml
│   ├── image.yml
│   └── release.yml
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── renovate.json
├── README.md
└── docs/
    ├── EXECUTION_PLAN.md
    ├── DEPLOY_COOLIFY.md
    ├── UPGRADE_AND_ROLLBACK.md
    ├── SECURITY_MODEL.md
    └── archive/
```

不再创建 `packages/gateway`、`auth/users.ts`、`proxy/websocket.ts` 等原计划中的自研认证与代理层。除 status server 外，没有前端工程。

## 13. v0.1 完整交付范围

v0.1 是可公开部署的单管理员服务器发行版，不发布“只有 Dockerfile”或“只有登录页”的半成品。

### 13.1 必须交付

- 多阶段 Dockerfile：非 root、`tini`、精确 Node / Caddy / DSH 版本；
- :8080 到 DSH :3080 的安全 Caddy 代理，支持 HTTP、WebSocket、SSE、上传和下载；
- 通过 POC 后锁定的 Auth Bundle，保护页面、API 和 WebSocket；
- `base` seed Profile，首次初始化无网络依赖；
- `workbench` seed Profile 的兼容构建与验收；其失败不阻塞 `base` 发布；
- 单个 `/data` Volume、权限校验、`healthz` / `readyz` / `versionz`；
- release manifest、runtime marker、旧 Volume 升级和回滚契约；
- Docker Compose、Coolify、备份、升级、回滚和安全模型文档；
- GitHub Actions、GHCR amd64 / arm64 镜像、Renovate；
- 真实容器和浏览器集成测试。

### 13.2 不可接受的“完成”

- DSH :3080 被 Docker 直接发布；
- 只有登录页，但 `/api` 或 WebSocket 可绕过；
- 镜像或依赖只用 `latest`；
- 升级只验证新 Volume；
- Bundle 仅 typecheck，没有真实 `dsh web`、浏览器和重启验证；
- 声称多用户隔离；
- 密码进入 Dockerfile、`.env.example`、日志、fixture 或 git 历史。

## 14. 实施顺序与 Atomic Commits

以下是同一个 v0.1 交付内的依赖顺序，不代表可以跳过后续安全或兼容工作公开发布。

| Commit | 单一目的 | 主要文件 | 完成判据 |
| --- | --- | --- | --- |
| 1 | 固化复用架构与 manifest schema | `docs/`、`config/release-manifest.json` | 未填精确版本时构建失败。 |
| 2 | 创建可复现、非 root 的 base image | `Dockerfile`、`.dockerignore` | 镜像含精确 DSH、Caddy、tini，且不含 secret。 |
| 3 | 实现 Profile seed 与首次初始化 | `scripts/build-seed-profile.mjs`、`docker/entrypoint.sh` | 空 Volume 初始化成功；已有 Profile checksum 不变。 |
| 4 | 接入并验收 Auth Bundle | `config/presets/base.json`、auth 测试 | 页面、API、WebSocket 均 fail-closed。 |
| 5 | 配置 Caddy 与 status server | `config/Caddyfile`、`src/status-server.mjs` | 仅 :8080 外露；streaming、health、ready 正确。 |
| 6 | 接入 Workbench Profile | `config/presets/workbench.json`、浏览器测试 | 锁定 UI Bundle 的声明功能真实可用。 |
| 7 | 实现升级、marker 与旧 Volume 契约 | preflight、fixture、升级测试 | 新 image 挂旧 Volume 成功或不修改数据地失败。 |
| 8 | 发布供应链与部署文档 | workflows、Compose、Coolify docs | 双架构镜像可发布，干净主机能按文档部署。 |

每个 commit 只包含上表的一项；对应测试与文档同 commit 提交，不混入无关依赖升级、格式化或 UI 功能。

## 15. CI 与验收矩阵

### 15.1 每个 PR

```text
manifest schema / exact-version validation
  ↓
Docker build (amd64)
  ↓
fresh base volume boot
  ↓
missing auth secret fails closed
  ↓
unauthenticated and authenticated HTTP checks
  ↓
unauthenticated and authenticated WebSocket checks
  ↓
SSE / streaming smoke
  ↓
container restart + Volume persistence
  ↓
old-volume + new-image compatibility
```

### 15.2 Workbench 额外验证

```text
fresh workbench profile
  ↓
login through public Caddy path
  ↓
browser opens DSH session
  ↓
sidebar renders
  ↓
file preview / terminal / Git panel smoke
  ↓
restart container
  ↓
upgrade same profile to next approved DSH image
```

### 15.3 人工发布门槛

- 真实 HTTPS 域名下验证 `Secure` Cookie、登录、刷新和退出；
- 浏览器 DevTools 确认 WebSocket 无绕过认证；
- `docker ps` 与 Coolify 只显示 :8080；
- 原 image digest + 原 Volume 的回滚 read-back；
- 确认 `dsh-web-all`、SSH、remote、cron 不在 `base` Profile；
- community 扩展只在单独 Snapshot 和风险提示后安装。

## 16. 发布与运维

### 16.1 标签

```text
ghcr.io/<owner>/dsh-server-kit:0.1.0
ghcr.io/<owner>/dsh-server-kit:0.1.0-dsh<exact-version>
ghcr.io/<owner>/dsh-server-kit:sha-<git-sha>
```

生产锁定 digest 或 `0.1.0-dsh<exact-version>`。禁止在 Coolify 生产配置中使用 `latest`。

### 16.2 Coolify 部署动作

1. 从 Git Repository 选择 Dockerfile；
2. 仅发布容器端口 `8080`；
3. 创建一个 Persistent Storage，容器挂载路径设为 `/data`；
4. 配置 HTTPS 域名；
5. 首次部署后，访问 `/setup` 创建管理员（用户名或邮箱）并确认域名；若域名已公开，设置可选变量 `DSH_SETUP_PROTECTION=code` 后再从首启日志复制一次性码；
6. 等待 `/readyz`，再通过浏览器登录；
7. 第一次升级前创建 Volume Snapshot，并记录当前 image digest。

旧版三 Volume 部署迁移时，先对三卷创建快照，将它们的内容分别复制到新 `/data` Volume 的 `dsh`、`dsh-server`、`workspace` 子目录，再切换挂载；不得以空 `/data` 覆盖已有实例。

### 16.3 日志与诊断

容器日志只记录 timestamp、event、image digest、DSH / auth / UI preset 的精确版本、readiness 与非敏感失败码。

不得记录 URL query、Cookie、Authorization、密码、模型 Key、请求 body、工作区文件名或完整异常栈。仅在显式 `code` 初始化保护模式下，随机 setup code 是例外：它只打印一次，完成配置后立即失效；详细诊断只可在容器内受限路径读取。

## 17. 发布准入与已实现闭环

以下不是架构待决项，而是每次新发行必须重新运行的准入矩阵：

1. 当前基线固定为 DSH `0.1.2-rc.1`、`dsh-auth-gate` `0.12.0`、`dsh-better-sidebar` `0.18.0`、构建器 `pnpm` `10.33.0`；三个 npm integrity、三个 Profile lockfile 与基础镜像 digest 进入 manifest 和 Git。构建器版本必须与锁生成版本一致，避免 pnpm 11 的最小发布年龄策略在已审计 lockfile 上产生非确定性拒绝。
2. `base` 是唯一默认预置。`workbench` 已预构建但仅在每次锁定组合完成真实容器启动、认证与浏览器验收后才标为生产支持。
3. `dsh-web-all` 继续是受控 community 路径，不会进入发行镜像。
4. Auth Gate 的容器内登录限流只能看到 Caddy；Coolify / Traefik / Cloudflare 必须配置真实客户端 IP 限流。
5. 发布工作流输出 `linux/amd64` 和 `linux/arm64` 多架构镜像、SBOM 与 provenance；DSH/UI 有 native dependency 时，两个架构都必须通过容器冒烟。

### 17.1 已实现的 v0.1 运行闭环

```text
committed manifest + locks + digest
  ↓ Docker build (no runtime package install)
immutable base/workbench seed profile + attestation
  ↓ first boot only
first-open setup (optional code) + persisted trustedHost + bcrypt admin
  ↓
entrypoint exports trustedHost + preflight profile integrity
  ↓
DSH loopback + auth probe (auth/status 200 AND anonymous root 401)
  ↓
status server + Caddy start
  ↓
ready marker + last-known-good marker
  ↓
upgrade: mount old volumes, validate without rewriting, then start or fail closed
```

本机没有 Docker 时，只能完成 lock、配置、脚本和 status 单元验证；真实 image build、Caddy 运行时解析、DSH/Auth 启动和匿名拒绝由 `tests/integration/container-smoke.sh` 与 GitHub Actions 执行，不能把前者误报为完整容器验收。

任何新增功能必须证明属于“安全远程访问、持久化、升级、部署或运维”之一；否则交给 DSH 或社区 Bundle。
