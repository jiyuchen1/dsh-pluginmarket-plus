#!/usr/bin/env node
/**
 * tools/client-selftest.mjs —— dsh-pluginmarket-plus 客户端自检（无浏览器）。
 *
 * 用最小 React 垫片 + 假 __ModuleLoader__ 装载 client.js，检查：
 *   1. plugins.tab 席位注册（name/id/order/label 走 ctx.locale，中文「可更新」）；
 *   2. 检查更新 / 统计条 / 过滤 / 搜索 / 两个开关（POST /settings 持久化）；
 *   3. 行的复选框、插件名（点击即 openPackage）、当前→目标版本、registry/git 徽标、状态徽标、[更新]；
 *   4. 全选 + 半选、底部批量栏、[一键更新]、[更新全部]（跳过不兼容项）；
 *   5. 更新确认框（版本、来源、回滚说明）→ POST /updates/apply → 进度轮询（阶段/日志/取消）→ 汇总；
 *   6. 不兼容行的「版本豁免」入口：勾选风险 → 二次确认 → POST /updates/exempt {acceptRisk:true} → 自动 apply；
 *   7. 只 require('react')、不 import @deepseek-ai、CSS 只用 --dsw-alias-* token、注册全部经 ctx.effect。
 *
 * 用法：node tools/client-selftest.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client.js')

let passed = 0
let failed = 0
const failures = []

/**
 * 断言。
 * @param {boolean} condition - 条件。
 * @param {string} label - 断言说明。
 * @returns {void}
 */
function ok(condition, label) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
    return
  }
  failed += 1
  failures.push(label)
  console.log(`  ✗ ${label}`)
}

/**
 * @param {unknown} actual - 实际值。
 * @param {unknown} expected - 期望值。
 * @param {string} label - 断言说明。
 * @returns {void}
 */
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

/** ------------------------------------------------------------------ *
 * 最小 React 垫片
 * ------------------------------------------------------------------ */
const hookState = new WeakMap()
let currentInstance = null
let currentName = ''
let hookCursor = 0
let pending = []
let mount = { effects: [], cleanups: [] }
let cleanups = new Map()

/**
 * 取当前组件本次渲染的第 N 个 hook 槽（按调用顺序，和 React 一样）。
 * @returns {object} 槽。
 */
function slotAt() {
  const instance = currentInstance
  const hooks = hookState.get(instance)
  const index = hookCursor
  hookCursor += 1
  if (hooks[index] === undefined) hooks[index] = { value: undefined, deps: undefined }
  return hooks[index]
}

/**
 * 重新渲染整棵树。
 * @param {object} tree - 元素。
 * @returns {object} 渲染结果。
 */
function rerender(tree) {
  return walk(tree)
}

/**
 * 走一遍树，执行函数组件、收集宿主节点、触发副作用与更新队列。
 * @param {unknown} node - 元素 / 字符串 / null。
 * @returns {unknown} 渲染结果。
 */
function walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(walk)
  if (typeof node !== 'object' || typeof node.type === 'undefined') return node
  const { type, props } = node
  const children = Array.isArray(props?.children) ? props.children : (props?.children === undefined ? [] : [props.children])
  if (typeof type === 'function') {
    currentName = type.displayName || type.name || 'anonymous'
    currentInstance = node
    if (!hookState.has(node)) hookState.set(node, [])
    hookCursor = 0
    const previousInstance = currentInstance
    const rendered = type(Object.assign({}, props, { children }))
    const result = walk(rendered)
    currentInstance = previousInstance
    return result
  }
  const element = {
    type,
    props: Object.assign({}, props, { children }),
    rendered: children.map(walk).filter(child => child !== null),
    setAttribute(name, value) { this.props[name] = value },
  }
  if (props?.ref !== null && typeof props?.ref === 'object') props.ref.current = element
  return element
}

/**
 * 执行副作用 + 应用状态更新队列。
 * @param {object} tree - 根元素。
 * @param {object[]} store - 本次挂载的副作用记录。
 * @returns {object} 最新渲染结果。
 */
function flushWork(tree, store) {
  let guard = 0
  while (guard < 60) {
    guard += 1
    const effects = store.slice()
    store.length = 0
    if (effects.length > 0) {
      for (const effect of effects) {
        const cleanup = effect.fn()
        if (typeof cleanup === 'function') {
          const list = cleanups.get(effect.instance)
          if (list === undefined) cleanups.set(effect.instance, [cleanup])
          else list.push(cleanup)
        }
      }
      continue
    }
    if (pending.length === 0) break
    for (const task of pending.splice(0)) task()
  }
  return walk(tree)
}

const ReactShim = {
  createElement(type, props, ...children) {
    return { type, props: Object.assign({}, props, { children: children.length <= 1 ? children[0] : children }) }
  },
  Fragment: Symbol('Fragment'),
  useRef(initial) {
    const slot = slotAt()
    if (slot.value === undefined) slot.value = { current: initial }
    return slot.value
  },
  useState(initial) {
    const slot = slotAt()
    if (slot.value === undefined) slot.value = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      const before = slot.value
      const value = typeof next === 'function' ? next(before) : next
      if (Object.is(value, before)) return
      slot.value = value
      pending.push(() => {})
    }
    return [slot.value, setter]
  },
  useMemo(factory, deps) {
    const slot = slotAt()
    if (slot.value === undefined || !sameDeps(slot.deps, deps)) {
      slot.value = factory()
      slot.deps = deps
    }
    return slot.value
  },
  useCallback(fn, deps) {
    const slot = slotAt()
    if (slot.value === undefined || !sameDeps(slot.deps, deps)) {
      slot.value = fn
      slot.deps = deps
    }
    return slot.value
  },
  useEffect(fn, deps) {
    const slot = slotAt()
    if (slot.value !== undefined && sameDeps(slot.deps, deps)) return
    slot.value = fn
    slot.deps = deps
    mount.effects.push({ fn, instance: currentInstance, name: currentName })
  },
  useId() {
    const slot = slotAt()
    if (slot.value === undefined) slot.value = `id-${hookCursor}`
    return slot.value
  },
}

/**
 * @param {unknown[]|undefined} a - 旧依赖。
 * @param {unknown[]|undefined} b - 新依赖。
 * @returns {boolean} 是否相同。
 */
function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((item, index) => Object.is(item, b[index]))
}

/**
 * 挂载一个组件。
 * @param {Function} Component - 组件。
 * @param {object} props - 属性。
 * @returns {object} 渲染上下文。
 */
function renderComponent(Component, props) {
  mount = { effects: [], cleanups: [] }
  pending = []
  cleanups = new Map()
  const tree = { type: Component, props: Object.assign({}, props, { children: [] }) }
  const context = { tree, store: mount.effects, result: null }
  context.result = flushWork(tree, context.store)
  context.rerender = () => { context.result = flushWork(tree, context.store) }
  context.unmount = () => {
    for (const list of cleanups.values()) for (const fn of list) fn()
    cleanups.clear()
  }
  return context
}

/**
 * 等待挂起的请求 / 定时器回调把状态落地，并重渲染到稳定。
 * 假 fetch 也是 async，链比较深，所以用宏任务让微任务排空。
 * @param {object} context - 渲染上下文。
 * @returns {Promise<void>} 完成。
 */
async function settle(context) {
  // 每轮都重渲染：walk 注册的副作用在下一轮 flushWork 才执行，
  // 而假 fetch 也在 async 链上，所以等到连续多轮都没有新状态为止。
  let idle = 0
  for (let round = 0; round < 60; round += 1) {
    await new Promise(resolve => setImmediate(resolve))
    const before = pending.length
    context.rerender()
    if (pending.length === 0 && before === 0) {
      idle += 1
      if (idle >= 6) break
    } else {
      idle = 0
    }
  }
  context.rerender()
}

/**
 * 触发一次进度轮询（等价于定时器到点）并重渲染。
 * @param {object} context - 渲染上下文。
 * @returns {Promise<void>} 完成。
 */
async function tickPoll(context) {
  const current = intervals.filter(fn => typeof fn === 'function')
  for (const fn of current) fn()
  await settle(context)
}

/**
 * 取元素的可见文本（只用叶子节点拼接，避免同一段文字在父子节点里重复）。
 * @param {object} element - 宿主节点。
 * @returns {string} 文本。
 */
function nodeText(element) {
  if (element === null || element === undefined) return ''
  if (typeof element === 'string') return element
  if (typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(nodeText).join(' ')
  return nodeText(element.rendered)
}

/**
 * 只取叶子文本（避免同一段文字在父子节点里重复计数）。
 * @param {unknown} rendered - 渲染结果。
 * @returns {string} 文本。
 */
function leafText(rendered) {
  if (rendered === null || rendered === undefined) return ''
  if (typeof rendered === 'string' || typeof rendered === 'number') return String(rendered)
  if (Array.isArray(rendered)) return rendered.map(leafText).join(' ')
  if (typeof rendered !== 'object') return ''
  return leafText(rendered.rendered)
}

/**
 * 在渲染结果里收集所有元素。
 * @param {unknown} rendered - 渲染结果。
 * @param {object[]} [out] - 累加器。
 * @returns {object[]} 元素列表。
 */
function collect(rendered, out = []) {
  if (rendered === null || rendered === undefined) return out
  if (Array.isArray(rendered)) {
    for (const item of rendered) collect(item, out)
    return out
  }
  if (typeof rendered !== 'object') return out
  out.push(rendered)
  collect(rendered.rendered, out)
  return out
}

/**
 * 查找按钮（按文本或 aria-label）。
 * @param {object} context - 渲染上下文。
 * @param {string} label - 文本。
 * @returns {object|undefined} 元素。
 */
function findButton(context, label) {
  return collect(context.result).find(el => el.type === 'button' && (nodeText(el).includes(label) || el.props['aria-label'] === label))
}

/**
 * 按下按钮（异步处理函数会被等待，然后重渲染）。
 * @param {object} context - 渲染上下文。
 * @param {string} label - 文本。
 * @returns {Promise<object>} 元素。
 */
async function clickButton(context, label) {
  const button = findButton(context, label)
  if (button === undefined) throw new Error(`找不到按钮：${label}`)
  const outcome = button.props.onClick()
  if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') await outcome
  await settle(context)
  return button
}

/**
 * 按包名找一行。
 * @param {object} context - 渲染上下文。
 * @param {string} name - 包名。
 * @returns {object} 行元素。
 */
function rowFor(context, name) {
  const rows = collect(context.result).filter(el => el.type === 'div' && el.props.className === 'pmu-row')
  const found = rows.find(row => nodeText(row).includes(name))
  if (found === undefined) throw new Error(`找不到 ${name} 那一行`)
  return found
}

/**
 * 按精确文本点过滤 chip（避免和「更新全部」撞车）。
 * @param {object} context - 渲染上下文。
 * @param {string} label - chip 文本。
 * @returns {Promise<void>} 完成。
 */
function gearButton(context) {
  return collect(context.result).find(el => el.type === 'button' && String(el.props?.className ?? '').split(/\s+/u).includes('pmu-gearBtn'))
}

/**
 * 打开齿轮设置菜单。
 * @param {object} context - 渲染上下文。
 * @returns {Promise<void>} 完成。
 */
async function openSettings(context) {
  const gear = gearButton(context)
  if (gear === undefined) throw new Error('找不到设置齿轮按钮')
  gear.props.onClick()
  await settle(context)
}

/**
 * 取设置菜单里的开关（顺序：显示检查失败的项 / 包含预发布 / 包含已禁用）。
 * @param {object} context - 渲染上下文。
 * @returns {object[]} 开关按钮。
 */
function menuSwitches(context) {
  return collect(context.result).filter(el => el.type === 'button' && el.props.role === 'switch')
}

/**
 * 在弹窗范围内找按钮（避免和页面上同名按钮撞车）。
 * @param {object} context - 渲染上下文。
 * @param {string} label - 文本。
 * @returns {object|undefined} 元素。
 */
function findModalButton(context, label) {
  const dialog = collect(context.result).find(el => el.type === 'div' && el.props.role === 'dialog')
  if (dialog === undefined) return undefined
  return collect(dialog).find(el => el.type === 'button' && nodeText(el).includes(label))
}

/**
 * 在弹窗里按按钮并等待稳定。
 * @param {object} context - 渲染上下文。
 * @param {string} label - 文本。
 * @returns {Promise<object>} 元素。
 */
async function clickModalButton(context, label) {
  const button = findModalButton(context, label)
  if (button === undefined) throw new Error(`弹窗里找不到按钮：${label}`)
  const outcome = button.props.onClick()
  if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') await outcome
  await settle(context)
  return button
}

/**
 * 行主布局：按顺序返回 pmu-rowMain 的子元素标记。
 * @param {object} context - 渲染上下文。
 * @param {string} name - 包名。
 * @returns {string[]} 标记数组。
 */
function rowLayout(context, name) {
  const main = rowMain(context, name)
  const markers = []
  for (const el of main.rendered ?? []) {
    if (el === null || typeof el !== 'object') continue
    if (el.type === 'input') { markers.push('checkbox'); continue }
    const classes = String(el.props?.className ?? '').split(/\s+/u)
    if (classes.includes('pmu-name') || classes.includes('pmu-nameLink')) markers.push('name')
    else if (classes.includes('pmu-kindBadge')) markers.push('kind')
    else if (classes.includes('pmu-versions')) markers.push('versions')
    else if (classes.includes('pmu-spacer')) markers.push('spacer')
    else if (classes.includes('pmu-disabledBadge')) markers.push('disabled')
    else if (classes.includes('pmu-statusBadge')) markers.push('status')
    else if (classes.includes('pmu-rowActions')) markers.push('actions')
  }
  return markers
}

/**
 * 取行主区（pmu-rowMain）元素。
 * @param {object} context - 渲染上下文。
 * @param {string} name - 包名。
 * @returns {object} 元素。
 */
function rowMain(context, name) {
  const main = collect(rowFor(context, name)).find(el => el.type === 'div' && el.props.className === 'pmu-rowMain')
  if (main === undefined) throw new Error(`找不到 ${name} 的 pmu-rowMain`)
  return main
}

/**
 * 从 CSS 文本里取某个选择器的声明块。
 * @param {string} css - 样式表文本。
 * @param {string} selector - 选择器（精确匹配 `selector{`）。
 * @returns {string} 声明块内容。
 */
function cssRule(css, selector) {
  const start = css.indexOf(`${selector}{`)
  if (start === -1) return ''
  const bodyStart = start + selector.length + 1
  return css.slice(bodyStart, css.indexOf('}', bodyStart))
}

/**
 * 找某行的主状态徽标。
 * @param {object} context - 渲染上下文。
 * @param {string} name - 包名。
 * @returns {object|undefined} 徽标元素。
 */
function statusBadge(context, name) {
  return collect(rowFor(context, name)).find(el => String(el.props?.className ?? '').includes('pmu-statusBadge'))
}

/**
 * 找某行的来源徽标。
 * @param {object} context - 渲染上下文。
 * @param {string} name - 包名。
 * @returns {object|undefined} 徽标元素。
 */
function kindBadge(context, name) {
  return collect(rowFor(context, name)).find(el => String(el.props?.className ?? '').includes('pmu-kindBadge'))
}

/**
 * 找输入元素。
 * @param {object} context - 渲染上下文。
 * @param {string} ariaLabel - aria-label。
 * @returns {object|undefined} 元素。
 */
function findInput(context, ariaLabel) {
  return collect(context.result).find(el => (el.type === 'input' || el.type === 'textarea') && el.props['aria-label'] === ariaLabel)
}

/**
 * 触发输入事件。
 * @param {object} element - 输入元素。
 * @param {object} value - 事件对象。
 * @returns {void}
 */
function fireChange(element, value) {
  element.props.onChange(value)
}

/**
 * 悬停：把所有渲染文本拼起来，用于断言文案。
 * @param {object} context - 渲染上下文。
 * @returns {string} 文本。
 */
function allText(context) {
  return leafText(context.result).replace(/\s+/g, ' ')
}

/**
 * 给裸的 fetch 实现补上 calls 记录（用例里临时替换 fakeFetch 时用）。
 * @param {Function} impl - 原始实现。
 * @returns {Function} 带 calls 的实现。
 */
function withCalls(impl) {
  const calls = []
  const wrapped = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) })
    return impl(url, init)
  }
  wrapped.calls = calls
  return wrapped
}

