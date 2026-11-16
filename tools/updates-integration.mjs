/**
 * t3 · 独立集成验证：「可更新」Host 半边（假 cordis ctx + 假 pluginManager + 假索引磁盘）。
 *
 * 这个脚本不是 `tools/updates-selftest.mjs` 的复用：它自己搭载入器、自己造假服务、
 * 自己写索引文件，只从**外部可观察契约**出发断言（HTTP 状态码、响应体、桥接路由注册
 * 形态、pluginManager 被怎么调、磁盘上留下什么）。
 *
 * 覆盖（对应 t3 验收条款）：
 *  1. 候选过滤矩阵：official / link: / file: / npm: 别名 / 未固定 commit 的 git /
 *     带插件管理组件 一律不出现；enabled:false 只在 updatesIncludeDisabled=true 出现；
 *     prerelease+deprecated 只在 updatesIncludePrerelease=true 出现（默认 skipped）。
 *  2. 检查两种来源：npm（pluginManager update:registry）→ listVersions(name)；git → 缓存索引里的 source.commit；
 *     索引缺失 → uncheckable 且不抛错。
 *  3. apply 顺序执行 + 失败继续；每项结果含 success/failed/restartRequired/restore；
 *     cancel 停队列 + 取消当前 requestId；stage/logs 来自 plugin-manager/* 事件。
 *  4. exempt 只在 acceptRisk===true 时调用 setVersionExemption(pkg@version, runtime, true, true)，
 *     缺 acceptRisk → 400。
 *  5. 6 个新路由都经 connection.fetch 注册、requestBody='buffered'、methods 正确；无自动更新路径。
 *
 * 跑法：`node tools/updates-integration.mjs`（只用 Node 内置模块，不发网络请求）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

// ---------------------------------------------------------------------------
// 载入器：lib/index.js 的 peer 依赖（@deepseek-ai/schemastery）由 DSH profile 提供，
// 插件目录里没有 node_modules。这里只补一条「解析失败再试 profile」的兜底规则，
// 不写任何文件，也不改变生产环境的解析方式。
// ---------------------------------------------------------------------------
function enablePeerResolution() {
  const candidates = []
  if (process.env.DSH_PROFILE_DIR !== undefined && process.env.DSH_PROFILE_DIR !== '') candidates.push(process.env.DSH_PROFILE_DIR)
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (home !== undefined) candidates.push(join(home, '.dsh', 'profiles', 'web'), join(home, '.dsh', 'profiles'))
  const roots = candidates.filter(dir => existsSync(dir))
  if (roots.length === 0) return false
  const requires = roots.map(dir => createRequire(join(dir, 'index.js')))
  /** 兜底解析的递归深度：`require.resolve()` 在 Node 24 里会再走一遍 ESM 钩子，必须设上限。 */
  let resolveDepth = 0
  registerHooks({
    resolve(specifier, context, nextResolve) {
      resolveDepth += 1
      if (resolveDepth > 3) {
        resolveDepth -= 1
        throw new Error(`解析兜底递归过深：${specifier}`)
      }
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) throw error
        for (const require of requires) {
          try {
            return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
          } catch {
            // 这个 root 里没有：试下一个。
          }
        }
        throw error
      } finally {
        resolveDepth -= 1
      }
    },
  })
  return true
}

const peerResolution = enablePeerResolution()

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------
let passed = 0
const failed = []
let currentSection = '(root)'

/** 切一节。 */
function section(title) {
  currentSection = title
  console.log(`\n== ${title}`)
}

/**
 * 断言为真。
 * @param {unknown} value - 条件。
 * @param {string} label - 说明。
 * @param {unknown} [detail] - 诊断。
 * @returns {void}
 */
function ok(value, label, detail) {
  if (value === true || (value !== false && value !== null && value !== undefined && value !== 0 && value !== '')) {
    passed += 1
    return
  }
  failed.push({ section: currentSection, label, detail: detail === undefined ? undefined : tryJson(detail) })
}

/**
 * 深度相等断言。
 * @param {unknown} actual - 实际。
 * @param {unknown} expected - 期望。
 * @param {string} label - 说明。
 * @returns {void}
 */
function eq(actual, expected, label) {
  const left = tryJson(actual)
  const right = tryJson(expected)
  ok(left === right, label, `实际 ${left} ≠ 期望 ${right}`)
}

/**
 * 安全 JSON。
 * @param {unknown} value - 任意值。
 * @returns {string} 字符串。
 */
function tryJson(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 必须为真，否则直接抛错（用于「后续断言以它为前提」的步骤）。
 * @param {unknown} value - 条件。
 * @param {string} label - 说明。
 * @returns {void}
 */
function must(value, label) {
  ok(value, label)
  if (!(value === true || (value !== false && value !== null && value !== undefined && value !== 0 && value !== ''))) {
    throw new Error(`前置条件不成立：${label}`)
  }
}

/**
 * 断言队列 `summary`：逐字段比对给定值，不要求对象全等。
 *
 * 队列汇总会随功能增加字段（t8 新增 `restartRequired` / `skipped`），全等断言会把
 * 「新增字段」误报成回归。这里改为：
 * - 已知字段必须存在且是数字（`total/success/failed/cancelled/restartRequired/skipped/pending`）；
 * - 只对调用方给出的字段断言精确值。
 * @param {unknown} summary - `/updates/state` 的 `summary`。
 * @param {Record<string, number>} expected - 期望精确值的字段。
 * @param {string} label - 用例名（会拼到每条断言里）。
 * @returns {void}
 */
function summaryMatches(summary, expected, label) {
  const value = summary !== null && typeof summary === 'object' ? /** @type {Record<string, unknown>} */ (summary) : {}
  for (const key of ['total', 'success', 'failed', 'cancelled', 'restartRequired', 'skipped', 'pending']) {
    ok(typeof value[key] === 'number', `${label}：summary.${key} 是数字`, value)
  }
  for (const [key, want] of Object.entries(expected)) {
    eq(value[key], want, `${label}：summary.${key}=${String(want)}`)
  }
}

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

/**
 * 轮询直到条件成立。
 * @param {(attempt: number) => unknown} probe - 探针。
 * @param {string} label - 失败说明。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<unknown>} 最后一次结果。
 */
async function waitFor(probe, label, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs
  for (let attempt = 0; Date.now() < until; attempt += 1) {
    const value = await probe(attempt)
    if (value) return value
    await sleep(10)
  }
  throw new Error(`等待超时：${label}`)
}

// ---------------------------------------------------------------------------
// 常量与假件
// ---------------------------------------------------------------------------
const API = '/api/pluginmarket-plus'
const ROUTE_CONTRACT = [
  { path: `${API}/updates`, methods: ['GET'] },
  { path: `${API}/updates/check`, methods: ['POST'] },
  { path: `${API}/updates/apply`, methods: ['POST'] },
  { path: `${API}/updates/state`, methods: ['GET'] },
  { path: `${API}/updates/cancel`, methods: ['POST'] },
  { path: `${API}/updates/exempt`, methods: ['POST'] },
]

const COMMIT_OLD = 'c'.repeat(40)
const COMMIT_NEW = 'd'.repeat(40)
const GIT_HTTPS_OLD = `git+https://github.com/acme/demo-git.git#${COMMIT_OLD}`

/** 一份最小假 Request（lib 只用 request.text()）。 */
class FakeRequest {
  /**
   * @param {string} url - 地址。
   * @param {{method?: string, body?: string|null, headers?: Record<string, string>}} [init] - 初始化。
   */
  constructor(url, init = {}) {
    this.url = url
    this.method = init.method ?? 'GET'
    this.headers = new Map(Object.entries(init.headers ?? {}))
    this._body = init.body ?? null
  }

  /** @returns {Promise<string>} 请求体文本。 */
  async text() {
    return this._body ?? ''
  }
}

/**
 * 造一个 bundle 条目（默认：已装、启用、pluginManager update:registry 可更新）。
 * @param {Record<string, unknown>} patch - 覆盖字段。
 * @returns {Record<string, unknown>} BundleInfo 形状的对象。
 */
function bundle(patch) {
  const name = typeof patch.name === 'string' ? patch.name : 'demo'
  return {
    name,
    version: '1.0.0',
    enabled: true,
    installed: true,
    official: false,
    availability: 'profile',
    source: `${name}@1.0.0`,
    update: 'registry',
    rows: [],
    removable: true,
    ...patch,
  }
}

/**
 * 假 pluginManager：记录每一次调用，并按名字给出预设结果。
 * @param {Record<string, unknown>[]} bundles - listBundles 的返回。
 * @param {{versionsBy?: Record<string, unknown>, versionsDefault?: unknown, outcomes?: Record<string, unknown>, delayMs?: number}} [options] - 行为。
 * @returns {object} 假服务。
 */
function makePluginManager(bundles, options = {}) {
  const calls = { listBundles: 0, listVersions: [], updateBundle: [], cancelInstall: [], waitForInstall: [], setVersionExemption: [], installBundle: [], removeBundle: [] }
  const versionLists = options.versionsBy ?? {}
  let bundleCursor = 0
  return {
    calls,
    versionLists,
    async listBundles() {
      calls.listBundles += 1
      // 第二次起换成本次运行读到的最新快照（模拟更新后 changed 事件重读），这里保持同一份。
      bundleCursor += 1
      return bundles
    },
    async listVersions(name) {
      calls.listVersions.push(name)
      if (Object.prototype.hasOwnProperty.call(versionLists, name)) return versionLists[name]
      return options.versionsDefault ?? { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }], omitted: 0 }
    },
    async updateBundle(name, version, updateOptions) {
      calls.updateBundle.push({ name, version, options: updateOptions })
      const outcome = options.outcomes?.[name]
      if (typeof outcome === 'function') return outcome(name, version, updateOptions)
      if (options.delayMs !== undefined && options.delayMs > 0) await sleep(options.delayMs)
      return outcome ?? applied(name, version)
    },
    async installBundle(spec) {
      calls.installBundle.push(spec)
      const outcome = options.installOutcomes?.[spec]
      if (typeof outcome === 'function') return outcome(spec)
      if (outcome !== undefined) return outcome
      return { changed: true, application: 'applied', stage: 'install', target: spec }
    },
    async removeBundle(name) {
      calls.removeBundle.push(name)
      const outcome = options.removeOutcomes?.[name]
      if (typeof outcome === 'function') return outcome(name)
      if (outcome !== undefined) return outcome
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async cancelInstall(requestId) {
      calls.cancelInstall.push(requestId)
      return { status: 'cancelled' }
    },
    async waitForInstall(requestId) {
      calls.waitForInstall.push(requestId)
      return null
    },
    async setVersionExemption(...args) {
      calls.setVersionExemption.push(args)
      return { changed: true, application: 'applied', stage: 'exempt', target: args[0] }
    },
    listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
  }
}

/**
 * `updateBundle` 成功返回形状（与官方 pluginManager 契约一致）。
 * @param {string} name - 包名。
 * @param {string} version - 目标版本。
 * @returns {object} 结果。
 */
function applied(name, version) {
  return { from: '1.0.0', to: version, step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: `${name}@${version}` } }
}

