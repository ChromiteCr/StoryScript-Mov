# SPEC v0.1 — 开发预览版（coding agent 唯一需求依据）

> 本文件覆盖 `docs/SPEC.md`（原始完整规格，现为路线图）。**本文未列出的契约一律不实现**；与原规格冲突时以本文为准。
> 类型与字段的唯一事实来源是 `packages/contracts/src/`。本文只描述行为和边界。

## 1. 定位与范围

开源、本地运行的实拍分镜工作台。v0.1 的主线是：剧本 → 拆镜 → 分镜（结构线稿 + 宽银幕铅笔稿）→ 拍摄顺序 → 场记 → 素材关联 → 漏拍清单。四块最小闭环全部打通，拆镜和分镜做深。

- **形态**：一个 Node（≥24.15）进程，只监听 `127.0.0.1`，浏览器访问。启动方式为 `npx storyscript-mov` 或源码下 `npm start`。
- **平台**：只验证 macOS Apple Silicon + Chrome；Safari 尽力支持；Linux/Windows 未验证。
- **模型**：BYOK，文本走 OpenAI chat completions 协议。图像按主机名自动识别方言（§6），属于实验功能。
- **无 key 可用**：手工建镜头、出分镜（结构线稿与铅笔稿都不需要 key）、排期、场记、素材和导出全部可用；AI 按钮置灰并说明原因。

## 2. 不变量（每条都要有测试）

| ID | 规则 |
|---|---|
| INV-01 | 叙事顺序（`shot.narrative_pos`）与拍摄顺序（`plan.order/blocks`）分开存储；排期操作绝不修改叙事顺序。 |
| INV-02 | 主键一律用 UUID；显示编号（`shot.code`、`scene.display_no`）可改，但不承担身份。 |
| INV-03 | AI 输出只写入 `shot_draft`；只有 apply 才能进入正式表。apply 跳过 `locked` 镜头，并检查 `expected_revision`，冲突返回 409。 |
| INV-04 | 原片只读。项目数据和派生文件（海报帧等）只写进项目文件夹的 `.storyscript-mov/`（S1e 起项目是一个可打开的文件夹，素材放在其子文件夹）；视频文件和外部素材目录不产生任何新文件。 |
| INV-05 | 计划只有同时满足以下条件才能批准：`feasible`、校验器无违规、所有工时已确认、不 stale。启发式排不全时返回 `partial`，不等于"无解"。 |
| INV-06 | take↔shot、shot↔media 都是多对多；删除关联不删除文件，也不影响其他关联。 |
| INV-07 | 用 `origin`、`match`、`evidence`、`status` 区分 AI、人工和推断；不显示模型自报的置信度。 |
| INV-08 | 导入素材成功不等于备份成功；任何地方都不提示"可以格式化存储卡"。 |
| INV-09 | AI 栅格图与 BoardSpec、ShotFields 相互独立；必须人工采用；永不回写结构层。 |
| INV-10 | 剧本文本和模型输出都当数据处理：经 zod 与业务校验，渲染时转义；SVG 只由本项目的渲染器生成。 |
| COV | 覆盖状态只由 `core/coverage.computeCoverage` 计算，不落库。页面、API、CSV 调用的是同一个函数。 |
| SR | `source_range` 采用冻结结构：五个整数字段，区间为 `[in,out)`，time_base 必须与流一致（contracts/media.ts）。 |

## 3. 架构与目录归属

```
packages/contracts  zod schema 与类型（只依赖 zod）            ← 仅 lead 可改
packages/core       纯函数，零 IO（不得 import node:*、fetch 等）
apps/server         Hono + node:sqlite + ffmpeg 子进程 + openai SDK 适配器
apps/web            Vite + React 19 + TanStack Query + Tailwind 4
```

- **依赖方向**：web→core→contracts，server→core→contracts。
- **只有 lead 能改的内容**：`package.json`/`package-lock.json`、`packages/contracts`、`apps/server/src/db/migrations/`、README 版本表。
- **项目目录结构**：`project.json`、`project.sqlite`（WAL）、`project.lock`、`scripts/`、`boards/<board_id>/`、`derivatives/posters/`、`exports/`。原片只按 `source_root_id + rel_path` 引用。
- **全局配置目录**：`~/.config/storyscript-mov/`，包含 `config.json`、`credentials.json`（0600）、`runtime.json`（0600）。可用环境变量 `STORYSCRIPT_HOME` 覆盖该目录，测试时指向临时目录。

## 4. 功能要求

### FR-01 项目
- 新建项目时选目录、时区（默认取系统时区）、默认画幅（默认 2.39）、目标时长。
- 每个明确操作立即提交事务；文本输入 800ms 防抖。只在事务提交成功后才显示"已保存"。
- 打开项目时检查 `schema_version`；需要迁移时先调用 `sqlite.backup()`。
- 用 `project.lock`（pid、hostname、started_at）保证单写入者；pid 已不存在的陈旧锁可以接管。

