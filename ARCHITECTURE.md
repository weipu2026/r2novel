# r2novel 架构契约（ARCHITECTURE.md）

> 本文档是**随仓库走的显性契约**：无论谁（另一台电脑的你、未来的你、AI 辅助）改这份代码，
> 先读这一页。核心原则：**这里列的守卫与约束是历次实测踩坑换来的，改动时只许搬移、不许重写。**
> 最后更新：2026-09-15（索引 v2 分片 + SW 门禁 + 部署后核验落地之后）。

## 1. 全站地图

生产 `novel.114446.xyz` · GitHub `weipu2026/r2novel` · **部署唯一入口 = push main 触发 CI**
（不要手动 `npm run deploy`，会让线上领先于 GitHub，下次 CI 会回滚你的改动）。

```
src/router.js (2,242)   Workers 入口：~25 个 API 端点（apiXxx 函数 + 集中 dispatch）；
                        书架索引 v2 分片存储（openIndex/makeHandle/migrateV1/rebuildIdxRoot，见 §6）
public/
  index.html (278)      单页多视图：shelf / upload / read / trash / login，视图切换走 showView()
  js/
    main.js             入口：import { init } from './app.js'
    app.js (1,512)      宿主：登录/书架/批量/标签/诊断/回收站/阅读入口 + 8 个模块级可变状态（见 §2）
    dom.js (28)         共享 DOM 薄层：els 元素表 + $ / $$ / esc / normTitle + IC（图标字面量，两端共用）
    reader.js (774)     阅读器（交互禁区密度全站最高，改动前必读 §3）
    store.js (255)      api（fetch 封装）+ local（localStorage）+ fmtWords
    cleaner.js (427)    纯函数分章引擎（语义冻结：只动它必须先跑 cleaner.test）
    offline.js (143)    离线队列（进度/操作的回网补传）
    ui.js (61) / exporter.js / shared-const.js   通用薄层（bindBusy/bindToast/busy/toast）/ 导出 / 前后端共享常量
    sw.js (107)         PWA shell 缓存（CACHE 版本号由 CI 部署时 sed 替换成时间戳，本地字面量是占位符）
    upload/ (1,141)     上传域（2026-09-13 拆分完成）：
      index.js (59)       唯一对外入口：再导出 openUpload/rewashConfirm/openChapterEditor + init(caps) 注入宿主能力
      session.js (76)     上传会话状态唯一事实源（原 app.js 的 5 个上传裸变量，见 §2）
      ctx.js (21)         宿主注入点 provide(host) / host()（未注入即 fail loud）
      files.js (192)      上传页入口 openUpload + handleFiles（选文件/拖入/粘贴）+ importBatch
      prepare.js (36)     读字节建会话 / 编码选择
      preview.js (205)    预览面板（runPreview / 分章表 / 清洗选项）
      upload.js (256)     上传核心链路（onConfirm / 建书 / 逐章上传 / 原件 / 重试）
      editor.js (266)     编辑章节弹层
      rewash.js (28)      重洗确认 + 转交上传链路
  css/style.css (1,057) 设计令牌化完毕（--accent 等），断点两套：移动 / ≥900px 桌面
scripts/dev-server.mjs  本地 :8088，自动读 .dev.vars；R2NOVEL_DATA=<不含斜杠的相对名> 换数据目录
scripts/verify-deploy.mjs 部署后核验：拉生产静态文件与仓库哈希比对（CI 最后一步自动跑）
test/                   146 项单测（14 文件；index-shards.test.mjs = 分片专项）；.ui-tests/（gitignored）多套 Playwright 回归
数据布局（R2）: meta/idx/{root,s<N>}.json(+.bak) 书架索引 v2 分片 + meta/<id>.json + meta/sec/st/<id> + text/<id>/<key>.txt
                + raw/<id>.txt + progress/<id>.json + meta/trash.json + meta/index.json(v1 冻结快照)
```

依赖方向单向、无环：
`main → app → {store, cleaner, reader, ui, exporter, offline, shared-const, dom, upload}`；
`upload/index → {files, prepare, preview, upload, editor, rewash} → {dom, store, ui, cleaner, session, ctx}`；
`reader → {store, offline, ui, exporter}`；前后端共享 `shared-const.js`。
**upload/ 各模块一律不 import app.js**——需要宿主能力（切视图/刷书架/弹层/标签 chips）时走 `ctx.host()`。
禁止引入反向依赖或新依赖。

## 2. app.js 的 8 个共享可变状态 + upload/session.js 的 5 个上传态（bug 高发区）

