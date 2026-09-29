# S3 风格化拆镜、润色、计划用剧本演员表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆镜可选风格卡和难度（含用本组 key 的风格研究），已有镜头可 AI 润色，计划直接用剧本角色的演员姓名。

**Architecture:** 风格卡是项目级数据（内置卡在 core，组内卡在新表 `style`），拆镜和润色的请求带 `style_id` + `level`，服务器把卡的文字放进提示词。研究和润色都是新的远程任务（structuredCall，≤3 次外发，结果进草案）。演员姓名落在 `entity.actor_name`，由 core 纯函数读人物表、生成计划同步预览。

**Tech Stack:** TypeScript monorepo：contracts (zod 4)、core（纯函数）、server（Hono + node:sqlite）、web（React 19 + TanStack Query + Tailwind v4）；vitest；Playwright。

**Spec:** `docs/superpowers/specs/2026-09-29-s3-style-polish-cast-design.md`

## Global Constraints

- 代码、提示词、界面、测试数据里不出现真实导演、片名、IMAX（docs/CLEANROOM.md §3）。测试用人名全部原创。
- 模型只输出语义枚举和短文本；zod + 业务校验；结果先进草案（INV-03）。
- 每步最多外发 3 次（`MAX_ATTEMPTS = 3`），`maxRetries: 0`；新远程任务加进 `LLM_JOB_KINDS`。
- key 不进日志、草案、前端；新增的设置字段都不是秘密。
- 演员姓名不进任何提示词。
- `packages/core` 不 import `node:*`，不用 `Date.now`、`Math.random`、`fetch`、`process`。
- 没有风格、没有风格要求、难度为 steady 时，拆镜消息与 `breakdown-v1` 逐字相同。
- 测试文件以里程碑命名：`s3-*.test.ts`、`s3a-*.test.ts`、`s3b-*.test.ts`；用 FakeChat / fake OpenAI，不联网。
- 不新增依赖；不 push、不 publish。
- 界面文案中文，用现有组件（Button、Field、FormRow、Notice、Tag、Dialog、InspectorGroup）和 token 类名，不写内联样式。

## File Map

| 文件 | 职责 |
|---|---|
| `packages/contracts/src/style.ts`（新） | StyleLevel、StyleCard、StyleCardInput、StyleDefaults、StyleLibrary、StyleResearchInput、StyleResearchOutput |
| `packages/contracts/src/shot.ts` | Movement +orbit/aerial/dolly_zoom；ShotFields.camera_notes（可选可空）；DraftKind +style/polish |
| `packages/contracts/src/job.ts` | JobKind +research_style/polish_shots |
| `packages/contracts/src/entity.ts` | Entity.actor_name |
| `packages/contracts/src/cast.ts`（新） | CastSuggestion、CastApplyInput、CastSyncChange、CastSyncPreview、CastSyncApplyInput |
| `packages/contracts/src/api.ts` | BreakdownRequest +style_id/level；Polish*；provider research 字段；entity actor_name；路由 |
| `packages/contracts/src/project.ts` | PROJECT_SCHEMA_VERSION = 3 |
| `apps/server/src/db/migrations/003_style_cast.ts`（新） | style 表；entity.actor_name + 回填 |
| `apps/server/src/db/repos/style.ts`（新） | style 行 ↔ StyleCard；kv style_defaults |
| `packages/core/src/presets/styles.ts`（新） | 8 张内置风格卡、findStyle |
| `packages/core/src/prompt/breakdown.ts` | v1 不变；v2（风格、难度、新运镜、拍法说明）；`breakdownPromptVersion` |
| `packages/core/src/prompt/style.ts`（新） | 研究提示词与校验 |
| `packages/core/src/prompt/polish.ts`（新） | 润色提示词与校验 |
| `packages/core/src/script/cast.ts`（新） | readCastList（人物表识别） |
| `packages/core/src/schedule/cast-sync.ts`（新） | planCastSync（计划同步预览） |
| board、i18n、normalize、shot-line、image 提示词 | 新运镜的画法、标签、同义词 |
| `apps/server/src/adapters/llm/{chat,openai-chat,structured}.ts` | extra_body；被拒时去掉再发 |
| `apps/server/src/config/text-provider.ts` | 研究模型、联网开关、searchBody |
| `apps/server/src/ai/runtime.ts` | AiClient.research |
| `apps/server/src/ai/style-jobs.ts`（新） | startStyleResearch |
| `apps/server/src/ai/polish-jobs.ts`（新） | startPolish |
| `apps/server/src/services/styles.ts`（新） | 风格库 CRUD、默认、保存研究结果、resolveStyle |
| `apps/server/src/services/polish.ts`（新） | applyPolish |
| `apps/server/src/services/cast.ts`（新） | 人物表建议/应用、计划同步预览/应用 |
| `apps/server/src/routes/styles.ts`（新） | 风格路由 |
| web：`views/script/StyleLibraryDialog.tsx`、`PolishDialog.tsx`、`PolishDiffDialog.tsx`、`CastDialog.tsx`；`views/plan/CastSyncDialog.tsx` | 新界面 |

