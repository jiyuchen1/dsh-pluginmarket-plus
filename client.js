/**
 * dsh-pluginmarket-plus —— 客户端半边（无构建步骤，直接由 __ModuleLoader__ 装载）。
 *
 * 一个设置页：插件市场缓存。展示每个索引源的缓存状态，提供「刷新」「改刷新间隔」
 * 「让发现页使用本地缓存」等操作。所有数据都来自 Host 的 `/api/pluginmarket-plus/*`
 * （经 connection 精确路由，只有 owner 浏览器能访问）。
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

    const I18N = {
      zh: {
        nav: '插件市场缓存',
        title: '插件市场缓存',
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
      },
      en: {
        nav: 'Plugin market cache',
        title: 'Plugin market cache',
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
      },
    }

    const CSS = [
      '.pmp-page{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);font:inherit}',
      '.pmp-title{margin:0;font-size:16px;font-weight:600;line-height:24px}',
      '.pmp-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.pmp-notice{display:flex;align-items:center;gap:8px;border-radius:var(--dsw-radius-md);padding:8px 10px;font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.pmp-notice[data-tone="ok"]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary)}',
      '.pmp-notice[data-tone="error"]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}',
      '.pmp-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.pmp-toolbarLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pmp-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.pmp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.pmp-btn:disabled{opacity:.45;cursor:default}',
      '.pmp-btnPrimary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color,#fff)}',
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
      '.pmp-switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}',
      '.pmp-switch[aria-checked="true"] .pmp-switchKnob{transform:translateX(14px)}',
      '.pmp-switchRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pmp-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.pmp-addRow{display:flex;gap:8px;flex-wrap:wrap}',
      '.pmp-input{flex:1 1 320px;min-width:0;height:30px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 10px}',
      '.pmp-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}',
      '.pmp-sectionLabel{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.pmp-codes{margin:0;font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
    ].join('\n')

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
     * 状态徽标。
     * @param {{state: string, t: Function}} props - 源状态与翻译函数。
     * @returns {object} React 元素。
     */
    function StatusBadge({ state, t }) {
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

      const load = React.useCallback(async () => {
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

      return h('div', { className: 'pmp-page' },
        h('h2', { className: 'pmp-title' }, t('title')),
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
            h(StatusBadge, { state: source.state, t }),
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

    /**
     * 设置导航图标（可选席位）。
     * @param {{size?: number, active?: boolean}} props - 图标尺寸与选中态。
     * @returns {object} React 元素。
     */
    function CacheIcon({ size, active }) {
      return h('svg', {
        width: size ?? 16,
        height: size ?? 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { color: active === true ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)' },
      },
      h('ellipse', { cx: 12, cy: 6.5, rx: 7, ry: 3 }),
      h('path', { d: 'M5 6.5v11c0 1.66 3.13 3 7 3s7-1.34 7-3v-11' }),
      h('path', { d: 'M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3' }))
    }

    return {
      inject: ['slots', 'locale'],
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

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'pluginmarket-plus',
          order: 41,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, MarketCacheSection))

        // 也放进「插件」设置页的页签里，和「发现」在同一处。
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'pluginmarket-plus',
          order: 55,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, MarketCacheSection))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'pluginmarket-plus',
          order: 41,
        }, CacheIcon))
      },
    }
  },
})