改任何上传/书架逻辑前先对照这张表——**历史上 app.js 的 bug 几乎全部长在这些变量的交叉处**
（上传竞态、同名弹窗挂死、批量并发）。上传域 2026-09-13 拆分后，原 5 个上传裸变量收敛为
`upload/session.js` 的 API（`current/begin/clear`、`isBusy/isUploading/setUploading`、
`isImporting/setImporting`、`createdId/setCreatedId`、`rawReq/setRawReq`）；**语义与读写边界原样保留**
（尤其「能否开始新会话」的唯一判据 `isBusy()` 必须继续覆盖 change/drop/paste 三个入场口）。
表格上半部分（前 5 行）指的就是它：

| 变量 | 语义 | 谁写 / 谁读 | 禁忌 |
|---|---|---|---|
| `session.current()`（原 `pending`） | 当前上传会话 `{title,bytes,preview,updating,keepRaw}` | files.js 的 handleFiles/importBatch 写；onConfirm 起全程用快照 `session` | **上传链路函数（createAndUpload/uploadToExisting/uploadBulkAndRaw/uploadChapters/collectPayload）一律读 `session` 参数，禁止读 `session.current()`**——上传期间当前会话可能已被换掉 |
| `session.isUploading()`（原 `uploading`） | 单文件/重洗上传进行中 | onConfirm 置 true，成功路径提前置 false + finally 兜底 | handleFiles/paste/drop 见 `isBusy()` 必须拒绝；置 true 与 try 之间不得插入可抛语句 |
| `session.isImporting()`（原 `importing`） | 批量导入进行中 | importBatch 置位 | 同上；批量循环中当前会话被循环体自己换，受 importing 保护 |
| `session.createdId()`（原 `createdId`） | 「新建」出的书 id | createBook 成功后置，publish 成功置 null | 用途：入库中途失败把半成品移入回收站，否则成为不可见的孤儿数据 |
| `session.rawReq()`（原 `rawInflightReq`） | 在途的 raw 上传（进度提示用） | upload.js 的 uploadBulkAndRaw | — |
| `books` | 全量在架书 | loadShelf 写 | `shelfSeq` 并发去重：只应用最后一次 loadShelf 的结果，过期响应直接丢弃（该守卫不许删） |
| `ui` | 书架筛选/翻页状态 `{sort,q,tag,finished,readState,star,page}` | 筛选 chip / 搜索框 | 加新筛选维度时：**UI 元素挪容器/新增元素会打脸既有回归断言**，先 grep `.ui-tests/` 里的计数断言 |
| `tagCache` | 标签计数缓存 | loadShelf 时置 null 重算 | — |
| `presetTags` / `presetTagsAt` / `presetTagsInflight` | 常用分类 chips + 去重/并发守卫 | preset 加载 | `At` 防同一波操作连发 GET；`Inflight` 防并发重复请求 |
| `sheetAnchor` | 操作单锚定按钮 | placeSheet / closeSheet | 关闭时**必须清干净内联定位样式（left/top/transform）**，残留会盖住手机端响应式断点 |
| `batchMode` | 书架多选模式 | 批量操作 | — |
| `diagData` | 最近一次残留诊断结果 | 诊断页 | 删除/回收动作读取它，须与扫描结果同会话 |
| `toastTimer` | toast 定时器 | ui.js 的 toast() | — |

`reader.js` 自持 `state`（book/chapters/cur/cache/inflight/toc/dirty/lastSave/failedIdx/pref），
与 app.js 的边界：`bindReader(root, navCb)` + app 显式调 `reader.openBook/closeReader`。

## 3. 改动禁区（每条都有实测事故背书，删前先复现原 bug）

**进度写盘（reader.js）**
- `curRatio()` 三态 + art 空判据，一个都不能少：`sh===0&&ch===0 → null`（隐藏）；
  `!els.art.childElementCount → null`（**渲染窗口**：renderChapter 清空正文到填回之间
  scrollHeight===clientHeight，少了这行会误判「一屏装得下」把当前章写成 100%）；
  `max<=0 → 1`（短末章视为读完）。`saveProgress()` 见 null 直接 return——**宁可不写也不写坏值**
- `closeReader()` 清 state.book + 推进 openSeq；`openBook()` 落 state 必须在
  `await api.getProgress()` 与 seq 校验**之后**；`renderChapter` 的 `!state.book` 与
  `state.cur !== idx` 守卫在成功/失败两条路径都要有（防迟到渲染覆盖 + 写坏进度）
- 失败章 `failedIdx` 不算「读到」：切后台不得把进度写成失败章 0%

