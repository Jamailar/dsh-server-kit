# DSH Server Kit

把上游 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装为可部署、可升级的单管理员服务器发行版。

它不是新的 DSH UI 或 Gateway。DSH 提供 UI 与 Agent runtime；`dsh-auth-gate` 负责登录、会话以及 HTTP/WebSocket 守卫；Caddy 只提供安全反代；本仓库只负责不可变依赖、首启、健康状态、升级检查与部署契约。

## 当前发行组合

| 层 | 固定版本 |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.1.2-rc.1` |
| 认证 | `dsh-auth-gate@0.12.0`，密码模式、Secure Cookie、可选 TOTP |
| 可选工作台 | `dsh-better-sidebar@0.18.0` |
| Node | `24.14.0` |
| Caddy | `2.10.2` |

全部 npm 依赖通过提交的 `pnpm-lock.yaml` 锁定，并由 `pnpm@10.33.0` 构建；基础镜像以 digest 锁定。运行时绝不执行 `npm install`、`pnpm add` 或下载社区插件。

## 信任边界

```text
HTTPS / Coolify / Traefik
        │ :8080
        ▼
      Caddy ── /healthz, /readyz, /versionz → status :9000
        │
        └── 保留公开 Host、移除外部转发标记 → DSH :3080 (127.0.0.1)
                                                       │
                                                       └── Auth Gate: page + API + WS
```

首次 Web 初始化会保存一个准确的公开 authority，例如 `dsh.example.com` 或 `dsh.example.com:8443`。启动器随后把它传给 DSH 的 `--trusted-host`，而 Caddy 保留浏览器的 `Host` 供 DSH 自己的 browser-trust fence 验证。不要使用 `https://`、路径、通配符或多个域名。

Caddy 也会在入口以 `421` 拒绝任何不等于该 authority 的 `Host`。这个 authority 在首次 Web 初始化时持久化，之后由启动器自动提供给 DSH 与 Caddy，无需持续配置环境变量。

端口 `3080` 与 `9000` 从不发布。Caddy 删除客户端伪造的 `Forwarded`、`X-Forwarded-*`、`X-Real-IP` 和 `X-Dsh-Proxy`。因此登录限流应同时在 Coolify/Traefik/Cloudflare 边缘配置；Auth Gate 在容器内看到的是 Caddy，而非真实客户端 IP。

## 部署

1. 创建一个持久卷并挂载到 `/data`。认证、运行配置和工作区分别位于 `/data/dsh`、`/data/dsh-server`、`/data/workspace`。
2. 仅发布容器 `8080`，在 Coolify 配置 HTTPS 域名。
3. 首次启动后，打开该 HTTPS 域名的 `/setup`，输入域名、管理员用户名和密码。用户名须以字母或数字开头，只能含字母、数字、`.`、`_`、`-`，不能使用邮箱。
4. 向导会把域名与密码哈希用户记录写入持久卷，然后自动启动 DSH。等待 `GET /readyz` 返回 `200` 后登录。

如果已按旧配置创建过三个独立 Volume，升级前先创建 `/data` 的快照，并将旧的 `dsh-home`、`dsh-server`、`dsh-workspace` 内容分别复制到新 Volume 的 `dsh`、`dsh-server`、`workspace` 子目录。不要把空的 `/data` 挂到已有实例上，否则它会被当作新实例初始化。

本地构建命令：

```sh
docker compose up --build -d
# 完成 /setup 后：
curl -H 'Host: localhost:8080' http://127.0.0.1:8080/readyz
```

直接 HTTP 只适合检查健康状态，不能用于登录：认证 Cookie 强制 `Secure`。生产必须在 HTTPS 后面运行。

首次启动不需要环境变量，默认初始化页面也不显示一次性码。Web 向导通过 Auth Gate 自己的 CLI、使用 stdin 创建密码哈希用户记录；密码不会写入镜像、状态端点或日志；持久卷只保存 Auth Gate 的密码哈希记录和非敏感运行配置。

`DSH_SETUP_PROTECTION=code` 会重新启用保留在镜像内的一次性初始化码机制：代码只出现在首次容器日志，完成后删除。默认 `open` 模式应只在首次访问受控（例如先不公开 DNS 或限制平台访问）的部署中使用；如果域名已公开，任何第一个访问 `/setup` 的人都可创建管理员，生产部署应改用 `code` 模式。

浏览器不能安全、持久地改写 Coolify 的环境变量；因此向导保存的是 `/data/dsh-server/runtime-config.json`。之后的启动由 entrypoint 读取该文件并把可信域名传给 DSH/Caddy，达到“不再需要部署变量”的效果。已有旧部署若尚无此配置，可以保留一次 `DSH_TRUSTED_HOST` 启动后迁移；其值必须与持久化域名完全一致。

## 预置与边界

- `DSH_UI_PRESET=base`：上游 DSH Web UI + Auth Gate，默认且最小。
- `DSH_UI_PRESET=workbench`：在同一个安全边界内预装 `dsh-better-sidebar`。v0.1 仅验证其锁定构建与容器启动；在补上真实浏览器功能验收前，不标为生产支持预置。
- `dsh-web-all`：不在镜像中安装。它的 SSH、远程配对、计划任务等能力需在克隆 Volume 上单独审计；本项目不自动安装或升级它。

公开域名登录后，上游 DSH 仍把完整 Settings 编辑限制在 loopback origin。这是原生安全边界，不在本项目中用前端 patch 或 Host 伪造绕过。需要完整 Settings 编辑时，管理员使用 SSH 隧道或受控本机的 Auth Gate loopback proxy；该 proxy 不由 Caddy 暴露。

这是单一可信管理员、共享工作区实例，不是多用户隔离或多租户产品。

## 升级与回滚

每次升级只替换镜像，绝不覆盖 `/data`。启动前 `scripts/preflight-upgrade.mjs` 会检查 Profile 的依赖、bundle 顺序、锁文件和 Auth 配置 attestation；不匹配就 fail closed，不尝试“自动修复”或悄悄升级用户插件。

升级动作：先对 `/data` Volume 建快照 → 记录当前 image digest → 部署新 digest → 等待 `/readyz` → 验证匿名请求得到 `401` 与登录流程。失败时切回上一个 digest；持久卷不应被新镜像迁移或修改。

## 验证

```sh
node scripts/build-seed-profile.mjs --verify-only
node --test tests/unit/*.test.mjs
node tests/integration/contract.mjs
```

GitHub Actions 在 Node 24 下执行上述检查，并构建真实容器，确认 `readyz`、匿名 `401` 与 Auth Gate 状态端点。完整架构、组件准入和 Coolify 操作见 [执行计划](docs/EXECUTION_PLAN.md)。