/** ------------------------------------------------------------------ *
 * 假宿主环境
 * ------------------------------------------------------------------ */
const registrations = []
const effectLabels = []
let fakeFetch = null
let bootDictZh = {}

function makeCtx() {
  let activeDict = {}
  const t = (key, params) => {
    let out = typeof activeDict[key] === 'string' ? activeDict[key] : key
    if (params !== null && typeof params === 'object') {
      for (const name of Object.keys(params)) out = out.split(`{${name}}`).join(String(params[name]))
    }
    return out
  }
  t.locale = 'zh'
  return {
    effect(fn, label) {
      effectLabels.push(label)
      fn()
      return () => {}
    },
    locale: {
      register(ns, provided) {
        bootDictZh = provided.zh ?? {}
        activeDict = bootDictZh
        return () => {}
      },
      bind() { return t },
    },
    slots: {
      inject(slot, fn) {
        fn()
        return () => {}
      },
      register(descriptor, component) {
        registrations.push({ slot: descriptor.name, descriptor, component })
        return () => {}
      },
    },
  }
}

const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalFetch = globalThis.fetch
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const originalConsoleError = console.error

let intervals = []
let consoleErrors = []

function installGlobals() {
  registrations.length = 0
  effectLabels.length = 0
  intervals = []
  consoleErrors = []
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        globalThis.__pmpFactory = factory
      },
    },
  }
  globalThis.document = {
    head: { appendChild(node) { globalThis.__pmpStyle = node } },
    createElement() { return { dataset: {}, textContent: '', remove() { globalThis.__pmpStyle = null } } },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length }
  globalThis.clearInterval = (id) => { intervals[id - 1] = null }
  globalThis.fetch = (...args) => fakeFetch(...args)
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')) }
}

/**
 * 默认的假桥接（严格按 t1 的 Host 契约）。
 * @param {{settingsRef?: object, stateSeq?: Array, candidates?: Array}} [options] - 可调参数。
 * @returns {Function} fetch 实现。
 */
function defaultFetch(options = {}) {
  const calls = []
  const settingsRef = options.settingsRef ?? { updatesIncludeDisabled: false, updatesIncludePrerelease: false, updatesShowFailed: false }
  const stateSeq = options.stateSeq ?? null
  const candidates = options.candidates ?? CANDIDATES
  let stateIndex = 0
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ url, method, body })
    const json = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) })
    if (url === '/api/pluginmarket-plus/updates') {
      return json({
        ok: true,
        candidates,
        checkedAt: 1_700_000_000_000,
        index: { sources: ['https://example.com/index.json'], packages: candidates.length, error: null },
        // 真实 Host：GET /updates 的 config.showFailed，POST/status 回 updatesShowFailed。
        config: Object.assign({}, settingsRef, { showFailed: settingsRef.updatesShowFailed === true }),
        running: false,
      })
    }
    if (url === '/api/pluginmarket-plus/settings' && method === 'POST') {
      if (body?.updatesIncludeDisabled !== undefined) settingsRef.updatesIncludeDisabled = body.updatesIncludeDisabled
      if (body?.updatesIncludePrerelease !== undefined) settingsRef.updatesIncludePrerelease = body.updatesIncludePrerelease
      if (body?.updatesShowFailed !== undefined) settingsRef.updatesShowFailed = body.updatesShowFailed
      return json({ ok: true, saved: true, status: { config: Object.assign({}, settingsRef) } })
    }
    if (url === '/api/pluginmarket-plus/status') {
      return json({
        ok: true,
        cacheDir: 'C:/cache/pluginmarket-plus',
        nextRefreshAt: 1_700_000_600_000,
        writable: true,
        sources: [
          { id: 'src-1', url: 'https://example.com/index.json', title: '示例索引', packages: 12, fetchedAt: 1_700_000_000_000, error: null, stale: false },
          { id: 'src-2', url: 'https://second.example.com/index.json', title: '', packages: 0, fetchedAt: null, error: 'ETIMEDOUT', stale: true },
        ],
        config: { autoRefresh: true, refreshIntervalHours: 4, managePluginMarket: false },
        pluginMarket: { available: true, managed: false, indexes: ['https://example.com/index.json'], error: null },
      })
    }
    if (url === '/api/pluginmarket-plus/updates/check') {
      return json({
        ok: true,
        checked: candidates.map(item => item.name),
        skipped: candidates.filter(item => item.state === 'skipped').map(item => item.name),
        unknown: [],
        candidates,
        checkedAt: 1_700_000_100_000,
      })
    }
    if (url === '/api/pluginmarket-plus/updates/apply') {
      const items = Array.isArray(body?.items) ? body.items : []
      return json({
        ok: true,
        started: true,
        requestIds: items.map((item, index) => `req-${index + 1}`),
        items: items.map(item => ({ name: item.name, requestId: 'req-1' })),
      })
    }
    if (url === '/api/pluginmarket-plus/updates/state') {
      const payload = stateSeq === null
        ? { ok: true, running: false, stopped: false, finished: false, summary: {}, active: null, activeRequestId: null, items: [], lastRun: null, checkedAt: 1_700_000_000_000 }
        : stateSeq[Math.min(stateIndex, stateSeq.length - 1)]
      stateIndex += 1
      return json(payload)
    }
    if (url === '/api/pluginmarket-plus/updates/cancel') {
      return json({ ok: true, cancelled: true, name: 'demo-plugin-a', state: { running: false, stopped: true, finished: false, items: [] } })
    }
    if (url === '/api/pluginmarket-plus/updates/exempt') {
      if (body?.acceptRisk !== true) return json({ ok: false, message: 'risk-not-accepted' }, 400)
      if (typeof body.package !== 'string' || typeof body.version !== 'string') return json({ ok: false, message: 'invalid-request' }, 400)
      return json({ ok: true, runtimeVersion: body.runtimeVersion ?? '0.3.9', result: { enabled: true } })
    }
    return json({ ok: false, message: `unexpected ${method} ${url}` }, 404)
  }
  impl.calls = calls
  return impl
}

/** 假候选列表：字段与 Host 桥（t1）一致。 */
const CANDIDATES = [
  {
    name: 'demo-plugin-a', current: '1.2.0', latest: '1.4.2', kind: 'npm', state: 'available',
    enabled: true, incompatible: null, prerelease: false, deprecated: null,
    spec: 'demo-plugin-a@1.2.0',
  },
  {
    name: 'demo-plugin-b', current: '0.9.1', latest: '1.0.0', kind: 'git', state: 'available',
    enabled: true, incompatible: null, prerelease: false, deprecated: null,
    spec: 'git+https://github.com/x/demo-b.git#0123456789abcdef0123456789abcdef01234567&path:/packages/b',
    origin: 'github.com/x/demo-b.git  /packages/b',
  },
  {
    name: 'demo-plugin-c', current: '2.0.0', latest: '3.0.0', kind: 'npm', state: 'available',
    enabled: true, prerelease: false, deprecated: null,
    spec: 'demo-plugin-c@2.0.0',
    // 真实 Host 形状（DSH evaluatePluginCompatibility → incompatiblePlugin），不是布尔：
    // { name, version, runtimeVersion, requirements: { 'engines.dsh': '>=0.4.0 <0.5.0' } }
    incompatible: {
      name: 'demo-plugin-c',
      version: '3.0.0',
      runtimeVersion: '0.3.9',
      requirements: { 'engines.dsh': '>=0.4.0 <0.5.0' },
    },
  },
  {
    name: 'demo-plugin-d', current: '1.0.0', latest: '1.1.0-rc.1', kind: 'npm', state: 'skipped',
    enabled: true, incompatible: null, prerelease: true, deprecated: null,
    spec: 'demo-plugin-d@1.0.0',
  },
  {
    name: 'demo-plugin-e', current: '0.4.0', latest: '0.5.0', kind: 'npm', state: 'available',
    enabled: false, incompatible: null, prerelease: false, deprecated: null,
    spec: 'demo-plugin-e@0.4.0',
  },
  {
    name: 'demo-plugin-f', current: '1.0.0', latest: '', kind: 'npm', state: 'error',
    enabled: true, incompatible: null, prerelease: false, deprecated: null, error: 'registry timeout',
  },
  {
    name: 'demo-plugin-g', current: '1.0.0', latest: '', kind: 'git', state: 'uncheckable',
    enabled: true, incompatible: null, prerelease: false, deprecated: null, reason: 'index-miss',
  },
  {
    name: 'demo-plugin-h', current: '1.0.0', latest: '1.0.0', kind: 'registry', state: 'current',
    enabled: true, incompatible: null, prerelease: false, deprecated: null,
  },
]

/** 默认「更新全部」只应勾选 a / b。 */
const AUTO_SELECTED = ['demo-plugin-a', 'demo-plugin-b']

