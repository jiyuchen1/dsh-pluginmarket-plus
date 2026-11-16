# dsh-pluginmarket-plus · 插件市场增强

给 DSH 的插件页加两个能力：**插件源缓存**（把插件索引 JSON 落到本地磁盘，发现页不再被上游超时拖垮）和**可更新**（集中检查已安装插件的新版本，支持单包、多选与一键更新）。

安装后，插件页（Plugins）会出现两个新 tab：

```
[已安装]  [发现]  [插件源缓存]  [可更新]
```

## 安装

从 npm：

```sh
dsh plugin --profile web add dsh-pluginmarket-plus
```

直接从 GitHub：

```sh
dsh plugin --profile web add github:jiyuchen1/dsh-pluginmarket-plus
```

安装后重启 `dsh web`（或在桌面应用里安装并重启），然后打开 **Plugins → 插件源缓存 / 可更新**。

## 功能一：插件源缓存

### 为什么需要它

官方插件市场（`plugin-market` 服务）读取索引时单次抓取限时 **15 秒**、失败不落盘，也不会沿用上一份成功的结果。真实索引很大，实测（2026-11-14，本机直连）：

| 索引 | 大小 | 插件数 | 抓取耗时 |
|---|---|---|---|
| `https://cdn.dsh.so/market/index.json` | 8.4 MB | 11,141 | ≈ 64 s |
| `https://api.dshfind.com/market/dsh-index.json` | 4.7 MB | 8,321 | ≈ 34 s |
| `https://gcore.jsdelivr.net/gh/yueyexiayu/dsh-market-zh@main/index.json` | 0.7 MB | 597 | ≈ 4 s |
| `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` | 4.6 MB | 5,643 | ≈ 1 s |

前两个都远超 15 秒，于是「发现」页搜索经常直接失败，报索引超时或搜不出来。

### 可添加的索引源

下面四个地址可以直接复制，粘贴到 **插件源缓存 → 添加**，或 **发现 → 索引源**：

```text
https://cdn.dsh.so/market/index.json
https://gcore.jsdelivr.net/gh/yueyexiayu/dsh-market-zh@main/index.json
https://api.dshfind.com/market/dsh-index.json
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

> 这些索引由社区维护，地址或格式可能变化；添加后可在「插件源缓存」里点「刷新」验证是否可用。

本功能做三件事：

1. **落盘缓存**：用更长的超时（默认 2 分钟）在后台抓取索引，校验格式 1 的基本结构，原子写入 `<profile>/.pluginmarket-plus/index-<id>.json`；失败保留上一份成功副本。
2. **本地镜像**：通过本机 Web 服务提供 `http://127.0.0.1:<port>/pluginmarket-plus/index/<id>.json`，抓取是毫秒级。
3. **接管发现页**：把 `plugin-market` 的 `indexes` 从上游地址切换成本地镜像（只替换已经缓存成功的源），搜索随即恢复正常。

### 使用

打开 **Plugins → 插件源缓存**：

- 「全部刷新」「刷新」：立即重新抓取并落盘。
- 「自动刷新」「刷新间隔」：默认每 4 小时刷新一次（另有插件启动时补一次过期/缺失的源）。
- 「让发现页使用本地缓存」：接管 `plugin-market` 的索引源；关掉即还原为上游地址。
- 索引源列表：可添加/移除源，可复制每个源的本地镜像地址。

### 行为与限制

- 缓存目录：`<profile>/.pluginmarket-plus/`（可用 `cacheDir` 改）。
- 镜像路由必须免登录：`pluginMarket` 在 Host 进程里用裸 `fetch` 读取索引，不带浏览器 Cookie；路由只提供公开的索引 JSON，且 Web 服务默认只绑定回环地址。
- 接管只替换已缓存成功的源；尚未缓存成功的源继续直连上游，不会因为镜像 404 而整体失败。
- 索引里的相对 `icon` 会在落盘时改写为相对上游地址的绝对地址，避免在镜像源下解析到 localhost。
- 详情页（README/长描述）仍由官方 `plugin-market` 按版本的 npm/Git 源读取，不受本缓存影响；上游仓库不可达时详情页仍可能失败。
- 禁用/卸载插件前建议先关闭「让发现页使用本地缓存」，否则发现页会保留指向本机镜像的索引地址。

## 功能二：可更新

### 它能做什么

「可更新」把已安装插件里**有新版本**的集中列出来，并允许：

- 单项「更新」
- 勾选多个后「更新已选」
- 一次「更新全部」（按当前设置开关选取）
- 批量按顺序执行；**某一项失败会继续下一项**，最后汇总成功/失败/需重启
- 实时进度（检查 → 移除 → 安装 → 回滚）、可展开 pnpm 日志、可取消当前项
- 不兼容版本显示与「版本豁免」流程
- 齿轮设置里三个开关：
  - 「显示检查失败的项」：显示检查失败 / 无法检查 / 未检查的条目
  - 「包含预发布 / 已废弃版本」：把这两类目标版本也纳入列表与「更新全部」
  - 「包含已禁用的插件」：把已禁用但可更新的插件也纳入列表

