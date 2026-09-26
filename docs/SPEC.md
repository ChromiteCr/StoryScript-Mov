> **注意（2026-09-26）**：v0.1 开发以 [`SPEC-v0.1.md`](SPEC-v0.1.md) 为准；本文件是原始完整规格，现降为路线图。凡 SPEC-v0.1 未列入的契约（Job 四状态与费用预留、有理数 PTS 精确交付、全面 409、SSE、Electron/Python sidecar 等）在 v0.1 中不实现。架构已由"Electron + Python sidecar"改为"本地 Web 应用、TypeScript 单栈"（见 PLAN.md）。

# AI 实拍分镜工作台 — 产品与技术规格

- **文档版本：** 0.1.0
- **日期：** 2026-09-25
- **状态：** 开发讨论稿；包含明确标注的暂定假设，尚非全部经用户确认的冻结需求。
- **面向读者：** 产品负责人、开发者、设计者、测试者与辅助开发的 Coding Agent。
- **交付目标：** 从剧本自动拆镜，生成可修改的简单分镜图，辅助安排真实拍摄顺序，并将实拍素材关联回镜头。
- **本次交付范围：** 规格文档。没有执行产品开发、模型训练、软件安装、付费 API 调用或部署。

> 本文中的“必须”是所定义版本的验收要求，不代表软件已经实现。标为“暂定”的决策允许在实现前调整；调整须同步更新范围、接口与验收用例，不能静默修改需求。

## 1. 目标、边界与待确认假设

### 1.1 用户已明确的目标

| ID | 目标 |
|---|---|
| U-01 | AI 根据剧本自动拆解镜头。 |
| U-02 | 自动绘制简单分镜图，能够参考电影及导演作品的镜头语言，例如诺兰的电影。 |
| U-03 | 使用 LLM 辅助整理真实拍摄顺序。 |
| U-04 | 整理拍摄素材，支持后续检索与使用。 |
| U-05 | 以 Markdown 交付可用于开发的 spec。 |

### 1.2 为使文档可执行而采用的暂定假设

以下均是方案默认值，**不是用户已明确同意的决定**。

| ID | 暂定决策 | 影响与变更条件 |
|---|---|---|
| A-01 | 先面向个人与小型团队自用；单用户、单项目写入者 | 公共 SaaS、协作权限和计费不进入 P0。 |
| A-02 | 首个验收平台为 macOS Apple Silicon 桌面端 | Windows 为后续目标；若改为浏览器优先，须重评本地目录、原片引用和后台处理。 |
| A-03 | Electron + React/TypeScript；Python 本地工作服务；SQLite | 在技术 spike 后锁定支持版本；不同时开发 Tauri 版本。 |
| A-04 | 中文界面；剧本支持中文与英文 | 字幕、PDF、CSV 必须覆盖中文编码和字体。 |
| A-05 | 默认自动结构线稿；可选 AI 铅笔画在 P1 完成 | P0 不是纯占位图片，必须自动给出人物、动作、构图及方向信息；若用户要求写实/铅笔图首发，需提升优先级并重估成本。 |
| A-06 | 原始视频本地只读；云模型按需、显式授权 | “本地优先”不等于全部离线；无云授权时相关模型调用必须关闭。 |
| A-07 | P0 验收规模：1—5 分钟短片、1—3 场地、2—5 角色、10—30 计划镜头、单拍摄日与单摄制组 | 这是验收范围而非永久产品限制；多日、多组资源优化属于 P1/P2。 |
| A-08 | 首版不训练模型、不采购专用 GPU、不内置商业 SaaS 依赖 | LLM 供应商、调用额度、价格及图像模型需在接入前确认。 |

优先确认：使用对象、目标平台、线稿/铅笔图的首发要求。每周投入时间与预算未提供，本文按里程碑而不是固定交付日期组织开发。

### 1.3 产品定位

> 一个以镜头为核心的 AI 实拍工作台：让镜头能被理解、修改、排入拍摄计划，并在拍完后找到对应素材。

核心价值不是生成图片数量，而是降低分镜修改、现场调度、漏拍核对和寻找素材的成本。

### 1.4 非目标

P0 不做：完整非线性剪辑器、调色与特效、整片 AI 视频生成、导演模型微调、复杂 3D 预演、自动演员身份识别、云盘、实时多人协同、公开账号/付费系统、自动发送通告单。

不自动：抓取整部电影、建立未授权参考图包、上传全部原片、删除或改写原始素材、决定最终好条、替用户确认场地许可或安全规则。

## 2. 术语与不可破坏的规则

### 2.1 领域术语

| 术语 | 本项目含义 |
|---|---|
| Scene / 剧本场景 | 一段可识别的场景与行动单位，不等于算法检测到的视频切点。 |
| Shot / 计划镜头 | 一个具有稳定 ID 的拍摄意图，可对应多个 take，也可在叙事中多次使用。 |
| Board / 分镜图 | 某镜头某版本的可视化，不是镜头本身。 |
| Setup / 拍摄设置 | 场地、机位/布光、设备等组合；多个镜头可复用。 |
| Take / 条次 | 一次实际表演/拍摄记录，可涉及多个相机文件。 |
| MediaAsset / 媒体资产 | 原片、音频、代理或派生图等具体文件记录。 |
| ShotMediaLink | 计划镜头与具体媒体片段的关联，包含源时间范围及确认状态。 |
| NarrativeEntry | 叙事中的一次镜头使用；不是现场拍摄顺序。 |
| Proxy / 代理 | 用于浏览和分析的派生文件，不替代原片。 |
| Draft / Approved / Stale | 草案、已人工批准、因上游变化需要重新检查。 |

### 2.2 系统不变量

- **INV-01：** 故事时间、叙事顺序、拍摄顺序分别保存，不复用一个 `order` 字段。
- **INV-02：** 外键使用稳定 UUID；镜号等显示编号可改，不能承担唯一身份。
- **INV-03：** AI 产物先进入草案，不能绕过校验或覆盖已锁定内容。
- **INV-04：** 原片只读。数据库标签、代理和转录放在项目目录，不写回原件或摄影卡。
- **INV-05：** 排期“批准”必须基于完整校验；启发式未排出方案不等于证明无解。
- **INV-06：** 一个镜头可对应多条/多机位/多片段；一个媒体文件可对应多个镜头。
- **INV-07：** 已确认事实、机器推断、人工修改分别记录；相似度不冒充正确概率。
- **INV-08：** 索引成功不等于备份成功；P0 不提示用户可格式化摄影卡。
- **INV-09：** 生成图不能反向覆盖镜头中的角色、道具、机位等结构化事实。
- **INV-10：** 模型输出与导入文本都是数据，不是获得文件系统、网络或工具权限的指令。

## 3. 版本范围与需求追踪

- **P0：可拍闭环。** AI 拆镜 → 自动可编辑结构线稿 → 有校验的拍摄计划 → 场记 → 本地素材关联 → 导出。
- **P1：半自动增强。** AI 铅笔分镜、转录/OCR/语义关联、多资源优化、一个目标剪辑软件交换。
- **P2：扩展。** 3D 预演、多日/多组复杂排期、多人协作等，另写变更规格。

| 需求 ID | 功能 | 优先级 | 原始目标 | 主要验收用例 |
|---|---|---|---|---|
| FR-01 | 项目创建、打开、自动保存与恢复 | P0 | U-01—04 | AT-01、AT-15 |
| FR-02 | 剧本导入、版本、场景/角色草案 | P0 | U-01 | AT-02 |
| FR-03 | AI 镜头拆解、依据、局部修改与锁定 | P0 | U-01 | AT-03、AT-04 |
| FR-04 | 自动结构分镜与图层编辑 | P0 | U-02 | AT-05 |
| FR-05 | 电影参考/镜头手法模板与来源 | P0 | U-02 | AT-06 |
| FR-06 | 拍摄资源、自然语言约束草案、规则排期 | P0 | U-03 | AT-07—09 |
| FR-07 | 现场镜号/条次、好条与完成状态 | P0 | U-04 | AT-10 |
| FR-08 | 只读素材导入、哈希、缩略图与代理 | P0 | U-04 | AT-11、AT-12 |
| FR-09 | 人工/CSV 素材关联、查缺镜头与检索 | P0 | U-04 | AT-10、AT-13 |
| FR-10 | PDF/CSV/项目 JSON 导入导出 | P0 | U-01—04 | AT-14 |
| FR-11 | 后台任务、取消、恢复、有限重试与预算 | P0 | U-01—04 | AT-15—17 |
| FR-12 | 参考图约束的 AI 铅笔分镜 | P1 | U-02 | AT-18 |
| FR-13 | 转录、打板 OCR 与候选匹配审核 | P1 | U-04 | AT-19 |
| FR-14 | OR-Tools 约束求解与临时重排 | P1 | U-03 | AT-20 |
| FR-15 | 选定 NLE 的片段交付与原片重链接 | P1 | U-04 | AT-21 |

