# AI-cut Windows 构建与认证问题审计（2026-09-22）

## 结论

- 本地源码提交 `eec697c106c0ba67fb09ef81f6e66ea4a326c5f4` 与 `origin/main` 一致，不存在漏拉远端提交。
- 2026-09-21 20:52（+08:00）的 `067cda7` 合并了远端 OpenChatCut 主线；随后 `c557307` 恢复生成服务商与 Windows 打包，`eec697c` 补齐平台模式和 GEO 发布运行时。这一覆盖时间线本身连续。
- 故障来自 2026-09-22 的本地 Windows 手工拆分构建：源码要求 `OPENCHATCUT_PLATFORM_MODE=platform` 覆盖整个发布脚本，但首次 `vite build` 未继承该变量。Electron 后端按平台模式启动，前端却被编译为本地模式。
- 直接结果是前端启动函数被编译为恒定返回 `ok`，登录挑战页不可达；后端写请求仍要求平台会话，因此外部编辑器注册返回 `HTTP 403`。

## 证据日志

```text
git fetch --all --tags --prune
HEAD       eec697c106c0ba67fb09ef81f6e66ea4a326c5f4
origin/main eec697c106c0ba67fb09ef81f6e66ea4a326c5f4

2026-09-21 20:52 +0800 067cda7 merge: integrate remote main history
2026-09-21 22:32 +0800 c557307 fix: restore generation providers and Windows packaging
2026-09-22 00:12 +0800 eec697c fix: bundle platform mode and GEO publisher runtime
```

错误产物中的启动交换函数被压缩为：

```js
async function Gt(){return "ok"}
```

这证明 `__PLATFORM_MANAGED__` 在 Vite 编译期为 `false`。仓库规范脚本 `scripts/desktop-dist-win.mjs` 则明确为所有步骤统一设置：

```text
OPENCHATCUT_PLATFORM_MODE=platform
OPENCHATCUT_PLATFORM_API_BASE_URL=https://api.daost.cn/api
CC_EB_TARGET=win32-x64
```

## 项目认证规范

1. Renderer 不得读取或保存平台 Session Token。
2. 登录必须使用系统浏览器打开 `https://admin.daost.cn/desktop-login`，携带随机一次性 `state` 和 `openchatcut://auth` 回调。
3. Electron 主进程校验回调 state，用短期 ticket 向 `/v1/video-editor/desktop-session` 兑换 Session Token。
4. 用户取消网页授权时，桌面主进程必须立即作废当前 state；被取消标签页的延迟回调不得再被接受。
5. Token 只能由主进程持有，并通过系统安全存储加密落盘；本地嵌入服务仅通过 provider 取得 Token。
6. 启动时必须校验 Token 的结构、类型与 `exp`；无效或过期 Token 应删除并进入网页登录授权。
7. 运行期间到期也必须清除 Token、回到登录界面并重新发起网页登录，不能向用户暴露 `registration failed: HTTP 403` 这类底层错误。
8. Windows 正式包的前端构建、主进程构建、资源准备和 electron-builder 必须继承同一组平台环境变量。

## 给技术人员的发布要求

- 不要单独运行无环境变量的 `npm run build` 后再执行 electron-builder。
- Windows 发布以 `npm run desktop:dist:win` 为唯一标准入口；若 CI/本机构建系统必须拆分命令，先在父进程设置上述三个环境变量，直到 electron-builder 退出后再释放。
- 发布验收必须包含：
  - 无 Token 首次启动自动打开网页登录；
  - 有效 Token 启动直接进入工程列表；
  - 过期 Token 启动删除旧凭据并重新授权；
  - 运行中 Token 到期自动回到授权流程；
  - `/api/external-agent/register` 不再在正常登录态返回 403；
  - 产物搜索确认平台启动检查未被常量折叠为 `return "ok"`；
  - Windows 顶栏使用项目主题 Token，并可拖拽、最小化、最大化和关闭。

## 本次修复范围

- 平台登录页启动时自动发起系统浏览器授权。
- Electron 主进程按 Token `exp` 安排到期清理与界面重载。
- 外部编辑器注册遇到 401/403 时触发网页登录恢复并显示用户可理解的信息。
- Windows 主窗口改用与前端设计系统一致的自定义标题栏。
- 以全流程平台环境变量重新构建并启动 Windows 本地开发预览；按后续要求未生成安装包。
