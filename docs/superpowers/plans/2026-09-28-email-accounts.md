# S2a 邮箱账号与小组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本计划由同一会话内联执行（用户要求自主推进、少开 subagent），因此只写接口、文件和测试用例，不预先誊写全部代码。

**Goal:** 服务器版改为邮箱注册（站点邀请码 + Resend 验证码）和自建小组，并部署到 mov.nestudy.cn。

**Architecture:** 账号、小组、会话、验证码放在网关自己的 `<data>/site.db`，按小组把 `/api/*` 转发给该组的 app 实例（S2 的实例结构不变）。发信走 `Mailer` 接口（Resend / 发件箱文件 / 未配置）。前端在服务器版用登录注册页、建组入组页和账号菜单取代口令页。

**Tech Stack:** TypeScript、Hono、node:sqlite、node:crypto（scrypt）、React 19、TanStack Query、vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-28-email-accounts-design.md`

## Global Constraints

- 不新增依赖；发信用全局 `fetch`。
- 密钥只从环境变量读（`STORYSCRIPT_RESEND_API_KEY`），不进日志、不进前端、不进 `site.db`。
- 邀请码 `sdszmovie` 不写进仓库，只在服务器上设置，存 sha256。
- 单机版行为、路由和测试不变。
- 洁净室：自己写，不拷其他项目；产品里不出现导演、片名和 IMAX。
- 版本 S2a：在 README 版本表最上方加一行，并同步 version 徽章。
- 只做本地提交，不 push、不 npm publish。

---

### Task 1: 契约与错误码

**Files:** Modify `packages/contracts/src/common.ts`、`packages/contracts/src/api.ts`

**Produces:**
- `ErrorCode` 新增 `ACCOUNT_EXISTS`、`NO_TEAM`、`MAIL_FAILED`。
- 输入：
  - `RegisterCodeInput {email, invite}`；`RegisterInput {email, code, name, password}`；
  - `PasswordLoginInput {email, password}`；`EmailOnlyInput {email}`；`CodeLoginInput {email, code, new_password?}`；
  - `ChangePasswordInput {current, next}`；
  - `CreateGroupInput {name}`；`JoinGroupInput {code}`；`DisbandGroupInput {confirm: true}`。
- 输出：
  - `GroupMember {id, name, role: 'leader'|'member', joined_at, you}`；
  - `GroupView {slug, name, join_code, role, members}`；
  - `AccountMe {email, name, group: GroupView|null}`；
  - `GroupPreview {name, members: number}`。
- `Api` 路由：
  - 账号：`registerCode` POST /api/v1/account/register/code、`register` POST /api/v1/account/register、`passwordLogin` POST /api/v1/account/login、`loginCode` POST /api/v1/account/login/code、`codeLogin` POST /api/v1/account/login/verify、`me` GET /api/v1/account、`changePassword` POST /api/v1/account/password；
  - 小组：`createGroup` POST /api/v1/group、`previewGroup` POST /api/v1/group/preview、`joinGroup` POST /api/v1/group/join、`leaveGroup` POST /api/v1/group/leave、`resetGroupCode` POST /api/v1/group/code、`removeGroupMember` DELETE /api/v1/group/members/:id、`disbandGroup` POST /api/v1/group/disband。
- 邮箱规则：trim、小写、≤ 254、`^[^\s@]+@[^\s@]+\.[^\s@]+$`。
- 其他长度：密码 8–128；昵称和组名 1–20（trim）；验证码 `^\d{6}$`。

- [ ] 加 schema、跑 `npm run typecheck`、提交。

### Task 2: site.db、密码、限流

**Files:**
- Create：`apps/server/src/hosted/site-db.ts`、`apps/server/src/hosted/passwords.ts`、`apps/server/src/hosted/limiter.ts`（从 sessions.ts 移出 `LoginLimiter`，另加 `WindowCounter`）。
- Delete：`apps/server/src/hosted/sessions.ts`。
- Test：`apps/server/test/hosted-site-db.test.ts`。

**Produces:**
- `openSiteDb(dataDir): SiteDb`，表见 spec，`user_version = 1`，文件 0600。
- 账号：`createAccount`、`accountByEmail`、`accountById`、`listAccounts`、`deleteAccount`、`setPassword`、`setMembership(accountId, slug|null, role|null)`。
- 小组：`createTeam`、`teamBySlug`、`teamByJoinCode`、`listTeams`、`deleteTeam`、`members(slug)`、`setJoinCode`。
- 会话：`createSession(accountId): string`（返回 cookie 值，只存 sha256）、`sessionAccount(id): Account|null`（顺带清掉过期的）、`revokeSession`、`revokeOtherSessions(accountId, keepId)`。
- 验证码：`putCode(email, purpose, hash, expiresAt)`、`takeCode`（带次数）、`logMail(email, ip, purpose, at)`、`mailCounts(...)`。
- `hashPassword(pw): Promise<string>`，格式 `scrypt$16384$8$1$salt$hash`；`verifyPassword(pw, stored): Promise<boolean>`。

**Tests:** 建号和查重（大小写）；会话往返、过期和注销；验证码过期、错 5 次作废；密码哈希往返、错密码为 false、两次哈希不同。

### Task 3: 发信与模版

**Files:**
- Create：`apps/server/src/hosted/mail/mailer.ts`、`apps/server/src/hosted/mail/templates.ts`、`apps/server/scripts/mail-preview.ts`；根 `package.json` 加脚本 `mail:preview`。
- Test：`apps/server/test/hosted-mail.test.ts`。

**Produces:**
- `interface Mailer { readonly kind: 'resend'|'outbox'|'none'; send(m: {to, subject, html, text}): Promise<void> }`。
- 实现：`resendMailer({apiKey, from, fetch?})`、`outboxMailer(dir)`、`noMailer()`；`mailerFromEnv(env, from)`。
- `codeEmail({purpose: 'register'|'login', code, siteName, origin, minutes}) → {subject, html, text}`。

**Tests:**
- Resend 请求形状：URL、Bearer、from、to、subject、html、text。
- 非 2xx 抛 `MAIL_FAILED`，且消息里不含 key。
- 超时抛 `MAIL_FAILED`。
- 发件箱写出 JSON。
- 模版转义站点名里的 `<script>`，纯文本里有验证码。

### Task 4: 账号与小组服务、网关、启动

**Files:**
- Create：`apps/server/src/hosted/accounts.ts`、`apps/server/src/hosted/groups.ts`、`apps/server/src/hosted/teams.ts`。
- Rewrite：`apps/server/src/hosted/gateway.ts`、`apps/server/src/hosted/start.ts`、`apps/server/src/hosted/config.ts`（version 2）。
- Test：重写 `apps/server/test/hosted-server.test.ts`，新增 `apps/server/test/hosted-accounts.test.ts`。

**Behaviour:** 见 spec「用户流程」「安全与限额」。

**Tests（HTTP，经 startHostedServer，发件箱读验证码）：**
- 邀请码错：403，不发信。
- 注册全流程：设 cookie；`me` 无小组；`/api/v1/health` 返回 409 NO_TEAM。
- 已注册的邮箱再注册：409 ACCOUNT_EXISTS。验证码错 5 次作废。验证码过期（注入时钟）。
- 60 秒内重发：429。每日上限：429 QUOTA_EXCEEDED。
- 密码登录：错密码 401，连错 10 次 429。
- 验证码登录并设新密码：旧密码失效，其他会话被注销。
- 建组：`health` 返回 200、`team_name` 为组名。加入：两人看到同一个项目。
- 换组（离开 A 加入 B）；组长移交；组长移除组员后，该组员下次请求得到 NO_TEAM。
- 解散只在只剩一人时可用，并删除目录；组员上限、组数上限。
- 两组数据隔离。
- Host/Origin 检查保留；服务器版 `POST /api/v1/session` 返回 404；拒绝列表（S2）仍然生效。
- 重启后会话和小组都还在。

### Task 5: 管理命令

**Files:**
- Rewrite：`apps/server/src/hosted/cli.ts`。
- Test：放在 `hosted-server.test.ts` 的 CLI 部分。

**Commands:** 见 spec「管理命令」。`mail test` 用 `mailerFromEnv` 发信。

**Tests:**
- 缺少 `--invite` 或 `--mail-from` 时 init 失败。
- `invite set` 在服务运行时拒绝。
- `user list`、`user remove` 后该账号的会话失效。
- `team remove` 在服务运行时拒绝，停服后执行时保留文件。

### Task 6: 前端

**Files:**
- Create：`apps/web/src/components/AccountScreens.tsx`（AuthScreen、GroupScreen）、`apps/web/src/components/AccountMenu.tsx`（菜单、GroupDialog、PasswordDialog）、`apps/web/src/lib/join.ts`（从 `#join=` 读出组码、暂存到 sessionStorage）。
- Modify：`App.tsx`、`TitleBar.tsx`、`lib/session.ts`（BootResult 加 `no-team`）、`lib/errors.ts`（新码和 `sign-in` 语境）、`components/FullScreenNotice.tsx`（删掉口令页）。
- Test：`apps/web/test/at17-session-bootstrap.test.ts` 加 no-team；新增 `apps/web/test/join-link.test.ts`。

