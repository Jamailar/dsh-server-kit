可以。现在这个项目可以正式定为：

# DSH Server Kit

GitHub 仓库名：

```text
dsh-server-kit
```

我建议把它定义成：

> **A secure, Docker-ready server distribution for DeepSeek Harness.**
> 将 DeepSeek Harness 变成一个可 Docker 部署、可安全远程访问、可持续升级的服务器版本。

它不是 DeepSeek Harness 的 fork，也不是单纯一个插件，而是一个“服务器发行版”。内部可以包含一个 DSH Gateway 插件，同时负责 Docker、持久化、版本管理、健康检查等服务器能力。

---

# 一、项目到底解决什么问题

DeepSeek Harness 目前本质上仍然偏向：

```text
本地电脑
    ↓
127.0.0.1
    ↓
DSH Web
```

官方之所以这样设计，是因为 DSH Agent 能运行 Bash、访问文件、使用凭据，Web Host 权限很高，所以官方默认只允许 loopback。官方当前 Web Server 也明确把 `127.0.0.1` 作为默认安全边界。

但是很多人真正需要的是：

```text
服务器
   ↓
Docker
   ↓
域名
   ↓
浏览器
   ↓
DeepSeek Harness
```

这里缺的就是：

```text
Docker Deployment
Remote Access
Authentication
Persistence
Upgrade
Health Check
Server Runtime
```

这就是 `dsh-server-kit` 的定位。

---

# 二、明确项目边界

我建议一开始就把边界定死。

`dsh-server-kit` 负责：

| 能力             | 是否属于核心 |
| -------------- | -----: |
| Docker 镜像      |      ✅ |
| 服务器远程访问        |      ✅ |
| Gateway        |      ✅ |
| 用户名密码          |      ✅ |
| Session        |      ✅ |
| TOTP           |     可以 |
| HTTP 鉴权        |      ✅ |
| WebSocket 鉴权   |      ✅ |
| 持久化            |      ✅ |
| Health Check   |      ✅ |
| DSH 版本管理       |      ✅ |
| DSH 自动升级检测     |      ✅ |
| 插件升级兼容         |      ✅ |
| Coolify 部署     |      ✅ |
| Docker Compose |      ✅ |
| GHCR 镜像        |      ✅ |
| dsh-trading    |      ❌ |
| MCP            |      ❌ |
| Skills         |      ❌ |
| 特定模型           |      ❌ |
| 特定业务插件         |      ❌ |

也就是说：

```text
DSH Server Kit
      │
      ├── 基础设施
      │
      └── 安全远程访问
```

至于：

```text
dsh-trading
各种 Skill
MCP
GitHub Plugin
Telegram
自定义 Agent
```

全部交给用户安装。

这样项目才会长期干净。

---

# 三、整体架构

最终结构建议：

```text
Internet
   │
   ▼
https://dsh.example.com
   │
   ▼
Coolify / Traefik
   │
   ▼
Container :8080
   │
   ▼
┌──────────────────────────────────────┐
│              DSH Server Kit          │
│                                      │
│  ┌────────────────────────────────┐  │
│  │       Server Gateway           │  │
│  │                                │  │
│  │  Password Authentication       │  │
│  │  Session Cookie                │  │
│  │  Rate Limit                    │  │
│  │  TOTP optional                 │  │
│  │  HTTP / API Guard              │  │
│  │  WebSocket Guard               │  │
│  └───────────────┬────────────────┘  │
│                  │                   │
│                  ▼                   │
│         127.0.0.1:3080               │
│                  │                   │
│                  ▼                   │
│        DeepSeek Harness              │
│                  │                   │
│          DSH Web Profile             │
│                  │                   │
│       用户自己安装的 Plugins         │
│                                      │
└──────────────────────────────────────┘

Volumes
│
├── /data/dsh
└── /workspace
```

这里最重要的是：

**外界永远接触不到真正的 DSH Web Server。**

真正 DSH：

```text
127.0.0.1:3080
```

Gateway：