P0 完成不等于全部愿景完成；P1 的铅笔风格、自动匹配和复杂优化必须在界面和发布说明中标为未提供，不能用演示占位冒充实现。

## 4. 用户流程与页面

### 4.1 标准流程

1. 新建项目，选择工作目录、时区、画幅与目标时长。
2. 粘贴/导入剧本，系统形成版本与场景/角色草案。
3. 用户确认角色、场地及已知拍摄限制。
4. AI 提出镜头表；用户检查依据、增删镜头并锁定。
5. 自动绘制结构分镜；用户调整位置、方向和动作。P1 可增加铅笔图。
6. 输入真实拍摄日、资源时间窗和工时；确认 LLM 提取的约束。
7. 生成拍摄草案、处理冲突，批准/导出拍摄表。
8. 拍摄时记录镜号、条次、机位和备注；离线也可手工记录后导入 CSV。
9. 导入素材、完成哈希/代理，按场记关联到镜头。
10. 在镜头页选看各条，核对缺失、标记补拍并交付剪辑。

### 4.2 信息架构

| 页面 | 主要内容与操作 |
|---|---|
| 项目首页 | 最近项目、新建/打开、工作目录状态、未完成任务、缺失磁盘提示。 |
| 剧本 | 左侧原文与版本，右侧场景/角色；点击镜头可定位原文。 |
| 镜头表 | 编号、场景、景别、动作、资源、锁定、版本与审核状态；支持批量选择。 |
| 分镜工作区 | 中间取景框，左侧画格列表，右侧镜头属性与图层；切换叙事视图/场景视图。 |
| 参考与设定 | 角色、地点、道具、手法模板、参考图片来源及适用范围。 |
| 拍摄计划 | 资源时间窗、设置分组、时间块、冲突列表、未排镜头、人工锁定。 |
| 拍摄记录 | 按拍摄顺序的大字号镜号、新增 take、机位、好条/待补拍标记。P0 仅桌面。 |
| 素材库 | 缩略图、预览、原始信息、标签、片段范围、镜头关联、离线/哈希状态。 |
| 任务与设置 | 任务队列、失败原因、网络授权、模型配置、费用/预算和导出。 |

### 4.3 交互规则

- AI 生成前显示作用范围、使用的输入、将发送到哪个服务及预计费用是否已知。
- 多条覆盖/删除计划数据前显示受影响镜头、分镜与排期，不删除原片。
- 锁定与批准分开：锁定防止 AI 修改；批准表示用户接受某一版本。
- 空数据、无 API key、离线、费用未知、任务失败、磁盘不可用必须有独立状态，不显示伪造进度。
- 自动保存只在本地事务提交成功后显示“已保存”；失败保留脏状态和恢复入口。

## 5. P0 功能规格

### 5.1 FR-01：项目与保存

**输入：** 项目名、工作目录、IANA 时区、画幅。时区默认建议 `Asia/Shanghai`，可改；镜头画幅默认建议 16:9，可改。

**行为：** 建立项目元数据、数据库和派生目录；打开时检查 schema 版本、目录权限与数据库锁。一个项目同时只允许一个写服务，第二个实例只读或拒绝写入。

**保存：** 明确操作即时事务保存；文本输入可短延迟合并保存，目标不超过 2 秒，待性能测试。保留最近草稿恢复记录；大文件不进入数据库。

**不包含：** 自动把媒体原件复制进项目、云同步或完整媒体备份。

### 5.2 FR-02：剧本导入与事实提取

P0 支持粘贴、UTF-8 `.txt`、`.md`、`.fountain`；PDF、Word、FDX 和 OCR 后置，不因上传不支持格式而悄悄丢页。

- 保存原始输入和内容哈希，导入后创建不可变 `ScriptVersion`。
- 为场景和段落分配锚点；AI 引用 `script_version_id + paragraph_id + quote`，服务端检查引用存在。字符偏移若使用，统一为 Unicode code point，不能混用 JS UTF-16 下标。
- 场景、角色、道具和地点首先是提取草案，支持别名合并与人工确认。
- 原文没有写明的身份、设备、时间或地点必须标记 `assumption` 或 `unknown`。
- 改剧本创建新版本，不原地覆盖旧版本。失去对应关系的镜头进入待重新关联列表，不能按新行号自动错连。

### 5.3 FR-03：AI 镜头表

**输入：** 已选择的剧本范围、角色/场地设定、目标时长、镜头数量上限、手法模板、已确认资源限制。

**输出：** 结构化镜头草案，每条至少包括：

- 原文锚点与场景；
- `narrative_purpose`：该镜头的信息/情绪作用；
- 人物动作、出场角色、道具；
- 景别、机位高度/方向、镜头运动、视线与进出画方向；
- 对白引用与预计成片秒数；
- 资源需求、连续性状态、假设及待确认问题。

**执行：** 先 schema 校验，再校验引用、枚举、角色 ID、数量上限和时间单位；失败只产生错误/待修正草案，不污染正式镜头表。AI 自报置信度仅作未校准分数，不能绕过人工确认。

**编辑：** 可新增、删除、合并、拆分、改显示编号、锁定，局部重生成需指定目标 IDs 和基础版本。手工新建使用 `origin=manual`，可无原文锚点但必须提供 `manual_note`；不能伪装成AI已验证的剧本引用。拆分/合并创建新 IDs，旧镜头归档并保留 `supersedes`，已有素材关联不得被自动迁移到不确定的新镜头。

**连续性提示：** 视线、屏幕方向、持物/服装、必要覆盖的检查为可解释提示。故意越轴等创作选择可人工记录原因后接受；P0 不声称能自动正确理解任意多人动态走位。

### 5.4 FR-04：自动结构分镜与图层编辑

**不是占位板。** 每个可生成的镜头至少包含角色轮廓/姿势、相对位置、朝向、简化场景或道具、镜头/人物运动标记中的适用项。

**渲染输入：** 由已确认镜头生成的受限 `BoardSpec`，不是 LLM 直接输出的任意 SVG/HTML。

**P0 模板：** 建立镜头、单人中近景、双人同框、过肩正反打、动作/物件细节、单方向移动。不能适配的复杂镜头保留说明并要求人工布局，不伪装成可靠投影。

**坐标：** 构图使用 `[0,1]` 归一化坐标；模板锚点区分人物位置、视线、运动路径和摄影机说明。取景框与俯视调度图是两个明确视图，2D 调度图不自动保证真实 3D 透视。

**可编辑项：** 人物/道具位置、朝向、轮廓姿势预设、前后层级、裁切、箭头、标签。文本是独立图层。

**一致性：** 角色使用稳定 ID、姓名标签及可区分轮廓；不以颜色作为唯一身份线索，黑白导出也能识别。

**版本：** 每次人工保存/生成创建或提交图版本；具有撤销/重做。镜头变化后旧图标为 stale，用户选择重生成或保留，不自动覆盖人工调整。

### 5.5 FR-05：电影参考与镜头手法

P0 提供三个通用模板：对话覆盖、双线交叉/赶时间、悬疑揭示。允许用户输入参考影片/段落、自己的文字分析和有权使用的图片；不要求内置电影截图图库。

模板最少包含：`name`、`intended_effect`、`shot_grammar`、`applicable_scenes`、`resource_cost_notes`、`low_budget_alternative`、`sources`、`limitations`。