### FR-02 剧本
- 支持粘贴、`.txt`、`.md`、`.fountain`。
- **规则切场**：中文场景标题（如"1. 内景 咖啡馆 日"、"场1 日 内 咖啡馆"、"第一场"）；Fountain 的 `INT./EXT./EST./INT/EXT/I/E` 和强制前导 `.`。
- 每个非空段落一个锚点，编号为 `p-001`…；`ScriptVersion` 不可变，带 `content_hash`。
- 导入页可以手动把某一行设为场景标题或取消。
- 实体抽取（LLM，可选）生成草案，经人工确认、改名、编辑别名后生效；没有 key 时手工建。
- 修改剧本会生成新版本。旧镜头的 quote 在新版本中能精确匹配就沿用，否则标 `needs_relink`，只给建议，不自动连接。

### FR-03 拆镜（做深）
- 按场调用 `structuredCall`，输出 `BreakdownOutput`。**每步最多外发 3 次**，网络重试、429、解析失败、校验失败都各计一次；SDK 的 `maxRetries` 设为 0。
- **校验**依次为：
  1. zod；
  2. 枚举大小写归一；
  3. 角色 alias 必须在花名册内；
  4. 引用 quote 经 NFKC 归一与空白折叠后，在指定段落中分级：`exact`、`fuzzy`（编辑距离 ≤15%）、`rejected`，`rejected` 的不能应用；
  5. 数量上限。
- **草案展示**为差异视图，逐条勾选后 apply。已锁定的镜头显示为不可改。
- 局部重生成：按场重新拆，跳过锁定镜头。
- 手工操作：新建（`origin=manual`，必须填 `manual_note`）、编辑（生成 `shot_revision`）、改 code、拖动叙事顺序、归档、`waive/restore`（改 `required_status`，必须写原因）。
- 手法模板：见 `packages/core/src/presets/`。"参考 X"只能从库里选 `technique_id` 并写改编说明，输出标"通用手法建议（未核实）"。书名号、年份、时间码之类的具体断言用正则标注，但不拦截。

### FR-04 分镜（做深）
- apply 之后，由 `core/board/layoutBoard(shot, scene, preset)` 生成 BoardSpec；LLM 永远不输出坐标、SVG 或 HTML。
- `renderBoard(spec, mode)` 的 mode 为 `structure | pencil | topview`，输出纯 SVG 字符串。
  - 只用表现属性，不写 `style` 属性或 `<style>` 标签（CSP 要求）；
  - 灰度，不依赖颜色区分身份；
  - 同一输入逐字节输出相同。
- **模板**：establishing、single、two_shot、ots、insert、lateral_move、scale。
- **相机求解**：vFOV = 2·atan(h/2f)，传感器宽 36mm；按景别可见高度反推机距。焦段滑块默认"保持景别"。
- **编辑**：画框内直接拖动的只有人物脚点和箭头端点；其余属性在侧栏改。撤销/重做；保存生成新版本；镜头 `content_hash` 变化后板子标 stale，由用户选择重生成或保留。
- **画风**：pencil 的画风指标 L1–L7 写成测试（见 `docs/PLAN.md`）。

### FR-05 手法与外观
- 内置 3 个原创手法模板：对话覆盖、双线交叉/赶时间、悬疑揭示。
- 内置 1 个外观预设："宽银幕铅笔分镜"。
- 用户可以新建文字版模板。v0.1 不接收参考图。

### FR-06 排期（最小闭环）
- 单日、单摄制组。资源分演员（带选角映射到角色）、场地、设备，每项有时间窗：带时区输入，存 UTC，区间为 `[start,end)`，跨午夜显式展开。
- setup 自动分组规则：同场地且同 `angle+facing` 桶。工时默认值标"估算"，批准前必须确认。
- 约束：`before`、`not_before`、`not_after`、`locked_block`。
- **算法**：分组 → 显式矛盾检查 → 贪心找最早合法空档 → 独立的 `validate()`。
  - 只有显式矛盾（必需演员当天没有窗口、单块时长超过所有窗口、前置关系成环、锁定块冲突）才返回 `proven_infeasible`，并附依据；
  - 贪心排不全时返回 `partial`，附未排项和原因。
- **LLM 排序建议**：只输出 setup 顺序和理由，结果经 validate 校验后一键采纳。
- 手动上移或下移之后立即重新校验。
- 导出：拍摄单（未批准时标"草案"）、打板卡、预填 code 的场记 CSV 模板。

### FR-07 场记
快速录入：code、take 号、机位标签、评级、`clip_hint`（机内文件名）、备注。一条 take 可关联多个镜头；对不上的手写镜号存进 `unresolved_labels`；评级不会推导出 usable。

### FR-08 素材
- 选目录用 osascript 或粘贴路径，realpath 后登记为 `source_root`。
- 按扩展名白名单只读扫描，跳过 `._*` 文件；用 ffprobe 读取并归一化元数据；海报帧用输入端 `-ss` 单帧抽取。
- 后台流式计算 SHA-256；读前读后比对 size/mtime，有变化就标 `source_changed`。
- 只有 H.264 8-bit 4:2:0 的 MP4/MOV 走 Range 直接播放，其余格式显示"需代理（v0.2）"。
- 没装 ffmpeg 时应用照常启动，只禁用导入。

