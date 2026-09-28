# 服务器版部署指南

服务器版让一个活动里的多个小组共用一个网站：剧本、镜头表、分镜、拍摄计划和场记存在服务器上，组员在各自的电脑上用浏览器打开同一个网址。

- **账号**：用邮箱注册，注册时要填活动的邀请码，并输入发到邮箱里的 6 位验证码。之后用邮箱加密码登录，也可以用邮箱验证码登录（忘记密码时顺便设新密码）。
- **小组**：登录后自己创建小组（成为组长）或用组长发的链接、组码加入。一个小组共用一个项目，小组之间互相看不到。
- **素材**：视频不上传到服务器。组员把素材放在自己电脑上的**项目文件夹**里（例如 `我的短片/A-roll/`、`我的短片/B-roll/`），在素材页「打开项目文件夹…」：浏览器在本机读取素材信息、截取海报小图，只把这些发到服务器；播放直接用本机文件。见下文「素材：打开项目文件夹」。

单机使用不受影响：`npx storyscript-mov` 仍然是本机运行、只监听 127.0.0.1 的单人版本，没有账号。

## 需要准备

- 一台能长期运行的 Linux 服务器，装好 **Node.js ≥ 24.15**。服务器版不需要 ffmpeg。服务器上已有别的项目在用旧版 Node 时，把 Node 24 单独解压到本项目的目录里（见第 1 节），不要升级系统的 Node。
- 一个子域名，例如 `story.example.com`，解析到这台服务器。服务器版不支持挂在子路径（如 `example.com/story/`）下。
- HTTPS 证书。已经在跑 Nginx 或 Caddy 的服务器，沿用现有的证书方式即可。浏览器只有在 HTTPS 下才能记住本机素材文件夹，登录 cookie 也需要加密传输。
- 一个 [Resend](https://resend.com) 账号，用来发验证码邮件（见第 3 节）。模型不需要管理员准备：每个小组用自己的 key（见第 4 节）。
- 服务器在中国大陆以外（例如韩国）时不需要 ICP 备案；在中国大陆并用域名对公网开放时需要备案。

## 1. 安装

推荐装 npm 包，服务器上不需要构建：

```bash
sudo useradd --system --home /var/lib/storyscript-mov --shell /usr/sbin/nologin storyscript
sudo install -d -o storyscript -g storyscript -m 700 /var/lib/storyscript-mov
sudo install -d -o root -g root -m 755 /opt/storyscript-mov
# 系统 Node 低于 24.15 时：把官方 Node 24 解压到 /opt/storyscript-mov/node，只给本服务用
cd /opt/storyscript-mov
sudo mkdir app && cd app
sudo npm install --omit=dev storyscript-mov
```

包还没发布到 npm 时，在源码目录里 `npm run build && npm pack -w storyscript-mov` 生成 `storyscript-mov-<版本>.tgz`，上传后用 `npm install --omit=dev ./storyscript-mov-<版本>.tgz` 安装。

入口是 `/opt/storyscript-mov/app/node_modules/storyscript-mov/dist/cli.mjs`。管理命令要读到第 4 节的环境文件，建一个小脚本 `/opt/storyscript-mov/bin/ssm`（权限 755）：

```sh
#!/bin/sh
set -a
[ -r /etc/storyscript-mov/env ] && . /etc/storyscript-mov/env
set +a
exec node /opt/storyscript-mov/app/node_modules/storyscript-mov/dist/cli.mjs "$@"
```

下文的 `ssm` 代表以服务账号运行它：`sudo -u storyscript /opt/storyscript-mov/bin/ssm`。

（从源码安装也可以：`git clone` 后 `npm ci && npm run build`，入口是 `apps/server/dist/cli.mjs`。）

## 2. 初始化站点

```bash
ssm server init --data /var/lib/storyscript-mov \
  --origin https://story.example.com \
  --name "学校短片节" \
  --invite 你的邀请码 \
  --mail-from noreply@story.example.com \
  --port 4700
```

- `--origin`：浏览器访问的地址，只写协议和域名。
- `--invite`：注册邀请码，发给参加活动的同学；不区分大小写。服务器上只保存它的哈希。换邀请码用 `ssm server invite set <新邀请码>`（先停止服务），已注册的账号不受影响。
- `--mail-from`：验证码邮件的发件地址，它的域名要在 Resend 验证过。
- `--port`：服务在本机监听的端口，默认 4700，只监听 127.0.0.1，由反向代理转发。
- `--timezone`：新项目的时区，默认 `Asia/Shanghai`。

## 3. 发信（Resend）

1. 在 Resend 后台 Domains → Add Domain，添加发件域名（例如 `story.example.com`）。Resend 会列出要加的 DNS 记录，一般是：`resend._domainkey` 的 TXT（DKIM）、`send` 的 MX 和 TXT（SPF），以及可选的 `_dmarc` TXT。在域名的 DNS 里照抄，然后点 Verify。
2. API Keys → Create API Key：权限选 Sending access，域名只选这一个。每个项目单独建 key，需要时可以单独作废。
3. 把 key 写进服务的环境文件（见第 4 节）的 `STORYSCRIPT_RESEND_API_KEY`。key 不进日志，也不会发给浏览器。
4. 发一封测试邮件确认：`ssm server mail test 你的邮箱 --data /var/lib/storyscript-mov`。

限额（写在 `server.json` 的 `limits` 里，改完重启服务生效）：

- 同一邮箱 1 分钟内只发 1 封、1 小时最多 5 封；同一访问者地址 1 小时最多 20 封；
- 全站 24 小时最多 `emails_per_day` 封，默认 100。这正好是 Resend 免费档每天的额度：同一天注册的人很多时，要么分几天注册，要么升级 Resend 套餐并调高这个数。

## 4. 模型：每个小组用自己的（BYOK）

服务器版不替小组付模型费用。每个小组在网页的「设置 → 模型」里填自己的 base_url、模型名和 key（OpenAI 协议，例如 DeepSeek、通义、OpenAI），组员共用这一套：

- key 存在服务器上这个小组的状态目录里（`teams/<代号>/state/credentials.json`，权限 600），只用来转发本组的请求；网页上只显示后 4 位，其他小组看不到。管理员能在服务器上读到这些文件，请告诉同学们用单独建的、设了余额上限的 key。
- 服务器只连接公网上的 https 地址：base_url 指向本机、内网或云服务器元数据地址时，保存会被拒绝；连接时还会再检查一次每个解析到的地址和每次跳转，防止有人借服务器访问内部服务。
- 环境文件里的 `STORYSCRIPT_LLM_*`、`STORYSCRIPT_IMAGE_*` 在服务器版里不使用（可以留着，不影响）。

环境文件 `/etc/storyscript-mov/env`（属主 root、组 storyscript，权限 640）只需要 Resend 的 key：

```ini
STORYSCRIPT_RESEND_API_KEY=re_…
```

每个小组在 24 小时内的调用仍有上限（防止意外花费和服务器过载），默认文本模型 200 次、图像模型 20 次：

```json
"limits": {
  "llm_jobs_per_day": 200,
  "image_jobs_per_day": 20,
  "emails_per_day": 100,
  "max_teams": 60,
  "max_team_members": 12
}
```

超出后，小组会看到「已达到调用次数上限」，24 小时后恢复。没有配置模型时，拆镜和实体抽取可以手工完成。`max_teams` 是全站最多的小组数，`max_team_members` 是每组最多人数。

## 5. 用 systemd 常驻

`/etc/systemd/system/storyscript-mov.service`：

```ini
[Unit]
Description=StoryScript-Mov server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=storyscript
Group=storyscript
EnvironmentFile=/etc/storyscript-mov/env
ExecStart=/usr/bin/node /opt/storyscript-mov/app/node_modules/storyscript-mov/dist/cli.mjs server start --data /var/lib/storyscript-mov
Restart=on-failure
MemoryMax=768M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/storyscript-mov

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now storyscript-mov
journalctl -u storyscript-mov -f
```

`ExecStart` 里的 node 路径以实际安装的 Node 24 为准。启动日志会写明发信方式；看到「发信：未配置」说明环境文件里没有 Resend 的 key。

## 6. 反向代理

### Caddy

```
story.example.com {
    request_body {
        max_size 20MB
    }
    reverse_proxy 127.0.0.1:4700 {
        header_up X-Real-IP {remote_host}
    }
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name story.example.com;

    ssl_certificate     /etc/letsencrypt/live/story.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/story.example.com/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:4700;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

服务会检查 Host 和 Origin，只接受 `--origin` 里的域名（以及本机回环地址）。反向代理要保留原始 Host，或者转发为 `127.0.0.1:4700`；两种都可以。

限速按访问者地址计算，地址取 `X-Forwarded-For` 的最后一段（由代理追加，浏览器改不了）；没有这个头时才用 `X-Real-IP`。密码或验证码输错、查询没注册的邮箱：同一地址、同一邮箱 15 分钟内各最多 10 次。

## 7. 管理账号和小组

```bash
ssm server user list --data /var/lib/storyscript-mov              # 账号、所在小组、注册日期
ssm server user remove 某人@example.com --data /var/lib/storyscript-mov   # 删除账号，立即退出登录
ssm server team list --data /var/lib/storyscript-mov              # 小组、人数、组长、组码
ssm server team remove g7x2k9pq --data /var/lib/storyscript-mov   # 删除小组（先停止服务；项目文件保留）
ssm server invite set 新邀请码 --data /var/lib/storyscript-mov     # 换注册邀请码（先停止服务）
```

组长在网页里就能移除组员、换组码；只剩自己一人时可以解散小组（项目会从服务器删除）。组员可以退出小组，组长退出时组长交给最早加入的组员。

## 8. 备份与升级

备份：在访问少的时候停止服务，打包整个数据目录，再启动。

```bash
sudo systemctl stop storyscript-mov
sudo tar czf /backup/storyscript-$(date +%F).tgz -C /var/lib storyscript-mov
sudo systemctl start storyscript-mov
```

小组也可以随时在"交付"页下载自己项目的 JSON 和 CSV。

升级：

```bash
cd /opt/storyscript-mov/app
sudo npm install --omit=dev storyscript-mov@latest
sudo systemctl restart storyscript-mov
```

## 素材：打开项目文件夹

组员在素材页点「打开项目文件夹…」，选择放素材的文件夹。第一次打开时确认「使用这个文件夹」，之后：

- 浏览器列出文件夹里的视频、声音和图片（子文件夹一起列出，隐藏文件跳过），读取 MP4/MOV 的编码、分辨率、帧率、时间码等信息，截一张海报小图，最后在后台计算校验值；
- 服务器只收到这些信息和海报（每条约 30 KB），用它们做候选关联、覆盖状态和漏拍清单；
- 在检查器里播放时，直接读本机文件；
- 组员电脑上看得到海报和信息。组员有同一个文件夹的拷贝时，打开它也能播放。

| 浏览器 | 能力 |
|---|---|
| Chrome、Edge（桌面版） | 能记住文件夹（「最近打开」），并在文件夹里新建 `.storyscript-mov/` 保存记录，下次打开只处理改动过的文件 |
| Safari、Firefox | 只读打开：不写记录，每次都要重新选择文件夹 |

编码：H.264 都能截海报和播放；HEVC（例如 iPhone 拍的）取决于电脑是否支持硬件解码；ProRes 只有素材信息，没有海报，也不能在浏览器里播放。MXF、MTS、AVI 等格式能列出来，但浏览器读不出信息，不能关联；需要处理这些素材时请用单机版。

`.storyscript-mov/` 里只有 `link.json`（这个文件夹属于哪个网站的哪个项目）和 `media-index.json`（每个文件已经读到的信息和校验值），不会改动任何视频文件。

## 数据目录结构

```
/var/lib/storyscript-mov/
  server.json              站点配置和限额（邀请码只存哈希）
  site.db                  账号、小组、登录会话、验证码（密码用 scrypt，会话和验证码只存哈希；权限 600）
  teams/<代号>/project/    小组的项目：SQLite 数据库、海报、AI 图
  teams/<代号>/state/      该小组实例的状态目录
```

## 和单机版的区别

| | 单机版（`npx storyscript-mov`） | 服务器版 |
|---|---|---|
| 访问 | 本机浏览器，终端打印的一次性链接 | 公网域名，邮箱账号（邀请码注册） |
| 项目 | 打开任意文件夹作为项目（数据在其中的 .storyscript-mov） | 每个小组固定一个项目，学生自己建组、入组 |
| 素材 | 登记本机目录，ffprobe 扫描，本机播放 | 在浏览器里打开本机项目文件夹，只上传素材信息和海报小图，本机播放 |
| 模型 key | 在设置页填写，存在本机 | 每个小组在设置页填自己的，存在服务器上本组的目录里，服务器只转发（只连公网 https） |
| 文件夹选择框、最近项目 | 有 | 没有 |
