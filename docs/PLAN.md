# StoryScript-Mov v0.1 规划（10 天开发预览版）

## Context

用户要开源一个"AI 实拍分镜工作台"，面向真人实拍短片：剧本拆镜 → 分镜图（结构线稿 + 诺兰式铅笔草图）→ 拍摄排期 → 场记 → 素材关联与漏拍清单。原规格 `/Users/billgao/Downloads/SPEC.md` 约 800 行，按 7–11 周、Electron + Python sidecar 的规模写成，10 天内做不完。

本规划的来源：
- 18 个调研 agent 的结论，已逐条事实核查；
- 3 个角度的方案，经 3 位评委打分后合并；
- 1 轮对抗挑错。

全量资料：
- 调研摘要：`/private/tmp/claude-501/-Users-billgao-Documents-Coding-StoryScript-Mov/e0c5e95c-6d34-4788-9f13-6fee47041f0d/scratchpad/digest.md`
- 合并方案全文：`~/.claude/projects/-Users-billgao-Documents-Coding-StoryScript-Mov/73807ae7-f94c-4fd6-b7f7-07ac102f5736/tool-results/boo7jpe3j.txt`

实施阶段会把这些资料的要点固化进 `docs/`，不依赖临时路径。

v0.1 的目标是一个能装、能用、不说假话的**开发预览版**：
- U-02 分镜达到能当首屏卖点的完成度；
- U-01 拆镜做深；
- U-03 排期、U-04 素材各有一条最小可用闭环。

## 研判结论

- **规格优点，保留为不变量**：
  - 叙事顺序与拍摄顺序分离；稳定 UUID；
  - AI 结果先进草案；锁定保护；原片只读；
  - 排期必须经独立校验；覆盖状态由唯一的纯函数计算；source_range 用整数 PTS 结构；
  - 无 key 可用；测试用假 provider。
- **主要问题**：
  - 量级超出约 3 倍。推迟：四套 Job 状态与费用预留、held 晚到结果、全面 409、SSE、entity-merge、JSON 导入、代理与 VFR。
  - A-02/A-03（形态与技术栈）、A-05/FR-12（铅笔图原为 P1）、§5.4（调度图透视）与已拍板的决定冲突，需要正式修订。
- **差异化**：开源热门项目（Toonflow、ViMax 等）都在做 AI 生成视频。真正的空白是实拍闭环："计划镜头 ID → 条次 → 片段 → 漏拍清单"，覆盖无对白镜头。
- **"诺兰感"分三层落地**：
  1. 媒介：纸上松散铅笔。这是唯一查实的一手事实。
  2. 镜头语法：焦段、机高、尺度对比、视点纪律。
  3. 宽银幕画幅。
- **AI 重绘的限制**：只能"参考构图"，会漂移，OpenAI 官方也承认这一点。所以诺兰感的下限必须由**确定性铅笔渲染**保证。

## 已定决策

| 项 | 决定 |
|---|---|
| 形态 | 本地 Web 应用：单个 Node 进程只监听 127.0.0.1。安装方式为 `npx storyscript-mov`，或 `git clone → npm ci → npm start` |
| 名称/许可/版本 | 包名 `storyscript-mov`，许可证 MIT，版本前缀 S（开发期 S0…S0x，发布时 S1 对应 npm 0.1.0） |
| 文本模型 | 统一走 OpenAI chat completions 协议，BYOK（base_url、key、model 三项） |
| 图像模型 | 配置同样三项，按主机名自动识别方言：默认 `openai-edits`；`generations-ref` 由 JSON preset 驱动（火山 Seedream 为国内默认，另有 OpenRouter） |
| 诺兰命名 | 产品内不出现。外观预设叫"宽银幕铅笔分镜"。README 的"灵感与参考"一节提一次，并附无关联声明 |
| 实测条件 | 用户提供文本 key（写进环境变量或 credentials 文件，Claude 不经手明文）；**暂无图像 key**，图像层按文档格式对照假服务开发，标"未验证" |
| Node | Claude 执行 `brew upgrade node`，升到 26.10.0；`.nvmrc` 写 26，engines 写 `>=24.15`；CI 跑 24 和 26 |