**上传链路（upload/，2026-09-13 拆分后）**
- 上传会话冻结三件套：`session.isBusy()` 拦换文件/粘贴/拖入（handleFiles 拒绝时必须复位
  `els.upFile.value=''`，否则同文件不再触发 change）；onConfirm 快照 `session` 全程透传；
  `uploadBulkAndRaw` 见 `!session` throw
- raw 失败不算上传失败（返回 `{rawFailed:true}` 由调用方决定文案）——旧实现 raw 失败删整本正文
- **宿主能力必须经 `host()`**：`upload/` 里出现 `showView(` / `loadShelf(` / `openModal(` /
  `confirmModal(` / `parseTagInput(` 之类的裸调用就是依赖倒挂。新增能力时先在 `upload/index.js`
  的 `init(caps)` 里注入，再在目标模块写 `host().xxx(`
- **搬函数必须连 import 一起搬**：`importBatch` 从 app.js 搬到 files.js 时漏带 `CHAPTER_MAX` 的
  import，ReferenceError 又被同函数 `catch { fail++ }` 吞掉 → 批量导入静默 0 本入库、页面无任何报错
  （只有 `verify-review-fixes` 的「两本均入库」抓得到）。**这类缺陷 `npm run check` 的 ② 模块一致性检查
  现在能拦住了**（报 `UNDEF CONST`），但静态检查只覆盖 `public/**/*.js` 的导入 / 常量 / 宿主调用三种模式，
  搬完仍要跑 §4 全套
- **搬常量同理，而且更隐蔽**：`IC`（图标字面量）原本是 app.js 的模块级常量，跟着 `pvIconBtnSvg`
  一起被搬进 `upload/preview.js`，但 app.js 的「标签管理」弹层还在用它 → app.js 成了「引用 `IC`
  却没 import」的悬空引用，**一开标签管理就 `ReferenceError`、弹层空白**。当时三层全漏：`npm run check`
  只查语法、`IC` 只有 2 字符、旧版大写常量正则要求总长 ≥4；`verify-review-fixes` 不碰标签管理，
  唯一覆盖它的 `batch-tags-ui` 报红却被当成「既有不稳定」。**判据：搬任何模块级声明前，先 grep 全仓库
  数一遍它的引用点，逐个确认引用方能拿到它**（本轮已把 `IC` 移到共享层 `dom.js`）

**UI/CSS（改元素位置或容器时必查）**
- 安全区：`.read-top`/`.read-bar` 的 env(safe-area-inset-*) 必须加在 **height** 上
  （`height: calc(44px + env(...))`），写「固定高度+padding」会被 box-sizing:border-box 压成 0
- 元素挪容器/换父级后：grep CSS 里挂原容器的选择器（`.readfilter button.star-chip` 类事故），
  并比特异性与源码顺序；承载状态的属性从子元素搬父元素要重查 :hover 级联（`.card.pinned` 事故）
- 移动端工具栏**常驻不隐藏**（`bars-hid` 整体删除是有意为之，别再加回「轻点隐藏」）
- `reader.js renderChapter` 的 `state.cur !== idx` 竞态守卫、`placeSheet` 的内联定位清理：
  复现必须用 `page.route` 网关式扣响应，固定延时测不出来

**测试基建纪律**
- `.ui-tests` 必须串行（互踩 8088）；启服与跑测试写**同一条命令**（后台 `&` 进程随命令结束被回收）
- `R2NOVEL_DATA` 必须用**相对路径**（`path.join` 归一化会让绝对路径前缀校验失败 → 建书 500）
- 跑 UI 套件前先确认它是否会改真实数据（用独立数据目录，跑完删）；多轮造书用唯一文件名（防同名弹窗挂死）
- **要求空书架的套件（feat-ui / ui-desktop）各自单独用一个干净数据目录**：和别的套件共用目录会因为
  书架里已有书而假失败（feat-ui 13/18、ui-desktop 报「书库空态为全宽引导卡」），换干净目录即 18/18、20/20
- 改 UI 后先 grep `.ui-tests/` 里受影响的计数/位置断言同步更新——**断言失败先用旧代码复跑**，
  数值一字不差 = 探针过时，不是产品 bug
- `scripts/dev-server.mjs` 的请求体桥接已改成自管 `ReadableStream`（`reqBodyStream`）：
  handler 早退时 `dropBody()` 会 `req.body.cancel()`，原来的 `Readable.toWeb(req)` 会把后续分片
  enqueue 到已关闭的 controller 抛未捕获异常、**直接打死 dev-server**，把 401/400 伪装成
  「测试莫名 Failed to fetch」。别改回 `Readable.toWeb(req)`

