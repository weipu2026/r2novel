# r2novel 架构契约（ARCHITECTURE.md）

> 本文档是**随仓库走的显性契约**：无论谁（另一台电脑的你、未来的你、AI 辅助）改这份代码，
> 先读这一页。核心原则：**这里列的守卫与约束是历次实测踩坑换来的，改动时只许搬移、不许重写。**
> 最后更新：2026-09-13（方案 B + 审计补堵渲染窗口，commit 5964c47 之后）。

## 1. 全站地图

生产 `novel.114446.xyz` · GitHub `weipu2026/r2novel` · **部署唯一入口 = push main 触发 CI**
（不要手动 `npm run deploy`，会让线上领先于 GitHub，下次 CI 会回滚你的改动）。

```
src/router.js (1,976)   Workers 入口：~25 个 API 端点（apiXxx 函数 + 集中 dispatch）
public/
  index.html (268)      单页多视图：shelf / upload / read / trash / login，视图切换走 showView()
  js/
    main.js             入口：import { init } from './app.js'
    app.js (2,460)      巨石：17 个功能域、105 个顶层函数、13 个模块级可变状态（见 §2）
    reader.js (774)     阅读器（交互禁区密度全站最高，改动前必读 §3）
    store.js (255)      api（fetch 封装）+ local（localStorage）+ fmtWords
    cleaner.js (427)    纯函数分章引擎（语义冻结：只动它必须先跑 cleaner.test）
    offline.js (143)    离线队列（进度/操作的回网补传）
    ui.js / exporter.js / shared-const.js   通用薄层 / 导出 / 前后端共享常量
    sw.js (107)         PWA shell 缓存（CACHE 版本号由 CI 部署时 sed 替换成时间戳，本地字面量是占位符）
  css/style.css (1,057) 设计令牌化完毕（--accent 等），断点两套：移动 / ≥900px 桌面
scripts/dev-server.mjs  本地 :8088，自动读 .dev.vars；R2NOVEL_DATA=<不含斜杠的相对名> 换数据目录
test/                   139 项单测；.ui-tests/（gitignored）多套 Playwright 回归
数据布局（R2）: index.json + novels/<nid>.json + content/<nid>/<vid>.txt + raw/<nid> + _trash/
```

依赖方向单向：`main → app → {store, cleaner, reader, ui, exporter, offline, shared-const}`；
`reader → {store, offline, ui, exporter}`；前后端共享 `shared-const.js`。禁止引入反向依赖或新依赖。

## 2. app.js 的 13 个共享可变状态（bug 高发区）

改任何上传/书架逻辑前先对照这张表——**历史上 app.js 的 bug 几乎全部长在这些变量的交叉处**
（上传竞态、同名弹窗挂死、批量并发）。拆分重构时，这些变量的读写边界必须原样保留：

| 变量 | 语义 | 谁写 / 谁读 | 禁忌 |
|---|---|---|---|
| `pending` | 当前上传会话 `{title,bytes,preview,updating,keepRaw}` | handleFiles/importBatch 写；onConfirm 起全程用快照 `session` | **上传链路函数（createAndUpload/uploadToExisting/uploadBulkAndRaw/uploadChapters/collectPayload）一律读 `session` 参数，禁止读模块级 `pending`**——上传期间 pending 可能已被换掉 |
| `uploading` | 单文件/重洗上传进行中 | onConfirm 置 true，成功路径提前置 false + finally 兜底 | handleFiles/paste/drop 见 `uploading\|\|importing` 必须拒绝；置 true 与 try 之间不得插入可抛语句 |
| `importing` | 批量导入进行中 | importBatch 置位 | 同上；批量循环中 `pending` 被循环体自己换，受 importing 保护 |
| `createdId` | 「新建」出的书 id | createBook 成功后置，publish 成功置 null | 用途：入库中途失败把半成品移入回收站，否则成为不可见的孤儿数据 |
| `rawInflightReq` | 在途的 raw 上传（进度提示用） | uploadBulkAndRaw | — |
| `books` | 全量在架书 | loadShelf 写 | `shelfSeq` 并发去重：只应用最后一次 loadShelf 的结果，过期响应直接丢弃（该守卫不许删） |
| `ui` | 书架筛选/翻页状态 `{sort,q,tag,finished,readState,star,page}` | 筛选 chip / 搜索框 | 加新筛选维度时：**UI 元素挪容器/新增元素会打脸既有回归断言**，先 grep `.ui-tests/` 里的计数断言 |
| `tagCache` | 标签计数缓存 | loadShelf 时置 null 重算 | — |
| `presetTags` / `presetTagsAt` / `presetTagsInflight` | 常用分类 chips + 去重/并发守卫 | preset 加载 | `At` 防同一波操作连发 GET；`Inflight` 防并发重复请求 |
| `sheetAnchor` | 操作单锚定按钮 | placeSheet / closeSheet | 关闭时**必须清干净内联定位样式（left/top/transform）**，残留会盖住手机端响应式断点 |
| `batchMode` | 书架多选模式 | 批量操作 | — |
| `diagData` | 最近一次残留诊断结果 | 诊断页 | 删除/回收动作读取它，须与扫描结果同会话 |
| `toastTimer` | toast 定时器 | toast() | — |

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

**上传链路（app.js）**
- 上传会话冻结三件套：`uploading` 拦换文件/粘贴/拖入（handleFiles 拒绝时必须复位
  `els.upFile.value=''`，否则同文件不再触发 change）；onConfirm 快照 `session` 全程透传；
  `uploadBulkAndRaw` 见 `!session` throw
- raw 失败不算上传失败（返回 `{rawFailed:true}` 由调用方决定文案）——旧实现 raw 失败删整本正文

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
- 改 UI 后先 grep `.ui-tests/` 里受影响的计数/位置断言同步更新——**断言失败先用旧代码复跑**，
  数值一字不差 = 探针过时，不是产品 bug

## 4. 验证命令（改动后按此顺序，缺一不可）

```bash
npm run check          # 语法门禁（SYNTAX_OK · 30 files）
npm test               # 139 项单测
# UI 回归（每套独立数据目录，串行跑）：
# verify-fix-3bugs(27) / audit-render-window(5) / verify-readstate / audit-marks(21)
# audit-star-chip(10) / verify-iter3(33) / feat-ui(18)
npm run smoke          # 需 TEST_PASSWORD（.dev.vars 里的口令），35 项
```

发布：单 commit 一次 push（一次 push = 一次 CI run）；推前 `git ls-remote origin main` 确认快进；
推后用 REST API `?head_sha=<sha>` 轮询 CI（total_count 必须=1）；线上验证加 cache-buster
与本地剔除行尾 diff。

## 5. 何时拆分（触发条件，满足才动，不为整洁而整洁）

- app.js 巨石暂不拆（17 域分节清晰、系统全绿）。触发条件：① 新增功能域时先拆相关旧域再叠加；
  ② 上传域再出竞态 bug → 拆上传域（含批量/重洗/章节编辑，~900 行）并把 §2 状态收敛成显式模块；
  ③ 两台电脑并行开发冲突变频繁 → 按域拆文件降低合并冲突面
- 不动：cleaner.js（纯函数语义冻结）、store/offline/sw（稳定薄层）、CSS（刚令牌化）
- 拆分纪律：函数+注释**整体搬家**、一个 commit 只搬一个域、每步跑 §4 全量回归后才推