---

## S3 风格化拆镜与风格研究

### Task 1: 契约（lead）

**Files:** Modify `packages/contracts/src/{shot,job,entity,api,project,index}.ts`；Create `style.ts`、`cast.ts`。

**Produces（后续任务依赖的确切名字）：**

```ts
// style.ts
StyleLevel = z.enum(['steady', 'bold', 'extreme'])
StyleOrigin = z.enum(['builtin', 'custom', 'researched'])
StyleBias = z.object({ shot_size: z.array(ShotSize), angle: z.array(CameraAngle), lens: z.array(LensClass), movement: z.array(Movement) })
StyleCard = z.object({ id, name(≤24), summary(≤80), grammar(1..800), bias: StyleBias, gear(≤300), low_budget(≤300), origin: StyleOrigin, reference: string(≤200)|null, unverified: boolean, created_at: IsoTime|null, updated_at: IsoTime|null })
StyleCardInput = { name, summary, grammar, bias, gear, low_budget }（trim 后同样的上限）
StyleDefaults = { style_id: string|null, level: StyleLevel }
StyleLibrary = { cards: StyleCard[], defaults: StyleDefaults }
StyleResearchInput = { reference: string(2..200), notes: string(≤300)|null }
StyleResearchOutput = { name, summary, grammar, shot_size_bias[], angle_bias[], lens_bias[], movement_bias[], gear, low_budget, confidence: 'high'|'medium'|'low', caveats: string[] }
// shot.ts
Movement += 'orbit' | 'aerial' | 'dolly_zoom'
ShotFields.camera_notes: z.string().nullable().optional()
DraftKind += 'style' | 'polish'
// job.ts
JobKind += 'research_style' | 'polish_shots'
// entity.ts
Entity.actor_name: z.string().max(40).nullable()
// api.ts
BreakdownRequest: reference_note ≤800；style_id: string|null（default null）；level: StyleLevel（default 'steady'）
PolishMode = z.enum(['refine', 'improve', 'rewrite'])
PolishRequest = { shot_ids: Uuid[1..12], mode, instruction: string(≤500)|null, style_id: string|null, level: StyleLevel }
PolishOutput = { shots: { ref: string, change_note: string, fields: ShotFields.omit({source}) }[] }
ApplyPolishInput = { selected: int[], expected_revisions: Record<string,int> }
ApplyPolishResult = { updated: Shot[], skipped_locked_ids: Uuid[], skipped_missing_ids: Uuid[] }
TextProviderView += research_model: string|null, research_search: boolean, search_support: 'dashscope'|'openai'|null
SaveTextProviderInput += research_model?: string|null, research_search?: boolean
CreateEntityInput/UpdateEntityInput += actor_name?: string(≤40)|null
// cast.ts
CastMatch = z.enum(['exact', 'alias', 'near', 'none'])
CastSuggestion = { line, actor_name, character_label, entity_id: Uuid|null, entity_name: string|null, match: CastMatch, split_alias: string|null, current: boolean }
CastApplyInput = { items: { entity_id: Uuid|null, actor_name, split_alias: string|null, new_character_name: string|null }[] }
CastSyncKind = z.enum(['create_performer', 'add_cast', 'move_cast', 'create_location'])
CastSyncChange = { kind, resource_id: Uuid|null, resource_name, entity_id: Uuid, entity_name, from_resource_id: Uuid|null, from_resource_name: string|null }
CastSyncPreview = { changes: CastSyncChange[], hash: string }
CastSyncApplyInput = { hash: string, include_locations: boolean }
// routes
getStyles GET /api/v1/styles → StyleLibrary
createStyle POST /api/v1/styles (StyleCardInput) → StyleCard
updateStyle PUT /api/v1/styles/:id (StyleCardInput) → StyleCard
deleteStyle DELETE /api/v1/styles/:id → { id }
saveStyleDefaults PUT /api/v1/styles/defaults (StyleDefaults) → StyleLibrary
researchStyle POST /api/v1/styles/research (StyleResearchInput) → JobAccepted
saveResearchedStyle POST /api/v1/drafts/:id/save-style (StyleCardInput) → StyleCard
requestPolish POST /api/v1/shots/polish (PolishRequest) → JobAccepted
applyPolish POST /api/v1/drafts/:id/apply-polish (ApplyPolishInput) → ApplyPolishResult
castSuggestions GET /api/v1/entities/cast → CastSuggestion[]
applyCast POST /api/v1/entities/cast (CastApplyInput) → Entity[]
castSyncPreview GET /api/v1/resources/cast-sync → CastSyncPreview
applyCastSync POST /api/v1/resources/cast-sync (CastSyncApplyInput) → Resource[]
```