## 4. 验证命令（改动后按此顺序，缺一不可）

```bash
npm run check          # 门禁一次跑完三项，任一有问题即 CHECK_FAIL 且 RC=1
#   ① 语法：全仓库 node --check（SYNTAX_OK · 42 files）
#      跳过 node_modules / data-* / .git / .ui-tests / .wrangler / shots
#   ② 模块一致性（MODULE_OK · 20 files）：只查 public/**/*.js，补 ① 抓不到的运行时缺陷
#      a) 命名 import / 再导出的名字在目标模块里不存在（rewash.js 漏 export 事故）；
#         副作用 import `import './x.js'` 与 `export * from './y.js'` 只校验**路径存在性**
#      b) 全大写常量被引用却未 import / 未声明（files.js 漏 CHAPTER_MAX、app.js 悬空 IC 事故）；
#         判据 = 名字总长 ≥4 **或** 它在 public/ 里确实被 export 过（后半句才抓得到 2 字符的 IC）
#      c) upload/ 里绕过 ctx.host() 裸调宿主能力（含 app.js 顶层函数）；宿主能力名单从
#         app.js 的 `initUpload({...})` 实参**自动抽取**，不再手写镜像
#   ③ SW SHELL 双向比对（SHELL_OK）：public/ 全部静态资源必须在 SHELL 预缓存清单里
#      （SW MISSING），SHELL 条目必须真实存在（SW UNKNOWN）——手写清单漂移在此被拦
npm test               # 146 项单测（含 index-shards 分片专项 7 项）
# UI 回归（每套独立数据目录、串行跑）：
# verify-fix-3bugs(27) / audit-render-window(5) / verify-readstate / audit-marks(21)
# audit-star-chip(10) / verify-iter3(33) / verify-batch(12) / verify-prelaunch(17)
# verify-audit(14) / verify-audit4(12) / verify-review-fixes(11) / verify-0915-fixes(7)
# feat-ui(18)* / ui-desktop(20)*
# * 这两套要求空书架，各自单独用一个干净数据目录
npm run smoke          # 需 TEST_PASSWORD（.dev.vars 里的口令），55 项
# CI 部署链：单测+门禁 → 建桶 → 部署 → 同步密钥 → 生产冒烟(55) → verify-deploy.mjs 哈希核验
```

> 已知与重构无关的既有失败（用旧代码复跑基线同样红，别误判成回归）：`verify-publish` 12/13
> （C2「章内滚动不更新镜像 updatedAt」时间敏感，三轮实测抖动 5 / 6 / 76ms）、`batch-tags-ui` 12 项里
> 「批量软删后书架少一本」偶发时序抖动（实测数值正确：3 本 + batchBar 已隐藏 + 共 3 本）。
> ⚠️ `batch-tags-ui` 的「标签管理列出全量标签」曾长期报红并被归因于「不稳定」，实际是 app.js
> 悬空 `IC` 的真 BUG（见 §3，已修）。**「既有失败」必须先量出实际数值再定性**，否则会把真回归写进基线。

发布：单 commit 一次 push（一次 push = 一次 CI run）；推前 `git ls-remote origin main` 确认快进；
推后用 REST API `?head_sha=<sha>` 轮询 CI（total_count 必须=1）；CI 末步自动跑
`scripts/verify-deploy.mjs`（生产静态文件与仓库哈希比对，排除 sw.js——部署时会改写 CACHE 版本号），
本地抽查仍可 cache-buster + 下载比对（行尾归一化后比）。

## 5. 何时拆分（触发条件，满足才动，不为整洁而整洁）

- **上传域已于 2026-09-13 拆出**（触发条件 ② 命中：上传竞态反复出事）。6 步、每步一个独立
  commit + 全量回归：①session 状态收敛 ②dom.js + ctx.js，搬出 prepare/preview ③上传核心链路 +
  toast 提到 ui.js ④editor.js ⑤files/rewash/index 装配 + 上传页事件迁移 ⑥文档与推送。
  app.js 2464 → 1509 行，§2 的 5 个上传裸变量收敛为 `upload/session.js`。
  **2026-09-15 复审又修掉两处遗留**（悬空 `IC`、同名弹窗被遮罩关闭后上传页死锁）→ 现 1512 行
- app.js 其余部分暂不拆（域分节清晰、系统全绿）。后续触发条件：① 新增功能域时先拆相关旧域再叠加；
  ③ 两台电脑并行开发冲突变频繁 → 按域拆文件降低合并冲突面