/** 装载并 apply。 */
function bootClient() {
  registrations.length = 0
  effectLabels.length = 0
  globalThis.__pmpStyle = undefined
  const source = readFileSync(CLIENT, 'utf8')
  ok(source.includes('window.__ModuleLoader__.load('), 'client.js 走 __ModuleLoader__.load 装载')
  ok(!/require\(\s*['"]@deepseek-ai/.test(source) && !/^\s*import\s[^\n]*from\s*['"]@deepseek-ai/m.test(source), 'client.js 不 import / require 任何 @deepseek-ai 包')
  const requires = []
  globalThis.eval(source)
  globalThis.__pmpStyle = undefined
  const component = globalThis.__pmpFactory((name) => {
    requires.push(name)
    if (name !== 'react') throw new Error(`只允许 require('react')，实际 ${name}`)
    return ReactShim
  })
  eq(requires.join(','), 'react', '工厂只 require("react")')
  // 工厂本身必须无副作用：不注册席位、不写样式、不注册词典。
  ok(registrations.length === 0 && effectLabels.length === 0 && globalThis.__pmpStyle === undefined, '工厂函数无副作用（apply 之前不注册任何东西）')
  const ctx = makeCtx()
  component.apply(ctx)
  ok(globalThis.__pmpStyle !== undefined && typeof globalThis.__pmpStyle.textContent === 'string', '样式在 apply 内写入 <style>')
  ok(globalThis.__pmpStyle.dataset.plugin === 'dsh-pluginmarket-plus', '样式带插件标记，便于清理')
  return { component, ctx }
}

/**
 * 取 plugins.tab 注册。
 * @returns {object} 注册记录。
 */
function updatesRegistration() {
  const found = registrations.find(item => item.slot === 'plugins.tab' && item.descriptor.id === 'pluginmarket-plus-updates')
  if (found === undefined) throw new Error('没有注册 plugins.tab#pluginmarket-plus-updates')
  return found
}

/**
 * 取 plugins.tab 的「插件源缓存」注册。
 * @returns {object} 注册记录。
 */
function cacheRegistration() {
  const found = registrations.find(item => item.slot === 'plugins.tab' && item.descriptor.id === 'pluginmarket-plus-cache')
  if (found === undefined) throw new Error('没有注册 plugins.tab#pluginmarket-plus-cache')
  return found
}

/**
 * 渲染「插件源缓存」页。
 * @param {object} [props] - owner props 覆盖。
 * @returns {Promise<object>} 渲染上下文（首屏数据已加载）。
 */
async function renderCache(props = {}) {
  const registration = cacheRegistration()
  const context = renderComponent(registration.component, Object.assign({ t: registration.descriptor.inject().t }, props))
  await settle(context)
  return context
}

/**
 * 渲染「可更新」页。
 * @param {object} [props] - owner props 覆盖。
 * @returns {Promise<object>} 渲染上下文（首屏数据已加载）。
 */
async function renderUpdates(props = {}) {
  const registration = updatesRegistration()
  const context = renderComponent(registration.component, Object.assign({ t: registration.descriptor.inject().t }, props))
  // 首屏会先 GET /updates 再出列表；等 promise 链跑完再重渲染。
  await settle(context)
  return context
}

/** ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
const cases = []
const test = (title, fn) => { cases.push({ title, fn }) }

test('席位注册与词典', async () => {
  const { component } = bootClient()
  const item = updatesRegistration()
  eq(item.descriptor.name, 'plugins.tab', 'descriptor.name')
  eq(item.descriptor.id, 'pluginmarket-plus-updates', 'descriptor.id')
  eq(item.descriptor.order, 20, 'descriptor.order')
  eq(typeof item.descriptor.label, 'function', 'label 是 thunk')
  eq(bootDictZh.updatesTab, '可更新', 'ctx.locale 注册的中文词典含「可更新」')
  eq(item.descriptor.label(), bootDictZh.updatesTab, 'label 走 ctx.locale（与注册词典一致）')
  eq(item.descriptor.locale, 'pluginmarket-plus', 'descriptor.locale 指向本插件命名空间')
  const info = component.inspectable()
  eq(Object.keys(info.dict.zh).length, Object.keys(info.dict.en).length, 'zh/en 词典键数一致')
  for (const key of Object.keys(info.dict.zh)) {
    ok(typeof info.dict.en[key] === 'string', `en 词典含 ${key}`)
  }
  ok(effectLabels.some(label => label.includes('dictionaries')), '词典注册在 ctx.effect 内')
  ok(effectLabels.some(label => label.includes('styles')), '样式注册在 ctx.effect 内')
  ok(registrations.length === 2, `只注册 2 个席位（实际 ${registrations.length}）`)
  ok(registrations.every(item => item.slot === 'plugins.tab'), '两个席位都在 plugins.tab')
})

test('插件源缓存 tab：tab 内渲染状态卡 / 索引源 / 添加源 / 自动刷新 / 间隔 / 接管开关', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderCache()
  const text = allText(context)
  ok(text.includes('示例索引'), '渲染索引源标题')
  ok(text.includes('https://example.com/index.json'), '渲染索引源地址')
  ok(text.includes('https://second.example.com/index.json'), '渲染第二个索引源')
  ok(text.includes('ETIMEDOUT'), '渲染索引源错误')
  ok(text.includes('全部刷新'), '有「全部刷新」按钮')
  ok(text.includes('自动刷新'), '有自动刷新开关')
  ok(text.includes('刷新间隔'), '有间隔选择')
  ok(text.includes('让发现页使用本地缓存') || text.includes('接管'), '有接管（本地缓存）开关')
  const select = collect(context.result).find(el => el.type === 'select')
  ok(select !== undefined, '间隔是原生 select')
  eq(String(select.props.value), '4', '间隔默认 4 小时')
  eq((select.rendered ?? []).filter(el => el !== null && typeof el === 'object').length, 7, '7 个间隔选项')
  const switches = collect(context.result).filter(el => el.type === 'button' && el.props.role === 'switch')
  eq(switches.length, 2, '两个开关（自动刷新 / 接管）')
  // 添加索引源
  const input = collect(context.result).find(el => el.type === 'input' && el.props.type !== 'checkbox' && el.props.type !== 'search')
  ok(input !== undefined, '有添加索引源的输入框')
  ok(collect(context.result).some(el => el.type === 'button' && nodeText(el).trim() === '添加'), '有「添加」按钮')
  // 不重复标题、无设置页内边距类
  ok(!collect(context.result).some(el => el.type === 'h2'), 'tab 内不再有重复的 h2 标题')
  const page = collect(context.result).find(el => String(el.props?.className ?? '').includes('pmp-page'))
  ok(String(page?.props?.className ?? '').includes('pmp-tabPage'), '根节点带 pmp-tabPage（tab 内不额外加内边距）')
  context.unmount()
})

test('插件源缓存 tab：注册 id/order/label，设置侧注册已移除', async () => {
  const { component } = bootClient()
  const item = cacheRegistration()
  eq(item.descriptor.name, 'plugins.tab', 'descriptor.name 是 plugins.tab')
  eq(item.descriptor.id, 'pluginmarket-plus-cache', "id = pluginmarket-plus-cache")
  eq(item.descriptor.order, 10, 'order = 10（discover 之后、可更新之前）')
  ok(item.descriptor.order < updatesRegistration().descriptor.order, '排在「可更新」（order 20）之前')
  eq(typeof item.descriptor.label, 'function', 'label 是 thunk')
  eq(item.descriptor.label(), bootDictZh.cacheTab, 'label 走 ctx.locale（插件源缓存）')
  eq(bootDictZh.cacheTab, '插件源缓存', '中文词典含「插件源缓存」')
  eq(item.descriptor.locale, 'pluginmarket-plus', 'descriptor.locale 指向本插件命名空间')
  eq(typeof item.component, 'function', '组件是 MarketCacheSection')
  // 三处设置侧注册都不再存在
  ok(!registrations.some(entry => entry.slot === 'settings.section'), 'settings.section 注册已移除')
  ok(!registrations.some(entry => entry.slot === 'settings.plugins.tab'), 'settings.plugins.tab 注册已移除')
  ok(!registrations.some(entry => entry.slot === 'settings.section.icon'), 'settings.section.icon 注册已移除')
  const info = component.inspectable()
  eq(info.dict.zh.nav, undefined, '旧 nav 文案键已删除')
  eq(info.dict.zh.title, undefined, '旧 title 文案键已删除（tab 标签已提供标题）')
  eq(info.dict.en.cacheTab, 'Plugin source cache', '英文词典含 Plugin source cache')
})

test('词典：删除过滤相关键，新增设置/显示检查失败键，zh=en', () => {
  const { component } = bootClient()
  const dict = component.inspectable().dict
  const removed = ['updatesFilterMenu', 'updatesFilterSelect', 'updatesFilterAll', 'updatesFilterUpdatable', 'updatesFilterFailed']
  for (const key of removed) {
    ok(dict.zh[key] === undefined && dict.en[key] === undefined, `已删除无用键 ${key}`)
  }
  eq(dict.zh.updatesSettingsMenu, '设置', '新增 updatesSettingsMenu（zh）')
  eq(dict.en.updatesSettingsMenu, 'Settings', '新增 updatesSettingsMenu（en）')
  eq(dict.zh.updatesShowFailed, '显示检查失败的项', '新增 updatesShowFailed（zh）')
  eq(dict.en.updatesShowFailed, 'Show failed checks', '新增 updatesShowFailed（en）')
  eq(Object.keys(dict.zh).length, Object.keys(dict.en).length, `zh/en 键数一致（${Object.keys(dict.zh).length}）`)
  const inspectable = component.inspectable()
  eq(inspectable.filters, undefined, '不再导出 filters')
  eq(inspectable.scopeStates.join(','), 'updatable,skipped,incompatible', '导出 scopeStates')
  eq(inspectable.failedScopeStates.join(','), 'failed,uncheckable,unknown', '导出 failedScopeStates')
  eq(typeof inspectable.inScope, 'function', '导出 inScope')
})

test('样式只用 --dsw-alias-* 颜色 token', async () => {
  const { component } = bootClient()
  const info = component.inspectable()
  const vars = [...info.css.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1])
  ok(vars.length > 0, 'CSS 引用了主题变量')
  const structural = new Set(['--dsw-radius-xs', '--dsw-radius-sm', '--dsw-radius-md', '--dsw-radius-lg', '--dsw-radius-xl', '--dsw-radius-panel', '--ds-font-family-code', '--dsw-focus-ring-width', '--dsw-focus-ring-color'])
  const offenders = vars.filter(name => !name.startsWith('--dsw-alias-') && !structural.has(name))
  ok(offenders.length === 0, `非法/未知 token：${offenders.join(', ') || '无'}`)
  const hex = [...info.css.matchAll(/:\s*([^;{}]*)/g)].map(match => match[1]).filter(value => /#[0-9a-fA-F]{3,8}\b/.test(value))
  ok(hex.length === 0, `CSS 颜色不写死十六进制：${hex.join(' | ') || '无'}`)
  ok(!/rgba?\(/.test(info.css), 'CSS 不写死 rgba() 颜色')
})

test('检查更新按钮与统计条', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  const text = allText(context)
  ok(text.includes('检查更新'), '有「检查更新」按钮')
  ok(text.includes('可更新 2 项'), '统计条显示可更新 2 项（不兼容/预发布/无更新/无法检查都不计入）')
  ok(text.includes('已选 0'), '统计条显示已选 0')
  await clickButton(context, '检查更新')
  const call = fakeFetch.calls.find(item => item.url.endsWith('/updates/check'))
  ok(call !== undefined, '点击后 POST /updates/check')
  eq(call.method, 'POST', 'check 用 POST')
  eq(call.body.names.length, CANDIDATES.length, 'check 带上当前候选包名')
  context.unmount()
})

test('工具条：单行五控件，检查时间在统计条最右', async () => {
  const { component } = bootClient()
  // 先构造「从未检查」（checkedAt: null）的桥接，再检查一次拿到时间。
  const impl = defaultFetch()
  fakeFetch = withCalls(async (url, init) => {
    if (url === '/api/pluginmarket-plus/updates') {
      const response = await impl(url, init)
      const payload = await response.json()
      return { ok: true, status: 200, json: async () => Object.assign({}, payload, { checkedAt: null }) }
    }
    return impl(url, init)
  })
  const context = await renderUpdates()
  ok(!collect(context.result).some(el => el.type === 'div' && String(el.props?.className ?? '') === 'pmu-head'), '不再有独立头部区域')
  ok(!collect(context.result).some(el => el.type === 'h3' && nodeText(el).includes('可更新')), '不再有「可更新」标题')
  ok(!collect(context.result).some(el => el.type === 'select'), '不再有独立过滤下拉')
  ok(!collect(context.result).some(el => el.type === 'button' && nodeText(el).trim() === '筛选'), '不再有「筛选」文字按钮')
  const toolbar = collect(context.result).find(el => el.type === 'div' && String(el.props?.className ?? '') === 'pmu-toolbar')
  ok(toolbar !== undefined, '有工具条')
  const kinds = (toolbar.rendered ?? []).filter(el => el !== null && typeof el === 'object').map(el => el.type === 'div' ? 'gear' : el.type)
  eq(kinds.join(','), 'button,input,gear,button,button', `工具条次序：检查更新 / 搜索框 / 齿轮 / 更新全部 / 更新已选（实际 ${kinds.join(',')}）`)
  const toolbarButtons = collect(toolbar)
    .filter(el => el.type === 'button' && String(el.props?.className ?? '').includes('pmp-btn') && !String(el.props?.className ?? '').includes('pmu-gearBtn'))
    .map(el => nodeText(el).trim())
  eq(JSON.stringify(toolbarButtons), JSON.stringify(['检查更新', '更新全部', '更新已选']), '工具条按钮文案与次序')
  const gear = gearButton(context)
  ok(gear !== undefined, '有齿轮按钮')
  eq(gear.props['aria-label'], '设置', '齿轮 aria-label=设置')
  eq(gear.props.title, '设置', '齿轮 title=设置')
  eq(nodeText(gear).trim(), '', '齿轮按钮无文字')
  // 检查时间在统计条最右
  const summaryChildren = () => {
    const summary = collect(context.result).find(el => el.type === 'div' && String(el.props?.className ?? '') === 'pmu-summary')
    return (summary?.rendered ?? []).filter(el => el !== null && typeof el === 'object')
  }
  const kids = summaryChildren()
  ok(String(kids[kids.length - 1].props?.className ?? '').includes('pmu-summaryTime'), '统计条最后一个元素是检查时间')
  ok(nodeText(kids[kids.length - 1]).includes('尚未检查'), '未检查时显示「尚未检查」')
  ok(/margin-left:auto/u.test(cssRule(component.inspectable().css, '.pmu-summaryTime')), '检查时间右对齐（margin-left:auto）')
  await clickButton(context, '检查更新')
  const kids2 = summaryChildren()
  ok(/上次检查\s*\d{1,2}:\d{2}/u.test(nodeText(kids2[kids2.length - 1])), '检查后显示「上次检查 HH:MM」')
  context.unmount()
})

test('设置菜单结构：菜单不是全屏遮罩的后代（回归：不能再被定位到视口外）', async () => {
  const { component } = bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  await openSettings(context)
  const wrap = collect(context.result).find(el => String(el.props?.className ?? '').split(/\s+/u).includes('pmu-filterWrap'))
  const layer = collect(context.result).find(el => String(el.props?.className ?? '').split(/\s+/u).includes('pmu-menuLayer'))
  const menu = collect(context.result).find(el => String(el.props?.className ?? '').split(/\s+/u).includes('pmu-menu'))
  ok(wrap !== undefined && layer !== undefined && menu !== undefined, 'filterWrap / 遮罩 / 菜单都在')
  ok(!collect(layer).includes(menu), '菜单不是 pmu-menuLayer 的后代（根因回归断言）')
  const wrapChildren = (wrap.rendered ?? []).filter(el => el !== null && typeof el === 'object')
  ok(wrapChildren.includes(layer) && wrapChildren.includes(menu), '遮罩与菜单都是 pmu-filterWrap 的直接子节点（兄弟）')
  ok(wrapChildren.indexOf(layer) < wrapChildren.indexOf(menu), '遮罩在菜单之前（菜单绘制在其上）')
  // 定位基准与层级
  const css = component.inspectable().css
  ok(/position:relative/u.test(cssRule(css, '.pmu-filterWrap')), 'filterWrap 是定位包含块（position:relative）')
  const menuRule = cssRule(css, '.pmu-menu')
  ok(/position:absolute/u.test(menuRule), '菜单用绝对定位（相对 filterWrap）')
  ok(/top:calc\(100% \+ 6px\)/u.test(menuRule), '菜单贴在按钮下方（top:calc(100% + 6px)）')
  const menuZ = Number((menuRule.match(/z-index:(\d+)/u) ?? [])[1])
  const layerZ = Number((cssRule(css, '.pmu-menuLayer').match(/z-index:(\d+)/u) ?? [])[1])
  ok(Number.isFinite(menuZ) && Number.isFinite(layerZ) && menuZ > layerZ, `菜单 z-index(${menuZ}) 高于遮罩(${layerZ})`)
  ok(/max-width:min\(320px,92vw\)/u.test(menuRule), '菜单宽度受视口约束（min(320px,92vw)）')
  ok(/max-height:min\(70vh,360px\)/u.test(menuRule), '菜单高度受视口约束（min(70vh,360px)）')
  ok(/\.pmu-menu\[data-placement="top"\]\[data-anchored="css"\]/u.test(css), '有向上换向的样式规则（仅纯 CSS 定位时生效）')
  ok(/position:fixed/u.test(cssRule(css, '.pmu-menuLayer')), '遮罩仍铺满视口')
  // 菜单内部点击不关闭
  let stopped = false
  menu.props.onClick({ stopPropagation: () => { stopped = true } })
  await settle(context)
  ok(stopped, '菜单内部点击阻止冒泡')
  eq(gearButton(context).props['aria-expanded'], 'true', '点菜单内部不关闭菜单')
  // 点按钮开合：再次点击收起
  await openSettings(context)
  eq(gearButton(context).props['aria-expanded'], 'false', '再点齿轮收起菜单（点按钮开合）')
  ok(!collect(context.result).some(el => String(el.props?.className ?? '').split(/\s+/u).includes('pmu-menu')), '收起后菜单与遮罩都不在')
  context.unmount()
})

test('menuPlacement：贴下方、空间不足换向、水平贴边不出视口', () => {
  const { component } = bootClient()
  const { menuPlacement } = component.inspectable()
  const anchor = { left: 40, right: 100, top: 20, bottom: 48 }
  eq(JSON.stringify(menuPlacement(anchor, { width: 1200, height: 800 }, { width: 240, height: 108 })),
    JSON.stringify({ left: 40, top: 54, placement: 'bottom' }), '空间足够：贴按钮下方')
  const flip = menuPlacement({ left: 40, top: 700, bottom: 728 }, { width: 1200, height: 760 }, { width: 240, height: 108 })
  eq(flip.placement, 'top', '下方空间不足：向上换向')
  eq(flip.top, 700 - 6 - 108, '换向后贴按钮上方')
  eq(menuPlacement({ left: 1100, top: 20, bottom: 48 }, { width: 1200, height: 800 }, { width: 240, height: 108 }).left, 1200 - 240 - 8, '右侧超出：贴右边距')
  eq(menuPlacement({ left: -50, top: 20, bottom: 48 }, { width: 1200, height: 800 }, { width: 240, height: 108 }).left, 8, '左侧超出：贴左边距')
  const narrow = menuPlacement({ left: 10, top: 20, bottom: 48 }, { width: 320, height: 800 }, { width: 300, height: 108 })
  eq(narrow.left, 10, '窄屏：菜单在视口内就不动')
  ok(narrow.left + 300 <= 320 - 8, `窄屏：右边缘留白（${narrow.left}+300 ≤ 312）`)
  eq(menuPlacement({ left: 10, top: 20, bottom: 48 }, { width: 320, height: 800 }, { width: 320, height: 108 }).left, 8, '菜单等于视口宽：贴左边距')
  const unknown = menuPlacement(anchor, { width: 0, height: 0 }, { width: 0, height: 0 })
  eq(unknown.placement, 'bottom', '拿不到视口尺寸时退化为贴下方')
  ok(Number.isFinite(unknown.left) && Number.isFinite(unknown.top), '退化时坐标仍是有限数')
})

test('Host 的 config.showFailed=true：首屏就显示检查失败/无法检查的项', async () => {
  bootClient()
  const settingsRef = { updatesIncludeDisabled: false, updatesIncludePrerelease: false, updatesShowFailed: true }
  fakeFetch = defaultFetch({ settingsRef })
  const context = await renderUpdates()
  const text = allText(context)
  ok(text.includes('demo-plugin-f') && text.includes('检查失败'), '打开状态下来自 GET /updates 的 config.showFailed=true → 显示 failed 行')
  ok(text.includes('demo-plugin-g') && text.includes('无法检查'), '同时显示 uncheckable 行')
  eq(menuSwitches(context).length, 0, '默认不展开菜单')
  await openSettings(context)
  eq(menuSwitches(context)[0].props['aria-checked'], 'true', '菜单里「显示检查失败的项」呈打开态')
  context.unmount()
})

test('空态：全是无更新行 → 「没有可更新的插件。」；只有失败的项 → 提示打开开关', async () => {
  bootClient()
  fakeFetch = defaultFetch({ candidates: [{ name: 'only-current', current: '1.0.0', latest: '1.0.0', kind: 'npm', state: 'current', enabled: true, incompatible: null, prerelease: false, deprecated: null }] })
  let context = await renderUpdates()
  ok(allText(context).includes('没有可更新的插件。'), '只有无更新行时显示「没有可更新的插件。」')
  ok(!allText(context).includes('可在设置里打开'), '没有隐藏的失败项时不提示开关')
  context.unmount()
  bootClient()
  fakeFetch = defaultFetch({ candidates: [{ name: 'only-failed', current: '1.0.0', latest: '', kind: 'npm', state: 'error', enabled: true, incompatible: null, prerelease: false, deprecated: null }] })
  context = await renderUpdates()
  ok(allText(context).includes('可在设置里打开「显示检查失败的项」'), '只有失败项时提示打开「显示检查失败的项」')
  ok(!allText(context).includes('only-failed'), '提示态下列表本身为空')
  context.unmount()
})

test('齿轮设置菜单：三个开关 + /settings 持久化，不再有过滤下拉', async () => {
  const { component } = bootClient()
  const settingsRef = { updatesIncludeDisabled: false, updatesIncludePrerelease: false, updatesShowFailed: false }
  fakeFetch = defaultFetch({ settingsRef })
  const context = await renderUpdates()
  const css = component.inspectable().css
  ok(!/\.pmu-chip/u.test(css), '样式表里不残留 chip 规则')
  ok(!/\.pmu-filterSelect/u.test(css), '样式表里不残留过滤下拉样式')
  ok(!collect(context.result).some(el => el.type === 'select'), '没有过滤下拉')
  ok(!collect(context.result).some(el => el.type === 'button' && nodeText(el).trim() === '筛选'), '没有「筛选」文字按钮')
  ok(findInput(context, '搜索包名…') !== undefined, '搜索框保留')
  eq(menuSwitches(context).length, 0, '默认不展开设置菜单')
  eq(gearButton(context).props['aria-expanded'], 'false', '齿轮 aria-expanded=false')
  await openSettings(context)
  eq(gearButton(context).props['aria-expanded'], 'true', '打开后 aria-expanded=true')
  const switches = menuSwitches(context)
  eq(switches.length, 3, '菜单里三个开关')
  const labels = collect(context.result)
    .filter(el => el.type === 'button' && String(el.props?.className ?? '').includes('pmu-switchLabel'))
    .map(el => nodeText(el).trim())
  eq(JSON.stringify(labels), JSON.stringify(['显示检查失败的项', '包含预发布/已废弃', '包含已禁用的插件']), `三个开关文案与顺序（实际 ${labels.join(' / ')}）`)
  eq(switches.map(el => el.props['aria-checked']).join(','), 'false,false,false', '默认三个都关')
  // 打开「显示检查失败的项」→ POST /settings 带 updatesShowFailed
  switches[0].props.onClick()
  await settle(context)
  const call = fakeFetch.calls.filter(item => item.url === '/api/pluginmarket-plus/settings').pop()
  ok(call !== undefined, '开关变化 POST /settings')
  eq(call.body.updatesShowFailed, true, '持久化 updatesShowFailed=true')
  eq(call.body.updatesIncludeDisabled, false, '同时带上其他开关当前值')
  eq(settingsRef.updatesShowFailed, true, '服务端配置已写入')
  ok(allText(context).includes('demo-plugin-f'), '打开后检查失败行出现')
  // 统计条保留（全选 + 可更新 N 项 · 已选 M）
  ok(allText(context).includes('全选'), '全选保留')
  ok(allText(context).includes('可更新 2 项 · 已选 0'), '统计条保留')
  eq(findButton(context, '更新全部').props.disabled, false, '有可安装项时「更新全部」可用')
  await clickButton(context, '更新全部')
  ok(allText(context).includes('确认更新 2 项'), '「更新全部」仍选全部可安装项')
  await clickModalButton(context, '取消')
  context.unmount()
})

test('行渲染：默认只显示有更新的项 / 版本 / 徽标 / 名称即详情 / openPackage', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const opened = []
  const context = await renderUpdates({ openPackage: (name) => { opened.push(name) } })
  const text = allText(context)
  ok(text.includes('demo-plugin-a'), '显示包名')
  ok(text.includes('1.2.0') && text.includes('1.4.2'), '显示 当前 → 目标 版本')
  ok(text.includes('npm') && text.includes('git'), '显示 npm / git 来源徽标')
  ok(!text.includes('registry'), '不再显示旧的 registry 字样')
  ok(text.includes('可更新') && text.includes('不兼容') && text.includes('预发布'), '显示状态徽标（可更新/不兼容/预发布）')
  ok(!text.includes('demo-plugin-f') && !text.includes('demo-plugin-g') && !text.includes('demo-plugin-h'), '默认隐藏 failed/uncheckable/无更新 行')
  ok(!text.includes('demo-plugin-e'), '「包含已禁用」默认关：已禁用插件不显示')
  const checkboxes = collect(context.result).filter(el => el.type === 'input' && el.props.type === 'checkbox')
  eq(checkboxes.length, 5, '每行一个复选框（4 行可见 + 全选）')
  // 详情按钮已删除，功能移到插件名称上。
  const buttons = collect(context.result).filter(el => el.type === 'button')
  ok(!buttons.some(el => nodeText(el).trim() === '详情'), '行内不再渲染「详情」按钮')
  const nameButtons = buttons.filter(el => String(el.props.className ?? '').includes('pmu-nameLink'))
  eq(nameButtons.length, 4, '每个可见行的插件名称都是可点击控件')
  const nameButton = nameButtons.find(el => nodeText(el).trim() === 'demo-plugin-a')
  ok(nameButton !== undefined, '插件名称是可点击控件')
  eq(nameButton?.props.type, 'button', '插件名称是 button 语义（可键盘聚焦）')
  nameButton?.props.onClick()
  await settle(context)
  eq(opened.length, 1, '点击插件名 → 调用 owner props openPackage(name)')
  eq(opened[0], 'demo-plugin-a', 'openPackage 收到该行的包名')
  // 打开「显示检查失败的项」后：失败/无法检查行出现
  await openSettings(context)
  menuSwitches(context)[0].props.onClick()
  await settle(context)
  const text2 = allText(context)
  ok(text2.includes('demo-plugin-f') && text2.includes('demo-plugin-g'), '打开开关后出现 failed / uncheckable 行')
  eq(nodeText(statusBadge(context, 'demo-plugin-f')).trim(), '检查失败', 'failed 行显示「检查失败」')
  eq(nodeText(statusBadge(context, 'demo-plugin-g')).trim(), '无法检查', 'uncheckable 行显示「无法检查」')
  eq(collect(context.result).filter(el => el.type === 'input' && el.props.type === 'checkbox').length, 7, '打开后 6 行可见 + 全选')
  ok(!allText(context).includes('demo-plugin-h'), '无更新行仍然不显示（不在基础范围也不在失败范围）')
  context.unmount()
})

test('行布局：复选框→名称→来源→版本→空隙→已禁用→主状态→操作（8 列固定顺序）', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  const normal = ['checkbox', 'name', 'kind', 'versions', 'spacer', 'status', 'actions']
  eq(JSON.stringify(rowLayout(context, 'demo-plugin-a')), JSON.stringify(normal), 'npm 行顺序：复选框→名称→来源→版本→空隙→(已禁用空列)→主状态→操作')
  eq(JSON.stringify(rowLayout(context, 'demo-plugin-b')), JSON.stringify(normal), 'git 行顺序一致')
  eq(JSON.stringify(rowLayout(context, 'demo-plugin-d')), JSON.stringify(normal), '预发布行顺序一致')
  eq(nodeText(kindBadge(context, 'demo-plugin-b')).trim(), 'git', 'git 行显示 git 徽标')
  // 来源徽标在版本变动之前；已禁用列始终占位（不是已禁用时为空）
  const order = rowLayout(context, 'demo-plugin-a')
  ok(order.indexOf('kind') < order.indexOf('versions'), '来源徽标在版本变动之前')
  ok(!order.includes('disabled'), '非禁用行不渲染已禁用徽标（该列由共享模板空占位）')
  ok(order.indexOf('status') === order.indexOf('actions') - 1, '主状态紧邻操作列左侧')
  // 打开「包含已禁用」（在齿轮设置菜单里）后：已禁用徽标出现在该列里
  await openSettings(context)
  menuSwitches(context)[2].props.onClick()
  await settle(context)
  const disabledLayout = rowLayout(context, 'demo-plugin-e')
  eq(JSON.stringify(disabledLayout), JSON.stringify(['checkbox', 'name', 'kind', 'versions', 'spacer', 'disabled', 'status', 'actions']), '已禁用行：已禁用徽标插在主状态列左侧')
  ok(nodeText(rowMain(context, 'demo-plugin-e')).includes('已禁用'), '已禁用徽标显示在已禁用列')
  context.unmount()
})

test('行主区是共享列宽的 CSS Grid（固定轨道 + 名称省略 + 操作右对齐 + 窄屏）', () => {
  const { component } = bootClient()
  const css = component.inspectable().css
  const main = cssRule(css, '.pmu-rowMain')
  ok(/display:grid/u.test(main), '行主区 display:grid（不是 flex）')
  const template = (main.match(/grid-template-columns:([^;}]*)/u) ?? [])[1]?.trim() ?? ''
  ok(template !== '', '声明了 grid-template-columns')
  const tracks = template.split(/\s+(?![^(]*\))/u)
  eq(tracks.length, 8, `8 个列轨道（实际：${template}）`)
  eq(tracks[0], 'auto', '第 1 列：复选框 auto')
  ok(/^minmax\(0,\s*1fr\)$/u.test(tracks[1]), '第 2 列：插件名 minmax(0,1fr)（吃剩余空间、可省略）')
  ok(/^\d+px$/u.test(tracks[2]), '第 3 列：更新来源固定 px 轨道')
  ok(/^\d+px$/u.test(tracks[3]), '第 4 列：版本变动固定 px 轨道')
  ok(/minmax\(/u.test(tracks[4]) || /^\d+px$/u.test(tracks[4]), '第 5 列：弹性空隙轨道')
  ok(/^\d+px$/u.test(tracks[5]), '第 6 列：已禁用固定 px 轨道（空也占位）')
  ok(/^\d+px$/u.test(tracks[6]), '第 7 列：主状态固定 px 轨道')
  ok(/minmax\(/u.test(tracks[7]) || /^\d+px$/u.test(tracks[7]), '第 8 列：操作列有界轨道')
  // 所有行共用同一模板：每行的 pmu-rowMain 都是同一 className、无内联 grid 覆盖
  ok(!/grid-template-columns/u.test(css.slice(css.indexOf('.pmu-row['), css.indexOf('.pmu-rowMain'))), '行容器自身不另设模板（模板只来自共享类）')
  // 名称省略
  const name = cssRule(css, '.pmu-name')
  ok(/text-overflow:ellipsis/u.test(name), '.pmu-name 有省略号')
  ok(/overflow:hidden/u.test(name), '.pmu-name 裁剪溢出')
  ok(/white-space:nowrap/u.test(name), '.pmu-name 不换行')
  ok(/min-width:0/u.test(name), '.pmu-name min-width:0')
  const nameCell = cssRule(css, '.pmu-nameCell')
  ok(/min-width:0/u.test(nameCell), '.pmu-nameCell min-width:0')
  // 每个网格项显式指定列（空列由模板轨道占位，后续列不位移）
  const columns = [
    ['.pmu-check', '1', '复选框'],
    ['.pmu-nameCell', '2', '插件名'],
    ['.pmu-kindBadge', '3', '更新来源'],
    ['.pmu-versions', '4', '版本变动'],
    ['.pmu-spacer', '5', '弹性空隙'],
    ['.pmu-disabledBadge', '6', '已禁用'],
    ['.pmu-statusBadge', '7', '主状态'],
    ['.pmu-rowActions', '8', '操作'],
  ]
  for (const [selector, column, label] of columns) {
    ok(new RegExp(`grid-column:${column}(;|$)`, 'u').test(cssRule(css, selector)), `${label}列显式 grid-column:${column}`)
  }
  ok(/justify-self:start/u.test(cssRule(css, '.pmu-statusBadge')), '主状态列在固定轨道内左对齐')
  // 不换行
  ok(/white-space:nowrap/u.test(cssRule(css, '.pmu-versions')), '.pmu-versions 不换行')
  ok(/white-space:nowrap/u.test(cssRule(css, '.pmu-disabledBadge')), '.pmu-disabledBadge 不换行')
  ok(/white-space:nowrap/u.test(cssRule(css, '.pmu-statusBadge')), '.pmu-statusBadge 不换行')
  ok(/white-space:nowrap/u.test(css), '状态徽标基类 pmp-badge 自带 nowrap')
  // 操作列右对齐 + 内部换行
  const actions = cssRule(css, '.pmu-rowActions')
  ok(/justify-content:flex-end/u.test(actions), '.pmu-rowActions 右对齐')
  ok(/flex-wrap:wrap/u.test(actions), '.pmu-rowActions 内部可换行（版本豁免入口不挤动其他列）')
  ok(/justify-self:end/u.test(actions), '.pmu-rowActions 在网格列内贴右')
  // 窄屏：收紧轨道
  ok(/@media\s*\(max-width:720px\)\s*\{\.pmu-rowMain\{grid-template-columns/u.test(css), '窄屏 720px 有收紧的 grid 模板')
  ok(/@media\s*\(max-width:560px\)\s*\{\.pmu-rowMain\{grid-template-columns/u.test(css), '窄屏 560px 有更紧凑的 grid 模板')
  ok(/@media\s*\(max-width:420px\)\s*\{\.pmu-rowMain\{grid-template-columns/u.test(css), '超窄屏 420px 有最紧凑的 grid 模板')
  ok(/\.pmu-spacer\{display:none\}/u.test(css), '窄屏隐藏弹性空隙')
})

test('跨行对齐：所有行共用同一 grid 模板且单元格无内联覆盖', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  const rows = collect(context.result).filter(el => el.type === 'div' && el.props.className === 'pmu-row')
  ok(rows.length >= 4, `渲染出多行（${rows.length}）`)
  const templates = []
  for (const row of rows) {
    const main = collect(row).find(el => el.type === 'div' && String(el.props?.className ?? '') === 'pmu-rowMain')
    ok(main !== undefined, '每行都有 pmu-rowMain')
    eq(main?.props?.style, undefined, '行主区没有内联 style（模板统一来自 CSS 类）')
    templates.push(String(main?.props?.className))
    // 7 个网格项（已禁用列为空时不渲染占位节点）或 8 个（含已禁用徽标）
    const cells = (main?.rendered ?? []).filter(el => el !== null && typeof el === 'object')
    ok(cells.length === 7 || cells.length === 8, `每行 7–8 个网格项（实际 ${cells.length}；空列由共享模板占位）`)
  }
  eq([...new Set(templates)].length, 1, '所有行的 grid 容器类完全一致（共享列宽）')
  context.unmount()
})

test('主状态唯一：每行一个状态徽标，不再有重复的预发布/已废弃标签', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  // 打开「显示检查失败的项」，让失败/无法检查的行走同一套渲染断言。
  await openSettings(context)
  menuSwitches(context)[0].props.onClick()
  await settle(context)
  const rows = collect(context.result).filter(el => el.type === 'div' && el.props.className === 'pmu-row')
  ok(rows.length > 0, '有可见行')
  for (const row of rows) {
    const badges = collect(row).filter(el => String(el.props?.className ?? '').includes('pmu-statusBadge'))
    ok(badges.length === 1, `每行恰好 1 个主状态徽标（${nodeText(row).slice(0, 24)}…）`)
  }
  // 预发布/已废弃只由主状态表达，不再附加重复徽标
  const prereleaseBadges = collect(context.result).filter(el => String(el.props?.className ?? '').includes('pmp-badge') && nodeText(el).trim() === '预发布')
  eq(prereleaseBadges.length, 1, '预发布只出现一次（主状态）')
  const states = rows.map(row => collect(row).find(el => String(el.props?.className ?? '').includes('pmu-statusBadge'))?.props['data-state'])
  ok(states.includes('updatable') && states.includes('incompatible') && states.includes('prerelease') && states.includes('failed') && states.includes('uncheckable'), `主状态覆盖各类型（实际 ${states.join(',')}）`)
  context.unmount()
})

test('无法检查徽标：原生 title 来自候选 reason（中文）', async () => {
  bootClient()
  const candidates = [
    { name: 'git-miss', current: '1.0.0', latest: null, kind: 'git', state: 'uncheckable', enabled: true, incompatible: null, prerelease: false, deprecated: null, reason: 'index-miss' },
    { name: 'git-unpinned', current: '1.0.0', latest: null, kind: 'git', state: 'uncheckable', enabled: true, incompatible: null, prerelease: false, deprecated: null, reason: 'unpinned-git-spec' },
    { name: 'git-other', current: '1.0.0', latest: null, kind: 'git', state: 'uncheckable', enabled: true, incompatible: null, prerelease: false, deprecated: null, reason: 'weird-reason' },
    { name: 'git-none', current: '1.0.0', latest: null, kind: 'git', state: 'uncheckable', enabled: true, incompatible: null, prerelease: false, deprecated: null },
  ]
  fakeFetch = defaultFetch({ candidates })
  const context = await renderUpdates()
  await openSettings(context)
  menuSwitches(context)[0].props.onClick()
  await settle(context)
  eq(statusBadge(context, 'git-miss')?.props.title, '本地索引中找不到该 Git 包可用的提交记录', 'index-miss → 本地索引找不到提交')
  eq(statusBadge(context, 'git-unpinned')?.props.title, 'Git 包未固定 commit，无法检查更新', 'unpinned-git-spec → 未固定 commit')
  eq(statusBadge(context, 'git-other')?.props.title, '暂时无法检查更新（原因未知）', '其它 reason → 兜底文案')
  eq(statusBadge(context, 'git-none')?.props.title, '暂时无法检查更新（原因未知）', '缺失 reason → 兜底文案')
  eq(nodeText(statusBadge(context, 'git-miss')).trim(), '无法检查', '主状态文案是「无法检查」')
  context.unmount()
})

test('无法检查徽标：英文 title 同样映射', async () => {
  const { component } = bootClient()
  const en = component.inspectable().dict.en
  const enT = (key, params) => {
    let out = en[key] ?? key
    for (const name of Object.keys(params ?? {})) out = out.split(`{${name}}`).join(String(params[name]))
    return out
  }
  const candidates = [
    { name: 'en-miss', current: '1.0.0', latest: null, kind: 'git', state: 'uncheckable', enabled: true, incompatible: null, prerelease: false, deprecated: null, reason: 'index-miss' },
    { name: 'en-unpinned', current: '1.0.0', latest: null, kind: 'git', state: 'uncheckable', enabled: true, incompatible: null, prerelease: false, deprecated: null, reason: 'unpinned-git-spec' },
  ]
  fakeFetch = defaultFetch({ candidates })
  const context = await renderUpdates({ t: enT })
  await openSettings(context)
  menuSwitches(context)[0].props.onClick()
  await settle(context)
  eq(statusBadge(context, 'en-miss')?.props.title, 'No usable commit for this Git bundle was found in the local index', '英文 index-miss 文案')
  eq(statusBadge(context, 'en-unpinned')?.props.title, 'This Git bundle is not pinned to a commit, so updates cannot be checked', '英文 unpinned-git-spec 文案')
  eq(nodeText(kindBadge(context, 'en-miss')).trim(), 'git', '英文下 git 徽标仍是 git')
  context.unmount()
})

test('主状态优先级与「已禁用」分离（纯函数）', () => {
  const { component } = bootClient()
  const { statusOf, uncheckableReasonText } = component.inspectable()
  const row = (over) => Object.assign({ state: 'updatable', incompatible: false, prerelease: false, deprecated: false, enabled: true }, over)
  eq(statusOf(row({ state: 'failed' }), false), 'failed', '检查失败最高')
  eq(statusOf(row({ state: 'failed', incompatible: true }), false), 'failed', '检查失败 > 不兼容')
  eq(statusOf(row({ state: 'uncheckable', incompatible: true }), false), 'uncheckable', '无法检查 > 不兼容')
  eq(statusOf(row({ incompatible: true }), false), 'incompatible', '不兼容 > 可更新')
  eq(statusOf(row({ incompatible: true }), true), 'exempted', '已豁免 > 不兼容')
  eq(statusOf(row({ state: 'incompatible' }), true), 'exempted', 'state=incompatible 且已豁免 → 已豁免')
  eq(statusOf(row({ state: 'skipped', deprecated: true }), false), 'deprecated', 'skipped+deprecated → 已废弃')
  eq(statusOf(row({ state: 'skipped', prerelease: true }), false), 'prerelease', 'skipped+prerelease → 预发布')
  eq(statusOf(row({ state: 'skipped' }), false), 'skipped', 'skipped → 跳过')
  eq(statusOf(row({ state: 'current' }), false), 'current', 'current → 无更新')
  eq(statusOf(row({ state: 'unknown' }), false), 'unknown', 'unknown → 未检查')
  eq(statusOf(row({ state: 'disabled', enabled: false }), false), 'updatable', 'state=disabled 时主状态仍是可更新（已禁用另列）')
  eq(statusOf(row({ enabled: false }), false), 'updatable', '已禁用不并入主状态')
  ok(!['disabled'].includes(statusOf(row({ state: 'disabled', enabled: false }), false)), '主状态永不返回 disabled')
  eq(uncheckableReasonText('index-miss', (key) => key), 'updatesUncheckableReasonIndexMiss', 'index-miss 映射专用文案键')
  eq(uncheckableReasonText('unpinned-git-spec', (key) => key), 'updatesUncheckableReasonUnpinned', 'unpinned-git-spec 映射专用文案键')
  eq(uncheckableReasonText('', (key) => key), 'updatesUncheckableReasonOther', '缺省映射兜底文案键')
})

test('默认范围（有更新的项）+ 搜索叠加 + 纯函数 inScope', async () => {
  const { component } = bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  ok(!collect(context.result).some(el => el.type === 'select'), '没有过滤下拉')
  ok(!collect(context.result).some(el => String(el.props?.className ?? '').split(/\s+/u).includes('pmu-chip')), '没有 chip 按钮')
  let text = allText(context)
  ok(text.includes('demo-plugin-a') && text.includes('demo-plugin-b') && text.includes('demo-plugin-c') && text.includes('demo-plugin-d'), '基础范围显示有更新的项（a/b/c/d）')
  ok(!text.includes('demo-plugin-f') && !text.includes('demo-plugin-g') && !text.includes('demo-plugin-h'), '默认隐藏 failed / uncheckable / 无更新')
  ok(!text.includes('demo-plugin-e'), '默认隐藏已禁用')
  // 空态提示：只剩「检查失败」这类被隐藏的条目时提示打开开关
  const search = findInput(context, '搜索包名…')
  ok(search !== undefined, '有搜索框')
  fireChange(search, { target: { value: 'demo-plugin-f' } })
  await settle(context)
  ok(allText(context).includes('可在设置里打开「显示检查失败的项」'), '搜索命中被隐藏的失败项 → 空态提示打开开关')
  fireChange(search, { target: { value: 'zzz' } })
  await settle(context)
  ok(allText(context).includes('没有匹配当前搜索的条目。'), '搜索无命中显示搜索空态')
  fireChange(search, { target: { value: 'demo-plugin-b' } })
  await settle(context)
  text = allText(context)
  ok(text.includes('demo-plugin-b') && !text.includes('demo-plugin-a'), '搜索按包名过滤')
  // 纯函数：范围状态
  const { inScope, scopeStates, failedScopeStates } = component.inspectable()
  eq(scopeStates.join(','), 'updatable,skipped,incompatible', '基础范围状态')
  eq(failedScopeStates.join(','), 'failed,uncheckable,unknown', '需要开关的范围状态')
  ok(inScope({ state: 'updatable' }, false) && inScope({ state: 'skipped' }, false) && inScope({ state: 'incompatible' }, false), '三种基础状态默认纳入')
  ok(!inScope({ state: 'failed' }, false) && !inScope({ state: 'uncheckable' }, false) && !inScope({ state: 'unknown' }, false), 'failed/uncheckable/unknown 默认不纳入')
  ok(inScope({ state: 'failed' }, true) && inScope({ state: 'uncheckable' }, true) && inScope({ state: 'unknown' }, true), '打开开关后纳入')
  ok(!inScope({ state: 'current' }, true), '无更新行永不纳入')
  ok(!inScope({ state: 'disabled' }, true), '未知状态不纳入')
  context.unmount()
})

test('更新全部：跳过不兼容项（默认只选稳定 + 启用中的）', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  await clickButton(context, '更新全部')
  const text = allText(context)
  ok(text.includes('确认更新 2 项'), '「更新全部」只选可安装的 2 项（排除不兼容/预发布/已禁用/检查失败/无更新）')
  ok(text.includes('1.2.0') && text.includes('1.4.2'), '确认框写清当前 → 目标版本')
  ok(text.includes('开始更新') === true, '确认框需要显式点「开始更新」')
  context.unmount()
})

test('单项更新：确认框 + POST /updates/apply', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  const row = rowFor(context, 'demo-plugin-a')
  const update = collect(row).find(el => el.type === 'button' && nodeText(el).includes('更新'))
  update.props.onClick()
  await settle(context)
  let text = allText(context)
  ok(text.includes('确认更新'), '点「更新」先出确认框')
  ok(text.includes('失败时会尝试装回当前版本'), '确认框写明失败会回滚')
  ok(text.includes('demo-plugin-a'), '确认框写清包名')
  ok(text.includes('1.2.0') && text.includes('1.4.2'), '确认框写清当前 → 目标版本')
  ok(text.includes('demo-plugin-a@1.2.0'), '确认框写明安装来源（registry 包显示其安装 spec）')
  await clickModalButton(context, '开始更新')
  const call = fakeFetch.calls.find(item => item.url.endsWith('/updates/apply'))
  ok(call !== undefined, '确认后 POST /updates/apply')
  eq(call.body.items.length, 1, 'apply 只带 1 项')
  eq(call.body.items[0].name, 'demo-plugin-a', 'apply 带包名')
  eq(call.body.items[0].version, undefined, 'apply 不带 version（Host 契约只认 name/spec/commit）')
  eq(call.body.items[0].spec, undefined, 'registry 行 apply 不带 spec')
  eq(call.body.items[0].commit, undefined, 'registry 行 apply 不带 commit')
  eq(call.body.requestId, undefined, 'apply 不带 requestId 参数')
  text = allText(context)
  ok(text.includes('更新进度'), '进入进度视图')
  eq(findInput(context, '全选').props['data-state'], 'none', '开始更新后清空选择')
  context.unmount()
})

test('git 包：确认框写清 git 位置与 spec', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  const gitRow = rowFor(context, 'demo-plugin-b')
  const update = collect(gitRow).find(el => el.type === 'button' && nodeText(el).includes('更新'))
  update.props.onClick()
  await settle(context)
  const text = allText(context)
  ok(text.includes('github.com/x/demo-b.git'), '确认框显示 git 仓库')
  ok(text.includes('/packages/b'), '确认框显示子目录')
  await clickModalButton(context, '开始更新')
  const call = fakeFetch.calls.filter(item => item.url.endsWith('/updates/apply')).pop()
  ok(typeof call.body.items[0].spec === 'string' && call.body.items[0].spec.includes('#0123456789abcdef'), 'git 项带上固定 commit 的 spec')
  ok(call.body.items[0].commit === undefined || typeof call.body.items[0].commit === 'string', 'git 项要么带 spec 要么带 commit（Host 契约二选一）')
  context.unmount()
})

test('选择与「更新已选」：无底部批量栏，工具条按钮等价批量更新', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  ok(!collect(context.result).some(el => String(el.props?.className ?? '').includes('pmu-bulk')), '没有底部批量栏（pmu-bulk）')
  let text = allText(context)
  ok(!text.includes('一键更新'), '不再有「一键更新」文案')
  ok(!/已选 \d+ 项/u.test(text), '统计条用「已选 M」而不是旧的「已选 N 项」批量栏文案')
  eq(findButton(context, '更新已选').props.disabled, true, '未选中时「更新已选」禁用')
  const rowCheckboxes = () => collect(context.result).filter(el => el.type === 'input' && el.props.type === 'checkbox' && el.props['aria-label'] !== '全选')
  fireChange(rowCheckboxes()[0], {})
  await settle(context)
  text = allText(context)
  ok(text.includes('已选 1'), '顶部统计条显示「已选 1」')
  eq(findButton(context, '更新已选').props.disabled, false, '选中 1 项后「更新已选」可用')
  const selectAll = findInput(context, '全选')
  eq(selectAll.props['data-state'], 'indeterminate', '部分选中时全选为半选（indeterminate）')
  fireChange(selectAll, {})
  await settle(context)
  eq(findInput(context, '全选').props['data-state'], 'all', '全选后为全选态')
  ok(allText(context).includes('已选 2'), '全选只覆盖可安装项（2 项）')
  await clickButton(context, '更新已选')
  ok(allText(context).includes('确认更新 2 项'), '「更新已选」对已选项出确认框')
  await clickModalButton(context, '开始更新')
  const applyCall = fakeFetch.calls.find(item => item.url.endsWith('/updates/apply'))
  ok(applyCall !== undefined, '确认后发起 apply')
  eq(applyCall.body.items.length, 2, 'apply 只带已选的 2 项')
  eq(applyCall.body.items.some(item => item.name === 'demo-plugin-c'), false, 'apply 不含不可安装项')
  context.unmount()
})

test('两个开关：默认关 + POST /settings 持久化', async () => {
  bootClient()
  const settingsRef = { updatesIncludeDisabled: false, updatesIncludePrerelease: false }
  fakeFetch = defaultFetch({ settingsRef })
  const context = await renderUpdates()
  const switches = () => collect(context.result).filter(el => el.type === 'button' && el.props.role === 'switch')
  eq(switches().length, 0, '默认不展开设置菜单（工具栏内联开关已移除）')
  eq(gearButton(context).props['aria-expanded'], 'false', '齿轮 aria-expanded=false')
  ok(!allText(context).includes('两个开关同时作用'), '不再显示开关说明提示（updatesSettingsHint）')
  await openSettings(context)
  eq(gearButton(context).props['aria-expanded'], 'true', '展开后 aria-expanded=true')
  eq(switches().length, 3, '菜单里三个开关')
  eq(switches()[0].props['aria-checked'], 'false', '显示检查失败的项默认关')
  eq(switches()[1].props['aria-checked'], 'false', '包含预发布/已废弃默认关')
  eq(switches()[2].props['aria-checked'], 'false', '包含已禁用默认关')
  let text = allText(context)
  ok(!text.includes('demo-plugin-e'), '关闭时不显示已禁用的候选')
  ok(text.includes('demo-plugin-d') && text.includes('默认不勾选') === false, 'skipped 的预发布条目仍显示（Host 明确给出）')
  ok(text.includes('可更新 2 项'), '关闭时「更新全部」只有 2 项')
  switches()[2].props.onClick()
  await settle(context)
  const call = fakeFetch.calls.filter(item => item.url === '/api/pluginmarket-plus/settings').pop()
  ok(call !== undefined, '开关变化 POST /api/pluginmarket-plus/settings')
  eq(call.body.updatesIncludeDisabled, true, '持久化 updatesIncludeDisabled=true')
  eq(call.body.updatesIncludePrerelease, false, '同时带上另一个开关的当前值')
  text = allText(context)
  ok(text.includes('demo-plugin-e'), '打开后显示已禁用条目')
  ok(text.includes('可更新 3 项'), '打开「包含已禁用」后「更新全部」多出该项')
  switches()[1].props.onClick()
  await settle(context)
  const call2 = fakeFetch.calls.filter(item => item.url === '/api/pluginmarket-plus/settings').pop()
  eq(call2.body.updatesIncludePrerelease, true, '持久化 updatesIncludePrerelease=true')
  eq(settingsRef.updatesIncludePrerelease, true, '假配置已被写入')
  ok(allText(context).includes('可更新 4 项'), '打开预发布开关后 skipped 的 a/b/d/e 都可自动勾选')
  // 切开关不会自动收起菜单
  eq(gearButton(context).props['aria-expanded'], 'true', '切开关后菜单仍展开')
  // 点击外部（遮罩）关闭
  const layer = collect(context.result).find(el => String(el.props?.className ?? '').includes('pmu-menuLayer'))
  ok(layer !== undefined, '菜单带可点击的遮罩层（覆盖点击外部）')
  layer.props.onClick()
  await settle(context)
  eq(collect(context.result).filter(el => el.props.role === 'switch').length, 0, '点击外部关闭设置菜单')
  eq(gearButton(context).props['aria-expanded'], 'false', '关闭后 aria-expanded=false')
  // Escape 关闭
  await openSettings(context)
  const wrap = collect(context.result).find(el => String(el.props?.className ?? '').includes('pmu-filterWrap'))
  ok(wrap !== undefined && typeof wrap.props.onKeyDown === 'function', '设置容器处理键盘事件')
  wrap.props.onKeyDown({ key: 'Escape' })
  await settle(context)
  eq(collect(context.result).filter(el => el.props.role === 'switch').length, 0, 'Escape 关闭设置菜单')
  context.unmount()
})

/** Host `/updates/state` 的队列项真实形状（lib/updates.js createUpdateQueue 的初始值）。 */
function hostItem(over = {}) {
  return Object.assign({
    name: 'demo-plugin-a', current: '1.2.0', latest: '1.4.2', version: '1.4.2', kind: 'npm',
    requestId: 'upd-1', stage: 'queued', success: false, failed: false, restartRequired: false,
    cancelled: false, error: null, restore: null, startedAt: 0, endedAt: null,
  }, over)
}

/** Host `/updates/state` 顶层真实形状。 */
function hostState(over = {}) {
  return Object.assign({
    ok: true, running: false, starting: false, stopped: false, finished: false,
    summary: { total: 0, success: 0, failed: 0, cancelled: 0, restartRequired: 0, skipped: 0, pending: 0 },
    active: null, activeRequestId: null, items: [], logs: [],
    lastRun: null, checkedAt: 1_700_000_000_000,
  }, over)
}

test('readSettings：解析嵌套 config，缺席时返回 undefined + known=false', () => {
  const { component } = bootClient()
  const { readSettings, mergeSettings } = component.inspectable()
  // POST /settings 的真实形状：配置在 status.config 里
  const post = readSettings({ ok: true, saved: true, status: { config: { updatesIncludeDisabled: true, updatesIncludePrerelease: false } } })
  eq(post.known, true, 'status.config 被识别（known=true）')
  eq(post.includeDisabled, true, 'status.config.updatesIncludeDisabled → true')
  eq(post.includePrerelease, false, 'status.config.updatesIncludePrerelease → false')
  // status.settings / status.updates 两种嵌套别名
  const viaSettings = readSettings({ ok: true, status: { settings: { updatesIncludePrerelease: true } } })
  eq(viaSettings.includePrerelease, true, 'status.settings 别名可解析')
  const viaUpdates = readSettings({ ok: true, status: { updates: { includeDisabled: true } } })
  eq(viaUpdates.includeDisabled, true, 'status.updates + 短键名可解析')
  // 「显示检查失败的项」：POST 的 status.config.updatesShowFailed 与 GET 的 config.showFailed
  const postFailed = readSettings({ ok: true, saved: true, status: { config: { updatesShowFailed: true } } })
  eq(postFailed.known, true, 'status.config.updatesShowFailed 被识别')
  eq(postFailed.showFailed, true, 'status.config.updatesShowFailed → true')
  const getFailed = readSettings({ ok: true, config: { showFailed: true, includePrerelease: false } })
  eq(getFailed.showFailed, true, 'GET 的 config.showFailed → true')
  eq(readSettings({ ok: true, config: { includePrerelease: true } }).showFailed, undefined, 'config 没有 showFailed 时返回 undefined')
  const mergedFailed = mergeSettings({ includeDisabled: false, includePrerelease: false, showFailed: true, settable: true }, { includePrerelease: false, settable: true, known: true })
  eq(mergedFailed.showFailed, true, 'mergeSettings 保留未被响应覆盖的 showFailed')
  // GET /updates 的顶层 config 仍然可解析
  const get = readSettings({ ok: true, config: { includeDisabled: false, includePrerelease: true } })
  eq(get.known, true, '顶层 config 被识别')
  eq(get.includeDisabled, false, '顶层 config.includeDisabled → false')
  eq(get.includePrerelease, true, '顶层 config.includePrerelease → true')
  // 缺席：必须是 undefined 而不是 false
  const absent = readSettings({ ok: true })
  eq(absent.known, false, '没有配置时 known=false')
  eq(absent.includeDisabled, undefined, '缺席时返回 undefined（而不是 false）')
  eq(absent.includePrerelease, undefined, '缺席时返回 undefined（而不是 false）')
  // saved:false → settable=false，但仍能读出开关值
  const unsaved = readSettings({ ok: true, saved: false, status: { config: { updatesIncludeDisabled: true } } })
  eq(unsaved.settable, false, 'saved:false → settable=false')
  eq(unsaved.includeDisabled, true, 'saved:false 仍能读出开关值')
  // mergeSettings：只并入确实提供的字段
  const merged = mergeSettings({ includeDisabled: true, includePrerelease: false, settable: true }, { known: false })
  eq(JSON.stringify(merged), JSON.stringify({ includeDisabled: true, includePrerelease: false, settable: true }), 'known=false 时本地状态完全不变')
  const merged2 = mergeSettings({ includeDisabled: true, includePrerelease: false, settable: true }, { includePrerelease: true, settable: true, known: true })
  eq(merged2.includePrerelease, true, '提供字段被并入')
  eq(merged2.includeDisabled, true, '未提供字段保持原值')
})

test('筛选开关回归：POST 响应缺配置时两个开关不会被翻成 false', async () => {
  bootClient()
  const settingsRef = { updatesIncludeDisabled: false, updatesIncludePrerelease: false }
  const impl = defaultFetch({ settingsRef })
  // POST /settings 只回 {ok,saved}（历史 bug 现场）：两个开关必须保持乐观值。
  // GET /updates 也不带 config，避免被 load() 悄悄「救回来」，从而真正复现回归。
  fakeFetch = withCalls(async (url, init) => {
    if (url === '/api/pluginmarket-plus/settings' && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, saved: true }), text: async () => '{}' }
    }
    if (url === '/api/pluginmarket-plus/updates') {
      const response = await impl(url, init)
      const payload = await response.json()
      const copy = Object.assign({}, payload)
      delete copy.config
      return { ok: true, status: 200, json: async () => copy }
    }
    return impl(url, init)
  })
  const context = await renderUpdates()
  await openSettings(context)
  const switchAt = (index) => collect(context.result).filter(el => el.type === 'button' && el.props.role === 'switch')[index]
  eq(switchAt(1).props['aria-checked'], 'false', '初始：包含预发布=false')
  eq(switchAt(2).props['aria-checked'], 'false', '初始：包含已禁用=false')
  switchAt(2).props.onClick()
  await settle(context)
  eq(switchAt(2).props['aria-checked'], 'true', '打开「包含已禁用」后保持 true（乐观值未被响应清掉）')
  eq(switchAt(1).props['aria-checked'], 'false', '另一个开关（包含预发布）没有被连带翻成 true 或 false')
  const call = fakeFetch.calls.filter(item => item.url === '/api/pluginmarket-plus/settings').pop()
  eq(call.body.updatesIncludeDisabled, true, 'POST 体带上新值')
  eq(call.body.updatesIncludePrerelease, false, 'POST 体带上另一个开关的当前值')
  context.unmount()
})

