#!/usr/bin/env node
/**
 * tools/client-selftest.mjs —— dsh-pluginmarket-plus 客户端自检（无浏览器）。
 *
 * 用最小 React 垫片 + 假 __ModuleLoader__ 装载 client.js，检查：
 *   1. plugins.tab 席位注册（name/id/order/label 走 ctx.locale，中文「可更新」）；
 *   2. 检查更新 / 统计条 / 过滤 / 搜索 / 两个开关（POST /settings 持久化）；
 *   3. 行的复选框、名称、当前→目标版本、registry/git 徽标、状态徽标、[更新]/[详情]（openPackage）；
 *   4. 全选 + 半选、底部批量栏、[一键更新]、[更新全部]（跳过不兼容项）；
 *   5. 更新确认框（版本、来源、回滚说明）→ POST /updates/apply → 进度轮询（阶段/日志/取消）→ 汇总；
 *   6. 不兼容行展开（不满足项）+ 版本豁免：勾选风险 → 二次确认 → POST /updates/exempt {acceptRisk:true}；
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
async function clickChip(context, label) {
  const chip = collect(context.result).find(el => el.type === 'button' && el.props.className === 'pmu-chip' && nodeText(el) === label)
  if (chip === undefined) throw new Error(`找不到过滤 chip：${label}`)
  chip.props.onClick()
  await settle(context)
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
  const settingsRef = options.settingsRef ?? { updatesIncludeDisabled: false, updatesIncludePrerelease: false }
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
        config: Object.assign({}, settingsRef),
        running: false,
      })
    }
    if (url === '/api/pluginmarket-plus/settings' && method === 'POST') {
      if (body?.updatesIncludeDisabled !== undefined) settingsRef.updatesIncludeDisabled = body.updatesIncludeDisabled
      if (body?.updatesIncludePrerelease !== undefined) settingsRef.updatesIncludePrerelease = body.updatesIncludePrerelease
      return json({ ok: true, saved: true, status: { config: Object.assign({}, settingsRef) } })
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
    name: 'demo-plugin-a', current: '1.2.0', latest: '1.4.2', kind: 'registry', state: 'available',
    enabled: true, incompatible: null, prerelease: false, deprecated: null,
    spec: 'demo-plugin-a@1.2.0', origin: 'registry',
  },
  {
    name: 'demo-plugin-b', current: '0.9.1', latest: '1.0.0', kind: 'git', state: 'available',
    enabled: true, incompatible: null, prerelease: false, deprecated: null,
    spec: 'git+https://github.com/x/demo-b.git#0123456789abcdef0123456789abcdef01234567&path:/packages/b',
    origin: 'github.com/x/demo-b.git  /packages/b',
  },
  {
    name: 'demo-plugin-c', current: '2.0.0', latest: '3.0.0', kind: 'registry', state: 'available',
    enabled: true, prerelease: false, deprecated: null,
    spec: 'demo-plugin-c@2.0.0', origin: 'registry',
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
    name: 'demo-plugin-d', current: '1.0.0', latest: '1.1.0-rc.1', kind: 'registry', state: 'skipped',
    enabled: true, incompatible: null, prerelease: true, deprecated: null,
    spec: 'demo-plugin-d@1.0.0', origin: 'registry',
  },
  {
    name: 'demo-plugin-e', current: '0.4.0', latest: '0.5.0', kind: 'registry', state: 'available',
    enabled: false, incompatible: null, prerelease: false, deprecated: null,
    spec: 'demo-plugin-e@0.4.0', origin: 'registry',
  },
  {
    name: 'demo-plugin-f', current: '1.0.0', latest: '', kind: 'registry', state: 'error',
    enabled: true, incompatible: null, prerelease: false, deprecated: null, error: 'registry timeout',
  },
  {
    name: 'demo-plugin-g', current: '1.0.0', latest: '', kind: 'git', state: 'uncheckable',
    enabled: true, incompatible: null, prerelease: false, deprecated: null,
  },
  {
    name: 'demo-plugin-h', current: '1.0.0', latest: '1.0.0', kind: 'registry', state: 'current',
    enabled: true, incompatible: null, prerelease: false, deprecated: null, origin: 'registry',
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
    if (key === 'nav') continue
    ok(typeof info.dict.en[key] === 'string', `en 词典含 ${key}`)
  }
  ok(effectLabels.some(label => label.includes('dictionaries')), '词典注册在 ctx.effect 内')
  ok(effectLabels.some(label => label.includes('styles')), '样式注册在 ctx.effect 内')
  ok(registrations.length === 4, `注册了 4 个席位（实际 ${registrations.length}）`)
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

test('行渲染：复选框 / 版本 / 徽标 / 按钮 / openPackage', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const opened = []
  const context = await renderUpdates({ openPackage: (name) => { opened.push(name) } })
  const text = allText(context)
  ok(text.includes('demo-plugin-a'), '显示包名')
  ok(text.includes('1.2.0') && text.includes('1.4.2'), '显示 当前 → 目标 版本')
  ok(text.includes('registry') && text.includes('git'), '显示 registry / git 徽标')
  ok(text.includes('可更新') && text.includes('不兼容') && text.includes('预发布') && text.includes('检查失败') && text.includes('无法检查') && text.includes('无更新'), '显示状态徽标（可更新/不兼容/预发布/检查失败/无法检查/无更新）')
  ok(text.includes('demo-plugin-g') && text.includes('无法检查'), 'uncheckable 的 Git 行显示「无法检查」')
  ok(!text.includes('demo-plugin-e'), '「包含已禁用」默认关：已禁用插件不显示')
  const checkboxes = collect(context.result).filter(el => el.type === 'input' && el.props.type === 'checkbox')
  eq(checkboxes.length, 8, '每行一个复选框（7 行可见 + 全选）')
  clickButton(context, '详情')
  eq(opened.length, 1, '[详情] 调用 owner props openPackage(name)')
  eq(opened[0], 'demo-plugin-a', '详情传到的是这一行的包名')
  context.unmount()
})

test('过滤与搜索', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  await clickChip(context, '检查失败')
  eq(collect(context.result).filter(el => el.type === 'input' && el.props.type === 'checkbox').length, 3, '过滤「检查失败」= error + uncheckable 两行 + 全选')
  await clickChip(context, '仅可更新')
  ok(allText(context).includes('demo-plugin-a') && !allText(context).includes('demo-plugin-h'), '过滤「仅可更新」排除「无更新」行')
  await clickChip(context, '全部')
  const search = findInput(context, '搜索包名…')
  ok(search !== undefined, '有搜索框')
  fireChange(search, { target: { value: 'demo-plugin-b' } })
  await settle(context)
  const text = allText(context)
  ok(text.includes('demo-plugin-b') && !text.includes('demo-plugin-a'), '搜索按包名过滤')
  ok(text.includes('当前筛选下没有条目。') === false, '搜索有命中')
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
  ok(text.includes('registry'), '确认框写明安装来源')
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

test('多选 / 全选 / 半选 / 底部批量栏', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  const rowCheckboxes = () => collect(context.result).filter(el => el.type === 'input' && el.props.type === 'checkbox' && el.props['aria-label'] !== '全选')
  fireChange(rowCheckboxes()[0], {})
  await settle(context)
  let text = allText(context)
  ok(text.includes('已选 1 项'), '底部批量栏显示「已选 1 项」')
  ok(text.includes('一键更新') && text.includes('取消'), '批量栏有 [一键更新] [取消]')
  const selectAll = findInput(context, '全选')
  eq(selectAll.props['data-state'], 'indeterminate', '部分选中时全选为半选（indeterminate）')
  fireChange(selectAll, {})
  await settle(context)
  eq(findInput(context, '全选').props['data-state'], 'all', '全选后为全选态')
  text = allText(context)
  ok(text.includes('已选 2 项'), '全选只覆盖可安装项（2 项）')
  await clickButton(context, '一键更新')
  ok(allText(context).includes('确认更新 2 项'), '「一键更新」对已选项出确认框')
  await clickModalButton(context, '取消')
  ok(!allText(context).includes('确认更新 2 项'), '弹窗 [取消] 关闭确认框')
  await clickButton(context, '取消')
  eq(findInput(context, '全选').props['data-state'], 'none', '批量栏 [取消] 清空选择')
  context.unmount()
})

test('两个开关：默认关 + POST /settings 持久化', async () => {
  bootClient()
  const settingsRef = { updatesIncludeDisabled: false, updatesIncludePrerelease: false }
  fakeFetch = defaultFetch({ settingsRef })
  const context = await renderUpdates()
  const switches = () => collect(context.result).filter(el => el.type === 'button' && el.props.role === 'switch')
  eq(switches().length, 2, '两个开关')
  eq(switches()[0].props['aria-checked'], 'false', '包含预发布/已废弃默认关')
  eq(switches()[1].props['aria-checked'], 'false', '包含已禁用默认关')
  let text = allText(context)
  ok(!text.includes('demo-plugin-e'), '关闭时不显示已禁用的候选')
  ok(text.includes('demo-plugin-d') && text.includes('默认不勾选') === false, 'skipped 的预发布条目仍显示（Host 明确给出）')
  ok(text.includes('可更新 2 项'), '关闭时「更新全部」只有 2 项')
  switches()[1].props.onClick()
  await settle(context)
  const call = fakeFetch.calls.filter(item => item.url === '/api/pluginmarket-plus/settings').pop()
  ok(call !== undefined, '开关变化 POST /api/pluginmarket-plus/settings')
  eq(call.body.updatesIncludeDisabled, true, '持久化 updatesIncludeDisabled=true')
  eq(call.body.updatesIncludePrerelease, false, '同时带上另一个开关的当前值')
  text = allText(context)
  ok(text.includes('demo-plugin-e'), '打开后显示已禁用条目')
  ok(text.includes('可更新 3 项'), '打开「包含已禁用」后「更新全部」多出该项')
  switches()[0].props.onClick()
  await settle(context)
  const call2 = fakeFetch.calls.filter(item => item.url === '/api/pluginmarket-plus/settings').pop()
  eq(call2.body.updatesIncludePrerelease, true, '持久化 updatesIncludePrerelease=true')
  eq(settingsRef.updatesIncludePrerelease, true, '假配置已被写入')
  ok(allText(context).includes('可更新 4 项'), '打开预发布开关后 skipped 的 a/b/d/e 都可自动勾选')
  context.unmount()
})

/** Host `/updates/state` 的队列项真实形状（lib/updates.js createUpdateQueue 的初始值）。 */
function hostItem(over = {}) {
  return Object.assign({
    name: 'demo-plugin-a', current: '1.2.0', latest: '1.4.2', version: '1.4.2', kind: 'registry',
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
    name: 'unchecked-one', current: '1.0.0', latest: null, kind: 'registry', state: 'unknown',
    enabled: true, incompatible: null, prerelease: false, deprecated: null,
  }]
  fakeFetch = defaultFetch({ candidates })
  const context = await renderUpdates()
  const text = allText(context)
  ok(text.includes('unchecked-one'), '渲染出 unknown 候选')
  ok(text.includes('未检查'), 'unknown → 「未检查」徽标')
  ok(!text.includes('没有可用更新'), '不再误显示「没有可用更新」')
  ok(!/updates[A-Z][A-Za-z]+/u.test(text), '徽标文案已本地化（没有把 i18n key 直接漏到界面）')
  context.unmount()
})

