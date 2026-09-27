# 服务器版部署指南

服务器版让多个队伍共用一个网站：剧本、镜头表、分镜、拍摄计划和场记存在服务器上，队员在各自的电脑上用浏览器打开同一个网址。每个队伍有自己的项目，互相看不到。

视频素材不上传到服务器。当前版本里，素材页在服务器版中只记录场记和机内文件名；从本机添加素材文件夹（浏览器在本机读取素材，只上传元数据和海报小图）正在开发。

单机使用不受影响：`npx storyscript-mov` 仍然是本机运行、只监听 127.0.0.1 的单人版本。

## 需要准备

- 一台能长期运行的 Linux 服务器，装好 **Node.js ≥ 24.15**。服务器版不需要 ffmpeg。
- 一个子域名，例如 `story.example.com`，解析到这台服务器。服务器版不支持挂在子路径（如 `example.com/story/`）下。
- HTTPS 证书。已经在跑 Nginx 或 Caddy 的服务器，沿用现有的证书方式即可。浏览器只有在 HTTPS 下才能记住本机素材文件夹，登录 cookie 也需要加密传输。
- 服务器在中国大陆以外（例如韩国）时不需要 ICP 备案；在中国大陆并用域名对公网开放时需要备案。

## 1. 安装

```bash
git clone https://github.com/ChromiteCr/StoryScript-Mov.git /opt/storyscript-mov
cd /opt/storyscript-mov
npm ci
npm run build
```

构建完成后，入口是 `apps/server/dist/cli.mjs`。下文的 `ssm` 代表：

```bash
node /opt/storyscript-mov/apps/server/dist/cli.mjs
```

## 2. 初始化站点

选一个数据目录（项目、会话都存在这里），例如 `/srv/storyscript`：

```bash
ssm server init --data /srv/storyscript --origin https://story.example.com --name "学校短片节" --port 4700
```

- `--origin`：浏览器访问的地址，只写协议和域名。
- `--port`：服务在本机监听的端口，默认 4700，只监听 127.0.0.1，由反向代理转发。
- `--timezone`：新项目的时区，默认 `Asia/Shanghai`。

## 3. 添加队伍

```bash
ssm server team add team-1 --name "一组" --data /srv/storyscript
ssm server team add team-2 --name "二组" --data /srv/storyscript
```

每条命令会打印一次队伍口令（形如 `ABCD-EFGH-JKMN-PQRS`）和邀请链接。服务器只保存口令的哈希，**口令只显示这一次**，请直接发给队员：

- 打开邀请链接即可登录；
- 或者打开网站，输入队伍口令。

登录在这台电脑的浏览器里保持 30 天。其他队伍管理命令：

```bash
ssm server team list --data /srv/storyscript             # 列出队伍和已登录的浏览器数
ssm server team reset team-1 --data /srv/storyscript     # 换口令，旧口令和已登录的浏览器全部失效
ssm server team remove team-1 --data /srv/storyscript    # 停用队伍，项目文件保留
```

修改队伍前需要先停止服务，改完再启动。

## 4. 配置模型（可选）

模型 key 只放在服务器上，队伍在网页里看不到、也不能修改。写进一个只有 root 可读的环境文件，例如 `/etc/storyscript-mov.env`（权限 600）：

```ini
STORYSCRIPT_LLM_BASE_URL=https://api.deepseek.com/v1
STORYSCRIPT_LLM_API_KEY=你的 key
STORYSCRIPT_LLM_MODEL=deepseek-chat
# 图像重绘（实验，可不填）
# STORYSCRIPT_IMAGE_BASE_URL=
# STORYSCRIPT_IMAGE_API_KEY=
# STORYSCRIPT_IMAGE_MODEL=
```

所有队伍共用这组 key。每个队伍在 24 小时内的调用有上限，默认文本模型 200 次、图像模型 20 次，写在 `server.json` 的 `limits` 里，改完重启服务生效：

```json
"limits": { "llm_jobs_per_day": 200, "image_jobs_per_day": 20 }
```

超出后，队伍会看到「已达到调用次数上限」，24 小时后恢复。也建议在模型服务商的后台给这个 key 设置余额上限。不配置模型时，拆镜和实体抽取可以手工完成。

## 5. 用 systemd 常驻

`/etc/systemd/system/storyscript-mov.service`：

```ini
[Unit]
Description=StoryScript-Mov server
After=network.target

[Service]
Type=simple
User=storyscript
WorkingDirectory=/opt/storyscript-mov
EnvironmentFile=/etc/storyscript-mov.env
ExecStart=/usr/bin/node /opt/storyscript-mov/apps/server/dist/cli.mjs server start --data /srv/storyscript
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /srv/storyscript storyscript
sudo chown -R storyscript /srv/storyscript
sudo systemctl daemon-reload
sudo systemctl enable --now storyscript-mov
journalctl -u storyscript-mov -f
```

`ExecStart` 里的 node 路径以 `which node` 为准。

## 6. 反向代理

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

### Caddy

```
story.example.com {
    reverse_proxy 127.0.0.1:4700
}
```

服务会检查 Host 和 Origin，只接受 `--origin` 里的域名（以及本机回环地址）。反向代理要保留原始 Host，或者转发为 `127.0.0.1:4700`；两种都可以。登录失败会按访问者地址限速（15 分钟内最多 10 次），地址取自代理设置的 `X-Real-IP` / `X-Forwarded-For`。

## 7. 备份与升级

备份：在访问少的时候停止服务，打包整个数据目录，再启动。

```bash
sudo systemctl stop storyscript-mov
sudo tar czf /backup/storyscript-$(date +%F).tgz -C /srv storyscript
sudo systemctl start storyscript-mov
```

队伍也可以随时在"交付"页下载自己项目的 JSON 和 CSV。

升级：

```bash
cd /opt/storyscript-mov
git pull
npm ci
npm run build
sudo systemctl restart storyscript-mov
```

## 数据目录结构

```
/srv/storyscript/
  server.json              站点配置和队伍列表（口令只存哈希）
  sessions.json            已登录的浏览器（只存哈希，权限 600）
  teams/<代号>/project/    队伍的项目：SQLite 数据库、海报、AI 图
  teams/<代号>/state/      该队伍实例的状态目录
```

## 和单机版的区别

| | 单机版（`npx storyscript-mov`） | 服务器版 |
|---|---|---|
| 访问 | 本机浏览器，终端打印的一次性链接 | 公网域名，队伍口令或邀请链接 |
| 项目 | 可以新建、打开任意目录 | 每个队伍固定一个项目 |
| 素材 | 登记本机目录，ffprobe 扫描，本机播放 | 视频留在队员电脑上，服务器不读取视频文件（本机素材文件夹开发中） |
| 模型 key | 在设置页填写 | 管理员用环境变量配置 |
| 文件夹选择框、最近项目 | 有 | 没有 |