```text
0.0.0.0:8080
```

所以：

```text
公网
↓
Gateway
↓
认证
↓
DSH
```

而不是：

```text
公网
↓
DSH
```

---

# 四、Gateway 应该做成标准 DSH Plugin

仓库是 Server Distribution。

但里面真正负责认证的部分，可以是：

```text
@dsh-server-kit/gateway
```

一个标准 DSH Bundle。

例如：

```text
packages/gateway/
```

它最终甚至可以独立发布到 npm：

```bash
dsh plugin --profile web add @dsh-server-kit/gateway
```

所以别人即使不用你的 Docker 镜像，也能使用 Gateway。

这样会让整个项目架构非常漂亮：

```text
dsh-server-kit
│
├── Docker Distribution
│
└── @dsh-server-kit/gateway
```

---

# 五、Gateway 的职责

Gateway 是整个项目真正核心的代码。

它监听：

```text
0.0.0.0:8080
```

内部 DSH：

```text
127.0.0.1:3080
```

工作流程：

```text
request
   ↓
有没有有效 Session？
   │
   ├── 没有
   │      ↓
   │    /login
   │
   └── 有
          ↓
      Proxy to DSH
```

它要代理的不只是普通页面。

必须覆盖：

```text
HTML
Static Assets
/api/*
WebSocket
SSE
Streaming
Uploads
Downloads
```

否则 DSH 会出现页面能打开但 Agent 不工作的情况。

---

# 六、认证系统

第一版不需要做复杂账号体系。

建议支持两种模式：

```text
password
token
```

默认：

```text
password
```

例如环境变量：

```env
DSH_AUTH_MODE=password
DSH_AUTH_USERNAME=jam
DSH_AUTH_PASSWORD_HASH=...
```

注意：

不要存：

```text
DSH_AUTH_PASSWORD=123456
```

最好第一次启动生成用户数据库：

```text
/data/dsh-server/auth/users.json
```

例如：

```json
{
  "users": {
    "jam": {
      "passwordHash": "...",
      "enabled": true
    }
  }
}
```

密码使用：

```text
scrypt
```

或者 Argon2。

对于第一版来说 Node 内置 `crypto.scrypt` 很合适，不需要额外 native dependency。

---

# 七、Session

登录之后：

```text
POST /auth/login
```

成功生成：

```text
256-bit random session token
```

返回 Cookie：

```text
HttpOnly
Secure
SameSite=Lax/Strict
Path=/
```

例如：

```text
dsh_server_session
```

Session 存储第一版可以直接用：

```text
/data/dsh-server/auth/sessions.json
```

甚至简单一点：

```text
内存
```

但我建议持久化。

Session 默认：

```text
7 days
```

可以环境变量控制：

```env
DSH_SESSION_TTL=604800
```

---

# 八、TOTP

不是第一版必须。

可以放到：

```text
v0.2
```

支持：

```text
Google Authenticator
1Password
Authy
Microsoft Authenticator
```

登录：

```text
Password
   ↓
TOTP
   ↓
Session
```

但项目第一版我会优先保证：

```text
密码
Session
API/WebSocket
稳定代理
Docker
Upgrade
```

先做好。

---

# 九、一个非常重要的原则：不要改 DSH 源码

这一点要坚持。

不要：

```text
fork DeepSeek Harness
↓
修改 Web Server
↓
修改 Auth
↓
修改 Host
↓
长期 merge upstream
```

应该：

```text
@deepseek-ai/dsh
        │
        ▼
Server Kit
        │
        ├── Gateway
        ├── Docker
        └── Server Runtime
```

DSH 当前已经把 CLI 作为公开 npm package 发布，而且 profile/plugin 本身就是其标准扩展机制。当前仓库的 `@deepseek-ai/dsh` 版本已经进入 `0.1.3-alpha.1`，说明这个项目确实处于快速迭代期。

这更说明：

> 上游必须是可替换依赖，而不是你代码的一部分。

---

# 十、仓库结构