- 不动：cleaner.js（纯函数语义冻结）、store/offline/sw（稳定薄层）、CSS（刚令牌化）
- 拆分纪律：函数+注释**整体搬家**、一个 commit 只搬一个域、每步跑 §4 全量回归后才推；
  **搬完先跑 §4 的 `npm run check`（1 秒出结果，含模块一致性检查）再跑 UI 套件**（十几分钟）

## 6. 书架索引 v2 分片契约（2026-09-15 落地，改存储层前必读）

**布局**：`meta/idx/root.json`（`{v:2, shards:n, map:{书id:分片号}}`）+ `meta/idx/s<N>.json`
（≤500 本/片，`{books:[摘要]}`），各带 `.bak`。**v1 的 `meta/index.json` 迁移后冻结**：
不再读不再写，本体保留（旧代码回滚窗口）+ 原文另存 `meta/index.json.v1.bak` 双保险。

**读写形态**（`openIndex(store, opts)`）：
- full（默认）：root + 全部分片聚合，`GET /api/books`/publish 响应/opds/标签清单用——响应形状与 v1 完全一致
- `{ id }` 单书模式：root + 该书所在片（热路径：进度镜像/PATCH/就地编辑同步/软删/恢复）
- `{ ids }` 并集模式：批量治理用，只载目标所在片
- `{ rootRaw }`：调用方已读过 root（批量接口核预算）→ 传进来复用，省 1 子请求（否则公式得算两次读）
- `{ id }` / `{ ids }` 都是 **partial**（只加载部分分片）→ 对账只做「补/改 map」，不做死指针摘除

**预算纪律**（48 子请求软顶）：
- 单书写 = root 1 读 + 1 片读 + 片写 + bak ≈ 4~5，永远安全
- 批量/标签：`1 + 3k + 2N ≤ 48`（k=目标跨片数），超出贪心裁剪，**被裁的 id 必须原样回传**
  （`deferred`，客户端 `public/js/batch-queue.js` 排回队列续调）；标签治理用 `remaining`，同款语义。
  「只回传数量、前端不消费」＝静默丢书（v2 实测：书库 ≥1501 本时 18 本散在 5 片只处理 16 本，
  且前端把 2 本计成「失败（可能是半成品书）」→ 用户不会重试）
- diag/purgeOrphans：预算基数 = `2 + idx.shardCount`（root+分片+trash）

**自愈链**（读路径只读回退，不在读时写盘）：root 坏 → root.bak → 由分片重建（`rebuildIdxRoot`）；
分片坏 → 片 .bak → 双坏则该片按空处理且 **save() 拒绝写入**（`shardRaw===undefined` throw）——
绝不允许把空片固化（v1 的真数据丢失路径）。书 meta 都在 R2，可经「检查残留→无主书→回收站→恢复」重建。
片与片 bak **都不存在**（missing，迁移半途/被外部删除）→ **允许重建写入**：没有可丢的内容，
否则一个缺失的片文件会让全库永久无法发布（save 一律 throw）。此时全量模式还会尝试 `resumeMigration`。

**构造期对账**（`reconcileIdx`，makeHandle 构造时跑）：分片内容与 `root.map` 是**两处真相**
（bak 回落、写盘半途失败都会让二者错位），错位即「书架看得见、点进去 404」，下一次成员变更还会
把错位 map 固化。以「已读到的片内容」为准：① 片里有、map 缺失或指错片 → 补/改（同 id 多片副本以
片号最小者为准，其余摘除）；② map 里有、但该片内容确凿读到却没这本书 → 摘除死指针
（片缺失/双坏时跳过：那是「读不到」，不是「确认没有」）。

**禁忌**：
- **禁止再读写 `meta/index.json`**（测试也走 `_harness.mjs` 的 `readIdxBooks/writeIdxBooks`）
- root bak 只在「写前 root 是有效布局且 `shards>0`」时写：迁移首写、以及**迁移空库后发布第一本书**
  （root 存在但 shards:0）都没有可备份的旧状态——拿空布局当 bak 会伪造「合法但空」的书架
  （回退即清空书架 + 再发布覆盖首片，已实测）
- 迁移必须**均匀整块切**（500/片），不要逐本 append+拆分（会留 251/250 参差片）
- 迁移写序：分片（含片 bak）与 v1 留档先落，**root 最后提交**（并发写中断会留下「root 说有 N 片、
  分片一个都没落」，而 root 看着合法 → 自愈链永不重迁 → 书架永久为空且发布必 500）
- 新增 API 的 index 读写一律走 `openIndex` 三种模式，别绕过 handle 直接拼 key
