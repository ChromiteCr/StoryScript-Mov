# 洁净室与命名规则

本项目以 MIT 许可证发布。可以参考已有项目的**做法**（产品形态、工作流、公开文档里描述的思路），但**不得照抄任何代码、提示词、素材或文案**。

## 1. 禁读名单（源码、提示词、素材都不得放进 coding agent 的上下文）

以下项目只允许阅读 README 和公开文档中描述做法的部分：

- **AGPL/GPL**：AIMovieStudio v2、ArcReel、CozyClay、moyin-creator、Nomi、starc / KIT Scenarist、Kitsu、CineSched、create-call-sheet、mannequin.js、Trelby
- **Elastic / PolyForm / 自定义或非商用许可**：waoowaoo、dramaclaw、arkiv、CineGen-ShortDrama、ai-shotlive
- **没有许可证文件**：Storyboarder（包括它的模型、图标和 Shot Generator 资产）、MovieAgent、ShotBench
- **Toonflow v1.1.8 及更早版本**（这些版本不是纯 MIT）

MIT 或 Apache 许可的项目，同样不复制代码片段。`fountain-js` 最多只在测试里用来对照结果，不复制它的实现。

## 2. 素材

仓库里**不收录**以下内容：
- 电影截图、剧照、分镜原稿扫描件；
- 针对具体画格的描摹；
- 用上述材料训练出来的权重；
- ShotBench、CameraBench 等数据集；
- Mixamo 素材、ffmpeg-static。

仓库里所有的人偶、纸纹、图标、样例剧本、手法卡片和测试素材，都必须原创或由程序生成（例如用 ffmpeg lavfi 生成测试视频）。这些内容随项目以 MIT 发布；程序生成的铅笔稿额外声明为 CC0。

## 3. 命名与措辞

- 产品内（预设名、按钮、提示词、卖点标题、测试数据）**不出现**在世导演、分镜师、片名、角色名，也不出现 IMAX。外观预设叫「宽银幕铅笔分镜」。
- 唯一例外是 `packages/core/src/prompt/claims.ts` 里的触发词过滤表和它的测试：它们需要列出被过滤的词，但这些词绝不会出现在界面或提示词里。
- 图像提示词要经过触发词过滤：剥离人名、片名、商标，并提示用户。拆镜阶段用户输入的"参考 X"不受过滤影响，但输出必须标注为"通用手法建议（未核实）"，并且不得捏造具体影片的镜头。
- README 只在"灵感与参考"一节提及导演一次，并附无关联声明，具体措辞见 docs/PLAN.md。
- **禁用说法**：「诺兰同款」「Nolan Mode」「一键诺兰化」「IMAX 模式」「AI 严格按线稿出图」「唯一做素材回链」「自动最优排期」。
- 引用只用核实过的原话，并注明出处。不写存疑的分镜师署名。

## 4. 依赖许可

- CI 许可证闸门：出现 GPL、AGPL、SSPL 或未知许可时直接失败。
- `@resvg/resvg-wasm`（MPL-2.0）作为外部依赖安装，不打进 bundle，也不修改它的源码，在 THIRD_PARTY_NOTICES 中列明。
- ffmpeg 由用户自行安装，项目只以子进程方式调用，不随包分发。
