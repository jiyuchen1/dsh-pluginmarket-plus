/**
 * dsh-pluginmarket-plus —— 插件市场索引本地缓存（Host 半边）。
 *
 * ## 它解决什么问题
 *
 * 官方插件市场（插件页 → 发现）由 `pluginMarket` 服务读取索引源，单次抓取限时
 * 15 秒、失败不落盘。真实的索引动辄 1–8 MB，从这里访问 `cdn.dsh.so` 要 80 秒、
 * `api.dshfind.com` 要 18 秒，于是「搜索不出来 / 索引超时」。本插件在后台用更长
 * 的时间窗把索引抓下来、写到本地磁盘，再通过本机 HTTP 路由提供一份镜像；把发现页
 * 的索引源换成本地镜像后，抓取是毫秒级的，搜索不再超时。
 *
 * ## 组成
 *
 * - 磁盘缓存：`<profile>/.pluginmarket-plus/index-<id>.json` + `state.json`。
 * - 定时刷新：默认每 4 小时一次（可关、可调）；启动时补一次过期/缺失的源。
 * - 本地镜像：`http://127.0.0.1:<port>/pluginmarket-plus/index/<id>.json`。
 *   这份路由必须免登录——`pluginMarket` 是在 Host 进程里用裸 `fetch` 取索引的。
 * - 设置页桥：`/api/pluginmarket-plus/*`（经 `connection.fetch`，仅 owner 可访问）。
 * - 发现页接管：把 `plugin-market` 的 `indexes` 在「上游地址」和「本地镜像」之间
 *   切换；只替换已经缓存成功的源，没缓存成功的继续保持直连。
 *
 * @module dsh-pluginmarket-plus
 */

import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { CacheStore, sourceId } from './store.js'
import { fetchIndex, indexTitle, messageOf } from './refresh.js'

/** 包名（Client 模块 id 必须与它一致）。 */
export const name = 'dsh-pluginmarket-plus'

/** 本地镜像路由前缀。 */
export const MIRROR_PATH = '/pluginmarket-plus/index'

/** 公开状态路由（只读，便于排查问题）。 */
const PUBLIC_STATUS_PATH = '/pluginmarket-plus/status.json'

/** 设置页桥前缀。 */
const API_PREFIX = '/api/pluginmarket-plus'

/** 镜像 id 的路径匹配。 */
const MIRROR_ID = /^\/pluginmarket-plus\/index\/([a-f0-9]{16})\.json$/u

/** 最长 7 天的刷新间隔，避免 setTimeout 溢出。 */
const MAX_INTERVAL_HOURS = 168

/** 配置。面板上可改的字段都声明为 volatile，修改后无需重载插件。 */
export const Config = z.object({
  /** 要缓存的索引源；留空时自动接管「发现」页当前配置的源。 */
  sources: z.array(z.string()).default([]).volatile(),
  /** 是否按间隔自动刷新。 */
  autoRefresh: z.boolean().default(true).volatile(),
  /** 自动刷新间隔（小时）。 */
  refreshIntervalHours: z.number().min(0.25).max(MAX_INTERVAL_HOURS).default(4).volatile(),
  /** 是否让「发现」页优先使用本地镜像。 */
  managePluginMarket: z.boolean().default(true).volatile(),
  /** 单次抓取超时（毫秒）。索引很大，默认给到 2 分钟。 */
  fetchTimeoutMs: z.natural().min(1000).default(120000),
  /** 单个索引正文上限（字节）。 */
  maxBytes: z.natural().min(1).default(64 * 1024 * 1024),
  /** 失败重试次数。 */
  retries: z.natural().min(0).max(5).default(2),
  /** 缓存目录，相对 profile 目录。 */
  cacheDir: z.string().default('.pluginmarket-plus'),
})