我建议正式结构：

```text
dsh-server-kit/
│
├── packages/
│   │
│   └── gateway/
│       ├── package.json
│       ├── tsconfig.json
│       ├── cordis.patch.yml
│       │
│       └── src/
│           ├── index.ts
│           ├── server.ts
│           │
│           ├── auth/
│           │   ├── password.ts
│           │   ├── session.ts
│           │   └── users.ts
│           │
│           ├── proxy/
│           │   ├── http.ts
│           │   ├── websocket.ts
│           │   └── headers.ts
│           │
│           └── routes/
│               ├── login.ts
│               ├── logout.ts
│               └── health.ts
│
├── docker/
│   ├── entrypoint.sh
│   └── healthcheck.sh
│
├── Dockerfile
│
├── docker-compose.yml
│
├── .env.example
│
├── package.json
├── pnpm-workspace.yaml
│
├── .github/
│   └── workflows/
│       ├── test.yml
│       └── docker.yml
│
├── renovate.json
│
├── LICENSE
└── README.md
```

---

# 十一、Dockerfile

这里建议用：

```dockerfile
FROM node:24-bookworm-slim
```

而不是 Alpine。

原因是 DSH / 插件未来可能有 native dependency，Debian 基础镜像通常省事很多。

核心：

```dockerfile
FROM node:24-bookworm-slim

ARG DSH_VERSION=0.1.3-alpha.1

ENV NODE_ENV=production
ENV DSH_HOME=/data/dsh
ENV DSH_INTERNAL_PORT=3080
ENV DSH_SERVER_PORT=8080
ENV WORKSPACE_ROOT=/workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    @deepseek-ai/dsh@${DSH_VERSION} \
    pnpm

WORKDIR /opt/dsh-server-kit

COPY packages/gateway ./packages/gateway
COPY docker ./docker

RUN cd packages/gateway \
    && npm install \
    && npm run build

RUN mkdir -p \
    /data/dsh \
    /data/dsh-server \
    /workspace

VOLUME ["/data/dsh", "/data/dsh-server", "/workspace"]

EXPOSE 8080

HEALTHCHECK \
  --interval=30s \
  --timeout=5s \
  --start-period=30s \
  --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/opt/dsh-server-kit/docker/entrypoint.sh"]
```

这只是结构示意，真正实现时还需要解决 Profile 初始化。

---

# 十二、版本一定要锁死

例如：

```dockerfile
ARG DSH_VERSION=0.1.3-alpha.1
```

不要：

```text
latest
alpha
next
```

因为：

```text
今天 build
```

和：

```text
明天 build
```

必须产生同样的软件版本。

否则无法复现。

---

# 十三、DSH Profile 初始化

第一次容器启动：

```text
/data/dsh
```

是空的。

entrypoint 应该检查：

```text
$DSH_HOME/profiles/web
```

是否存在。

不存在：

```bash
dsh plugin --profile web add ...
```

初始化 Server Kit Gateway。

例如：

```bash
dsh plugin --profile web add /opt/dsh-server-kit/packages/gateway
```

然后启动：

```bash
dsh --profile web \
    --port 3080 \
    --no-open
```

Gateway 同时监听：

```text
8080
```

---

# 十四、不要把用户插件装进镜像

这是特别重要的一点。

比如：

```text
dsh-trading
```

不要：

```dockerfile
RUN dsh plugin add @dshtrading/...
```

因为这样每次更新 Docker 镜像都把 Server 和业务绑定到一起了。

正确的是：

```text
DSH Server Kit
↓
启动

用户之后：
↓
Settings / Terminal
↓
安装 dsh-trading
```

插件保存在：

```text
/data/dsh
```

而 `/data/dsh` 是 Volume。

所以更新 Server Kit 镜像以后插件依然存在。

---

# 十五、三个 Volume

我建议最终三个：

```text
/data/dsh
```

DSH：

```text
profiles
sessions
settings
credentials
plugins
skills
```

