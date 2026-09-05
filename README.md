# r2novel · 个人私有在线小说仓库

> **电脑上传 txt → 浏览器自动清洗分章 → 手机优先网页阅读 · 进度云端同步 · 整本离线**
> Cloudflare Workers + R2 免费层（约 $0/月）· 前端零依赖原生 JS · PWA 可安装 · 仓库零凭据

**主场景**：电脑上传为主 · 手机阅读为主。库完全私有（口令登录），R2 桶不公开、无直链，一切读写经 Worker 鉴权。

**品牌**：「私人书屋」—— 登录页 / 书架 / 浏览器标题 / PWA 安装名全部统一；桌面端浏览器访问自动启用左目录栏阅读布局。

---

## 功能说明

**核心流程**：电脑上传 txt → 浏览器本地自动识别编码、清洗排版、智能分章 → 上传清洗后章节到私有 R2 → 手机/电脑网页阅读、进度云端同步 → 整本可离线、可经 OPDS 喂给第三方阅读器。

### 📤 上传（电脑体验最佳）
- **三种导入方式**：拖拽文件 / 点击选择 / 直接粘贴文本；单文件 ≤ 50MB
- **编码自动识别**：UTF-8 / GB18030 / Big5 三路解码 + 可读性打分判优（已规避 GBK 全字节合法陷阱），识别不准可手动切换重洗
- **7+1 项可勾选清理**：去站点残留/广告行、乱码与替换符、多余空行、段首空格规范化、合并硬件断行、引号统一、Markdown 残留；「自动清洗排版」总开关可一键关闭
- **智能分章**：自适应识别 第X章/回/节/卷、Chapter N、「标题与正文同行」等格式，引号归章、单章书取书名、误抓修复、**支持自定义正则**；预览页可逐章核对再入库
- **去重提醒**：建书撞同名时弹窗选择 **替换 / 追加章节 / 另存副本**；替换尽量按同名标题保留阅读进度
- **超大单章自动分段**：分章引擎无法识别章标识（整本兜底为一章）且超过服务端单章 2MB 上限时，上传前按 UTF-8 字节边界自动切成 ≤1.9MB 连续段（切点绝不劈裂多字节字符，标题自动加「（1）（2）…」），不再因单章超限中断留下半成品书

### 📚 书架
- 四种排序（最近阅读 / 最近更新 / 创建时间 / 书名）+ **置顶**
- **标签云**点筛（前 12 个标签）、书名/标签即时搜索
- 进度角标（读到第几章）、字数统计、分页（60/页）
- 每本书支持 **作者 + 备注标签**（如「已读完」「垃圾翻译」）

### 📖 阅读 · 手机端（主场景）
- 全屏滚读，**顶/底栏滚动自动淡出、轻点屏幕唤出**（沉浸模式）
- 目录抽屉：分页 50/页增量渲染、当前章自动定位展开、已读标记；千章书不卡
- Aa 面板：字号 15–30px、行距 1.5–2.6、**4 主题**（羊皮纸 / 白 / 护眼绿 / 夜间）
- 正文保留段首缩进；章节头显示「第 x / y 章 · 全文百分比」
- 切后台立即存进度；8 秒节流；离线时进度入队、回网自动补传

### 🖥 阅读 · 电脑端
- **左侧常驻章节目录**（可一键收起成竖排书脊，`T` 键切换），右侧正文加宽至 42em
- **键盘导航**：`Space` / `PgDn` / `PgUp` 翻页，`←` / `→` 切章，`Esc` 关面板，`T` 收展目录
- 目录点章即时跳转，当前章高亮跟随

### 📴 离线（PWA）
- 可安装到主屏（manifest + 图标全平台），打开即全屏
- **「⤓ 离线」一键下载整本**到 IndexedDB（localStorage 装不下整本），断网也能读
- Service Worker 只缓存静态壳（stale-while-revalidate），正文永不进 SW 缓存

