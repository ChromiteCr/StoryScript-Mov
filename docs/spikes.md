# M0 Spikes：实测记录

测量环境：Apple M4 Pro，macOS 26.6.2，Node 26.10.0，2026-09-26。数字都是本机实测，换机器要重测。

## 媒体（Track D）

### ffmpeg 与编码器

- **路径与版本**：PATH 先命中 `/opt/anaconda3/bin/ffmpeg`，版本 6.1.1（conda 构建，`--disable-gpl`）。ffprobe 同版本、同目录。`/opt/homebrew/bin` 与 `/usr/local/bin` 下没有 ffmpeg。
- **H.264 编码器**：有 `h264_videotoolbox` 和 `libopenh264`，**没有 libx264**。`pickH264Encoder` 选中 `h264_videotoolbox`。
- **HEVC 编码器**：有 `hevc_videotoolbox`，Main10 加 `p010le` 可用；没有 libx265。
- **ProRes 编码器**：有 `prores_ks`、`prores`、`prores_aw`、`prores_videotoolbox`。
- **drawtext**：可用（libfreetype + fontconfig）。字体加载失败时，`gen-media` 会自动去掉文件名水印再试一次。
- CI（ubuntu-latest）装的 apt 版 ffmpeg 自带 libx264/libx265。`gen-media` 按探测结果选编码器，同一套代码两边都能跑。

### 测试素材（`npx tsx scripts/gen-media.ts <outdir> [--small] [--h264 <enc>]`）

- **来源**：全部由 lavfi（testsrc2 + 440 Hz sine）生成，640×360、25 fps、2 s；`--small` 为 320×180、1 s。
- **生成耗时**：整套约 1.4 s（含 tsx 启动）。VideoToolbox 每条约 190–225 ms，prores_ks 约 70 ms，libopenh264（small）约 40 ms。
- **VFR 样本**：前 60% 的帧按 1/30 s 间隔，其余按 1/20 s，总长不变。要点：`settb=1/12800` 必须放在 `setpts` 前面，还要加 `-fps_mode passthrough -enc_time_base:v 1/12800`；否则时间戳会被量化回 1/25 网格，得到的仍是 CFR。
- **确定性**：
  - 画面与声音内容是确定的；
  - 软件编码器输出逐字节一致：prores_ks 和 libopenh264 两次生成的 SHA-256 相同；
  - **VideoToolbox（H.264/HEVC）每次输出的字节都不同**。需要逐字节一致的 H.264 时，用 `--h264 libopenh264`。
  - probe 归一化结果与各项 flags 每次都一致。

| 文件 | 编码 | pix_fmt / bits | r / avg 帧率 | playable_direct | is_vfr_suspect | has_timecode | 整条 source_range |
|---|---|---|---|---|---|---|---|
| S01-001-T01.mp4 | h264 High（VT） | yuv420p / 8 | 25/1 · 25/1 | ✅ | — | — | [0, 25600) @1/12800，exact |
| S01-002-T01.mov | h264 High（VT） | yuv420p / 8 | 25/1 · 25/1 | ✅ | — | — | [0, 25600) @1/12800，exact |
| A001C003.mov | h264 High（VT）+ tmcd | yuv420p / 8 | 25/1 · 25/1 | ✅ | — | ✅ 01:00:00:00 | [0, 25600) @1/12800，exact |
| IMG_1234.mov | hevc Main 10（VT） | yuv420p10le / **null** | 25/1 · 25/1 | ❌ | — | — | [0, 25600) @1/12800，exact |
| B002C001.mov | prores Standard（422） | yuv422p10le / 10 | 25/1 · 25/1 | ❌ | — | — | [0, 25600) @1/12800，exact |
| S01-003-T02.mp4 | h264 High（VT），VFR | yuv420p / 8 | **60/1 · 5000/199** | ✅ | ✅ | — | [0, 25472) @1/12800，exact |
| notes.txt | — | — | — | ffprobe 报 Invalid data | | | |
| ._S01-001-T01.mp4 | AppleDouble 头（26 B） | — | — | ffprobe 报 moov atom not found | | | |

- **libopenh264**：输出的 profile 是 Constrained Baseline，flags 与上表一致。它生成的 VFR 样本 avg 为 2500/99，仍然会被标为 VFR。
- **HEVC 的位深**：VideoToolbox 写出的 HEVC 流**没有 `bits_per_raw_sample`**，所以 8-bit 判断不能只看这个字段。`deriveMediaFlags` 要求 pix_fmt 属于 {yuv420p, yuvj420p}，并且 `bits_per_raw_sample` 为空或等于 8。
- **creation_time**：A001C003.mov 写入了固定值 `2026-01-02T03:04:05.000000Z`，归一化后原样保留。
- **ffprobe 耗时**：单个文件（`-show_format -show_streams`，JSON）约 20–30 ms。