官方 DSH 的 Profile 本来就位于 `$DSH_HOME/profiles/<name>`，而 `$DSH_HOME` 是整个用户状态的统一根目录。

第二：

```text
/data/dsh-server
```

Server Kit 自己：

```text
users
sessions
gateway config
audit
```

第三：

```text
/workspace
```

Agent 真正工作的文件。

这样最清楚：

```text
DSH Runtime Data
/data/dsh

Server Security Data
/data/dsh-server

Agent Files
/workspace
```

---

# 十六、为什么 Gateway 数据不要塞 DSH_HOME

理论上也可以：

```text
/data/dsh/server-kit
```

但我更建议分开。

因为以后：

```text
重置 DSH
```

不应该顺便删除：

```text
Server 登录账号
```

反过来也一样。

逻辑边界更清晰。

---

# 十七、Coolify 部署体验

你的目标应该是：

用户打开 Coolify：

```text
New Resource
↓
Git Repository
↓
dsh-server-kit
```

选择：

```text
Dockerfile
```

设置：

```text
Port: 8080
```

Volumes：

```text
/data/dsh
/data/dsh-server
/workspace
```

绑定：

```text
dsh.example.com
```

Deploy。

然后：

```text
https://dsh.example.com
```

打开：

```text
DSH Server Kit

Username
Password

Sign in
```

登录后：

```text
DeepSeek Harness
```

这应该是项目最核心的 UX。

---

# 十八、首次启动体验

我甚至建议不要强制用户通过环境变量写密码。

第一次启动：

```text
没有任何 users
```

自动生成：

```text
Initial Admin Password

username: admin
password: xxxxxxxxxxxxxxxx
```

打印到 Docker log。

用户进入：

```text
/admin/setup
```

第一次登录后：

```text
强制修改密码
```

这样对于 Coolify 很友好。

用户部署：

```text
Deploy
↓
看一次 Logs
↓
复制密码
↓
登录
```

结束。

这比让用户先配置 Hash 更好。

---

# 十九、Health Check

必须提供：

```text
GET /health
```

返回：

```json
{
  "status": "ok",
  "gateway": "ok",
  "dsh": "ok",
  "version": {
    "serverKit": "0.1.0",
    "dsh": "0.1.3-alpha.1"
  }
}
```

这样 Coolify 可以直接检测。

最好再提供：

```text
/ready
```

区别：

```text
/health
```

进程活着。

```text
/ready
```

DSH 已经真正启动成功。

---

# 二十、Docker 内启动顺序

entrypoint：

```text
1. 检查 Volume 权限
2. 检查 DSH_HOME
3. 初始化 web profile
4. 检查 Gateway bundle
5. 必要时修复依赖
6. 启动 DSH
7. 等待 127.0.0.1:3080 Ready
8. 启动 Gateway :8080
9. Ready
```

如果 DSH 启动失败：

```text
Gateway 不应该假装正常
```

`/ready` 返回：

```text
503
```

---

# 二十一、版本升级策略

这是 DSH Server Kit 最应该做好的一部分。

例如：

```text
Server Kit 0.1.0

DSH:
0.1.3-alpha.1

Gateway:
0.1.0
```

然后官方 DSH：

```text
0.1.3-alpha.2
```

你只需要修改：

```text
DSH_VERSION
```

构建新的 Server Kit：

```text
0.1.1
```

对应：

```text
Server Kit 0.1.1
DSH 0.1.3-alpha.2
```

---

# 二十二、不要自动升级生产环境

DSH 现在太新。

所以不要：

```text
npm update
↓
直接 production
```

正确流程：

```text
DSH 发布新版本
        ↓
Renovate 创建 PR
        ↓
CI Build
        ↓
Integration Test
        ↓
Docker Smoke Test
        ↓
Merge
        ↓
发布 Server Kit image
        ↓
Coolify 更新
```

---

# 二十三、Renovate

我更推荐 Renovate，而不是 Dependabot。

让它监控：

```text
@deepseek-ai/dsh
```

发现：