/**
 * `updateBundle` 失败并回滚的返回形状。
 * @param {string} name - 包名。
 * @param {string} version - 目标版本。
 * @returns {object} 结果。
 */
function rolledBack(name, version) {
  return {
    from: '1.0.0',
    to: version,
    step: 'check',
    result: { changed: false, application: 'failed', stage: 'check', target: `${name}@${version}`, error: { diagnostic: `不兼容：${name}@${version}` } },
    restore: { changed: true, application: 'applied', stage: 'restore', target: `${name}@1.0.0` },
  }
}

// ---------------------------------------------------------------------------
// 假 cordis 宿主
// ---------------------------------------------------------------------------
/**
 * 启动一个插件实例（真实 `lib/index.js`）挂在假 ctx 上。
 * @param {{config?: Record<string, unknown>, bundles?: Record<string, unknown>[], manager?: object, breakSettings?: boolean}} [options] - 选项。
 * @returns {Promise<object>} 实例句柄。
 */
async function boot(options = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'pmplus-t3-'))
  const values = {
    sources: [],
    autoRefresh: false,
    refreshIntervalHours: 4,
    managePluginMarket: false,
    fetchTimeoutMs: 3000,
    maxBytes: 1024 * 1024,
    retries: 0,
    cacheDir: '.pluginmarket-plus',
    updatesIncludeDisabled: false,
    updatesIncludePrerelease: false,
    ...options.config,
  }
  /** 每个配置字段都是 volatile 引用（`{ get() }`），与 DSH 里 `live()` 的读法一致。 */
  const config = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => values[key] }]))

  /** 只收 connection.fetch 注册的路由（t3 只关心这一条桥）。 */
  const fetchRoutes = new Map()
  /** webServer 与公开状态路由，另放一处，避免和桥接路由混在一起。 */
  const webRoutes = new Map()
  const effects = []
  const listeners = {}
  const warnLines = []
  const infoLines = []
  const logger = { info: (message) => { infoLines.push(String(message)) }, warn: (message) => { warnLines.push(String(message)) } }

  let revision = 1
  const settings = {
    describe: () => [{ ns: 'dsh-pluginmarket-plus', revision: () => revision }],
    mutate: async (ns, ops, expected) => {
      if (ns !== 'dsh-pluginmarket-plus') throw new Error(`未知命名空间 ${ns}`)
      if (options.breakSettings === true) throw new Error('settings 不可用')
      if (typeof expected === 'number' && expected !== revision) throw new Error('revision 过期')
      for (const op of ops) {
        if (op.op !== 'set' || !Array.isArray(op.path) || op.path.length !== 1) continue
        values[op.path[0]] = op.value
        config[op.path[0]] = { get: () => values[op.path[0]] }
      }
      revision += 1
      return { revision }
    },
  }

  const manager = options.manager ?? makePluginManager(options.bundles ?? [])
  const services = {
    profileContext: { dir: profileDir },
    settings,
    logger,
    webServer: {
      getOrigin: () => 'http://127.0.0.1:3080',
      register: definition => {
        webRoutes.set(definition.path, definition)
        return () => webRoutes.delete(definition.path)
      },
    },
    connection: {
      fetch: {
        register: definition => {
          fetchRoutes.set(definition.path, definition)
          return () => fetchRoutes.delete(definition.path)
        },
      },
    },
    pluginMarket: { listIndexes: () => [], setIndexes: async () => {} },
    pluginManager: manager,
  }

  /** 子上下文：inject 时只暴露被请求的服务名。 */
  function makeScope(names) {
    return {
      ...Object.fromEntries(names.map(name => [name, services[name]])),
      get: name => services[name],
      on,
      effect,
      fiber: { entry: { options: { id: 'dsh-pluginmarket-plus' } } },
      logger,
    }
  }

  /**
   * 注册事件监听；返回解绑函数。
   * @param {string} name - 事件名。
   * @param {Function} listener - 监听器。
   * @returns {() => void} 解绑。
   */
  function on(name, listener) {
    const list = listeners[name] ?? []
    list.push(listener)
    listeners[name] = list
    return () => {
      listeners[name] = (listeners[name] ?? []).filter(entry => entry !== listener)
    }
  }

  /**
   * 执行一次 effect；把返回值记成清理函数。
   * @param {Function} callback - 回调。
   * @param {string} [label] - 标签。
   * @returns {() => void} 解绑。
   */
  function effect(callback, label) {
    const entry = { label, dispose: callback() }
    effects.push(entry)
    return () => {
      entry.dispose?.()
      effects.splice(effects.indexOf(entry), 1)
    }
  }

  const ctx = {
    fiber: { entry: { options: { id: 'dsh-pluginmarket-plus' } } },
    logger,
    get: name => services[name],
    on,
    effect,
    inject: (names, callback) => {
      const missing = names.filter(name => services[name] === undefined)
      if (missing.length > 0) return
      callback(makeScope(names))
    },
    /**
     * 触发一个事件（等价于 mockCtx.emit）。
     * @param {string} name - 事件名。
     * @param {...unknown} args - 参数。
     * @returns {void}
     */
    emit(name, ...args) {
      for (const listener of listeners[name] ?? []) listener(...args)
    },
  }

  const plugin = await import('../lib/index.js')
  // 可选：在插件 apply 之前准备 profile 目录（例如预写 package.json / 中断日志，验证启动路径）。
  if (typeof options.prepare === 'function') await options.prepare(profileDir)
  plugin.apply(ctx, config)

  /**
   * 调一个桥接路由。
   * @param {string} path - 路径。
   * @param {{method?: string, body?: unknown}} [request] - 请求。
   * @returns {Promise<{status: number, body: any, text: string}>} 响应。
   */
  async function call(path, request = {}) {
    const route = fetchRoutes.get(path)
    if (route === undefined) throw new Error(`路由未注册：${path}`)
    const method = request.method ?? (route.methods.includes('GET') ? 'GET' : 'POST')
    const fake = new FakeRequest(`http://127.0.0.1:3080${path}`, {
      method,
      body: request.body === undefined ? null : JSON.stringify(request.body),
    })
    const response = await route.fetch(fake)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text), text }
  }

  return {
    profileDir,
    cacheDir: join(profileDir, String(values.cacheDir)),
    values,
    config,
    manager,
    fetchRoutes,
    webRoutes,
    listeners,
    effects,
    warnLines,
    infoLines,
    ctx,
    call,
    /** 释放所有 effect 注册。 */
    dispose() {
      for (const entry of effects) {
        try {
          entry.dispose?.()
        } catch {
          // 忽略
        }
      }
    },
  }
}

/**
 * 往假 profile 的缓存目录写一份索引正文（`store.cachedIndex()` 认格式 1）。
 * @param {object} app - boot 句柄。
 * @param {string} url - 上游地址。
 * @param {object[]} plugins - `plugins[]`。
 * @returns {Promise<string>} 源 id。
 */
async function writeIndexBody(app, url, plugins) {
  const store = await import('../lib/store.js')
  const id = store.sourceId(url)
  mkdirSync(app.cacheDir, { recursive: true })
  writeFileSync(join(app.cacheDir, `index-${id}.json`), JSON.stringify({ format: 1, plugins }), 'utf8')
  writeFileSync(join(app.cacheDir, 'state.json'), JSON.stringify({ version: 1, sources: [url], entries: {} }), 'utf8')
  return id
}

/** 一份含 git 版本的索引条目。 */
function gitIndexPlugin(name, entries) {
  return {
    name,
    versions: entries.map(entry => ({
      version: entry.version,
      publishTimestamp: entry.publishTimestamp ?? 1_700_000_000_000,
      source: { type: 'git', url: entry.url ?? 'git+https://github.com/acme/demo-git.git', path: entry.path ?? '', commit: entry.commit },
    })),
  }
}

// ---------------------------------------------------------------------------
// 过滤矩阵
// ---------------------------------------------------------------------------
/** 覆盖方案 §3/§4 全部「不显示」形态 + 两个开关的两类候选。 */
function fixtureBundles() {
  return [
    bundle({ name: 'keep-registry', version: '1.0.0', source: 'keep-registry@1.0.0', update: 'registry' }),
    bundle({ name: 'keep-git', version: '1.0.0', source: GIT_HTTPS_OLD, update: 'git' }),
    bundle({ name: 'official-box', official: true, source: 'official-box@1.0.0', update: 'registry' }),
    bundle({ name: 'linked-local', source: 'link:../linked-local', update: undefined }),
    bundle({ name: 'file-local', source: 'file:../file-local-1.0.0.tgz', update: undefined }),
    bundle({ name: 'aliased-npm', source: 'npm:real-package@1.2.3', update: undefined }),
    bundle({ name: 'git-branch', source: 'git+https://github.com/acme/demo-git.git#main', update: 'git' }),
    bundle({ name: 'git-shorthand', source: 'github:acme/demo-git', update: 'git' }),
    bundle({ name: 'plugin-managerish', source: 'plugin-managerish@2.0.0', update: 'registry', readOnlyReason: 'bundle 自带的插件管理组件' }),
    bundle({ name: 'plugin-managerish-row', source: 'plugin-managerish-row@2.0.0', update: 'registry', rows: [{ moduleName: '@deepseek-ai/dsh-plugin-manager' }] }),
    bundle({ name: 'disabled-one', enabled: false, source: 'disabled-one@1.0.0', update: 'registry' }),
    bundle({ name: 'not-installed', installed: false, source: 'not-installed@1.0.0', update: 'registry' }),
    bundle({ name: 'no-update-field', source: 'no-update-field@1.0.0', update: undefined }),
    bundle({ name: 'not-updatable-alias', source: 'npm:other@1.0.0', update: 'registry' }),
  ]
}

const expectedVisible = ['keep-registry', 'keep-git']