- [ ] 写契约；`npm run typecheck` 修掉所有构造点（Entity 行映射、测试里的 BreakdownRequest 常量改用 `z.input`）。
- [ ] 提交 `feat(contracts): S3 styles, polish and cast contracts`。

### Task 2: 迁移 3 与仓储（lead）

**Files:** Create `apps/server/src/db/migrations/003_style_cast.ts`、`apps/server/src/db/repos/style.ts`；Modify `migrations/index.ts`、`repos/entity.ts`。

```sql
CREATE TABLE style (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL, grammar TEXT NOT NULL,
  bias_json TEXT NOT NULL, gear TEXT NOT NULL, low_budget TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('custom','researched')),
  reference TEXT, unverified INTEGER NOT NULL DEFAULT 0 CHECK (unverified IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
ALTER TABLE entity ADD COLUMN actor_name TEXT;
UPDATE entity SET actor_name = (
  SELECT r.name FROM resource r, json_each(r.cast_character_ids_json) j
  WHERE r.type = 'performer' AND j.value = entity.id)
WHERE type = 'character' AND (
  SELECT COUNT(*) FROM resource r, json_each(r.cast_character_ids_json) j
  WHERE r.type = 'performer' AND j.value = entity.id) = 1;
```

- repos/style.ts：`listStyles(db)`、`getStyle(db,id)`、`insertStyle(db,card)`、`updateStyleRow(db,card)`、`deleteStyleRow(db,id)`、`readStyleDefaults(db): StyleDefaults`（默认 `{style_id:null, level:'steady'}`）、`writeStyleDefaults(db, d, now)`（kv 键 `style_defaults`）。
- repos/entity.ts：COLS 加 `actor_name`，insert/update 写入。
- [ ] 测试 `apps/server/test/s3-migration.test.ts`：v2 库（含两个演员资源，一个角色被两人饰演）迁到 v3 后，只有唯一饰演的角色得到 actor_name；style 表存在。
- [ ] 提交。

### Task 3: 新运镜与拍法说明（sonnet 子代理）