### FR-09 关联与检索
- 候选规则：R1 文件名含打板 code（`S01-003-T02`）；R2 `take.clip_hint` 等于文件名主干；R3 用户自定义正则（命名组 scene/shot/take）。
- 所有候选进审核队列，永不自动确认。
- 整条关联写成所选视频流精确的 `[start_pts, start_pts+duration_ts)`。
- 覆盖决定（`usable/needs_pickup/clear`）都要写原因，只追加不修改。`usable` 必须选中已确认且原片在线的关联。
- 漏拍清单区分四种原因：`no_take`、`no_link`、`no_confirmed_usable`、`file_offline`；optional 和 waived 镜头不算漏拍。
- 检索只用 LIKE。

### FR-10 导出
- PDF 用浏览器打印 CSS 生成：分镜（画幅 ≥2.2 时每页 3 格，否则 2 格）、俯视站位、拍摄单、打板卡、漏拍报告。
- CSV：UTF-8，可选 BOM；以 `= + - @ \t \r` 开头的单元格前置 `'`；source_range 拆成五列整数导出。
- 项目 JSON 只做导出，不含密钥和原片。

### FR-11 任务
- 单一执行状态：`queued/running/succeeded/failed/cancelled/interrupted/outcome_unknown`，带幂等键，前端每秒轮询一次。
- 重启后，本地任务标 `interrupted` 再重跑；付费远端任务标 `outcome_unknown`，不重发。
- 付费图像请求只对 429 按 Retry-After 重试。
- 首次外发前说明将发送哪些数据、发往哪个主机；每次记录 usage，拿不到就标"未知"。

### FR-12 AI 铅笔重绘（实验）
- **控制图**：服务端用 resvg 渲染同一份 BoardSpec，不含文字标注。
- **提示词**：由 `core/prompt` 固定骨架编译，并过滤触发词（人名、片名、商标）。
- **方言**：`openai-edits` 为默认；`generations-ref` 由 `apps/server/src/adapters/image/presets/*.json` 驱动。
- **结果**：一次只出 1 张候选；洋葱皮对比后人工采用；导出默认带"AI 生成"角标；结构一变就标 stale。
- **验证**：以 FakeImage 验证；没有实测过的 preset 一律标"未验证"。

## 5. 本地 API 约定

- 前缀 `/api/v1`。成功响应为 `{ data }`；错误响应为 `{ error: { code, message, details?, retryable } }`，error code 取自 `contracts/errors.ts`。
- 带 revision 的写入（shot、board、plan）必须附 `expected_revision`，不匹配返回 409 `REVISION_CONFLICT`。
- 异步任务返回 202 `{ data: { job_id } }`，通过 `GET /api/v1/jobs/:id` 查询状态。

## 6. 安全（AT-17）

- 启动时生成 32 字节令牌，打开链接 `/#t=<token>`；前端 POST `/api/v1/session` 换取 HttpOnly、SameSite=Strict 的 cookie，然后清掉 fragment。
- 每个请求校验 Host 属于 `{127.0.0.1:port, localhost:port}`；非 GET 请求要求 Origin 同源；不开 CORS；设置 CSP 为 `default-src 'self'`。
- 媒体只通过 asset_id 访问：服务端先 realpath，再校验路径落在已登记的根目录内。
- ffmpeg 只用参数数组 spawn，带超时和 AbortSignal，输出只写 `derivatives/`。
- key 只在服务端使用：存放在 `credentials.json`（0600）或环境变量 `STORYSCRIPT_LLM_*`、`STORYSCRIPT_IMAGE_*`；界面只显示末 4 位。

## 7. 验收子集（v0.1 发布闸门）

- AT-01（简化）、02、03、04、05、06、07、08、09、10、11（"生成代理"改为"提示需代理"）、12（子集）、13、14（只含导出）、15（子集）、16（无 key 流程与晚到候选）、17、18（FakeImage）。
- 无 key 全链路 E2E。
- 在临时 HOME 下两条安装路径都可用。

## 8. v0.1 不实现（UI 与 README 标"未提供"）

代理生成、掉盘重连、JSON 导入、场记 CSV 导入、自然语言约束抽取、子集 DP 与求解器、FTS、转录/OCR、NLE 交换、3D 取景、参考图库、entity-merge、Job 四套状态与费用预留、SSE、多日排期、多人协作、Electron/dmg。

## 9. 命名与洁净室

- 产品内（预设名、按钮、提示词、测试数据）不得出现在世导演、分镜师、片名、角色名，也不得出现 IMAX。外观预设名为"宽银幕铅笔分镜"。
- 禁读、禁抄名单和素材规则见 `docs/CLEANROOM.md`。所有模板、提示词、人偶、样例剧本、纸纹都必须原创。