section('候选过滤矩阵（方案 §3/§4）')
{
  const manager = makePluginManager(fixtureBundles())
  const app = await boot({ bundles: fixtureBundles(), manager })
  const response = await app.call(`${API}/updates`)
  eq(response.status, 200, 'GET /updates 返回 200')
  const names = response.body.candidates.map(entry => entry.name)
  ok(expectedVisible.every(name => names.includes(name)), `保留可更新的两个包（${names.join(',')}）`, names)
  for (const hidden of ['official-box', 'linked-local', 'file-local', 'aliased-npm', 'git-branch', 'git-shorthand', 'plugin-managerish', 'plugin-managerish-row', 'not-installed', 'no-update-field', 'not-updatable-alias']) {
    ok(!names.includes(hidden), `不出现：${hidden}`, names)
  }
  ok(!names.includes('disabled-one'), 'enabled:false 默认不出现', names)
  ok(response.body.config?.includeDisabled === false && response.body.config?.includePrerelease === false, '响应里的两个开关默认都是 false', response.body.config)
  eq(response.body.config?.showFailed, false, 'GET /updates config.showFailed 默认 false')
  ok(names.length === 2, `候选恰好 2 项（实际 ${names.length}）`, names)
  // 对外 kind 契约：只有 npm / git，绝不出现旧值 'registry'。
  eq(response.body.candidates.find(entry => entry.name === 'keep-registry')?.kind, 'npm', 'GET /updates：registry 来源对外 kind=npm')
  eq(response.body.candidates.find(entry => entry.name === 'keep-git')?.kind, 'git', 'GET /updates：git 来源对外 kind=git')
  ok(response.body.candidates.every(entry => entry.kind === 'npm' || entry.kind === 'git'), '候选 kind 只有 npm / git', response.body.candidates.map(entry => entry.kind))
  ok(!response.text.includes('"kind":"registry"'), 'GET /updates 响应里没有 "kind":"registry"', response.text.slice(0, 400))
  // 无法检查的 Git 候选把 reason 透传给界面（本地没有索引 → index-miss）。
  const gitCandidate = response.body.candidates.find(entry => entry.name === 'keep-git')
  eq(gitCandidate?.state, 'uncheckable', '没有本地索引时 Git 候选 state=uncheckable')
  eq(gitCandidate?.reason, 'index-miss', '没有本地索引时 Git 候选 reason=index-miss')
  ok(Object.prototype.hasOwnProperty.call(gitCandidate ?? {}, 'error'), '候选始终输出 error 字段', Object.keys(gitCandidate ?? {}))

  // 分类原因也要对得上：official / 未固定 git / 插件管理组件。
  const { classifyBundle } = await import('../lib/updates.js')
  const byName = new Map(fixtureBundles().map(entry => [entry.name, entry]))
  eq(classifyBundle(byName.get('official-box')).reason, 'official', 'official → reason=official')
  eq(classifyBundle(byName.get('linked-local')).reason, 'not-updatable', 'link: → reason=not-updatable')
  eq(classifyBundle(byName.get('file-local')).reason, 'not-updatable', 'file: → reason=not-updatable')
  eq(classifyBundle(byName.get('aliased-npm')).reason, 'not-updatable', 'npm: 别名 → reason=not-updatable')
  eq(classifyBundle(byName.get('git-branch')).reason, 'unpinned-git-spec', '分支 git → reason=unpinned-git-spec')
  eq(classifyBundle(byName.get('plugin-managerish')).reason, 'plugin-management', 'readOnlyReason → reason=plugin-management')
  eq(classifyBundle(byName.get('plugin-managerish-row')).reason, 'plugin-management', 'rows 里的插件管理模块 → reason=plugin-management')
  eq(classifyBundle(byName.get('not-updatable-alias')).reason, 'not-own-name-registry-spec', '别名却标了 registry → reason=not-own-name-registry-spec')
  eq(classifyBundle(byName.get('no-update-field')).reason, 'not-updatable', '没有 update 字段 → reason=not-updatable')
  eq(classifyBundle(byName.get('keep-registry')).kind, 'npm', 'pluginManager 的 update:registry 被归类为对外 kind:npm')
  eq(classifyBundle(byName.get('keep-git')).kind, 'git', '固定 commit 的 git 包被归类为 git')
  app.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
}

