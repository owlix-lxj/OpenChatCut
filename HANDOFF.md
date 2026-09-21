# 交接说明（OpenChatCut 平台集成 / 部署）

> 面向接手的 AI/工程师。记录三套仓库、生产部署、已完成与**未完成**事项、以及踩过的坑。
> 生成时间：2026-09-17。
>
> **2026-09-19 架构更新（优先于下方历史记录）**：平台已改为仅使用本地 AI-cut
> 桌面编辑器。业务管理前端不再构建或托管 `OpenChatCut/dist`，已删除
> `sync-openchatcut-editor.mjs` 与 `public/openchatcut/`；`/openchatcut` 只兼容跳转到
> `/content/ai-cut`。Vue 仍保留介绍页和 `/desktop-login` 登录桥梁；业务后端继续消费
> `server-dist`，为桌面端提供云端 API。

---

## 0. 三套仓库（都在 `~/zhiboxitong/` 下，均为本地，未 push 到远程）

| 仓库 | 路径 | 作用 |
|---|---|---|
| **OpenChatCut** | `~/zhiboxitong/OpenChatCut` | React 视频编辑器 + Node 服务端（**本次主要改这里**）。远程是 `github.com/0xsline/OpenChatCut`（fork） |
| **业务管理前端** | `~/zhiboxitong/业务管理前端` | Vue 管理后台；提供 AI-cut 介绍页、桌面唤起和 `/desktop-login` 登录桥梁，不托管编辑器 |
| **业务后端** | `~/zhiboxitong/业务后端（javascript+go+分布式微服务架构）` | Go 微服务 + Node 的 openchatcut-server 外壳。`services/node/openchatcut-server/build.mjs` 从 `../../../../OpenChatCut` 构建 server 产物 |

**当前架构决策（重要）**：OpenChatCut 仍保持一个内聚工程，不物理拆分；桌面安装包消费编辑器构建，业务后端消费 `server-dist`。业务管理前端不再消费编辑器静态构建。

---

## 1. Git 分支状态（全部本地，**未 push**）

### OpenChatCut
- **`main`** = `bddef5d`（本次所有修复都合进来了，线性历史）：
  - `8c4ea11` 平台集成在途改动基线（155 文件，已上线）
  - `d43a176` 两标签所有权 livelock 修复
  - `2c0a526` ① AI-cut 改名 + ⑤ 资源库缩略图 base 路径
  - `f92f5d8` ② 业务素材预览兜底 + ④ 下拉分页
  - `d1bc5ba` systemPrompt 身份断言测试更新
  - `8c07f0b` 手机上传平台公网化
  - `bddef5d` **手机上传作用域修复（见 §4 未完成）**
- **`refactor/split-core-editor-server`** = `e4850c0`：**大重构**（core/src/server 三层，500+ 文件迁移，独立 `@openchatcut/core`）。**未合并、未上线**，是独立效果，另议。
- 其它：`chore/session-platform-baseline`（如有）。

### 业务管理前端 / 业务后端
- 各有 `chore/session-platform-baseline` 分支，装着本次会话的在途改动基线提交。`main` 落后于已部署状态。
- **注意**：业务管理前端由团队/CI **频繁部署**（生产上是 `feature-*` release），部署编辑器时必须避开冲突（见 §3）。

**待你/用户拍板**：main 有提交未 push 到 `origin`（`github.com/0xsline/OpenChatCut`）。这些提交**含专有平台集成代码**——若该远程是**公开** fork，**不要 push**（会泄露专有代码）；团队本地 main 已够用（他们从本地 `../OpenChatCut` 构建）。

---

## 2. 生产服务器 & 访问

- **主机**：`47.97.10.37`（阿里云杭州）。域名 `admin.daost.cn`（前端）、`api.daost.cn`。
- **SSH**：端口 **22222**（**不是 22！** 22 不是有效入口，连 22 会被立即关闭、看起来像被封，其实是端口错），user `root`，key `/Users/lxj/Downloads/吉量云播.pem`。
  - 已在 `~/.ssh/config` 加别名 `daost-prod`（HostName 47.97.10.37 / Port 22222 / IdentityFile 那把 pem）。直接 `ssh daost-prod`。
- **后端 openchatcut-server**：systemd 服务 `openchatcut-server`，监听 `127.0.0.1:5199`，健康检查 `http://127.0.0.1:5199/healthz`。
  - Release 目录 `/opt/live-platform/releases/`，软链 `/opt/live-platform/current`。
  - 结构：`current/openchatcut-server/{server-dist/standalone.mjs, remotion-bundle, node_modules, start-openchatcut.mjs}`。
