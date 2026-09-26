# 参与贡献

感谢你愿意改进 StoryScript-Mov。提交之前请先读三份文件：

1. [AGENTS.md](AGENTS.md)：目录归属、硬规则、测试命名（人和 coding agent 都要遵守）。
2. [docs/SPEC-v0.1.md](docs/SPEC-v0.1.md)：当前版本唯一的需求依据。规格没有列出的契约请先开 issue 讨论。
3. [docs/CLEANROOM.md](docs/CLEANROOM.md)：洁净室规则。

## 洁净室规则（强制）

- 不得把 AGPL、GPL、Elastic、PolyForm、非商用许可，以及没有许可证文件的项目的源码、提示词或素材复制进本仓库，也不要放进 coding agent 的上下文。名单见 CLEANROOM.md。
- 即使是 MIT 或 Apache 许可的项目，也请不要复制代码片段。
- 不提交电影截图、分镜原稿扫描、描摹，也不提交用这类材料训练出的权重。
- 预设名、提示词、界面文案和测试数据里，不出现在世导演、分镜师、片名、角色名，也不出现商标。

## 开发流程

```bash
npm ci
npm run typecheck
npm test
npm run e2e        # 需要本机 Chrome
```

- 测试按验收编号命名（例如 `at05-boards.test.ts`）；确定性输出用 golden 快照。
- `packages/core` 必须是零 IO 的纯函数（`purity.test.ts` 会检查）。
- 新增依赖前请先在 issue 里说明理由和许可证。CI 的许可证检查会拒绝 GPL、AGPL、SSPL 和未知许可。

## 贡献图像服务预设

图像接口的"写法"由 `apps/server/src/adapters/image/presets/*.json` 描述，格式见 `packages/contracts/src/provider.ts` 的 `ImagePreset`。新增预设时：

1. 写明服务的官方文档链接和已知限制。
2. 新增的预设 `verified` 一律为 `false`；只有用真实 key 跑通"生成 → 候选 → 后处理 → 采用"并核对账单后，才可以改成 `true`，同时填写 `verified_at`。
3. 在 [docs/providers.md](docs/providers.md) 的表格里补一行。

## 贡献手法模板

手法卡片放在 `packages/core/src/presets/techniques.ts`，字段见 `Technique`。卡片内容必须原创，只描述通用的镜头语法；来源字段只写客观引用，并注明 `basis_type`。

## 提交

- 提交信息写清楚改了什么、为什么改。
- 用户可见的变更会记入 README 的版本记录，由维护者统一更新。
