# 图像服务与 AI 铅笔重绘（实验功能）

> 适用版本：v0.1 开发预览版（M8）。本页描述 `apps/server/src/adapters/image/` 的真实行为。
> **所有组合都没有用真实 key 跑通过**，只按各家文档对照假服务（`apps/server/test/helpers/fake-image.ts`）开发和测试。价格、模型 ID 和可用性变化很快，接入前请以服务商当期文档为准。

AI 铅笔重绘只产出**候选图**：把分镜的构图交给图像模型重画成铅笔稿，由人对照后决定是否采用。确定性铅笔稿（无需 key）始终是分镜的主体；候选图永远不会改写 BoardSpec 或镜头字段（INV-09）。

## 1. 组合与验证状态

| 服务 | base_url 示例 | 方言 | preset | 状态 | 验证日期 |
|---|---|---|---|---|---|
| OpenAI（gpt-image-2.5 flare/sunburst、gpt-image-2、gpt-image-1.x） | `https://api.openai.com/v1` | openai-edits | — | 未验证 | |
| 火山方舟 Seedream | `https://ark.cn-beijing.volces.com/api/v3` | generations-ref | `volcengine-seedream` | 未验证 | |
| BytePlus ModelArk（Seedream 海外） | `https://ark.ap-southeast.bytepluses.com/api/v3` | generations-ref | `volcengine-seedream` | 未验证 | |
| OpenRouter | `https://openrouter.ai/api/v1` | generations-ref | `openrouter` | 未验证 | |
| 其他 OpenAI 兼容服务 | 任意 | openai-edits（默认） | — | 未验证 | |
| 其他服务，手动切到 generations-ref | 任意 | generations-ref | `generic-generations`（兜底） | 未验证 | |
| Gemini 的 OpenAI 兼容层 | `https://generativelanguage.googleapis.com/v1beta/openai` | — | — | **不可用**：该地址不接收参考图，不能用于草图重绘 | |
| 阿里云百炼（兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | — | — | **不可用**：兼容模式不支持图像编辑，原生接口 v0.2 适配 | |

"验证日期"一栏留空，直到有人用真实 key 跑通：生成 → 候选 → 后处理 → 采用，并核对账单与 `usage`。验证后把 preset JSON 的 `verified` 改为 `true`、`verified_at` 填日期，并在上表补日期。

## 2. 方言识别

设置页填写三项：`base_url`、API key、模型名（环境变量 `STORYSCRIPT_IMAGE_BASE_URL` / `STORYSCRIPT_IMAGE_API_KEY` / `STORYSCRIPT_IMAGE_MODEL` 优先；否则存 `credentials.json` 的 `image` 字段，权限 0600）。另有可选的"方言覆盖"。

按 `base_url` 的主机名识别：

1. 主机匹配某个 preset 的 `host_patterns` → `generations-ref` + 该 preset：
   - `ark.*.volces.com`、`*.bytepluses.com` → `volcengine-seedream`
   - `openrouter.ai` → `openrouter`
2. 其他主机 → `openai-edits`（默认）。
3. 方言覆盖优先；把一个未匹配的主机强制设为 `generations-ref` 时，使用兜底 preset `generic-generations`。
4. 主动警示（出现在设置页；重绘请求在发送前就被拒绝，返回 409）：
   - `generativelanguage.googleapis.com` → "该地址不接收参考图，不能用于草图重绘"
   - `dashscope.aliyuncs.com` 的 `compatible-mode` → "百炼兼容模式不支持图像编辑，原生接口 v0.2 适配"

preset 放在 `apps/server/src/adapters/image/presets/*.json`，加载时按 `packages/contracts` 的 `ImagePreset` 校验。新增一个服务 = 新增一个 JSON 文件 + `presets.ts` 里一行 import。

## 3. 请求写法

### openai-edits
- 官方 `openai` SDK（`maxRetries: 0`），`POST {base_url}/images/edits`，multipart。
- `image` 永远是数组（SDK 发成 `image[]` 字段）：第 1 张是控制图，可选第 2 张是风格锚点（v0.1 管线暂不发送锚点，适配器已支持）。
- 其余字段：`model`、`prompt`、`size`（精确像素）、`quality`、`n=1`。
- `input_fidelity=high` 只发给 gpt-image-1.x；gpt-image-2.x 会忽略它，所以不发。
- 可剥离的可选参数：`quality`、`input_fidelity`。