默认列表只显示「有更新的项」：可更新 + 暂不推荐（预发布/已废弃未开启时）+ 不兼容（需先豁免）；检查失败类条目默认隐藏。

### 检查更新从哪里来

- **npm 包**：调用 DSH 官方的 `pluginManager.listVersions(name)`，由 pnpm / registry 查询新版本，返回 `prerelease`、`deprecated`、是否声明 `dsh.bundle`、与当前 DSH 的兼容性。
- **Git 包**（固定 40 位 commit）：官方不查 GitHub，本插件读**插件源缓存里的市场索引**，取该包最新版本的 `source.commit` 与已安装 commit 比较；索引里没有就标记「无法检查」，不会去调 GitHub API。
- 以下不进列表：官方自带 bundle、`link:` / `file:` 本地目录、`npm:` 别名、分支/标签等未固定 commit 的 Git 安装。

### 更新怎么执行

复用 DSH 官方的 `pluginManager.updateBundle()`：校验目标版本与 DSH 兼容性 → 移除旧版 → 安装新版；失败时尝试装回旧版本（结果在 `restore` 里），回滚也失败则包处于未安装状态。需要 build script 批准的新版本会更新失败并回滚，官方路径是「移除后重新安装并批准脚本」。

### 版本豁免

如果目标版本声明的 `engines.dsh` / peers 与当前 DSH 不匹配，官方会在检查阶段拒绝更新。对确实想用的版本，可以在不兼容行点「版本豁免」：

1. 勾选「我接受风险：可能崩溃或数据丢失」
2. 再点一次「豁免此版本并更新」二次确认

确认后调用 `setVersionExemption(pkg@version, runtimeVersion, true, acceptRisk: true)`，写入 profile 的本地豁免记录，然后自动发起更新。豁免只对「这个包的这一个版本 × 当前这个 DSH 版本」生效，插件或 DSH 升级后自动失效。

### 行为与限制

- 检查更新需要网络；registry 走 pnpm 配置的源（npmjs、npmmirror 或私有源）。
- Git 包的检查依赖「插件源缓存」里的索引；缓存被禁用或为空时，Git 项会显示「无法检查」。
- 官方自带 bundle 跟随 DSH 版本升级，不参与这里的单包更新。
- 一次只跑一个更新（顺序队列）；批量可随时取消当前项。
- 部分插件更新后需要重启 DSH 才能完全生效（结果里会标「需重启」）。

## 配置（cordis.patch.yml）

| 字段 | 默认 | 说明 |
|---|---|---|
| `sources` | `[]` | 索引源列表；留空时自动接管发现页已有的源 |
| `autoRefresh` | `true` | 是否定时刷新 |
| `refreshIntervalHours` | `4` | 定时刷新间隔（0.25–168 小时） |
| `managePluginMarket` | `true` | 是否让发现页使用本地镜像 |
| `fetchTimeoutMs` | `120000` | 单次抓取超时 |
| `maxBytes` | `67108864` | 单个索引正文上限 |
| `retries` | `2` | 失败重试次数 |
| `cacheDir` | `.pluginmarket-plus` | 缓存目录（相对 profile） |
| `updatesIncludeDisabled` | `false` | 「可更新」是否包含已禁用的插件 |
| `updatesIncludePrerelease` | `false` | 「可更新」是否包含预发布/已废弃版本 |
| `updatesShowFailed` | `false` | 「可更新」是否显示检查失败 / 无法检查 / 未检查的条目 |

## 文件

- `lib/index.js` — Host：缓存编排、镜像路由、定时器、发现页接管；「可更新」桥接与队列。
- `lib/store.js` — 磁盘缓存与状态清单（原子写）。
- `lib/refresh.js` — 抓取、最小格式校验、相对 icon 改写。
- `lib/updates.js` — 「可更新」纯逻辑：版本比较、候选筛选、检查、顺序队列、结果归一。
- `client.js` — 两个 tab（插件源缓存 / 可更新），无构建步骤，React 来自宿主模块表。
- `tools/` — 自测与独立验证脚本（`npm test` 跑 `tools/updates-selftest.mjs`）。

## 开发与测试

```sh
npm test                                  # updates-selftest
node tools/updates-integration.mjs        # Host 集成（假 ctx + 假 pluginManager）
node tools/client-selftest.mjs            # 客户端纯逻辑与交互
node tools/client-bundle-check.mjs         # 客户端装载/渲染冒烟
```

## License

MIT © 2026 jiyuchen1