“诺兰”等输入用于提出可编辑的参考手法，不作导演本人的背书，不承诺精确复制。电影截图、原始分镜手稿、教学复绘、用户原创、模型生成分别标记来源类型。用户未提供具体段落时，AI 只能标“通用手法建议”，不得捏造某场电影镜头作为事实引用。

生成必须服从角色、场地、设备和用户锁定项。手法模板不能自动改写故事时间；若建议叙事重排，产生独立提案供确认。

### 5.6 FR-06：拍摄资源与排序

#### 输入与确认

- `Performer` 是真实拍摄资源，`Character` 是故事角色；二者通过选角映射关联，不能把角色名直接当演员可用时间。
- 资源包括人员、场地、设备；P0 固定单摄制组。每项镜头资源要求须能解析到资源 ID 或标记未知。
- 用户填写拍摄日期、时区、可用时间窗、场地/设备限制、设置/转场/排练/拍摄/恢复/缓冲时长。
- LLM 将自然语言转为带原文依据的约束草案；只有人工确认后的约束参与正式计划校验。
- 剧本中的 DAY/NIGHT 不自动等于当地日出日落窗口；实际光照窗口由用户确认，P0 不依赖天气服务。
- 工时可由模板估算，但必须显示“估算”及确认状态。批准之前必须确认纳入计划的工时和必要资源，不用成片长度直接充当拍摄工时。

#### P0 排期算法

1. 确认基本数据、时间窗与依赖，无完整数据则返回 `needs_input`。
2. 保留已锁定时间块；按地点/设置构建分组，优先处理窗口紧的镜头。
3. 为设置、移动、拍摄、恢复与缓冲分别安排时间块；参与该块的每个资源都必须覆盖整段时间。
4. 在依赖允许的范围内寻找最早合法空档；同摄制组时间块不重叠。
5. 使用独立校验函数重新检查所有已排时间块、资源窗口、前置关系和未排镜头。
6. 输出结果、未排原因、算法版本、规则版本和输入快照；相同版本与输入保持确定性排序。

启发式找不到完整方案时返回 `partial` / `search_incomplete`，**不能声称已证明无解**。只有明确矛盾或 P1 求解器证明时才返回 `proven_infeasible`，并附可核验依据。

#### 校验与批准

时间窗使用带时区输入，内部 UTC 瞬时；区间语义为 `[start,end)`。跨午夜显式展开为正确日期。P0 限制一个拍摄日，不自动扩展第二天。

计划状态和求解结果分开：
- 状态：`draft → ready → approved`，上游变化后 `stale`。
- 结果：`needs_input | feasible | partial | search_incomplete | proven_infeasible`。

只有所有必拍项已排、硬约束无冲突、估算与必填项已确认的 `feasible` 计划才能进入 `ready/approved`。更改时间块立即重新校验；不能凭“手动拖入”绕过硬约束。

拍摄顺序变化不修改 `NarrativeEntry`。已经拍完的记录是事实，不被重排删除；只能对剩余工作提出新计划。输出仅为文件/页面，P0 不发送通知。

### 5.7 FR-07：场记与完成状态

- 创建 take 时选择拍摄设置、计划镜头（可多个）、条次、机位、实际时间和备注。`POST /takes` 使用 `shot_ids: UUID[]` 建立独立 `TakeShotLink`，不依赖媒体存在；无法解析的手写镜号仅存 `unresolved_shot_labels`，不冒充已关联。
- `good/alternate/reject/unrated` 是人工评级；`planned/attempted/usable/needs_pickup/waived` 是派生覆盖状态，二者不同，状态来源见5.9。
- 拍摄记录可先存在，没有视频文件也能记条次；随后添加媒体关联。若新媒体关联的镜头不属于所选take，必须显式确认补建TakeShotLink并填写更正原因；不能悄悄改变场记关系。
- “已拍摄”不等于“已找到可用素材”。镜头页面分别显示场记次数、已确认片段数、可用标记与缺失文件。
- P0 支持桌面输入和严格模板 CSV 导入；移动端扫码/实时同步后置。
- 更正场记保留审计记录，不重写机器读取到的原始文件信息。

### 5.8 FR-08：素材导入与代理

#### 支持范围

P0 验收输入：本地 MP4/MOV，H.264 视频及常见 PCM/AAC 音频，CFR 24/25/30 fps；另含 VFR、23.976/29.97、无时间码作为边界测试。边界格式至少正确索引/提示，不把索引成功宣传成逐帧交付支持。HEVC、ProRes、RAW 等按解码能力另测，不承诺开箱即用。

#### 导入步骤

1. 用户通过系统文件选择授权来源目录；服务端保存受限 `source_root_id`，后续请求不能传任意绝对路径。
2. 扫描并保存路径、卷标、大小、mtime、容器/编码、分辨率、音视频流、timebase、平均帧率及时间码来源。
3. 后台流式计算完整 SHA-256；哈希完成前状态是 `pending`，不能按大小/文件名直接宣布重复。
4. 检查读取前后文件大小/mtime，并识别明显仍在增长的文件；发现变化则标 `source_changed` 并重新请求处理，不确认一致性。
5. 在派生目录生成缩略图/浏览代理；失败不撤销已存在的原片记录，也不标记为全部成功。
6. 同内容文件保留不同位置记录，可复用派生结果，但不能自动删除任一副本。

#### 原片与代理

- 原片记录不可由生成任务修改；标签属于独立元数据。
- 每个代理保存 `derivative_of`、输入哈希、工具/预设版本、输出哈希和时间映射。
- CFR 代理应保持源时间关系；VFR 原片优先保存源 PTS。若转换为 CFR 必须保存映射，映射未验证时禁止精确片段交付。
- 不把不存在的 timecode 伪造为摄影机真实时间码；可另提供明确标记的相对时间。
- 掉盘后显示 offline，重连时用已授权路径和完整身份校验重链接，不能仅按文件名重新认领。
- P0 不自动复制摄影卡，不提供“安全格式化”结论。项目备份与媒体备份分别说明。

### 5.9 FR-09：素材关联、检索与漏拍检查

P0 支持：手动拖入镜头、CSV 场记关联、文件名编号候选与人工确认。文件名中的镜号只是候选；重复、冲突、找不到镜头必须进入审核队列。

关联记录包含 `shot_id`、`media_asset_id`、可空 `take_id`、`source_range`、证据来源、状态与人工确认人/时间。范围统一为 `[in,out)`，使用8.3冻结的流索引、整数PTS与时间基结构，不能只存浮点秒；代理坐标不得覆盖原片范围。

- 同文件允许多个互不相同或有意重叠的片段关联。
- 一次删除关联不删除文件或其他镜头的关联。
- 人工确认后可撤销；历史确认状态留审计。
- 检索支持镜号、场景、文件名、标签、场记备注、评级、关联状态与离线状态；全文检索先用 SQLite FTS，不先引入向量数据库。
- 缺镜头规则按批准的必拍镜头清单核对，区分“无场记”“无关联”“无已确认可用片段”“文件离线”。导演主动取消的镜头记录 waiver，不强行算漏拍。

#### 覆盖状态的唯一来源

`coverage_status` 不作为可任意写入字段保存，由以下规则按从上到下优先级计算：

| 条件 | 返回状态 | 唯一事实来源 |
|---|---|---|
| Shot.required_status为waived且有原因 | waived | Shot中的拍摄要求决定；不存在第二个独立waiver字段。 |
| 当前有效人工决定为needs_pickup | needs_pickup | CoverageDecision，附原因、操作者、时间与镜头版本。 |
| 当前有效人工决定为usable，且至少一个被选中的关联已确认、源范围有效、原片在线 | usable | CoverageDecision.selected_link_ids及当前媒体事实；不由Take.good自动推导。 |
| 有TakeShotLink或已确认媒体关联，但未满足usable条件 | attempted | 已存在的场记/关联事实。 |
| 其余情况 | planned | 镜头存在但尚无已确认拍摄证据。 |

