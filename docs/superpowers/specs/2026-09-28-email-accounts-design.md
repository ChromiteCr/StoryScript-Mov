# S2a 设计：服务器版的邮箱账号与小组

日期：2026-09-28　状态：已确认，实施中

## 目标

服务器版（`storyscript-mov server`）不再用管理员发的队伍口令登录，改为：

- 用邮箱注册，注册时必须填站点邀请码（由管理员在服务器上设置，仓库里不出现）。
- 邮箱验证码经 Resend 发送，发件人 `StoryScript-Mov <noreply@mov.nestudy.cn>`，邮件模版单独设计。
- 登录：邮箱加密码，或邮箱加验证码（也用于忘记密码时设新密码）。
- 学生自己建小组、用链接或组码加入；一个小组共用一个项目；一人同时只在一个组。

单机版（`npx storyscript-mov`）完全不变。

## 用户流程

- **注册**：邮箱 + 邀请码 → 服务器校验邀请码（错了不发信）→ 发 6 位验证码（10 分钟有效）→ 填验证码、昵称、密码（≥ 8 位）→ 账号建成并登录。
- **登录**：「密码登录」或「验证码登录」。验证码登录的表单可以顺带填新密码（「忘记密码？」进入的就是它）。
- **小组**：
  - 登录后没有小组 → 「创建小组」（组名）或「加入小组」（粘贴 `…/#join=XXXX-XXXX` 链接或组码）。
  - 创建者是组长：看组员、移除组员、换组码。组员可以退出。
  - 组长退出时，组长交给最早加入的组员。只剩组长一人时，只能「解散小组」（二次确认后删除该组项目）。
  - 已在组里的人打开别组的加入链接：弹窗确认「离开 A 组并加入 B 组」。只剩自己一人的组要先解散。
- **账号菜单**（标题栏右侧）：昵称和组名、小组…、修改密码…（要当前密码）、退出登录。

## 服务器结构

```
<data>/server.json      站点设置（version 2）：public_origin、端口、时区、invite_sha256、mail.from、limits
<data>/site.db          账号、小组、会话、验证码、发信记录（node:sqlite，WAL，0600）
<data>/teams/<slug>/    小组项目（与 S2 相同：project/、state/）
```

`site.db` 表：

| 表 | 字段 |
|---|---|
| `teams` | slug PK、name、join_code UNIQUE（明文，组员都能看到）、created_at |
| `accounts` | id PK、email UNIQUE（小写）、name、password_hash、created_at、team_slug、team_role（leader/member）、joined_at |
| `sessions` | id_hash PK（sha256）、account_id、created_at、expires_at（30 天） |
| `email_codes` | (email, purpose) PK、code_hash、expires_at、attempts、created_at |
| `mail_log` | email、ip、purpose、sent_at（限流和每日上限用） |

- **网关**（`hosted/gateway.ts`）：处理 `/api/v1/site`、`/api/v1/account/*`、`/api/v1/group/*`、`DELETE /api/v1/session`（退出）。其余 `/api/*` 在每次请求时由 cookie → 账号 → 当前小组找到实例后转发：未登录 401；没有小组 409 `NO_TEAM`。`POST /api/v1/session`（单机版的 token 换 cookie）在服务器版返回 404。
- **小组实例**：启动时为每个小组打开实例；建组时当场创建（ProjectSession + createApp），解散时关闭并删除目录。每组的模型调用上限（S1c）不变。
- **发信**：`Mailer` 接口，三种实现：
  - Resend：`fetch` POST `https://api.resend.com/emails`，10 秒超时，不重试；key 只从 `STORYSCRIPT_RESEND_API_KEY` 读取。
  - 发件箱：设置 `STORYSCRIPT_MAIL_OUTBOX=<目录>` 时把邮件写成 JSON 文件，供测试和试用。
  - 未配置：返回 `MAIL_FAILED`「服务器还没配置发信」。
- **邮件模版**（`hosted/mail/templates.ts`）：注册验证码、登录验证码两封。表格布局、内联样式、HTML 加纯文本，所有文本转义；验证码放在 2.39 画幅的框里（与应用图标同一母题）。`npm run mail:preview` 输出 HTML 供检查。

## 安全与限额

- 密码：scrypt（N=16384，r=8，p=1），每个账号单独加盐，恒定时间比较；改密码后注销该账号其他会话。
- 验证码：6 位，只存哈希，10 分钟有效，错 5 次作废。
- 发信限流：
  - 同一邮箱 60 秒 1 封、1 小时 5 封；
  - 同一 IP 1 小时 20 封；
  - 全站 24 小时 `limits.emails_per_day`（默认 100，对应 Resend 免费档）。
- 登录失败限流：沿用 LoginLimiter，按 IP 和按邮箱各 15 分钟 10 次；输错组码也计入。
- 邀请码只存 sha256，恒定时间比较。
- Cookie：HttpOnly、SameSite=Strict，https 下 Secure。
- 小组上限：`limits.max_teams`（60）、`limits.max_team_members`（12）。
- 新错误码：`ACCOUNT_EXISTS`、`NO_TEAM`、`MAIL_FAILED`。

## 管理命令

```
server init --data <目录> --origin <地址> --invite <邀请码> --mail-from <地址> [--port] [--listen] [--name] [--timezone]
server invite set <邀请码>        （需先停服务）
server user list | user remove <邮箱>
server team list | team remove <代号>   （remove 需先停服务；项目文件保留）
server mail test <邮箱>           发一封测试邮件
server start
```

移除：`team add`、`team reset`、队伍口令登录、`sessions.json`。S2 未在任何地方部署，无需迁移；version 1 的 server.json 会提示重新 init。

## 测试

- 服务端：账号（注册、邀请码、验证码过期和次数、密码和验证码登录、改密码）、限流和每日上限、小组（创建、加入、换组、组长移交、移除、解散、上限）、两组互相隔离、Resend 请求形状（假 fetch）、模版转义。
- 端到端：用 UI 注册 → 建组 → 另一个浏览器用加入链接注册并入组 → 两人看到同一个项目；验证码从发件箱目录读取。`hosted-media` 规格改用新登录。
- 单机版全部原有测试保持为绿。

## 部署（mov.nestudy.cn）

- 专用系统用户 `storyscript`。
- 专用 Node 24：`/opt/storyscript-mov/node`，从 nodejs.org 下载并校验 SHA-256。
- 程序：`/opt/storyscript-mov/app`，由本机打包上传，不在服务器上构建。
- 数据：`/var/lib/storyscript-mov`，权限 700。
- 密钥：`/etc/storyscript-mov/env`，权限 640，由用户填写。
- 进程：`storyscript-mov.service`，监听 127.0.0.1:4700，MemoryMax 768M，systemd 沙箱。
- 反向代理：`/etc/caddy/sites/mov.caddy`，先 validate 再 reload。
- 不读写其他项目的目录、配置和密钥。
