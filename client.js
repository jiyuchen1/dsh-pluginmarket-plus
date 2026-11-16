/**
 * dsh-pluginmarket-plus —— 客户端半边（无构建步骤，直接由 __ModuleLoader__ 装载）。
 *
 * 插件页两个标签：`pluginmarket-plus-cache`（插件源缓存）与 `pluginmarket-plus-updates`
 * （可更新）。缓存标签展示每个索引源的缓存状态，提供「刷新」「改刷新间隔」
 * 「让发现页使用本地缓存」等操作；「可更新」标签集中列出有更新的 bundle。
 * 所有数据都来自 Host 的 `/api/pluginmarket-plus/*`（经 connection 精确路由，
 * 只有 owner 浏览器能访问）。
 *
 * 约束：工厂函数无副作用；样式/字典/席位注册全部放进 apply 并用 ctx.effect 清理；
 * 只 require('react')，不 import 任何 @deepseek-ai Client 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-pluginmarket-plus',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 文案命名空间。 */
    const NS = 'pluginmarket-plus'
    /** 设置页 API 前缀。 */
    const API = '/api/pluginmarket-plus'
    /** 「可更新」页使用的桥接前缀（同源，仅 owner 浏览器可读）。 */
    const UPDATES_API = `${API}/updates`
    /** 注册进插件页的席位名。 */
    const UPDATES_SLOT = 'plugins.tab'
    /** 席位 id 与顺序（排在自带的 Installed / Discover 之后）。 */
    const UPDATES_ID = 'pluginmarket-plus-updates'
    const UPDATES_ORDER = 20
    /** 「插件源缓存」tab：排在 discover 之后、「可更新」之前。 */
    const CACHE_ID = 'pluginmarket-plus-cache'
    const CACHE_ORDER = 10
    /** 进度轮询间隔（毫秒）。 */
    const POLL_MS = 700
    /** 连续这么多次读不到进度就认定 Host 已退出/正在重启。 */
    const LOST_THRESHOLD = 3
    /** 空队列保护的有界轮询次数：前 8 次保留本地进度（约 5.6s），第 9 次判定队列已丢失。 */
    const EMPTY_QUEUE_LIMIT = 8

    const I18N = {
      zh: {
        cacheTab: '插件源缓存',
        intro: '把「插件 → 发现」读取的索引 JSON 缓存到本地磁盘，定时或手动刷新。在「发现 → 索引源」或本页增删索引源都会自动同步；开启下方开关后，发现页会改用本地镜像，搜索不再因上游索引超时而失败。',
        loading: '读取中…',
        failed: '读取失败：{error}',
        refreshAll: '全部刷新',
        refresh: '刷新',
        refreshing: '刷新中…',
        autoRefresh: '自动刷新',
        interval: '刷新间隔',
        hours: '{n} 小时',
        manageTitle: '让「发现」页使用本地缓存',
        manageOnHint: '已接管：发现页的索引源指向本机镜像，打开和搜索都是毫秒级。',
        manageOffHint: '未接管：发现页仍直接访问上游索引，慢或超时时会失败。',
        restore: '还原为上游地址',
        apply: '立即接管',
        sources: '索引源',
        addPlaceholder: '粘贴一个新的索引 JSON 地址（https://…/index.json）',
        add: '添加',
        remove: '移除',
        copy: '复制镜像地址',
        copied: '已复制',
        empty: '还没有索引源。插件会自动接管「发现」页已有的索引；也可以在上方手动添加。',
        statusOk: '缓存正常',
        statusStale: '缓存过期',
        statusEmpty: '尚未缓存',
        statusError: '刷新失败',
        meta: '{plugins} 个插件 · {size}',
        fetched: '更新于 {time}',
        never: '从未成功缓存',
        nextRefresh: '下次自动刷新：{time}',
        autoOff: '自动刷新已关闭',
        cacheDir: '缓存目录：{dir}',
        pluginMarketMissing: '当前没有挂载官方插件市场服务（plugin-market），只能缓存，无法接管发现页。',
        writableHint: '当前部署无法写回配置，修改只对本次运行生效。',
        unknownTitle: '未命名索引',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        hoursAgo: '{n} 小时前',
        daysAgo: '{n} 天前',
        marketIndexes: '发现页当前索引源',
        errorLabel: '错误',
        addFailed: '添加失败',
        saved: '已保存',
        refreshDone: '刷新完成',
        refreshFailed: '刷新失败：{error}',
        removal: '已移除',

        // ——「可更新」标签页 ——
        updatesTab: '可更新',
        updatesCheck: '检查更新',
        updatesChecking: '检查中…',
        updatesLastChecked: '上次检查 {time}',
        updatesNeverChecked: '尚未检查',
        updatesSummary: '可更新 {updates} 项 · 已选 {selected}',
        updatesSearchPlaceholder: '搜索包名…',
        updatesSettingsMenu: '设置',
        updatesShowFailed: '显示检查失败的项',
        updatesIncludePrerelease: '包含预发布/已废弃',
        updatesIncludeDisabled: '包含已禁用的插件',
        updatesUpdateAll: '更新全部',
        updatesUpdateSelected: '更新已选',
        updatesSelectAll: '全选',
        updatesCancel: '取消',
        updatesRowUpdate: '更新',
        updatesStateUpdatable: '可更新',
        updatesStateIncompatible: '不兼容',
        updatesStatePrerelease: '预发布',
        updatesStateDeprecated: '已废弃',
        updatesStateDisabled: '已禁用',
        updatesStateFailed: '检查失败',
        updatesStateExempted: '已豁免',
        updatesStateSkipped: '跳过',
        updatesStateCurrent: '无更新',
        updatesStateUncheckable: '无法检查',
        updatesUncheckableReasonIndexMiss: '本地索引中找不到该 Git 包可用的提交记录',
        updatesUncheckableReasonUnpinned: 'Git 包未固定 commit，无法检查更新',
        updatesUncheckableReasonOther: '暂时无法检查更新（原因未知）',
        updatesStateUnknown: '未检查',
        updatesSetsLocalOnly: '当前部署无法写回配置：开关只对本次运行生效。',
        updatesNeedCheck: '还没有检查过，请先点「检查更新」。',
        updatesRunningElsewhere: '另一个更新正在进行，请稍后再试。',
        updatesKindNpm: 'npm',
        updatesKindGit: 'git',
        updatesEmpty: '没有可更新的插件。点「检查更新」只看已安装且能自动更新的包（官方自带、link:/file:/别名、未固定 commit 的 git 都不显示）。',
        updatesEmptyFilter: '没有匹配当前搜索的条目。',
        updatesEmptyNoUpdate: '没有可更新的插件。',
        updatesEmptyShowFailed: '没有可更新的插件。可在设置里打开「显示检查失败的项」查看检查失败/无法检查的条目。',
        updatesUnknown: '未知',
        updatesLoading: '读取中…',
        updatesLoadFailed: '读取失败：{error}',
        updatesCheckFailed: '检查失败：{error}',
        updatesSettingsFailed: '保存设置失败：{error}',
        updatesUnknownVersion: '—',
        updatesExemptEntry: '版本豁免',
        updatesExemptFlow: '豁免此版本并更新',
        updatesExemptAck: '我知道风险：可能崩溃、数据丢失',
        updatesExemptIntro: '豁免只对本机生效，且精确到「包@版本 × DSH 版本」，插件或 DSH 升级后失效。',
        updatesExemptSubmit: '继续',
        updatesExemptConfirmTitle: '再次确认：豁免风险版本',
        updatesExemptConfirmBody: '将把 {pkg} 与运行中的 DSH {runtime} 标记为允许组合，然后立即更新到 {target}。不兼容的插件可能导致崩溃或数据丢失。',
        updatesExemptConfirmYes: '豁免并更新',
        updatesExemptDoing: '正在豁免…',
        updatesExemptFailed: '豁免失败：{error}',
        updatesConfirmTitle: '确认更新',
        updatesConfirmTitleBulk: '确认更新 {n} 项',
        updatesConfirmLeadSingle: '将更新下列插件：',
        updatesConfirmLeadBulk: '将按顺序依次更新下列 {n} 项（某项失败会继续下一项）：',
        updatesConfirmFrom: '当前版本',
        updatesConfirmTo: '目标版本',
        updatesConfirmSource: '安装来源',
        updatesConfirmRollback: '失败时会尝试装回当前版本；装回也失败则该包会处于未安装状态。',
        updatesConfirmQueue: '一次只跑一个更新；批量中可取消。',
        updatesConfirmNow: '开始更新',
        updatesConfirmClose: '关闭',
        updatesProgressTitle: '更新进度',
        updatesRunStateRunning: '更新进行中，点击查看更新进度',
        updatesRunStateDone: '更新完成，点击查看更新进度',
        updatesRunStateCount: '{done}/{total}',
        updatesProgressOf: '第 {index}/{total} 项',
        updatesStage: '阶段',
        updatesLogToggle: 'pnpm 日志',
        updatesLogEmpty: '暂无日志',
        updatesCancelQueue: '取消当前',
        updatesCancelling: '正在取消…',
        updatesCancelHint: '取消只作用于当前这一项，后续项会跳过。',
        updatesSummaryTitle: '更新结果',
        updatesSuccessItems: '成功 {n} 项',
        updatesFailedItems: '失败 {n} 项',
        updatesRestartItems: '需重启 {n} 项',
        updatesSkippedItems: '已跳过 {n} 项',
        updatesStages: '阶段记录：',
        updatesRestored: '已装回原版本',
        updatesRestoreIdle: '未发生回滚',
        updatesRestoreFailed: '回滚也失败了',
        updatesRestartRequired: '需要重启 DSH',
        updatesClose: '完成',
        updatesStartFailed: '更新未能开始：{error}',
        updatesAnotherRunning: '另一个更新正在进行，请稍后再试。',
        updatesStateLost: '进度状态读取失败（可重试）。',
        updatesHostLost: 'DSH 已退出或正在重启，请重新启动后继续。',
        updatesProgressReconciled: '更新已转由后台继续或已完成，进度视图已重置；请查看插件详情确认版本。',
        updatesProgressLost: '更新进度已丢失，请重新检查更新后再试。',
        updatesRestartNotice: '{n} 项已更新，重启 DSH 后生效。',
        updatesInterruptedTitle: '上次更新中断',
        updatesMissingFromProfile: '已从 profile 依赖中移除',
        updatesMissingFromProfileHint: '需要重新安装',
        updatesInterruptedLead: '{n} 项没装完。可以重新安装，或忽略这次记录。',
        updatesRecover: '重新安装',
        updatesRecovering: '正在重新安装…',
        updatesIgnore: '忽略',
        updatesRecovered: '已重新安装 {n} 项。',
        updatesRecoverPartial: '已重新安装 {ok} 项，{failed} 项失败（见下方原因）。',
        updatesRecoverItemFailed: '重新安装失败：{error}',
        updatesRecoverFailed: '恢复失败：{error}',
        updatesInterruptedCleared: '已忽略上次中断的更新记录。',
        updatesRecheck: '重新检查',
        stagePending: '等待',
        stageChecking: '检查',
        stageRemoving: '移除',
        stageInstalling: '安装',
        stageRestoring: '回滚',
        stageDone: '完成',
        stageFailed: '失败',
        stageRestart: '需重启',
        stageCancelled: '已取消',
        stageSkipped: '已跳过',
      },
      en: {
        cacheTab: 'Plugin source cache',
        intro: 'Caches the index JSON that Plugins → Discover reads, on local disk, refreshed on a schedule or on demand. Adding or removing a source in Discover → Index sources or on this page stays in sync; turn on the switch below to point Discover at the local mirror, so searches no longer fail on an upstream index timeout.',
        loading: 'Loading…',
        failed: 'Failed to load: {error}',
        refreshAll: 'Refresh all',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        autoRefresh: 'Auto refresh',
        interval: 'Interval',
        hours: '{n} h',
        manageTitle: 'Use the local cache in Discover',
        manageOnHint: 'Active: Discover index sources point at the local mirror, so opening and searching are instant.',
        manageOffHint: 'Inactive: Discover still fetches the upstream indexes and can time out.',
        restore: 'Restore upstream URLs',
        apply: 'Take over now',
        sources: 'Index sources',
        addPlaceholder: 'Paste an index JSON URL (https://…/index.json)',
        add: 'Add',
        remove: 'Remove',
        copy: 'Copy mirror URL',
        copied: 'Copied',
        empty: 'No index source yet. The plugin adopts the sources already configured in Discover; you can also add one above.',
        statusOk: 'Cached',
        statusStale: 'Stale',
        statusEmpty: 'Not cached',
        statusError: 'Refresh failed',
        meta: '{plugins} plugins · {size}',
        fetched: 'Updated {time}',
        never: 'Never cached successfully',
        nextRefresh: 'Next auto refresh: {time}',
        autoOff: 'Auto refresh is off',
        cacheDir: 'Cache directory: {dir}',
        pluginMarketMissing: 'The official plugin market service (plugin-market) is not mounted; caching works but Discover cannot be switched.',
        writableHint: 'This deployment cannot persist configuration; changes last for this run only.',
        unknownTitle: 'Untitled index',
        justNow: 'just now',
        minutesAgo: '{n} min ago',
        hoursAgo: '{n} h ago',
        daysAgo: '{n} d ago',
        marketIndexes: 'Index sources currently in Discover',
        errorLabel: 'Error',
        addFailed: 'Could not add',
        saved: 'Saved',
        refreshDone: 'Refresh complete',
        refreshFailed: 'Refresh failed: {error}',
        removal: 'Removed',

        // —— Updates tab ——
        updatesTab: 'Updates',
        updatesCheck: 'Check for updates',
        updatesChecking: 'Checking…',
        updatesLastChecked: 'Checked {time}',
        updatesNeverChecked: 'Not checked yet',
        updatesSummary: '{updates} updatable · {selected} selected',
        updatesSearchPlaceholder: 'Search package name…',
        updatesSettingsMenu: 'Settings',
        updatesShowFailed: 'Show failed checks',
        updatesIncludePrerelease: 'Include prerelease/deprecated',
        updatesIncludeDisabled: 'Include disabled plugins',
        updatesUpdateAll: 'Update all',
        updatesUpdateSelected: 'Update selected',
        updatesSelectAll: 'Select all',
        updatesCancel: 'Cancel',
        updatesRowUpdate: 'Update',
        updatesStateUpdatable: 'Updatable',
        updatesStateIncompatible: 'Incompatible',
        updatesStatePrerelease: 'Prerelease',
        updatesStateDeprecated: 'Deprecated',
        updatesStateDisabled: 'Disabled',
        updatesStateFailed: 'Check failed',
        updatesStateExempted: 'Exempted',
        updatesStateSkipped: 'Skipped',
        updatesStateCurrent: 'No update',
        updatesStateUncheckable: 'Cannot check',
        updatesUncheckableReasonIndexMiss: 'No usable commit for this Git bundle was found in the local index',
        updatesUncheckableReasonUnpinned: 'This Git bundle is not pinned to a commit, so updates cannot be checked',
        updatesUncheckableReasonOther: 'Cannot check for updates right now (reason unknown)',
        updatesStateUnknown: 'Not checked',
        updatesSetsLocalOnly: 'This deployment cannot persist configuration: the switches last for this run only.',
        updatesNeedCheck: 'Not checked yet — run "Check for updates" first.',
        updatesRunningElsewhere: 'Another update is already running; try again shortly.',
        updatesKindNpm: 'npm',
        updatesKindGit: 'git',
        updatesEmpty: 'Nothing to update. "Check for updates" only looks at installed bundles that can update automatically (official bundles, link:/file:/aliases, and git specs without a pinned commit are never listed).',
        updatesEmptyFilter: 'No entry matches the search.',
        updatesEmptyNoUpdate: 'Nothing to update.',
        updatesEmptyShowFailed: 'Nothing to update. Turn on "Show failed checks" in Settings to include failed or uncheckable entries.',
        updatesUnknown: 'unknown',
        updatesLoading: 'Loading…',
        updatesLoadFailed: 'Failed to load: {error}',
        updatesCheckFailed: 'Check failed: {error}',
        updatesSettingsFailed: 'Could not save settings: {error}',
        updatesUnknownVersion: '—',
        updatesExemptEntry: 'Version exemption',
        updatesExemptFlow: 'Exempt this version and update',
        updatesExemptAck: 'I accept the risk: crashes and data loss are possible',
        updatesExemptIntro: 'An exemption is local and exact — one package version on one DSH version; it does not survive upgrading either side.',
        updatesExemptSubmit: 'Continue',
        updatesExemptConfirmTitle: 'Confirm again: exempt a risky version',
        updatesExemptConfirmBody: 'This allows {pkg} on the running DSH {runtime} and then updates to {target} immediately. An incompatible plugin can crash the app or lose data.',
        updatesExemptConfirmYes: 'Exempt and update',
        updatesExemptDoing: 'Exempting…',
        updatesExemptFailed: 'Exemption failed: {error}',
        updatesConfirmTitle: 'Confirm update',
        updatesConfirmTitleBulk: 'Confirm {n} updates',
        updatesConfirmLeadSingle: 'The following plugin will be updated:',
        updatesConfirmLeadBulk: 'These {n} items run one after another (a failure continues with the next):',
        updatesConfirmFrom: 'Current',
        updatesConfirmTo: 'Target',
        updatesConfirmSource: 'Source',
        updatesConfirmRollback: 'A failure tries to reinstall the current version; if that also fails the package stays uninstalled.',
        updatesConfirmQueue: 'One update runs at a time; a batch can be cancelled.',
        updatesConfirmNow: 'Start update',
        updatesConfirmClose: 'Close',
        updatesProgressTitle: 'Update progress',
        updatesRunStateRunning: 'Updating — open update progress',
        updatesRunStateDone: 'Update finished — open update progress',
        updatesRunStateCount: '{done}/{total}',
        updatesProgressOf: 'Item {index}/{total}',
        updatesStage: 'Stage',
        updatesLogToggle: 'pnpm log',
        updatesLogEmpty: 'No log yet',
        updatesCancelQueue: 'Cancel current',
        updatesCancelling: 'Cancelling…',
        updatesCancelHint: 'Cancel affects only the current item; the remaining items are skipped.',
        updatesSummaryTitle: 'Result',
        updatesSuccessItems: '{n} succeeded',
        updatesFailedItems: '{n} failed',
        updatesRestartItems: '{n} need a restart',
        updatesSkippedItems: '{n} skipped',
        updatesStages: 'Stages:',
        updatesRestored: 'Current version reinstalled',
        updatesRestoreIdle: 'No rollback happened',
        updatesRestoreFailed: 'Rollback failed too',
        updatesRestartRequired: 'DSH restart required',
        updatesClose: 'Done',
        updatesStartFailed: 'The update did not start: {error}',
        updatesAnotherRunning: 'Another update is already running; try again shortly.',
        updatesStateLost: 'Could not read progress state (retryable).',
        updatesHostLost: 'DSH exited or is restarting. Restart it, then continue here.',
        updatesProgressReconciled: 'The update continued in the background or already finished. The progress view was reset; check the plugin details to confirm the version.',
        updatesProgressLost: 'Update progress was lost. Run "Check for updates" again.',
        updatesRestartNotice: '{n} updated. Restart DSH to apply.',
        updatesInterruptedTitle: 'Interrupted last time',
        updatesMissingFromProfile: 'Removed from profile dependencies',
        updatesMissingFromProfileHint: 'Reinstall required',
        updatesInterruptedLead: '{n} did not finish installing. Reinstall them, or ignore this record.',
        updatesRecover: 'Reinstall',
        updatesRecovering: 'Reinstalling…',
        updatesIgnore: 'Ignore',
        updatesRecovered: 'Reinstalled {n}.',
        updatesRecoverPartial: 'Reinstalled {ok}, {failed} failed (see reasons below).',
        updatesRecoverItemFailed: 'Reinstall failed: {error}',
        updatesRecoverFailed: 'Recovery failed: {error}',
        updatesInterruptedCleared: 'Ignored the interrupted update record.',
        updatesRecheck: 'Check again',
        stagePending: 'Queued',
        stageChecking: 'Checking',
        stageRemoving: 'Removing',
        stageInstalling: 'Installing',
        stageRestoring: 'Rolling back',
        stageDone: 'Done',
        stageFailed: 'Failed',
        stageRestart: 'Restart needed',
        stageCancelled: 'Cancelled',
        stageSkipped: 'Skipped',
      },
    }

    const CSS = [
      '.pmp-page{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);font:inherit}',
      // 插件页 tab 内：不设额外内边距/最大宽度（避免与设置页样式冲突）。
      '.pmp-tabPage{max-width:none;min-width:0;padding:0}',
      '.pmp-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.pmp-notice{display:flex;align-items:center;gap:8px;border-radius:var(--dsw-radius-md);padding:8px 10px;font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.pmp-notice[data-tone="ok"]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary)}',
      '.pmp-notice[data-tone="error"]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}',
      '.pmp-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.pmp-toolbarLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pmp-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.pmp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.pmp-btn:disabled{opacity:.45;cursor:default}',
      '.pmp-btnPrimary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color)}',
      '.pmp-btnPrimary:hover:not(:disabled){filter:brightness(1.06)}',
      '.pmp-btnDanger{color:var(--dsw-alias-state-error-primary)}',
      '.pmp-select{font:inherit;font-size:12px;height:26px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 6px}',
      '.pmp-card{display:flex;flex-direction:column;gap:8px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);padding:12px 14px}',
      '.pmp-cardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.pmp-cardTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}',
      '.pmp-url{margin:0;font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.pmp-meta{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.pmp-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;white-space:pre-wrap}',
      '.pmp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.pmp-badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:20px;font-weight:500;white-space:nowrap;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}',
      '.pmp-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}',
      '.pmp-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}',
      '.pmp-badge[data-tone="bad"]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}',
      '.pmp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
      '.pmp-switch{position:relative;width:34px;height:20px;flex:none;padding:0;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform);cursor:pointer;transition:background .15s}',
      '.pmp-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary);border-color:transparent}',
      '.pmp-switch:disabled{opacity:.45;cursor:default}',
      '.pmp-switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);box-shadow:0 1px 2px var(--dsw-alias-bg-mask-2);transition:transform .15s}',
      '.pmp-switch[aria-checked="true"] .pmp-switchKnob{transform:translateX(14px)}',
      '.pmp-switchRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pmp-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.pmp-addRow{display:flex;gap:8px;flex-wrap:wrap}',
      '.pmp-input{flex:1 1 320px;min-width:0;height:30px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 10px}',
      '.pmp-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}',
      '.pmp-sectionLabel{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.pmp-codes{margin:0;font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',

      // ——「可更新」标签页（.pmu-*） ——
      '.pmu-root{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font:inherit}',
      '.pmu-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '.pmu-title{margin:0;font-size:16px;font-weight:600;line-height:24px}',
      '.pmu-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pmu-search{flex:1 1 200px;min-width:140px;height:30px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 10px}',
      '.pmu-search:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}',
      '.pmu-checkBtn{flex:none}',
      '.pmu-gearBtn{position:relative;z-index:31;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;flex:none}',
      '.pmu-gear{display:block}',
      '.pmu-settingsWrap{flex:none}',
      '.pmu-switchLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:0;padding:0}',
      '.pmu-filterWrap{position:relative;display:inline-flex}',
      // 遮罩与菜单是 filterWrap 下的兄弟节点：菜单以 filterWrap（position:relative）为包含块，
      // 不会再像挂在全屏 fixed 遮罩下那样被定位到视口下方。
      '.pmu-menuLayer{position:fixed;inset:0;z-index:30}',
      '.pmu-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:41;display:flex;flex-direction:column;gap:8px;min-width:220px;max-width:min(320px,92vw);max-height:min(70vh,360px);overflow:auto;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px var(--dsw-alias-bg-mask-3)}',
      '.pmu-menu[data-placement="top"][data-anchored="css"]{top:auto;bottom:calc(100% + 6px)}',
      '.pmu-menuRow{display:flex;align-items:center;gap:8px}',
      '.pmu-notice{margin:0;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-md);padding:8px 10px;overflow-wrap:anywhere}',
      '.pmu-notice[data-tone="ok"]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary)}',
      '.pmu-notice[data-tone="error"]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}',
      '.pmu-notice[data-tone="warn"]{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.pmu-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;white-space:pre-wrap}',
      '.pmu-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.pmu-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}',
      '.pmu-summaryText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.pmu-summaryActions{margin-left:auto;display:flex;align-items:center;gap:8px}',
      '.pmu-summaryTime{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      // 工具条右侧的「更新状态」区域：更新中转圈、结束后绿色对勾；点击打开进度弹窗。
      '.pmu-runState{display:inline-flex;align-items:center;gap:6px;flex:none;height:30px;padding:0 10px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.pmu-runState:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.pmu-runState:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}',
      '.pmu-runIcon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none;border-radius:999px}',
      '.pmu-runState[data-state="running"] .pmu-runIcon{border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);animation:pmu-spin .9s linear infinite}',
      '.pmu-runState[data-state="done"] .pmu-runIcon{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-on-color)}',
      '.pmu-runCheck{display:block}',
      '.pmu-runText{font-variant-numeric:tabular-nums}',
      '@keyframes pmu-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.pmu-runState[data-state="running"] .pmu-runIcon{animation:none;border-top-color:var(--dsw-alias-border-l3);border-left-color:var(--dsw-alias-state-business-primary)}}',
      '.pmu-progressModal{max-width:640px}',
      // 「上次更新中断」区块：列表上方，逐项一行。
      '.pmu-interrupted{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.pmu-interruptedHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pmu-interruptedRow{display:grid;grid-template-columns:minmax(0,1fr) 148px 56px minmax(0,auto) minmax(0,auto) minmax(112px,auto);column-gap:10px;align-items:center;min-width:0;padding-top:8px;border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.pmu-missingHint{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}',
      '.pmu-interruptedName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:600}',
      '@media (max-width:720px){.pmu-interruptedRow{grid-template-columns:minmax(0,1fr) 120px 48px minmax(0,auto) minmax(96px,auto);column-gap:6px}}',
      '.pmu-list{display:flex;flex-direction:column;gap:6px}',
      '.pmu-row{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.pmu-row[data-tone="bad"]{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}',
      '.pmu-row[data-busy="true"]{border-color:var(--dsw-alias-border-selected)}',
      // 行主区：共享列宽的 CSS Grid（所有行共用同一模板 → 来源/版本/状态/操作列垂直对齐）。
      // 列顺序：复选框 | 插件名(吃剩余空间) | 更新来源 | 版本变动 | 弹性空隙 | 已禁用 | 主状态 | 操作
      '.pmu-rowMain{display:grid;grid-template-columns:auto minmax(0,1fr) 56px 148px minmax(8px,0.4fr) 56px 92px minmax(112px,auto);column-gap:10px;row-gap:6px;align-items:center;min-width:0}',
      '.pmu-check{grid-column:1;width:14px;height:14px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.pmu-check:disabled{opacity:.45;cursor:default}',
      '.pmu-nameCell{grid-column:2;min-width:0;max-width:100%;overflow:hidden}',
      '.pmu-name{display:block;max-width:100%;min-width:0;font-size:13px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pmu-nameLink{display:block;max-width:100%;min-width:0;appearance:none;font:inherit;font-size:13px;line-height:20px;font-weight:600;text-align:left;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pmu-nameLink:hover{text-decoration:underline}',
      '.pmu-nameLink:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-radius:var(--dsw-radius-xs)}',
      '.pmu-kindBadge{grid-column:3;justify-self:start}',
      '.pmu-versions{grid-column:4;justify-self:start;font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.pmu-arrow{color:var(--dsw-alias-label-tertiary);padding:0 4px}',
      '.pmu-spacer{grid-column:5;min-width:0}',
      '.pmu-disabledBadge{grid-column:6;justify-self:start;white-space:nowrap}',
      '.pmu-statusBadge{grid-column:7;justify-self:start;min-width:0;white-space:nowrap}',
      '.pmu-rowActions{grid-column:8;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;min-width:0;max-width:100%;justify-self:end}',
      // 窄屏收紧固定轨道并隐藏弹性空隙，避免整行横向滚动/重叠。
      '@media (max-width:720px){.pmu-rowMain{grid-template-columns:auto minmax(0,1fr) 48px 120px minmax(6px,0.2fr) 48px 84px minmax(96px,auto);column-gap:6px}}',
      '@media (max-width:560px){.pmu-rowMain{grid-template-columns:auto minmax(0,1fr) 44px 104px 0 44px 76px minmax(84px,auto);column-gap:4px}.pmu-spacer{display:none}}',
      '@media (max-width:420px){.pmu-rowMain{grid-template-columns:auto minmax(0,1fr) 40px 84px 0 40px 64px minmax(64px,auto);column-gap:3px}}',
      '.pmu-detail{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px}',
      '.pmu-log{max-height:180px;overflow:auto;margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.pmu-selectAll{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pmu-link{font:inherit;font-size:12px;line-height:18px;padding:0;border:0;background:transparent;color:var(--dsw-alias-link);cursor:pointer;text-decoration:underline}',
      '.pmu-modalLayer{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1)}',
      '.pmu-modal{display:flex;flex-direction:column;gap:10px;width:100%;max-width:520px;max-height:80vh;overflow:auto;padding:16px 18px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px var(--dsw-alias-bg-mask-3)}',
      '.pmu-modalTitle{margin:0;font-size:14px;font-weight:600;line-height:22px}',
      '.pmu-modalBody{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.pmu-modalActions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px}',
      '.pmu-confirmRow{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:4px 10px;font-size:12px;line-height:18px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      '.pmu-confirmKey{color:var(--dsw-alias-label-tertiary)}',
      '.pmu-confirmValue{overflow-wrap:anywhere}',
      '.pmu-ack{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.pmu-progressHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pmu-progressItem{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}',
      '.pmu-progressItem[data-current="true"]{border-color:var(--dsw-alias-border-selected)}',
      '.pmu-progressTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.pmu-progressName{font-size:12px;line-height:18px;font-weight:600;overflow-wrap:anywhere}',
      '.pmu-progressText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.pmu-progressActions{margin-left:auto}',
      '.pmu-summaryList{margin:0;padding-left:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.pmu-textarea{width:100%;min-height:56px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:6px 8px;resize:vertical}',
      '.pmu-textarea:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}',
    ].join('\n')

    /**
     * 工厂级兜底翻译（宿主未注入 `t` 时用；语言切换仍由宿主重渲染驱动）。
     * @param {string} key - 文案键。
     * @param {object} [params] - 插值参数。
     * @returns {string} 文案。
     */
    function fallbackT(key, params) {
      const dict = I18N.zh ?? {}
      let out = typeof dict[key] === 'string' ? dict[key] : key
      if (params !== null && typeof params === 'object') {
        for (const name of Object.keys(params)) out = out.split(`{${name}}`).join(String(params[name]))
      }
      return out
    }

    /**
     * 拼出本插件 API 的同源地址。
     * @param {string} path - 以 `/` 开头的子路径，例如 `/updates`。
     * @returns {string} 绝对路径。
     */
    function api(path) {
      const suffix = typeof path === 'string' && path.startsWith('/') ? path : `/${String(path ?? '')}`
      if (suffix === API || suffix.startsWith(`${API}/`)) return suffix
      if (suffix.startsWith('/api/')) return `${API}/status`
      return `${API}${suffix}`
    }

    /**
     * 字节数展示。
     * @param {number|null|undefined} value - 字节数。
     * @returns {string} 展示文本。
     */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      const units = ['B', 'KB', 'MB', 'GB']
      let size = value
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
    }

    /**
     * 相对时间展示。
     * @param {number|null|undefined} timestamp - Unix 毫秒。
     * @param {(key: string, params?: object) => string} t - 翻译函数。
     * @returns {string} 展示文本。
     */
    function formatAge(timestamp, t) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return t('never')
      const diff = Math.max(0, Date.now() - timestamp)
      const minutes = Math.floor(diff / 60_000)
      if (minutes < 1) return t('justNow')
      if (minutes < 60) return t('minutesAgo', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('hoursAgo', { n: hours })
      return t('daysAgo', { n: Math.floor(hours / 24) })
    }

    /**
     * 本地时间点展示。
     * @param {number|null|undefined} timestamp - Unix 毫秒。
     * @returns {string} 展示文本。
     */
    function formatClock(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      try {
        return new Date(timestamp).toLocaleString()
      } catch {
        return new Date(timestamp).toISOString()
      }
    }

    /**
     * 计算「筛选」菜单落点：默认贴按钮下方，下方放不下就向上换向；水平方向贴边不出视口。
     * @param {{left?: number, right?: number, top?: number, bottom?: number}} anchor - 按钮矩形。
     * @param {{width?: number, height?: number}} viewport - 视口尺寸。
     * @param {{width?: number, height?: number}} menu - 菜单尺寸。
     * @param {number} [gap] - 与按钮的间距。
     * @returns {{left: number, top: number, placement: 'bottom'|'top'}} 落点。
     */
    function menuPlacement(anchor, viewport, menu, gap = 6) {
      const margin = 8
      const viewportWidth = num(viewport?.width, 0)
      const viewportHeight = num(viewport?.height, 0)
      const menuWidth = num(menu?.width, 0)
      const menuHeight = num(menu?.height, 0)
      const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin)
      const left = Math.max(margin, Math.min(num(anchor?.left, 0), maxLeft))
      const below = num(anchor?.bottom, 0) + gap
      const above = num(anchor?.top, 0) - gap - menuHeight
      const fitsBelow = viewportHeight === 0 || below + menuHeight <= viewportHeight - margin
      const placement = fitsBelow || above < margin ? 'bottom' : 'top'
      return { left, top: placement === 'bottom' ? below : above, placement }
    }

    /**
     * 量出「筛选」菜单的落点（真实浏览器）；拿不到布局信息时返回 null，退化为纯 CSS 定位。
     * @param {object} node - filterWrap 元素。
     * @returns {{left: number, top: number, placement: 'bottom'|'top'}|null} 落点。
     */
    function measureMenuPlacement(node) {
      try {
        if (typeof node?.getBoundingClientRect !== 'function') return null
        const rect = node.getBoundingClientRect()
        if (!(rect.width > 0)) return null
        const viewport = {
          width: typeof window === 'undefined' ? 0 : num(window.innerWidth, 0),
          height: typeof window === 'undefined' ? 0 : num(window.innerHeight, 0),
        }
        // 菜单尺寸用声明的上下限估算（min-width 220 / max-width min(320px,92vw)、两行 + 内边距）。
        const menu = { width: 240, height: 108 }
        return menuPlacement(rect, viewport, menu)
      } catch {
        return null
      }
    }

    /**
     * 只显示时分的本地时间（头部「上次检查 HH:MM」）。
     * @param {number|null|undefined} timestamp - Unix 毫秒。
     * @returns {string} 展示文本。
     */
    function formatTimeOnly(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      try {
        return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch {
        return new Date(timestamp).toISOString().slice(11, 16)
      }
    }

    /**
     * 索引源缓存状态徽标（与「可更新」的行状态徽标同名会互相覆盖，故加 Source 前缀）。
     * @param {{state: string, t: Function}} props - 源状态与翻译函数。
     * @returns {object} React 元素。
     */
    function SourceStatusBadge({ state, t }) {
      const tone = state === 'ok' ? 'ok' : state === 'stale' ? 'warn' : state === 'error' ? 'bad' : 'idle'
      const label = state === 'ok' ? t('statusOk') : state === 'stale' ? t('statusStale') : state === 'error' ? t('statusError') : t('statusEmpty')
      return h('span', { className: 'pmp-badge', 'data-tone': tone },
        h('span', { className: 'pmp-dot' }), label)
    }

    /**
     * iOS 风格开关。
     * @param {{checked: boolean, disabled?: boolean, label: string, onChange: (next: boolean) => void}} props - 开关属性。
     * @returns {object} React 元素。
     */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: 'pmp-switch',
        disabled: disabled === true,
        onClick: () => { onChange(!checked) },
      }, h('span', { className: 'pmp-switchKnob' }))
    }

    /**
     * 设置页主体。
     * @param {{t?: Function}} props - 宿主注入属性。
     * @returns {object} React 元素。
     */
    function MarketCacheSection(props) {
      const t = props.t ?? ((key) => key)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const alive = React.useRef(true)

      const load = React.useCallback(async (skipResume) => {
        try {
          const response = await fetch(`${API}/status`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (!alive.current) return
          setData(payload)
          setError(null)
        } catch (failure) {
          if (!alive.current) return
          setError(String(failure?.message ?? failure))
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => { void load() }, 15_000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      /**
       * 发一个 POST 请求并把返回的状态写回页面。
       * @param {string} path - API 子路径。
       * @param {object} [body] - JSON 请求体。
       * @returns {Promise<void>} 完成。
       */
      const post = React.useCallback(async (path, body) => {
        setBusy(path)
        setNotice(null)
        try {
          const response = await fetch(`${API}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok === false) throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`)
          if (payload.status) setData(payload.status)
          return payload
        } catch (failure) {
          setNotice({ tone: 'error', text: String(failure?.message ?? failure) })
          throw failure
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      if (data === null && error === null) return h('p', { className: 'pmp-hint' }, t('loading'))
      if (data === null) return h('p', { className: 'pmp-error' }, t('failed', { error: error }))

      const sources = Array.isArray(data.sources) ? data.sources : []
      const config = data.config ?? {}
      const market = data.pluginMarket ?? {}
      const disabled = data.writable === false

      /**
       * @param {number} hours - 新间隔。
       * @returns {void}
       */
      const changeInterval = (hours) => {
        void post('/settings', { refreshIntervalHours: hours }).catch(() => {})
      }

      /**
       * @param {string} url - 要刷新的源。
       * @returns {void}
       */
      const refreshOne = (url) => {
        void post('/refresh', { url }).then(() => setNotice({ tone: 'ok', text: t('refreshDone') })).catch(() => {})
      }

      /**
       * @returns {void}
       */
      const refreshAll = () => {
        void post('/refresh', {}).then(() => setNotice({ tone: 'ok', text: t('refreshDone') })).catch(() => {})
      }

      /**
       * @param {string} url - 要移除的源。
       * @returns {void}
       */
      const remove = (url) => {
        const next = sources.map(item => item.url).filter(item => item !== url)
        void post('/settings', { sources: next }).then(() => setNotice({ tone: 'ok', text: t('removal') })).catch(() => {})
      }

      /**
       * @returns {void}
       */
      const add = () => {
        const text = draft.trim()
        if (text === '') return
        const next = [...sources.map(item => item.url), text]
        void post('/settings', { sources: next }).then(() => { setDraft(''); setNotice({ tone: 'ok', text: t('saved') }) }).catch(() => {})
      }

      /**
       * @param {string} text - 复制到剪贴板的文本。
       * @returns {void}
       */
      const copy = (text) => {
        try {
          if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(text).then(
              () => { setNotice({ tone: 'ok', text: t('copied') }) },
              () => {},
            )
          }
        } catch {
          // 剪贴板不可用时静默；用户仍可手动选中地址。
        }
      }

      // 作为 plugins.tab 的内容：tab 标签已是「插件源缓存」，这里不再重复标题。
      return h('div', { className: 'pmp-page pmp-tabPage' },
        h('p', { className: 'pmp-intro' }, t('intro')),

        notice !== null && h('p', { className: 'pmp-notice', 'data-tone': notice.tone }, notice.text),
        error !== null && h('p', { className: 'pmp-error' }, error),

        h('div', { className: 'pmp-toolbar' },
          h('button', { type: 'button', className: 'pmp-btn pmp-btnPrimary', disabled: busy !== '' || sources.length === 0, onClick: refreshAll }, busy === '/refresh' ? t('refreshing') : t('refreshAll')),
          h('span', { className: 'pmp-toolbarLabel' }, t('autoRefresh')),
          h(Switch, {
            checked: config.autoRefresh !== false,
            disabled,
            label: t('autoRefresh'),
            onChange: (next) => { void post('/settings', { autoRefresh: next }).catch(() => {}) },
          }),
          h('span', { className: 'pmp-toolbarLabel' }, t('interval')),
          h('select', {
            className: 'pmp-select',
            value: String(config.refreshIntervalHours ?? 4),
            disabled,
            onChange: (event) => { changeInterval(Number(event.target.value)) },
          }, [1, 2, 4, 6, 8, 12, 24].map(hours => h('option', { key: hours, value: String(hours) }, t('hours', { n: hours })))),
          h('span', { className: 'pmp-hint' }, config.autoRefresh === false ? t('autoOff') : t('nextRefresh', { time: formatClock(data.nextRefreshAt) })),
        ),

        h('div', { className: 'pmp-card' },
          h('div', { className: 'pmp-switchRow' },
            h(Switch, {
              checked: market.managed === true,
              disabled: disabled || market.available !== true,
              label: t('manageTitle'),
              onChange: (next) => { void post('/market', { action: next ? 'apply' : 'restore' }).catch(() => {}) },
            }),
            h('h3', { className: 'pmp-cardTitle' }, t('manageTitle')),
          ),
          h('p', { className: 'pmp-hint' }, market.available !== true ? t('pluginMarketMissing') : market.managed === true ? t('manageOnHint') : t('manageOffHint')),
          market.available === true && h('p', { className: 'pmp-codes' }, t('marketIndexes') + '：' + (Array.isArray(market.indexes) && market.indexes.length > 0 ? market.indexes.join('  ·  ') : '—')),
          market.error && h('p', { className: 'pmp-error' }, `${t('errorLabel')}: ${market.error}`),
          market.managed === true && h('div', { className: 'pmp-actions' },
            h('button', { type: 'button', className: 'pmp-btn', disabled: busy !== '', onClick: () => { void post('/market', { action: 'restore' }).catch(() => {}) } }, t('restore')),
          ),
        ),

        h('h3', { className: 'pmp-sectionLabel' }, t('sources')),

        sources.length === 0 && h('p', { className: 'pmp-hint' }, t('empty')),

        sources.map((source) => h('div', { className: 'pmp-card', key: source.id },
          h('div', { className: 'pmp-cardHead' },
            h('h3', { className: 'pmp-cardTitle' }, source.title || t('unknownTitle')),
            h(SourceStatusBadge, { state: source.state, t }),
            source.refreshing === true && h('span', { className: 'pmp-badge' }, t('refreshing')),
          ),
          h('p', { className: 'pmp-url' }, source.url),
          h('p', { className: 'pmp-meta' },
            source.bytes === null || source.bytes === undefined
              ? t('never')
              : `${t('meta', { plugins: source.plugins ?? 0, size: formatBytes(source.bytes) })} · ${t('fetched', { time: formatAge(source.fetchedAt, t) })}`),
          source.error && h('p', { className: 'pmp-error' }, `${t('errorLabel')}: ${source.error}`),
          h('div', { className: 'pmp-actions' },
            h('button', { type: 'button', className: 'pmp-btn', disabled: busy !== '', onClick: () => { refreshOne(source.url) } }, busy === '/refresh' ? t('refreshing') : t('refresh')),
            source.mirrorUrl && h('button', { type: 'button', className: 'pmp-btn', onClick: () => { copy(source.mirrorUrl) } }, t('copy')),
            h('button', { type: 'button', className: 'pmp-btn pmp-btnDanger', disabled: busy !== '', onClick: () => { remove(source.url) } }, t('remove')),
          ),
        )),

        h('div', { className: 'pmp-addRow' },
          h('input', {
            className: 'pmp-input',
            value: draft,
            placeholder: t('addPlaceholder'),
            onChange: (event) => { setDraft(event.target.value) },
            onKeyDown: (event) => { if (event.key === 'Enter') add() },
          }),
          h('button', { type: 'button', className: 'pmp-btn', disabled: busy !== '' || draft.trim() === '', onClick: add }, t('add')),
        ),

        h('p', { className: 'pmp-hint' }, t('cacheDir', { dir: data.cacheDir ?? '—' })),
        data.writable === false && h('p', { className: 'pmp-hint' }, t('writableHint')),
      )
    }

    /** 进度阶段（Host 桥的 stage 取值）→ 文案键。自检脚本会读它校验覆盖。 */
    const PROGRESS_STAGES = {
      pending: 'stagePending',
      waiting: 'stagePending',
      queued: 'stagePending',
      checking: 'stageChecking',
      checking_compatibility: 'stageChecking',
      removing: 'stageRemoving',
      installing: 'stageInstalling',
      restoring: 'stageRestoring',
      restore: 'stageRestoring',
      restoring_previous: 'stageRestoring',
      done: 'stageDone',
      finished: 'stageDone',
      success: 'stageDone',
      failed: 'stageFailed',
      error: 'stageFailed',
      restart: 'stageRestart',
      restart_required: 'stageRestart',
      cancelled: 'stageCancelled',
      canceled: 'stageCancelled',
      skipped: 'stageSkipped',
    }

    /** 状态徽标文案键（按优先级从高到低）。 */
    const STATUS_LABEL_KEYS = {
      incompatible: 'updatesStateIncompatible',
      failed: 'updatesStateFailed',
      skipped: 'updatesStateSkipped',
      current: 'updatesStateCurrent',
      uncheckable: 'updatesStateUncheckable',
      unknown: 'updatesStateUnknown',
      deprecated: 'updatesStateDeprecated',
      prerelease: 'updatesStatePrerelease',
      updatable: 'updatesStateUpdatable',
      exempted: 'updatesStateExempted',
    }

    /** 状态徽标配色。 */
    const STATUS_TONES = {
      updatable: 'ok',
      exempted: 'ok',
      incompatible: 'bad',
      failed: 'bad',
      skipped: 'warn',
      uncheckable: 'warn',
      current: 'idle',
      unknown: 'idle',
      deprecated: 'warn',
      prerelease: 'warn',
    }

    /** 过滤键 → 文案键。 */
    /** 齿轮（设置）图标 path（Feather settings，24×24 视框）。 */
    const GEAR_PATH = 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z'

    /**
     * 自检脚本读取的纯逻辑/常量出口（不参与运行时行为）。
     * @returns {object} 常量集合。
     */
    function inspectable() {
      return {
        namespace: NS,
        updatesApi: UPDATES_API,
        slot: UPDATES_SLOT,
        id: UPDATES_ID,
        order: UPDATES_ORDER,
        stages: PROGRESS_STAGES,
        statusLabels: STATUS_LABEL_KEYS,
        statusTones: STATUS_TONES,
        scopeStates: SCOPE_STATES,
        failedScopeStates: FAILED_SCOPE_STATES,
        inScope,
        dict: I18N,
        css: CSS,
        requirementLines,
        incompatibilityOf,
        readProgress,
        progressTerminal,
        restoreText,
        statusOf,
        uncheckableReasonText,
        menuPlacement,
        readSettings,
        mergeSettings,
        nextPollFailure,
        progressTally,
        nextEmptyQueueVerdict,
        emptyQueueLimit: EMPTY_QUEUE_LIMIT,
        readInterrupted,
        readRecoverResults,
        lostThreshold: LOST_THRESHOLD,
      }
    }

    /**
     * 安全取字符串。
     * @param {unknown} value - 原始值。
     * @param {string} [fallback] - 兜底。
     * @returns {string} 字符串。
     */
    function text(value, fallback = '') {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return fallback
    }

    /**
     * 安全取数字。
     * @param {unknown} value - 原始值。
     * @param {number} [fallback] - 兜底。
     * @returns {number} 数字。
     */
    function num(value, fallback = 0) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) return parsed
      }
      return fallback
    }

    /**
     * 安全取布尔。
     * @param {unknown} value - 原始值。
     * @returns {boolean} 布尔。
     */
    function bool(value) {
      return value === true || value === 'true'
    }

    /**
     * 安全取数组。
     * @param {unknown} value - 原始值。
     * @returns {Array} 数组。
     */
    function list(value) {
      return Array.isArray(value) ? value : []
    }

    /**
     * 安全取对象。
     * @param {unknown} value - 原始值。
     * @returns {object} 对象。
     */
    function rec(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    /**
     * 行/豁免的稳定键：包名 + 目标版本。
     * @param {string} name - 包名。
     * @param {string} latest - 目标版本。
     * @returns {string} 键。
     */
    function cellKey(name, latest) {
      return `${name}@${latest === '' ? '?' : latest}`
    }

    /**
     * 判断目标版本是否预发布（SemVer 的 `-` 段）。
     * @param {string} version - 版本号。
     * @returns {boolean} 是否预发布。
     */
    function isPrereleaseVersion(version) {
      if (typeof version !== 'string' || version === '') return false
      return version.split('+')[0].includes('-')
    }

    /**
     * 从 package.json 风格的 peer 依赖里摘出 DSH 条目。
     * @param {object} manifest - manifest 片段。
     * @returns {Array<{name: string, range: string}>} DSH 相关依赖。
     */
    function dshPeers(manifest) {
      const merged = Object.assign({}, rec(manifest.peerDependencies), rec(manifest.peerDependenciesMeta))
      const out = []
      for (const name of Object.keys(merged)) {
        if (!name.startsWith('@deepseek-ai/dsh')) continue
        const value = merged[name]
        const range = typeof value === 'string' ? value : text(rec(value).range)
        out.push({ name, range: range === '' ? '—' : range })
      }
      return out
    }

    /** 旧结构里由专门分支处理的键（不当成「要求名 → 范围」）。 */
    const REQUIREMENT_STRUCTURED_KEYS = new Set(['dsh', 'enginesDsh', 'required', 'manifest', 'missing'])

    /**
     * 把 Host 的 `incompatible` 归一成 `{runtimeVersion, requirements}`。
     *
     * 真实契约（DSH `evaluatePluginCompatibility` → `incompatiblePlugin`）给的是对象：
     * `{name, version, runtimeVersion, requirements: {'engines.dsh': '>=x'}}`，不是布尔。
     * 优先认显式归一字段 `incompatibility` / `incompatibleInfo`，其余形态（布尔、字符串）兜底。
     * @param {object} info - 一条候选信息。
     * @returns {{runtimeVersion: string, requirements: object, version: string}|null} 归一结果。
     */
    function incompatibilityOf(info) {
      const source = rec(info)
      const explicit = rec(source.incompatibility ?? source.incompatibleInfo)
      if (Object.keys(explicit).length > 0) {
        return {
          runtimeVersion: text(explicit.runtimeVersion) || text(source.runtimeVersion),
          requirements: rec(explicit.requirements),
          version: text(explicit.version),
        }
      }
      const raw = source.incompatible
      if (raw === true) return { runtimeVersion: text(source.runtimeVersion), requirements: {}, version: '' }
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const payload = rec(raw)
        if (Object.keys(payload).length === 0) return null
        return {
          runtimeVersion: text(payload.runtimeVersion) || text(source.runtimeVersion),
          requirements: rec(payload.requirements),
          version: text(payload.version),
        }
      }
      if (text(raw) === 'true') return { runtimeVersion: text(source.runtimeVersion), requirements: {}, version: '' }
      return null
    }

    /**
     * 目标版本不满足项展示文本（逐行）。
     *
     * 真实契约的 `requirements` 是「要求名 → 范围」的扁平记录
     * （如 `{'engines.dsh': '>=0.4.0 <0.5.0'}`），这里逐项输出 `key range`；
     * 同时兼容早期结构的 `{dsh, required, manifest, missing}`。空/缺省时不产出任何行。
     * @param {object} incompatibility - 目标版本的不兼容信息。
     * @returns {string[]} 逐行文本。
     */
    function requirementLines(incompatibility) {
      const lines = []
      const requirement = rec(rec(incompatibility).requirements)
      for (const [key, value] of Object.entries(requirement)) {
        if (REQUIREMENT_STRUCTURED_KEYS.has(key)) continue
        const raw = typeof value === 'string' ? value : (typeof value === 'number' ? String(value) : text(rec(value).range))
        const range = text(raw)
        lines.push(range === '' ? key : `${key} ${range}`)
      }
      const engine = text(requirement.dsh) || text(requirement.enginesDsh)
      if (engine !== '') lines.push(`engines.dsh ${engine}`)
      const required = requirement.required
      if (typeof required === 'string' && required !== '') lines.push(required)
      if (Array.isArray(required)) {
        for (const entry of required) {
          const item = rec(entry)
          const name = text(item.name) || text(entry)
          if (name === '') continue
          const range = text(item.range)
          lines.push(range === '' ? name : `${name} ${range}`)
        }
      }
      for (const peer of dshPeers(rec(requirement.manifest))) lines.push(`${peer.name} ${peer.range}`)
      for (const item of list(requirement.missing)) {
        const value = text(item)
        if (value !== '') lines.push(value)
      }
      return [...new Set(lines)]
    }

    /**
     * 阶段文案。
     * @param {string} stage - 阶段值。
     * @param {(key: string, params?: object) => string} t - 翻译函数。
     * @returns {string} 文案。
     */
    function stageLabel(stage, t) {
      const key = PROGRESS_STAGES[text(stage)]
      return typeof key === 'string' ? t(key) : text(stage, t('updatesUnknown'))
    }

    /**
     * 从桥接信息里推断展示状态。
     * @param {object} info - 一条候选信息。
     * @returns {string} 状态键。
     */
    function rowState(info) {
      const raw = text(info.state)
      // Host 桥的权威取值：available|skipped|current|uncheckable|unknown|error
      if (raw === 'available') return 'updatable'
      if (raw === 'skipped' || raw === 'current' || raw === 'unknown') return raw
      if (raw === 'uncheckable') return 'uncheckable'
      if (raw === 'error' || raw === 'check-failed' || raw === 'check_failed' || raw === 'failed') return 'failed'
      if (raw === 'incompatible' || raw === 'updatable' || raw === 'prerelease' || raw === 'deprecated' || raw === 'disabled') return raw
      if (info.checkable === false || text(info.checkError) !== '' || text(info.error) !== '') return info.checkable === false ? 'uncheckable' : 'failed'
      if (incompatibilityOf(info) !== null) return 'incompatible'
      if (info.deprecated === true || text(info.deprecated) !== '') return 'deprecated'
      if (info.prerelease === true || isPrereleaseVersion(text(info.latest))) return 'prerelease'
      if (info.enabled === false) return 'disabled'
      return 'updatable'
    }

    /**
     * 把 Host 桥返回的一条候选归一成渲染用的行。
     * @param {object} raw - 原始条目。
     * @param {number} index - 下标（兜底 key）。
     * @returns {object|null} 行；缺少包名时返回 null。
     */
    function toRow(raw, index) {
      const info = rec(raw)
      const name = text(info.name) || text(info.packageName) || text(info.package)
      if (name === '') return null
      // 真实契约：listVersions().incompatible 是 {name,version,runtimeVersion,requirements}。
      const incompatibility = incompatibilityOf(info)
      const latest = text(info.latest) || text(info.targetVersion) || text(info.latestVersion) || text(info.to)
        || text(incompatibility?.version)
      const current = text(info.current) || text(info.currentVersion) || text(info.version) || text(info.from)
      const deprecatedReason = text(info.deprecated)
      // 来源内部统一用 'npm'：Host 新契约给 'npm'，旧数据可能仍是 'registry'，都归一为 'npm'。
      const rawKind = text(info.kind)
      const kind = rawKind === 'git' ? 'git' : (rawKind === 'npm' || rawKind === 'registry' ? 'npm' : '')
      return {
        key: cellKey(name, latest),
        name,
        current,
        latest,
        kind,
        state: rowState(info),
        enabled: info.enabled !== false,
        spec: text(info.spec),
        registry: text(info.registry),
        repository: text(info.repository),
        location: text(info.location) || text(info.origin),
        directory: text(info.directory),
        commit: text(info.commit),
        incompatible: incompatibility !== null || text(info.state) === 'incompatible',
        incompatibility,
        prerelease: info.prerelease === true || isPrereleaseVersion(latest),
        deprecated: info.deprecated === true || deprecatedReason !== '',
        deprecatedReason,
        reason: text(info.reason),
        checkError: text(info.checkError) || text(info.error),
        restore: null,
        restartRequired: false,
        log: '',
      }
    }

    /**
     * 行是否可在「更新全部 / 全选」里被自动勾选（严格按当前两个开关）。
     * skipped（目标预发布/已废弃而开关关着）默认不勾选；incompatible / uncheckable /
     * current / unknown / error 一律不自动勾选。
     * @param {object} row - 行。
     * @param {{includeDisabled: boolean, includePrerelease: boolean}} settings - 当前开关。
     * @returns {boolean} 是否可自动勾选。
     */
    function autoSelectable(row, settings) {
      if (row.latest === '') return false
      if (row.incompatible === true) return false
      switch (row.state) {
        case 'updatable': return true
        case 'skipped': return settings.includePrerelease === true
        case 'prerelease':
        case 'deprecated': return settings.includePrerelease === true
        case 'disabled': return settings.includeDisabled === true
        default: return false
      }
    }

    /**
     * 不兼容行是否可以先豁免再更新（无法检查/无更新/检查失败的不行）。
     * @param {object} row - 行。
     * @returns {boolean} 是否可走豁免流程。
     */
    function canExempt(row) {
      if (row.incompatible !== true || row.latest === '') return false
      return !['uncheckable', 'current', 'unknown', 'failed'].includes(row.state)
    }

    /**
     * 行是否允许手动勾选/单独更新（不兼容需先豁免，无法检查/无更新/检查失败不允许）。
     * @param {object} row - 行。
     * @returns {boolean} 是否可选。
     */
    function selectableRow(row) {
      if (row.latest === '') return false
      if (row.incompatible === true) return false
      return ![
        'failed', 'uncheckable', 'current', 'unknown', 'incompatible',
      ].includes(row.state)
    }

    /**
     * 「更新全部」可安装集合：目标存在、不是不兼容/无法检查/无更新，且按开关过滤。
     * @param {object[]} rows - 可见行。
     * @param {{includeDisabled: boolean, includePrerelease: boolean}} settings - 当前开关。
     * @returns {object[]} 可安装行。
     */
    /** 基础范围：有更新的项（默认显示）。 */
    const SCOPE_STATES = ['updatable', 'skipped', 'incompatible']
    /** 需要「显示检查失败的项」开关才纳入的项。 */
    const FAILED_SCOPE_STATES = ['failed', 'uncheckable', 'unknown']

    /**
     * 列表基础范围：默认只显示有更新的项；打开「显示检查失败的项」后追加失败/无法检查/未检查的项。
     * @param {object} row - 行。
     * @param {boolean} showFailed - 是否显示检查失败的项。
     * @returns {boolean} 是否纳入。
     */
    function inScope(row, showFailed) {
      const state = text(row?.state)
      if (SCOPE_STATES.includes(state)) return true
      return showFailed === true && FAILED_SCOPE_STATES.includes(state)
    }

    /**
     * 「更新全部 / 全选」的可安装集合（按当前两个开关）。
     * @param {object[]} rows - 可见行。
     * @param {{includeDisabled: boolean, includePrerelease: boolean}} settings - 当前开关。
     * @returns {object[]} 可安装行。
     */
    function installableRows(rows, settings) {
      return rows.filter(row => autoSelectable(row, settings))
    }

    /**
     * 行是否落在当前两个开关的显示范围内。
     * @param {object} row - 行。
     * @param {{includeDisabled: boolean, includePrerelease: boolean}} settings - 当前开关。
     * @returns {boolean} 是否显示。
     */
    function visibleBySettings(row, settings) {
      if (row.enabled === false && settings.includeDisabled !== true) return false
      if (row.state === 'prerelease' || row.state === 'deprecated' || row.state === 'skipped') {
        // skipped 由 Host 明确给出「显示但不勾选」，即使开关关着也显示。
        return row.state === 'skipped' ? true : settings.includePrerelease === true
      }
      if (row.state === 'disabled') return settings.includeDisabled === true
      return true
    }

    /**
     * 合并 /updates 的 settings 与 /settings 的返回，兼容两套字段名。
     * @param {object} payload - 响应体。
     * @returns {{includeDisabled: boolean, includePrerelease: boolean, settable: boolean}} 设置。
     */
    function readSettings(payload) {
      const source = rec(payload)
      const status = rec(source.status)
      // 两个开关可能出现在顶层 config（GET /updates）或一层嵌套的 status.config（POST /settings）。
      const nested = Object.assign({},
        rec(status.config), rec(status.settings), rec(status.updates),
        rec(source.config), rec(source.settings), rec(source.updates))
      const flat = Object.assign({}, nested, source)
      /**
       * 取第一个出现的值；全部缺席时返回 undefined（表示「响应里没说」，调用方不得据此覆盖本地状态）。
       * @param {...string} keys - 候选键。
       * @returns {boolean|undefined} 值。
       */
      const pick = (...keys) => {
        for (const key of keys) {
          if (flat[key] !== undefined) return bool(flat[key])
        }
        return undefined
      }
      const includeDisabled = pick('updatesIncludeDisabled', 'includeDisabled')
      const includePrerelease = pick('updatesIncludePrerelease', 'includePrerelease')
      // Host：GET /updates 的 config.showFailed；POST /settings 的 status.config.updatesShowFailed。
      const showFailed = pick('updatesShowFailed', 'showFailed')
      const settable = source.settable === false || status.settable === false || nested.settable === false
        || source.writable === false || source.saved === false ? false : true
      return {
        includeDisabled,
        includePrerelease,
        showFailed,
        settable,
        // 是否真的从响应里解析到了开关值（false 时调用方保持乐观值，等 GET /updates 校准）。
        known: includeDisabled !== undefined || includePrerelease !== undefined || showFailed !== undefined,
      }
    }

    /**
     * 只把响应里确实提供的开关并入本地状态（避免缺席字段被当成 false 覆盖）。
     * @param {object} previous - 当前状态。
     * @param {{includeDisabled?: boolean, includePrerelease?: boolean, settable?: boolean}} incoming - 解析结果。
     * @returns {object} 新状态。
     */
    function mergeSettings(previous, incoming) {
      const next = Object.assign({}, previous)
      if (incoming?.includeDisabled !== undefined) next.includeDisabled = incoming.includeDisabled
      if (incoming?.includePrerelease !== undefined) next.includePrerelease = incoming.includePrerelease
      if (incoming?.showFailed !== undefined) next.showFailed = incoming.showFailed
      if (incoming?.settable !== undefined) next.settable = incoming.settable
      return next
    }

    /**
     * 归一 /updates/apply 的返回（Host 契约：`{ok,started,requestIds[],items[]}`）。
     * @param {object} payload - 响应体。
     * @returns {{ok: boolean, requestId: string, message: string}} 入队结果。
     */
    function applyAck(payload) {
      const source = rec(payload)
      const state = rec(source.state)
      const requestIds = list(source.requestIds).map(item => text(item)).filter(item => item !== '')
      const requestId = requestIds[0] ?? (text(source.requestId) || text(state.requestId) || text(source.id))
      return {
        ok: source.ok !== false && source.started !== false,
        requestId,
        message: text(source.message) || text(source.error),
      }
    }

    /**
     * 轮询失败的累加判定：连续失败达到阈值即认为 Host 失联（DSH 退出或正在重启）。
     * @param {number} previous - 之前的连续失败次数。
     * @returns {{count: number, lost: boolean}} 新的计数与是否失联。
     */
    function nextPollFailure(previous) {
      const count = (Number.isFinite(previous) ? Math.max(0, Math.floor(previous)) : 0) + 1
      return { count, lost: count >= LOST_THRESHOLD }
    }

    /**
     * 空队列保护的计数：本地进度在跑但 Host 反复返回空队列时，前 EMPTY_QUEUE_LIMIT 次继续保留，
     * 第 EMPTY_QUEUE_LIMIT + 1 次起判定「队列已丢失/由后台继续」，需要停止轮询并对账。
     * @param {number} previous - 之前的连续空队列次数。
     * @returns {{count: number, lost: boolean}} 新的计数与是否超时。
     */
    function nextEmptyQueueVerdict(previous) {
      const count = (Number.isFinite(previous) ? Math.max(0, Math.floor(previous)) : 0) + 1
      return { count, lost: count > EMPTY_QUEUE_LIMIT }
    }

    /**
     * 归一 GET /updates 的 `interrupted`（Host：`{name,current,target,kind,requestId,phase,startedAt,spec?}`）。
     * @param {unknown} value - 响应里的 interrupted。
     * @returns {Array<{name: string, current: string, target: string, kind: string, spec: string, phase: string, missingFromProfile: boolean}>} 记录。
     */
    function readInterrupted(value) {
      return list(value)
        .map((entry) => {
          const raw = rec(entry)
          const name = text(raw.name) || text(raw.package)
          if (name === '') return null
          return {
            name,
            current: text(raw.current) || text(raw.from),
            target: text(raw.target) || text(raw.latest) || text(raw.version),
            kind: text(raw.kind) === 'git' ? 'git' : 'npm',
            spec: text(raw.spec),
            phase: text(raw.phase) || text(raw.stage),
            // Host 的 t39 契约：该包已不在 profile 依赖里（已从依赖删除但没装回）。
            missingFromProfile: raw.missingFromProfile === true,
          }
        })
        .filter(Boolean)
    }

    /**
     * 把 recover 的 `results` 合并成「包名 → 失败原因」（成功项没有原因）。
     * @param {unknown} results - 响应里的 results。
     * @returns {{failed: Map<string, string>, ok: string[]}} 结果。
     */
    function readRecoverResults(results) {
      /** @type {Map<string, string>} */
      const failed = new Map()
      /** @type {string[]} */
      const ok = []
      for (const entry of list(results)) {
        const raw = rec(entry)
        const name = text(raw.name)
        if (name === '') continue
        if (raw.ok === true) ok.push(name)
        else failed.set(name, text(raw.error) || text(raw.message) || 'install-failed')
      }
      return { failed, ok }
    }

    /**
     * 取进度项的错误正文（Host 的 `error` 是字符串；对象时取 diagnostic/message/code）。
     * 取消项被 Host 写入的 `error:'cancelled'` 不是错误正文，返回空串。
     * @param {object} raw - 队列项。
     * @returns {string} 错误文本。
     */
    function progressError(raw) {
      const value = raw.error
      if (value !== null && typeof value === 'object') {
        const nested = rec(value)
        return text(nested.diagnostic) || text(nested.message) || text(nested.code)
      }
      const message = text(value) || text(raw.message)
      const lower = message.toLowerCase()
      // Host 的 markCancelled 会把 error 写成 'cancelled'，那不是错误正文。
      if (lower === 'cancelled' || lower === 'canceled') return ''
      return message
    }

    /**
     * 归一 `/updates/state`（Host 契约：顶层 `{running,starting,stopped,finished,summary,active,activeRequestId,items,logs,lastRun,checkedAt}`）。
     *
     * 关键点：Host 的队列项初始就是 `success:false / failed:false / cancelled:false`，
     * 所以「失败」只能看 `failed===true`（或 stage/error），「终态」看 `success/failed/cancelled/
     * restartRequired` 或终态 stage；`queued`/`checking`/`installing` 等都不是终态。
     * pnpm 日志在**顶层** `logs`（当前 active 项的尾巴），按 `activeRequestId`/`active` 归到该项。
     * @param {object} payload - 响应体。
     * @returns {{requestId: string, status: string, items: Array, summary: object, running: boolean}} 进度。
     */
    function readProgress(payload) {
      const source = rec(payload)
      const state = Object.keys(rec(source.state)).length > 0 ? rec(source.state) : source
      const rawItems = list(state.items ?? source.items)
      const running = state.running === true
      const activeName = text(state.active) || text(source.active)
      const activeRequestId = text(state.activeRequestId) || text(source.activeRequestId)
      const topLogs = list(state.logs ?? source.logs).map(entry => text(entry)).filter(entry => entry !== '')
      const normalized = rawItems.map((item, index) => {
        const raw = rec(item)
        const name = text(raw.name) || text(raw.packageName) || `#${index + 1}`
        const requestId = text(raw.requestId) || text(raw.id)
        const stage = text(raw.stage) || text(raw.status)
        const isActive = (activeRequestId !== '' && requestId === activeRequestId)
          || ((activeRequestId === '' || requestId === '') && activeName !== '' && name === activeName)
        const ownLogs = list(raw.logs).map(entry => text(entry)).filter(entry => entry !== '')
        const log = ownLogs.length > 0 ? ownLogs.join('\n') : (isActive ? topLogs.join('\n') : text(raw.log))
        const result = text(raw.result)
        const restartRequired = raw.restartRequired === true || result === 'restart-required'
        const cancelled = raw.cancelled === true || stage === 'cancelled' || stage === 'canceled'
        const success = raw.success === true || raw.ok === true || result === 'success' || restartRequired
        const error = progressError(raw)
        return {
          key: `${name}@${index}`,
          name,
          requestId,
          from: text(raw.from) || text(raw.currentVersion) || text(raw.current),
          to: text(raw.to) || text(raw.targetVersion) || text(raw.version),
          stage,
          cancelled,
          success,
          failed: raw.failed === true || stage === 'failed' || (error !== '' && !cancelled && !success),
          error,
          restore: Object.keys(rec(raw.restore)).length > 0 ? rec(raw.restore) : null,
          restartRequired,
          log,
        }
      })
      const allTerminal = normalized.length > 0 && normalized.every(progressTerminal)
      const done = state.finished === true || (running === false && allTerminal)
      return {
        requestId: activeRequestId || text(state.requestId) || text(source.requestId),
        status: done ? 'done' : running ? 'running' : '',
        running,
        summary: rec(state.summary ?? source.summary),
        items: normalized,
      }
    }

    /**
     * 把 Host 的 summary 归一成计数。
     * @param {object} summary - `{success,failed,restartRequired,skipped}` 或数组。
     * @returns {{success: number, failed: number, restart: number, skipped: number}|null} 计数。
     */
    function readSummary(summary) {
      if (Array.isArray(summary)) {
        const counted = { success: 0, failed: 0, restart: 0, skipped: 0 }
        for (const entry of summary) {
          const raw = rec(entry)
          const result = text(raw.result) || text(raw.status)
          if (result === 'success' || raw.success === true) counted.success += 1
          else if (result === 'failed' || raw.failed === true) counted.failed += 1
          else if (result === 'restart-required' || raw.restartRequired === true) counted.restart += 1
          else if (result === 'skipped' || result === 'cancelled') counted.skipped += 1
        }
        return counted
      }
      const raw = rec(summary)
      if (Object.keys(raw).length === 0) return null
      return {
        success: num(raw.success ?? raw.succeeded ?? raw.ok, 0),
        failed: num(raw.failed, 0),
        restart: num(raw.restartRequired ?? raw.restart ?? raw.restartRequiredCount, 0),
        skipped: num(raw.skipped ?? raw.cancelled, 0),
      }
    }

    /**
     * 进度是否已经结束（成功 / 失败 / 取消 / 跳过都算）。
     * @param {object} item - 进度项。
     * @returns {boolean} 是否终态。
     */
    function progressTerminal(item) {
      if (item.success === true || item.failed === true || item.cancelled === true || item.restartRequired === true) return true
      const stage = text(item.stage).toLowerCase()
      return ['done', 'finished', 'success', 'failed', 'error', 'restart', 'restart-required', 'restart_required', 'cancelled', 'canceled', 'skipped'].includes(stage)
    }

    /**
     * 状态区域的「已完成数 / 队列总数」。
     *
     * 关键点：Host 的 summary 里「需重启」项**同时**计入 `success` 与 `restartRequired`
     * （lib/updates.js：`success: success || restartRequired`），所以绝不能把
     * success + failed + restart + skipped 相加 —— 需重启项会被计两次（2 项队列显示 3/3）。
     * 这里直接按队列项去重计数：终态项（success/failed/cancelled/restartRequired/终态 stage）各算一次。
     * @param {object[]} items - 进度项。
     * @param {object} [summary] - Host 的 summary（仅在还没有 items 时兜底总数）。
     * @returns {{done: number, total: number}} 计数。
     */
    function progressTally(items, summary) {
      const rows = list(items)
      // 终态项各算一次：restartRequired 项虽然同时是 success，但只会被数到一次。
      const done = rows.filter(progressTerminal).length
      // 总数取「队列项数」与 Host summary.total 的较大者：done ≤ rows.length 恒成立，
      // 所以这里取 max 不会把 done 撑大（旧实现撑大的是 done 本身）。
      const total = Math.max(done, rows.length, num(rec(summary).total, 0))
      return { done, total }
    }

    /**
     * 「筛选」下拉里的一行开关（文案也可点）。
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function FilterMenuRow({ checked, disabled, label, onChange }) {
      return h('div', { className: 'pmu-menuRow' },
        h(Switch, { checked, disabled, label, onChange }),
        h('button', { type: 'button', className: 'pmu-switchLabel', disabled: disabled === true, onClick: () => { onChange(!checked) } }, label))
    }

    /**
     * 来源徽标（npm / git），位于插件名之后、版本变动之前。
     * @param {object} props - 组件属性。
     * @returns {object|null} React 元素。
     */
    function KindBadge({ kind, t }) {
      if (text(kind) === '') return null
      return h('span', { className: 'pmp-badge pmu-kindBadge' }, kind === 'git' ? t('updatesKindGit') : t('updatesKindNpm'))
    }

    /**
     * 「已禁用」次左徽标：独立显示在主状态徽标左侧，不合并进主状态。
     * @param {object} props - 组件属性。
     * @returns {object|null} React 元素。
     */
    function DisabledBadge({ row, t }) {
      // 只在已禁用时渲染；该列在共享 grid 模板里有固定轨道且后续列都显式 grid-column，
      // 所以空列也天然占位，其他行不会位移。
      if (row.enabled !== false) return null
      return h('span', { className: 'pmp-badge pmu-disabledBadge' }, t('updatesStateDisabled'))
    }

    /**
     * 「无法检查」的悬浮原因文案。
     * @param {string} reason - 候选的 reason（index-miss / unpinned-git-spec / 其它）。
     * @param {(key: string) => string} t - 翻译函数。
     * @returns {string} 文案。
     */
    function uncheckableReasonText(reason, t) {
      if (reason === 'index-miss') return t('updatesUncheckableReasonIndexMiss')
      if (reason === 'unpinned-git-spec') return t('updatesUncheckableReasonUnpinned')
      return t('updatesUncheckableReasonOther')
    }

    /**
     * 主状态徽标：整行只渲染一个，覆盖 无法检查/可更新/不兼容/预发布/已废弃/已豁免/未检查/检查失败/无更新。
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function StatusBadge({ row, exempted, t }) {
      const state = statusOf(row, exempted)
      const labelKey = STATUS_LABEL_KEYS[state] ?? STATUS_LABEL_KEYS.unknown
      const title = state === 'uncheckable' ? uncheckableReasonText(text(row.reason), t) : undefined
      return h('span', {
        className: 'pmp-badge pmu-statusBadge',
        'data-state': state,
        'data-tone': STATUS_TONES[state] ?? 'idle',
        title,
      }, h('span', { className: 'pmp-dot' }), t(labelKey))
    }

    /**
     * 行的主状态（整行只显示一个）。
     *
     * 优先级（高→低）：检查失败 > 无法检查 > 不兼容（未豁免）> 已豁免 > 已废弃 > 预发布 > 跳过 >
     * 无更新 > 未检查 > 可更新。「已禁用」不属于主状态，作为独立徽标显示在主状态左侧。
     * @param {object} row - 行。
     * @param {boolean} exempted - 是否已豁免。
     * @returns {string} 状态键。
     */
    function statusOf(row, exempted) {
      const state = text(row.state)
      if (state === 'failed') return 'failed'
      if (state === 'uncheckable') return 'uncheckable'
      if (state === 'incompatible' || row.incompatible === true) return exempted === true ? 'exempted' : 'incompatible'
      // 目标版本自身的属性优先于 Host 的 available/skipped（开关打开时 Host 仍给 available + 标记）。
      if (state === 'deprecated' || row.deprecated === true) return 'deprecated'
      if (state === 'prerelease' || row.prerelease === true) return 'prerelease'
      if (state === 'skipped') return 'skipped'
      if (state === 'current') return 'current'
      if (state === 'unknown') return 'unknown'
      return 'updatable'
    }

    /**
     * 弹窗外壳（Escape 关闭 + 点击遮罩关闭）。
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function UpdatesModal({ title, onClose, children, panelClass }) {
      React.useEffect(() => {
        /**
         * @param {object} event - 键盘事件。
         * @returns {void}
         */
        const onKey = (event) => { if (event?.key === 'Escape') onClose() }
        try {
          document.addEventListener('keydown', onKey)
          return () => { document.removeEventListener('keydown', onKey) }
        } catch {
          return undefined
        }
      }, [onClose])
      const panel = h('div', { className: panelClass === undefined ? 'pmu-modal' : `pmu-modal ${panelClass}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onClick: (event) => { event.stopPropagation() } },
        h('h3', { className: 'pmu-modalTitle' }, title),
        children)
      return h('div', { className: 'pmu-modalLayer', onClick: onClose }, panel)
    }

    /**
     * 确认框里的一项（包、当前 → 目标版本、来源）。
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function ConfirmRow({ row, t }) {
      return h('div', { className: 'pmu-confirmRow' },
        h('span', { className: 'pmu-confirmKey' }, row.name),
        h('span', { className: 'pmu-confirmValue' },
          `${t('updatesConfirmFrom')} ${row.current === '' ? t('updatesUnknownVersion') : row.current} → ${t('updatesConfirmTo')} ${row.latest === '' ? t('updatesUnknownVersion') : row.latest}`),
        h('span', { className: 'pmu-confirmKey' }, t('updatesConfirmSource')),
        h('span', { className: 'pmu-confirmValue' }, locationText(row, t)))
    }

    /**
     * 安装来源位置展示。
     * @param {object} row - 行。
     * @param {(key: string, params?: object) => string} t - 翻译函数。
     * @returns {string} 文本。
     */
    function locationText(row, t) {
      if (row.location !== '') return row.location
      if (row.spec !== '') return row.spec
      const parts = []
      if (row.repository !== '') parts.push(row.repository)
      if (row.directory !== '') parts.push(row.directory)
      if (row.commit !== '') parts.push(row.commit.slice(0, 12))
      if (parts.length > 0) return parts.join(' ')
      if (row.registry !== '') return `${t('updatesKindNpm')} ${row.registry}`
      return row.kind === 'git' ? t('updatesKindGit') : t('updatesKindNpm')
    }

    /**
     * 进度视图。
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function UpdatesProgress({ items, status, summary, running, cancelling, openLogs, lost, t, onToggleLog, onCancel, onClose }) {
      const ready = items.length > 0 && items.every(progressTerminal)
      const finished = status !== 'running' && (status === 'done' || (ready && running !== true))
      const counts = readSummary(summary) ?? {
        success: items.filter(item => item.success === true).length,
        failed: items.filter(item => item.failed === true || (progressTerminal(item) && item.cancelled !== true && item.success !== true && item.restartRequired !== true)).length,
        restart: items.filter(item => item.restartRequired === true).length,
        skipped: items.filter(item => item.cancelled === true || ['cancelled', 'canceled', 'skipped'].includes(text(item.stage).toLowerCase())).length,
      }
      const done = counts.success
      const failed = counts.failed
      const restart = counts.restart
      const skipped = counts.skipped
      const current = items.find(item => !progressTerminal(item))
      const currentIndex = items.length === 0 || current === undefined ? items.length : items.indexOf(current) + 1
      return h('div', { className: 'pmu-root' },
        // Host 失联：比「读取失败（可重试）」更明确，且此时已停止轮询。
        lost === true && h('p', { className: 'pmu-notice pmu-lost', 'data-tone': 'warn' }, t('updatesHostLost')),
        // 批量结束且有需要重启的项：醒目提示，但不自动重启、不杀进程。
        finished && restart > 0 && h('p', { className: 'pmu-notice pmu-restartNotice', 'data-tone': 'warn' }, t('updatesRestartNotice', { n: restart })),
        h('div', { className: 'pmu-progressHead' },
          h('h3', { className: 'pmu-title' }, t('updatesProgressTitle')),
          h('span', { className: 'pmu-summaryText' }, t('updatesProgressOf', { index: currentIndex, total: items.length })),
          h('span', { className: 'pmu-summaryActions' },
            current !== undefined && h('button', { type: 'button', className: 'pmp-btn pmp-btnDanger', disabled: cancelling, onClick: onCancel }, cancelling ? t('updatesCancelling') : t('updatesCancelQueue'))),
        ),
        h('p', { className: 'pmu-hint' }, t('updatesCancelHint')),
        ...items.map((item) => h('div', { className: 'pmu-progressItem', key: item.key, 'data-current': item === current ? 'true' : undefined },
          h('div', { className: 'pmu-progressTop' },
            h('span', { className: 'pmu-progressName' }, item.name),
            h('span', { className: 'pmu-versions' }, `${item.from === '' ? t('updatesUnknownVersion') : item.from} → ${item.to === '' ? t('updatesUnknownVersion') : item.to}`),
            h('span', { className: 'pmp-badge', 'data-tone': item.failed === true ? 'bad' : item.success === true || item.restartRequired === true ? 'ok' : 'idle' },
              h('span', { className: 'pmp-dot' }), item.stage === '' ? t('stagePending') : stageLabel(item.stage, t))),
          item.error !== '' && h('p', { className: 'pmu-error' }, item.error),
          list(item.stages).length > 1 && h('p', { className: 'pmu-hint' }, h('b', null, `${t('updatesStages')} `), list(item.stages).map(value => stageLabel(value, t)).join(' → ')),
          item.restore !== null && h('p', { className: 'pmu-hint' }, h('b', null, `${t('updatesStages')} `), restoreText(item.restore, t)),
          h('div', { className: 'pmu-progressTop' },
            h('button', { type: 'button', className: 'pmu-link', onClick: () => { onToggleLog(item.key) } }, t('updatesLogToggle')),
            item.restartRequired === true && h('span', { className: 'pmu-progressText' }, t('updatesRestartRequired'))),
          openLogs[item.key] === true && h('div', { className: 'pmu-log' }, item.log === '' ? t('updatesLogEmpty') : item.log))),
        finished && h('div', { className: 'pmu-summary' },
          h('span', { className: 'pmu-summaryText' }, `${t('updatesSuccessItems', { n: done })} · ${t('updatesFailedItems', { n: failed })} · ${t('updatesRestartItems', { n: restart })}${skipped > 0 ? ` · ${t('updatesSkippedItems', { n: skipped })}` : ''}`),
          h('span', { className: 'pmu-summaryActions' },
            h('button', { type: 'button', className: 'pmp-btn pmp-btnPrimary', onClick: onClose }, t('updatesClose')))),
      )
    }

    /**
     * 回滚结果文本。
     *
     * Host 的 `restore` 是 `pluginManager.updateBundle()` 的 ChangeResult：
     * `{application:'applied'|'restart-required'|'failed'|'unchanged', error?:{code,diagnostic,...}}`。
     * `applied`/`restart-required` = 已装回原版本；`failed` = 回滚也失败（显示诊断）；
     * `unchanged` 或其他 = 没发生实际回滚（中性文案）。
     * @param {object} restore - restore（ChangeResult）。
     * @param {(key: string, params?: object) => string} t - 翻译函数。
     * @returns {string} 文本。
     */
    function restoreText(restore, t) {
      const value = rec(restore)
      const application = text(value.application) || text(value.result) || text(value.status)
      const error = rec(value.error)
      const diagnostic = text(error.diagnostic) || text(error.message) || text(error.code)
      if (application === 'applied' || application === 'restart-required') return t('updatesRestored')
      if (application === 'failed' || Object.keys(error).length > 0) {
        return `${t('updatesRestoreFailed')}${diagnostic === '' ? '' : `: ${diagnostic}`}`
      }
      return t('updatesRestoreIdle')
    }

    /**
     * 「可更新」页主体：plugins.tab 席位内容。
     * @param {object} props - 宿主注入属性（owner props + 本插件注入的 t）。
     * @returns {object} React 元素。
     */
    function UpdatesSection(props) {
      // owner props：openPackage 打开官方详情页；install/update 在本页不使用。
      const openPackage = typeof props?.openPackage === 'function' ? props.openPackage : null
      const t = typeof props?.t === 'function' ? props.t : fallbackT

      const [rows, setRows] = React.useState([])
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')
      const [checkedAt, setCheckedAt] = React.useState(null)
      const [settings, setSettings] = React.useState({ includeDisabled: false, includePrerelease: false, showFailed: false, settable: true })
      const [search, setSearch] = React.useState('')
      const [selected, setSelected] = React.useState({})
      const [exemptPanels, setExemptPanels] = React.useState({})
      const [exempted, setExempted] = React.useState(() => ({}))
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [confirm, setConfirm] = React.useState(null)
      const [exemptAck, setExemptAck] = React.useState({})
      const [confirmSecond, setConfirmSecond] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [cancelling, setCancelling] = React.useState(false)
      const [hostLost, setHostLost] = React.useState(false)
      const [progressOpen, setProgressOpen] = React.useState(false)
      const [interrupted, setInterrupted] = React.useState([])
      const [recovering, setRecovering] = React.useState('')
      const [recoverErrors, setRecoverErrors] = React.useState({})
      const [openLogs, setOpenLogs] = React.useState({})
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [menuPos, setMenuPos] = React.useState(null)
      const alive = React.useRef(true)
      const pollRef = React.useRef(null)
      const pollFailuresRef = React.useRef(0)
      const progressItemsRef = React.useRef([])
      const progressRunningRef = React.useRef(false)
      const emptyQueueRef = React.useRef(0)
      const requestRef = React.useRef('')
      const selectAllRef = React.useRef(null)
      const settingsRef = React.useRef(null)
      const stagesRef = React.useRef({})
      const startPollingRef = React.useRef(null)
      const tRef = React.useRef(t)
      tRef.current = t

      const seen = (name, latest) => cellKey(name, latest)

      /** 让阶段记录跨轮询保留（Host 只发增量时也能看到历史）。 */
      const mergeStages = (items) => {
        const previous = stagesRef.current ?? {}
        const next = {}
        const merged = items.map((item) => {
          const prior = previous[item.key] ?? {}
          const priorStages = list(prior.stages)
          const stage = text(item.stage)
          const stages = stage === '' || priorStages[priorStages.length - 1] === stage ? priorStages : [...priorStages, stage]
          // Host 的顶层 logs 只覆盖当前 active 项，队列结束后会变空：保留最后一次看到的日志。
          const log = text(item.log) !== '' ? text(item.log) : text(prior.log)
          next[item.key] = { stages, log }
          return Object.assign({}, item, { stages, log })
        })
        stagesRef.current = next
        return merged
      }

      const load = React.useCallback(async (skipResume) => {
        try {
          const payload = await getJson(`${UPDATES_API}`)
          if (!alive.current) return
          const body = rec(payload)
          if (body.ok === false) {
            setLoadError(text(body.message) || text(body.error) || 'error')
            setLoaded(true)
            return
          }
          // Host 契约：candidates[] + config{} + checkedAt + running
          setRows(list(body.candidates ?? body.updates ?? body.items).map(toRow).filter(Boolean))
          const incomingSettings = readSettings(body)
          if (incomingSettings.known) setSettings(previous => mergeSettings(previous, incomingSettings))
          setCheckedAt(body.checkedAt === undefined || body.checkedAt === null ? null : num(body.checkedAt, Date.now()))
          setInterrupted(readInterrupted(body.interrupted))
          setLoadError('')
          setLoaded(true)
          if (body.running === true && skipResume !== true) {
            // 打开页面时已有队列在跑：接上进度，不再自己入队。
            setNotice({ tone: 'warn', text: tRef.current('updatesRunningElsewhere') })
            progressRunningRef.current = true
            setProgress({ requestId: '', status: 'running', running: true, summary: {}, items: [] })
            if (typeof startPollingRef.current === 'function') startPollingRef.current()
          }
          return body
        } catch (failure) {
          if (!alive.current) return null
          setLoadError(String(failure?.message ?? failure))
          setLoaded(true)
          return null
        }
      }, [])

      // 「筛选」下拉打开时响应 Escape（真实浏览器；点击外部由遮罩层处理）。
      React.useEffect(() => {
        if (settingsOpen !== true) return undefined
        /**
         * @param {object} event - 键盘事件。
         * @returns {void}
         */
        const onKey = (event) => { if (event?.key === 'Escape') setSettingsOpen(false) }
        try {
          document.addEventListener('keydown', onKey)
          return () => { document.removeEventListener('keydown', onKey) }
        } catch {
          return undefined
        }
      }, [settingsOpen])

      const applyCandidates = React.useCallback((body) => {
        const source = rec(body)
        const candidates = list(source.candidates)
        if (candidates.length === 0) return false
        setRows(candidates.map(toRow).filter(Boolean))
        if (source.checkedAt !== undefined && source.checkedAt !== null) setCheckedAt(num(source.checkedAt, Date.now()))
        return true
      }, [])

      React.useEffect(() => {
        alive.current = true
        void load()
        return () => {
          alive.current = false
          if (pollRef.current !== null) clearInterval(pollRef.current)
        }
      }, [load])

      const finish = React.useCallback((items, summary) => {
        const counts = readSummary(summary)
        const failed = counts === null
          ? items.filter(item => item.failed === true && item.restartRequired !== true).length
          : counts.failed
        const done = counts === null
          ? items.filter(item => item.success === true || item.restartRequired === true).length
          : counts.success + counts.restart
        setNotice(failed > 0
          ? { tone: 'error', text: `${t('updatesFailedItems', { n: failed })} · ${t('updatesSuccessItems', { n: done })}` }
          : { tone: 'ok', text: `${t('updatesSuccessItems', { n: done })}${done === 0 || items.some(item => item.restartRequired === true) || (counts?.restart ?? 0) > 0 ? ` · ${t('updatesRestartRequired')}` : ''}` })
        setSelected({})
        setCancelling(false)
        // 队列刚结束：只刷新列表，不要再把「正在跑」的旧状态接回来（否则 finish→load→poll 会自激）。
        void load(true)
      }, [t, load])

      const stopPolling = React.useCallback(() => {
        if (pollRef.current !== null) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, [])

      /**
       * 空队列超时后的对账：停止轮询、清空进度，重新拉 GET /updates，按「是否仍可更新」给不同提示。
       * @param {string[]} names - 超时前本地进度里的包名。
       * @returns {Promise<void>} 完成。
       */
      const reconcileLostQueue = React.useCallback(async (names) => {
        stopPolling()
        setCancelling(false)
        setProgress(null)
        setProgressOpen(false)
        setOpenLogs({})
        emptyQueueRef.current = 0
        const body = await load(true)
        if (!alive.current) return
        const fresh = body === null ? null : list(body.candidates ?? body.updates ?? body.items).map(toRow).filter(Boolean)
        const stillUpdatable = fresh === null
          ? true
          : fresh.some(row => names.includes(row.name) && ['updatable', 'skipped', 'incompatible'].includes(row.state))
        // 已装到目标（不在可更新列表）→ 视为完成；仍可更新 → 说明更新没完成，需要重新检查。
        setNotice({
          tone: stillUpdatable ? 'error' : 'warn',
          text: t(stillUpdatable ? 'updatesProgressLost' : 'updatesProgressReconciled'),
        })
      }, [load, stopPolling, t])

      const poll = React.useCallback(async () => {
        try {
          const payload = await getJson(`${UPDATES_API}/state`)
          if (!alive.current) return
          pollFailuresRef.current = 0
          setHostLost(false)
          const body = rec(payload)
          const current = readProgress(body)
          // Host 还没把队列报出来（刚入队 / 刚切回）时，保留本地已有的进度，避免被空状态清空。
          // 判定依据：Host 一个条目都没有、summary.total 也是 0、也还没结束 —— 说明它还没接上这次队列。
          // 有界保护：最多保留 EMPTY_QUEUE_LIMIT 次；超过则判定队列已丢失（典型：Host 被 HMR 重载），
          // 停止轮询、清空进度并重新对账，避免界面永久卡在旧阶段。
          if (current.items.length === 0 && num(current.summary.total, 0) === 0 && current.status !== 'done'
            && (progressItemsRef.current.length > 0 || progressRunningRef.current === true)) {
            const verdict = nextEmptyQueueVerdict(emptyQueueRef.current)
            emptyQueueRef.current = verdict.count
            if (verdict.lost) {
              const names = progressItemsRef.current.map(item => item.name)
              void reconcileLostQueue(names)
            }
            return
          }
          emptyQueueRef.current = 0
          const items = mergeStages(current.items)
          setProgress({
            requestId: current.requestId === '' ? requestRef.current : current.requestId,
            status: current.status,
            running: current.running,
            summary: current.summary,
            items,
          })
          if (current.status === 'done') {
            stopPolling()
            finish(items, current.summary)
          }
        } catch {
          if (!alive.current) return
          // 单次失败只提示可重试；连续 3 次失败说明 Host 已经不在（DSH 退出/重启中），
          // 这时停止轮询并给出「重新启动后继续」，而不是反复刷「读取失败（可重试）」。
          const verdict = nextPollFailure(pollFailuresRef.current)
          pollFailuresRef.current = verdict.count
          if (verdict.lost) {
            stopPolling()
            setCancelling(false)
            setHostLost(true)
            setNotice(null)
            return
          }
          setNotice({ tone: 'error', text: t('updatesStateLost') })
        }
      }, [finish, mergeStages, stopPolling, t])

      const startPolling = React.useCallback(() => {
        stopPolling()
        pollFailuresRef.current = 0
        emptyQueueRef.current = 0
        setHostLost(false)
        pollRef.current = setInterval(() => { void poll() }, POLL_MS)
        void poll()
      }, [poll, stopPolling])
      startPollingRef.current = startPolling

      /**
       * 打开开关：先本地生效保证交互即时，再持久化到插件配置并重取列表。
       * @param {'includeDisabled'|'includePrerelease'} key - 开关。
       * @param {boolean} next - 新值。
       * @returns {void}
       */
      const toggleSetting = (key, next) => {
        const nextSettings = Object.assign({}, settings, { [key]: next })
        setSettings(nextSettings)
        setBusy('settings')
        setNotice(null)
        void postJson('/settings', {
          updatesIncludeDisabled: nextSettings.includeDisabled === true,
          updatesIncludePrerelease: nextSettings.includePrerelease === true,
          updatesShowFailed: nextSettings.showFailed === true,
        }).then(async (payload) => {
          if (!alive.current) return
          const incoming = readSettings(payload)
          // 响应没带配置（例如 {ok:true}）时保留乐观值，随后用 GET /updates 的 config 校准。
          if (incoming.known) setSettings(previous => mergeSettings(previous, incoming))
          if (incoming.settable === false) setNotice({ tone: 'warn', text: t('updatesSetsLocalOnly') })
          await load()
        }).catch((failure) => {
          if (alive.current) setNotice({ tone: 'error', text: t('updatesSettingsFailed', { error: String(failure?.message ?? failure) }) })
        }).finally(() => {
          if (alive.current) setBusy('')
        })
      }

      const check = async () => {
        setBusy('check')
        setNotice(null)
        try {
          const names = rows.map(row => row.name)
          const payload = await postJson('/updates/check', names.length > 0 ? { names } : {})
          if (!alive.current) return
          // 手动检查成功 = 连接已恢复：清掉失联提示与计数。
          pollFailuresRef.current = 0
          setHostLost(false)
          const body = rec(payload)
          if (!applyCandidates(body)) await load()
          if (!alive.current) return
          const candidates = list(body.candidates).map(toRow).filter(Boolean)
          let updatable = 0
          for (const row of candidates) {
            if (autoSelectable(row, settings)) updatable += 1
          }
          // 检查成功不再弹「检查完成：可更新 N 项」提示条；列表本身就是结果。
          setNotice(null)
        } catch (failure) {
          if (alive.current) setNotice({ tone: 'error', text: t('updatesCheckFailed', { error: String(failure?.message ?? failure) }) })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      /**
       * 重新安装中断的项（Host：POST /updates/recover）。
       * @param {string} [only] - 只恢复该包；省略则整批。
       * @returns {void}
       */
      const recoverInterrupted = (only) => {
        setRecovering(only === undefined ? '*' : only)
        setNotice(null)
        const body = only === undefined ? {} : { items: [{ name: only }] }
        void postJson('/updates/recover', body).then((payload) => {
          if (!alive.current) return
          const result = readRecoverResults(rec(payload).results)
          const remaining = readInterrupted(rec(payload).interrupted)
          setInterrupted(remaining)
          /** @type {Record<string, string>} */
          const errors = {}
          for (const [name, reason] of result.failed) errors[name] = reason
          setRecoverErrors(errors)
          if (result.failed.size === 0) {
            setNotice({ tone: 'ok', text: t('updatesRecovered', { n: result.ok.length }) })
          } else {
            setNotice({ tone: 'error', text: t('updatesRecoverPartial', { ok: result.ok.length, failed: result.failed.size }) })
          }
          void load(true)
        }).catch((failure) => {
          if (alive.current) setNotice({ tone: 'error', text: t('updatesRecoverFailed', { error: String(failure?.message ?? failure) }) })
        }).finally(() => {
          if (alive.current) setRecovering('')
        })
      }

      /**
       * 忽略中断记录（Host：POST /updates/clear-interrupted）。
       * @returns {void}
       */
      const ignoreInterrupted = () => {
        setRecovering('ignore')
        setNotice(null)
        void postJson('/updates/clear-interrupted', {}).then(() => {
          if (!alive.current) return
          setInterrupted([])
          setRecoverErrors({})
          setNotice({ tone: 'ok', text: t('updatesInterruptedCleared') })
        }).catch((failure) => {
          if (alive.current) setNotice({ tone: 'error', text: t('updatesRecoverFailed', { error: String(failure?.message ?? failure) }) })
        }).finally(() => {
          if (alive.current) setRecovering('')
        })
      }

      const startApply = async (items) => {
        setConfirm(null)
        setBusy('apply')
        setNotice(null)
        setSelected({})
        requestRef.current = ''
        try {
          // Host 契约：items 只带 name；只有 Git 包才需要 spec/commit（registry 一律不带）。
          const payload = await postJson('/updates/apply', {
            items: items.map(row => {
              const item = { name: row.name }
              if (row.kind === 'git') {
                if (row.spec !== '') item.spec = row.spec
                else if (row.commit !== '') item.commit = row.commit
              }
              return item
            }),
          })
          if (!alive.current) return
          const ack = applyAck(payload)
          if (!ack.ok) throw new Error(ack.message === '' ? t('updatesAnotherRunning') : ack.message)
          requestRef.current = ack.requestId
          const seeded = items.map(row => ({
            key: `${row.name}@0`, name: row.name, from: row.current, to: row.latest, stage: 'pending',
            success: false, failed: false, error: '', restore: null, restartRequired: false, log: '', stages: [],
          }))
          // 立刻记下种子条目：紧接着的第一次轮询若 Host 还没接上，也不能把它清空。
          progressItemsRef.current = seeded
          progressRunningRef.current = true
          setProgress({
            requestId: ack.requestId,
            status: 'running',
            running: true,
            summary: {},
            items: seeded,
          })
          stagesRef.current = {}
          startPolling()
        } catch (failure) {
          if (alive.current) setNotice({ tone: 'error', text: t('updatesStartFailed', { error: String(failure?.message ?? failure) }) })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const cancelCurrent = async () => {
        if (progress === null) return
        setCancelling(true)
        try {
          // Host 契约：POST {} → {ok,cancelled,name?,state}
          await postJson('/updates/cancel', {})
          if (alive.current) void poll()
        } catch (failure) {
          if (alive.current) {
            setCancelling(false)
            setNotice({ tone: 'error', text: String(failure?.message ?? failure) })
          }
        }
      }

      const exemptAndUpdate = async (row, incompatibility) => {
        setBusy(`exempt:${row.name}`)
        setNotice(null)
        const runtimeVersion = text(incompatibility?.runtimeVersion)
        try {
          // Host 契约：{package,version,acceptRisk:true,runtimeVersion?} → {ok,runtimeVersion,result}
          const request = { package: row.name, version: row.latest, acceptRisk: true }
          if (runtimeVersion !== '') request.runtimeVersion = runtimeVersion
          const payload = await postJson('/updates/exempt', request)
          if (!alive.current) return
          const body = rec(payload)
          setExempted(previous => Object.assign({}, previous, {
            [seen(row.name, row.latest)]: text(body.runtimeVersion) || runtimeVersion || 'true',
          }))
          const next = Object.assign({}, row, { incompatible: false, state: 'updatable' })
          await startApply([next])
        } catch (failure) {
          if (alive.current) setNotice({ tone: 'error', text: t('updatesExemptFailed', { error: String(failure?.message ?? failure) }) })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const visibleRows = React.useMemo(() => {
        const needle = search.trim().toLowerCase()
        return rows.filter((row) => {
          if (!inScope(row, settings.showFailed === true)) return false
          if (!visibleBySettings(row, settings)) return false
          if (needle !== '' && !row.name.toLowerCase().includes(needle)) return false
          return true
        })
      }, [rows, search, settings.includeDisabled, settings.includePrerelease, settings.showFailed])

      // 当前搜索范围内被「显示检查失败的项」开关隐藏的条目数（空态提示用）。
      const hiddenFailedCount = React.useMemo(() => {
        const needle = search.trim().toLowerCase()
        return rows.filter(row => visibleBySettings(row, settings)
          && (needle === '' || row.name.toLowerCase().includes(needle))
          && !inScope(row, settings.showFailed === true) && inScope(row, true)).length
      }, [rows, search, settings.includeDisabled, settings.includePrerelease, settings.showFailed])

      // 当前搜索范围内是否一个候选都没有（用于区分「搜索无命中」与「没有可更新的项」）。
      const searchedCount = React.useMemo(() => {
        const needle = search.trim().toLowerCase()
        return rows.filter(row => visibleBySettings(row, settings)
          && (needle === '' || row.name.toLowerCase().includes(needle))).length
      }, [rows, search, settings.includeDisabled, settings.includePrerelease])

      const installable = installableRows(visibleRows, settings)
      const selectedRows = visibleRows.filter(row => selected[row.key] === true)
      const allSelected = installable.length > 0 && installable.every(row => selected[row.key] === true)
      const someSelected = installable.some(row => selected[row.key] === true)
      const selectedCount = selectedRows.length

      // 原生 indeterminate 只能用 DOM 属性；data-state 同步一份供样式/无障碍使用。
      const selectAllState = allSelected ? 'all' : someSelected ? 'indeterminate' : 'none'
      React.useEffect(() => {
        const node = selectAllRef.current
        if (node !== null && node !== undefined) node.indeterminate = selectAllState === 'indeterminate'
      }, [selectAllState])

      const toggleSelect = (key, next) => {
        setSelected(previous => {
          const copy = Object.assign({}, previous)
          if (next) copy[key] = true
          else delete copy[key]
          return copy
        })
      }

      const toggleAll = () => {
        setSelected(() => {
          const copy = {}
          if (!allSelected) {
            for (const row of installable) copy[row.key] = true
          }
          return copy
        })
      }

      const toggleExemptPanel = (key) => {
        setExemptPanels(previous => {
          const copy = Object.assign({}, previous)
          if (copy[key] === true) delete copy[key]
          else copy[key] = true
          return copy
        })
        // 收起时清掉该行的风险勾选，重新打开需再次确认风险。
        setAck(key, false)
      }

      /**
       * 某一行的风险勾选状态（按行 key 区分，互不影响）。
       * @param {string} key - 行键。
       * @returns {boolean} 是否已勾选。
       */
      const ackOf = (key) => exemptAck[key] === true

      /**
       * 写入某一行的风险勾选。
       * @param {string} key - 行键。
       * @param {boolean} next - 是否勾选。
       * @returns {void}
       */
      const setAck = (key, next) => {
        setExemptAck(previous => {
          const copy = Object.assign({}, previous)
          if (next) copy[key] = true
          else delete copy[key]
          return copy
        })
      }

      const toggleLog = (key) => {
        setOpenLogs(previous => {
          const copy = Object.assign({}, previous)
          if (copy[key] === true) delete copy[key]
          else copy[key] = true
          return copy
        })
      }

      /**
       * 打开插件详情（名称即入口）。
       * @param {string} name - 包名。
       * @returns {void}
       */
      const openDetails = (name) => {
        if (openPackage !== null) openPackage(name)
      }

      /**
       * 展开 / 收起「筛选」菜单（展开时先量一次落点，避免菜单出视口）。
       * @returns {void}
       */
      const toggleSettingsMenu = () => {
        if (settingsOpen === true) {
          setSettingsOpen(false)
          return
        }
        setMenuPos(measureMenuPlacement(settingsRef.current))
        setSettingsOpen(true)
      }

      const progressItems = progress?.items ?? []
      progressItemsRef.current = progressItems
      progressRunningRef.current = progress !== null && (progress.running === true || progress.status === 'running')
      const progressReady = progressItems.length > 0 && progressItems.every(progressTerminal)
      const progressRunning = progress !== null && (progress.running === true || progress.status === 'running')
      // 队列运行中绝不渲染「上次更新中断」：切走再切回时 GET /updates 可能还带着旧残留，
      // 先按 running 只显示进度，等队列结束后再按新的 GET /updates 决定是否显示。
      const interruptedVisible = interrupted.length > 0 && progressRunning !== true
      const progressCounts = readSummary(progress?.summary ?? {}) ?? {
        success: progressItems.filter(item => item.success === true || item.restartRequired === true).length,
        failed: progressItems.filter(item => item.failed === true).length,
        restart: progressItems.filter(item => item.restartRequired === true).length,
        skipped: progressItems.filter(item => item.cancelled === true).length,
      }
      // 「已完成数 / 队列总数」按终态项去重计数（summary 的 success 已含 restartRequired，
      // 不能与 restart 相加，否则需重启项会被计两次）。
      const progressTallyOf = progressTally(progressItems, progress?.summary ?? {})
      const progressDone = progressTallyOf.done
      const progressTotal = progressTallyOf.total
      const openConfirm = (target) => { setConfirm(target); setExemptAck({}); setConfirmSecond(null) }

      return h('div', { className: 'pmu-root' },
        // 工具条（单行）：检查更新 | 搜索框 | 齿轮设置 | 更新全部 | 更新已选
        h('div', { className: 'pmu-toolbar' },
          h('button', {
            type: 'button', className: 'pmp-btn pmp-btnPrimary pmu-checkBtn',
            disabled: busy !== '' || progress !== null && !progressReady,
            onClick: () => { void check() },
          }, busy === 'check' ? t('updatesChecking') : t('updatesCheck')),
          h('input', {
            className: 'pmu-search', type: 'search', value: search, placeholder: t('updatesSearchPlaceholder'),
            'aria-label': t('updatesSearchPlaceholder'), onChange: (event) => { setSearch(text(event?.target?.value)) },
          }),
          // 齿轮设置：遮罩与菜单是 wrap 下的兄弟节点（菜单以 wrap 为包含块，不能嵌进全屏 fixed 遮罩）。
          h('div', {
            className: 'pmu-filterWrap pmu-settingsWrap', ref: settingsRef,
            onKeyDown: (event) => { if (event?.key === 'Escape' && settingsOpen) setSettingsOpen(false) },
          },
          settingsOpen && h('div', { className: 'pmu-menuLayer', onClick: () => { setSettingsOpen(false) } }),
          h('button', {
            type: 'button', className: 'pmp-btn pmu-gearBtn',
            'aria-haspopup': 'true', 'aria-expanded': settingsOpen ? 'true' : 'false',
            'aria-label': t('updatesSettingsMenu'), title: t('updatesSettingsMenu'),
            onClick: toggleSettingsMenu,
          }, h('svg', {
            className: 'pmu-gear', viewBox: '0 0 24 24', width: '15', height: '15',
            'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor',
            'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          }, h('circle', { cx: '12', cy: '12', r: '3' }), h('path', { d: GEAR_PATH }))),
          settingsOpen && h('div', {
            className: 'pmu-menu pmu-settingsMenu', role: 'menu', 'aria-label': t('updatesSettingsMenu'),
            'data-placement': menuPos === null ? 'bottom' : menuPos.placement,
            'data-anchored': menuPos === null ? 'css' : 'fixed',
            style: menuPos === null ? undefined : { position: 'fixed', left: `${menuPos.left}px`, top: `${menuPos.top}px` },
            onClick: (event) => { event.stopPropagation() },
          },
          h(FilterMenuRow, {
            checked: settings.showFailed === true,
            disabled: settings.settable === false || busy !== '',
            label: t('updatesShowFailed'),
            onChange: (next) => { toggleSetting('showFailed', next) },
          }),
          h(FilterMenuRow, {
            checked: settings.includePrerelease === true,
            disabled: settings.settable === false || busy !== '',
            label: t('updatesIncludePrerelease'),
            onChange: (next) => { toggleSetting('includePrerelease', next) },
          }),
          h(FilterMenuRow, {
            checked: settings.includeDisabled === true,
            disabled: settings.settable === false || busy !== '',
            label: t('updatesIncludeDisabled'),
            onChange: (next) => { toggleSetting('includeDisabled', next) },
          }))),
          h('button', { type: 'button', className: 'pmp-btn', disabled: busy !== '' || installable.length === 0, onClick: () => { openConfirm({ rows: installable }) } }, t('updatesUpdateAll')),
          h('button', { type: 'button', className: 'pmp-btn', disabled: busy !== '' || selectedCount === 0, onClick: () => { openConfirm({ rows: selectedRows }) } }, t('updatesUpdateSelected')),
          // 更新状态：有队列时才出现；点开「更新进度」弹窗（关闭弹窗不中断队列）。
          progress !== null && progressTotal > 0 && h('button', {
            type: 'button', className: 'pmu-runState',
            'data-state': progressRunning ? 'running' : 'done',
            'aria-label': progressRunning ? t('updatesRunStateRunning') : t('updatesRunStateDone'),
            title: progressRunning ? t('updatesRunStateRunning') : t('updatesRunStateDone'),
            'aria-haspopup': 'dialog',
            onClick: () => { setProgressOpen(true) },
          },
          h('span', { className: 'pmu-runIcon', 'aria-hidden': 'true' },
            progressRunning ? null : h('svg', {
              className: 'pmu-runCheck', viewBox: '0 0 24 24', width: '9', height: '9',
              fill: 'none', stroke: 'currentColor', 'stroke-width': '3.4',
              'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            }, h('path', { d: 'M4 12.5l5 5L20 6.5' }))),
          h('span', { className: 'pmu-runText' }, t('updatesRunStateCount', { done: progressDone, total: progressTotal })))),

        notice !== null && h('p', { className: 'pmu-notice', 'data-tone': notice.tone }, notice.text),
        hostLost && h('p', { className: 'pmu-notice pmu-lost', 'data-tone': 'warn' }, t('updatesHostLost')),
        // 队列结束且有需重启项：弹窗关着时也在页面上提醒（弹窗内同样有）。
        progress !== null && progressOpen !== true && progressReady && progressCounts.restart > 0
          && h('p', { className: 'pmu-notice pmu-restartNotice', 'data-tone': 'warn' }, t('updatesRestartNotice', { n: progressCounts.restart })),

        // 上次更新中断（Host 的 GET /updates.interrupted）：逐项重装或整批忽略。
        // 队列运行中一律不显示（见 interruptedVisible）。
        interruptedVisible && h('div', { className: 'pmu-interrupted', role: 'group', 'aria-label': t('updatesInterruptedTitle') },
          h('div', { className: 'pmu-interruptedHead' },
            h('h3', { className: 'pmu-title' }, t('updatesInterruptedTitle')),
            h('span', { className: 'pmu-summaryText' }, t('updatesInterruptedLead', { n: interrupted.length })),
            h('span', { className: 'pmu-summaryActions' },
              h('button', {
                type: 'button', className: 'pmp-btn pmp-btnPrimary',
                disabled: recovering !== '' || busy !== '',
                onClick: () => { recoverInterrupted() },
              }, recovering === '*' ? t('updatesRecovering') : t('updatesRecover')),
              h('button', {
                type: 'button', className: 'pmp-btn',
                disabled: recovering !== '' || busy !== '',
                onClick: ignoreInterrupted,
              }, t('updatesIgnore')))),
          ...interrupted.map(item => h('div', { className: 'pmu-interruptedRow', key: item.name },
            h('span', { className: 'pmu-interruptedName', title: item.name }, item.name),
            h('span', { className: 'pmu-versions' }, `${item.current === '' ? t('updatesUnknownVersion') : item.current} → ${item.target === '' ? t('updatesUnknownVersion') : item.target}`),
            h('span', { className: 'pmp-badge' }, item.kind === 'git' ? t('updatesKindGit') : t('updatesKindNpm')),
            item.missingFromProfile === true && h('span', { className: 'pmp-badge pmu-missingBadge', 'data-tone': 'warn' }, t('updatesMissingFromProfile')),
            item.missingFromProfile === true && h('span', { className: 'pmu-missingHint' }, t('updatesMissingFromProfileHint')),
            recoverErrors[item.name] !== undefined && h('span', { className: 'pmu-error' }, t('updatesRecoverItemFailed', { error: recoverErrors[item.name] })),
            h('span', { className: 'pmu-summaryActions' },
              h('button', {
                type: 'button', className: 'pmp-btn',
                disabled: recovering !== '' || busy !== '',
                onClick: () => { recoverInterrupted(item.name) },
              }, recovering === item.name ? t('updatesRecovering') : t('updatesRecover')))))),
        loadError !== '' && h('p', { className: 'pmu-error' }, t('updatesLoadFailed', { error: loadError })),

        // 更新进度整体在弹窗里（由工具条的状态区域点开）；这里不再内联渲染。
        progressOpen && progress !== null && h(UpdatesModal, {
          title: t('updatesProgressTitle'),
          panelClass: 'pmu-progressModal',
          onClose: () => { setProgressOpen(false) },
        },
        h(UpdatesProgress, {
          items: progressItems,
          status: progress.status,
          summary: progress.summary,
          running: progress.running,
          cancelling,
          openLogs,
          lost: hostLost,
          t,
          onToggleLog: toggleLog,
          onCancel: () => { void cancelCurrent() },
          // 弹窗里的「完成」只关闭弹窗：状态区域（绿色对勾 + 计数）保留到下一次更新或页面刷新。
          onClose: () => { setProgressOpen(false) },
        })),

        // 统计条
        h('div', { className: 'pmu-summary' },
          h('label', { className: 'pmu-selectAll' },
            h('input', {
              ref: selectAllRef, type: 'checkbox', className: 'pmu-check', 'aria-label': t('updatesSelectAll'),
              'data-state': selectAllState, checked: allSelected, disabled: installable.length === 0,
              onChange: () => { toggleAll() },
            }),
            t('updatesSelectAll')),
          h('span', { className: 'pmu-summaryText' }, t('updatesSummary', { updates: installable.length, selected: selectedCount })),
          h('span', { className: 'pmu-summaryTime' }, checkedAt === null ? t('updatesNeverChecked') : t('updatesLastChecked', { time: formatTimeOnly(checkedAt) }))),

        // 列表
        visibleRows.length === 0
          ? h('p', { className: 'pmu-hint' }, loaded
            ? (rows.length === 0
              ? t('updatesEmpty')
              : (searchedCount === 0
                ? t('updatesEmptyFilter')
                : (hiddenFailedCount > 0 && settings.showFailed !== true ? t('updatesEmptyShowFailed') : t('updatesEmptyNoUpdate'))))
            : t('updatesLoading'))
          : h('div', { className: 'pmu-list' }, ...visibleRows.map(row => renderRow(row))),

        // 更新确认框
        confirm !== null && h(UpdatesModal, {
          title: confirm.rows.length === 1 ? t('updatesConfirmTitle') : t('updatesConfirmTitleBulk', { n: confirm.rows.length }),
          onClose: () => { setConfirm(null) },
        },
        h('p', { className: 'pmu-modalBody' }, confirm.rows.length === 1 ? t('updatesConfirmLeadSingle') : t('updatesConfirmLeadBulk', { n: confirm.rows.length })),
        ...confirm.rows.slice(0, 20).map(row => h(ConfirmRow, { key: `${row.key}:confirm`, row, t })),
        h('p', { className: 'pmu-modalBody' }, t('updatesConfirmRollback')),
        h('p', { className: 'pmu-hint' }, t('updatesConfirmQueue')),
        h('div', { className: 'pmu-modalActions' },
          h('button', { type: 'button', className: 'pmp-btn', onClick: () => { setConfirm(null) } }, t('updatesCancel')),
          h('button', { type: 'button', className: 'pmp-btn pmp-btnPrimary', disabled: busy !== '', onClick: () => { void startApply(confirm.rows) } }, t('updatesConfirmNow')))),

        // 豁免：第二层确认弹窗（勾选风险在第一层，见行的展开区）
        h(UpdatesExemptDialogs, {
          pending: confirmSecond,
          t,
          onCancel: () => { setConfirmSecond(null); setExemptAck({}) },
          onConfirm: () => {
            const target = confirmSecond
            setConfirmSecond(null)
            setExemptAck({})
            if (target !== null) void exemptAndUpdate(target.row, target.incompatibility)
          },
        }),
      )

      /**
       * 渲染一行。
       * @param {object} row - 行数据。
       * @returns {object} React 元素。
       */
      function renderRow(row) {
        const key = row.key
        const exempt = text(exempted[seen(row.name, row.latest)]) !== ''
        const incompatible = row.incompatible === true && !exempt
        const selectable = selectableRow(row)
        const showExempt = incompatible && canExempt(row)
        const exemptOpen = showExempt && exemptPanels[key] === true
        const acked = ackOf(key)
        return h('div', {
          className: 'pmu-row', key, 'data-tone': incompatible ? 'bad' : undefined,
          'data-busy': busy === `exempt:${row.name}` ? 'true' : undefined,
        },
        h('div', { className: 'pmu-rowMain' },
          h('input', {
            type: 'checkbox', className: 'pmu-check', 'aria-label': row.name,
            checked: selected[key] === true, disabled: !selectable || busy !== '',
            onChange: () => { toggleSelect(key, selected[key] !== true) },
          }),
          // 插件名（网格第 2 列，吃剩余空间；过长省略号 + title 显示全名）。
          openPackage !== null
            ? h('button', {
              type: 'button', className: 'pmu-name pmu-nameLink pmu-nameCell', title: row.name,
              onClick: () => { openDetails(row.name) },
            }, row.name)
            : h('span', { className: 'pmu-name pmu-nameCell', title: row.name }, row.name),
          // 中间固定列：来源 → 版本变动（所有行共享同一轨道，垂直对齐）。
          h(KindBadge, { kind: row.kind, t }),
          h('span', { className: 'pmu-versions' },
            row.current === '' ? t('updatesUnknownVersion') : row.current,
            h('span', { className: 'pmu-arrow' }, '→'),
            row.latest === '' ? t('updatesUnknownVersion') : row.latest),
          // 弹性空隙 + 已禁用列（空也占位）+ 主状态列 + 操作列（右对齐、内部可换行）。
          h('span', { className: 'pmu-spacer' }),
          h(DisabledBadge, { row, t }),
          h(StatusBadge, { row, exempted: exempt, t }),
          h('span', { className: 'pmu-rowActions' },
            h('button', {
              type: 'button', className: 'pmp-btn pmp-btnPrimary',
              disabled: !selectable || incompatible || busy !== '',
              onClick: () => { openConfirm({ rows: [row] }) },
            }, t('updatesRowUpdate')),
            showExempt && h('button', {
              type: 'button', className: 'pmp-btn pmp-btnDanger',
              'aria-expanded': exemptOpen ? 'true' : 'false',
              disabled: busy !== '',
              onClick: () => { toggleExemptPanel(key) },
            }, t('updatesExemptEntry'))) ),

        // 版本豁免：入口展开风险勾选 → 「豁免此版本并更新」 → 二次确认弹窗 → POST /updates/exempt
        exemptOpen && h('div', { className: 'pmu-detail pmu-exempt' },
          h('p', { className: 'pmu-hint' }, t('updatesExemptIntro')),
          h('label', { className: 'pmu-ack' },
            h('input', {
              type: 'checkbox', className: 'pmu-check', 'aria-label': t('updatesExemptAck'),
              checked: acked, disabled: busy !== '',
              onChange: () => { setAck(key, !acked) },
            }),
            t('updatesExemptAck')),
          h('div', { className: 'pmu-rowActions' },
            h('button', {
              type: 'button', className: 'pmp-btn pmp-btnDanger',
              disabled: acked !== true || busy !== '',
              onClick: () => { setConfirmSecond({ row, incompatibility: row.incompatibility }) },
            }, busy === `exempt:${row.name}` ? t('updatesExemptDoing') : t('updatesExemptFlow')))))
      }

      /** 清掉阶段历史（关闭进度视图时）。 */
      function setStagesRefSafe() {
        stagesRef.current = {}
      }
    }

    /**
     * 豁免流程的第二层：风险说明 + 二次确认弹窗。
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function UpdatesExemptDialogs(props) {
      const { pending, t, onCancel, onConfirm } = props
      if (pending === null || pending === undefined) return null
      const row = pending.row
      const incompatibility = rec(pending.incompatibility)
      const runtime = text(incompatibility.runtimeVersion) || '—'
      return h(UpdatesModal, { title: t('updatesExemptConfirmTitle'), onClose: onCancel },
        h('p', { className: 'pmu-modalBody' }, t('updatesExemptConfirmBody', { pkg: `${row.name}@${row.latest}`, runtime, target: row.latest })),
        h('p', { className: 'pmu-hint' }, t('updatesExemptIntro')),
        h('p', { className: 'pmu-hint' }, `${row.name}@${row.latest} × DSH ${runtime}`),
        h('div', { className: 'pmu-modalActions' },
          h('button', { type: 'button', className: 'pmp-btn', onClick: onCancel }, t('updatesCancel')),
          h('button', { type: 'button', className: 'pmp-btn pmp-btnDanger', onClick: onConfirm }, t('updatesExemptConfirmYes'))))
    }

    /**
     * GET 同源 JSON。
     * @param {string} path - API 子路径。
     * @returns {Promise<object>} 响应体。
     */
    async function getJson(path) {
      const response = await fetch(api(path), { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      const payload = await readBody(response)
      if (!response || response.ok !== true) throw new Error(messageOf(payload, response))
      if (payload.ok === false) throw new Error(messageOf(payload, response))
      return payload
    }

    /**
     * POST 同源 JSON。
     * @param {string} path - API 子路径。
     * @param {object} body - 请求体。
     * @returns {Promise<object>} 响应体。
     */
    async function postJson(path, body) {
      const response = await fetch(api(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      })
      const payload = await readBody(response)
      if (!response || response.ok !== true) throw new Error(messageOf(payload, response))
      if (payload.ok === false) throw new Error(messageOf(payload, response))
      return payload
    }

    /**
     * 读取响应体（非 JSON 时退化成文本）。
     * @param {object} response - fetch 响应。
     * @returns {Promise<object>} 响应体。
     */
    async function readBody(response) {
      if (typeof response?.json === 'function') {
        try {
          return rec(await response.json())
        } catch {
          return {}
        }
      }
      if (typeof response?.text === 'function') {
        try {
          const raw = await response.text()
          return raw === '' ? {} : { message: raw }
        } catch {
          return {}
        }
      }
      return {}
    }

    /**
     * 组装错误信息。
     * @param {object} payload - 响应体。
     * @param {object} response - fetch 响应。
     * @returns {string} 错误文本。
     */
    function messageOf(payload, response) {
      const message = text(rec(payload).message) || text(rec(payload).error)
      if (message !== '') return message
      const status = num(response?.status, 0)
      return status > 0 ? `HTTP ${status}` : 'request failed'
    }

    return {
      inject: ['slots', 'locale'],
      /** 纯逻辑/常量出口，仅供自检脚本读取；不参与运行时行为。 */
      inspectable,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: I18N.zh, en: I18N.en }), 'dsh-pluginmarket-plus: dictionaries')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-pluginmarket-plus'
          style.dataset.pluginCss = 'dsh-pluginmarket-plus/cache.css'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'dsh-pluginmarket-plus: styles')

        const t = ctx.locale.bind(NS)

        // 插件页（Plugins）「插件源缓存」标签：排在自带的 Discover 之后、「可更新」之前。
        ctx.slots.inject(UPDATES_SLOT, () => ctx.slots.register({
          name: UPDATES_SLOT,
          id: CACHE_ID,
          order: CACHE_ORDER,
          label: () => t('cacheTab'),
          locale: NS,
          inject: () => ({ t }),
        }, MarketCacheSection))

        // 插件页（Plugins）新增「可更新」标签：排在自带的 Installed / Discover 之后。
        // 数据只走同源 /api/pluginmarket-plus/updates*；「详情」复用官方详情页。
        ctx.slots.inject(UPDATES_SLOT, () => ctx.slots.register({
          name: UPDATES_SLOT,
          id: UPDATES_ID,
          order: UPDATES_ORDER,
          label: () => t('updatesTab'),
          locale: NS,
          inject: () => ({ t }),
        }, UpdatesSection))
      },
    }
  },
})