section('两个开关：包含已禁用 / 包含预发布与已废弃')
{
  const manager = makePluginManager(fixtureBundles(), {
    versionsBy: {
      'keep-registry': { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }], omitted: 0 },
      'disabled-one': { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }], omitted: 0 },
    },
  })
  const app = await boot({ bundles: fixtureBundles(), manager })
  /** 检查后立刻读候选。 */
  const inspect = async (label) => {
    const checked = await app.call(`${API}/updates/check`, { body: {} })
    ok(checked.status === 200, `${label}：POST /updates/check 200`, checked.status)
    const listed = await app.call(`${API}/updates`)
    return listed.body.candidates
  }

  // 开关全关：disabled 不出现。
  let candidates = await inspect('默认')
  ok(!candidates.some(entry => entry.name === 'disabled-one'), '开关关闭时 disabled-one 不出现', candidates.map(entry => entry.name))

  // 打开「包含已禁用的插件」。
  const settings = await app.call(`${API}/settings`, { body: { updatesIncludeDisabled: true } })
  eq(settings.status, 200, 'POST /settings 打开包含已禁用 → 200')
  candidates = await inspect('包含已禁用')
  ok(candidates.some(entry => entry.name === 'disabled-one'), '开关打开后 disabled-one 出现', candidates.map(entry => entry.name))
  ok(candidates.some(entry => entry.name === 'disabled-one' && entry.enabled === false), 'disabled-one 的 enabled 字段是 false', candidates.find(entry => entry.name === 'disabled-one'))

  // 预发布 / 已废弃：默认 skipped，打开开关后 available。
  const manager2 = makePluginManager(
    [bundle({ name: 'pre-release', source: 'pre-release@1.0.0', update: 'registry' }), bundle({ name: 'deprecated-pkg', source: 'deprecated-pkg@1.0.0', update: 'registry' })],
    {
      versionsBy: {
        'pre-release': { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [{ version: '2.0.0-rc.1', tags: ['next'], prerelease: true, bundle: true }], omitted: 0 },
        'deprecated-pkg': { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [{ version: '1.5.0', tags: ['latest'], prerelease: false, deprecated: '已不再维护，请改用别的包', bundle: true }], omitted: 0 },
      },
    },
  )
  const app2 = await boot({ bundles: [bundle({ name: 'pre-release', source: 'pre-release@1.0.0', update: 'registry' }), bundle({ name: 'deprecated-pkg', source: 'deprecated-pkg@1.0.0', update: 'registry' })], manager: manager2 })
  const inspect2 = async () => {
    await app2.call(`${API}/updates/check`, { body: {} })
    return (await app2.call(`${API}/updates`)).body.candidates
  }
  const off = await inspect2()
  const preOff = off.find(entry => entry.name === 'pre-release')
  const depOff = off.find(entry => entry.name === 'deprecated-pkg')
  ok(preOff !== undefined, '预发布候选默认仍在列表里（只是不自动勾选）', off)
  eq(preOff?.state, 'skipped', '预发布默认 state=skipped')
  eq(preOff?.prerelease, true, '预发布候选带 prerelease=true')
  eq(depOff?.state, 'skipped', '已废弃默认 state=skipped')
  ok(typeof depOff?.deprecated === 'string' && depOff.deprecated.length > 0, '已废弃候选带 deprecated 文案', depOff)

  await app2.call(`${API}/settings`, { body: { updatesIncludePrerelease: true } })
  const on = await inspect2()
  const preOn = on.find(entry => entry.name === 'pre-release')
  eq(preOn?.state, 'available', '打开「包含预发布/已废弃」后预发布 state=available')
  eq(on.find(entry => entry.name === 'deprecated-pkg')?.state, 'available', '打开开关后已废弃 state=available')

  // 关掉开关应该回到 skipped（volatile 配置热更新）。
  await app2.call(`${API}/settings`, { body: { updatesIncludePrerelease: false } })
  const back = await inspect2()
  eq(back.find(entry => entry.name === 'pre-release')?.state, 'skipped', '再次关闭开关后回到 skipped')

  app.dispose()
  app2.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
  rmSync(app2.profileDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 检查：registry / git
// ---------------------------------------------------------------------------
section('检查：npm（registry 来源）走 listVersions，git 走缓存索引')
{
  const bundles = [bundle({ name: 'reg-check', source: 'reg-check@1.0.0', update: 'registry' }), bundle({ name: 'git-check', version: '1.0.0', source: GIT_HTTPS_OLD, update: 'git' })]
  const manager = makePluginManager(bundles, {
    versionsBy: {
      'reg-check': { status: 'listed', installed: '1.0.0', registry: 'https://registry.npmjs.org/', attempts: [], versions: [{ version: '1.3.0', tags: ['latest'], prerelease: false, bundle: true }, { version: '1.2.0', tags: [], prerelease: false, bundle: true }], omitted: 0 },
    },
  })
  const app = await boot({ bundles, manager })

  // 索引缺失：git 候选 uncheckable，且检查不抛错。
  const first = await app.call(`${API}/updates/check`, { body: {} })
  eq(first.status, 200, '索引缺失时 POST /updates/check 仍 200')
  eq(manager.calls.listVersions, ['reg-check'], 'registry 包调用 listVersions(name)（git 包不调用）')
  const gitFirst = first.body.candidates.find(entry => entry.name === 'git-check')
  eq(gitFirst?.state, 'uncheckable', '索引缺失时 git 候选 state=uncheckable')
  eq(gitFirst?.reason, 'index-miss', '索引缺失时 git 候选 reason=index-miss（透传给界面）')
  eq(first.body.checked.find(entry => entry.name === 'git-check')?.reason, 'index-miss', 'check 的 checked[] 也带 reason=index-miss')
  const regFirst = first.body.candidates.find(entry => entry.name === 'reg-check')
  eq(regFirst?.latest, '1.3.0', 'registry 候选取 listVersions 里的最新版本')
  eq(regFirst?.state, 'available', 'registry 候选 state=available')
  eq(regFirst?.kind, 'npm', 'check 候选：registry 来源对外 kind=npm')
  eq(first.body.checked.find(entry => entry.name === 'reg-check')?.kind, 'npm', 'check checked[]：registry 来源对外 kind=npm')
  eq(first.body.checked.find(entry => entry.name === 'git-check')?.kind, 'git', 'check checked[]：git 来源对外 kind=git')
  ok(!first.text.includes('"kind":"registry"'), 'POST /updates/check 响应里没有 "kind":"registry"', first.text.slice(0, 400))

  // 写入索引：git 包从缓存索引解析最新 commit。
  const url = 'https://example.test/index.json'
  await writeIndexBody(app, url, [gitIndexPlugin('git-check', [{ version: '1.0.0', commit: COMMIT_OLD }, { version: '1.1.0', commit: COMMIT_NEW }])])
  const second = await app.call(`${API}/updates/check`, { body: {} })
  eq(second.status, 200, '有索引时 POST /updates/check 返回 200')
  const gitSecond = second.body.candidates.find(entry => entry.name === 'git-check')
  eq(gitSecond?.commit ?? second.body.checked.find(entry => entry.name === 'git-check')?.commit, COMMIT_NEW, 'git 候选从索引解析出最新 commit')
  eq(second.body.checked.find(entry => entry.name === 'git-check')?.latest, '1.1.0', 'git 候选的目标版本来自索引')
  const spec = second.body.checked.find(entry => entry.name === 'git-check')?.spec
  ok(typeof spec === 'string' && spec.includes(COMMIT_NEW), 'git 候选返回固定新 commit 的 spec', spec)

  // names 限定 + 未知包名。
  const limited = await app.call(`${API}/updates/check`, { body: { names: ['git-check', 'nope-pkg'] } })
  eq(limited.body.unknown, ['nope-pkg'], 'names 里的未知包名进 unknown')
  ok(Array.isArray(limited.body.skipped) && limited.body.skipped.includes('reg-check'), 'names 之外的候选进 skipped', limited.body.skipped)

  // listVersions 抛错不把整个检查打挂。
  manager.versionLists['reg-check'] = undefined
  const boom = makePluginManager(bundles, {})
  boom.listVersions = async (name) => {
    boom.calls.listVersions.push(name)
    if (name === 'reg-check') throw new Error('registry 挂了')
    return { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [], omitted: 0 }
  }
  const app2 = await boot({ bundles, manager: boom })
  const survived = await app2.call(`${API}/updates/check`, { body: {} })
  eq(survived.status, 200, 'listVersions 抛错时检查仍返回 200')
  eq(survived.body.checked.find(entry => entry.name === 'reg-check')?.state, 'error', 'listVersions 抛错的候选 state=error')

  app.dispose()
  app2.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
  rmSync(app2.profileDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 队列：顺序、失败继续、回滚、取消
// ---------------------------------------------------------------------------
section('apply：顺序执行与失败继续')
{
  const bundles = [
    bundle({ name: 'q-one', source: 'q-one@1.0.0', update: 'registry' }),
    bundle({ name: 'q-two', source: 'q-two@1.0.0', update: 'registry' }),
    bundle({ name: 'q-three', source: 'q-three@1.0.0', update: 'registry' }),
  ]
  const manager = makePluginManager(bundles, {
    outcomes: {
      'q-two': () => {
        throw new Error('目标版本不存在')
      },
      'q-three': (name, version) => ({ from: '1.0.0', to: version, step: 'install', result: { changed: true, application: 'restart-required', stage: 'install', target: `${name}@${version}` } }),
    },
  })
  const app = await boot({ bundles, manager })
  await app.call(`${API}/updates/check`, { body: {} })

  const apply = await app.call(`${API}/updates/apply`, { body: { items: [{ name: 'q-one' }, { name: 'q-two' }, { name: 'q-three' }] } })
  eq(apply.status, 200, 'POST /updates/apply 200')
  eq(apply.body.started, true, 'apply 立即返回 started=true')
  eq(apply.body.requestIds.length, 3, 'apply 返回 3 个 requestId')
  ok(apply.body.requestIds.every(id => typeof id === 'string' && id.length > 0), 'requestId 都是非空字符串', apply.body.requestIds)

  await waitFor(async () => (await app.call(`${API}/updates/state`)).body.finished === true, '队列跑完')

  eq(manager.calls.updateBundle.map(entry => entry.name), ['q-one', 'q-two', 'q-three'], '第 2 项抛错后第 3 项照样执行（顺序 q-one → q-two → q-three）')
  eq(manager.calls.updateBundle.map(entry => entry.version), ['1.1.0', '1.1.0', '1.1.0'], '每项都拿到检查缓存里的目标版本')
  ok(manager.calls.updateBundle.every(entry => typeof entry.options?.requestId === 'string'), 'updateBundle 都带 requestId', manager.calls.updateBundle.map(entry => entry.options))

  const state = await app.call(`${API}/updates/state`)
  const items = state.body.items
  eq(state.body.running, false, '跑完后 running=false')
  summaryMatches(state.body.summary, { total: 3, success: 2, failed: 1, cancelled: 0, pending: 0, restartRequired: 1, skipped: 0 }, '汇总（成功 2 / 失败 1 / 需重启 1）')
  eq(items[0].success, true, '第 1 项 success=true')
  eq(items[0].failed, false, '第 1 项 failed=false')
  eq(items[1].failed, true, '第 2 项 failed=true')
  ok(typeof items[1].error === 'string' && items[1].error.includes('目标版本不存在'), '第 2 项带上抛错信息', items[1].error)
  eq(items[2].restartRequired, true, '第 3 项 restartRequired=true（application=restart-required）')
  eq(items[2].success, true, 'restart-required 也算成功', items[2].success)
  for (const [index, item] of items.entries()) {
    for (const field of ['success', 'failed', 'restartRequired', 'restore', 'stage', 'name', 'requestId']) {
      ok(Object.prototype.hasOwnProperty.call(item, field), `第 ${index + 1} 项含契约字段 ${field}`, Object.keys(item))
    }
  }
  eq(items.map(item => item.kind), ['npm', 'npm', 'npm'], 'GET /updates/state：items[].kind 全为 npm')
  ok(!state.text.includes('"kind":"registry"'), 'GET /updates/state 响应里没有 "kind":"registry"', state.text.slice(0, 400))

  // 有队列在跑时再 apply 应该 409。
  const managerSlow = makePluginManager(bundles, { delayMs: 250 })
  const app3 = await boot({ bundles, manager: managerSlow })
  await app3.call(`${API}/updates/check`, { body: {} })
  await app3.call(`${API}/updates/apply`, { body: { items: [{ name: 'q-one' }] } })
  const conflict = await app3.call(`${API}/updates/apply`, { body: { items: [{ name: 'q-two' }] } })
  eq(conflict.status, 409, '已有队列在跑时再 apply 返回 409')
  eq(conflict.body.error, 'update-running', '409 的 error=update-running')
  await waitFor(async () => (await app3.call(`${API}/updates/state`)).body.finished === true, '慢队列跑完')
  eq(managerSlow.calls.updateBundle.length, 1, '被 409 拒掉的那次没有产生 updateBundle 调用')

  // 空 items。
  const empty = await app3.call(`${API}/updates/apply`, { body: { items: [] } })
  eq(empty.status, 400, '空 items → 400')
  eq(empty.body.error, 'no-items', '空 items 的 error=no-items')

  app.dispose()
  app3.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
  rmSync(app3.profileDir, { recursive: true, force: true })
}

section('apply：失败回滚结果与 git spec')
{
  const bundles = [bundle({ name: 'restore-me', source: 'restore-me@1.0.0', update: 'registry' }), bundle({ name: 'git-apply', version: '1.0.0', source: GIT_HTTPS_OLD, update: 'git' })]
  const manager = makePluginManager(bundles, {
    outcomes: { 'restore-me': (name, version) => rolledBack(name, version) },
  })
  const app = await boot({ bundles, manager })
  await writeIndexBody(app, 'https://example.test/index.json', [gitIndexPlugin('git-apply', [{ version: '1.1.0', commit: COMMIT_NEW }])])
  const checked = await app.call(`${API}/updates/check`, { body: {} })
  const gitSpec = checked.body.checked.find(entry => entry.name === 'git-apply')?.spec

  await app.call(`${API}/updates/apply`, { body: { items: [{ name: 'restore-me' }, { name: 'git-apply' }] } })
  await waitFor(async () => (await app.call(`${API}/updates/state`)).body.finished === true, '队列跑完')

  const state = await app.call(`${API}/updates/state`)
  const restoreItem = state.body.items.find(item => item.name === 'restore-me')
  eq(restoreItem.failed, true, 'application=failed → failed=true')
  eq(restoreItem.success, false, 'application=failed → success=false')
  ok(restoreItem.restore !== null && typeof restoreItem.restore === 'object', '失败项保留回滚信息 restore', restoreItem.restore)
  ok(typeof restoreItem.error === 'string' && restoreItem.error.includes('不兼容'), '失败项带 diagnostic', restoreItem.error)
  const gitCall = manager.calls.updateBundle.find(entry => entry.name === 'git-apply')
  eq(gitCall.version, '1.1.0', 'git 项更新到索引里的版本')
  eq(gitCall.options.spec, gitSpec, 'git 项把 spec 透传给 updateBundle')
  ok(typeof gitCall.options.spec === 'string' && gitCall.options.spec.includes(COMMIT_NEW), 'git spec 固定新 commit', gitCall.options.spec)

  app.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
}

section('cancel：停队列并取消当前 requestId')
{
  const bundles = [bundle({ name: 'c-one', source: 'c-one@1.0.0', update: 'registry' }), bundle({ name: 'c-two', source: 'c-two@1.0.0', update: 'registry' }), bundle({ name: 'c-three', source: 'c-three@1.0.0', update: 'registry' })]
  /** 第一项挂起，直到后端取消把它结束（真实 pnpm 进程被杀掉后 updateBundle 的 promise 会落地）。 */
  let releaseHanging
  const hanging = new Promise(resolveHanging => { releaseHanging = resolveHanging })
  const manager = makePluginManager(bundles, {
    outcomes: { 'c-one': async () => { await hanging } },
    versionsDefault: { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }], omitted: 0 },
  })
  const nativeCancelInstall = manager.cancelInstall
  manager.cancelInstall = async (requestId) => {
    const outcome = await nativeCancelInstall(requestId)
    releaseHanging()
    return outcome
  }
  const app = await boot({ bundles, manager })
  await app.call(`${API}/updates/check`, { body: {} })
  await app.call(`${API}/updates/apply`, { body: { items: [{ name: 'c-one' }, { name: 'c-two' }, { name: 'c-three' }] } })
  await waitFor(() => manager.calls.updateBundle.length === 1, '第一项开始跑')

  const cancel = await app.call(`${API}/updates/cancel`, { body: {} })
  eq(cancel.status, 200, 'POST /updates/cancel 200')
  eq(cancel.body.ok, true, 'cancel 返回 ok=true')
  eq(cancel.body.cancelled, 'cancelled', 'cancel 透传 pluginManager.cancelInstall 的状态')
  eq(manager.calls.cancelInstall.length, 1, 'cancelInstall 恰好调用一次')
  eq(manager.calls.cancelInstall[0], cancel.body.state.items[0].requestId, '取消的是当前项的 requestId')
  eq(manager.calls.waitForInstall.includes(cancel.body.state.items[0].requestId), true, '取消后等一次 waitForInstall 兜底')

  await waitFor(async () => (await app.call(`${API}/updates/state`)).body.finished === true, '取消后的队列收尾')
  const state = await app.call(`${API}/updates/state`)
  summaryMatches(state.body.summary, { total: 3, success: 0, failed: 0, cancelled: 3, pending: 0, restartRequired: 0, skipped: 3 }, '取消后汇总（3 项取消）')
  eq(state.body.items.map(item => item.stage), ['cancelled', 'cancelled', 'cancelled'], '三项 stage 都是 cancelled')
  eq(manager.calls.updateBundle.length, 1, '取消后不再调用 updateBundle')

  // 队列已结束后再取消：不报错。
  const again = await app.call(`${API}/updates/cancel`, { body: {} })
  eq(again.status, 200, '队列结束后再 cancel 仍 200')
  eq(again.body.cancelled, 'not-running', '无在跑项时 cancelled=not-running')

  app.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
}

section('进度：plugin-manager/* 事件驱动 stage / logs')
{
  const bundles = [bundle({ name: 'p-one', source: 'p-one@1.0.0', update: 'registry' }), bundle({ name: 'p-two', source: 'p-two@1.0.0', update: 'registry' })]
  /** 第一项挂起，等我们手动推进事件。 */
  let release
  const gate = new Promise(resolveGate => { release = resolveGate })
  const manager = makePluginManager(bundles, { outcomes: { 'p-one': async () => { await gate; return applied('p-one', '1.1.0') } } })
  const app = await boot({ bundles, manager })
  await app.call(`${API}/updates/check`, { body: {} })
  await app.call(`${API}/updates/apply`, { body: { items: [{ name: 'p-one' }, { name: 'p-two' }] } })
  await waitFor(() => manager.calls.updateBundle.length === 1, '第一项开始跑')

  const before = await app.call(`${API}/updates/state`)
  eq(before.body.active, 'p-one', 'state.active 是当前项')
  eq(before.body.activeRequestId, before.body.items[0].requestId, 'state.activeRequestId 是当前项的 requestId')

  // 事件：阶段 + 日志。
  app.ctx.emit('plugin-manager/update-state', { requestId: before.body.items[0].requestId, step: 'removing' })
  app.ctx.emit('plugin-manager/install-log', { requestId: before.body.items[0].requestId, text: 'progress 1\nprogress 2\n', stream: 'stdout' })
  app.ctx.emit('plugin-manager/install-log', { requestId: before.body.items[0].requestId, text: 'warn line', stream: 'stderr' })
  const during = await app.call(`${API}/updates/state`)
  eq(during.body.items[0].stage, 'removing', 'update-state 事件把阶段推到 removing')
  ok(during.body.logs.length >= 3, 'install-log 事件进了 logs', during.body.logs)
  ok(during.body.logs.some(line => line.startsWith('! ')), 'stderr 行带 ! 前缀', during.body.logs)

  release()
  await waitFor(async () => (await app.call(`${API}/updates/state`)).body.finished === true, '队列跑完')
  const after = await app.call(`${API}/updates/state`)
  eq(after.body.items[0].stage, 'done', '成功项最终 stage=done')
  eq(after.body.active, null, '跑完后 active=null')
  ok(after.body.lastRun !== null && after.body.lastRun.finishedAt !== undefined, 'state 带 lastRun 快照', after.body.lastRun)

  // changed 事件在空闲时清日志。
  app.ctx.emit('plugin-manager/changed', {})
  const cleared = await app.call(`${API}/updates/state`)
  eq(cleared.body.logs, [], '空闲时 changed 事件清掉日志尾巴')

  app.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 豁免
// ---------------------------------------------------------------------------
section('exempt：必须显式 acceptRisk')
{
  const bundles = [bundle({ name: 'risky-pkg', source: 'risky-pkg@1.0.0', update: 'registry' })]
  const manager = makePluginManager(bundles, {
    versionsBy: {
      'risky-pkg': {
        status: 'listed',
        installed: '1.0.0',
        registry: null,
        attempts: [],
        versions: [{ version: '3.0.0', tags: ['latest'], prerelease: false, bundle: true, incompatible: { name: 'risky-pkg', version: '3.0.0', runtimeVersion: '0.3.0', requirements: [{ kind: 'engines.dsh', wanted: '>=0.4.0', actual: '0.3.0' }] } }],
        omitted: 0,
      },
    },
  })
  const app = await boot({ bundles, manager })

  // 缺 acceptRisk → 400，且不碰 pluginManager。
  const denied = await app.call(`${API}/updates/exempt`, { body: { package: 'risky-pkg', version: '3.0.0' } })
  eq(denied.status, 400, '缺 acceptRisk → 400')
  eq(denied.body.error, 'risk-not-accepted', '缺 acceptRisk 的 error=risk-not-accepted')
  eq(manager.calls.setVersionExemption.length, 0, '缺 acceptRisk 时不调用 setVersionExemption')

  const falsey = await app.call(`${API}/updates/exempt`, { body: { package: 'risky-pkg', version: '3.0.0', acceptRisk: 'true' } })
  eq(falsey.status, 400, 'acceptRisk 不是布尔 true（字符串）→ 400')
  eq(manager.calls.setVersionExemption.length, 0, 'acceptRisk 为字符串时不调用 setVersionExemption')

  const missing = await app.call(`${API}/updates/exempt`, { body: { package: '', version: '3.0.0', acceptRisk: true } })
  eq(missing.status, 400, '缺 package → 400')
  eq(missing.body.error, 'invalid-request', '缺 package 的 error=invalid-request')

  // acceptRisk:true + 指定 runtimeVersion → 精确调用。
  const granted = await app.call(`${API}/updates/exempt`, { body: { package: 'risky-pkg', version: '3.0.0', acceptRisk: true, runtimeVersion: '9.9.9-test' } })
  eq(granted.status, 200, 'acceptRisk:true → 200')
  eq(granted.body.ok, true, '豁免成功 ok=true')
  eq(manager.calls.setVersionExemption.length, 1, '只调用一次 setVersionExemption')
  eq(manager.calls.setVersionExemption[0], ['risky-pkg@3.0.0', '9.9.9-test', true, true], '调用形态：setVersionExemption(pkg@version, runtimeVersion, true, true)')

  // 不指定 runtimeVersion：Host 自己解析出当前 DSH 版本。
  const auto = await Promise.race([
    app.call(`${API}/updates/exempt`, { body: { package: 'other-pkg', version: '1.0.0', acceptRisk: true } })
      .then(value => ({ state: 'settled', value }), error => ({ state: 'rejected', error: String(error) })),
    sleep(8000).then(() => ({ state: 'timeout' })),
  ])
  ok(auto.state !== 'timeout', '不指定 runtimeVersion 的豁免请求不会挂死（8s 内返回）', auto)
  const autoResponse = auto.state === 'settled' ? auto.value : { status: 0, body: {} }
  if (autoResponse.status === 200) {
    eq(manager.calls.setVersionExemption[1]?.[0], 'other-pkg@1.0.0', '自动解析版本时包名仍是 pkg@version')
    ok(typeof manager.calls.setVersionExemption[1]?.[1] === 'string' && manager.calls.setVersionExemption[1][1].length > 0, '自动解析出的 runtimeVersion 是非空字符串', manager.calls.setVersionExemption[1])
    eq(manager.calls.setVersionExemption[1]?.[2], true, '第三个参数 enabled=true')
    eq(manager.calls.setVersionExemption[1]?.[3], true, '第四个参数 acceptRisk=true')
  } else if (autoResponse.status === 409) {
    eq(autoResponse.body.error, 'runtime-version-unknown', '解析不出 DSH 版本时返回 409 且 error=runtime-version-unknown')
    eq(manager.calls.setVersionExemption.length, 1, '解析失败时不调用 setVersionExemption')
  }

  // 不兼容信息要能在候选里看到（供 UI 显示原因）。
  const checked = await app.call(`${API}/updates/check`, { body: {} })
  const risky = checked.body.candidates.find(entry => entry.name === 'risky-pkg')
  ok(risky?.incompatible !== null && risky?.incompatible !== undefined, '候选带上 incompatible 详情', risky?.incompatible)

  app.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 路由注册与「无自动更新」
// ---------------------------------------------------------------------------
section('路由注册：6 个 owner-only 桥 + 无自动更新路径')
{
  const bundles = fixtureBundles()
  const manager = makePluginManager(bundles)
  const app = await boot({ bundles, manager })

  for (const entry of ROUTE_CONTRACT) {
    const route = app.fetchRoutes.get(entry.path)
    ok(route !== undefined, `connection.fetch 注册了 ${entry.path}`, [...app.fetchRoutes.keys()])
    eq(route?.methods, entry.methods, `${entry.path} 的 methods 正确`)
    eq(route?.requestBody, 'buffered', `${entry.path} 的 requestBody='buffered'`)
    eq(typeof route?.fetch, 'function', `${entry.path} 有 fetch 处理函数`)
  }
  ok(app.fetchRoutes.size >= 6, `桥接路由不少于 6 条（实际 ${app.fetchRoutes.size}）`, [...app.fetchRoutes.keys()])
  eq(app.webRoutes.has(`${API}/updates`), false, '「可更新」端点没被挂到 webServer（只走 connection.fetch）')

  // 公开状态路由不该泄露候选。
  const publicRoute = [...app.webRoutes.keys()].find(path => path.startsWith('/pluginmarket-plus/'))
  ok(publicRoute !== undefined, '公开状态路由仍在（排查用）', [...app.webRoutes.keys()])

  // 启动静默：等一段时间，确认没有任何自动检查/更新。
  const before = tryJson(manager.calls)
  await sleep(400)
  eq(tryJson(manager.calls), before, '启动后 400ms 内没有任何自动 pluginManager 调用（不自动检查 / 不自动更新）')
  eq(manager.calls.updateBundle.length, 0, '启动不触发 updateBundle')
  eq(manager.calls.listVersions.length, 0, '启动不触发 listVersions')

  // 静默读取：state 在队列从未跑过时也要可读。
  const idle = await app.call(`${API}/updates/state`)
  eq(idle.status, 200, '没跑过队列时 GET /updates/state 也 200')
  eq(idle.body.running, false, 'idle state running=false')
  eq(idle.body.items, [], 'idle state items=[]')

  // 源码级证据：updateBundle / queue.start 的唯一起点是 apply 路由。
  const sources = {
    'lib/index.js': readFileSync(join(PLUGIN_ROOT, 'lib/index.js'), 'utf8'),
    'lib/updates.js': readFileSync(join(PLUGIN_ROOT, 'lib/updates.js'), 'utf8'),
  }
  const indexSource = sources['lib/index.js']
  const indexLines = indexSource.split(/\r?\n/u).map((line, number) => ({ line, number: number + 1 }))
  const updateBundleCalls = indexLines.filter(entry => /updateBundle\s*\(/u.test(entry.line) && !/^\s*(?:\/\/|\*|\/\*)/u.test(entry.line))
  ok(updateBundleCalls.length === 1, `lib/index.js 里 updateBundle( 调用只出现一次（实际 ${updateBundleCalls.length}）`, updateBundleCalls)
  ok(updateBundleCalls[0]?.line.includes('pluginManager.updateBundle'), 'updateBundle 只经注入的 pluginManager 调用', updateBundleCalls[0]?.line)
  const startUpdatesCallers = indexLines.filter(entry => /startUpdates\s*\(/u.test(entry.line) && !/^\s*(?:\/\/|\*|\/\*)/u.test(entry.line))
  ok(startUpdatesCallers.length === 2, `startUpdates 只有「定义 + apply 路由」两处引用（实际 ${startUpdatesCallers.length}）`, startUpdatesCallers)
  ok(startUpdatesCallers.some(entry => entry.line.includes('async function startUpdates')), '其中一处是 startUpdates 的定义', startUpdatesCallers)
  ok(startUpdatesCallers.some(entry => entry.line.includes('await startUpdates')), '另一处是 apply 路由里的调用', startUpdatesCallers)
  ok(!/setInterval\(|setTimeout\([^)]*updates/iu.test(indexSource), '没有针对「可更新」的定时器（无自动检查 / 无自动更新）')
  ok(!/boot[\s\S]{0,400}?updates\/apply|updates\/apply[\s\S]{0,400}?boot/iu.test(indexSource), '启动路径没有触发 apply')

  app.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
}

section('设置持久化：两个开关经 /settings 落盘')
{
  const bundles = fixtureBundles()
  const manager = makePluginManager(bundles)
  const app = await boot({ bundles, manager })
  const saved = await app.call(`${API}/settings`, { body: { updatesIncludeDisabled: true, updatesIncludePrerelease: true } })
  eq(saved.status, 200, 'POST /settings 200')
  eq(saved.body.saved, true, 'settings 报告 saved=true')
  eq(app.values.updatesIncludeDisabled, true, 'updatesIncludeDisabled 落到配置')
  eq(app.values.updatesIncludePrerelease, true, 'updatesIncludePrerelease 落到配置')
  const listed = await app.call(`${API}/updates`)
  eq(listed.body.config?.includeDisabled, true, 'GET /updates config.includeDisabled=true')
  eq(listed.body.config?.includePrerelease, true, 'GET /updates config.includePrerelease=true')
  eq(listed.body.config?.showFailed, false, 'GET /updates config.showFailed=false（三键契约）')
  ok(listed.body.candidates.some(entry => entry.name === 'disabled-one'), '打开开关后候选包含已禁用的包')

  // settings 不可用时要有内存兜底，别静默失败。
  const broken = await boot({ bundles, manager: makePluginManager(bundles), breakSettings: true })
  const fallback = await broken.call(`${API}/settings`, { body: { updatesIncludeDisabled: true } })
  eq(fallback.body.saved, false, 'settings 写入失败时 saved=false')
  const after = await broken.call(`${API}/updates`)
  eq(after.body.config.includeDisabled, true, '写入失败也在本次进程内生效（内存兜底）')
  ok(broken.warnLines.some(line => line.includes('保存配置失败')), '写入失败有 warn 日志', broken.warnLines)

  app.dispose()
  broken.dispose()
  rmSync(app.profileDir, { recursive: true, force: true })
  rmSync(broken.profileDir, { recursive: true, force: true })
}

section('中断恢复：interrupted / recover / clear-interrupted')
{
  /**
   * 往假 profile 的缓存目录写一份中断日志（真实 Host 的 `{version,items}` 形状）。
   * @param {object} app - boot 句柄。
   * @param {object[]} items - 记录。
   * @returns {void}
   */
  const writeInflightFile = (app, items) => {
    mkdirSync(app.cacheDir, { recursive: true })
    writeFileSync(join(app.cacheDir, 'updates-inflight.json'), JSON.stringify({ version: 1, items }, null, 2), 'utf8')
  }
  /**
   * 读回中断日志文件（不存在时返回 null）。
   * @param {object} app - boot 句柄。
   * @returns {object|null} 解析结果。
   */
  const readInflightFile = (app) => {
    const path = join(app.cacheDir, 'updates-inflight.json')
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  const bundles = [
    bundle({ name: 'rec-npm', source: 'rec-npm@1.0.0', update: 'registry' }),
    bundle({ name: 'rec-git', version: '1.0.0', source: GIT_HTTPS_OLD, update: 'git' }),
  ]
  const manager = makePluginManager(bundles, {
    installOutcomes: {
      'rec-npm@2.0.0': { changed: true, application: 'applied', stage: 'install', target: 'rec-npm@2.0.0' },
      [`git+https://github.com/acme/demo-git.git#${COMMIT_NEW}`]: { changed: true, application: 'restart-required', stage: 'install', target: 'rec-git' },
      'boom-npm@9.9.9': { changed: false, application: 'failed', stage: 'install', error: { code: 'install-failed', diagnostic: '目标版本不存在' } },
    },
  })
  const app = await boot({ bundles, manager })

  // 1) 默认没有残留。
  const first = await app.call(`${API}/updates`)
  eq(first.status, 200, 'GET /updates 200')
  eq(first.body.interrupted, [], 'GET /updates 的 interrupted 默认是 []')
  eq(readInflightFile(app), null, '没有残留时不写中断日志文件')

  // 2) 模拟进程被杀：文件里留下一条 npm 与一条 git 记录。
  writeInflightFile(app, [
    { name: 'rec-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-npm', phase: 'installing', startedAt: 1_700_000_000_000 },
    { name: 'rec-git', current: '1.0.0', target: '1.1.0', kind: 'git', spec: `git+https://github.com/acme/demo-git.git#${COMMIT_NEW}`, requestId: 'req-git', phase: 'removing', startedAt: 1_700_000_001_000 },
  ])
  const listed = await app.call(`${API}/updates`)
  eq(listed.status, 200, '有残留时 GET /updates 仍 200')
  eq(listed.body.interrupted.map(record => record.name), ['rec-npm', 'rec-git'], 'interrupted 含两个残留包（按写入顺序）')
  const npmRecord = listed.body.interrupted.find(record => record.name === 'rec-npm')
  const gitRecord = listed.body.interrupted.find(record => record.name === 'rec-git')
  eq(
    { name: npmRecord?.name, current: npmRecord?.current, target: npmRecord?.target, kind: npmRecord?.kind, phase: npmRecord?.phase, requestId: npmRecord?.requestId, startedAt: npmRecord?.startedAt },
    { name: 'rec-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', phase: 'installing', requestId: 'req-npm', startedAt: 1_700_000_000_000 },
    'npm 记录字段完整（name/current/target/kind/phase/requestId/startedAt）',
  )
  eq(gitRecord?.spec, `git+https://github.com/acme/demo-git.git#${COMMIT_NEW}`, 'git 记录带原固定 commit 的 spec')
  eq(gitRecord?.kind, 'git', 'git 记录 kind=git')

  // 3) 单行恢复：只发 {items:[{name:'rec-git'}]}，只重装该包且用原 spec。
  const single = await app.call(`${API}/updates/recover`, { body: { items: [{ name: 'rec-git' }] } })
  eq(single.status, 200, 'POST /updates/recover（单行）200')
  eq(manager.calls.installBundle, [`git+https://github.com/acme/demo-git.git#${COMMIT_NEW}`], 'git 项用原 spec 调 installBundle')
  eq(single.body.results, [{ name: 'rec-git', ok: true }], 'restart-required 也算恢复成功')
  eq(single.body.interrupted.map(record => record.name), ['rec-npm'], '成功项从返回的 interrupted 中移除')
  eq(readInflightFile(app)?.items.map(record => record.name), ['rec-npm'], '成功项也从磁盘文件移除（失败/未处理的保留）')

  // 4) 整批恢复：npm 项调 installBundle('name@target')；失败项保留并带原因。
  writeInflightFile(app, [
    { name: 'rec-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-npm', phase: 'installing', startedAt: 1_700_000_000_000 },
    { name: 'boom-npm', current: '1.0.0', target: '9.9.9', kind: 'npm', requestId: 'req-boom', phase: 'installing', startedAt: 1_700_000_002_000 },
  ])
  const all = await app.call(`${API}/updates/recover`, { body: {} })
  eq(all.status, 200, 'POST /updates/recover（整批）200')
  ok(manager.calls.installBundle.includes('rec-npm@2.0.0'), 'npm 项用 name@target 调 installBundle', manager.calls.installBundle)
  ok(manager.calls.installBundle.includes('boom-npm@9.9.9'), '失败项也尝试重装', manager.calls.installBundle)
  const boom = all.body.results.find(result => result.name === 'boom-npm')
  eq(boom?.ok, false, '失败项 ok=false')
  ok(typeof boom?.error === 'string' && boom.error.includes('目标版本不存在'), '失败项带上 diagnostic', boom)
  eq(all.body.interrupted.map(record => record.name), ['boom-npm'], '只保留失败项')
  eq(readInflightFile(app)?.items.map(record => record.name), ['boom-npm'], '磁盘文件只保留失败项')

  // 5) 请求体点名不在残留列表里 → 400。
  const unknown = await app.call(`${API}/updates/recover`, { body: { items: [{ name: 'nope-pkg' }] } })
  eq(unknown.status, 400, '点名不存在的包 → 400')
  eq(unknown.body.error, 'unknown-items', '400 的 error=unknown-items')

  // 6) 队列在跑时 recover 返回 409。
  const slowManager = makePluginManager(bundles, { delayMs: 250 })
  const busyApp = await boot({ bundles, manager: slowManager })
  writeInflightFile(busyApp, [{ name: 'rec-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', phase: 'installing', startedAt: 1_700_000_000_000 }])
  await busyApp.call(`${API}/updates/check`, { body: {} })
  await busyApp.call(`${API}/updates/apply`, { body: { items: [{ name: 'rec-npm' }] } })
  const conflict = await busyApp.call(`${API}/updates/recover`, { body: {} })
  eq(conflict.status, 409, '队列在跑时 recover 返回 409')
  eq(conflict.body.error, 'update-running', '409 的 error=update-running')
  eq(slowManager.calls.installBundle, [], '409 时没有发起任何 installBundle')
  await waitFor(async () => (await busyApp.call(`${API}/updates/state`)).body.finished === true, '慢队列跑完')

  // 7) clear-interrupted：返回 cleared 并清空文件。
  const cleared = await app.call(`${API}/updates/clear-interrupted`, { body: {} })
  eq(cleared.status, 200, 'POST /updates/clear-interrupted 200')
  eq(cleared.body.ok, true, 'clear 返回 ok=true')
  eq(cleared.body.cleared.map(record => record.name), ['boom-npm'], 'clear 返回被清掉的记录')
  eq(cleared.body.interrupted, [], 'clear 后 interrupted=[]')
  eq(readInflightFile(app), null, 'clear 后磁盘文件已删除')
  const afterClear = await app.call(`${API}/updates`)
  eq(afterClear.body.interrupted, [], 'clear 后 GET /updates 的 interrupted 为空')

  // 8) 队列正常跑完会把中断日志清空（不残留）。
  const cleanApp = await boot({ bundles, manager: makePluginManager(bundles, {}) })
  await cleanApp.call(`${API}/updates/check`, { body: {} })
  await cleanApp.call(`${API}/updates/apply`, { body: { items: [{ name: 'rec-npm' }] } })
  await waitFor(async () => (await cleanApp.call(`${API}/updates/state`)).body.finished === true, '队列跑完')
  eq(readInflightFile(cleanApp), null, '队列正常跑完后不留下中断日志')

  app.dispose()
  busyApp.dispose()
  cleanApp.dispose()
  for (const handle of [app, busyApp, cleanApp]) rmSync(handle.profileDir, { recursive: true, force: true })
}

section('运行中排除中断项 / phase 写回 / missingFromProfile')
{
  /**
   * 往 profile 写 package.json 的 dependencies。
   * @param {object} app - boot 句柄。
   * @param {string[]} names - 依赖包名。
   * @returns {void}
   */
  const writeDeps = (app, names) => {
    writeFileSync(join(app.profileDir, 'package.json'), JSON.stringify({ name: 'fake-profile', dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])) }, null, 2), 'utf8')
  }
  /**
   * 往缓存目录写中断日志。
   * @param {object} app - boot 句柄。
   * @param {object[]} items - 记录。
   * @returns {void}
   */
  const writeInflight = (app, items) => {
    mkdirSync(app.cacheDir, { recursive: true })
    writeFileSync(join(app.cacheDir, 'updates-inflight.json'), JSON.stringify({ version: 1, items }, null, 2), 'utf8')
  }
  /**
   * 读回中断日志。
   * @param {object} app - boot 句柄。
   * @returns {object[]} items。
   */
  const readInflight = (app) => {
    const path = join(app.cacheDir, 'updates-inflight.json')
    if (!existsSync(path)) return []
    return JSON.parse(readFileSync(path, 'utf8')).items ?? []
  }

  // A) 运行中的队列项不出现在 interrupted；残留项带 missingFromProfile。
  const bundles = [
    bundle({ name: 'run-npm', source: 'run-npm@1.0.0', update: 'registry' }),
    bundle({ name: 'kept-npm', version: '1.0.0', source: 'kept-npm@1.0.0', update: 'registry' }),
  ]
  const app = await boot({
    bundles,
    manager: makePluginManager(bundles, { delayMs: 400 }),
    prepare: (profileDir) => {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'fake-profile', dependencies: { 'run-npm': '1.0.0', 'kept-npm': '1.0.0' } }, null, 2), 'utf8')
      const cacheDir = join(profileDir, '.pluginmarket-plus')
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(join(cacheDir, 'updates-inflight.json'), JSON.stringify({
        version: 1,
        items: [
          { name: 'run-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-run', phase: 'removing', startedAt: 1_700_000_000_000 },
          { name: 'stale-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-stale', phase: 'installing', startedAt: 1_700_000_001_000 },
          { name: 'kept-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-kept', phase: 'checking', startedAt: 1_700_000_002_000 },
        ],
      }, null, 2), 'utf8')
    },
  })

  // 启动时（无队列）三条都可见，missingFromProfile 按 profile 依赖标记。
  const idle = await app.call(`${API}/updates`)
  const idleByName = new Map(idle.body.interrupted.map(record => [record.name, record]))
  eq(idle.body.interrupted.map(record => record.name), ['run-npm', 'stale-npm', 'kept-npm'], '无队列时三条残留都可见')
  eq(idleByName.get('stale-npm')?.missingFromProfile, true, '不在 profile 依赖里的包标 missingFromProfile=true')
  eq(idleByName.get('run-npm')?.missingFromProfile, false, '在 profile 依赖里的包标 missingFromProfile=false')
  eq(idleByName.get('kept-npm')?.missingFromProfile, false, '在 profile 依赖里的包标 missingFromProfile=false（第二条）')

  // 启动 warn：明确提示「已移除但未装回」的残留。
  ok(app.warnLines.some(line => String(line).includes('stale-npm')), '启动时对不在 profile 依赖的残留给出 warn', app.warnLines)

  // 启动一个慢队列（run-npm），运行中 GET /updates 应过滤掉正在跑的项。
  await app.call(`${API}/updates/check`, { body: {} })
  const applied = await app.call(`${API}/updates/apply`, { body: { items: [{ name: 'run-npm' }] } })
  eq(applied.status, 200, 'apply 启动慢队列 200')
  const runRequestId = applied.body.items[0].requestId
  const during = await app.call(`${API}/updates`)
  const duringNames = during.body.interrupted.map(record => record.name)
  ok(!duringNames.includes('run-npm'), '运行中的队列项不出现在 interrupted（按 name 过滤）', duringNames)
  eq(duringNames, ['stale-npm', 'kept-npm'], '其它残留仍正常展示', duringNames)

  // 阶段推进：update-state 事件把 inflight 文件的 phase 写回 removing / installing。
  app.ctx.emit('plugin-manager/update-state', { requestId: runRequestId, step: 'removing' })
  eq(readInflight(app).find(record => record.name === 'run-npm')?.phase, 'removing', 'removing 阶段写回 inflight 文件')
  app.ctx.emit('plugin-manager/update-state', { requestId: runRequestId, step: 'installing' })
  eq(readInflight(app).find(record => record.name === 'run-npm')?.phase, 'installing', 'installing 阶段写回 inflight 文件')

  // 队列结束：run-npm 的记录被清掉，剩下的残留照常展示。
  await waitFor(async () => (await app.call(`${API}/updates/state`)).body.finished === true, '慢队列跑完')
  const after = await app.call(`${API}/updates`)
  eq(after.body.interrupted.map(record => record.name), ['stale-npm', 'kept-npm'], '队列结束后只保留真正的残留')
  eq(readInflight(app).some(record => record.name === 'run-npm'), false, '结束后运行项的记录已从文件移除')

  // B) recover 兜底：包不在 profile 依赖 + 首次 install 失败 → removeBundle 清残留 → 再装一次成功。
  const fallbackApp = await boot({
    bundles: [bundle({ name: 'gone-npm', source: 'gone-npm@1.0.0', update: 'registry' })],
    manager: (() => {
      let attempts = 0
      return makePluginManager([bundle({ name: 'gone-npm', source: 'gone-npm@1.0.0', update: 'registry' })], {
        installOutcomes: {
          'gone-npm@2.0.0': () => {
            attempts += 1
            if (attempts === 1) return { changed: false, application: 'failed', error: { code: 'install-failed', diagnostic: '包未在依赖中，无法原地升级' } }
            return { changed: true, application: 'applied', stage: 'install', target: 'gone-npm@2.0.0' }
          },
        },
        removeOutcomes: { 'gone-npm': { changed: true, application: 'applied', stage: 'remove', target: 'gone-npm' } },
      })
    })(),
    prepare: (profileDir) => {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'fake-profile', dependencies: {} }, null, 2), 'utf8')
      const cacheDir = join(profileDir, '.pluginmarket-plus')
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(join(cacheDir, 'updates-inflight.json'), JSON.stringify({ version: 1, items: [{ name: 'gone-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-gone', phase: 'removing', startedAt: 1_700_000_003_000 }] }, null, 2), 'utf8')
    },
  })
  const fallback = await fallbackApp.call(`${API}/updates/recover`, { body: {} })
  eq(fallback.status, 200, 'recover 兜底场景 200')
  const fallbackResult = fallback.body.results[0]
  eq(fallbackResult?.ok, true, '依赖缺失时兜底重装成功')
  eq(fallbackResult?.steps?.map(step => step.step), ['install', 'remove', 'reinstall'], 'steps 记录 install → remove → reinstall 三步', fallbackResult?.steps)
  eq(fallbackResult?.steps?.[0]?.ok, false, '首次 install 失败（带原因）', fallbackResult?.steps?.[0])
  eq(fallbackResult?.steps?.[1]?.ok, true, 'removeBundle 清残留成功', fallbackResult?.steps?.[1])
  eq(fallbackResult?.steps?.[2]?.ok, true, '二次 install 成功', fallbackResult?.steps?.[2])
  eq(fallbackApp.manager.calls.removeBundle, ['gone-npm'], '兜底时调用 removeBundle(包名)')
  eq(fallbackApp.manager.calls.installBundle.filter(spec => spec === 'gone-npm@2.0.0').length, 2, 'installBundle 被调用两次（首次失败 + 兜底重装）')
  eq(readInflight(fallbackApp), [], '兜底成功后残留记录被清空')

  // C) 包在 profile 依赖里时，install 失败不触发兜底（不会误删依赖）。
  let attemptsC = 0
  const keptManager = makePluginManager([bundle({ name: 'keep-npm', source: 'keep-npm@1.0.0', update: 'registry' })], {
    installOutcomes: { 'keep-npm@2.0.0': () => { attemptsC += 1; return { changed: false, application: 'failed', error: { code: 'install-failed', diagnostic: '版本冲突' } } } },
  })
  const keptApp = await boot({
    bundles: [bundle({ name: 'keep-npm', source: 'keep-npm@1.0.0', update: 'registry' })],
    manager: keptManager,
    prepare: (profileDir) => {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'fake-profile', dependencies: { 'keep-npm': '1.0.0' } }, null, 2), 'utf8')
      const cacheDir = join(profileDir, '.pluginmarket-plus')
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(join(cacheDir, 'updates-inflight.json'), JSON.stringify({ version: 1, items: [{ name: 'keep-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-keep', phase: 'installing', startedAt: 1_700_000_004_000 }] }, null, 2), 'utf8')
    },
  })
  const kept = await keptApp.call(`${API}/updates/recover`, { body: {} })
  eq(kept.body.results[0]?.ok, false, '依赖仍在时 install 失败 → recover 失败')
  eq(kept.body.results[0]?.steps, undefined, '依赖仍在时不走兜底（没有 steps，即只有一次 install）', kept.body.results[0]?.steps)
  eq(kept.body.results[0]?.error, '版本冲突', '失败原因仍是首次 install 的 diagnostic', kept.body.results[0])
  eq(keptManager.calls.removeBundle, [], '依赖仍在时不调用 removeBundle')
  eq(readInflight(keptApp).map(record => record.name), ['keep-npm'], '失败项保留在中断日志里')

  // D) 兜底也失败：steps 保留每一步原因，记录仍在。
  let attemptsD = 0
  const badManager = makePluginManager([bundle({ name: 'bad-npm', source: 'bad-npm@1.0.0', update: 'registry' })], {
    installOutcomes: { 'bad-npm@2.0.0': () => { attemptsD += 1; return { changed: false, application: 'failed', error: { code: 'install-failed', diagnostic: `第 ${attemptsD} 次失败` } } } },
    removeOutcomes: { 'bad-npm': { changed: false, application: 'failed', error: { code: 'remove-failed', diagnostic: '删不掉' } } },
  })
  const badApp = await boot({
    bundles: [bundle({ name: 'bad-npm', source: 'bad-npm@1.0.0', update: 'registry' })],
    manager: badManager,
    prepare: (profileDir) => {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'fake-profile', dependencies: {} }, null, 2), 'utf8')
      const cacheDir = join(profileDir, '.pluginmarket-plus')
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(join(cacheDir, 'updates-inflight.json'), JSON.stringify({ version: 1, items: [{ name: 'bad-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-bad', phase: 'removing', startedAt: 1_700_000_005_000 }] }, null, 2), 'utf8')
    },
  })
  const bad = await badApp.call(`${API}/updates/recover`, { body: {} })
  eq(bad.body.results[0]?.ok, false, '兜底也失败时 recover 报失败')
  eq(bad.body.results[0]?.steps?.map(step => step.step), ['install', 'remove', 'reinstall'], '失败路径同样返回三步')
  eq(bad.body.results[0]?.steps?.[1]?.error, '删不掉', 'remove 失败原因带在 steps 里', bad.body.results[0]?.steps?.[1])
  eq(bad.body.results[0]?.steps?.[2]?.error, '第 2 次失败', 'reinstall 失败原因带在 steps 里', bad.body.results[0]?.steps?.[2])
  eq(readInflight(badApp).map(record => record.name), ['bad-npm'], '兜底失败后记录保留')

  for (const handle of [app, fallbackApp, keptApp, badApp]) {
    handle.dispose()
    rmSync(handle.profileDir, { recursive: true, force: true })
  }
}