## 技术栈（均锁定精确版本，M0 一次装齐）

- **基础**：Node ≥24.15；npm workspaces；TypeScript 6.0.3。
- **契约**：zod 4.6.5（`z.toJSONSchema` 生成 response_format）。
- **服务端**：hono 4.13.9、@hono/node-server 2.1.1。开发模式下 Vite 以 middleware 模式挂进 Hono 的同一端口，避免跨端口 Origin 被 CSRF 校验挡住。
- **数据库**：node:sqlite + 手写 SQL 迁移（`PRAGMA user_version`）+ zod 行解析，全部经 DbPort。备份用模块级的 `sqlite.backup(db, path)`。检索只用 LIKE。后备驱动 better-sqlite3 13.0.3。
- **LLM 与图像**：openai 7.23.0，`maxRetries:0`。自写 structuredCall：每步最多外发 3 次，流程为 jsonrepair 3.15.0 → zod → 业务校验 → 带错误回灌的修复。能力阶梯为 json_schema → json_object → 纯提示，按端点缓存。
- **渲染**：自研 `renderBoard(spec, mode, seed)` → SVG 字符串（core 纯函数）。随机量用 mulberry32，**不用 roughjs**。SVG 只用表现属性，不写 `style`，以符合 CSP。
- **服务端 PNG**：@resvg/resvg-wasm 2.6.2（MPL-2.0，作为外部依赖，不打包）。先 `initWasm`，用完调 `.free()`；服务端 PNG 不含文字。
- **前端**：vite 8.3.1、react 19.3.0、@tanstack/react-query 5.103.2、tailwindcss 4.3.3。不用路由库，不用画布库。
- **测试与构建**：vitest 5.0.2、fast-check、@playwright/test 1.63.0；tsdown（把 contracts 和 core 内联进产物）；CLI 用 node:util 的 parseArgs 解析参数，入口带版本垫片。
- **媒体**：用户自装 ffmpeg/ffprobe，spawn 时只传参数数组。本机 ffmpeg 没有 libx264，改用 h264_videotoolbox/libopenh264；"需代理"的测试样本用 ProRes 422 和 HEVC Main10。哈希用 node:crypto 的 SHA-256。
- **明确不用**：three.js、AI SDK、Drizzle、tldraw、Konva、roughjs、Electron、ffmpeg-static、fluent-ffmpeg。

## 架构

```
packages/contracts   只依赖 zod：ids/script/shot/board/plan/take/media/coverage/provider/job/api-routes
packages/core        零 IO 纯函数：script/ shots/ board/{camera,layout,puppets,project,render,overlay,lint,look-metrics} prompt/ schedule/ coverage/ media/ export/
apps/server          cli.ts app.ts security/ db/ jobs/ adapters/{llm,image,media,render,platform} routes/ fakes/
apps/web             5 个主视图：剧本+镜头表 / 分镜 / 拍摄计划 / 场记+素材 / 设置与任务
docs/ samples/ fixtures/ scripts/ e2e/
```

**安全**：
- fragment 令牌换成 HttpOnly、SameSite=Strict 的 cookie；
- Host 白名单；非 GET 请求校验 Origin；CSP；
- 媒体只接受 asset_id，服务端 realpath 后校验路径在已登记根目录内；
- key 存在 `~/.config/storyscript-mov/credentials.json`（0600）；
- project.lock 保证同一项目只有一个写入者。

**数据模型**：
- 约 20 张表，核心聚合为 Project、Scene、Shot、Board、Plan、Take、MediaAsset、ShotMediaLink。
- **ShotFields v1**（LLM 输出）是扁平闭集枚举。subjects 的细节字段全部可空，由模板默认值补齐；K4 触发时只改提示词，不改契约。
- **BoardSpec v1**：由 Scene（世界坐标，单位米）、Camera、Frame、Overlay 组成，LLM 永远不输出它。允许在 M1 结束时一次性升到 v1.1。
- revision/409 只在 Shot、Board、Plan 三处强制。
- setup 按"同场地且同机位朝向"自动分组，用户可以改。