### 📡 OPDS 订阅（第三方阅读器 App）
- 标准 **OPDS 1.2** 目录：ReadEra / Librera / 静读天下等支持 OPDS 的阅读器可订阅私人书库——拉书目、整本下载 TXT 本地读
- 订阅地址 `https://你的域名/opds`：**用户名任意、口令即 `ADMIN_PASSWORD`**（HTTP Basic Auth；与网页登录共用同一把防爆破 IP 锁，恒时比较）
- 整本下载走服务端**流式拼章**（书头 + 逐章标题 + 正文，字节流直转不经 JS 编解码，不烧 Worker CPU），章节顺序由章表保证
- 注意：第三方 App 内的阅读**进度不会回传**——与网页/PWA 的云端进度不同步，介意请在浏览器里读

### 🧰 书库管理（数据安全）
- **回收站软删**：删除进回收站保留 15 天，可随时恢复；过期惰性清理，多章书自动分批删（单批 ≤40 章）
- **raw 原件留档**：上传的原件永远在 R2，**一键重新清洗**（换分章规则/清理项后整本重洗，进度按同名章保留）
- **index.json.bak 自动快照**：每次发布/删除/恢复前先备份书架索引，防写坏
- **导出清洗后 txt**：书架菜单或阅读页一键导出（含书名/作者/章节标题）

## 快速开始（本地联调）

```bash
git clone <你的仓库> r2novel && cd r2novel
npm ci                          # 安装 wrangler（唯一依赖，仅部署用）
cp .dev.vars.example .dev.vars  # 填 ADMIN_PASSWORD / SESSION_SECRET

npm run dev                     # → http://localhost:8088（数据落 data-dev/）

npm test                        # 单测 52 项（另开终端）
SMOKE_PASSWORD=<.dev.vars 里的 ADMIN_PASSWORD> npm run smoke    # 端到端冒烟 46 项
SMOKE_PASSWORD=<口令> SMOKE_CLEANUP=1 npm run smoke             # 冒烟 + 自动清走测试书（可重复执行）
```

## 命令一览

| 命令 | 说明 |
|---|---|
| `npm run dev` | 本地联调服务器（端口 8088，与生产共用同一套路由核心代码） |
| `npm test` | 52 项单测：cleaner（编码/清洗/分章/超限分段）+ API 鉴权全链路 + OPDS + M2 书库管理 + 审计回归 |
| `npm run smoke` | 端到端冒烟 46 项：M1 全链路 + M2 管理整套 + OPDS 通道；`SMOKE_CLEANUP=1` 结束自动清理测试书 |
| `npm run check` | 跨平台语法检查（遍历 src/public/scripts/test 全部 js） |
| `npm run icons` | 重新生成 PWA 图标（零依赖 zlib 手写 PNG） |
| `npm run deploy` | 本地 `wrangler deploy`（日常部署走 GitHub Actions，见下） |

> 桌面 UI 回归（开发期自测，不随 CI）：`node .ui-tests/ui-desktop.mjs` —— Playwright + 系统 Chrome，13 项断言（`.ui-tests/` 不入库）。

## 架构

```
浏览器 SPA（原生 JS，零依赖；编码/清洗/分章全在浏览器端做——免费 Worker 单请求 10ms CPU 装不下）
   │  /api/*  (fetch, 同源 HMAC Cookie 会话)
   ▼
Cloudflare Worker（src/worker.js 薄壳；业务全在 src/router.js，本地 dev-server 共用同一套）
   │  鉴权 + 存储；静态资源由 CF 边缘直出（不消耗请求数）
   ▼
R2 桶（私有；无公开读、无直链）
```

## API 一览（除 login / opds / export 外全部需会话；opds 与 export 支持 Cookie 或 Basic Auth）