**Files:** `packages/core/src/i18n/zh.ts`（ZH_MOVEMENT：环绕、航拍、变焦推拉）、`packages/core/src/shots/normalize.ts`（同义词：orbit ← 环绕/环拍/arc/360；aerial ← 航拍/无人机/drone；dolly_zoom ← 变焦推拉/滑动变焦/vertigo；camera_notes 缺失补 null）、`packages/core/src/script/shot-line.ts`（航拍 → aerial，环绕 → orbit，变焦推拉 → dolly_zoom）、`packages/core/src/prompt/image.ts`（两张运镜描述表）、`packages/core/src/board/render.ts` 与 `pencil-overlay.ts`（三种新画法：orbit 为画面下部的椭圆弧箭头；aerial 为右上角无人机符号加向下箭头；dolly_zoom 为四角向内箭头加中部「变焦推拉」小字）、`packages/core/src/shots/validate.ts`（camera_notes 超过 300 字给 warning `camera_notes_long`）、`apps/web/src/lib/labels.ts`（MOVEMENT_LABEL、字段标签「拍法说明」）、`apps/web/src/views/script/ShotEditor.tsx`（机位组加「拍法说明」TextArea，maxLength 300，空串存为 null）、`ShotRow.tsx`（有拍法说明时在动作下方一行 text-xs 灰字）。
- 空的 camera_notes 在服务器写入前删除这个键（Task 6 的 `cleanFields`），所以旧镜头内容哈希不变。
- [ ] 测试：`packages/core/test/s3-movements.test.ts`（三种新运镜渲染出 `data-camera-move`，两种渲染器；同义词；分镜脚本词表）；现有 golden 不变。
- [ ] 提交。

### Task 4: 内置风格卡与拆镜 v2 提示词（lead）

**Files:** Create `packages/core/src/presets/styles.ts`；Modify `packages/core/src/prompt/breakdown.ts`、`packages/core/src/index.ts`。

**Produces:**
```ts
export const BUILTIN_STYLES: readonly StyleCard[]            // 8 张，id 形如 'style.track-low'
export function findBuiltinStyle(id: string): StyleCard | null
export const BREAKDOWN_PROMPT_VERSION_V2 = 'breakdown-v2'
export interface BreakdownStyle { name: string; grammar: string; bias: StyleBias; gear: string; low_budget: string; unverified: boolean }
BreakdownPromptInput += style?: BreakdownStyle | null; level?: StyleLevel
export function breakdownPromptVersion(input: BreakdownPromptInput): 'breakdown-v1' | 'breakdown-v2'
export const LEVEL_LABEL: Record<StyleLevel, string>          // 稳妥 / 进取 / 挑战
```
- v2 system：v1 的规则 1–9 保留；规则 4 的 movement 加三种新值；新增字段 camera_notes 的说明；【拆镜原则】按难度给不同段落（steady 保留「宁可少而准」；bold/extreme 要求有难度的镜头写 camera_notes 和 assumptions 里的器材；extreme 额外要求低成本替代和安全注意）。
- v2 user：v1 的区块后加【风格】（名称、镜头语言、偏好、器材、低成本替代；研究卡加一句「以下是通用手法整理，未核实」）和【难度】。
- [ ] 测试 `packages/core/test/s3-breakdown-v2.test.ts`：无风格且 steady → 与 v1 消息逐字相同、版本 v1；有风格 → v2、包含风格名和 grammar、不包含 reference；extreme 文本包含「低成本替代」；内置卡名字不含任何在世导演或片名（用 claims.ts 的触发词表检查）；8 张卡都能过 StyleCard.parse。
- [ ] 提交。

### Task 5: 研究用模型与联网参数（lead）

**Files:** `adapters/llm/chat.ts`（ChatRequest.extra_body）、`openai-chat.ts`（展开到请求体）、`structured.ts`（`extraBody` 选项；带着它时遇到 400/422，除非消息明确是 response_format 问题，否则去掉 extraBody 再发，记 lastProblem「服务商不支持联网搜索参数，已改为不联网」）、`config/text-provider.ts`（credentials.llm 的 research_model、research_search；`searchSupport(base_url)`；`searchBody(base_url, model)`；view 与 save）、`ai/runtime.ts`（`AiClient.research: { cfg: TextClientConfig; extraBody: Record<string, unknown> | null }`）、`routes/settings.ts` 不变（走 view）。
- [ ] 测试 `apps/server/test/s3-research-provider.test.ts`：保存研究模型和联网开关后 view 正确；fake OpenAI 收到 `enable_search: true`（dashscope 主机名用 FakeChat 的 cfg 覆盖检验 searchBody 纯函数）；第一次 400 后第二次请求不带联网参数；共 2 次外发。
- [ ] 提交。

### Task 6: 风格库服务、研究任务、拆镜接入（lead）