test('筛选开关回归：POST 响应带 status.config 时两个开关都正确', async () => {
  bootClient()
  const settingsRef = { updatesIncludeDisabled: false, updatesIncludePrerelease: false }
  fakeFetch = defaultFetch({ settingsRef })
  const context = await renderUpdates()
  await openSettings(context)
  const switchAt = (index) => collect(context.result).filter(el => el.type === 'button' && el.props.role === 'switch')[index]
  // defaultFetch 的 POST /settings 回 {ok,saved,status:{config:{...}}} —— 正是修复前会翻成 false 的形状
  switchAt(1).props.onClick()
  await settle(context)
  eq(switchAt(1).props['aria-checked'], 'true', '打开「包含预发布」后为 true')
  eq(switchAt(2).props['aria-checked'], 'false', '「包含已禁用」保持 false（未被响应覆盖）')
  switchAt(2).props.onClick()
  await settle(context)
  eq(switchAt(1).props['aria-checked'], 'true', '再开「包含已禁用」时「包含预发布」仍为 true')
  eq(switchAt(2).props['aria-checked'], 'true', '「包含已禁用」为 true')
  eq(settingsRef.updatesIncludePrerelease, true, '服务端配置同步了预发布开关')
  eq(settingsRef.updatesIncludeDisabled, true, '服务端配置同步了已禁用开关')
  context.unmount()
})

