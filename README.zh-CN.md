# Codex Reset Request — Codex 用量限制监控工具

一个事件驱动的本地 Codex usage limits monitor：检测并确认 Codex 用量限制或
rate limit 事件，并可选择通过 Bird，使用用户现有的 X 浏览器登录会话发送一条
可自定义的 reset request。

- 不轮询
- 不需要 X Developer API key
- 不需要 OpenAI API key
- 运行时不产生 LLM inference calls
- 自动发帖必须由用户明确开启

本工具不会重置你的 Codex 账号，也不保证任何人会提供 reset。

> **公开开发中的 alpha——源码可供审查，但不代表认可真实自动发帖。**X 目前的
> Automation Rules 禁止脚本化 X 网站；这个 Bird 衍生版本使用未公开的 web
> GraphQL，而不是官方 X API。在独立解决 [DISCLAIMER.md](DISCLAIMER.md) 和
> [release checklist](docs/public-release-checklist.md#live-operation-policy-blockers)
> 中的真实运行要求前，请保持 `dry-run` 模式。

[English](README.md)

## 工作方式

```text
Codex rollout append
        ↓
原生文件系统事件
        ↓
严格 UsageLimit 分类器
        ↓
Codex App Server 确认
        ↓
去重 + rate guard
        ↓
Bird 目标帖子选择
        ↓
预期 X 账号验证
        ↓
一次 mutation attempt
        ↓
sent / definitive failure / unknown
```

watcher 只在操作系统报告文件变化时被唤醒，只增量读取 rollout JSONL 新增的
字节。它仅接受限定结构中的 Codex usage-limit error，然后临时启动本地 Codex
App Server，调用 `account/rateLimits/read` 进行二次确认。空闲时不会进行 X
请求、App Server 调用或 LLM 调用。

第一次启动时，已有 rollout 文件的 cursor 会定位在 EOF，因此历史错误不会触发
动作；之后新建的 rollout 文件从 byte 0 读取。partial line、truncate、replace、
新日期目录、restart 和重复 limit window 都采用保守处理。

更多细节见[架构](docs/architecture.md)和
[ADR](docs/adr/0001-public-bird-fork.md)。

## 要求

- Node.js 22 或以上
- pnpm（可通过 Corepack 使用）
- 已正常登录的 Codex CLI；本 alpha 实测版本为 `0.140.0`
- Bird 可读取的 Safari、Chrome 或 Firefox X 登录会话
- macOS 或 Linux 才支持托管后台服务
- Windows v0.1 支持前台 `watch`，不支持自动启动服务

Bun 仅是上游 Bird standalone binary 的可选构建工具，不是普通安装或运行依赖。

## 致谢与许可证

简短但必要的署名：本仓库衍生自公开项目
[`0xEnc0der/bird-x-cli`](https://github.com/0xEnc0der/bird-x-cli)，并保留 Git
上游历史和 MIT 署名。secondary upstream 是
[`zaydiscold/bird`](https://github.com/zaydiscold/bird)，原始 `jawond/bird`
由 Peter Steinberger 实现。

基线 commit 是 `a16f9901717008bf1ab3ea0b715dfd95dedc95b0`。见
[UPSTREAM.md](UPSTREAM.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
和 [LICENSE](LICENSE)。上游 `bird` binary 继续保留用于诊断；
`codex-reset-request` 是独立的 guarded workflow。

## 从源码安装

本 alpha 暂不发布 npm package。

```bash
git clone https://github.com/ncihxaonn/codex-reset-request.git
cd codex-reset-request
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
```

确认两个 CLI：

```bash
codex-reset-request --help
bird --help
```

拉取源码更新后重新运行 `pnpm build`。service definition 会固定安装时的 Node
binary 和已构建 CLI 绝对路径；如果移动 checkout 或更换 Node，请重新运行
`codex-reset-request service install`。

## 登录要求

### Codex

先正常运行 `codex` 并完成登录。工具只读 `$CODEX_HOME/sessions` 下的 rollout，
并与临时本地 Codex App Server subprocess 通信。它不会打开
`~/.codex/auth.json`、不会修改 Codex session，也不需要 OpenAI API key。

确认 client 只调用 initialize 和 `account/rateLimits/read`，不会调用
`thread/start` 或 `turn/start`，因此不会创建 Codex conversation 或 inference
turn。

Codex home 优先级：

```text
CRR_CODEX_HOME → config.codexHome → CODEX_HOME → ~/.codex
```

setup 会保存实际通过 preflight 的路径，保证后台服务监听同一个 Codex home。

### X 浏览器会话

在配置的 Safari、Chrome 或 Firefox profile 中登录 `x.com`。Bird 通过本地
browser-cookie provider 读取 `auth_token` 和 `ct0`，仅在内存中使用；不会把
它们写入本项目的 config、state 或 logs。

上游 Bird 的前台兼容模式可以使用环境变量凭据，但本项目的后台服务会拒绝
“仅环境变量”凭据：launchd/systemd 不应保存 secrets，也不会可靠继承安装命令
所在 shell 的变量。

## 一键安装并部署（macOS 与 Linux）

从源码安装 CLI 后，执行这一条命令即可完成 preflight、记录必要同意，并安装和启动
已开启自动 X 回复的事件驱动用户后台服务：

```bash
codex-reset-request install
```

用 `--reply-text` 自定义回复内容。自动回复仍须完成明确的风险确认；随时可用
`codex-reset-request disable-auto` 关闭。本项目不包含本地 OS 通知功能：

```bash
codex-reset-request install --reply-text "Please reset my Codex limit"
```

Windows 不支持后台 service，请先用 `setup`，再以前台方式运行 `watch`。

## Setup 与模式

默认从不写入的模式开始：

```bash
codex-reset-request setup
```

setup 会检查 Node、Codex App Server rate-limit 读取、当前 X 账号和目标帖子；
显示 disclaimer；保存预期 X handle；默认写入 `dry-run`。

- `dry-run`：检测并确认事件，但不发帖。
- `auto`：只有完成精确风险确认后，才允许 guarded reply。

```bash
codex-reset-request enable-auto
codex-reset-request disable-auto
```

`enable-auto` 会重新检查 App Server、当前账号和目标读取，并要求逐字输入：

```text
I UNDERSTAND THE X ACCOUNT RISK
```

disclaimer 版本改变、账号不匹配、consent 被撤销、mutation 边界前配置改变、
dedup 命中或 rate guard 命中，都会阻止写入。

安装 service 之前，可在前台运行：

```bash
codex-reset-request watch
```

这是在 terminal 中观察 dry-run 的正常方式。使用 `Ctrl-C` 停止；shutdown
会保存 cursor/audit state 并释放 single-instance lock。

## 诊断、状态与日志

```bash
codex-reset-request doctor
codex-reset-request status
codex-reset-request status --json
codex-reset-request logs --tail 100
```

`doctor` 使用 `PASS / WARN / FAIL` 检查 runtime、Codex 兼容性、sessions、
App Server、X read、原生 watcher、无轮询设计、config/state、service、
single-instance lock 和 consent。输出只包含 safe code，不打印 cookie、token、
prompt、完整 rollout record 或原始 GraphQL body。

不访问网络、不写 state 的 synthetic test：

```bash
codex-reset-request test trigger
```

CI 永远不运行 live X test。只读测试必须明确设置 gate：

```bash
CRR_LIVE_X=1 codex-reset-request test x-read
```

这项只读检查会读取当前 X 账号，以及硬编码安全目标 `@thsottiaux` 的公开账号与帖子
元数据；它不会执行写操作。

真实写测试只能回复当前账号自己拥有的测试帖子。先停止 watcher，以便测试命令
取得 single-instance lock：

```bash
CRR_LIVE_X=1 codex-reset-request test x-reply \
  --url https://x.com/<YOUR_HANDLE>/status/<YOUR_POST_ID> \
  --live
```

命令会从服务器读取帖子，同时核对 author ID、handle、当前账号和 setup 保存的
账号；明确拒绝 `@thsottiaux`；应用 rolling guard；先原子保存 mutation marker；
只允许一次 POST。结果不明确时只允许一次只读验证，之后保持 `unknown`，不重试。

## 后台服务

先 build、完成 setup，并确认后台可读取浏览器 cookie：

```bash
codex-reset-request service install
codex-reset-request service status
codex-reset-request service start
codex-reset-request service stop
codex-reset-request service restart
codex-reset-request service uninstall
```

macOS 使用
`~/Library/LaunchAgents/io.github.ncihxaonn.codex-reset-request.plist`；Linux 使用
XDG user unit `~/.config/systemd/user/codex-reset-request.service`。两者都没有
scheduled `StartInterval`、`CalendarInterval`、systemd timer 或 cron。launchd
的 `ThrottleInterval=5` 只是 restart backoff，不是 quota polling。stop 会抑制
当前托管进程；uninstall 会先 unload/disable，再删除精确的 definition。即使
definition 被手工删除，仍会查询 manager 状态并报告 drift。

Windows service 命令会明确返回 unsupported。请使用：

```powershell
codex-reset-request watch
```

## 配置与 rate guard

```bash
codex-reset-request config show
codex-reset-request config set maxAttemptsPer24Hours 1
codex-reset-request config reset
```

不要直接设置 `mode=auto`，请使用 `enable-auto`。配置上限可设为 0–3，任何
rolling 24 hours 的硬上限始终是 3，默认是 1。`attempting`、`unknown` 或带有
mutation marker 的记录在重启后仍然占用 guard。

## 数据位置

| 平台 | Config | State | Logs |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/codex-reset-request/config.json` | `~/Library/Application Support/codex-reset-request/state/` | `~/Library/Logs/codex-reset-request/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/codex-reset-request/config.json` | `${XDG_STATE_HOME:-~/.local/state}/codex-reset-request/` | state 目录下的 `logs/` |
| Windows | `%APPDATA%\codex-reset-request\config.json` | `%LOCALAPPDATA%\codex-reset-request\` | state 目录下的 `logs\` |

可用 `CRR_CONFIG_DIR`、`CRR_STATE_DIR`、`CRR_LOG_DIR` 覆盖。后台 service 要求
所有 override 都是绝对路径。Unix 下应用目录使用 `0700`，config、state、
cursor、audit、lock 和 service definition 在支持时使用 `0600`。

state/cursor JSON 有 4 MiB 安全上限。guard 历史不会被静默淘汰，因为删除记录
可能造成重复写入。达到上限时必须先停止 watcher、完整归档 state 目录，再由
operator 明确决定如何处理。见[故障排查](docs/troubleshooting.md)。

redacted audit log 的上限为 16 MiB；service stdout/stderr logs 没有应用内
rotation。请按本地政策，在 watcher/service 停止时检查、轮换或删除精确 log 文件。

## 隐私与安全

项目不包含 telemetry、analytics、crash-report service、remote storage、proxy
rotation 或 runtime LLM calls。它只读取新追加的 Codex rollout bytes，以及 X
认证所需的本地浏览器 cookies；redacted audit events 保留在本机。

这不等于“完全离线”：setup、doctor、显式 live test 和确认后的 action 可以发起
X web requests；App Server 确认使用依赖现有 Codex 登录的本地 subprocess。见
[隐私说明](docs/privacy.md)、[threat model](docs/threat-model.md)和
[安全政策](SECURITY.md)。

本项目不会发送本地 OS notification；状态只保存在 CLI、state 和本地 redacted
logs 中。

Bird 使用未公开的 X web GraphQL endpoints。公开源码并不代表真实自动化获准。
X 目前的
[Automation Rules](https://help.x.com/en/rules-and-policies/x-automation) 禁止非 API
方式脚本化 X 网站，因此当前实现不适合按原样真实自动运行；免责声明不能消除这项
冲突。

## 免责声明（准确中文翻译）

Codex Reset Request 是独立、非官方的开源项目。它不隶属于 OpenAI、ChatGPT、
Codex、X Corp.、Tibo 或 Bird 维护者，也未获得这些主体的认可、赞助或运营。

本软件不会重置 Codex 或 ChatGPT 账号、不会授予额外用量，也不保证有人提供
reset。它只检测本地 Codex 用量限制事件，并在用户明确启用后，尝试通过用户
现有的、已认证的 X 浏览器会话发送配置的回复。

软件不需要 OpenAI API key 或 X API key，运行时不进行 LLM inference calls；
但仍然需要现有 Codex 认证和已认证的 X 浏览器会话。Bird 和本项目使用未公开的
X web GraphQL endpoints，它们可能随时变化或停止工作。

非 API 浏览器/网站自动化以及未经请求的自动回复，可能违反 X 的条款、自动化
规则、spam policy 或其他适用规则。使用本软件可能导致发帖失败、重复或意外
活动、内容移除、可见度降低、rate limit、账号限制或封禁。免责声明不能覆盖、
豁免任何平台规则。

用户必须自行审查并遵守适用的平台条款、法律、工作场所政策、账号安全义务及
其他要求，并对其账号执行的每个动作负责。禁止将本软件用于批量回复、协同活动、
骚扰、spam、欺骗性互动、多账号自动化、CAPTCHA bypass、anti-bot bypass、
规避 rate limit 或逃避平台保护措施。

本软件按“原样”提供，不附带任何形式的保证；使用风险完全由用户承担。英文完整
版本以 [DISCLAIMER.md](DISCLAIMER.md) 为准。

## 卸载与完整数据删除

先撤销 auto 并卸载 service：

```bash
codex-reset-request disable-auto
codex-reset-request service uninstall
pnpm remove --global codex-reset-request
```

uninstaller 不会自动删除 source checkout 或应用数据。确认 service 已停止后，
使用操作系统文件管理器，只删除上表列出的精确 config、state、log 路径；源码
checkout 另行删除。不要删除 `$CODEX_HOME`：它属于 Codex，不属于本工具。

## 已知限制与兼容性

- 工具只能发送 request，不能执行 reset 或增加用量。
- 工具不会调用 `account/rateLimitResetCredit/consume`；官方 reset-credit
  redemption 不属于 v0.1。
- v0.1 只有一个配置目标和一段回复文本。
- X 未公开 endpoint 和 response shape 可随时变化。
- 实测 Codex `0.140.0`；其他版本标记为 untested，schema 不兼容时 fail closed。
- 原生 watcher 是否可用取决于文件系统；没有 polling fallback。
- macOS/Linux 支持 user service；Windows 仅前台运行。
- 无法保证所有文件系统上的检测延迟。
- disclaimer 不会覆盖 X 规则、公司政策或法律。

详见[兼容性矩阵](docs/compatibility.md)和[故障排查](docs/troubleshooting.md)。

## 贡献

欢迎在本项目刻意收窄、local-first 的范围内贡献。请阅读
[CONTRIBUTING.md](CONTRIBUTING.md) 和
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。issue 中不得附上 credentials、
browser DB、原始 rollout、prompt 或未脱敏错误 body。live write test 只能针对
测试者自己的帖子，而且必须显式开启。