| 方法/路径 | 作用 |
|---|---|
| POST `/api/login` · `/api/logout` | 口令登录（HMAC 无状态 Cookie，防爆破锁定） / 登出 |
| GET `/api/books` | 书架摘要（pinned/标签/字数/进度镜像；顺带回收站惰性清理） |
| POST `/api/books` | 建书（同名 → `duplicate:true`，客户端引导 替换/追加/副本） |
| GET / PATCH / DELETE `/api/books/:id` | 章节表 / 改书名·作者·标签·备注·置顶 / 软删进回收站 |
| POST `/api/books/:id/restore` | 从回收站恢复 |
| POST `/api/books/:id/chapters` | 重建章表（`op: replace\|append`；replace 记录孤儿章节惰性清理，字数累加） |
| PUT / GET `/api/books/:id/chapters/:key` | 传/读一章正文（UTF-8，≤2MB/章） |
| PUT / GET `/api/books/:id/raw` | 上传/取原件（≤50MB，重洗依据） |
| POST `/api/books/:id/publish` | 发布（抽样校验 3 章 + index.bak 快照 + 孤儿章节续清） |
| GET `/api/trash` · DELETE `/api/trash/:id` | 回收站列表 / 彻底删除（分批 ≤40 章，按 `remaining` 续调） |
| GET / PUT `/api/progress/:id` | 阅读进度 `{ch(1-based), ratio}`；PUT 同步书架角标镜像 |
| GET `/opds` | OPDS 1.2 书目目录（全量书 + 每书 acquisition 下载链接） |
| GET `/export/:id.txt` | 整本 TXT 流式下载（书头 + 逐章标题 + 正文） |

**路由参数安全**：`/api/books/:id` 与章节 key 一律白名单 `[A-Za-z0-9_-]{1,80}`，非白名单直接 404（杜绝存储 key 注入与路径穿越）。

### 登录与安全

- **全站 HTTPS**（workers.dev / 自定义域均自动），明文不落线
- **会话**：HMAC-SHA256 签名的无状态 Cookie（`HttpOnly` + `Secure` + `SameSite=Lax`，30 天）；服务器不存会话表，**换 `SESSION_SECRET` 即全员下线**（改口令泄漏后的应急开关）
- **口令比较恒时**：长度差也进比较累积值，时间侧信道不泄露口令长度
- **OPDS / 整本下载通道**：`/opds` 与 `/export/*` 接受浏览器会话 Cookie 或 HTTP Basic Auth（用户名任意，口令即 `ADMIN_PASSWORD`，恒时比较）；错口令走同一把防爆破 IP 锁，锁定期内即使口令正确也 429
- **防暴力破解**（持久化，跨重启/多机房有效）：
  - 按**客户端 IP 的 SHA-256 哈希**计数（不存明文 IP）；
  - 连错 5 次（`BRUTE_LIMIT`）锁定 10 分钟（`BRUTE_LOCK_MS`），**每再锁一轮时长翻倍**，封顶 1 小时（`BRUTE_LOCK_MAX_MS`）——拖死撞库脚本又不至于把自己永久锁死；
  - 失败计数带 15 分钟滑动窗口（隔一刻钟重新计次，不累积冤枉）；
  - **锁定期内即使口令正确也 429**（不给绕过限速逐位试探的机会），响应带剩余分钟数与 `Retry-After`；
  - **成功登录即清零**该 IP 记录；
  - 状态存 R2 `meta/sec/brute.json`（极小文件，过期条目自动清理）。