**Files:** Create `services/styles.ts`、`routes/styles.ts`、`ai/style-jobs.ts`、`packages/core/src/prompt/style.ts`；Modify `ai/jobs.ts`（breakdownContext 解析 style、level；版本按 `breakdownPromptVersion`）、`services/quota.ts`、`app.ts`（注册路由）、`services/shots.ts` 与 `services/drafts.ts`（`cleanFields`：camera_notes 为空时删除键）。

**Produces:**
```ts
// core prompt/style.ts
export const STYLE_RESEARCH_PROMPT_VERSION = 'style-research-v1'
export function buildStyleResearchMessages(input: { reference: string; notes: string | null }): ChatMessage[]
export function validateStyleResearch(out: StyleResearchOutput): { ok: boolean; errors: string[]; warnings: string[] }
export function styleCardInputFromResearch(out: StyleResearchOutput): StyleCardInput   // 截断到上限
// server services/styles.ts
export function styleLibrary(db): StyleLibrary
export function createStyle(db, input, origin = 'custom', reference = null, now?): StyleCard
export function updateStyle(db, id, input, now?): StyleCard     // 内置卡 → 403
export function deleteStyle(db, id): { id }                      // 同时清掉默认
export function saveStyleDefaults(db, d): StyleLibrary           // style_id 必须存在
export function resolveStyle(db, id: string | null): StyleCard | null  // 不存在 → 400
export function saveResearchedStyle(db, draftId, input): StyleCard     // 草案 kind style + pending → applied
```
- 研究任务：`resolveAi` → 用 `ai.research.cfg` 和 `extraBody` 调 structuredCall（schema StyleResearchOutput，validate 返回 errors 用于修复轮）→ 草案 kind `style`、scope `{ reference, notes }`。demo 模式直接 409「演示模式不能研究新风格」。
- [ ] 测试 `apps/server/test/s3-styles.test.ts`：列表含 8 张内置卡；新建/编辑/删除组内卡；删除默认卡后默认变 null；研究任务（fake OpenAI）→ 草案 → 保存为 researched、unverified；研究计入配额（hosted limits 1 时第二个任务 409）；拆镜带 style_id + bold 时 fake 收到的 system 含「拍法说明」、user 含风格名；不带时请求体与 v1 相同；不存在的 style_id → 400。
- [ ] 提交。

### Task 7: 风格界面（sonnet 子代理）

**Files:** Create `apps/web/src/views/script/StyleLibraryDialog.tsx`、`apps/web/src/lib/queries-style.ts`；Modify `ScriptWorkspace.tsx`（标题栏「风格」按钮，Palette 图标，打开抽屉）、`SceneInspector.tsx`（BreakdownGroup：风格 select、难度三段按钮、风格要求 800 字、外发说明）、`TextProviderPanel.tsx`（研究用模型、联网开关、支持说明）、`lib/jobs.ts`（JOB_KIND_LABEL 两个新任务；`STYLE_RESEARCH_SLOT`）、`lib/labels.ts`（LEVEL_LABEL、LEVEL_HINT）。
- 抽屉：「本组默认」区（风格 select + 难度）；「研究新风格」表单（参考、补充说明、研究按钮、JobLine、完成后展示草案卡片可编辑并「保存为风格卡」「放弃」）；「本组的风格卡」列表（编辑、删除、设为默认）；「内置风格卡」列表（只读，可设为默认、可「复制一份再改」）。研究卡显示 Tag「未核实」和参考原文。
- [ ] 测试 `apps/web/test/s3-style-web.test.ts`（纯函数：表单校验、草案转输入）；e2e `e2e/s3-style.spec.ts`（fake OpenAI：研究 → 保存 → 拆镜选择该风格和挑战档 → 草案出现）。
- [ ] 提交；README 加 S3 行、徽章改 S3。

---

## S3a 润色

### Task 8: 润色提示词（lead）

**Files:** Create `packages/core/src/prompt/polish.ts`。