`CoverageDecision` 保存`usable | needs_pickup | clear`的人工事件及依据版本；`clear`撤销先前人工覆盖决定而不删场记。镜头实质内容变更后决定stale，重编号等显示性修改不使其失效。原片掉线不会删人工决定，但当前覆盖状态退回attempted并显示`previously_usable/source_offline`；重连验证后重新计算。

取消拍摄使用`waive`操作，原子更新Shot.required_status、requirement_reason并记审计；恢复操作明确目标required/optional。设置usable要求指明已确认片段，不允许凭一个good标签跳过审核。页面、coverage API、导出必须调用同一纯计算函数，额外返回细分事实计数和失效原因。

### 5.10 FR-10：导出与项目交换

P0 支持：

| 产物 | 必备内容 |
|---|---|
| 分镜 PDF | 项目/版本、镜号、图、动作、对白、景别/运动、叙事顺序；支持中文与灰度打印。 |
| 拍摄表 CSV/PDF | 日期/时区、计划版本、拍摄时间块、镜头/设置、人员/设备、冲突/待确认项。未批准必须标“草案”。 |
| 场记/素材 CSV | 镜号、条次、机位、原文件引用、时间范围、评级及确认状态；离线不能伪装为可交付。 |
| 项目 JSON | schema_version、稳定ID、镜头版本、分镜结构、计划、场记、媒体引用和来源；默认不含原片、密钥或完整私有日志。 |

JSON 导入先校验版本、枚举、引用与大小上限，再预览差异；默认创建新项目副本，不覆盖当前项目。缺失原片显示待重链接。需要包含分镜图片时使用显式“带派生图导出”，清单记录路径与哈希。

CSV 使用 UTF-8；提供适合常见表格软件的 BOM 选项。以 `= + - @` 等可能触发公式的用户文本按安全文本导出，避免 CSV 公式注入，保留机器可读原值的受控 JSON 出口。

### 5.11 FR-11：后台任务与模型调用

所有耗时操作通过任务执行，界面不等待完整哈希/转码/生成完成才能操作。

执行状态`execution_state`：`queued → running → succeeded | failed | cancelled | outcome_unknown`；本地中断且可恢复的任务可进入`interrupted`。独立字段`cancel_state=none | requested | confirmed | failed | unknown`记录取消请求，**不存在混入执行状态枚举的cancel_requested值**。另存`provider_state=not_submitted | accepted | running | succeeded | failed | cancelled | unknown`和`cost_state=reserved | settled | unknown`；缺少供应商证据不能推断已停止或免费。

- 每个任务有幂等键、输入版本/哈希、步骤、进度、输出清单、错误码和费用记录。
- 本地确定性步骤可重用缓存；单步任务最多 3 次外发尝试，包含解析修复与可重试网络请求。
- 收到 429 遵守 Retry-After，不密集循环。
- 超时而远端可能已接受的付费生成，先查询 provider job/idempotency 状态；无法核实时 `outcome_unknown`，不盲目重发收费。
- 取消远端任务是尽力而为，界面明确已发出的调用仍可能完成/计费。
- 已排队请求启动前再次检查输入版本、授权、预算和项目状态。
- 并发默认：1 个生成请求、1 个重媒体任务、1 个轻分析任务；在实测后调整，属于产品配置，不是性能保证。

预算按项目记录上限、已发生、已预留、未知费用。已知单价按保守最大量预留再发请求；价格未知时要求显式确认，并限制请求数/token/图像数量。应用只能阻止新调用，不能保证撤销已提交费用或替代供应商账单上限。

无模型密钥时仍能手工编辑、绘图、排期、导入和导出；AI按钮明确不可用。测试环境使用假 provider，不默认消耗真实配额。

#### 取消、晚到结果与费用结算

| 情况 | 状态与结果处理 | 预算处理 |
|---|---|---|
| 排队中且事务确认尚未外发 | execution=cancelled，cancel=confirmed，provider=not_submitted | 可释放尚未使用的预留，不计外发费用。 |
| 已提交后用户请求取消 | cancel=requested；execution不立即变cancelled | 保留预留；未取到费用凭据不能归零。 |
| 供应商确认已取消 | provider=cancelled；execution=cancelled；cancel=confirmed | 按供应商实际账单结转，可能有部分费用；未知则cost=unknown并保留保守占用。 |
| 取消失败/无法确认 | cancel=failed/unknown；execution继续运行或outcome_unknown | 继续占用预留，不重新提交同一收费请求。 |
| 请求取消后晚到成功 | provider/execution=succeeded；cancel不得伪写confirmed；output_disposition=held | 记录实际费用或unknown；不因用户取消而删掉账目。 |

取消记录必须先持久化，worker提交结果时在同一事务重查cancel_state和输入版本。取消后的晚到结果默认不应用到镜头/分镜/计划，也不覆盖缓存的正式输出，保留为held候选；只有输入仍有效且用户显式采用才能提交，否则仅允许查看/导出候选。远端回执按provider_job_id去重，重复回执不重复计费。

费用账目保存`reserved_amount`、可空`actual_amount`、币种、来源凭据和结算事件。只有确认未提交、取得供应商终态及可用费用信息，或经用户明确人工对账后，才释放或结转预留。供应商已完成但费用未知仍标unknown；估算不改写实际账单。API取消响应必须分别返回execution/cancel/provider/cost状态，不用单一cancelled表示四者。

## 6. P1 扩展契约

### 6.1 FR-12：AI 铅笔图

输入限定为选中镜头、对应结构草图、获授权角色/场景参考、手法模板与选定模型。每次默认一张候选，用户可增量生成；不自动批量重绘全项目。

生成结果保存在独立栅格层，与其输入 board/shot 版本绑定。用户手动采用，不改变结构层。对人物数、明显缺失角色、方向/道具等做辅助检查，但未实测前不承诺自动识别所有错误。

供应商适配器需声明参考图/编辑/尺寸/seed支持，不把同一请求强行发送给不兼容模型。选择 ComfyUI 路线时另外核对基础模型、控制模型与节点兼容性和硬件需求。

### 6.2 FR-13：自动日志与候选关联

- 本地转录候选为 whisper.cpp（Apple Silicon）；其他平台可比较 faster-whisper，多语言模型用于中文。
- 机器转录与人工修订分开，保存源范围、模型/参数与版本；不把词级时间戳当逐帧真值。
- 场记板 OCR、口述镜号、对白相似度、拍摄日与地点共同提供候选证据。
- 输出 Top-k 候选、分项匹配分数、冲突原因与拒识结果；未校准分数不得显示为“正确率99%”。
- 禁止仅靠视觉相似就自动移动/改名/删除媒体。关联可预填，但提交需要明确操作。
- PySceneDetect 仅用于已剪视频、参考片或适用长录的视觉边界候选，不替代 scene/shot/take 识别。

### 6.3 FR-14：约束优化

OR-Tools 接受经确认、版本化的资源/时间窗/依赖；求解前与求解后分别校验。目标可为换场、设置变化、等待、加班风险等，权重可解释，不把不同单位未经换算直接相加。

保留 solver status、时限、seed/配置、目标值与最优性信息。`UNKNOWN` 不等于无解；只有证明或显式矛盾才标 infeasible。冲突提示若是近似集合必须标明，不能承诺总能得到最小冲突集。

先支持单日增加资源约束；多日/多摄制组是另外的范围开关，不能顺带混入首次 P1 验收。

### 6.4 FR-15：剪辑软件交换

实现前只选一个目标软件、版本、交换格式和帧率集。OTIO 是候选中间表示，不保证目标软件原生支持或所有效果无损。

最小交付为人工选择的源范围、顺序、必要音轨及原片引用；不含复杂转场、变速、嵌套或自动成片。须测试代理到原片重链接、首尾帧、音画同步和离线异常。

## 7. 技术架构

### 7.1 组件与信任边界

```text
React Renderer（界面，不直接访问文件/密钥）
        │ 受限 preload IPC
Electron Main（文件选择、系统凭据、窗口、启动/关闭服务）
        │ 本地受认证命令
Python/FastAPI Sidecar
  ├─ 项目领域服务与 schema 校验
  ├─ SQLite 单写入口
  ├─ 持久化任务队列
  ├─ 规则排期 / 后续 OR-Tools
  ├─ 镜头/分镜结构生成与检查
  └─ 媒体与模型适配器
         ├─ ffprobe / FFmpeg 子进程
         ├─ 本地 ASR（P1）
         └─ 经授权的云模型
```