test('不兼容行：展开不满足项 + 豁免流程', async () => {
  bootClient()
  fakeFetch = defaultFetch()
  const context = await renderUpdates()
  const rows = () => collect(context.result).filter(el => el.type === 'div' && el.props.className === 'pmu-row')
  const row = rows().find(item => nodeText(item).includes('demo-plugin-c'))
  ok(nodeText(row).includes('不兼容'), '真实 incompatible 对象 → 行显示「不兼容」徽标')
  const updateButton = collect(row).find(el => el.type === 'button' && nodeText(el).includes('更新'))
  eq(updateButton.props.disabled, true, '不兼容行的 [更新] 先禁用')
  const rowCheckbox = collect(row).find(el => el.type === 'input' && el.props.type === 'checkbox')
  eq(rowCheckbox.props.disabled, true, '不兼容行的复选框不可勾选')
  const expand = collect(row).find(el => el.type === 'button' && nodeText(el).includes('展开不兼容原因'))
  ok(expand !== undefined, '不兼容行可展开')
  expand.props.onClick()
  await settle(context)
  const expandedText = allText(context)
  ok(expandedText.includes('与当前 DSH 不兼容'), '展开显示不兼容标题')
  ok(expandedText.includes('>=0.4.0 <0.5.0'), '展开显示不满足的 engines.dsh 条件（扁平 requirements 的真实范围）')
  ok(expandedText.includes('运行中的 DSH：0.3.9'), '展开显示当前 DSH 版本')
  const ack = findInput(context, '我知道风险：可能崩溃、数据丢失')
  ok(ack !== undefined, '提供风险勾选框')
  const exemptButton = findButton(context, '豁免此版本并更新')
  eq(exemptButton.props.disabled, true, '未勾选风险时豁免按钮禁用')
  fireChange(ack, {})
  await settle(context)
  eq(findButton(context, '豁免此版本并更新').props.disabled, false, '勾选后豁免按钮可用')
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

test('真实契约：deprecated 是字符串原因（不是布尔）', async () => {
  bootClient()
  const candidates = [{
    name: 'dep-old', current: '1.0.0', latest: '1.1.0', kind: 'registry', state: 'available',
    enabled: true, incompatible: null, prerelease: false, deprecated: 'renamed to dep-new',
  }]
  fakeFetch = defaultFetch({ candidates })
  const context = await renderUpdates()
  const text = allText(context)
  ok(text.includes('dep-old'), '渲染出该候选')
  ok(text.includes('已废弃'), 'deprecated 字符串 → 已废弃徽标')
  const row = rowFor(context, 'dep-old')
  const expand = collect(row).find(el => el.type === 'button' && nodeText(el).includes('展开不兼容原因'))
  ok(expand !== undefined, '可展开查看原因')
  expand.props.onClick()
  await settle(context)
  ok(allText(context).includes('renamed to dep-new'), '展开显示废弃原因')
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