```ts
export const POLISH_PROMPT_VERSION = 'polish-v1'
export interface PolishPromptShot { ref: string; scene: { display_no: string; heading: string }; source_text: string; fields: Omit<ShotFields, 'source'>; prev: string | null; next: string | null }
export interface PolishPromptInput { mode: PolishMode; instruction: string | null; shots: PolishPromptShot[]; roster: Pick<Entity,'alias'|'name'|'aliases'>[]; techniques: {id,name,shot_grammar}[]; style: BreakdownStyle | null; level: StyleLevel; frame_format: FrameFormat }
export function buildPolishMessages(input): ChatMessage[]
export function validatePolish(out: PolishOutput, ctx: { refs: string[]; aliases: string[]; technique_ids: string[]; mode: PolishMode; before: Record<string, Omit<ShotFields,'source'>> }): { issues: DraftIssue[]; error_count: number }
export function polishRepairErrors(v): string[]
export function shotOneLine(f: Pick<ShotFields,'shot_size'|'action'>): string
```
- [ ] 测试 `packages/core/test/s3a-polish-prompt.test.ts`：消息含每个 ref、出处原文、用户要求（作为数据）、不含 source 字段；缺 ref / 重复 ref / 未知 ref → error；细化改了景别 → warning `refine_changed_framing`；未知别名 → error。
- [ ] 提交。

### Task 9: 润色任务与应用（lead）

**Files:** Create `ai/polish-jobs.ts`、`services/polish.ts`；Modify `routes/drafts.ts`、`routes/shots.ts`、`services/drafts.ts`（draftDetail：polish 草案的 current_shots = scope 里的镜头）、`services/quota.ts`。
- startPolish：镜头必须存在、未归档、未锁定，且属于当前剧本版本；最多 12 个；按场次与叙事顺序排好，分配 s1…sN；前后镜头摘要取同场相邻镜头；scope `{ shot_ids, refs, expected_revisions, mode, instruction, style_id, level }`。
- applyPolish：草案 kind polish 且 pending；逐个 selected：镜头已删/归档 → skipped_missing；锁定 → skipped_locked；revision ≠ expected → 409 REVISION_CONFLICT；有 error 的条目不可应用；新 fields = 模型 fields + 原 source（cleanFields）；updateShotRow + 修订（origin 'ai'，reason「AI 润色（细化）：要求前 60 字」）；草案 applied。
- [ ] 测试 `apps/server/test/s3a-polish.test.ts`：两镜润色 → 草案 → 应用 → revision+1、source 不变、修订 origin ai；锁定镜头请求 → 409；请求后镜头被改 → 应用 409；模型改了 source 也不生效；配额计入。
- [ ] 提交。

### Task 10: 润色界面（sonnet 子代理）

**Files:** Create `views/script/PolishDialog.tsx`、`PolishDiffDialog.tsx`；Modify `context.ts`（selection：`selecting`、`selected: ReadonlySet<string>`、`toggleSelect`、`setSelecting`、`openPolish(shotIds)`）、`ShotTable.tsx`（「选择」开关、每场「全选本场」、底部选择栏「AI 润色（N）」「取消」）、`ShotRow.tsx`（选择模式下的复选框列；菜单「AI 润色…」，锁定时禁用）、`ShotEditor.tsx`（概况组「AI 润色…」按钮）、`ScriptWorkspace.tsx`（挂载两个对话框、润色 JobLine 放在镜头表顶部，slot `polish`）、`lib/queries.ts`（useRequestPolish、useApplyPolish）、`lib/drafts.ts`（polish 草案识别）。
- PolishDialog：方式三选一（细化 / 优化 / 重写，各有一句说明）、润色要求、风格、难度、外发说明（镜头数、发到哪里、最多 3 次）。
- PolishDiffDialog：每个镜头一张卡：左「改前」右「改后」，改动字段名加粗并列出（`changedFieldLabels`）、模型的改动说明、问题列表、复选框；底部「放弃草案」「应用所选（N）」；冲突时「刷新后重试」。
- [ ] 测试 `apps/web/test/s3a-polish-web.test.ts`（选择集合逻辑、diff 字段）；e2e `e2e/s3a-polish.spec.ts`。
- [ ] 提交；README 加 S3a 行、徽章改 S3a。

---

## S3b 计划直接用剧本演员表

### Task 11: 人物表识别与计划同步（core，sonnet 子代理）

