# AI-cut 桌面平台集成部署

AI-cut 编辑器只运行在用户电脑上的 Electron 桌面客户端。业务管理前端不再发布
OpenChatCut 的 React 静态构建，也不再提供网页版编辑器。

## 拓扑

- `https://admin.daost.cn/content/ai-cut`：AI-cut 介绍与桌面唤起页；
- `https://admin.daost.cn/desktop-login`：系统浏览器登录桥梁，生成一次性 launch ticket，
  再通过 `openchatcut://auth` 返回桌面客户端；
- 本地 AI-cut：编辑器、本地素材、本地 Whisper 和本地导出；
- `openchatcut-server` 与 API Gateway：租户鉴权、业务素材、平台模型、数字人、云端任务
  和其他平台 API。供应商密钥只保存在服务端。

旧的 `/openchatcut` 与 `/openchatcut/` 由 Nginx 重定向到 `/content/ai-cut`。

## 安全边界

桌面客户端只持有网关签发的短期 session token。Electron 主进程调用
`POST /api/v1/video-editor/desktop-session` 兑换 launch ticket，并让本地内嵌服务代为转发
session token。`OPENCHATCUT_PLATFORM_SESSION_SECRET` 和模型供应商密钥绝不能进入桌面安装包、
Vue 静态资源或任何 `VITE_` 变量。

## 云端服务配置

`openchatcut-server` 以 API-only 模式运行：

```text
OPENCHATCUT_API_ONLY=true
OPENCHATCUT_PLATFORM_MODE=platform
OPENCHATCUT_HOST=127.0.0.1
OPENCHATCUT_PORT=5199
OPENCHATCUT_PLATFORM_API_BASE_URL=http://127.0.0.1:8080/api
OPENCHATCUT_EDITOR_URL=https://admin.daost.cn/
OPENCHATCUT_PLATFORM_SESSION_SECRET=<与网关会话密钥一致>
MEDIA_DIR=/var/lib/openchatcut/media/uploads
CC_REMOTION_BUNDLE=/opt/live-platform/current/openchatcut-server/remotion-bundle
```

平台内置 GPT、DeepSeek、通义千问及千问语音能力的供应商密钥只配置在 API Gateway。

## 构建

平台前端在“业务管理前端”仓库独立构建：

```bash
npm run build
```

该构建不会访问 OpenChatCut 源码，也不会产生 `dist/openchatcut/`。

云端 Node 服务只构建服务端产物：

```bash
OPENCHATCUT_PLATFORM_MODE=platform npm run build:server
npm run desktop:prebundle
```

业务后端仓库的 `services/node/openchatcut-server/build.mjs` 会同步 `server-dist` 并安装运行时
依赖。云端发布不需要 OpenChatCut 的编辑器 `dist/`。

## 验收

1. 登录管理后台并进入 `/content/ai-cut`，确认展示桌面客户端入口；
2. 点击“打开桌面应用”，确认通过 `openchatcut://open` 唤起 AI-cut；
3. 在桌面端发起登录，确认浏览器进入 `/desktop-login` 并自动返回客户端；
4. 重启桌面端，确认加密会话仍可恢复；
5. 验证业务素材、平台模型、数字人和云端任务都通过租户 session 访问；
6. 访问旧 `/openchatcut/`，确认跳转到 `/content/ai-cut`，且服务器不再发布网页编辑器资源。