- **前端**：`/var/www/admin.daost.cn/releases/`，软链 `/var/www/admin.daost.cn/current`。编辑器在 `current/openchatcut/`。
- **数据/媒体**：`/var/lib/openchatcut/`——SQLite 工程库 `project-store-v1.sqlite3`；媒体上传 `media/uploads/`，**按租户/用户作用域** `media/uploads/platform-scopes/<scope>/`（`scope` = HMAC(tenant_id\0sub) 前 24 位）。
- **env**：`/etc/live-platform/openchatcut-server.env`（DeepSeek/Qwen key、`OPENCHATCUT_PLATFORM_SESSION_SECRET`、`OPENCHATCUT_PLATFORM_MODE=platform` 等）。**MEDIA_DIR 未设置**，media 根即 `/var/lib/openchatcut/media`。
- **nginx**：`/etc/nginx/conf.d/admin.daost.cn.conf`。`/api/(platform|external-agent|agent-runs|model-packs|mobile-upload|llm|render-*|export|...)`→ 5199；`/openchatcut/` → 前端静态。

### 当前线上版本（本次会话结束时）
- 后端 `current` → `openchatcut-mobile-20260917T140743`（含 ① AI-cut + 手机上传公网化；**不含 §4 的作用域修复**）。
- 前端 `current` → `openchatcut-platform-fixes3-20260917T135509`（团队最新 Vue + 我的 openchatcut ①②④⑤）。
- 用户租户 scope = `401c29ffdee274a580619fe6`（其正常桌面上传的文件在此 scope 下）。

---

## 3. 部署方法（照这套做，别乱来）

### 后端（server 产物）
1. 本地：`cd ~/zhiboxitong/OpenChatCut && rm -rf server-dist && OPENCHATCUT_PLATFORM_MODE=platform npm run build:server`。
2. **安全校验**：`scp daost-prod:/opt/live-platform/current/openchatcut-server/server-dist/standalone.mjs /tmp/prod.mjs`，用 node 归一化对比，确认与线上**只差你的已知改动**（别覆盖它物）。
3. 上传（慢链路建议 gzip）：`gzip -c server-dist/standalone.mjs > /tmp/x.gz; scp /tmp/x.gz daost-prod:/root/staged/; ssh daost-prod 'cd /root/staged && gunzip -kf x.gz'`。核对 sha。
4. 部署（原子 + 回滚）：`cp -al` 当前 release → 新 release（硬链接，node_modules/remotion 零成本），`install`+`mv` 换 `standalone.mjs`，`ln -s`+`mv -Tf` 切 `current`，`systemctl restart openchatcut-server`，`curl --retry 25 --retry-connrefused .../healthz`，失败自动回滚到 prev。（重启窗口会有几次 connection refused，`--retry-connrefused` 兜住。）

### 前端（编辑器 dist）—— ⚠️ **有并发部署冲突陷阱**
- 业务管理前端由团队/CI 频繁发布（`feature-*` release），整包切换。你若从旧 release cp 会**回退团队的 Vue 应用**。
- **正确做法**：
  1. 本地 `rm -rf dist && OPENCHATCUT_PLATFORM_MODE=platform OPENCHATCUT_BASE=/openchatcut/ npx vite build --config config/vite.config.ts`。
  2. 服务器取**团队最新**：`team=$(ls -dt /var/www/admin.daost.cn/releases/feature-* | head -1)`。
  3. `cp -al "$team" 新release`（含团队最新 Vue，硬链接）。
  4. 只把 openchatcut/ 换成你的 dist（rsync 或 `rm -rf 新release/openchatcut && cp -al 已验证release/openchatcut 新release/openchatcut`），`chown -R www-data:www-data`。
  5. 一致性校验（index.html 引用的 assets 都在），再 `ln -s`+`mv -Tf` 切 `current`。
- **坑**：macOS 自带 rsync 很老，**不支持 `--info`**（会打印用法、不传输）；用 `-i`；`--checksum` 正确但对 186MB 较慢。

### 其它坑
- **生产部署可能被 auto-mode 分类器拦截**（"Production Deploy"），需要用户批准/放行。
- 磁盘 `/` 约 93~96% 满（1.6~2.8G 空闲），`cp -al` 硬链接几乎零成本，但别全量 cp。

---

## 4. ⚠️ 未完成：手机上传「素材失效」——作用域修复 + 抢救文件

**现象**：手机传素材后，编辑器里那些素材显示"失效/离线、点击重新链接"。

**根因（已确诊）**：上传目录按平台作用域（AsyncLocalStorage，见 `server/platform-storage-scope.ts`）。编辑器请求带平台会话→设置 scope→写 `media/uploads/platform-scopes/<scope>/`。但**手机上传请求没有平台会话→scope 未设置→文件写到了未作用域的 `media/uploads/` 根**，编辑器按用户 scope 取不到 → 失效。

**代码修复（已提交 `bddef5d`，tsc+测试通过，但❗还没构建部署到后端）**：
- `server/mobile-upload-service.ts`：`createSession` 用 `currentPlatformStorageScope()` 捕获编辑器请求的 scope 存进 session；手机上传时 `withPlatformStorageScope(session.scope, () => receiveUpload(...))`，使本地目录和 R2 key 都落在正确 scope。
- 相关：`server/plugins/mobile-upload.ts`（`/s/<token>` 路由走主服务端、令牌鉴权、平台模式传公网 origin）、`server/plugins/request-shape-gate.ts`（豁免 `/api/mobile-upload/s/`）。