```text
0.1.3-alpha.1
→
0.1.3-alpha.2
```

自动 PR：

```text
chore(deps): update DeepSeek Harness to 0.1.3-alpha.2
```

CI 自动验证。

---

# 二十四、CI 至少测试这些

服务器项目最重要的不是 Unit Test，而是 Integration Test。

CI：

```text
docker build
      ↓
docker run
      ↓
等待 /ready
      ↓
GET /
      ↓
确认未登录无法访问
      ↓
登录
      ↓
获得 Cookie
      ↓
GET /
      ↓
成功
      ↓
调用 /api
      ↓
成功
      ↓
建立 WebSocket
      ↓
成功
      ↓
重启 Container
      ↓
Volume 数据存在
```

这些比测试几十个小函数重要。

---

# 二十五、升级兼容测试

每次 DSH 更新，还应该测试：

```text
old volume
+
new image
```

例如：

```text
Server Kit 0.1.0
↓
创建数据
↓
安装一个测试插件
↓
停止
↓
Server Kit 0.1.1
↓
挂旧 Volume
↓
启动
```

然后确认：

```text
Session 存在
Settings 存在
Credentials 存在
Plugin 存在
```

现有 `libook/dsh-server` 已经专门实现了 DSH 版本变化后重新运行 profile `pnpm install` 的思路，这一点非常值得直接借鉴。

---

# 二十六、插件兼容修复

这应该成为 Server Kit 一个很重要的特性。

在：

```text
/data/dsh/.server-kit-version
```

记录：

```json
{
  "dsh": "0.1.3-alpha.1",
  "serverKit": "0.1.0"
}
```

启动发现：

```text
上次：
DSH 0.1.3-alpha.1

当前：
DSH 0.1.3-alpha.2
```

那么自动：

```text
扫描 profiles/*
↓
重新 pnpm install
```

然后更新 marker。

这可以显著降低 DSH 快速升级带来的问题。

---

# 二十七、镜像版本

GHCR：

```text
ghcr.io/yourname/dsh-server-kit
```

Tag：

```text
0.1.0
0.1.1
0.2.0

sha-f3a81d7
latest
```

生产建议使用：

```text
0.1.1
```

或者：

```text
sha-f3a81d7
```

不要真正依赖：

```text
latest
```

---

# 二十八、回滚

因为 `/data` 是 Volume，所以：

```text
Server Kit 0.1.1
```

出问题：

```text
Image:
0.1.0
```

直接重启。

但是需要注意：

> 如果新版 DSH 修改了 DSH_HOME 数据格式，单纯回滚镜像未必安全。

所以升级前最好做 Volume Snapshot。

---

# 二十九、备份

Server Kit 可以提供：

```bash
dsh-server backup
```

未来版本做。

第一版至少文档说明：

需要备份：

```text
/data/dsh
/data/dsh-server
/workspace
```

其中最敏感：

```text
/data/dsh
```

因为这里可能有 API Key。

---

# 三十、安全边界

项目必须明确：

```text
DSH Agent ≈ 服务器上的高权限软件
```

不是普通聊天机器人。

所以 Gateway 不只是“为了好看加个登录页”。

它是真正安全边界。

至少要保证：

```text
未登录无法访问 HTML
未登录无法访问 API
未登录无法建立 WebSocket
未登录无法获得 Session
```

不能只是：

```text
前端显示 Login Page
```

然后别人直接：

```text
/api/xxx
```

还能访问。

---

# 三十一、不要完全绕开 DSH 自带认证

DSH 当前已经存在 launch-token → signed-cookie 的浏览器认证机制。

你的 Gateway 最好：

```text
Gateway Auth
+
DSH Auth
```

而不是：

```text
Gateway Auth
↓
把 DSH Auth 强行全部删除
```

也就是说：

```text
外层身份
+
内层 DSH session authority
```

两层都保留。

现有 `dsh-auth-gate` 已经实现了 launch-token bridge，这部分源码非常值得研究，而不是自己盲猜 DSH Cookie 协议。

