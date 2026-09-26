# StoryScript-Mov

![version](https://img.shields.io/badge/version-S0d1-blue)
![license](https://img.shields.io/badge/license-MIT-green)

开源、在本地运行的**实拍分镜工作台**：把剧本拆成有出处、可锁定的镜头表；为每个镜头自动画出带真实焦段和机位的宽银幕铅笔分镜（不需要任何 API key）；排出经过校验的拍摄顺序；在现场记录条次；把实拍素材挂回同一个镜头 ID，拍完直接看漏拍清单。

> 🚧 **开发中（v0.1 开发预览版）**。规格见 [docs/SPEC-v0.1.md](docs/SPEC-v0.1.md)，计划见 [docs/PLAN.md](docs/PLAN.md)。

## 开发

需要 Node ≥ 24.15（推荐 `brew install node`）。素材导入另需 ffmpeg（`brew install ffmpeg`）。

```bash
npm ci
npm test
npm run dev
```

## 版本记录

| 版本 | 日期 | 变更内容 | 类型 |
|------|------|----------|------|
| S0d1 | 2026-09-26 | 人偶层级整理：肢体按整条排前后、组内先描轮廓再填色（膝盖/肘部不再露圈），远侧肢体浅灰区分，朝镜头的大腿并入骨盆 | fix |
| S0d | 2026-09-26 | 剧本导入与 AI 拆镜（服务端）：规则切场与段落锚点、引用三级校验与改稿重关联、structuredCall（json_schema→json_object 降级、每步最多外发 3 次）、任务队列、镜头/草案/实体接口、锁定与 409 | feat |
| S0c | 2026-09-26 | 排期、覆盖状态、素材候选与 CSV 纯函数；排期改为多起点贪心，可选镜头不再阻挡可行，校验器独立核对工时与分段顺序 | feat |
| S0b | 2026-09-26 | 分镜核心：世界坐标针孔相机求解、7 个构图模板、2D 人偶（6 姿势 × 4 朝向 × 3 轮廓）、结构线稿与俯视站位图渲染、12 个标准镜头审阅页 | feat |
| S0a | 2026-09-26 | 界面改版：Resolve 式专业工作台（石墨外框、纸面内容、底部工作流页面栏：剧本→分镜→计划→现场→素材→交付）、面板组件、项目管理器 | feat |
| S0 | 2026-09-26 | M0 骨架完成：contracts v1、本地 Web 安全外壳（令牌换 cookie、Host/Origin、CSP）、node:sqlite 与迁移、项目锁、CLI（start/doctor/open）、前端外壳、媒体与渲染 spike、打包冒烟 | milestone |

## 许可证

[MIT](LICENSE)