## 分镜管线（D2 核心卖点）

1. **镜头语法 → 相机默认值**：尺度大全景用 24mm 低机位；视点纪律由 pov_owner 决定机位；面孔特写用 85mm；载具硬挂；2.39 画幅叠 1.43 中心保护线；set_piece 镜头默认低机位广角。
2. **世界坐标针孔相机求解**：vFOV=2·atan(h/2f)，由景别可见高度反推机距，另有过肩偏移与裁切、场景轴线。焦段滑块默认"保持景别"。
3. **structure 渲染**：地面、地平线和长方体走真实透视投影。人物用 2D 人偶公告板：4 个朝向（左右镜像）× 6 个姿势 × 3 种轮廓，按深度做画家排序。
4. **topview 渲染**：俯视站位图，与取景框同源，只读。
5. **pencil 渲染**（默认草图，无需 key）：先铺明暗，再描线。
   - **明暗**：每个图元分到 tone 0–3。人物按前、中、远景取 3/2/1，再按材质偏移（S4c）：皮肤 −1½、头发和鞋 +1、上下装按角色衣着 −½ / 0 / +½；前景人物只取 0.3 倍偏移，仍近乎剪影。长方体受光面 1、侧面 2、背光面 3；布景（env- 道具）更浅；地面由近到远 2→1→0；投影取 3。
   - **排线**：全画幅只生成 3 组（T1 间距 9px、角度 38°；T2 间距 6px；T3 再叠约 108° 的交叉线），每组用"该档及更暗区域的并集"做模糊蒙版。每根线切成 40–120px 的笔段，略带弓形，宽度和不透明度各有 ±15% 抖动。T3 下面垫一层模糊晕染。
   - **轮廓**：用收尖的填充多边形，宽度 `w(t)=w₀(0.55+0.45 sin πt)`，画两遍并错位，两端出头 3%。w₀ 按景深取前景 2.2px、中景 1.4px、背景 0.9px。受光侧断线，背光侧加重。
   - **构造线**：#8a8a8a，不透明度 0.35，最先画。
   - **纸面**：底色 #F3F0E8，正片叠底一张纸纹 tile，加暗角。颜色只允许灰色。
   - **人物与动作**（S4c 起）：人物画成有脸的分镜小人，不再是实心剪影。头部是皮肤，头发按发际线盖在头顶和后脑；脸上有眉、眼、鼻、嘴，侧面有耳；上下装分色，鞋子深色。发型和衣着由角色身份决定，每格一致。脸不进排线；人物够大才画五官。过肩前景仍近乎纯黑；动作镜头加速度线和虚线残影。
   - **布景**（S4c 起）：按环境排版时自动布景，全部是 env- 道具，由 seed 决定，不挡人物：室内的门窗和一件家具、教室的黑板和课桌、走廊的门和天花板、街道的路灯和行道树、野外的树；开阔地和野外在地平线上画远山或树线（渲染时生成）。
   - **交互性能**：拖动滑块时只渲染 structure，松手后再出 pencil，结果按 structure_hash 缓存。
6. **矢量标注层**：镜号、景别·焦段标签、运镜符号、投影得到的人物箭头、视线、A/B 徽标。编辑手柄是独立的 React 层。
7. **AI 铅笔重绘**（实验，只出候选）：
   - resvg 出控制图；提示词由固定骨架编译，并过滤触发词；
   - 两种方言；确定性后处理；
   - 用户对照洋葱皮后手动采用；"AI 生成"角标；结构层永远不被改写。
8. **导出**：分镜 PDF 走浏览器打印 CSS，中文字体栈，灰度可读；俯视页；单格 PNG。

**画风可测指标**：`npm run look` 用 resvg 渲染 12 个标准镜头，从像素计算以下指标，并写成 vitest 断言。