section('中断记录自动核对：已装到目标/更高清掉，低于目标/缺失/失败保留')
{
  /**
   * 往 profile 写包依赖清单。
   * @param {string} profileDir - profile 目录。
   * @param {string[]} names - 依赖包名。
   * @returns {void}
   */
  const writeDeps = (profileDir, names) => {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'fake-profile', dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])) }, null, 2), 'utf8')
  }
  /**
   * 往缓存目录写中断日志。
   * @param {string} profileDir - profile 目录。
   * @param {object[]} items - 记录。
   * @returns {void}
   */
  const writeInflightAt = (profileDir, items) => {
    const cacheDir = join(profileDir, '.pluginmarket-plus')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'updates-inflight.json'), JSON.stringify({ version: 1, items }, null, 2), 'utf8')
  }
  /**
   * 读回中断日志的原始文本（不存在返回 null）。
   * @param {string} profileDir - profile 目录。
   * @returns {string|null} 文本。
   */
  const rawInflight = (profileDir) => {
    const path = join(profileDir, '.pluginmarket-plus', 'updates-inflight.json')
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  /**
   * 读回中断日志的 items（不存在返回 null）。
   * @param {string} profileDir - profile 目录。
   * @returns {object[]|null} items。
   */
  const itemsInflight = (profileDir) => {
    const raw = rawInflight(profileDir)
    return raw === null ? null : JSON.parse(raw).items
  }
  const npmRecord = (name, target) => ({ name, current: '1.0.0', target, kind: 'npm', requestId: `req-${name}`, phase: 'installing', startedAt: 1_700_000_000_000 })

  // A) 已装到 target：GET /updates 后从文件移除、interrupted 为空。
  const doneApp = await boot({
    bundles: [bundle({ name: 'done-npm', version: '2.0.0', source: 'done-npm@2.0.0', update: 'registry' })],
    manager: makePluginManager([bundle({ name: 'done-npm', version: '2.0.0', source: 'done-npm@2.0.0', update: 'registry' })]),
    prepare: (profileDir) => { writeDeps(profileDir, ['done-npm']); writeInflightAt(profileDir, [npmRecord('done-npm', '2.0.0')]) },
  })
  const doneRes = await doneApp.call(`${API}/updates`)
  eq(doneRes.status, 200, '已装到 target：GET /updates 200')
  eq(doneRes.body.interrupted, [], '已装到 target：interrupted 为空')
  eq(rawInflight(doneApp.profileDir), null, '已装到 target：中断日志文件被删除')

  // B) 已装更高版本：同样清掉。
  const higherApp = await boot({
    bundles: [bundle({ name: 'higher-npm', version: '2.5.0', source: 'higher-npm@2.5.0', update: 'registry' })],
    manager: makePluginManager([bundle({ name: 'higher-npm', version: '2.5.0', source: 'higher-npm@2.5.0', update: 'registry' })]),
    prepare: (profileDir) => { writeDeps(profileDir, ['higher-npm']); writeInflightAt(profileDir, [npmRecord('higher-npm', '2.0.0')]) },
  })
  const higherRes = await higherApp.call(`${API}/updates`)
  eq(higherRes.status, 200, '已装更高版本：GET /updates 200')
  eq(higherRes.body.interrupted, [], '已装更高版本：interrupted 为空')
  eq(rawInflight(higherApp.profileDir), null, '已装更高版本：文件被删除')

  // C) 已装低于 target：保留。
  const lowerApp = await boot({
    bundles: [bundle({ name: 'lower-npm', version: '1.5.0', source: 'lower-npm@1.5.0', update: 'registry' })],
    manager: makePluginManager([bundle({ name: 'lower-npm', version: '1.5.0', source: 'lower-npm@1.5.0', update: 'registry' })]),
    prepare: (profileDir) => { writeDeps(profileDir, ['lower-npm']); writeInflightAt(profileDir, [npmRecord('lower-npm', '2.0.0')]) },
  })
  const lowerRes = await lowerApp.call(`${API}/updates`)
  eq(lowerRes.status, 200, '已装低于 target：GET /updates 200')
  eq(lowerRes.body.interrupted.map(record => record.name), ['lower-npm'], '已装低于 target：记录保留')
  eq(itemsInflight(lowerApp.profileDir)?.map(record => record.name), ['lower-npm'], '已装低于 target：文件保留')

  // D) bundle 不存在（未安装）：保留。
  const missingApp = await boot({
    bundles: [],
    manager: makePluginManager([]),
    prepare: (profileDir) => { writeDeps(profileDir, []); writeInflightAt(profileDir, [npmRecord('gone-npm', '2.0.0')]) },
  })
  const missingRes = await missingApp.call(`${API}/updates`)
  eq(missingRes.status, 200, 'bundle 不存在：GET /updates 200')
  eq(missingRes.body.interrupted.map(record => record.name), ['gone-npm'], 'bundle 不存在：记录保留')
  eq(missingRes.body.interrupted[0]?.missingFromProfile, true, 'bundle 不存在：missingFromProfile=true（不在依赖里）')

  // E) listBundles 抛错：保留、文件不动、GET 仍 200、只 warn 不崩。
  const beforeRaw = JSON.stringify({ version: 1, items: [npmRecord('boom-list', '2.0.0')] }, null, 2)
  const boomApp = await boot({
    bundles: [],
    manager: (() => {
      const base = makePluginManager([])
      return {
        ...base,
        async listBundles() {
          base.calls.listBundles += 1
          throw new Error('listBundles 坏了')
        },
      }
    })(),
    prepare: (profileDir) => { writeDeps(profileDir, ['boom-list']); writeInflightAt(profileDir, [npmRecord('boom-list', '2.0.0')]) },
  })
  const boomRes = await boomApp.call(`${API}/updates`)
  eq(boomRes.status, 200, 'listBundles 抛错：GET /updates 仍 200')
  eq(boomRes.body.interrupted.map(record => record.name), ['boom-list'], 'listBundles 抛错：记录保留')
  eq(rawInflight(boomApp.profileDir), beforeRaw, 'listBundles 抛错：文件内容原样未改')
  ok(boomApp.warnLines.some(line => String(line).includes('核对中断记录失败')), 'listBundles 抛错：记录一条 warn', boomApp.warnLines)

  // F) 惰性：核对只在「有残留记录」时才多做一次 listBundles；没有记录时不额外调用。
  // 注意 GET /updates 本身要算候选列表，会调用 listBundles 一次，所以这里比较「有/无记录」的增量。
  const lazyApp = await boot({ bundles: [bundle({ name: 'lazy-npm' })], manager: makePluginManager([bundle({ name: 'lazy-npm' })]) })
  lazyApp.manager.calls.listBundles = 0
  const lazyRes = await lazyApp.call(`${API}/updates`)
  eq(lazyRes.status, 200, '无记录：GET /updates 200')
  eq(lazyRes.body.interrupted, [], '无记录：interrupted 为空')
  const callsWithoutRecords = lazyApp.manager.calls.listBundles
  ok(callsWithoutRecords >= 1, '无记录：GET /updates 只做候选列表那一次 listBundles', callsWithoutRecords)
  eq(lazyApp.warnLines.some(line => String(line).includes('核对中断记录失败')), false, '无记录：不触发核对路径的 warn')
  // 同一 app 写入一条已完成记录后再 GET：应恰好比无记录时多一次 listBundles（核对那一次）。
  writeInflightAt(lazyApp.profileDir, [npmRecord('lazy-npm', '1.0.0')])
  lazyApp.manager.calls.listBundles = 0
  const lazyWithRecord = await lazyApp.call(`${API}/updates`)
  eq(lazyWithRecord.body.interrupted, [], '有已完成记录：GET /updates 后记录被清掉')
  eq(lazyApp.manager.calls.listBundles, callsWithoutRecords + 1, '有记录时核对只多做一次 listBundles（无记录时零额外调用）')

  // G) 启动 warn 不重复报已完成项：一条已完成 + 一条未完成。
  const startupApp = await boot({
    bundles: [
      bundle({ name: 'startup-done', version: '2.0.0', source: 'startup-done@2.0.0', update: 'registry' }),
      bundle({ name: 'startup-pending', version: '1.0.0', source: 'startup-pending@1.0.0', update: 'registry' }),
    ],
    manager: makePluginManager([
      bundle({ name: 'startup-done', version: '2.0.0', source: 'startup-done@2.0.0', update: 'registry' }),
      bundle({ name: 'startup-pending', version: '1.0.0', source: 'startup-pending@1.0.0', update: 'registry' }),
    ]),
    prepare: (profileDir) => {
      writeDeps(profileDir, ['startup-done', 'startup-pending'])
      writeInflightAt(profileDir, [npmRecord('startup-done', '2.0.0'), npmRecord('startup-pending', '2.0.0')])
    },
  })
  await waitFor(() => startupApp.warnLines.some(line => String(line).includes('上次中断的更新')), '启动 warn 出现')
  const startupWarn = startupApp.warnLines.join(' | ')
  ok(startupWarn.includes('startup-pending'), '启动 warn 报未完成项', startupWarn)
  ok(!startupWarn.includes('startup-done'), '启动 warn 不重复报已完成项', startupWarn)
  eq(itemsInflight(startupApp.profileDir)?.map(record => record.name), ['startup-pending'], '启动核对后文件只剩未完成项')

  // H) Git：commit 完全相等才清掉；不同 commit 保留。
  const commitA = 'a'.repeat(40)
  const commitB = 'b'.repeat(40)
  const gitBundle = (name, commit) => bundle({ name, version: '1.1.0', source: `git+https://github.com/acme/${name}.git#${commit}`, update: 'git' })
  const gitDoneApp = await boot({
    bundles: [gitBundle('git-done', commitA)],
    manager: makePluginManager([gitBundle('git-done', commitA)]),
    prepare: (profileDir) => {
      writeDeps(profileDir, ['git-done'])
      writeInflightAt(profileDir, [{ name: 'git-done', current: '1.0.0', target: '1.1.0', kind: 'git', spec: `git+https://github.com/acme/git-done.git#${commitA}`, requestId: 'req-git-done', phase: 'installing', startedAt: 1_700_000_000_000 }])
    },
  })
  const gitDoneRes = await gitDoneApp.call(`${API}/updates`)
  eq(gitDoneRes.body.interrupted, [], 'git 同 commit：记录被清掉')
  eq(rawInflight(gitDoneApp.profileDir), null, 'git 同 commit：文件被删除')

  const gitOtherApp = await boot({
    bundles: [gitBundle('git-other', commitB)],
    manager: makePluginManager([gitBundle('git-other', commitB)]),
    prepare: (profileDir) => {
      writeDeps(profileDir, ['git-other'])
      writeInflightAt(profileDir, [{ name: 'git-other', current: '1.0.0', target: '1.1.0', kind: 'git', spec: `git+https://github.com/acme/git-other.git#${commitA}`, requestId: 'req-git-other', phase: 'installing', startedAt: 1_700_000_000_000 }])
    },
  })
  const gitOtherRes = await gitOtherApp.call(`${API}/updates`)
  eq(gitOtherRes.body.interrupted.map(record => record.name), ['git-other'], 'git 不同 commit：记录保留')

  for (const handle of [doneApp, higherApp, lowerApp, missingApp, boomApp, lazyApp, startupApp, gitDoneApp, gitOtherApp]) {
    handle.dispose()
    rmSync(handle.profileDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n=== t3 Host 集成验证：${passed} 项通过，${failed.length} 项失败（peer 解析兜底 ${peerResolution ? '已启用' : '未启用'}）===`)
if (failed.length > 0) {
  console.error('\n失败明细（含最小复现线索）：')
  for (const entry of failed) {
    console.error(`✗ [${entry.section}] ${entry.label}${entry.detail === undefined ? '' : `\n    ${entry.detail}`}`)
  }
  process.exit(1)
}
console.log('全部通过。')
process.exit(0)
