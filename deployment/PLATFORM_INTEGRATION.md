# 业务平台集成部署

OpenChatCut 作为管理后台的同域路径 `https://admin.daost.cn/openchatcut/` 部署。管理后台只负责申请一次性启动票据并打开该地址；业务 JWT 不会进入编辑器。OpenChatCut 用票据换取 8 小时 HttpOnly Cookie，并以签名会话访问网关的租户素材接口。Node 服务运行在业务后端仓库的 `services/node/openchatcut-server`，只提供 API、媒体处理和渲染。

编辑器页面使用 `no-referrer`，Nginx 专用访问日志也不记录查询参数，避免两分钟启动票据进入资源请求或日志。

## 配置

API Gateway 的 `/etc/live-platform/api-gateway.env`：

```text
VIDEO_EDITOR_BASE_URL=https://admin.daost.cn/openchatcut/
VIDEO_EDITOR_SESSION_SECRET=<至少 32 字节的随机密钥>
VIDEO_EDITOR_LAUNCH_TTL=2m
```

OpenChatCut 的 `/etc/openchatcut/openchatcut.env`：

```text
OPENCHATCUT_PLATFORM_MODE=platform
OPENCHATCUT_HOST=127.0.0.1
OPENCHATCUT_PORT=5199
OPENCHATCUT_DIST_DIR=/opt/openchatcut/current/dist
OPENCHATCUT_EDITOR_URL=https://admin.daost.cn/openchatcut/
OPENCHATCUT_PLATFORM_API_BASE_URL=https://api.daost.cn/api
OPENCHATCUT_PLATFORM_SESSION_SECRET=<与 VIDEO_EDITOR_SESSION_SECRET 完全相同>
MEDIA_DIR=/var/lib/openchatcut/media/uploads
CC_REMOTION_BUNDLE=/opt/live-platform/current/openchatcut-server/remotion-bundle
```

供应商密钥也只写入该服务器环境文件，不使用 `VITE_` 前缀。配置文件建议权限为 `root:openchatcut 0640`。`VIDEO_EDITOR_SESSION_SECRET` 与 `OPENCHATCUT_PLATFORM_SESSION_SECRET` 不一致时，启动票据无法交换；生产入口会拒绝缺少密钥或非 HTTPS 公网地址的配置。

网关的 `CORS_ALLOW_ORIGINS` 继续只包含管理后台源站。编辑器素材请求由 OpenChatCut 服务端调用网关，不需要把编辑器域名加入浏览器 CORS 白名单。

## 构建与启动

使用 Node.js 24，在 Linux 构建机或目标服务器完成依赖安装和构建。`OPENCHATCUT_PLATFORM_MODE` 同时决定前端 bundle 的平台功能开关，必须在构建阶段设置；仅在 systemd 环境文件里设置是不够的：

```bash
npm ci
OPENCHATCUT_PLATFORM_MODE=platform npm run build
npm run desktop:prebundle
npm prune --omit=dev
```

发布目录至少需要 `dist/`、`server-dist/`、`node_modules/`、`package.json`、`package-lock.json`，以及由 `desktop:prebundle` 生成的 `desktop-dist/remotion-bundle/`（发布时放到服务目录的 `remotion-bundle/`）。该目录必须允许服务账号写入，因为启动后的上传目录会以符号链接挂入渲染包。将新版本放入 `/opt/openchatcut/releases/<release-id>`，再原子切换 `/opt/openchatcut/current` 软链接。不要在 macOS 构建后直接复制 `node_modules` 到 Linux；项目包含平台相关的原生依赖。

安装后端仓库的 `deployment/systemd/openchatcut-server.service`，并将管理前端仓库的 Nginx 配置中的 OpenChatCut 代理段合并到 `admin.daost.cn` 后执行：

```bash
systemctl daemon-reload
systemctl enable --now openchatcut-server
curl --fail http://127.0.0.1:5199/healthz
nginx -t
systemctl reload nginx
curl --fail https://admin.daost.cn/healthz
```

## 验收

1. 在 `https://admin.daost.cn` 登录租户账号，打开应用中心的“AI 视频剪辑”。
2. 确认浏览器地址中的 `platform_ticket` 立即消失，且不出现第二次登录。
3. 新建工程，刷新页面后确认工程仍存在；另一租户或另一账号看不到该工程。
4. 从“业务素材”导入视频或图片并加入时间线。
5. 导出 MP4，确认本地交付成功，并在业务素材库中出现带 `OpenChatCut` 标签的新视频。

当前平台模式下，项目全文/混合搜索不跨租户查询；没有可证明隔离的搜索路径会返回空结果。这不影响按项目列表打开与保存工程。

平台模式的本地素材、R2 上传对象和工程存储均按租户/账号分区。原本供单用户外部 Agent 使用的全局 MCP Bearer Token 在平台模式下禁用；不要将该入口作为多租户 Agent 服务开放。