| 编号 | 指标 | 阈值 |
|---|---|---|
| L1 | 亮度 k=4 聚类 | ≥3 个簇各占 ≥3%，簇中心间隔 ≥0.15 |
| L2 | 最大饱和度 | ≤0.04 |
| L3 | 240px 缩略图与剪影蒙版的 IoU | ≥0.7（S4c 起不检查大特写：脸是浅色，整格就是脸） |
| L4 | 平均亮度 | 前景 < 中景 < 远景 |
| L5 | 明暗区梯度方向的主峰 | 在 38°±8° 内，占 ≥50% |
| L6 | 前景主体内部接近纸白的像素比例 | ≤40% |
| L7 | 线宽变异系数 | ≥0.25 |

另加三项测试：同 seed 输出逐字节一致；改一个元素不影响其他元素；单格 SVG <150ms，1840px PNG <1.5s。

**自验循环**：
1. 每轮输出对比页、240px 缩略页、1:1 局部裁切和指标表；
2. Claude 读图后迭代，最多 6 轮；
3. 做出 3 个变体交用户选（检查点 C1b），选中的参数冻结为 look v1。

## 剧本体检与用量（S5）

- **预估片长**（core `script/estimate.ts`，不用模型）：汉字和假名、谚文各算 1 个单位，拉丁单词算 1.5；对白（`角色：台词`、Fountain 对白块，括号提示不算）每秒 4 个单位，动作描写每秒 2.5 个，每场另加 3 秒；显示 ×0.75–×1.3 的范围，写明是粗估。样例剧本 01-bookshop 为 1:48 + 0:37。
- **拍摄难点**（job `check_script`，提示词 check-v1）：一次发送整份剧本，最多外发 3 次，计入每日上限。类别固定九种，每条的引用必须能在剧本里找到（找不到的进修复轮，用完后略去并注明）；结果只是提示，不改剧本和镜头。勾选的「已处理」在重新体检时按「同类别、引用互相包含」沿用；剧本改版后按引用重新定位，找不到的标为过期。
- **用量**：只汇总 `remote = 1` 的任务。「今天」按项目时区算。服务器版分开组的 key 和个人 key，个人 key 的用量只给本人看。单价存在模型设置旁边的 `usage-price.json`，组的单价只有组长能改。

## v0.1 范围

| FR | 状态 | 要点 |
|---|---|---|
| 01 项目 | 简化 | 项目即目录，每次明确操作立即提交事务，迁移前 backup，project.lock |
| 02 剧本 | 简化 | 支持粘贴、txt、md、fountain；规则切场，可手动切换标题行；段落锚点；不可变版本；LLM 抽取实体草案；改剧本后对不上的镜头进"待重新关联" |
| 03 拆镜 | **做深** | 按场 structuredCall；引用经 NFKC 三级校验；差异视图 → apply（跳过锁定、409）；局部重生成；手工增删改、编号、叙事排序 |
| 04 分镜 | **做深** | 见上节管线；编辑时只直接拖动人物脚点和箭头端点，其余在侧栏改；撤销/重做；版本；stale |
| 05 手法 | 简化 | 3 个原创模板和 1 个外观预设；"参考 X"只能从库里选手法，输出标"通用手法建议（未核实）" |
| 06 排期 | 最小闭环 | 单日单组；资源、选角、setup 工时（标"估算"）、手工约束；分组 → 贪心 → 显式矛盾检查 → 独立 validate；**LLM 排序建议永不砍**（极小版，结果经 validate）；导出拍摄单、打板卡、场记模板 |
| 07 场记 | 最小闭环 | 快速录入（含 clip_hint），take↔shot 多对多，评级与覆盖分开 |
| 08 素材 | 最小闭环 | 选目录；只读扫描；ffprobe；海报帧；后台 SHA-256 并检测 source_changed；H.264 8-bit 直接播放，其余格式标"需代理（v0.2）" |
| 09 关联 | 最小闭环 | R1、R2、R3 候选全部进审核队列；整条关联写精确的 [start_pts, start_pts+duration_ts)；漏拍清单区分 4 种原因；LIKE 检索 |
| 10 导出 | 简化 | PDF（打印 CSS）；CSV（可选 BOM，防公式注入，PTS 五列）；项目 JSON 只导出 |
| 11 任务 | 简化 | 单一执行状态（含 interrupted、outcome_unknown）；幂等键；前端轮询；付费请求只对 429 重试；生成前确认，记录 usage |
| 12 AI 铅笔 | 实验 | 同上节第 7 步；AT-18 始终以 FakeImage 验证；preset 标"未验证" |
| 13/14/15 | 推迟 | README 标"未提供" |