- **安全响应头**：`_headers` 下发 CSP（default-src 'self'）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`

## 数据布局（R2）

| Key | 内容 |
|---|---|
| `meta/index.json`（+.bak） | 书架摘要；变更前自动快照到 `.bak` |
| `meta/trash.json` | 回收站（含分批清理进度） |
| `meta/sec/brute.json` | 防爆破计数状态（IP 只存 SHA-256 哈希前缀，不落明文） |
| `meta/<bookId>.json` | 单书元数据（章节表/作者/备注/标签/置顶/cleanVer/孤儿章节表） |
| `text/<bookId>/<key>.txt` | 清洗后正文章节 |
| `raw/<bookId>.txt` | 上传原件留档 |
| `progress/<bookId>.json` | 阅读进度 `{ch, ratio, updatedAt}` |

---

## 安装说明（GitHub Actions 一键部署）

填好 Secrets 后，**push 到 main 即自动发布**（也可在 Actions 页手动 Run workflow）。CI 流程：跑单测+语法检查 → 自动建 R2 桶（幂等）→ 部署 Worker → 同步密钥 → **对生产环境跑端到端冒烟（自动清走测试书）**。

### 部署前置
- **Node.js 18+**：本地联调需 `npm ci` 装 wrangler（纯部署可交给 CI，无需本地安装）
- **Cloudflare 账号**：含可用 R2 额度，免费层即可
- **Private GitHub 仓库**：凭据零入库，域名也不入库

### 第 1 步：准备 Cloudflare 侧信息

1. **R2 桶（可跳过）**：桶名已固定为 `r2novel-7d1a`（`wrangler.toml`），CI 首次部署自动创建；要换名就同时改 `wrangler.toml` 与 `deploy.yml`。
2. **Account ID**：[dash.cloudflare.com](https://dash.cloudflare.com) 首页右侧「**账户 ID**」（或 Workers & Pages 概览页右侧）。

### 第 2 步：创建 API Token

dash.cloudflare.com → 右上角头像 → **My Profile → API Tokens → Create Token** → 拉到底 **Create Custom Token**：

| 权限项 | 选择 |
|---|---|
| Account · **Workers Scripts** | Edit（部署 Worker + 写 secrets，必填） |
| Account · **R2** | Edit（自动建桶 + 读写正文，必填） |
| Zone · **Workers Routes** | Edit（仅绑自定义域名时需要；Zone Resources 选 Include → 你的域名所在 zone） |

Continue → Create → **复制 Token**（只显示这一次）。

### 第 3 步：建 GitHub 仓库并填 Secrets

建一个 **Private** 仓库，把本项目 push 上去。然后仓库页 **Settings → Secrets and variables → Actions → New repository secret**，逐条添加：

| Secret 名 | 必填 | 填什么 / 怎么来 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | 第 2 步创建的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | 第 1 步的账户 ID（32 位十六进制） |
| `ADMIN_PASSWORD` | ✅ | 网站登录口令，自己定（建议 ≥12 位；改后须重新部署才生效） |
| `SESSION_SECRET` | ✅ | Cookie 签名密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 或 `openssl rand -hex 32`（换新值会让所有已登录会话失效，无害） |
| `CUSTOM_DOMAIN` | 可选 | 自定义域名，如 `novel.example.com`；**留空**则用 `https://r2novel.<你的子域>.workers.dev`。要求域名 DNS 托管在同一 Cloudflare 账号（CI 自动注入路由并建 DNS 记录） |

### 第 4 步：部署

- push 到 `main` → 自动部署；或 Actions → **Deploy** → **Run workflow** 手动触发。
- 全绿即部署完成 + 生产冒烟通过，日志里能看到访问地址。
- **改了任意 Secret 后**：重新跑一次部署（push 或手动），CI 会把新值 `wrangler secret put` 同步到 Worker——Secret 填了不会自动生效。

> **本地 wrangler 部署（备选）**：`export CLOUDFLARE_API_TOKEN=…`，自定义域名取消 `wrangler.toml` 里 `[[routes]]` 注释，然后 `npm run deploy`。
> **部署纪律**：凭据只进 GitHub Secrets / `.dev.vars`，账户与域名标识绝不提交进 git。

## 目录结构