test('进度视图：真实 state 形状 / 顶层日志 / 取消当前 / 汇总', async () => {
  bootClient()
  const stateSeq = [
    // 运行中：Host 初始就是 success:false/failed:false，只有 stage 在变。
    hostState({
      running: true, active: 'demo-plugin-a', activeRequestId: 'upd-1',
      summary: { total: 1, success: 0, failed: 0, cancelled: 0, restartRequired: 0, skipped: 0, pending: 1 },
      items: [hostItem({ stage: 'removing', startedAt: 1 })],
      logs: ['removed 1.2.0'],
    }),
    hostState({
      running: true, active: 'demo-plugin-a', activeRequestId: 'upd-1',
      summary: { total: 1, success: 0, failed: 0, cancelled: 0, restartRequired: 0, skipped: 0, pending: 1 },
      items: [hostItem({ stage: 'installing', startedAt: 1 })],
      logs: ['installed 1.4.2'],
    }),
    hostState({
      running: false, finished: true,
      summary: { total: 1, success: 1, failed: 0, cancelled: 0, restartRequired: 1, skipped: 0, pending: 0 },
      items: [hostItem({ stage: 'done', success: true, restartRequired: true, startedAt: 1, endedAt: 2 })],
      logs: [],
    }),
  ]
  fakeFetch = defaultFetch({ stateSeq })
  const context = await renderUpdates()
  const planRow = rowFor(context, 'demo-plugin-a')
  collect(planRow).find(el => el.type === 'button' && nodeText(el).includes('更新')).props.onClick()
  await settle(context)
  await clickModalButton(context, '开始更新')
  ok(intervals.length > 0, '开始轮询进度')
  ok(allText(context).includes('移除'), '进度显示「移除」阶段')
  ok(allText(context).includes('取消当前'), '运行中可见「取消当前」')
  await tickPoll(context)
  let text = allText(context)
  ok(text.includes('安装'), '进度推进到「安装」阶段')
  ok(text.includes('阶段记录： 移除 → 安装'), '阶段历史保留（移除 → 安装）')
  const logButton = findButton(context, 'pnpm 日志')
  ok(logButton !== undefined, '日志可展开')
  logButton.props.onClick()
  await settle(context)
  ok(allText(context).includes('installed 1.4.2'), '展开后显示顶层 logs 归到当前项的日志文本')
  await clickButton(context, '取消当前')
  const cancelCall = fakeFetch.calls.find(item => item.url.endsWith('/updates/cancel'))
  ok(cancelCall !== undefined, '点击「取消当前」→ POST /updates/cancel')
  eq(JSON.stringify(cancelCall.body), '{}', '取消不带参数（Host 契约 POST {}）')
  text = allText(context)
  ok(text.includes('成功 1 项'), '结束汇总显示成功数')
  ok(text.includes('需重启 1 项'), '结束汇总显示需重启')
  ok(text.includes('完成'), '结束后有「完成」按钮')
  ok(text.includes('installed 1.4.2'), '队列结束后仍保留最后一次看到的日志')
  context.unmount()
})

