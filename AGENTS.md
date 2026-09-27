# AGENTS.md — 给 coding agent 的工作规则

本项目：StoryScript-Mov，开源、本地运行的实拍分镜工作台（npm 包名 `storyscript-mov`，许可证 MIT）。

## 先读这些
1. `docs/SPEC-v0.1.md`：**唯一需求依据**。其中没列出的契约一律不实现。`docs/SPEC.md` 只是路线图。
2. `docs/PLAN.md`：里程碑、技术栈、分镜管线和画风配方。
3. `docs/CLEANROOM.md`：洁净室和命名规则（强制）。
4. `packages/contracts/src/`：类型与 schema 的唯一事实来源。

## 目录归属
| 目录 | 归属 | 说明 |
|---|---|---|
| `package.json`、`package-lock.json`、任一 workspace 的依赖 | **仅 lead** | 子任务**禁止**新增或升级依赖。缺依赖时在报告里说明，由 lead 统一安装 |
| `packages/contracts/` | **仅 lead** | 需要改契约时，在报告里写明提案 |
| `apps/server/src/db/migrations/` | **仅 lead** 分配编号 | |
| `README.md` 版本表 | **仅 lead** | |
| `packages/core/` | 任务卡指定 | 纯函数，零 IO：不能 import `node:*`，不能用 `fetch`、`process`、`Date.now`、`Math.random`（`test/purity.test.ts` 会检查） |
| `apps/server/`、`apps/web/` | 任务卡指定 | |

## 硬规则
- **不变量**（SPEC-v0.1 §2）每条都有测试；改动涉及相关逻辑时必须保持测试为绿。
- **LLM**：只输出 ShotFields 这类语义枚举，永不输出坐标、SVG 或 HTML。所有模型输出都经 zod 和业务校验。
- **外发次数**：每步最多外发 3 次，网络重试也计入。`openai` 客户端一律设 `maxRetries: 0`。
- **SVG**：渲染器只用表现属性（`fill`、`stroke`、`opacity`…），不写 `style` 属性或 `<style>` 标签；所有文本都要转义。
- **视频只读**：程序只写项目文件夹里的 `.storyscript-mov/`（项目数据、派生文件、服务器版的文件夹记录），视频文件和外部素材目录一律不写。
- **ffmpeg**：只用参数数组 spawn，不经过 shell。
- **密钥**：key 不进日志、项目目录、导出文件和前端。
- **测试**：测试按 AT 编号命名（例如 `at05-board-edit.test.ts`）。确定性输出用 golden 快照，坐标保留两位小数。
- **命名**：代码、提示词、UI、测试数据里都不出现真实导演、分镜师、片名、角色名，也不出现 IMAX。

## 命令
- `npm test`：vitest。
- `npm run typecheck`：先检查 core（不带 Node 类型），再检查 server 和测试，最后检查 web。
- `npm run dev`：开发服务器，Vite 以 middleware 模式运行，与 API 同端口。
- `npm run look`：渲染 12 个标准镜头，输出 PNG 和画风指标（M1 起提供）。

## 版本规则（用户全局规则）
版本号格式为 `S<大版本><中版本字母?><小版本数字?>`。每完成一个里程碑，由 lead 在 README 版本表的最上方加一行，并同步更新 version 徽章。