### generations-ref
- 原生 `fetch`，`POST {base_url}{preset.path}`，JSON。
- 请求体：`{ model, prompt, <ref_field>: [data URL…], <size_field>: 尺寸, …extra_body }`。
- 结果从 `response_path` 取；返回的是 URL 时**立即下载**（带 `User-Agent: storyscript-mov/<版本>`，不带 Authorization），并计算 sha256。
- 不发送 quality：两个 preset 的服务都没有文档化的 quality 参数。

| preset | path | 参考图字段 | 尺寸 | 固定附加字段 | 可剥离参数 |
|---|---|---|---|---|---|
| volcengine-seedream | `/images/generations` | `image`（数组，data URL） | 像素 `WxH`（`size`） | `watermark:false`、`response_format:"b64_json"`、`sequential_image_generation:"disabled"` | `sequential_image_generation` |
| openrouter | `/images` | `input_references`（数组，data URL） | 比例枚举（`aspect_ratio`），最宽 21:9 | — | — |
| generic-generations | `/images/generations` | `image`（数组，data URL） | 像素 `WxH`（`size`） | `response_format:"b64_json"` | `response_format` |

## 4. 尺寸换算与裁回

分镜画框按画幅换算请求尺寸（`packages/core/src/prompt/image.ts`，纯函数）：

| 画幅 | openai-edits（16 的倍数，宽高比 ≤3:1） | OpenRouter（比例枚举） | Seedream（像素，默认 2K 档） |
|---|---|---|---|
| 2.39 | 1840x768 | 21:9（上下补边） | 3168x1328 |
| 2.20 | 1760x800 | 21:9（左右补边） | 3040x1376 |
| 1.90 | 1520x800 | 16:9（上下补边） | 2816x1488 |
| 1.78 | 1536x864 | 16:9 | 2736x1536 |
| 1.43 | 1440x1008 | 3:2（左右补边） | 2448x1712 |

- 控制图与请求同比例：画框居中放进画布，其余部分补纸色空白边。
- 画框在画布上的位置记为裁切参数（`canvas.crop`，写进 sidecar）。出图后按同一比例裁回画框，再缩放到画框尺寸（宽 1840），所以前端的矢量标注层坐标仍然对齐。
- Seedream 的像素窗口未知时按 2K 档（约 2048² 像素，下限 3.69MP 以兼容 5.0 lite），可在项目 kv `image.pixel_window` 里配置 `{tier, target_pixels, min_pixels, max_pixels, multiple}`。
- 服务返回 400 且指向尺寸时，错误信息给出最近的合法尺寸（openai-edits：先按自定义尺寸规则取整，已经合法时建议标准尺寸 1536x1024）。

## 5. 外发、重试与失败

每一步最多外发 3 次，每次外发都计数（含剥离参数后的重试）：

| 情况 | 处理 |
|---|---|
| 429 | 按 `Retry-After` 等待（上限 30 秒；没有该头时等 10 秒）后重试 |
| 超时、5xx、请求发出后连接中断 | `outcome_unknown`：服务可能已处理并计费，**不重发** |
| 连接被拒、DNS 失败（请求没有到达） | 失败，提示检查 base_url 与网络 |
| 400 且指向未知参数 | 剥离可选参数后重试一次 |
| 内容审核拒绝（`moderation_blocked` 等） | `PROVIDER_REFUSED`，不重试 |
| 401 / 403 | "key 无效 / 没有该模型权限" |
| 404 / 405 | "该端点不支持此写法"，openai-edits 下建议切换到 generations-ref |

错误信息、日志、任务记录和 sidecar 里都不会出现 key（按原文和 `sk-…`/`Bearer …` 形态双重擦除）。

## 6. 管线

