# 调研要点（2026-09-25 核查版）

以下是 18 个调研 agent 的结论，每条事实都经过独立核查，这里只保留对实现有影响的部分。价格和模型状态变化很快，接入前要重新核实。

## 1. 竞品与定位
- GitHub 上热门的项目几乎都面向**AI 生成视频/短剧**，走"剧本→资产→分镜→视频生成"的路线，例如 Toonflow（MIT，当前版本）、ViMax（MIT）、Jellyfish（Apache）；waoowaoo 和 dramaclaw 用 Elastic 许可证，ArcReel 用 AGPL。它们都没有实拍排期、场记，也不把素材回链到计划镜头。
- 实拍向的开源工具零散而且星数很低：Call-Sheet-Tool、shoot-logger 等。arkiv 是实拍素材库，但用 PolyForm 许可证，也不关联计划镜头。
- DaVinci Resolve 21 的 IntelliScript 已经能把剧本和转录对齐出粗剪。所以本项目的差异点要收窄为"**计划镜头 ID → 条次 → 片段的覆盖追踪加漏拍清单**"，这一点对无对白镜头、插入镜头、空镜同样有效。
- Storyboarder 自 2024-03 起停更，仓库里没有许可证文件，官方声明的是"MIT + 例外"。视为不可复用。

## 2. 文本 LLM：OpenAI 兼容协议下的结构化输出能力
| 服务 | 能力 | 注意 |
|---|---|---|
| OpenAI | json_schema strict | 根节点必须是 object，不能是 anyOf |
| Kimi（Moonshot） | json_schema，支持 strict | 官方建议显式设 strict=true |
| 通义（DashScope 兼容模式） | 部分型号支持 json_schema | 开启思考模式时可能失效 |
| DeepSeek | json_object | 偶尔返回空 content，按一次失败计 |
| 智谱 | json_object | |
| Anthropic 的 OpenAI 兼容层 | 忽略 response_format | 按纯提示处理 |
| Ollama | JSON mode | |

- `openai@7.23.0` 已在本地核对源码：
  - `maxRetries` 默认为 2，必须显式设为 0；
  - `images.edit` 的 `image` 可以传数组，`size` 接受任意字符串；
  - `moderation` 参数只在 generate 里有，edit 里没有；
  - `client.post` 可以发往任意路径。
- 策略：能力阶梯为 json_schema → json_object（把 schema 写进提示词）→ 纯提示，按 base_url+model 缓存探测结果。统一经过 jsonrepair、zod、业务校验和带错误回灌的修复，每步最多外发 3 次。

## 3. 图像：不存在统一的 OpenAI 图像编辑协议
| 服务 | 端点与写法 | 参考图 | 备注 |
|---|---|---|---|
| OpenAI（gpt-image-2.5 flare/sunburst，2026-09-08 发布） | `/images/edits`，multipart | 最多 16 张，可带 mask | 自定义尺寸的宽高必须是 16 的倍数，宽高比 ≤3:1；只返回 b64；gpt-image-2 会忽略 input_fidelity；Tier1 限速 5 IPM；OpenAI 自己承认模型在对版式敏感的构图里难以精确摆放元素 |
| 火山方舟 Seedream | `/api/v3/images/generations`，JSON | `image` 数组：5.0 pro/flash 最多 10 张，5.0 lite、4.5、4.0 最多 14 张 | 水印默认开启，必须显式传 `watermark:false`；`model` 直接填 Model ID；5.0 lite 的像素下限约 3.69MP |
| OpenRouter | `/api/v1/images`，JSON | 放在 `input_references` | 只接受比例枚举，最宽 21:9；另有未写进文档的 `/images/generations` 别名 |
| Gemini 的 OpenAI 兼容层 | 只能文生图 | **不接收参考图** | 不能用于草图重绘 |
| 百炼 qwen-image | 兼容模式不支持 edits；原生接口每次只接受 1–3 张输入图 | | 放到 v0.2 |
| Qwen-Image-Edit-2509（开放权重，Apache-2.0） | 模型卡写明原生支持边缘图、深度图、关键点图控制 | | 本地或 ComfyUI 路线，放到 v0.3 |