test('进度：取消项显示「已取消」且不回显 error 原文', async () => {
  bootClient()
  const stateSeq = [hostState({
    running: false, stopped: true, finished: true,
    summary: { total: 2, success: 1, failed: 0, cancelled: 1, restartRequired: 0, skipped: 1, pending: 0 },
    items: [
      hostItem({ name: 'demo-plugin-a', stage: 'done', success: true, startedAt: 1, endedAt: 2 }),
      hostItem({ name: 'demo-plugin-b', stage: 'cancelled', cancelled: true, error: 'cancelled', startedAt: 3, endedAt: 3 }),
    ],
    logs: [],
  })]
  fakeFetch = defaultFetch({ stateSeq })
  const context = await renderUpdates()
  await clickButton(context, '更新全部')
  await clickModalButton(context, '开始更新')
  await tickPoll(context)
  const text = allText(context)
  ok(text.includes('已取消'), '取消项阶段显示「已取消」')
  ok(!/(^|\s)cancelled(\s|$)/u.test(text), '不回显 Host 写入的 error:"cancelled" 原文')
  ok(text.includes('已跳过 1 项') || text.includes('成功 1 项'), '汇总里有取消/成功计数')
  context.unmount()
})

test('回滚文案按 ChangeResult.application 判定', () => {
  const { component } = bootClient()
  const { restoreText } = component.inspectable()
  const t = (key, params) => {
    const dict = component.inspectable().dict.zh
    let out = dict[key] ?? key
    for (const name of Object.keys(params ?? {})) out = out.split(`{${name}}`).join(String(params[name]))
    return out
  }
  eq(restoreText({ application: 'applied' }, t), '已装回原版本', 'application=applied → 已装回原版本')
  eq(restoreText({ application: 'restart-required' }, t), '已装回原版本', 'application=restart-required → 已装回原版本')
  eq(restoreText({ application: 'failed', error: { code: 'install-failed', diagnostic: 'ENOSPC' } }, t), '回滚也失败了: ENOSPC', 'application=failed → 回滚也失败 + diagnostic')
  eq(restoreText({ application: 'failed', error: { code: 'install-failed' } }, t), '回滚也失败了: install-failed', '没有 diagnostic 时退回 code')
  eq(restoreText({ application: 'unchanged' }, t), '未发生回滚', 'application=unchanged → 中性文案')
  eq(restoreText({ application: 'cancelled' }, t), '未发生回滚', 'application=cancelled → 中性文案（不是失败）')
  eq(restoreText({}, t), '未发生回滚', '缺省 → 中性文案')
})