- Renderer 禁用 Node integration，开启 context isolation/sandbox，设置 CSP；不执行远程页面代码。
- Sidecar 只监听 `127.0.0.1`，使用每次启动随机认证令牌、受限 Host/Origin，不允许任意网页调用本地媒体服务。
- 凭据由 Main 从系统凭据库读取，通过受控通道传给需要它的适配器；不落入项目 JSON/日志。
- 文件请求使用授权根目录与资源 ID；路径规范化、符号链接与 `..` 逃逸都须验证。
- FFmpeg 等使用固定参数结构和参数数组调用，不拼接用户输入为 shell 命令；并限制资源、超时与取消。
- Python 服务是数据库唯一写入口，worker 返回结果由服务事务提交；避免多进程随意写 SQLite。

### 7.2 建议代码结构

```text
apps/desktop/
  main/                 # Electron、凭据、目录授权、生命周期
  preload/              # 类型化最小 IPC
  renderer/             # React 页面、分镜编辑器
services/core/
  api/                  # 本地 API
  domain/               # 镜头、计划、素材等业务规则
  schemas/              # 输入输出与持久化 schema
  storage/              # SQLite、迁移、事务、文件清单
  jobs/                 # 队列、恢复、预算
  adapters/             # LLM、图像、ASR、媒体、交换
  scheduling/           # 排序、独立校验、后续求解器
packages/contracts/     # 由共享契约生成/维护的 TS 类型
fixtures/               # 原创/获授权剧本与短媒体测试集
tests/                  # 单元、契约、集成、端到端
```

这只是建议实现布局，不代表目录或代码已创建。实现前锁定依赖版本，禁止凭“latest”生成不可重现构建。

### 7.3 项目数据目录

```text
project/
  project.json           # 项目标识、格式版本，不含密钥
  project.sqlite
  scripts/               # 不可变原始剧本版本
  references/            # 经用户明确导入的参考图与来源
  boards/                # 结构快照、预览图、可选生成图
  derivatives/           # 缩略图、代理、波形、转录
  manifests/             # 导入/导出与校验清单
  exports/
  recovery/              # 草稿/数据库恢复材料，不是媒体备份
```

原片默认保留在用户授权的外部目录。项目移动可能需要重链接，不能假装单个 JSON 包含所有媒体。

## 8. 数据模型

### 8.1 共同约定

- 主键 UUID；时间戳 UTC ISO-8601；拍摄计划保留显示时区。
- 可编辑聚合具有 `revision`；写入必须带 `expected_revision`，冲突返回 409，不静默覆盖。单对象更新匹配该对象revision；创建/合并或集合批量更新使用`expected_project_revision`并在同一事务递增项目revision。接口表中的未细化expected_revision按此约定解释，响应同时返回受影响对象及project_revision。
- `created_at/updated_at` 是系统记录时间，拍摄时间和故事时间另存。
- 业务删除采用归档/墓碑；原文件删除不在 P0 API 中。
- 不可变来源、版本与审计记录禁止就地更改。

### 8.2 核心实体

| 实体 | 关键字段 / 约束 | 阶段 |
|---|---|---|
| Project | id、name、timezone、aspect_ratio、schema_version、revision | P0 |
| ScriptVersion | id、project_id、content_hash、path、paragraph_index、parent_version_id | P0 |
| Scene | id、project_id、script_version_id、source_anchor、display_no、location_entity_id、story_time_label | P0 |
| Entity | id、project_id、type(character/location/prop)、name、aliases、attributes、verification_status | P0 |
| ReferenceAsset | id、entity_id可空、source_type、source_url/description、rights_note、local_asset_id、retention_policy | P0 |
| StylePreset | id、version、name、grammar、sources、limitations、resource_notes | P0 |
| Shot | id、scene_id、display_no、current_revision_id、locked、archived、required_status | P0 |
| ShotRevision | id、shot_id、revision、source_anchor、镜头字段、assumptions、resource_requirements、origin | P0 |
| NarrativeEntry | id、project_id、sequence_id、position、shot_id、usage_note；同 shot 可多次出现 | P0 |
| BoardVersion | id、shot_revision_id、board_spec、parent_board_id、raster_asset_id可空、status、input_hash | P0 |
| Resource | id、project_id、type(performer/location/equipment/crew)、capacity、name | P0 |
| CastAssignment | character_entity_id、performer_resource_id；映射可随版本变化 | P0 |
| ResourceWindow | id、resource_id、start_utc、end_utc、confirmed、source | P0 |
| Setup | id、location_resource_id、camera/lighting配置、resource_requirements、duration_estimates | P0 |
| Constraint | id、type、parameters、source、confirmed、revision、severity | P0 |
| ShootPlan | id、date、timezone、input_snapshot_hash、status、outcome、validator_version | P0 |
| ScheduleBlock | id、plan_id、type、start/end、setup_id、shot_ids、resource_allocations、locked、dependencies | P0 |
| Take | id、project_id、setup_id、take_no、camera_labels、actual_time、rating、notes、unresolved_shot_labels、revision | P0 |
| TakeShotLink | id、take_id、shot_id、source、created_at；同一take/shot对唯一，独立于任何媒体 | P0 |
| CoverageDecision | id、shot_id、decision(usable/needs_pickup/clear)、selected_link_ids、reason、basis_shot_revision、actor、created_at | P0 |
| MediaAsset | id、kind、original_name、content_hash、probe_metadata（含streams）、timebase、timecode_source、status、derivative_of | P0 |
| AssetLocation | id、media_asset_id、source_root_id、relative_path、volume_id、size、mtime、availability | P0 |
| ShotMediaLink | id、shot_id、media_asset_id、take_id可空、source_range（见8.3）、proxy_mapping_id可空、evidence、status、confirmed_at、revision | P0 |
| Job / AuditEvent | 幂等键、输入版本、execution/cancel/provider/cost状态、output_disposition、费用账目、错误 / 操作对象、旧新版本、行为来源 | P0 |
| TranscriptSegment / MatchCandidate | 词句源范围、机器/人工文本 / 候选镜头、分项分数、证据、版本 | P1 |
| EditSelection | 顺序、媒体引用、原始source_range、音轨与人工选择依据 | P1 |

`required_status`固定为`required | optional | waived`，其变更同时保存`requirement_reason`及审计；waived必须有原因，coverage中的waived只从此字段推导。不能仅因无素材就断言所有optional镜头都漏拍。CoverageDecision不能创建第二套取消拍摄状态。

媒体未完成哈希前拥有独立临时身份，完成后允许归并内容身份但保留每个位置及关联来源；此操作必须事务化。字节完全相同也不应自动合并不同拍摄语义的 take 记录。

### 8.3 时间表示

- 排期使用 UTC 瞬时与明确时区，不用媒体帧率单位。
- 媒体片段使用有理数时间基/原始 PTS；例：`pts=90000, time_base_num=1, time_base_den=90000` 表示 1 秒。
- 每个`source_range`引用具体媒体流/时间基，采用半开区间；终点必须大于起点，并落在该流已验证的PTS边界内。原流PTS允许为负，不擅自减去起始PTS或假定零起点；用户可另外查看相对时间。
- VFR 不以 `frame_index / nominal_fps` 代替真实 PTS；若 UI 显示帧号，必须有相应映射。
- 缺失 timecode、drop/non-drop、外部录音同步偏移分别存储，不能依赖文件创建时间推断同步。

#### source_range的冻结结构

所有ShotMediaLink/导入导出使用唯一字段名`media_asset_id`；`source_range`必须为以下结构，不接受浮点秒或把帧号塞进PTS：

```json
{
  "media_asset_id": "44444444-4444-4444-8444-444444444444",
  "source_range": {
    "stream_index": 0,
    "in_pts": 90000,
    "out_pts": 450000,
    "time_base_num": 1,
    "time_base_den": 90000
  }
}
```