```
r2novel/
├── src/
│   ├── router.js          共享路由核心（鉴权/建书/传章/发布/回收站/进度；本地与线上共用）
│   └── worker.js          Cloudflare Worker 入口（R2 适配 + ASSETS 透传，薄壳）
├── public/
│   ├── index.html         SPA 单页（登录/书架/上传/回收站/阅读；含桌面左目录栏）
│   ├── manifest.webmanifest / sw.js / icons/*.png
│   ├── css/style.css      手机优先 + 桌面（≥900px）三栏阅读布局
│   └── js/
│       ├── main.js        启动入口 + PWA 注册
│       ├── app.js         登录/书架/上传/回收站
│       ├── reader.js      阅读器（目录双容器/键盘导航/进度/Aa 面板/离线兜底）
│       ├── store.js       API 客户端 + localStorage 镜像 + 并发拉全章
│       ├── cleaner.js     编码识别 + 清理规则 + 智能分章引擎
│       ├── offline.js     IndexedDB 封装（章/书目/离线进度队列）
│       ├── ui.js          共用：忙碌层 + 文件下载
│       └── exporter.js    共用：导出清洗后 txt
├── scripts/
│   ├── dev-server.mjs     本地联调服务器（fs store，与生产同一 router）
│   ├── smoke.mjs          端到端冒烟（SMOKE_CLEANUP=1 自动清理测试书，CI 幂等）
│   ├── check.mjs          跨平台语法检查
│   └── gen-icon.mjs       零依赖手写 PNG 图标
├── test/                  4 个单测文件，52 项（cleaner/api/api-m2/audit；api 含 OPDS/export）
├── .github/workflows/deploy.yml   push main → 测试 → 部署 → 生产冒烟
├── wrangler.toml          Worker/R2/限额配置（无凭据无域名）
└── .dev.vars.example      本地开发变量模板
```

## 实现纪律（质量约束，审计后固化）

1. **编码判定叠可读性打分**：GB18030 全字节合法，fatal 试错永远"成功"→ 必须叠汉字密度/常用字命中/替换符惩罚打分判优。
2. **清洗分章只在浏览器端**（10ms CPU 红线）；Worker 只鉴权 + 存储。
3. **桶不公开**，一切经 Worker 会话；路由参数白名单；UI 一律 `textContent`/`createElement` 防注入。
4. **子请求预算 ≤50/请求**：发布只抽样 3 章、字数信任客户端上报；删除单批 ≤40 章，孤儿章节惰性续清。
5. **进度语义统一 1-based**：落盘/上送/迁移/角标全 1-based，无 ±1 错位；进度写带位置变化检测（同章且比例变化 ≤2% 不重写 index）。
6. **离线**：正文进 IndexedDB，SW 只管静态壳；离线进度入队回网补传。

## 已知事项 / 边界

- 手工 PUT 不存在的 `bookId/key` 会留下孤儿正文对象（仅限已登录者自操作；replace 重建产生的孤儿已自动追踪清理）。
- 清洗质量依赖分章正则；极冷门目录格式会在预览页显示「未识别（整本一章）」——超大文件会自动分段入库（不再 413 中断），也可换自定义正则重洗。
- 小说内容仅限本人合法持有；库不公开、无分享功能。

---

## 发布状态（v1.0 · 2026-09-05 部署就绪）

| 验证 | 结果 |
|---|---|
| 单测（cleaner / api / api-m2 / audit） | 52/52 ✓ |
| 端到端冒烟（M1 全链路 + M2 管理整套 + OPDS 通道） | 46/46 ✓ |
| 桌面 UI 回归（`.ui-tests/ui-desktop.mjs`） | 13/13 ✓ |
| 语法检查（`npm run check`） | ✓ |
| OPDS / 整本导出（Basic Auth + 流式拼章 + XML 转义 + 防爆破覆盖） | 单测 + 冒烟覆盖 ✓ |
| 超大单章自动分段（UTF-8 边界安全，>2MB 不再 413 中断） | cleaner 单测覆盖 ✓ |
| 登录安全加固（恒时口令比较 / 防爆破持久锁定 / 安全响应头） | 审计用例覆盖 ✓ |
| 品牌统一「私人书屋」（index.html / manifest） | ✓ |

上线后首次操作：浏览器打开站点 → 用 `ADMIN_PASSWORD` 登录 → 上传第一本 txt 走一遍清洗分章即可投入使用。**M4 存量迁移**（novel-station 的 32 本）安排在上线之后单独进行。
