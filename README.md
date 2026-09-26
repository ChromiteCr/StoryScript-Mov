# StoryScript-Mov

![version](https://img.shields.io/badge/version-S0-blue)
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
| S0 | 2026-09-26 | M0 骨架完成：contracts v1、本地 Web 安全外壳（令牌换 cookie、Host/Origin、CSP）、node:sqlite 与迁移、项目锁、CLI（start/doctor/open）、前端外壳、媒体与渲染 spike、打包冒烟 | milestone |

## 许可证

[MIT](LICENSE)