契约约束：五个range字段均为JSON整数；`stream_index >= 0`，time_base_num/den为正；PTS限制在JS可精确表示的安全整数区间`[-9007199254740991,9007199254740991]`，超限返回UNSUPPORTED_TIMEBASE，不能舍入。该范围约束须同时存在于服务端schema和TS验证。

`stream_index`必须存在于被引用MediaAsset.probe_metadata.streams，time_base必须与该流记录完全一致；服务端禁止客户端偷偷重定义时间基。无可靠PTS边界时允许保存`candidate`范围，但不得确认usable或精确交付，需补充探测/映射验证。代理范围单独引用proxy_mapping_id映射回源PTS，不能覆盖source_range。

Schema至少拒绝：1.5等非整数PTS、不存在的流、0分母、与源流不一致的时间基、in>=out、越界与超出安全整数。CSV分别导出流索引、in/out_pts、time_base_num/den列，回读恢复原值，不只导出四舍五入后的秒数。

### 8.4 示例：镜头候选与结构图

下例是 API/测试用的最小结构示例，ID 和对白均为合成数据，不是电影原始分镜。完整 schema 按本章和功能约束补齐。

```json
{
  "schema_version": "0.1.0",
  "shot_candidate": {
    "client_ref": "candidate-01",
    "scene_id": "11111111-1111-4111-8111-111111111111",
    "source_anchor": {
      "script_version_id": "22222222-2222-4222-8222-222222222222",
      "paragraph_id": "p-003",
      "quote": "林走到门前，停了一下。"
    },
    "narrative_purpose": "在开门前延迟揭示房间内的信息",
    "action": "林走到门前停下，抬手但尚未敲门",
    "shot_size": "medium",
    "camera_angle": "eye_level",
    "camera_movement": "static",
    "estimated_screen_seconds": 4,
    "character_ids": ["33333333-3333-4333-8333-333333333333"],
    "assumptions": ["门的位置与实际场地需确认"],
    "requires_confirmation": true
  },
  "board_spec": {
    "version": 1,
    "aspect_ratio": [16, 9],
    "template": "single_subject_action",
    "subjects": [
      {
        "entity_id": "33333333-3333-4333-8333-333333333333",
        "x": 0.38,
        "y": 0.62,
        "scale": 0.55,
        "facing": "right",
        "pose": "hand_raised"
      }
    ],
    "props": [{"type": "door", "x": 0.73, "y": 0.5}],
    "overlays": [{"type": "label", "text": "停步，抬手", "x": 0.1, "y": 0.9}]
  }
}
```

## 9. 本地 API 契约

下列路由是**拟实现的本项目本地接口**，不是对任何外部产品 API 的描述。统一前缀 `/v1`；所有写入受认证、项目权限/目录 scope 和 revision 校验。

### 9.1 通用响应

同步成功：`{ "data": ..., "revision": 3 }`。

异步接受：HTTP 202，`{ "job_id": "uuid", "status": "queued" }`。

错误：`{ "error": { "code": "REVISION_CONFLICT", "message": "...", "details": {}, "retryable": false } }`。

典型错误：`VALIDATION_ERROR`、`REVISION_CONFLICT`、`LOCKED_SHOT`、`SOURCE_OFFLINE`、`SOURCE_CHANGED`、`PATH_NOT_ALLOWED`、`MISSING_CONFIRMATION`、`UNSUPPORTED_MEDIA`、`UNSUPPORTED_TIMEBASE`、`BUDGET_BLOCKED`、`PROVIDER_OUTCOME_UNKNOWN`、`SCHEMA_VERSION_UNSUPPORTED`。

### 9.2 最小接口清单

| 方法 / 路由 | 输入要点 | 行为 |
|---|---|---|
| POST /projects | name、workdir_grant_id、timezone、aspect_ratio | 创建项目；不能接受未授权任意路径。 |
| GET /projects/{p}/snapshot | 无 | 返回一致项目快照和revision。 |
| POST /projects/{p}/script-versions | 导入引用或文本、parent_version_id | 建新不可变剧本版本。 |
| GET /projects/{p}/scenes | cursor、limit | 列出场景与来源。 |
| POST /projects/{p}/scenes | 标题、origin、可空source_anchor、expected_project_revision | 手工/已确认导入建场景；manual须有说明。 |
| PATCH /projects/{p}/scenes/{s} | 合法字段、expected_revision | 修改元数据/归档；不改原始剧本。 |
| GET /projects/{p}/entities | type、cursor、limit | 列出角色/地点/道具及确认状态。 |
| POST /projects/{p}/entities | type、name、attributes、origin、expected_project_revision | 无模型也可手工创建设定。 |
| PATCH /projects/{p}/entities/{e} | 字段/归档标记、expected_revision | 改名/修订，保留稳定ID并标记依赖失效。 |
| POST /projects/{p}/entities/{e}/confirm | expected_revision | 确认设定来源/内容。 |
| POST /projects/{p}/entity-merges | source_ids、target_id、expected_project_revision、reason | 预览后显式确认；事务迁移引用、保留旧ID映射与审计。 |
| GET /projects/{p}/references | entity_id、cursor、limit | 列出参考与来源。 |
| POST /projects/{p}/references | source_type、授权文件/URL记录、rights_note、expected_project_revision | 建参考元数据；URL记录不自动下载。 |
| PATCH /projects/{p}/references/{r} | 元数据/归档标记、expected_revision | 更新来源、归档而非自动删除源图片。 |
| GET /projects/{p}/style-presets | 无 | 列出内置与项目模板。 |
| POST /projects/{p}/style-presets | name、grammar、sources、limitations、expected_project_revision | 保存用户手法模板。 |
| PATCH /projects/{p}/style-presets/{t} | 合法字段、expected_revision | 创建模板修订，不自动重绘。 |
| POST /projects/{p}/shots | scene_id、首个revision字段、manual_note、expected_project_revision | origin=manual；返回稳定shot_id及revision，不依赖LLM。 |
| POST /projects/{p}/shot-drafts | 范围、constraints/preset版本、max_shots、idempotency_key | 202；AI候选，不直接替换正式镜头。 |
| POST /projects/{p}/shot-drafts/{d}/apply | 选择的候选/目标ID、expected_revision | 原子应用；检查锁定、来源与冲突。 |
| PATCH /projects/{p}/shots/{s} | 合法字段、expected_revision | 创建镜头修订；锁定保护适用AI及批量覆盖。 |
| POST /projects/{p}/shots/{s}/archive | expected_revision、reason | 归档并保留素材引用，不删媒体。 |
| PUT /projects/{p}/narrative-sequences/{n} | 有序entry IDs/shot引用、expected_revision | 仅改叙事，不改排期。 |
| POST /projects/{p}/shots/{s}/boards | shot_revision_id、模板、idempotency_key | 自动结构图；后续图像生成用显式mode。 |
| PATCH /projects/{p}/boards/{b} | 受限board_spec、expected_revision | 保存编辑版本。 |
| GET /projects/{p}/resources | type可空 | 返回资源、窗口、选角与集合版本。 |
| PUT /projects/{p}/resources | 按稳定ID的upserts、显式archive_ids、窗口/选角变更、expected_project_revision | 事务upsert；未列项目保持不变，归档前检查引用；新项由服务端分配ID并返回映射。 |
| POST /projects/{p}/constraint-drafts | 自然语言、来源、idempotency_key | 202；生成待确认约束。 |
| POST /projects/{p}/constraints/confirm | draft IDs、修正值、expected_revision | 人工确认后生效。 |
| GET /projects/{p}/setups | cursor、limit | 读取设置、工时、资源与确认状态。 |
| POST /projects/{p}/setups | 配置、工时、资源、确认状态、expected_project_revision | 新建设置并返回稳定ID。 |
| PATCH /projects/{p}/setups/{u} | 字段/归档标记、expected_revision | 更新单项，不整表替换；变更使依赖计划stale。 |
| POST /projects/{p}/plans | 日期、镜头/设置、输入版本、idempotency_key | 202；生成草案与校验结果。 |
| PATCH /projects/{p}/plans/{q}/blocks | 时间块变更、expected_revision | 保存新版本并立即重校验。 |
| POST /projects/{p}/plans/{q}/validate | expected_revision | 返回逐项约束结果与未排清单。 |
| POST /projects/{p}/plans/{q}/approve | expected_revision、input_snapshot_hash | 事务内再次校验；不满足条件拒绝。 |
| POST /projects/{p}/takes | shot_ids:UUID[]、可空setup_id、条次、机位、评级、unresolved_shot_labels、expected_project_revision | 事务创建Take及TakeShotLink，媒体可尚不存在。 |
| PATCH /projects/{p}/takes/{t} | 字段与显式shot_link变更、reason、expected_revision | 更正场记；不删已有媒体，关系冲突需显式处理并留审计。 |
| POST /projects/{p}/media-imports | source_root_id、相对路径列表、idempotency_key | 202；索引/哈希/派生，不改原片。 |
| GET /projects/{p}/assets | filters、cursor、limit | 素材分页检索。 |
| POST /projects/{p}/assets/{a}/relink | 授权新位置、expected_revision | 先校验身份，再更新位置。 |
| POST /projects/{p}/shot-media-links | shot_id、media_asset_id、take_id可空、source_range、evidence、status、expected_project_revision | 采用8.3结构；校验流/PTS及TakeShotLink，默认candidate。 |
| PATCH /projects/{p}/shot-media-links/{l} | confirm/reject/unlink、expected_revision | 审核/撤销关联，不改媒体。 |
| GET /projects/{p}/coverage | approved_shot_set/version | 按5.9唯一规则返回覆盖状态、事实计数和失效原因。 |
| POST /projects/{p}/shots/{s}/coverage-decisions | operation(set_usable/request_pickup/clear/waive/restore)、selected_link_ids、reason、restore_required_status可空、expected_revision | 事务写决定/要求状态与审计；usable需有效确认片段；restore目标为required或optional。 |
| POST /projects/{p}/exports | type、版本、选项、目标grant、idempotency_key | 202；输出清单/哈希/警告。 |
| POST /project-import-previews | grant/file、target=new_project | 校验JSON并预览，不直接覆盖。 |
| POST /project-imports | preview_id、confirmation、idempotency_key | 创建副本并标记待重链接媒体。 |
| GET /jobs/{j} | 无 | 读取状态、结果、费用是否未知。 |
| POST /jobs/{j}/cancel | reason | 持久化取消请求，分别返回execution_state、cancel_state、provider_state、cost_state。 |
| POST /jobs/{j}/adopt-held-result | confirmation、expected_project_revision、expected_input_hash | 显式采用取消后晚到的候选；输入失效返回409，不自动应用。 |

