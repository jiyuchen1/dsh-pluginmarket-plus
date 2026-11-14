# dsh-pluginmarket-plus · 插件市场缓存

把「插件 → 发现」读取的索引 JSON 缓存到本地磁盘：手动刷新、每几小时自动刷新，并让发现页直接读本地镜像，绕开上游索引超时。

## 安装

从 npm（发布后）：

```sh
dsh plugin --profile web add dsh-pluginmarket-plus
```

直接从 GitHub：

```sh
dsh plugin --profile web add github:jiyuchen1/dsh-pluginmarket-plus
```

安装后重启 `dsh web`（或在桌面应用的插件页安装并重启），然后打开 **设置 → 插件市场缓存**。

## 为什么需要它

官方插件市场（`plugin-market` 服务）读取索引时单次抓取限时 **15 秒**、失败不落盘，也不会沿用上一份成功的结果。真实索引很大，实测（2026-11-14，本机直连）：

| 索引 | 大小 | 插件数 | 抓取耗时 |
|---|---|---|---|
| `cdn.dsh.so/market/index.json` | 8.4 MB | 11,141 | ≈ 64 s |
| `api.dshfind.com/market/dsh-index.json` | 4.7 MB | 8,321 | ≈ 34 s |
| `gcore.jsdelivr.net/.../dsh-market-zh` | 0.7 MB | 597 | ≈ 4 s |

前两个都远超 15 秒，于是搜索经常直接失败，报「索引超时」或「搜索不出来」。

本插件做三件事：

1. **落盘缓存**：用更长的超时（默认 2 分钟）在后台抓取索引，校验格式 1 的基本结构，原子写入 `<profile>/.pluginmarket-plus/index-<id>.json`；失败保留上一份成功副本。
2. **本地镜像**：通过本机 Web 服务提供 `http://127.0.0.1:<port>/pluginmarket-plus/index/<id>.json`，抓取是毫秒级。
3. **接管发现页**：把 `plugin-market` 的 `indexes` 从上游地址切换成本地镜像（只替换已经缓存成功的源），搜索随即恢复正常。

## 使用

安装并启用后，打开 **设置 → 插件市场缓存**：

- 「全部刷新」「刷新」：立即重新抓取并落盘。
- 「自动刷新」「刷新间隔」：默认每 4 小时刷新一次（另有插件启动时补一次过期/缺失的源）。
- 「让发现页使用本地缓存」：接管 `plugin-market` 的索引源。关掉即还原为上游地址。
- 索引源列表：可添加/移除源，可复制每个源的本地镜像地址。

## 行为与限制

- 缓存目录：`<profile>/.pluginmarket-plus/`（可用 `cacheDir` 改）。
- 镜像路由必须免登录：`pluginMarket` 在 Host 进程里用裸 `fetch` 读取索引，不带浏览器 Cookie；路由只提供公开的索引 JSON，且 Web 服务默认只绑定回环地址。
- 接管只替换已缓存成功的源；尚未缓存成功的源继续直连上游，不会因为镜像 404 而整体失败。
- 索引里的相对 `icon` 会在落盘时改写为相对上游地址的绝对地址，避免在镜像源下解析到 localhost。
- 详情页（README/长描述）仍由官方 `plugin-market` 按版本的 npm/Git 源读取，不受本缓存影响；上游仓库不可达时详情页仍可能失败。
- 禁用/卸载插件前建议先在设置页关闭「让发现页使用本地缓存」，否则发现页会保留指向本机镜像的索引地址。

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

## 文件

- `lib/index.js` — Host：缓存编排、镜像路由、`/api/pluginmarket-plus/*`、定时器、发现页接管。
- `lib/store.js` — 磁盘缓存与状态清单（原子写）。
- `lib/refresh.js` — 抓取、最小格式校验、相对 icon 改写。
- `client.js` — 设置页（无构建步骤，React 来自宿主模块表）。

## License

MIT © 2026 jiyuchen1