### 海报帧（输入端 `-ss`，单帧 JPEG，宽 480）

| 素材 | 耗时 |
|---|---|
| 6 条 640×360 样本（在 1.0 s 处取帧） | 每条 31–37 ms（测试阈值 < 300 ms） |
| 60 s 1080p H.264（GOP 50），在 30 s 处取帧，输入端 `-ss` | 53–55 ms |
| 同一文件，输出端 `-ss`（解码到 30 s） | 758 ms |

- **写入位置**：输出限定在调用方传入的 `allowedDir` 内，并做 realpath 校验，拒绝 `..`、目录本身、以及指向外部的软链目录。先写临时名再 rename，目标位置预先放好的软链只会被替换，不会被跟随。
- **INV-04**：集成测试在生成、probe、抽海报、哈希全部结束后，对源目录做"名称 + size + mtime + SHA-256"快照比对，结果完全一致，也没有新增文件。

### SHA-256（`hashFile`，流式，highWaterMark 1 MiB）

- **1 GiB 随机数据，页缓存已热**：2885–2920 MiB/s。
- **纯 CPU**（node:crypto，内存中的 16 MiB 块）：3112 MiB/s。
- **结论**：哈希本身不是瓶颈，实际吞吐取决于存储卡或外置盘的读速度。冷读外置盘的数据尚未实测。
- **变化检测**：读取前后比较 size 和 mtimeMs，并核对读到的字节数。有变化时返回 `source_changed`。也可以传入扫描时记录的 size/mtime（`expect`），先比对再读。

### Range 播放

- `parseRange` 只支持单区间（`a-b`、`a-`、`-n`）：
  - 多区间、其他单位、语法错误都**忽略**，返回完整 200，这是 RFC 9110 允许的做法；
  - 起点越界或后缀长度为 0 时返回 416，并带 `Content-Range: bytes */size`。
- `.mov` 按 `video/mp4` 返回，Chromium 才会尝试播放。

## 渲染（Track D）

`@resvg/resvg-wasm` 2.6.2：用 `createRequire(...).resolve('@resvg/resvg-wasm/index_bg.wasm')` 定位 wasm 文件，只初始化一次；每次渲染后对 `Resvg` 和 `RenderedImage` 都调用 `.free()`。

下表为 1840 px 宽（2.39:1）、单次渲染耗时（预热后取 5 次平均）：

| SVG | PNG | RGBA 像素 |
|---|---|---|
| 2000 条 path，每条带 `opacity` 属性 | 253 ms | 230 ms |
| 2000 条 path，改用 `stroke-opacity` | **78 ms** | 56 ms |
| 2000 条不透明 path | 66 ms | 46 ms |
| 2000 条 path（`stroke-opacity`）+ 一层 `feGaussianBlur` 晕染 | 143 ms | 121 ms |
| 6000 条 path（`stroke-opacity`） | 202 ms | 172 ms |

- **给 pencil 渲染器的建议**：每条笔段的透明度抖动写成 `stroke-opacity` 或 `fill-opacity`，**不要写 `opacity`**。`opacity` 会让每个元素单独开一个离屏图层，渲染慢 3–4 倍，PLAN 里"1840px PNG < 1.5 s"的余量会被吃掉一大块。
- **确定性**：同一 SVG 两次渲染出的 PNG 逐字节一致。
- **文字**：没有加载字体（wasm 版不读系统字体）。含 `<text>` 的 SVG 不会崩溃，文字不绘制，输出与去掉文字后的 SVG 逐像素相同。这符合"服务端 PNG 不含文字"的设计。
- **像素格式**：tiny-skia 内部存的是预乘 alpha（50% 红得到 128,0,0,128）。`svgToPixels` 会先还原成直通 RGBA，再交给画风指标计算。
- **内存**：先预热 5 次，再连续渲染 50 次（1840 px，2000 path），RSS 增长 < 100 MiB（测试阈值）。单独脚本实测，50 次渲染 RSS 增长 32.7 MiB，属于 wasm 堆长到稳态，不随次数线性增长。

## 许可证（Track D）