1. **确认**：请求必须带 `confirmed: true`（前端先展示目标主机、将发送的数据和"费用以服务商账单为准"），否则 400。未配置图像服务 → 409，不外发。
2. **控制图**：服务端用 resvg 渲染同一份 BoardSpec，`overlay:false`，不含文字、徽标和箭头。默认用铅笔稿（`pencil`）当控制图——**这是未实测的初始假设**（结构线稿与铅笔稿哪个更能让模型守住构图的 A/B 实测没做），可在项目 kv `image.control_mode` 改为 `structure`。
3. **提示词**：`image-v1`，固定骨架 + 字段插值：任务、画风、镜头（景别、机位、焦段性格、运动）、人物（"exactly N people"，每人画面左/中/右、前中远景、朝向、动作）、场景（环境、道具、主光方向）、禁止项。自由文本（镜头动作）先把角色名换成"Person N"，再经触发词过滤；被剥离的词记在 sidecar。默认英文，项目 kv `image.prompt_lang` 可设为 `zh`（Seedream 可用）。
4. **缓存**：键 = hash(方言, 主机, 模型, preset, 提示词, 控制图 sha256, 参考图, 尺寸, 实际发送的 quality)。同一分镜已有未被拒绝、图像文件仍在的候选图时直接返回，不外发（取消后晚到的候选也算）。
5. **软上限**：每个项目默认 50 张（含拒绝与结果未知的记录），超出返回 409；可在项目 kv `image.raster_cap` 调整。
6. **任务**：`image_redraw`，`remote=true`，一次只跑一个付费请求。取消时如果请求已发出，任务标 `outcome_unknown`；结果晚到时仍保存为候选（`outcome=late_after_cancel`），不会自动采用。
7. **后处理**（确定性，无新依赖）：返回图嵌进 SVG → `feColorMatrix` 去色 → `feComponentTransfer` 把色阶压到铅笔范围 → 叠同一张纸纹与暗角 → 按裁切参数裁回画框 → resvg 输出 PNG。resvg 只能解码 PNG/JPEG/GIF：返回 WebP 时保留原图、记录后处理失败，候选不可采用。
8. **采用**：人工对照（洋葱皮）后采用；同一分镜只有一张 adopted，其余回到 candidate。结构一变（`structure_hash` 不同），候选标 stale。导出默认带"AI 生成"角标（`ai_label_on`）。

## 7. 存储与可追溯

`<项目>/boards/<board_id>/` 下：

| 文件 | 内容 |
|---|---|
| `raster-<id>.png` | 后处理后的候选图（前端显示这张） |
| `raw-<id>.<ext>` | 服务返回的原图，一字节不改 |
| `control-<id>.png` | 发送出去的控制图 |
| `raster-<id>.json` | sidecar：模型、主机、方言、preset、日期、提示词全文与哈希、被剥离的词、控制图 sha256、请求尺寸与 quality、外发次数、裁切参数、原图与输出的 sha256、usage、`source_type=model_generated`、`ai_label=true` |

`board_raster` 表的行与 sidecar 一一对应（AT-18 测试逐项核对）。`usage` 拿不到时为 `null`，界面显示"未知"。

## 8. 费用

- 费用**以服务商账单为准**。本工具只记录服务返回的 `usage` 字段，不估算金额，也不预留额度。
- 超时、5xx 和取消后晚到的请求都可能已经计费；系统不会自动重发付费请求。
- 设置页的"付费测试"会生成 1 张最小合法尺寸、最低质量的图（openai-edits：1024x1024、`quality=low`），不保存结果；免费测试只调用 `GET {base_url}/models`。

## 9. 隐私

- **会发送**：控制图（由分镜结构渲染，不含任何文字）和由镜头字段编译的提示词（景别、机位、人物站位与姿态、环境，以及过滤后的镜头动作描述；角色名替换为"Person N"）。
- **不会发送**：原片、剧本全文、角色表和项目文件；除了该服务自己的 API key（放在 Authorization 头里），不发送任何其他凭据。下载服务返回的图像 URL 时不带 key。
- key 只在服务端使用，不进日志、项目目录、导出文件和前端（界面只显示末 4 位）。
- 返回图、控制图和 sidecar 只写在项目目录里。

## 10. 已知限制（来自 docs/research.md §3）

- **OpenAI**：`/images/edits` 最多 16 张输入图；自定义尺寸宽高必须是 16 的倍数、宽高比 ≤3:1；只返回 b64；Tier 1 限速约 5 张/分钟；官方承认模型在对版式敏感的构图里难以精确摆放元素——重绘只能"参考构图"，会漂移。gpt-image-1、gpt-image-1-mini、gpt-image-1.5 计划于 2026-12-01 移除。中国大陆不可直连。
- **火山方舟 Seedream**：水印默认开启，本工具显式传 `watermark:false`；`model` 直接填 Model ID；参考图 5.0 pro/flash 最多 10 张，5.0 lite、4.5、4.0 最多 14 张；5.0 lite 像素下限约 3.69MP。
- **OpenRouter**：只接受比例枚举，最宽 21:9，所以 2.39 画幅需要补边再裁回；另有未写进文档的 `/images/generations` 别名（本工具不用）；大陆能否直连未验证。
- **Gemini 的 OpenAI 兼容层**：只能文生图，不接收参考图。gemini-2.5-flash-image 最早可能 2026-10-02 下线。
- **百炼 qwen-image**：兼容模式不支持 edits；原生接口每次只接受 1–3 张输入图，放到 v0.2。
- 模型 ID 一律由用户配置，代码里不写死。
