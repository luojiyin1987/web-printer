# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，并采用 [语义化版本](https://semver.org/lang/zh-CN/) 进行版本管理。

## [Unreleased]

### 新增

- **前端智能轮询**：基于页面可见性动态调整轮询频率
  - 页面可见时：打印机列表 30s，任务列表按状态切换（有活跃任务 5s / 空闲 15s）
  - 页面隐藏时：打印机列表降至 180s，任务轮询暂停
  - 指数退避 + 15% 抖动：请求失败时自动降速，打散多客户端峰值
  - 请求去重：同一类请求未完成前，新调用复用 pending Promise
- **服务端短缓存**：保护下游 CUPS 服务，减少重复 IPP 调用
  - 打印机列表缓存：3s TTL
  - 按打印机独立的任务缓存：1.5s TTL
  - 写操作（打印/取消任务）后立即使相关缓存失效，保证数据一致性
- **缓存管理器**：`lib/cache-manager.js`
  - TTL 缓存单元：`createTimedCache` + `getCachedValue`
  - 按打印机 key 的 Map 缓存池，支持 LRU 淘汰（128 条上限）
  - 空闲超时清理：10 分钟无访问自动删除，防止内存泄漏
  - 并发安全：清理时跳过 `inFlight` 中的缓存条目
- **优雅关闭机制**：`registerShutdownHandlers`
  - 监听 SIGTERM / SIGINT，停止 maintenance timer，调用 `server.close()` 等待活跃请求完成
  - 可配置强制退出兜底时间：`SHUTDOWN_GRACE_MS`（默认 10 秒），防止连接挂起导致进程无法终止
  - 调用 `server.closeIdleConnections()` 主动关闭空闲 keep-alive 连接，加速关闭流程

### 变更

- **server.js 重构**
  - 路由 handler 全部具名化：`handleGetConfig`、`handleListPrinters`、`handlePrintDocument` 等
  - 缓存逻辑从 server.js 抽离至 `lib/cache-manager.js`
  - 启动流程拆分为意图明确的步骤：`registerMiddleware` → `registerRoutes` → `ensureRuntimeDirectories` → `runStartupCleanup` → `scheduleMaintenance`
  - 公共辅助函数提取：`removeFileIfPresent`、`sendBadRequest`、`resolveErrorStatus`、`buildPrintJobRequest`
- **定时清理机制**：`scheduleMaintenance` 从 `setInterval` 改为递归 `setTimeout`
  - 避免清理任务耗时超过间隔时产生堆积
  - 本轮完成后才开始下一轮计时，严格串行
- **`/api/previews` 路由优化**：增加 multer `fileFilter`
  - 非 Office 文件在写入磁盘前即被拒绝，避免产生垃圾临时文件
- **IPP 请求超时优化**：`lib/cups.js` 的 `execute()` 在收到响应后主动清理 `setTimeout` timer
  - 避免请求已成功但 timer 仍挂到超时时间才无意义触发
- **`shutdownGraceMs` 独立配置**：`lib/config.js`
  - 不再与 `sofficeTimeoutMs` 隐性绑定，用户可独立控制优雅关闭超时
  - Docker/K8s 场景下可按 orchestrator 容忍时间精确配置

### 修复

- **被动切换打印机时 `hasActiveJobs` 状态滞后**
  - 旧行为：重置为 false 后等待下次轮询定时器触发才刷新
  - 新行为：被动切换后立即执行 `loadJobs()`，状态与 UI 同步更新
- **`refreshAllNow` 重复请求修复**：打印机列表被动切换后，不再重复触发 `loadJobs()`，消除并发拉取同一队列的问题
- **`server.close()` 错误处理修正**：恢复回调的 error 参数处理。根据 Node.js 官方文档，`net.Server.close()` 在 server 未监听时 callback 会收到 Error 参数