test('readProgress：Host 字段判定终态/失败/取消 + 顶层日志归属', () => {
  const { component } = bootClient()
  const { readProgress, progressTerminal } = component.inspectable()
  const payload = hostState({
    running: true, active: 'demo-plugin-b', activeRequestId: 'upd-b',
    items: [
      hostItem({ name: 'demo-plugin-a', requestId: 'upd-a', stage: 'queued' }),
      hostItem({ name: 'demo-plugin-b', requestId: 'upd-b', stage: 'installing', startedAt: 5 }),
    ],
    logs: ['pnpm: 正在安装 demo-plugin-b'],
  })
  const progress = readProgress(payload)
  eq(progress.status, 'running', 'running:true → 运行中')
  const [queued, installing] = progress.items
  eq(queued.failed, false, 'queued 项 success:false 不算失败')
  eq(progressTerminal(queued), false, 'queued 不是终态')
  eq(progressTerminal(installing), false, 'installing 不是终态')
  eq(installing.log, 'pnpm: 正在安装 demo-plugin-b', '顶层 logs 归到 activeRequestId 对应的项')
  eq(queued.log, '', '非 active 项不承接顶层日志')
  ok(!progress.items.some(item => item.failed), '运行中没有任何项被判失败')
  // 取消项
  const cancelled = readProgress(hostState({
    running: false, finished: true,
    items: [hostItem({ name: 'x', stage: 'cancelled', cancelled: true, error: 'cancelled' })],
  }))
  eq(cancelled.items[0].cancelled, true, 'cancelled:true → 取消')
  eq(cancelled.items[0].failed, false, '取消项不算失败')
  eq(cancelled.items[0].error, '', '取消项不回显 error:"cancelled"')
  eq(progressTerminal(cancelled.items[0]), true, 'cancelled 是终态')
  eq(cancelled.status, 'done', 'finished:true → 结束')
  // 失败项带 ChangeResult restore
  const failed = readProgress(hostState({
    running: false, finished: true,
    items: [hostItem({ name: 'y', stage: 'failed', failed: true, error: 'install failed', restore: { application: 'applied' } })],
  }))
  eq(failed.items[0].failed, true, 'failed:true → 失败')
  eq(failed.items[0].restore.application, 'applied', 'restore ChangeResult 原样保留')
})

test('批量失败继续 + 汇总失败数 + 回滚文案（真实 ChangeResult）', async () => {
  bootClient()
  const stateSeq = [hostState({
    running: false, finished: true,
    summary: { total: 2, success: 1, failed: 1, cancelled: 0, restartRequired: 0, skipped: 0, pending: 0 },
    items: [
      hostItem({ name: 'demo-plugin-a', stage: 'done', success: true, startedAt: 1, endedAt: 2 }),
      hostItem({
        name: 'demo-plugin-b', kind: 'git', stage: 'failed', failed: true,
        error: 'install failed', restore: { application: 'applied' }, startedAt: 3, endedAt: 4,
      }),
    ],
    logs: [],
  })]
  fakeFetch = defaultFetch({ stateSeq })
  const context = await renderUpdates()
  await clickButton(context, '更新全部')
  await clickModalButton(context, '开始更新')
  await tickPoll(context)
  await settle(context)
  const text = allText(context)
  ok(text.includes('失败 1 项') && text.includes('成功 1 项'), '批量结束后汇总成功 / 失败')
  ok(text.includes('install failed'), '失败项显示错误')
  ok(text.includes('已装回原版本'), 'restore.application=applied → 显示已装回原版本')
  context.unmount()
})

test('回滚失败文案：restore.application=failed + error.diagnostic', async () => {
  bootClient()
  const stateSeq = [hostState({
    running: false, finished: true,
    summary: { total: 1, success: 0, failed: 1, cancelled: 0, restartRequired: 0, skipped: 0, pending: 0 },
    items: [hostItem({
      name: 'demo-plugin-a', stage: 'failed', failed: true, error: 'ENOSPC while installing',
      restore: { application: 'failed', error: { code: 'install-failed', diagnostic: 'ENOSPC' } },
      startedAt: 1, endedAt: 2,
    })],
    logs: [],
  })]
  fakeFetch = defaultFetch({ stateSeq })
  const context = await renderUpdates()
  const planRow = rowFor(context, 'demo-plugin-a')
  collect(planRow).find(el => el.type === 'button' && nodeText(el).includes('更新')).props.onClick()
  await settle(context)
  await clickModalButton(context, '开始更新')
  await tickPoll(context)
  await settle(context)
  const text = allText(context)
  ok(text.includes('回滚也失败了: ENOSPC'), 'restore.application=failed → 回滚也失败 + diagnostic')
  ok(!text.includes('已装回原版本'), '回滚失败时不显示已装回原版本')
  context.unmount()
})