- **检查方式**：`npm run licenses`（`scripts/check-licenses.mjs`，纯 Node，不依赖第三方包）。
  - 依赖树来自 `npm ls --omit=dev --all --json --long`，`--long` 只是为了拿到各包的安装路径；
  - 许可信息读各包的 package.json，兼容 SPDX 表达式（OR 取最宽松的一项，AND 取最严格的一项，WITH 看基础许可）、旧式 `license: {type}` 和 `licenses: []` 写法。
- **结果**：25 个第三方生产依赖（不含本仓库的 workspace 包），**0 个 GPL/AGPL/LGPL/SSPL 或未知许可**，退出码 0。
  - MIT：21 个；ISC：2 个（jsonrepair、lucide-react）；Apache-2.0：1 个（openai）；
  - **MPL-2.0：1 个（@resvg/resvg-wasm）**，允许，但会在 NOTICES 中标注"原样安装、未修改、未打包"。
- **NOTICES**：脚本会重写仓库根目录的 `THIRD_PARTY_NOTICES.md`，内容包括名称、版本、许可、使用方（server/web）和仓库地址，按名称排序、不带时间戳，便于 diff。
- **跳过项**：openai 的可选 peer 依赖（`ws`、`undici`、`@aws-sdk/*`、`@smithy/*`）没有安装，不在产物中，因此跳过。

## 数据库与安全（Track B）

**结论：继续使用 node:sqlite，不需要切换到后备驱动 better-sqlite3。**

- **运行环境**：Node 26.10.0 自带的 node:sqlite 链接 SQLite 3.53.4，FTS5 可用（v0.1 检索只用 LIKE）。运行时不打印 ExperimentalWarning。
- **DbPort**：
  - 打开时启用 WAL、foreign_keys=ON 和 busy_timeout；
  - 支持事务、SAVEPOINT 嵌套，拒绝异步回调，支持命名参数；
  - 另提供 `backup()`，内部调用模块级的 `sqlite.backup(db, path)`。
- **迁移**：
  - 迁移脚本以 TS 常量内嵌，方便打包；
  - 当前 user_version 为 1，共 22 张 STRICT 表，布尔和枚举字段带 CHECK 约束；coverage_decision 用触发器保证只追加；
  - 只在 0 < 当前版本 < 最新版本时，才先备份到 `recovery/`；
  - 迁移失败会整体回滚；数据库版本比程序新时拒绝打开，且不改动文件。
- **备份**：在 WAL 活跃、有 500 行未 checkpoint 时执行备份，备份文件可以打开，integrity_check 返回 ok。
- **LIKE 性能**：1 万行中文 `search_text`，查询 `LIKE '%客厅%'` 的中位数为 1.3–1.4 ms（目标 < 20 ms）。
- **项目锁**：
  - 同主机上持锁进程仍存活时返回 PROJECT_LOCKED；
  - 陈旧锁（pid 已不存在）可以接管；
  - 不接管其他主机的锁。
- **安全（AT-17 起点，共 25 个测试）**：
  - Host 与 Origin 校验：伪造 Host 返回 403，在 Hono 之前、socket 层就拦截；跨源 POST 返回 403，缺 Origin 的 POST 也返回 403；
  - 会话：缺 cookie 或令牌错误返回 401，并附中文提示；fragment 令牌换成 HttpOnly、SameSite=Strict 的 cookie；
  - 生产环境 CSP 与规格完全一致；不开 CORS；静态文件路径穿越被拒绝；
  - runtime.json 权限为 0600。
- **开发模式**：Vite 以 middleware 模式与 API 同端口，HMR 走 port+1（ws 只绑 127.0.0.1）。开发环境的 CSP 放宽为允许 'unsafe-inline' 和 ws:。已在内置浏览器验证：令牌换 cookie → 首页 → 新建项目，全流程可用。
- **打包**：
  - tsdown 把 contracts 和 core 内联进产物，vite 不打包，产物约 92 kB；前端构建产物复制到包内的 `web/`；
  - `npm pack` 后在全新的临时 HOME 下执行 `npx ./storyscript-mov-0.0.0.tgz doctor`，退出码为 0；
  - 发布包目前还缺 README 和 LICENSE，M10 发布前补齐。

## LLM（待用户提供 key）

- structuredCall 已按计划设计（`maxRetries:0`；能力阶梯 json_schema → json_object → prompt_only；jsonrepair → zod → 业务校验 → 带错误回灌的修复；每步最多外发 3 次）。
- M3 会先用假的 OpenAI 兼容服务验证。等用户在环境变量 `STORYSCRIPT_LLM_*` 中配置好 key，再跑 `fixtures/scripts` 下的真实评测。评测期望清单已于 2026-09-26 预先提交，时间早于任何真实调用。
