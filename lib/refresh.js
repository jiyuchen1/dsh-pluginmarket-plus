/**
 * 抓取与规范化一个插件市场索引 JSON。
 *
 * 官方插件市场（`plugin-market` 服务）在 15 秒内抓不到索引就判失败，而真实的索引
 * 动辄几 MB、跨网络要几十秒，于是「搜索 → 索引超时」。这里用更长的时间窗抓取，
 * 校验格式 1 的基本结构，并把相对 icon 改写为绝对地址——因为镜像会从 localhost
 * 提供这份 JSON，相对地址在镜像源下会指向 localhost 而失效。
 *
 * @module dsh-pluginmarket-plus/lib/refresh
 */

/** 抓取时使用的 User-Agent。 */
const USER_AGENT = 'dsh-pluginmarket-plus/0.1 (+local index cache)'

/**
 * @typedef {object} FetchedIndex
 * @property {Buffer} bytes - 规范化后的 JSON 正文。
 * @property {number} plugins - 插件条数。
 * @property {unknown} title - 索引标题（LocalizedText）。
 */

/**
 * 把一条拒绝原因压成一行，便于写进状态清单。
 * @param {unknown} error - 任意抛出物。
 * @returns {string} 单行诊断。
 */
export function messageOf(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
    return `${error.message}${cause}`.replace(/\s+/gu, ' ').trim()
  }
  return String(error).replace(/\s+/gu, ' ').trim()
}

/**
 * 从 LocalizedText 里挑一个用于列表展示的标题。
 * @param {unknown} title - 索引的 title 字段。
 * @returns {string} 可展示文本；没有时返回空串。
 */
export function indexTitle(title) {
  if (typeof title === 'string') return title
  if (title !== null && typeof title === 'object' && !Array.isArray(title)) {
    const record = /** @type {Record<string, unknown>} */ (title)
    for (const key of ['zh', 'en']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  return ''
}

/**
 * 把相对 icon 引用改写成相对「上游索引地址」的绝对地址。
 *
 * 镜像地址与上游地址不同源，相对 icon 在镜像下会解析到 localhost；在缓存前改写，
 * 浏览器就会直接向上游取图。`data:` 与已是绝对地址的 icon 保持原样。
 * @param {unknown} document - 已解析的索引文档（就地修改）。
 * @param {string} indexUrl - 上游索引地址。
 * @returns {void}
 */
export function absolutizeIcons(document, indexUrl) {
  if (document === null || typeof document !== 'object') return
  const plugins = /** @type {{ plugins?: unknown }} */ (document).plugins
  if (!Array.isArray(plugins)) return
  for (const plugin of plugins) {
    if (plugin === null || typeof plugin !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (plugin)
    const icon = record.icon
    if (typeof icon !== 'string' || icon === '' || icon.startsWith('data:')) continue
    if (/^[a-z][a-z0-9+.-]*:/iu.test(icon)) {
      // 官方校验只接受 https 的 icon（或与索引同源的地址）；镜像源是 localhost，
      // 所以 http 的 icon 在镜像下必然失效，直接丢弃，交给默认图标。
      try {
        if (new URL(icon).protocol === 'http:') delete record.icon
      } catch {
        delete record.icon
      }
      continue
    }
    try {
      const resolved = new URL(icon, indexUrl)
      if (resolved.protocol !== 'https:') {
        delete record.icon
        continue
      }
      record.icon = resolved.href
    } catch {
      delete record.icon
    }
  }
}

/**
 * 校验索引文档的最小结构（完整校验由官方 `plugin-market` 在读取镜像时执行）。
 * @param {unknown} document - JSON.parse 的结果。
 * @param {string} indexUrl - 上游索引地址，用于补默认标题。
 * @returns {void}
 */
function assertIndexShape(document, indexUrl) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('索引不是 JSON 对象')
  const record = /** @type {Record<string, unknown>} */ (document)
  if (record.format !== 1) throw new Error(`不支持的索引格式 format=${String(record.format)}`)
  if (!Array.isArray(record.plugins)) throw new Error('索引缺少 plugins 数组')
  // 官方校验要求 title 为 LocalizedText；上游偶尔缺失，补一个宿主名，避免整份索引作废。
  const title = record.title
  const hasTitle = typeof title === 'string'
    ? title.trim() !== ''
    : title !== null && typeof title === 'object' && typeof (/** @type {Record<string, unknown>} */ (title).en) === 'string'
  if (!hasTitle) {
    let host = 'plugin market'
    try {
      host = new URL(indexUrl).hostname || host
    } catch {
      // 保留默认值。
    }
    record.title = { en: host }
  }
}

/**
 * 抓取一次索引。
 * @param {string} url - 上游索引地址。
 * @param {{ timeoutMs: number, maxBytes: number, userAgent?: string }} options - 抓取约束。
 * @returns {Promise<FetchedIndex>} 规范化后的正文与摘要。
 */
async function fetchOnce(url, options) {
  const signal = AbortSignal.timeout(options.timeoutMs)
  const response = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: { accept: 'application/json', 'user-agent': options.userAgent ?? USER_AGENT },
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${String(response.status)}`)
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > options.maxBytes) {
    await response.body?.cancel()
    throw new Error(`响应体 ${String(declared)} 字节，超过上限 ${String(options.maxBytes)}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > options.maxBytes) {
    throw new Error(`响应体 ${String(buffer.byteLength)} 字节，超过上限 ${String(options.maxBytes)}`)
  }
  const text = new TextDecoder('utf-8').decode(buffer)
  /** @type {unknown} */
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`响应不是合法 JSON: ${messageOf(error)}`)
  }
  assertIndexShape(document, url)
  absolutizeIcons(document, url)
  const normalized = Buffer.from(JSON.stringify(document), 'utf8')
  return {
    bytes: normalized,
    plugins: Array.isArray(/** @type {{ plugins: unknown[] }} */ (document).plugins) ? /** @type {{ plugins: unknown[] }} */ (document).plugins.length : 0,
    title: /** @type {{ title?: unknown }} */ (document).title,
  }
}

/**
 * 抓取索引，失败时按次数重试（网络抖动很常见，多试一次往往就过了）。
 * @param {string} url - 上游索引地址。
 * @param {{ timeoutMs: number, maxBytes: number, retries?: number, userAgent?: string }} options - 抓取约束。
 * @returns {Promise<FetchedIndex>} 规范化后的正文与摘要。
 */
export async function fetchIndex(url, options) {
  const retries = Math.max(0, options.retries ?? 0)
  /** @type {unknown} */
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchOnce(url, options)
    } catch (error) {
      lastError = error
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)))
    }
  }
  throw lastError
}
