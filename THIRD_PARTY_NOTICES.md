# Third-party notices

由 `npm run licenses`（scripts/check-licenses.mjs）根据生产依赖树自动生成，请勿手改。
"使用方"一列：server = 随 `storyscript-mov` 安装的运行时依赖；web = 打包进前端产物的依赖。

| 名称 | 版本 | 许可 | 使用方 | 仓库 |
|---|---|---|---|---|
| @hono/node-server | 2.1.1 | MIT | server | https://github.com/honojs/node-server |
| @resvg/resvg-wasm | 2.6.2 | MPL-2.0 | server | https://github.com/yisibl/resvg-js |
| @tanstack/query-core | 5.103.2 | MIT | web | https://github.com/TanStack/query |
| @tanstack/react-query | 5.103.2 | MIT | web | https://github.com/TanStack/query |
| bundle-name | 4.1.1 | MIT | server | https://github.com/sindresorhus/bundle-name |
| default-browser | 5.5.1 | MIT | server | https://github.com/sindresorhus/default-browser |
| default-browser-id | 5.0.1 | MIT | server | https://github.com/sindresorhus/default-browser-id |
| define-lazy-prop | 3.0.0 | MIT | server | https://github.com/sindresorhus/define-lazy-prop |
| hono | 4.13.9 | MIT | server | https://github.com/honojs/hono |
| is-docker | 3.0.0 | MIT | server | https://github.com/sindresorhus/is-docker |
| is-in-ssh | 1.0.0 | MIT | server | https://github.com/sindresorhus/is-in-ssh |
| is-inside-container | 1.0.0 | MIT | server | https://github.com/sindresorhus/is-inside-container |
| is-wsl | 3.1.1 | MIT | server | https://github.com/sindresorhus/is-wsl |
| jsonrepair | 3.15.0 | ISC | server | https://github.com/josdejong/jsonrepair |
| lucide-react | 1.48.0 | ISC | web | https://github.com/lucide-icons/lucide |
| open | 11.0.4 | MIT | server | https://github.com/sindresorhus/open |
| openai | 7.23.0 | Apache-2.0 | server | https://github.com/openai/openai-node |
| powershell-utils | 0.1.0 | MIT | server | https://github.com/sindresorhus/powershell-utils |
| powershell-utils | 0.2.1 | MIT | server | https://github.com/sindresorhus/powershell-utils |
| react | 19.3.0 | MIT | web | https://github.com/react/react |
| react-dom | 19.3.0 | MIT | web | https://github.com/react/react |
| run-applescript | 7.1.0 | MIT | server | https://github.com/sindresorhus/run-applescript |
| scheduler | 0.28.0 | MIT | web | https://github.com/react/react |
| wsl-utils | 1.0.0 | MIT | server | https://github.com/sindresorhus/wsl-utils |
| zod | 4.6.5 | MIT | server, web | https://github.com/colinhacks/zod |

## 说明

- `@resvg/resvg-wasm`（MPL-2.0）：作为外部依赖原样安装，未修改、未打包进本项目产物；源码见 https://github.com/yisibl/resvg-js。
- ffmpeg / ffprobe 不随本项目分发，由用户自行安装，本项目只以子进程方式调用。