任务更新使用受认证 SSE `/v1/events`，断线后可凭事件序号恢复；事件日志截断时重新获取项目/任务快照。普通刷新不重复创建收费任务。

## 10. 版本、失效与恢复

| 上游变化 | 必须采取的行为 |
|---|---|
| 剧本修改 | 旧版本不变；受影响锚点/镜头待复核；不自动重编号迁移身份。 |
| 人物/道具/场景设定变化 | 依赖分镜标 stale；不自动重新生图或覆盖已采用图。 |
| 镜头动作/资源变化 | 分镜或拍摄计划相应失效；由用户选择重绘/重排。 |
| 叙事顺序变化 | 只更新叙事与相关导出，拍摄顺序保持独立。 |
| 排期变化 | 原场记事实不变；导出注明新旧计划版本，已拍项不重新执行。 |
| 源文件内容变化 | 原分析结果不再绑定“新内容”；保留旧身份和错误证据，重新导入或人工处理。 |
| 模型/模板变化 | 缓存键失效；旧结果保留来源，按需重算而非全量自动更新。 |

本地中断恢复检查：数据库事务完整、任务输入版本仍有效、派生输出是否完整、原件是否在线、远端任务是否已提交。半成品先写临时文件，完成校验后原子提交；不要把存在文件名当作任务成功。

数据库迁移前用一致性备份方式保存 SQLite 快照，不能在 WAL 活跃时只复制主数据库文件并称已备份。迁移失败保持旧项目可恢复，避免自动循环迁移。

## 11. 非功能要求与安全

### 11.1 性能目标（待实测，不是已达性能）

- 在 A-07 规模及本地 SSD 上，已缓存镜头表/分镜视图交互目标 p95 < 200 ms。
- 1000 条媒体元数据分页检索目标 p95 < 500 ms；缩略图懒加载，不一次读取全部视频。
- 长任务创建后 1 秒内出现排队状态；全片哈希、转码和模型生成不设不真实的固定完成时间。
- 计时与成本日志记录测试硬件、输入大小、模型和缓存状态；不拿厂商 GPU 基准替代本机数据。
- 内存不能随原片大小线性增长：哈希/转码流式处理，避免将整片载入前端。

### 11.2 数据与隐私

- 只有用户选定目录可访问；以软链接/相对路径绕过 scope 必须被拒绝。
- 剧本、参考图、音频上云逐类别说明；项目授权可撤回，撤回阻止新请求但不伪称已删除服务商持有数据。
- 日志默认不记录密钥、完整原片路径、整段剧本和生物身份信息；诊断导出先预览和脱敏。
- 本地数据继承 OS 权限；不宣称实现了应用层加密。公开发行前另评估加密、签名、公证、更新和供应链安全。
- 不对演员做人脸身份识别；角色对应来自用户授权参考和手动映射。

### 11.3 模型安全与失效

- 模型不能直接调用任意 shell、发通告、改文件或提升权限。
- 把剧本里的“忽略规则”“上传文件”等文本当作剧本内容，不当作控制指令。
- 对生成/导入 SVG、HTML、富文本做白名单转换；结构分镜仅由受控 renderer 生成，不执行任意脚本。
- 记录模型/模板/输入版本，但不承诺相同 seed 在第三方服务不同版本间完全重现。

### 11.4 许可

本项目暂不确定开源或闭源发行方式，不预填最终 LICENSE。复用前锁定仓库 commit、许可证、NOTICE、依赖和模型条款。AI Movie Studio 2 根许可为 AGPLv3、ViMax 根许可为 MIT 的调研结果只作为选择依据；未经审核不复制大段实现或内置资产。

## 12. 验收测试

### 12.1 测试数据集

使用原创/获授权素材，至少包含：

- 两人对话、单人移动、双线交叉三个短剧本；带中文人名、地点别名、模糊动作和缺失资源。
- 10 个计划镜头、两处场地、演员窗口冲突、锁定时间块和一项不可用设备。
- 多条、多机位、跨卡同名文件、完全重复字节文件、无时间码、长录、VFR/CFR样例。
- 中断任务、掉盘、文件导入时变化、坏文件、无API key、429、远端超时但可能已收费。

### 12.2 Given / When / Then 验收清单

