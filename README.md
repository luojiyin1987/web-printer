# web-printer

一个最小可用的 Web UI，用来连接局域网内的远程 CUPS 服务器，并把其中的共享打印机暴露成浏览器界面。

## What It Does

- 列出远程 CUPS 上的共享打印机
- 查看某台打印机的当前任务队列
- 上传文件并提交打印
- 支持 `1-3,5,8-10` 这种页面范围
- 对 PDF 和图片提供浏览器内预览
- 对 Office 文件通过 LibreOffice headless 转 PDF 预览
- 取消未完成任务

当前实现采用 `Node.js + Express + IPP`，不依赖本机安装 `lp`/`lpstat` 命令。

## Preview And Range

- 页面范围留空表示打印全部页面
- 支持输入 `1-3,5,8-10`
- PDF 使用浏览器内嵌预览
- 图片直接显示预览
- Office 文件会上传到后端，用 LibreOffice headless 转成 PDF 再预览
- 其它文件类型只显示元信息，不做浏览器内渲染，但仍可提交到 CUPS

## 系统依赖

在 Linux 上运行本项目前，需要先安装以下依赖。

### Node.js

需要 Node.js **18 或更高版本**（项目使用 `fs/promises` 等现代 API）。

```bash
# Debian / Ubuntu
sudo apt-get update
sudo apt-get install -y nodejs npm

# CentOS / RHEL / Fedora
sudo dnf install -y nodejs npm
```

> 如果系统仓库里的 Node.js 版本较旧，建议通过 [NodeSource](https://github.com/nodesource/distributions) 或 [nvm](https://github.com/nvm-sh/nvm) 安装新版。

### LibreOffice（可选）

如果你想在浏览器里预览 Office 文件（Word、Excel、PPT 等），需要安装 LibreOffice。纯打印 PDF / 图片可以不装。

LibreOffice 完整安装会带上大量 GUI 依赖，体积很大。如果 web-printer 跑在无桌面环境的服务器上，建议只装 **headless 精简版**，能显著减少磁盘占用。

```bash
# Debian / Ubuntu（无 GUI 精简版）
sudo apt-get update
sudo apt-get install -y --no-install-recommends libreoffice

# CentOS / RHEL / Fedora（headless 版）
sudo dnf install -y libreoffice-headless
```

> 如果某些 Office 格式转换失败，说明缺少对应的 filter 组件，可以回退到完整版：
> ```bash
> # Debian / Ubuntu 完整版
> sudo apt-get install -y libreoffice
>
> # CentOS / RHEL / Fedora 完整版
> sudo dnf install -y libreoffice
> ```

如果 `soffice` 不在默认 PATH，可以在 `.env` 里指定：

```bash
SOFFICE_BIN=/usr/bin/soffice
```

## Run

1. 安装项目依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

至少修改：

```bash
CUPS_SERVER_URL=http://192.168.1.50:631
```

如果远程 CUPS 用的是自签名 HTTPS 证书，再额外设置：

```bash
CUPS_TLS_REJECT_UNAUTHORIZED=false
```

3. 启动

```bash
npm start
```

默认会监听：

```bash
http://0.0.0.0:3000
```

## Docker 部署

项目已包含 Dockerfile，可直接构建镜像运行，无需在宿主机安装 Node.js / LibreOffice。

### 构建镜像

```bash
docker build -t web-printer:latest .
```

### 运行容器

先准备好 `.env` 文件（参考 `.env.example`），然后通过 `--env-file` 挂载：

```bash
docker run -d \
  --name web-printer \
  --env-file .env \
  -p 3000:3000 \
  --restart unless-stopped \
  web-printer:latest
```

如果需要调整端口映射，把 `-p 3000:3000` 改成 `-p <宿主机端口>:3000`。

`CUPS_SERVER_URL` 是必填项；如果没配置，服务会在启动时直接失败，而不是回退到本机 `127.0.0.1:631`。

### Docker Compose（推荐）

`docker-compose.yml` 示例：

```yaml
services:
  web-printer:
    build: .
    container_name: web-printer
    env_file: .env
    ports:
      - "3000:3000"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/api/printers', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

启动：

```bash
docker compose up -d
```

> 镜像内置了 LibreOffice headless 和常用中文字体（Noto CJK），可直接预览 Office 文件。
> `/api/config` 在探测 LibreOffice 异常时会降级为“不可预览”，不会阻塞整个 Web UI 初始化。

## Scripts

启动服务：

```bash
npm start
```

运行 smoke test：

```bash
npm run smoke
```

Git hooks 由 Husky 在 `npm install` 后自动安装。手动执行提交前检查：

```bash
npm run precommit -- --all-files
```

> 提交前 hook 会检查常见问题，例如 JSON / YAML 语法、行尾格式、冲突标记、私钥误提交和超大文件。

> 仓库根目录的 `.pre-commit-config.yaml` 保留给 GitHub 上的 `pre-commit.ci` 使用；本地开发默认不需要安装 Python `pre-commit`。

## Remote CUPS Requirements

远程 CUPS 服务器至少要满足下面几点：

- `631/TCP` 对 Web UI 所在机器可达
- 目标打印机已经在 CUPS 中配置完成
- 打印机被标记为 shared
- CUPS 允许局域网客户端访问

官方文档可参考：

- Printer Sharing: https://www.cups.org/doc/sharing.html
- Server Security: https://www.cups.org/doc/security.html
- CUPS IPP Extensions: https://www.cups.org/doc/spec-ipp

如果 CUPS 服务器还没开共享，常见做法是：

```bash
sudo cupsctl --share-printers
sudo cupsctl --remote-admin
```

`Listen`/`Port` 仍然需要在 `cupsd.conf` 中设置，`cupsctl` 不能代替这个步骤。

## Notes

- 当前前端默认适合内网使用，没有登录鉴权。
- 如果你的 CUPS 服务器开启了认证，可以把用户名密码写进 `CUPS_SERVER_URL`，例如：

```bash
http://user:password@192.168.1.50:631
```

- 大文件上传上限默认 25MB，可通过 `UPLOAD_LIMIT_MB` 调整。
- `.env` 会在启动时自动加载。
