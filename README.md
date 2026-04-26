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

## LibreOffice

Office 预览依赖 `soffice`。常见安装方式：

```bash
sudo apt-get update
sudo apt-get install -y libreoffice
```

如果二进制不在默认 PATH，可以在 `.env` 里指定：

```bash
SOFFICE_BIN=/usr/bin/soffice
```

## Run

1. 安装依赖

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

## Scripts

启动服务：

```bash
npm start
```

运行 smoke test：

```bash
npm run smoke
```

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