/**
 * 读取一个可能是 volatile 引用的配置值。
 * @param {unknown} value - 配置字段（普通值或 `{ get() }` 引用）。
 * @param {unknown} fallback - 引用缺失时的回退值。
 * @returns {unknown} 当前值。
 */
function live(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof (/** @type {{ get?: unknown }} */ (value).get) === 'function') {
    return /** @type {{ get: () => unknown }} */ (value).get()
  }
  return value ?? fallback
}

/**
 * 归一化源列表：只保留 http(s) 绝对地址、去重、保持顺序。
 * @param {unknown} list - 原始列表。
 * @returns {string[]} 归一化后的地址。
 */
function normalizeSources(list) {
  if (!Array.isArray(list)) return []
  const urls = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    let url
    try {
      url = new URL(text).href
    } catch {
      continue
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

/**
 * 从一个地址里读出镜像 id。
 * @param {string} url - 任意地址。
 * @returns {string|undefined} 镜像 id；不是本插件的镜像地址时为 undefined。
 */
export function mirrorIdOf(url) {
  try {
    const pathname = new URL(url).pathname
    return MIRROR_ID.exec(pathname)?.[1]
  } catch {
    return undefined
  }
}

/**
 * 构造某个源的本地镜像地址。
 * @param {string} origin - 本机 Web 服务根地址，例如 `http://127.0.0.1:3080`。
 * @param {string} url - 上游索引地址。
 * @returns {string} 镜像地址。
 */
export function mirrorUrl(origin, url) {
  return `${origin}${MIRROR_PATH}/${sourceId(url)}.json`
}

/**
 * 两个地址列表是否等价（顺序敏感）。
 * @param {string[]} left - 列表一。
 * @param {string[]} right - 列表二。
 * @returns {boolean} 等价时为 true。
 */
function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * 读 JSON 请求体。
 * @param {Request} request - Fetch 请求。
 * @returns {Promise<Record<string, unknown>>} 解析后的对象；空体返回 {}。
 */
async function readJsonBody(request) {
  const text = await request.text()
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? /** @type {Record<string, unknown>} */ (parsed)
    : {}
}

/**
 * 构造 JSON 响应。
 * @param {unknown} payload - 响应体。
 * @param {number} [status] - HTTP 状态码。
 * @returns {Response} Fetch 响应。
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 插件主函数。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {z.infer<typeof Config>} config - 插件配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const profileDir = ctx.get('profileContext')?.dir ?? process.env.DSH_PROFILE_DIR ?? process.cwd()
  const cacheDir = resolve(profileDir, String(config.cacheDir ?? '.pluginmarket-plus'))
  const store = new CacheStore(cacheDir)

  /** @type {import('@deepseek-ai/cordis').Context|undefined} */
  let webService
  /** @type {any} */
  let marketService
  /** @type {Map<string, Promise<unknown>>} */
  const inflight = new Map()
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let refreshTimer
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let bootTimer
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let marketChangeTimer
  let nextRefreshAt = 0
  let marketError = null
  /** 本插件最近一次写进「发现」页的完整列表，用来识别“这是我自己写的”事件。 */
  let lastWrittenIndexes = []

  const entryId = ctx.fiber?.entry?.options?.id
  const logger = {
    info: (/** @type {string} */ message, /** @type {unknown} */ detail) => ctx.logger?.info?.(`dsh-pluginmarket-plus: ${message}`, detail),
    warn: (/** @type {string} */ message, /** @type {unknown} */ detail) => ctx.logger?.warn?.(`dsh-pluginmarket-plus: ${message}`, detail),
  }

  /**
   * 当前生效的源：配置里写了就用配置，否则用自动接管时记住的列表。
   * @returns {string[]} 源列表。
   */
  function effectiveSources() {
    const configured = normalizeSources(live(config.sources, []))
    if (configured.length > 0) return configured
    return normalizeSources(store.sources)
  }

  /**
   * 本机 Web 服务根地址；服务尚未 listen 时返回空串。
   * @returns {string} 例如 `http://127.0.0.1:3080`。
   */
  function origin() {
    try {
      return webService?.getOrigin?.() ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 通过 Settings 服务写本插件自己的配置字段。
   * @param {Record<string, unknown>} patch - 要写入的字段。
   * @returns {Promise<boolean>} 是否写入成功。
   */
  async function writeConfig(patch) {
    const settings = ctx.get('settings')
    if (settings === undefined || entryId === undefined) return false
    try {
      const descriptors = settings.describe()
      const descriptor = Array.isArray(descriptors) ? descriptors.find(item => item?.ns === entryId) : undefined
      const ops = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }))
      if (ops.length === 0) return true
      await settings.mutate(entryId, ops, descriptor?.revision)
      return true
    } catch (error) {
      logger.warn(`保存配置失败：${messageOf(error)}`)
      return false
    }
  }

  /**
   * 当前每个源的展示状态。
   * @returns {object[]} 状态数组。
   */
  function sourceStatuses() {
    const base = origin()
    const hours = Number(live(config.refreshIntervalHours, 4))
    const intervalMs = hours * 3600_000
    return effectiveSources().map((url) => {
      const id = sourceId(url)
      const entry = store.entry(id)
      const hasBody = store.hasBody(id)
      const refreshing = inflight.has(id)
      const ageMs = typeof entry?.fetchedAt === 'number' ? Date.now() - entry.fetchedAt : undefined
      /** @type {'ok'|'stale'|'empty'|'error'} */
      let state
      if (!hasBody) state = 'empty'
      else if (entry?.error) state = 'error'
      else if (ageMs !== undefined && intervalMs > 0 && ageMs > intervalMs) state = 'stale'
      else state = 'ok'
      return {
        id,
        url,
        mirrorUrl: base === '' ? '' : mirrorUrl(base, url),
        state,
        refreshing,
        fetchedAt: entry?.fetchedAt ?? null,
        ageMs: ageMs ?? null,
        bytes: entry?.bytes ?? null,
        plugins: entry?.plugins ?? null,
        title: indexTitle(entry?.title),
        error: entry?.error ?? null,
        errorAt: entry?.errorAt ?? null,
      }
    })
  }

  /**
   * 汇总状态（公开状态路由与设置页共用）。
   * @returns {object} 状态对象。
   */
  function statusPayload() {
    /** @type {string[]} */
    let indexes = []
    /** @type {{url: string, title: string, error: string|null}[]} */
    let summaries = []
    if (marketService !== undefined) {
      try {
        const listed = marketService.listIndexes()
        indexes = listed.map((item) => item.url)
        summaries = listed.map(item => ({ url: item.url, title: indexTitle(item.title), error: item.error ?? null }))
      } catch {
        indexes = []
        summaries = []
      }
    }
    return {
      ok: true,
      origin: origin(),
      mirrorBase: origin() === '' ? '' : `${origin()}${MIRROR_PATH}`,
      cacheDir,
      entryId: entryId ?? null,
      nextRefreshAt: nextRefreshAt || null,
      config: {
        autoRefresh: live(config.autoRefresh, true) !== false,
        refreshIntervalHours: Number(live(config.refreshIntervalHours, 4)),
        managePluginMarket: live(config.managePluginMarket, true) !== false,
        fetchTimeoutMs: Number(config.fetchTimeoutMs ?? 120000),
        maxBytes: Number(config.maxBytes ?? 64 * 1024 * 1024),
        retries: Number(config.retries ?? 2),
      },
      sources: sourceStatuses(),
      pluginMarket: {
        available: marketService !== undefined,
        managed: indexes.some(url => mirrorIdOf(url) !== undefined),
        indexes,
        summaries,
        error: marketError,
      },
      writable: ctx.get('settings') !== undefined && entryId !== undefined,
    }
  }

  /**
   * 刷新一个源；同一源并发调用共享一次抓取。
   * @param {string} url - 上游索引地址。
   * @returns {Promise<unknown>} 抓取结果。
   */
  function refreshOne(url) {
    const id = sourceId(url)
    const running = inflight.get(id)
    if (running !== undefined) return running
    const promise = (async () => {
      const startedAt = Date.now()
      try {
        const fetched = await fetchIndex(url, {
          timeoutMs: Number(config.fetchTimeoutMs ?? 120000),
          maxBytes: Number(config.maxBytes ?? 64 * 1024 * 1024),
          retries: Number(config.retries ?? 2),
        })
        store.writeBody(id, fetched.bytes)
        store.update(id, {
          url,
          fetchedAt: Date.now(),
          bytes: fetched.bytes.byteLength,
          plugins: fetched.plugins,
          title: fetched.title,
          error: null,
        })
        logger.info(`已缓存 ${url}`, { bytes: fetched.bytes.byteLength, plugins: fetched.plugins, ms: Date.now() - startedAt })
        return fetched
      } catch (error) {
        store.update(id, { url, error: messageOf(error), errorAt: Date.now() })
        logger.warn(`抓取失败 ${url}`, { error: messageOf(error) })
        throw error
      } finally {
        store.save()
        inflight.delete(id)
      }
    })()
    inflight.set(id, promise)
    return promise
  }

  /**
   * 刷新若干源；不传 urls 时刷新全部。
   * @param {{urls?: string[]}} [options] - 目标源。
   * @returns {Promise<{url: string, ok: boolean, error?: string}[]>} 每个源的结果。
   */
  async function refreshMany(options = {}) {
    const sources = effectiveSources()
    const targets = options.urls === undefined ? sources : sources.filter(url => options.urls?.includes(url))
    if (targets.length === 0) return []
    const results = await Promise.allSettled(targets.map(url => refreshOne(url)))
    await syncMarket()
    return results.map((result, index) => ({
      url: targets[index],
      ok: result.status === 'fulfilled',
      ...(result.status === 'rejected' ? { error: messageOf(result.reason) } : {}),
    }))
  }

  /**
   * 只刷新缺失或已过期的源（启动时用，避免每次启动都全量下载）。
   * @returns {Promise<void>} 完成。
   */
  async function refreshDue() {
    const hours = Number(live(config.refreshIntervalHours, 4))
    const intervalMs = hours * 3600_000
    const due = effectiveSources().filter((url) => {
      const id = sourceId(url)
      if (!store.hasBody(id)) return true
      const fetchedAt = store.entry(id)?.fetchedAt
      return typeof fetchedAt !== 'number' || Date.now() - fetchedAt > intervalMs
    })
    if (due.length > 0) await refreshMany({ urls: due })
  }

  /**
   * 把「发现」页的索引源同步为本地镜像（只替换已缓存成功的源）。
   * @param {boolean} [ensureAll] - 为 true 时把本插件清单里、发现页还没有的源补进去
   *   （在缓存插件页新增源时用）。
   * @returns {Promise<void>} 完成。
   */
  async function syncMarket(ensureAll = false) {
    if (marketService === undefined) return
    if (live(config.managePluginMarket, true) === false) return
    const base = origin()
    if (base === '') return
    try {
      const current = marketService.listIndexes().map((item) => item.url)
      const sources = effectiveSources()
      const known = new Set(sources)
      /** 已出现在发现页列表里的上游地址，避免 ensureAll 重复追加。 */
      const seen = new Set()
      /** @type {string[]} */
      const desired = []
      for (const url of current) {
        const mirror = mirrorIdOf(url)
        if (mirror !== undefined) {
          const upstream = store.entry(mirror)?.url ?? sources.find(source => sourceId(source) === mirror)
          // 镜像对应的源已经不存在（被移除或清单丢了）：直接把它从列表里去掉，
          // 而不是留下一个可能 404 的地址。
          if (upstream === undefined) continue
          seen.add(upstream)
          if (known.has(upstream)) desired.push(store.hasBody(mirror) ? mirrorUrl(base, upstream) : upstream)
          else desired.push(upstream)
          continue
        }
        seen.add(url)
        desired.push(known.has(url) && store.hasBody(sourceId(url)) ? mirrorUrl(base, url) : url)
      }
      if (ensureAll) {
        for (const url of sources) {
          if (seen.has(url)) continue
          desired.push(store.hasBody(sourceId(url)) ? mirrorUrl(base, url) : url)
        }
      }
      if (sameList(current, desired)) {
        marketError = null
        return
      }
      lastWrittenIndexes = desired.slice()
      await marketService.setIndexes(desired)
      marketError = null
      logger.info('已更新「发现」页索引源', { indexes: desired })
    } catch (error) {
      marketError = messageOf(error)
      logger.warn(`更新「发现」页索引源失败：${marketError}`)
    }
  }

  /**
   * 把「发现」页的索引源还原成上游地址。
   * @returns {Promise<void>} 完成。
   */
  async function restoreMarket() {
    if (marketService === undefined) return
    try {
      const current = marketService.listIndexes().map((item) => item.url)
      const desired = current.map((url) => {
        const mirror = mirrorIdOf(url)
        if (mirror === undefined) return url
        return store.entry(mirror)?.url ?? url
      })
      if (sameList(current, desired)) return
      lastWrittenIndexes = desired.slice()
      await marketService.setIndexes(desired)
      marketError = null
      logger.info('已还原「发现」页索引源', { indexes: desired })
    } catch (error) {
      marketError = messageOf(error)
      logger.warn(`还原「发现」页索引源失败：${marketError}`)
    }
  }

  /**
   * 从「发现」页当前配置里接管还没有镜像的上游地址。
   * @returns {Promise<void>} 完成。
   */
  async function adoptFromMarket() {
    if (marketService === undefined) return
    const configured = normalizeSources(live(config.sources, []))
    if (configured.length > 0) return
    const remembered = normalizeSources(store.sources)
    if (remembered.length > 0) {
      // 之前已经接管过：把上游清单补写进配置，避免缓存目录丢失后无法还原。
      await writeConfig({ sources: remembered })
      return
    }
    let current = []
    try {
      current = marketService.listIndexes().map((item) => item.url)
    } catch {
      return
    }
    const upstreams = current.filter(url => mirrorIdOf(url) === undefined)
    const normalized = normalizeSources(upstreams)
    if (normalized.length === 0) return
    store.sources = normalized
    store.save()
    // 上游清单同时写进插件配置：即使缓存目录被清掉，也知道该回到哪些地址。
    await writeConfig({ sources: normalized })
    logger.info('已接管「发现」页索引源', { sources: normalized })
  }

  /**
   * 把「发现」页上的增删同步回本插件的源清单。
   *
   * 用户在发现页自己加了一个原始索引地址 → 收进清单并立刻缓存，缓存成功后再换成镜像；
   * 用户删掉一个镜像 → 对应上游也从清单和磁盘里移除。本插件自己写索引源时列表与
   * `lastWrittenIndexes` 相同，直接跳过，避免来回抖动。
   * @returns {Promise<void>} 完成。
   */
  async function reconcileFromMarket() {
    if (marketService === undefined) return
    let current = []
    try {
      current = marketService.listIndexes().map((item) => item.url)
    } catch {
      return
    }
    if (sameList(current, lastWrittenIndexes)) return
    const previous = effectiveSources()
    /** @type {string[]} */
    const upstreams = []
    for (const url of current) {
      const mirror = mirrorIdOf(url)
      if (mirror === undefined) {
        upstreams.push(url)
        continue
      }
      const upstream = store.entry(mirror)?.url ?? previous.find(source => sourceId(source) === mirror)
      if (upstream !== undefined) upstreams.push(upstream)
    }
    const next = normalizeSources(upstreams)
    const added = next.filter(url => !previous.includes(url))
    const removed = previous.filter(url => !next.includes(url))
    if (added.length === 0 && removed.length === 0) return
    store.sources = next
    for (const url of removed) store.remove(sourceId(url))
    store.save()
    await writeConfig({ sources: next })
    if (added.length > 0) await refreshMany({ urls: added })
    else await syncMarket()
    logger.info('已同步「发现」页的索引源变更', { added, removed })
  }

  /** 重新安排下一次自动刷新。 */
  function schedule() {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = undefined
    nextRefreshAt = 0
    if (live(config.autoRefresh, true) === false) return
    const hours = Number(live(config.refreshIntervalHours, 4))
    if (!Number.isFinite(hours) || hours <= 0) return
    const delay = Math.min(Math.max(hours * 3600_000, 60_000), MAX_INTERVAL_HOURS * 3600_000)
    nextRefreshAt = Date.now() + delay
    refreshTimer = setTimeout(() => {
      void refreshMany().catch(error => logger.warn(`定时刷新失败：${messageOf(error)}`)).finally(schedule)
    }, delay)
  }

  // --- 公开镜像路由（必须免登录：pluginMarket 在 Host 进程里裸 fetch）---------
  ctx.inject(['webServer'], (webCtx) => {
    webService = webCtx.webServer
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: MIRROR_PATH,
      async handler(req, res) {
        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const id = MIRROR_ID.exec(pathname)?.[1]
        const body = id === undefined ? undefined : store.readBody(id)
        if (body === undefined) {
          const message = id === undefined ? 'unknown mirror id' : 'index is not cached yet'
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: message }))
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.byteLength),
          'cache-control': 'no-store',
          'x-pluginmarket-plus': 'cached',
        })
        res.end(method === 'HEAD' ? undefined : body)
      },
    }), 'dsh-pluginmarket-plus: mirror route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PUBLIC_STATUS_PATH,
      async handler(req, res) {
        const body = JSON.stringify(statusPayload())
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(body)) })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    }), 'dsh-pluginmarket-plus: status route')
  })

  // --- 设置页 API（经 connection，只有 owner 浏览器能访问）-------------------
  ctx.inject(['connection'], (connCtx) => {
    /**
     * @param {string} path - `/api/...` 路径。
     * @param {('GET'|'POST')[]} methods - 允许的方法。
     * @param {(request: Request) => Promise<Response>} fetch - 处理函数。
     */
    const route = (path, methods, handler) => {
      connCtx.effect(() => connCtx.connection.fetch.register({
        path,
        methods,
        requestBody: 'buffered',
        fetch: handler,
      }), `dsh-pluginmarket-plus: ${path}`)
    }

    route(`${API_PREFIX}/status`, ['GET'], async () => jsonResponse(statusPayload()))

    route(`${API_PREFIX}/refresh`, ['POST'], async (request) => {
      try {
        const body = await readJsonBody(request)
        const url = typeof body.url === 'string' ? body.url : undefined
        if (url !== undefined && !effectiveSources().includes(url)) {
          return jsonResponse({ ok: false, error: 'unknown-source', message: `未配置的源：${url}` }, 400)
        }
        const results = await refreshMany(url === undefined ? {} : { urls: [url] })
        return jsonResponse({ ok: true, results, status: statusPayload() })
      } catch (error) {
        return jsonResponse({ ok: false, error: 'refresh-failed', message: messageOf(error) }, 500)
      }
    })

    route(`${API_PREFIX}/settings`, ['POST'], async (request) => {
      try {
        const body = await readJsonBody(request)
        /** @type {Record<string, unknown>} */
        const patch = {}
        /** @type {string[]} */
        let added = []
        if (typeof body.autoRefresh === 'boolean') patch.autoRefresh = body.autoRefresh
        if (body.refreshIntervalHours !== undefined) {
          const hours = Number(body.refreshIntervalHours)
          if (!Number.isFinite(hours) || hours < 0.25 || hours > MAX_INTERVAL_HOURS) {
            return jsonResponse({ ok: false, error: 'invalid-interval', message: '刷新间隔需在 0.25–168 小时之间' }, 400)
          }
          patch.refreshIntervalHours = hours
        }
        if (typeof body.managePluginMarket === 'boolean') patch.managePluginMarket = body.managePluginMarket
        if (body.sources !== undefined) {
          const next = normalizeSources(body.sources)
          const previous = effectiveSources()
          const removed = previous.filter(url => !next.includes(url))
          added = next.filter(url => !previous.includes(url))
          store.sources = next
          for (const url of removed) store.remove(sourceId(url))
          store.save()
          patch.sources = next
        }
        const saved = await writeConfig(patch)
        if (added.length > 0) await refreshMany({ urls: added })
        if (patch.managePluginMarket === false) await restoreMarket()
        else if (patch.managePluginMarket === true || patch.sources !== undefined) await syncMarket(patch.sources !== undefined)
        schedule()
        return jsonResponse({ ok: true, saved, status: statusPayload() })
      } catch (error) {
        return jsonResponse({ ok: false, error: 'settings-failed', message: messageOf(error) }, 500)
      }
    })

    route(`${API_PREFIX}/market`, ['POST'], async (request) => {
      try {
        const body = await readJsonBody(request)
        const action = typeof body.action === 'string' ? body.action : 'apply'
        if (action === 'restore') await restoreMarket()
        else await syncMarket(true)
        return jsonResponse({ ok: true, status: statusPayload() })
      } catch (error) {
        return jsonResponse({ ok: false, error: 'market-failed', message: messageOf(error) }, 500)
      }
    })
  })

  // --- 发现页服务：接管已有索引源、首次补缓存、定时刷新 ----------------------
  ctx.inject(['pluginMarket'], (marketCtx) => {
    marketService = marketCtx.pluginMarket
    void (async () => {
      await adoptFromMarket()
      await reconcileFromMarket()
      await syncMarket()
      await refreshDue()
      schedule()
    })().catch(error => logger.warn(`接管「发现」页索引源失败：${messageOf(error)}`))
  })

  // 用户在「发现 → 索引源」里增删时，跟随同步（防抖，忽略本插件自己的写入）。
  ctx.on('plugin-market/changed', () => {
    if (marketChangeTimer !== undefined) clearTimeout(marketChangeTimer)
    marketChangeTimer = setTimeout(() => {
      marketChangeTimer = undefined
      void reconcileFromMarket().catch(error => logger.warn(`同步索引源失败：${messageOf(error)}`))
    }, 600)
  })

  // 启动后补一次缺失/过期的缓存；此时 Web 服务与插件市场服务都已就位。
  bootTimer = setTimeout(() => {
    void refreshDue()
      .catch(error => logger.warn(`启动刷新失败：${messageOf(error)}`))
      .finally(schedule)
  }, 2000)

  // 配置热更新后重新排期。
  ctx.on('loader/volatile-update', () => {
    schedule()
  })

  ctx.effect(() => () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    if (bootTimer !== undefined) clearTimeout(bootTimer)
    if (marketChangeTimer !== undefined) clearTimeout(marketChangeTimer)
    // 卸载/停用时尽量把「发现」页的索引源还原成上游地址，避免留下指向已消失
    // 本地镜像的死链。失败也不影响卸载。
    if (live(config.managePluginMarket, true) !== false) {
      try {
        const current = marketService?.listIndexes?.().map((item) => item.url) ?? []
        if (current.some(url => mirrorIdOf(url) !== undefined)) void restoreMarket()
      } catch {
        // 服务已先一步销毁时忽略。
      }
    }
  }, 'dsh-pluginmarket-plus: timers')
}