test('unknown 行徽标显示「未检查」而不是「没有可用更新」', async () => {
  bootClient()
  const candidates = [{
    name: 'unchecked-one', current: '1.0.0', latest: null, kind: 'npm', state: 'unknown',
    enabled: true, incompatible: null, prerelease: false, deprecated: null,
  }]
  fakeFetch = defaultFetch({ candidates })
  const context = await renderUpdates()
  await openSettings(context)
  menuSwitches(context)[0].props.onClick()
  await settle(context)
  const text = allText(context)
  ok(text.includes('unchecked-one'), '渲染出 unknown 候选')
  ok(text.includes('未检查'), 'unknown → 「未检查」徽标')
  ok(!text.includes('没有可用更新'), '不再误显示「没有可用更新」')
  ok(!/updates[A-Z][A-Za-z]+/u.test(text), '徽标文案已本地化（没有把 i18n key 直接漏到界面）')
  context.unmount()
})

test('不兼容行：版本豁免入口 + 完整流程（无展开原因/详情）', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const opened = []
  const context = await renderUpdates({ openPackage: (name) => { opened.push(name) } })
  const row = rowFor(context, 'demo-plugin-c')
  ok(nodeText(row).includes('不兼容'), '真实 incompatible 对象 → 行显示「不兼容」徽标')
  const updateButton = collect(row).find(el => el.type === 'button' && nodeText(el).includes('更新'))
  eq(updateButton.props.disabled, true, '不兼容行的 [更新] 先禁用')
  const rowCheckbox = collect(row).find(el => el.type === 'input' && el.props.type === 'checkbox')
  eq(rowCheckbox.props.disabled, true, '不兼容行的复选框不可勾选')
  // 行内解释区整体移除：没有详情、没有展开/收起、没有 requirements 等解释行。
  ok(!collect(row).some(el => el.type === 'button' && nodeText(el).trim() === '详情'), '不兼容行没有「详情」按钮')
  ok(!collect(row).some(el => el.type === 'button' && /展开|收起/u.test(nodeText(el))), '没有「展开不兼容原因 / 收起」按钮')
  ok(!allText(context).includes('不满足项') && !allText(context).includes('>=0.4.0'), '不渲染行内解释区（requirements / 范围不出现）')
  // 版本豁免入口仍在。
  const entry = collect(row).find(el => el.type === 'button' && nodeText(el).trim() === '版本豁免')
  ok(entry !== undefined, '不兼容且可豁免的行有「版本豁免」入口')
  ok(findInput(context, '我知道风险：可能崩溃、数据丢失') === undefined, '未点击入口时风险勾选不展开')
  entry.props.onClick()
  await settle(context)
  const openedRow = rowFor(context, 'demo-plugin-c')
  ok(!/展开|收起/u.test(nodeText(openedRow)), '点击后也不出现展开/收起按钮')
  const ack = findInput(context, '我知道风险：可能崩溃、数据丢失')
  ok(ack !== undefined, '点击「版本豁免」展开风险勾选')
  const exemptButton = findButton(context, '豁免此版本并更新')
  eq(exemptButton.props.disabled, true, '未勾选风险时豁免按钮禁用')
  fireChange(ack, {})
  await settle(context)
  eq(findButton(context, '豁免此版本并更新').props.disabled, false, '勾选后豁免按钮可用')
  // 收起再打开：风险勾选重置（避免误触）
  collect(rowFor(context, 'demo-plugin-c')).find(el => el.type === 'button' && nodeText(el).trim() === '版本豁免').props.onClick()
  await settle(context)
  ok(findInput(context, '我知道风险：可能崩溃、数据丢失') === undefined, '再次点击「版本豁免」收起风险勾选')
  collect(rowFor(context, 'demo-plugin-c')).find(el => el.type === 'button' && nodeText(el).trim() === '版本豁免').props.onClick()
  await settle(context)
  eq(findButton(context, '豁免此版本并更新').props.disabled, true, '重新打开后风险勾选已重置')
  fireChange(findInput(context, '我知道风险：可能崩溃、数据丢失'), {})
  await settle(context)
  await clickButton(context, '豁免此版本并更新')
  ok(allText(context).includes('再次确认：豁免风险版本'), '弹出二次确认')
  await clickModalButton(context, '豁免并更新')
  const exemptCall = fakeFetch.calls.find(item => item.url.endsWith('/updates/exempt'))
  ok(exemptCall !== undefined, '确认后 POST /updates/exempt')
  eq(exemptCall.body.package, 'demo-plugin-c', 'exempt 带包名')
  eq(exemptCall.body.version, '3.0.0', 'exempt 带精确版本')
  eq(exemptCall.body.runtimeVersion, '0.3.9', 'exempt 带运行中的 DSH 版本')
  eq(exemptCall.body.acceptRisk, true, 'exempt 显式 acceptRisk:true')
  const applyCall = fakeFetch.calls.find(item => item.url.endsWith('/updates/apply'))
  ok(applyCall !== undefined, '豁免成功后接着发起更新')
  eq(applyCall.body.items.some(item => item.name === 'demo-plugin-c'), true, 'apply items 含刚豁免的包')
  context.unmount()
})

test('F1：incompatibleOf 归一真实 listVersions 形状', () => {
  const { component } = bootClient()
  const { incompatibilityOf } = component.inspectable()
  // 真实形状：对象 {name,version,runtimeVersion,requirements}
  const real = incompatibilityOf({
    name: 'x', current: '1.0.0', latest: '2.0.0',
    incompatible: { name: 'x', version: '2.0.0', runtimeVersion: '0.3.9', requirements: { 'engines.dsh': '>=0.4.0 <0.5.0' } },
  })
  eq(real?.runtimeVersion, '0.3.9', '真实对象 → runtimeVersion 归一')
  eq(real?.requirements?.['engines.dsh'], '>=0.4.0 <0.5.0', '真实对象 → requirements 原样保留')
  eq(real?.version, '2.0.0', '真实对象 → 目标版本可作为 latest 兜底')
  // 兼容形态
  eq(incompatibilityOf({ incompatible: true })?.runtimeVersion, '', '布尔 true 仍按不兼容处理')
  eq(incompatibilityOf({ incompatible: { runtimeVersion: '9.9.9' } })?.runtimeVersion, '9.9.9', '对象缺少 requirements 也能归一')
  eq(incompatibilityOf({ incompatible: null }), null, 'null → 兼容')
  eq(incompatibilityOf({ incompatible: false }), null, 'false → 兼容')
  eq(incompatibilityOf({}), null, '缺省 → 兼容')
  eq(incompatibilityOf({ incompatible: {} }), null, '空对象不当作不兼容')
  // 显式 incompatibility 字段优先
  const explicit = incompatibilityOf({
    incompatible: { runtimeVersion: '0.1.0', requirements: { 'engines.dsh': '>=1' } },
    incompatibility: { runtimeVersion: '0.2.0', requirements: { 'engines.dsh': '>=2' } },
  })
  eq(explicit?.runtimeVersion, '0.2.0', '显式 incompatibility 字段优先于 incompatible 对象')
  eq(explicit?.requirements?.['engines.dsh'], '>=2', '显式字段的 requirements 优先')
})

test('F2：requirementLines 支持扁平映射与旧结构', () => {
  const { component } = bootClient()
  const { requirementLines } = component.inspectable()
  // 真实契约：key → range 的扁平记录
  eq(JSON.stringify(requirementLines({ requirements: { 'engines.dsh': '>=0.4.0 <0.5.0' } })), JSON.stringify(['engines.dsh >=0.4.0 <0.5.0']), '扁平映射输出 key range')
  eq(
    JSON.stringify(requirementLines({ requirements: { 'engines.dsh': '>=0.4.0', '@deepseek-ai/dsh-client-ui-settings': '>=0.3.0 <0.4.0' } })),
    JSON.stringify(['engines.dsh >=0.4.0', '@deepseek-ai/dsh-client-ui-settings >=0.3.0 <0.4.0']),
    '多条扁平要求逐行输出，不丢范围',
  )
  eq(JSON.stringify(requirementLines({})), '[]', '空 incompatibility 不产出错误行')
  eq(JSON.stringify(requirementLines(null)), '[]', '缺省 incompatibility 不产出错误行')
  eq(JSON.stringify(requirementLines({ requirements: {} })), '[]', '空 requirements 不产出错误行')
  // 旧结构兜底
  eq(JSON.stringify(requirementLines({ requirements: { dsh: '>=1.2.3' } })), JSON.stringify(['engines.dsh >=1.2.3']), '旧 dsh 键 → engines.dsh 行')
  eq(JSON.stringify(requirementLines({ requirements: { required: ['engines.dsh'] } })), JSON.stringify(['engines.dsh']), '旧 required 字符串数组')
  eq(JSON.stringify(requirementLines({ requirements: { required: [{ name: 'p', range: '>=2' }] } })), JSON.stringify(['p >=2']), '旧 required 带范围数组')
  eq(
    JSON.stringify(requirementLines({ requirements: { manifest: { peerDependencies: { '@deepseek-ai/dsh-base': '>=0.3.0' } } } })),
    JSON.stringify(['@deepseek-ai/dsh-base >=0.3.0']),
    '旧 manifest peers 仍展开',
  )
  eq(JSON.stringify(requirementLines({ requirements: { missing: ['a', 'b'] } })), JSON.stringify(['a', 'b']), '旧 missing 列表仍展开')
  ok(!requirementLines({ requirements: { 'engines.dsh': '>=0.4.0' } }).some(line => line.includes('—')), '不再产出「engines.dsh —」这种占位错误行')
})

test('F1：真实形状行不被全选/更新全部勾选，apply 不含它', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  const all = findInput(context, '全选')
  eq(all.props['data-state'], 'none', '初始未选中')
  fireChange(all, {})
  await settle(context)
  eq(findInput(context, '全选').props['data-state'], 'all', '全选生效')
  const selected = collect(context.result)
    .filter(el => el.type === 'input' && el.props.type === 'checkbox' && el.props['aria-label'] !== '全选' && el.props.checked === true)
    .map(el => el.props['aria-label'])
  ok(!selected.includes('demo-plugin-c'), '全选不勾选真实不兼容行')
  eq(selected.length, 2, '全选只勾选 2 个可安装项')
  await clickButton(context, '更新全部')
  await clickModalButton(context, '开始更新')
  const applyCall = fakeFetch.calls.find(item => item.url.endsWith('/updates/apply'))
  ok(applyCall !== undefined, '更新全部会发起 apply')
  eq(applyCall.body.items.some(item => item.name === 'demo-plugin-c'), false, 'apply 不含未豁免的不兼容项')
  eq(applyCall.body.items.length, 2, 'apply 只带 2 个可安装项')
  context.unmount()
})

test('真实契约：deprecated 是字符串原因（只靠徽标表达，无行内解释区）', async () => {
  bootClient()
  const candidates = [{
    name: 'dep-old', current: '1.0.0', latest: '1.1.0', kind: 'npm', state: 'available',
    enabled: true, incompatible: null, prerelease: false, deprecated: 'renamed to dep-new',
  }]
  fakeFetch = defaultFetch({ candidates })
  const context = await renderUpdates()
  const text = allText(context)
  ok(text.includes('dep-old'), '渲染出该候选')
  ok(text.includes('已废弃'), 'deprecated 字符串 → 已废弃徽标')
  const row = rowFor(context, 'dep-old')
  ok(!collect(row).some(el => el.type === 'button' && /展开|收起/u.test(nodeText(el))), '没有展开/收起按钮')
  ok(!text.includes('renamed to dep-new'), '不再渲染行内解释区（废弃原因不显示）')
  context.unmount()
})

test('桥接失败与 error 分支', async () => {
  bootClient()
  fakeFetch = withCalls(async (url) => {
    if (url === '/api/pluginmarket-plus/updates') return { ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }), text: async () => 'boom' }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' }
  })
  const context = await renderUpdates()
  ok(allText(context).includes('读取失败：boom'), '列表读取失败显示错误')
  await clickButton(context, '检查更新')
  ok(allText(context).includes('检查完成'), '检查成功后有提示')
  eq(fakeFetch.calls.filter(item => item.url.endsWith('/updates/check')).length, 1, '检查只发一次')
  context.unmount()
})

test('打开页面时已有队列在跑 → 提示并接上进度', async () => {
  bootClient()
  const stateSeq = [
    hostState({
      running: true, active: 'demo-plugin-a', activeRequestId: 'req-9',
      summary: { total: 1, success: 0, failed: 0, cancelled: 0, restartRequired: 0, skipped: 0, pending: 1 },
      items: [hostItem({ name: 'demo-plugin-a', requestId: 'req-9', stage: 'installing', startedAt: 1 })],
      logs: ['installing demo-plugin-a'],
    }),
    hostState({
      running: false, finished: true,
      summary: { total: 1, success: 1, failed: 0, cancelled: 0, restartRequired: 0, skipped: 0, pending: 0 },
      items: [hostItem({ name: 'demo-plugin-a', requestId: 'req-9', stage: 'done', success: true, startedAt: 1, endedAt: 2 })],
      logs: [],
    }),
  ]
  const impl = defaultFetch({ stateSeq })
  fakeFetch = withCalls(async (url, init) => {
    if (url === '/api/pluginmarket-plus/updates') {
      const response = await impl(url, init)
      const payload = await response.json()
      return { ok: true, status: 200, json: async () => Object.assign({}, payload, { running: true }) }
    }
    return impl(url, init)
  })
  const context = await renderUpdates()
  ok(allText(context).includes('另一个更新正在进行'), '提示已有更新在跑')
  await tickPoll(context)
  ok(allText(context).includes('更新进度') && allText(context).includes('安装'), '接上了正在运行的进度')
  context.unmount()
})

/** ------------------------------------------------------------------ */
async function main() {
  installGlobals()
  const only = process.env.PMP_ONLY
  for (const item of cases) {
    if (only !== undefined && only !== '' && !item.title.includes(only)) continue
    console.log(`\n[${item.title}]`)
    try {
      await item.fn()
    } catch (failure) {
      ok(false, `用例抛出异常：${failure?.message ?? failure}`)
    }
  }
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  globalThis.fetch = originalFetch
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  console.error = originalConsoleError
  console.log(`\n===== client-selftest: ${passed} passed, ${failed} failed =====`)
  if (failed > 0) {
    console.log('失败项：')
    for (const label of failures) console.log(`  - ${label}`)
    process.exitCode = 1
  }
}

void main()