推迟到 v0.2：代理、重连、JSON 导入、场记 CSV 导入、自然语言约束、DP、FTS、真实试拍。推迟到 v0.3：3D 取景助手、转录/OCR、NLE 交换。

## 执行方式

- **主会话**：Claude 主会话担任 lead，独占以下工作：package-lock.json、依赖、contracts、迁移编号、api-routes、README 版本表、合并和审图。
- **并行轨**：M0 之后用 Workflow 最多同时开 3 条并行轨，每条轨一个 git worktree，按目录划分归属，并**禁止改依赖**。每个里程碑只合并测试全绿的分支。
- **需求依据**：M0 先写 `docs/SPEC-v0.1.md`（≤200 行），作为 agent 唯一的需求输入。原 SPEC 复制为 `docs/SPEC.md`，顶部加"v0.1 以 SPEC-v0.1 为准"。另写 `CLAUDE.md`/`AGENTS.md`、`docs/CLEANROOM.md`（禁读名单：AGPL/GPL/Elastic/无许可证项目；命名禁令）、`docs/research.md`（调研要点）。
- **拆镜评测防自评**：期望清单在运行模型**之前**提交，并请用户抽查 1 场。
- **版本与提交**：每个里程碑完成后在本地 main 提交（不 push），更新 README 版本表、version 徽章和 license 徽章。暂无 git remote，所以不加动态徽章。

## 里程碑

> **2026-09-26 调整**：
> - **版本号**：用户要求插入"S0a 界面改版"，参照 DaVinci Resolve 的专业工作台风格：石墨外框、纸面内容，底部工作流页面栏依次为 剧本 → 分镜 → 计划 → 现场 → 素材 → 交付。为此下表各里程碑的版本字母顺延，**实际版本号按合并顺序分配**，以 README 版本记录为准。
> - **页面划分**：原来的"场记与素材"视图拆成"现场"（场记录入）和"素材"（素材库与漏拍）两页，另新增"交付"页（导出）。
> - **开发前大标题**：每个里程碑开工前，先在会话里插入章节标题（用户全局规则）。