---

# 三十二、可以参考哪些现有项目

我会把它们当“参考实现”，而不是依赖：

### `libook/dsh-server`

重点学习：

```text
Docker
nginx / loopback
DSH_HOME
版本升级
插件 repair
```

它已经很好地解决了 Docker 自托管。

### `KegenGuyll/dsh-server`

重点学习：

```text
version pinned wrapper
volume
GHCR
upgrade
rollback
```

它的理念跟 Server Kit 非常接近。

### `dsh-auth-gate`

重点学习：

```text
Password
Session
TOTP
DSH launch token bridge
API authentication
WebSocket authentication
```

当前版本已经是一个成熟的标准 DSH bundle。

### `AnkoCD/dsh-server-deployment`

重点学习：

```text
公网安全
代理 DSH privileged APIs
用户隔离
Host / Origin 处理
```

但不要照搬多租户复杂度。

---

# 三十三、第一阶段千万别做多用户

第一版只做：

```text
一个 DSH instance
多个登录账号可以访问同一个实例
```

甚至更简单：

```text
一个 admin 用户
```

够了。

不要第一天就搞：

```text
user A
    ↓
DSH A

user B
    ↓
DSH B
```

这会立刻引入：

```text
OS isolation
process management
port allocation
credentials isolation
workspace isolation
resource quotas
```

项目复杂度直接乘十。

---

# 三十四、版本路线图

我会这样划。

## v0.1 — Minimum Server

目标：

> Docker 里安全跑起来。

包含：

```text
Dockerfile
DSH pinned version
Gateway
Username/password
Session Cookie
HTTP proxy
WebSocket proxy
DSH_HOME volume
Workspace volume
Health check
Coolify docs
```

这就是 MVP。

---

## v0.2 — Security

增加：

```text
TOTP
login rate limit
audit log
session management
logout all devices
password change
```

---

## v0.3 — Upgrade

重点做：

```text
Renovate
DSH upgrade detection
Profile dependency repair
migration checks
backup hook
rollback docs
```

---

## v0.4 — Deployment

增加：

```text
GHCR
amd64
arm64

Docker Compose
Coolify
Dokploy
Portainer
Railway（如果适合）
```

---

## v0.5 — Admin

可以增加简单 Server Kit 设置页：

```text
Server
DSH Version
Server Kit Version
Uptime
Storage
Installed Profiles
Installed Plugins
Users
Sessions
Logs
```

但不要替代 DSH Settings。

---

# 三十五、README 的定位也应该非常直接

项目标题：

```text
DSH Server Kit
```

副标题：

> Secure, Docker-ready server deployment for DeepSeek Harness.

README 开头：

```text
DeepSeek Harness is designed primarily for local use.

DSH Server Kit turns it into a secure, persistent,
Docker-ready server that you can access remotely.
```

然后直接：

```bash
docker run ...
```

这是最好的传播方式。

---

# 三十六、最核心的产品哲学

我觉得可以总结成三个原则：

### 1. Upstream First

```text
不 fork DSH
不改核心
尽量兼容官方
```

### 2. Docker First

```text
docker build
docker run
```

就是第一公民。

### 3. Server Only

只解决：

```text
Remote
Auth
Persistence
Upgrade
Deployment
```

不把业务功能塞进来。

---

# 三十七、最终架构一句话

所以你的项目最终可以非常清楚地定义为：

> **DSH Server Kit 是 DeepSeek Harness 的服务器发行层，通过一个安全网关、Docker 运行环境、持久化与版本管理，将本地优先的 DSH 转变为可安全远程访问、可持续升级的自托管服务。**

内部关系：

```text
DeepSeek Harness
        │
        ▼
@dsh-server-kit/gateway
        │
        ▼
Docker Runtime
        │
        ▼
DSH Server Kit
```

而不是：

```text
DSH Server Kit
=
修改版 DeepSeek Harness
```

这个区别很重要。