- 模型下线时间：gpt-image-1、gpt-image-1-mini、gpt-image-1.5 于 2026-12-01 移除；gemini-2.5-flash-image 最早可能 2026-10-02 下线。**模型 ID 一律由用户配置，不写死。**
- 大陆可达性：OpenAI 和 Gemini 官方都不对中国大陆开放；OpenRouter 在大陆能否直连尚未验证。

## 4. "诺兰式分镜"的事实边界
- 唯一能查实的一手画风事实：分镜师在访谈中说，诺兰要的分镜是"用铅笔在纸上松散地画，不用数字方式"（ScreenCrush 2017）。
- 诺兰本人的原话："an absolute concern with point of view"（DGA Quarterly 2012）。
- **不要写**："诺兰只为动作戏画分镜"（这是采访者提问里的前提，不是诺兰的原话）；也不要写存疑的分镜师署名。
- 诺兰感主要来自镜头语法：大画幅带来的尺度对比、视点纪律、载具挂机、实拍质感、多画幅构图时保护画面中心、在大画幅里拍面孔特写。画风规格采用行业通用的铅笔分镜做法：单色、3–4 阶灰、剪影优先、构造线、运动箭头。
- 画幅：IMAX 胶片 1.43:1；数字 IMAX 1.90:1；70mm 拷贝 2.20:1；变形宽银幕 2.39:1。

## 5. 运行时与存储
- 从 Node 24.15 起 node:sqlite 进入 RC（1.2）阶段，本机 Node 26.10 内置的 SQLite 是 3.53.4，带 FTS5 和 trigram 分词器。`backup` 是模块级函数 `sqlite.backup(db, path)`，不是实例方法。
- trigram 分词对**少于 3 个字的查询永远返回 0 条**，这会搜不到"林""客厅"这类 1–2 字的中文人名、地名。因此 v0.1 检索只用 LIKE：A-07 规模下 5000 行也只要约 2ms。
- vitest 5.0.2 和 tsdown 0.23.0 的 engines 都排除 Node 25。

## 6. 媒体
- 本机 PATH 会先命中 `/opt/anaconda3/bin/ffmpeg` 6.1.1，这个构建没有 libx264，但有 h264_videotoolbox、libopenh264、prores_ks 和 hevc_videotoolbox。编码器必须先探测再选择。
- 海报帧用输入端 `-ss` 单帧抽取，约 0.09 秒；用 fps 滤镜会整条解码，约 3.65 秒。
- Chromium 能播 8-bit 4:2:0 的 H.264；播不了 10-bit 或 4:2:2 的 H.264、ProRes 和 MXF。FX3/FX6 这类机型常录 10-bit 4:2:2。
- DIT 工具常用 XXH64（ASC MHL 不支持 SHA-256）。本机实测 node:crypto 的 SHA-256 约 3.2 GB/s，瓶颈在 I/O。
- macOS 用 `diskutil` 读到的 VolumeUUID 在重新挂载后不变；同名卷会被挂成 "/Volumes/NAME 1"。卷 UUID 重连推到 v0.2。
- 从外置卷读取会更新 atime，Finder 还会在 FAT/exFAT 卷上生成 `._` 文件。所以验收"原片未改"时比较哈希，不比较目录快照。

## 7. 合规
- 美国版权局认为作为独立元素的"风格"不受版权保护，但仓库仍然不收录原稿、剧照和描摹。
- 中国《人工智能生成合成内容标识办法》（2025-09-01 施行）：本地 BYOK 工具大概率不属于其规定的服务提供者。但作为良好实践，导出 AI 图时默认加"AI 生成"角标（可以关闭），同时写入元数据。