**Files:** Create `packages/core/src/script/cast.ts`、`packages/core/src/schedule/cast-sync.ts`；Modify `packages/core/src/index.ts`。

```ts
export interface CastCharacter { id: string; name: string; aliases: string[]; actor_name: string | null }
export function castBlockLines(preScene: readonly string[]): string[]
export function readCastList(preScene: readonly string[], characters: readonly CastCharacter[]): CastSuggestion[]
export function splitActorNames(s: string): string[]      // 按 、，,;；/ 拆，去空白、去重
export function planCastSync(input: { characters: {id,name,actor_name}[]; locations: {id,name}[]; resources: Resource[] }): CastSyncChange[]
export function castSyncHash(changes: CastSyncChange[]): string
```
- 规则见 spec。示例（原创人名）：
  - `周远：林川：主角` + 角色林川 → exact，actor 周远；
  - `孙晴：林川长大后` + 林川的别名「林川长大后」且林川另有演员 → alias，split_alias「林川长大后」；
  - `顾一鸣：林川的朋友` + 角色「朋友」→ near；
  - `沈老师：林川的母亲` 且无对应角色 → none；
  - `林川（周远 饰）`、`周远 饰 林川`、`林川——周远` 都识别。
- [ ] 测试 `packages/core/test/s3b-cast.test.ts`、`s3b-cast-sync.test.ts`：上面的例子；同一演员两角色合并；角色从别的演员资源移走（move_cast）；没写演员的角色不动；已有场地资源的地点不再建；hash 稳定。
- [ ] 提交。

### Task 12: 演员字段、人物表应用、计划同步、通告单（lead）

**Files:** Create `services/cast.ts`；Modify `services/entities.ts`（actor_name 清理：trim、空串 → null、≤40）、`routes/entities.ts`、`routes/resources.ts`、`packages/core/src/export/tables.ts`（blockRow 演员列「周远（饰 林川）」，PlanLookup 带角色名）。
- castSuggestions：当前剧本第一场之前的段落 + 角色列表 → readCastList。
- applyCast：逐条：entity_id 有 → 设 actor_name（split_alias 有 → 从该角色别名里删掉，新建角色 name=split_alias、actor_name）；entity_id 为 null 且 new_character_name 有 → 新建角色。单事务。
- castSyncPreview / applyCastSync：hash 不一致 → 409「剧本或计划刚被修改，请重新打开同步」；新建演员 windows `[]`、confirmed false；move_cast 从原资源移走该角色。
- [ ] 测试 `apps/server/test/s3b-cast.test.ts`：导入带人物表的原创剧本 → 建议正确 → 应用后 actor_name；拆分别名；同步预览 → 应用 → 资源；再次预览为空；通告单 CSV 演员列带「饰」。
- [ ] 提交。

### Task 13: 演员界面（sonnet 子代理）

**Files:** Create `views/script/CastDialog.tsx`、`views/plan/CastSyncDialog.tsx`；Modify `EntitiesPanel.tsx`（角色编辑加「演员」、列表显示演员、人物表提示条）、`ResourcesPanel.tsx`（不一致时提示条「同步…」）、`PrintViews.tsx` / `print-plan.ts`（沿用 core 的演员列）、`lib/queries.ts`、`lib/queries-plan.ts`。
- [ ] 测试 `apps/web/test/s3b-cast-web.test.ts`；e2e `e2e/s3b-cast.spec.ts`（原创人物表剧本 → 填入演员 → 计划同步 → 资源面板显示演员）。
- [ ] 提交；README 加 S3b 行、徽章改 S3b。

### Task 14: 发布与部署（lead）

- [ ] 全量 `npm run typecheck`、`npm test`、e2e 全部通过。
- [ ] 版本 0.6.0：`release: storyscript-mov 0.6.0 (S3, S3a, S3b)`。
- [ ] 按 docs/SERVER.md 升级：本地 build + pack，scp，sha256，停服务，备份 /var/lib/storyscript-mov 到 /var/backups/storyscript-mov，安装，重启；检查 mov 200、迁移到 v3、其他站点状态码（modeling 200、nestudy 200、request 404）。
- [ ] 更新记忆文件。