按这个架构做的话，`dsh-server-kit` 是有独立价值的：不是重复造 Harness，也不是重复造 Trading，而是专门把 DSH 的“服务器部署这一公里”做好。

---

# 三十八、执行计划的维护方式

本文是项目的主计划文档。当前阶段只完成了“规划入库”，尚未开始实现。

## 1. 结论状态

- **已确定**：项目定位、边界、单实例优先、外层 Gateway + 内层 DSH 身份机制、三个持久化 Volume、固定上游版本、禁止生产自动升级。
- **作为候选实现**：Node.js Gateway、Node 内置 `crypto.scrypt`、文件型用户与会话存储、`node:24-bookworm-slim`、Coolify 优先、`@dsh-server-kit/gateway` 可独立发布。
- **必须在编码前核验**：DSH 当前 CLI、Profile、插件、Web Server、launch-token / signed-cookie、WebSocket 与升级修复的真实接口和版本行为；本文出现的上游版本号与参考项目仅是原始规划中的线索，不视为当前事实。

## 2. 后续讨论的记录规则

每次讨论某个模块，直接在对应章节补充以下内容，而不是另起零散文档：

- 决策：最终选择与原因；
- 合约：环境变量、文件路径、HTTP 路由、Cookie、进程和退出行为；
- 实现：现成库 / DSH 官方接口 / 自研代码的边界；
- 验收：可复现命令、预期结果和失败语义；
- 风险：安全、兼容、数据迁移与回滚条件。

## 3. 首批待讨论项

1. **DSH 集成事实核验**：Gateway 应按“DSH 插件”还是“独立同容器进程”实现，以及 DSH 的完整启动与认证协议。
2. **安全模型**：单管理员起步还是允许多个共享同一实例的登录账号；Token 模式、CSRF、Origin/Host allowlist、反向代理信任边界的具体规则。
3. **状态与恢复**：用户、会话、审计日志采用 JSON 文件、SQLite，还是其他存储；并发写、密钥轮换、备份和容灾语义。
4. **代理合约**：HTTP、WebSocket、SSE、上传下载、Cookie 和重写 Header 的精确处理，以及哪些路径不应被代理。
5. **容器运行时**：DSH 需要的 OS 包、非 root 用户、权限模型、子进程监督、优雅关闭和启动失败可观测性。
6. **发布兼容性**：支持的 DSH 版本范围、升级前检查、profile 依赖修复条件、不可逆迁移的阻断与回滚策略。
7. **最小首发验收**：从全新 Volume 到 Coolify 域名部署、登录、代理流式会话、重启持久化、升级旧 Volume 的端到端证明。

## 4. 未开始实现清单

当前仓库仅有基础 README；以下内容均尚未创建：

- Gateway 源码与包结构；
- Dockerfile、entrypoint、Compose 与环境变量模板；
- CI、镜像发布和依赖更新自动化；
- 集成测试、兼容性测试与部署文档；
- 面向用户的登录或管理界面。

---

# 三十九、社区 Web UI 选项评估（2026-09-04）

本节记录公开仓库与其文档的调研结论。它不是对第三方项目的安全背书；任何第三方 Bundle 都会以 DSH 进程权限接触工作区、终端、凭据与网络，必须在隔离 Profile 中先验收。

调研来源：

- DSH 官方 Web：<https://github.com/deepseek-ai/deepseek-harness>
- `dsh-better-sidebar`：<https://github.com/omdsh-dev/DSH-better-sidebar>
- `dsh-web` / 聚合包：<https://github.com/zhu1090093659/dsh-web>
- `dsh-web-workbench`：<https://github.com/yth1120/dsh-web-workbench>

## 1. 结论

DSH Server Kit 不应重写 DSH 的主 UI，也不应把大型第三方 UI 全家桶作为默认安装项。

推荐的产品结构是：

```text
默认：DSH 官方 Web UI
可选：经过版本锁定和兼容测试的 Workbench UI 预设
用户自行选择：更激进的第三方 UI 全家桶
```