**接手要做的两步**：
1. **部署这个修复**：从 `main`(`bddef5d`) 重建 `standalone.mjs`，按 §3 后端部署（当前线上后端 `openchatcut-mobile-20260917T140743` 还没有这个 scope 修复）。
2. **抢救已失效的 7 个文件**：它们在**未作用域根** `/var/lib/openchatcut/media/uploads/*.jpeg`（7 个 `<uuid>.jpeg`，如 `04728b4d-...`、`2f0ac7f8-...` 等；显示名是 IMG_5050~5054）。用户 scope = `401c29ffdee274a580619fe6`。把这 7 个文件 **move 到** `/var/lib/openchatcut/media/uploads/platform-scopes/401c29ffdee274a580619fe6/`（保持 `live-platform:live-platform` 属主），用户刷新后即可加载。（或让用户在修复上线后重新上传。）
   - 确认归属：该 scope 目录里有用户 13:23-13:26 桌面传的 mp4/jpg；另一个 scope `085184ec...` 是空的旧用户。7 个失效文件 = 7 个未作用域 jpeg，归属明确。

---

## 5. 已完成并上线（可回滚）

1. **AI-cut 入口新标签打开**（业务管理前端 `AdminLayout.vue` / `AppCenterView.vue`）。
2. **DeepSeek 405**：查明是**旧界面残留 + 两标签死锁**，服务端一直健康。已用「造平台会话打 `/llm`」端到端验证 → 200、DeepSeek 真实回复。
3. **两标签所有权 livelock**：新标签接管、旧标签转只读，不再 ping-pong。（服务端+客户端，已上线）
4. **① Agent 自称 AI-cut**（`src/agent/systemPrompt.ts`）。新会话生效。
5. **⑤ 资源库缩略图**：模板 `thumb` 是绝对 `/thumbnails/...`，平台 base `/openchatcut/` 下 404。加 `src/assetUrl.ts` 用 `import.meta.env.BASE_URL` 解析，`TemplateCard.tsx` 应用。
6. **② 业务素材预览兜底**：图片 `cover_url` 空时用 `source_url`，加载失败回退图标（`PlatformMaterialPanel.tsx`）。
7. **④ 业务素材下拉分页**：每次 5 个、触底加载 + 「加载更多」按钮 + 服务端搜索/防抖/竞态保护（`platformIntegration.ts` + `PlatformMaterialPanel.tsx`）。
8. **手机上传公网化**：平台模式手机走 `https://admin.daost.cn/api/mobile-upload/s/<token>`（经 nginx→主服务端，无需改 nginx），已上线并验证路由公网可达。**但作用域问题见 §4 未修完**。

**③（非 bug）**：业务素材"全是图片没视频"= 该租户素材库里确实只有图片（链路全透传：openchatcut-server → 网关 `video_editor.go` → material-service，字段 `cover_url`/`type` 正确）。

---

## 6. 关键文件索引

- 编辑器系统提示词/身份：`src/agent/systemPrompt.ts`
- 业务素材前端：`src/library/PlatformMaterialPanel.tsx`、`src/platform/platformIntegration.ts`
- 资源库模板卡/缩略图：`src/library/TemplateCard.tsx`、`src/assetUrl.ts`、`assets/templates/*.json`（`thumb` 字段）
- 手机上传：`server/mobile-upload-service.ts`、`server/plugins/mobile-upload.ts`、`src/media/MobileUploadDialog.tsx`
- 平台作用域：`server/platform-storage-scope.ts`、`server/media-dir.ts`、`server/r2.ts`
- 平台会话/鉴权：`server/platform-session.ts`、`server/plugins/request-shape-gate.ts`、`server/agent-runs/internal-llm-auth.ts`
- 两标签 livelock：`server/external-agent/broker-registry.ts`、`server/plugins/external-agent-bridge-routes.ts`、`src/agent/useExternalAgentBridge.ts`、`src/agent/external-bridge-attempt-error.ts`
- 后端透传链：业务后端 `services/go/api-gateway/internal/httpapi/video_editor.go`、`services/go/material-service/`
- 迁移/架构决策：`OpenChatCut/MIGRATION_PLAN.md`

---

## 7. 立即待办清单（优先级）

1. **[高] 部署 §4 手机上传作用域修复**（main `bddef5d` → 重建 standalone → 后端部署）。
2. **[高] 抢救 7 个失效文件**（move 到 scope `401c29ffdee274a580619fe6`）。
3. **[中] 让手机上传闭环验证**（用户手机扫码传一张，确认落到正确 scope、编辑器能加载）。
4. **[中] 决定是否 push main 到 GitHub**（专有代码，看远程是否私有）。
5. **[中] 让业务管理前端团队从最新 OpenChatCut(main) 构建发布一次**，使前端流水线包含全部修复，彻底消除并发部署冲突（之后不用再手动换 openchatcut/）。
6. **[低] 大重构分支 `refactor/split-core-editor-server`**：想清 CI/部署再议，别急着合并/上线。