| M | 版本 | 依赖 | 内容 | 退出标准 |
|---|---|---|---|---|
| M0 | S0 | — | 升级 Node；一次装齐依赖；docs 与规则文件；README 与 LICENSE；contracts v1；安全外壳；DbPort、迁移和锁；web 空壳；CI 配置；打包冒烟；spike：LLM structuredCall（真实文本 key）、媒体（生成样本、Range）、resvg | `npm ci && npm run typecheck && npm test` 全绿；安全 3 项：伪造 Host 403、跨源 POST 403、无 cookie 401；DB：WAL、backup、user_version、1 万行 LIKE <20ms；`npm pack` 后在临时 HOME 下 `npx ./x.tgz doctor` 退出码 0；`docs/spikes.md` |
| M1 | S0a | M0 | 相机求解、投影与裁剪、7 个 layout 模板、lint、topview、structure、人偶、`npm run look` | 各景别主体高度误差 ≤3%；焦段 24→85 且保持景别时，主体高度变化 ≤3%；7 个模板的 golden SVG；**C1a：用户在人偶陈列页签字** |
| M2 | S0b | M1 | pencil 渲染（上述配方）、12 个标准镜头、标注层 | L1–L7 全过；确定性和性能测试通过；**C1b：用户三选一，冻结 look v1** |
| M3 | S0c | M0，与 M1/M2 并行 | 剧本解析、structuredCall、假 OpenAI 服务、实体草案、拆镜、差异视图、apply/409/锁定、局部重生成、手法模板、镜头表 UI | AT-02/03/04/06（用 Fake）全绿；真实 key 跑 3 个剧本，对照事先提交的清单达到 ≥80%；回放录制存入 fixtures |
| M3′ | （并入 S0c） | M0 | schedule、coverage、media 三组纯函数 | fast-check：validate 接受贪心的全部完整输出，注入冲突必被拒；§5.9 表驱动测试；AT-08 纯函数部分 |
| M4 | S0d | M2+M3 | apply 后自动出图、分镜网格、编辑器、分镜 PDF | AT-05（Playwright）；e2e 第 1 段；中文 PDF 冒烟 |
| M5 | S0e | M3+M3′ | 排期闭环：资源、选角、setup、约束、LLM 排序建议、批准规则、拍摄单、打板卡、场记模板 | AT-07/08/09；INV-01；e2e 第 2 段 |
| M6 | S0f | M3′，与 M5 并行 | 素材闭环：场记录入、扫描、ffprobe、海报帧、SHA-256、Range、候选审核、覆盖决定、漏拍清单、LIKE 检索、CSV | AT-10、11 简化版、12 子集、13；e2e 第 3 段 |
| M7 | S0g | M4–M6 | 无 key 全链路 E2E、`--demo`、JSON 导出、AT-14/15/16 | `npm run e2e` 全绿。**这是四块闭环的闸门，不过就不开 M8** |
| M8 | S0h | M7 | AI 层：openai-edits、generations-ref（Seedream、OpenRouter preset）、FakeImage、提示词编译、控制图、洋葱皮与采用、角标 | FakeImage E2E 通过；INV-09；请求格式与各家文档逐项对照；标"未验证" |
| M9 | S0i | M8 | AT-17 全量、doctor 和 open 子命令、两条安装路径、功能冻结；**C3（可选）：用户用手机拍约 10 条素材做模拟拍摄** | 临时 HOME 下两条安装路径的脚本化测试通过 |
| M10 | S1 | M9 | README 中英版、Playwright 录首屏 GIF、NOTICES、CONTRIBUTING、SECURITY | README 所列能力都有对应的测试或截图；未完成的功能标"未提供"；**C4：由用户执行 publish** |

**先砍顺序**：
1. generations-ref 和 OpenRouter preset
2. 俯视图拖拽、自由箭头、控制图导出
3. 档案抽屉
4. AI 层降为默认关闭
5. 视频播放和 SHA-256
6. 交叉排线和动作残影

**永不砍**：确定性铅笔、拆镜做深、四块最小闭环（含 LLM 排序建议）、computeCoverage、无 key E2E、安全测试。

**其他止损**：
- node:sqlite 失败 → 换 better-sqlite3。
- 人偶没过审 → 改用剪影胶囊。
- pencil 迭代 6 轮仍不过 → 改为色调块为主，并在 README 如实称为"结构铅笔稿"。
- 拆镜通过率 <60% → 只改提示词，缩小输出范围。
- 拖拽超时 → 改为侧栏数值编辑。

## 验证

- 每个里程碑：`npm run typecheck && npm test`（测试按 AT 编号命名），加 golden SVG 和画风指标断言。
- 视觉：resvg 渲染 PNG，Claude 读图自检；到检查点再交用户确认。
- 端到端：Playwright 无 key E2E 从 M4 起分段常驻，M7 起跑全链路；FakeImage E2E 从 M8 起常驻。CI 里的 Chromium 只断言海报帧，视频播放在本机 Chrome 上验证。
- 安装：`npm pack` 后在临时 HOME 下执行 `npx ./x.tgz --demo`，并验证 `git clone → npm ci → npm start`。

## 需要用户做的事

1. M3 之前把文本 key 写进 `STORYSCRIPT_LLM_BASE_URL`、`STORYSCRIPT_LLM_API_KEY`、`STORYSCRIPT_LLM_MODEL`（DeepSeek 或通义）。文本调用预算预先授权约 ¥50，额度内不再逐次询问。
2. 检查点：C1a 人偶签字；C1b 画风三选一；拆镜抽查 1 场；C3 模拟拍摄（可选）；C4 发布。
3. 以后有图像 key 时，补做 AI 构图 A/B 实测，README 更新已验证组合。
4. 建 GitHub 仓库、设置 remote（之后补上动态徽章），并执行 npm publish。