### Task 7: 端到端与文档、版本

**Files:**
- Modify：`e2e/support.ts`（startHostedApp 用发件箱，加 `signUp` 助手）、`e2e/hosted-media.spec.ts`。
- Create：`e2e/hosted-accounts.spec.ts`。
- Docs：`docs/SERVER.md`、`README.md`（S2a 行、徽章）、`docs/PLAN.md` 的状态行。

**Steps:** 跑 typecheck、`npx vitest run`、全部 e2e、`npm run smoke:install`，然后提交 S2a。

### Task 8: 部署到 mov.nestudy.cn

**Steps:**
1. 在本机 `npm run build` 并 `npm pack`。
2. 在服务器上建 `storyscript` 用户和各目录，下载 Node 24 并校验 SHA-256。
3. 把包上传到 `/opt/storyscript-mov/app`，`npm install --omit=dev`。
4. `server init --origin https://mov.nestudy.cn --invite sdszmovie --mail-from noreply@mov.nestudy.cn --port 4700`。
5. 写 env 模版和 systemd unit，启动服务，确认本机 `curl 127.0.0.1:4700/api/v1/site`。
6. 写 Caddy 站点文件，`caddy validate` 通过后 reload；确认其他站点仍然返回 200。
7. 等用户配好 DNS 和 key 之后，检查 HTTPS 和发信（`mail test` 发给用户同意的地址）。