| ID | 条件与操作 | 通过标准 | 阶段 |
|---|---|---|---|
| AT-01 | 新建中文项目、编辑后关闭重开 | 事务已确认的数据完整，未保存操作可明确恢复；不出现假“已保存”。 | P0 |
| AT-02 | 导入含未知地点/角色别名的剧本，再修改原文 | 来源锚点可定位，假设单列；旧版本仍可读，不把新行号错误接到旧镜头。 | P0 |
| AT-03 | 用假provider返回非法JSON、不存在角色、过多镜头 | 拒绝应用；有可读错误；外发次数遵守上限，不污染镜头表。 | P0 |
| AT-04 | 锁定镜头后局部重生成；并模拟旧revision提交 | 锁定内容不被覆盖；过期写入返回409；无关镜头版本不变。 | P0 |
| AT-05 | 为预设镜头自动绘图，拖动角色、改箭头、撤销并导出 | 图表达角色/动作/方向，文本与图层可编辑；保存重开一致，黑白可读。 | P0 |
| AT-06 | 输入“参考诺兰”但无具体素材；再导入自制参考 | 输出可编辑通用手法，不捏造电影原镜头；来源类型与权利说明可追溯。 | P0 |
| AT-07 | 两演员不同时间窗、设置/移动工时、已锁定时间块 | 全部已排块通过独立校验；任一资源不被同时占用，工时不遗漏。 | P0 |
| AT-08 | 构造可行但贪心可能失败的数据，以及显式矛盾数据 | 分别返回search_incomplete/partial和带依据的proven_infeasible；不混淆。 | P0 |
| AT-09 | 改拍摄顺序；演员窗口变更；尝试批准旧方案 | 叙事顺序不变，旧计划stale，批准被阻止直到重校验。 | P0 |
| AT-10 | 无媒体时先建关联两个镜头的take，重启后再导入多机位/长文件 | TakeShotLink先于媒体持久化；多对多及源范围正确；删除一条关联不删原片或另一关联。 | P0 |
| AT-11 | 批量导入素材、生成代理、修改标签 | 所有输入样本前后完整哈希相同；原目录无派生文件；索引不显示备份成功。 | P0 |
| AT-12 | 同名/重复文件、增长文件、掉盘重连、VFR样例 | 保留位置身份；不误合并take；变化/离线明确；时间映射未验证则阻止精确交付。 | P0 |
| AT-13 | 必拍/可选/取消镜头混合，有场记无素材、有素材未确认、人工补拍及取消 | 覆盖计算、页面与导出一致；usable不从good推导；补拍/waiver原因可审计，不把所有optional判漏拍。 | P0 |
| AT-14 | 导出中文PDF/CSV/JSON并导入项目副本 | 中文无乱码、无截断关键字段；CSV无公式执行；引用完整；原片未包含时明确待重链接。 | P0 |
| AT-15 | 中断哈希/转码、重启应用、重复点击生成 | 本地任务安全恢复/重用结果，无重复正式记录；未确认远端结果不盲目重收费。 | P0 |
| AT-16 | 缺密钥从空项目手工建角色/场景/镜头/设置；再模拟超预算、429、已受理后取消但晚到成功 | 无AI流程可持久化/绘图/排期；无授权预算不外发；晚到结果不自动应用、不重复计费；保留unknown预留直至有据结算。 | P0 |
| AT-17 | 路径逃逸、恶意SVG、剧本提示注入、外部网页调用sidecar | 被拒绝或作为纯数据处理，不执行脚本/命令，不访问未授权目录。 | P0 |
| AT-18 | 用同角色/场景生成铅笔图并切换版本 | 栅格与结构分开，采用需确认；失败仍有结构图；输入来源/费用可查。 | P1 |
| AT-19 | 噪声/方言/多候选/错误板号素材 | 输出候选与证据，允许拒识；人工修订不覆盖机器原文；不自动判最佳take。 | P1 |
| AT-20 | 求解时限结束、真无解、临时演员缺席 | UNKNOWN与INFEASIBLE分开；已拍事实不改；新可行方案经过独立校验。 | P1 |
| AT-21 | 在选定NLE导入选段并重连原片 | 首尾帧、音画同步、source range通过检查；未支持效果/格式明确告警。 | P1 |

### 12.3 质量评估

自动测试通过之外，用 3—5 位实际拍摄者进行小样本试拍。比较人工流程与本项目的镜头修改时间、构图理解、排期调整次数、找素材耗时与误关联；记录每个可用分镜费用。先建立基线，不预设提效百分比，不把小样本推广为普遍结论。

P0 发布闸门：AT-01—17 全部通过；至少完成一次真实小拍摄的剧本→素材流程；仍未实现的 P1 功能不得在 UI 中伪装可用。若现场试拍尚未完成，只能称开发预览版。

## 13. 开发里程碑与任务切分

| 里程碑 | 主要任务 | 出口条件 |
|---|---|---|
| M0：技术与交互验证 | 锁定平台/版本；受限sidecar；剧本JSON；两个分镜模板；只读索引/代理spike；假provider | 三个风险路径有可运行样例与记录，决定是否保留技术栈。 |
| M1：项目与镜头 | Project/Script/Entity/Shot版本、来源锚点、CRUD、LLM草案、锁定/冲突、镜头表 | AT-01—04及基础安全检查。 |
| M2：分镜与参考 | 全部P0模板、图层编辑/撤销、来源与手法、PDF预览 | AT-05—06，至少一份中文分镜PDF可读。 |
| M3：拍摄计划 | 选角/资源窗口、设置工时、约束确认、规则排序、独立校验、批准与stale | AT-07—09，不把启发式失败当无解。 |
| M4：场记与素材 | take、只读导入/哈希、代理、位置、片段关联、漏拍与CSV/JSON | AT-10—14，多对多与原件安全通过。 |
| M5：可试拍P0 | 任务恢复、费用/授权、安全回归、打包、真实小拍摄 | AT-01—17及一次完整现场试用。 |
| M6：P1增强 | 按实际痛点选择铅笔图、转录/OCR、求解器和一个NLE | 各自对应AT-18—21，不为凑版本同时塞入所有扩展。 |

依赖：M0 → M1；M2/M3 可在共同契约稳定后并行；M4可提前做只读导入，但镜头关联依赖M1；M5整体验收；M6不阻塞P0。

预计工作量需在 M0 后结合每周投入与实际速度重估。前期研究中的约7—11周以上只是条件化半自动试用版估算，不是本文承诺的交付日期。

### Coding Agent 实施约束

- 先实现纵向路径，再扩展模型/模板数量；每次任务限定模块和验收用例。
- 不因为本文列出技术就自动安装全套依赖、调用付费API或更改机器全局配置；实际操作仍需用户授权。
- 不生成不存在的供应商端点/SDK能力；适配器先用mock，真实集成读当期官方文档。
- 需求或契约变化先更新spec与测试，不绕过失败用例完成演示。
- 不复用未知许可证的外部代码/素材，不把本spec当作采购或部署授权。

## 14. 开放决策与完成定义

| 决策 | 当前状态 | 最迟确定时间 |
|---|---|---|
| 自用/社团还是公开发行 | A-01暂定自用 | M0前 |
| 平台与技术栈 | A-02/A-03暂定 | M0出口 |
| 线稿与铅笔图首发优先级 | A-05暂定 | M0前 |
| LLM/图像供应商、预算与云传输范围 | 未选定 | 首次真实外发前 |
| 模型与依赖许可、项目发行许可 | 未冻结 | 代码复用/发行前 |
| 目标NLE/版本/交换格式 | 未选定 | FR-15开始前 |
| 实拍测试人员、素材、场地许可 | 待提供 | M5现场验收前 |
| 每周开发投入与交付时间 | 未提供 | M0后重估 |

**P0 Done：** 用户可以把一段剧本拆成可修改镜头与结构分镜，安排经过校验的拍摄计划，记录条次，导入原片并关联镜头，导出可读交付物；原片不受破坏，失败可恢复，全部P0验收与一次试拍完成。

**不等于 Done：** 只有页面截图、AI生成样图、伪造进度、硬编码演示数据，或仅凭README声称已具备生图/求解/剪辑兼容能力。

## 15. 设计依据与证据边界

本规格基于同项目的《AI实拍分镜工作台：调研与项目规划》（2026-09-25）。研究稿是背景，不是额外隐含需求；本spec的优先级、契约与验收定义作为本版本开发依据，仍受第1节暂定假设约束。

参考项目/技术：
- Storyboarder：<https://wonderunit.com/storyboarder/>
- Boords：<https://boords.com/storyboard-software>
- Storyboarder.ai：<https://www.storyboarder.ai/>
- ViMax：<https://github.com/HKUDS/ViMax>
- AI Movie Studio 2：<https://github.com/Heroesjouney/AIMovieStudiov2>
- OR-Tools：<https://developers.google.com/optimization/scheduling/job_shop>
- whisper.cpp：<https://github.com/ggml-org/whisper.cpp>
- OpenTimelineIO：<https://github.com/AcademySoftwareFoundation/OpenTimelineIO>
- Electron安全：<https://www.electronjs.org/docs/latest/tutorial/security>

这些链接解释技术选择，不代表本次已运行其代码、确认其当前价格或通过本项目测试。所有功能、性能、费用和工期的最终结论须来自后续实际实现与验收。