这样既保留 DSH 核心高频升级能力，又让需要 IDE 式体验的用户有清晰、可控的升级路径。

## 2. 候选方案比较

| 方案 | 集成方式 | 主要能力 | 对高频 DSH 升级的影响 | Server Kit 定位 |
| --- | --- | --- | --- | --- |
| DSH 官方 Web UI | 上游 `dsh web` | DSH 原生会话、工作区、Settings、Agent 界面 | 最低；随锁定的 DSH 核心镜像一同更新 | 默认且唯一的基础界面 |
| `dsh-better-sidebar` | 标准 DSH Profile Bundle，不改 DSH 源码 | 文件浏览/编辑/预览、终端、Git、嵌入浏览器、后台任务；允许第三方注册 Tab | 较低；可锁定插件版本并对每个 DSH 版本做兼容验收 | 推荐的首个可选 Workbench 预设 |
| `@linxin666/dsh-web-all` / `dsh-web` | 标准 Profile 的聚合 Bundle，不改 DSH 源码 | Task board、Git graph、skins、mobile remote、SSH、社区插件入口，并聚合 `dsh-better-sidebar` | 中到高；依赖多、升级面大，其文档明确记录了 DSH 客户端接口变更和聚合包依赖未刷新的修复路径 | 不作为默认项；仅作为用户自选的实验性扩展 |
| `dsh-web-workbench` | 向指定 DSH 源码提交应用 patch | 右侧 Workbench、终端、时间线等 | 高；依赖精确上游源码基线，DSH 高频更新会产生 patch 维护成本 | 明确排除 |

## 3. 各层职责不能混淆

```text
DSH 官方 Web UI
  └── Agent、会话、工作区与模型操作

可选 Workbench Bundle
  └── 文件、终端、Git、预览等开发效率能力

DSH Server Kit
  └── 登录、HTTP/WebSocket 防护、容器、Volume、健康检查、升级和回滚
```

Server Kit 的 Gateway 必须在所有 UI Bundle 之前处理认证；UI 插件不得另开公网端口，也不能成为绕过 Gateway 的远程访问通道。

## 4. 推荐的首发 UI 策略

1. 基础镜像只启动官方 `dsh web`，并且 DSH 只绑定容器 loopback。
2. Server Kit 的登录页成功后，反向代理到官方 DSH Web UI；不复制、不 fork、不改写其前端。
3. `dsh-better-sidebar` 作为首个候选的“Workbench 预设”：只有在选定的 DSH 版本组合通过真实浏览器验收后，才提供带精确版本号的安装说明或专用镜像 tag。
4. `dsh-web-all` 保持用户自行安装；它包含 remote Web / SSH 等额外能力，必须先完成依赖、路由、权限和升级审查，不能因界面成熟而直接进入 Server Kit 基础发行版。
5. 禁止任何运行时的 `@latest` 安装或自动更新 UI Bundle。每个受支持的组合都必须记录：Server Kit、DSH、UI Bundle 的精确版本和兼容状态。

## 5. UI Bundle 兼容验收

每一个“DSH 核心版本 × UI Bundle 版本”组合至少证明：

```text
全新 Profile 安装 Bundle
↓
Gateway 登录后加载 UI
↓
HTTP API、WebSocket、SSE 正常
↓
工作区、文件预览、终端和 Git（若 Bundle 声称提供）可用
↓
重启后 Profile 与设置仍可加载
↓
以旧 Profile 挂载新 DSH 镜像
↓
Bundle 要么可验证地修复并启动，要么 fail closed 且保留旧状态以便回滚
```

## 6. 当前待确认决策

- 是否在首发时就提供 `dsh-better-sidebar` 的官方兼容预设，还是先只交付官方 Web UI + Server Gateway；
- 若提供预设，采用“独立的、版本锁定的镜像 tag”还是“由用户在 DSH Settings / Terminal 中显式安装”的分发方式；
- 是否把 `dsh-web-all` 仅列为兼容性实验对象，或未来建立经过审计的、独立 UI 扩展仓库。
