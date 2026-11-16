/**
 * t3 · 独立装载冒烟：把真实的 `client.js` 装进「假 __ModuleLoader__ + 假 React + 假 DOM」里。
 *
 * 这个脚本不复用 `tools/client-selftest.mjs`：它自己实现模块加载器、自己的最小渲染器、
 * 自己的假宿主（slots / locale），只断言**外部可观察的注册契约**与「能不能渲染出内容」。
 *
 * 覆盖（对应 t3 验收条款）：
 *  1. `client.js` 经 `window.__ModuleLoader__.load({id, factory})` 装载，id 与包名一致。
 *  2. 组件 `inject: ['slots', 'locale']`；`slots.inject('plugins.tab', ...)` +
 *     `register({name:'plugins.tab', id:'pluginmarket-plus-updates', order:20, label})`。
 *  3. label 解析成「可更新」；locale 词典 zh/en 键集合完全一致（含 updatesTab 及全部使用时出现的键）。
 *  4. 用假 `/api/pluginmarket-plus/updates*` 桥渲染 tab，能稳定渲染出候选与计数。
 *  5. 只 require('react')，不 import 任何 @deepseek-ai 包。
 *
 * 跑法：`node tools/client-bundle-check.mjs`（只用 Node 内置模块）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const CLIENT_PATH = join(PLUGIN_ROOT, 'client.js')
const PACKAGE_NAME = 'dsh-pluginmarket-plus'
/** `locale.register` 用的命名空间（插件自己的短名，不是 npm 包名）。 */
const DICT_NS = 'pluginmarket-plus'
const API = '/api/pluginmarket-plus'

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
  failed.push({ section: currentSection, label, detail: detail === undefined ? undefined : safe(detail) })
}

/**
 * @param {unknown} actual - 实际。
 * @param {unknown} expected - 期望。
 * @param {string} label - 说明。
 * @returns {void}
 */
function eq(actual, expected, label) {
  const left = safe(actual)
  const right = safe(expected)
  ok(left === right, label, `实际 ${left} ≠ 期望 ${right}`)
}

/**
 * @param {unknown} value - 任意值。
 * @returns {string} 字符串。
 */
function safe(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

// ---------------------------------------------------------------------------
// 最小 React 垫片（只实现 client.js 实际用到的 API）
// ---------------------------------------------------------------------------
/** hook 槽：按「元素对象 + 调用序号」定位，等价于 React 的顺序规则。 */
const hookSlots = new WeakMap()
let currentElement = null
let hookIndex = 0
/** 本次渲染收集到的副作用。 */
let effectQueue = []
/** 最近一次渲染/副作用期间是否发生过状态更新。 */
let dirty = false

/**
 * 取当前渲染的第 N 个 hook 槽。
 * @returns {object} 槽。
 */
function slot() {
  const list = hookSlots.get(currentElement) ?? []
  hookSlots.set(currentElement, list)
  if (list[hookIndex] === undefined) list[hookIndex] = { value: undefined, deps: undefined }
  const entry = list[hookIndex]
  hookIndex += 1
  return entry
}

/** `Object.is` 版依赖比较。 */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { __el: true, type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useRef(initial) {
    const entry = slot()
    if (entry.value === undefined) entry.value = { current: initial }
    return entry.value
  },
  useState(initial) {
    const entry = slot()
    if (entry.value === undefined) entry.value = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      const value = typeof next === 'function' ? next(entry.value) : next
      if (Object.is(value, entry.value)) return
      entry.value = value
      dirty = true
    }
    return [entry.value, setter]
  },
  useMemo(factory, deps) {
    const entry = slot()
    if (entry.value === undefined || !sameDeps(entry.deps, deps)) {
      entry.value = factory()
      entry.deps = deps
    }
    return entry.value
  },
  useCallback(fn, deps) {
    const entry = slot()
    if (entry.value === undefined || !sameDeps(entry.deps, deps)) {
      entry.value = fn
      entry.deps = deps
    }
    return entry.value
  },
  useEffect(fn, deps) {
    const entry = slot()
    if (entry.value !== undefined && sameDeps(entry.deps, deps)) return
    // 依赖变化（或首次执行）前先跑上一次的清理，等价 React 的 effect 语义。
    if (typeof entry.cleanup === 'function') entry.cleanup()
    entry.value = fn
    entry.deps = deps
    effectQueue.push({ fn, entry })
  },
  useLayoutEffect(fn, deps) {
    React.useEffect(fn, deps)
  },
  useId() {
    const entry = slot()
    if (entry.value === undefined) entry.value = `t3-id-${String(hookIndex)}`
    return entry.value
  },
  memo(component) {
    return component
  },
  forwardRef(fn) {
    return fn
  },
  createContext(defaultValue) {
    return { __context: true, defaultValue, Provider: 'Context.Provider', Consumer: 'Context.Consumer' }
  },
  useContext(context) {
    return context?.defaultValue
  },
}

// ---------------------------------------------------------------------------
// 渲染器
// ---------------------------------------------------------------------------
/**
 * 渲染一个组件到宿主树。
 * @param {Function} Component - 组件。
 * @param {object} props - 属性。
 * @returns {{ tree: object, texts: string[], elements: object[], rerender: () => void }} 渲染结果。
 */
function render(Component, props) {
  effectQueue = []
  const root = { __el: true, type: Component, props: { ...props, children: [] } }
  let tree = walk(root)
  return {
    get tree() {
      return tree
    },
    texts: () => collectText(tree),
    elements: () => collectElements(tree),
    /** 执行本轮收集到的副作用，再重渲染（等价于 React 的 commit 阶段）。 */
    flush: () => {
      const queue = effectQueue
      effectQueue = []
      for (const effect of queue) {
        const cleanup = effect.fn()
        effect.entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      tree = walk(root)
      return tree
    },
    rerender: () => {
      effectQueue = []
      tree = walk(root)
      return tree
    },
  }
}

/** 卸载时执行的清理函数。 */
const cleanups = []

/**
 * 取一个元素的整段文本（含子节点）。
 * @param {object} element - 宿主元素。
 * @returns {string} 文本。
 */
function elementText(element) {
  return collectText(element).join(' ')
}

/**
 * 在渲染结果里找一个「文本匹配且有 onClick」的元素。
 * @param {object} view - render 返回值。
 * @param {(text: string) => boolean} match - 文本匹配。
 * @returns {object|null} 元素。
 */
function findClickable(view, match) {
  return view.elements().find(element => typeof element.props?.onClick === 'function' && match(elementText(element))) ?? null
}

/**
 * 找一个可勾选的控件（checkbox/radio，或带 checked 的按钮）。
 * @param {object} view - render 返回值。
 * @returns {object|null} 元素。
 */
function findCheckable(view) {
  const elements = view.elements()
  const input = elements.find(element => element.type === 'input' && ['checkbox', 'radio'].includes(String(element.props?.type)))
  if (input !== undefined) return input
  return elements.find(element => typeof element.props?.checked === 'boolean' && (typeof element.props?.onChange === 'function' || typeof element.props?.onClick === 'function')) ?? null
}

/**
 * 在某个元素所在的子树里找可勾选控件（豁免区的风险勾选专用）。
 *
 * 这里退化成「找 aria-label 含风险文案的 input」：豁免区与「全选」都用了
 * `pmu-check` 类名，靠 aria-label 区分更稳。
 * @param {object} view - render 返回值。
 * @param {object} [near] - 附近的元素（只用来提供诊断，不参与匹配）。
 * @returns {object|null} 元素。
 */
function findCheckableWithin(view, near) {
  void near
  const inputs = view.elements().filter(element => element.type === 'input' && ['checkbox', 'radio'].includes(String(element.props?.type)))
  const risk = inputs.find(element => /风险|accept|risk/u.test(String(element.props?.['aria-label'] ?? '')))
  return risk ?? null
}

/**
 * 按 aria-label 找 input。
 * @param {object} view - render 返回值。
 * @param {string} label - aria-label。
 * @returns {object|null} 元素。
 */
function findInputByLabel(view, label) {
  return view.elements().find(element => element.type === 'input' && element.props?.['aria-label'] === label) ?? null
}

/**
 * 取所有状态徽标的文本（`pmp-badge` 容器里的叶子文本）。
 *
 * 只比整页文本不够精确：其他文案（入口标题、提示语）也可能含同样的词，
 * 会把「徽标是否正确」测成假阳性。
 * @param {object} view - render 返回值。
 * @returns {string[]} 徽标文本列表。
 */
function badgeTexts(view) {
  return view.elements()
    .filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmp-badge'))
    .map(element => elementText(element).trim())
}

/**
 * 每行 `pmu-rowMain` 的结构签名（按渲染顺序），用于断言行内布局。
 *
 * 签名取值：checkbox / name / kind:<npm|git> / versions / spacer / disabled /
 * status:<data-state> / actions / other:<type>。
 * @param {object} view - render 返回值。
 * @returns {string[][]} 每行一个签名数组。
 */
function rowMainSignatures(view) {
  return view.elements()
    .filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-rowMain'))
    .map((rowMain) => {
      const out = []
      for (const child of rowMain.children) {
        if (child === null || typeof child === 'string') continue
        const classes = String(child.props?.className ?? '').split(/\s+/u)
        if (child.type === 'input') out.push('checkbox')
        else if (classes.includes('pmu-nameLink') || classes.includes('pmu-name')) out.push('name')
        else if (classes.includes('pmu-kindBadge')) out.push(`kind:${elementText(child).trim()}`)
        else if (classes.includes('pmu-versions')) out.push('versions')
        else if (classes.includes('pmu-spacer')) out.push('spacer')
        else if (classes.includes('pmu-disabledBadge')) out.push('disabled')
        else if (classes.includes('pmu-statusBadge')) out.push(`status:${String(child.props?.['data-state'] ?? '')}`)
        else if (classes.includes('pmu-rowActions')) out.push('actions')
        else out.push(`other:${child.type}`)
      }
      return out
    })
}

/**
 * 收集所有主状态徽标（`pmu-statusBadge`）的状态、title 与文案。
 * @param {object} view - render 返回值。
 * @returns {{state: string, title: unknown, text: string}[]} 徽标信息。
 */
function statusBadges(view) {
  return view.elements()
    .filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-statusBadge'))
    .map(element => ({ state: String(element.props?.['data-state'] ?? ''), title: element.props?.title, text: elementText(element).trim() }))
}

/**
 * 头部 `.pmu-head` 的结构签名（按渲染顺序）：filter / button:<文案> / hint:<文案>。
 * @param {object} view - render 返回值。
 * @returns {string[]} 签名数组。
 */
function headSignature(view) {
  const head = view.elements().find(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-head'))
  if (head === undefined) return []
  return head.children.filter(child => child !== null).map((child) => {
    const classes = String(child.props?.className ?? '').split(/\s+/u)
    if (classes.includes('pmu-filterWrap')) return 'filter'
    if (classes.includes('pmu-hint')) return `hint:${elementText(child).trim()}`
    if (child.type === 'button') return `button:${elementText(child).trim()}`
    return `other:${child.type}`
  })
}

/**
 * 收集 `role=switch` 的开关（筛选下拉里的两个开关）。
 * @param {object} view - render 返回值。
 * @returns {{label: string, checked: unknown, disabled: unknown, node: object}[]} 开关列表。
 */
function switchButtons(view) {
  return view.elements()
    .filter(element => element.type === 'button' && element.props?.role === 'switch')
    .map(element => ({ label: String(element.props?.['aria-label'] ?? ''), checked: element.props?.['aria-checked'], disabled: element.props?.disabled, node: element }))
}

/**
 * 取最近一次 apply 注入的样式文本（每次 apply 都会追加一个 style 节点）。
 * @param {object} state - makeEnvironment 的 state。
 * @returns {string} CSS 文本。
 */
function latestCss(state) {
  const nodes = state.styles.filter(node => typeof node?.textContent === 'string' && node.textContent !== '')
  return nodes.length === 0 ? '' : nodes[nodes.length - 1].textContent
}

/**
 * 从 CSS 文本里取一条规则的声明块（选择器需完全一致，如 '.pmu-rowMain'）。
 * @param {string} css - CSS 文本。
 * @param {string} selector - 选择器。
 * @returns {string} 声明块内容；找不到返回 ''。
 */
function cssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`${escaped}\\{([^}]*)\\}`, 'u').exec(css)
  return match === null ? '' : match[1]
}

/**
 * 取一条 CSS 规则里某个声明的值。
 * @param {string} css - CSS 文本。
 * @param {string} selector - 选择器。
 * @param {string} property - 属性名。
 * @returns {string} 值；缺失返回 ''。
 */
function cssValue(css, selector, property) {
  const rule = cssRule(css, selector)
  const match = new RegExp(`${property.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:([^;]*)`, 'u').exec(rule)
  return match === null ? '' : match[1].trim()
}

/**
 * 反复推进渲染 + 副作用 + 微任务，直到稳定。
 * @param {object} view - render 的返回值。
 * @param {number} [rounds] - 最大轮次。
 * @returns {Promise<void>} 完成。
 */
async function settle(view, rounds = 40) {
  let idle = 0
  for (let round = 0; round < rounds; round += 1) {
    await sleep(3)
    dirty = false
    const queued = effectQueue.length
    view.flush()
    if (!dirty && queued === 0 && effectQueue.length === 0) {
      idle += 1
      if (idle >= 3) break
    } else {
      idle = 0
    }
  }
  dirty = false
  view.flush()
}

/**
 * 走一遍树：函数组件就地执行，宿主节点收敛成 `{type, props, children}`。
 * @param {unknown} node - 节点。
 * @returns {unknown} 收敛结果。
 */
function walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(walk).filter(child => child !== null)
  if (typeof node !== 'object' || node.__el !== true) return null
  const { type, props } = node
  const children = Array.isArray(props?.children) ? props.children : props?.children === undefined ? [] : [props.children]
  if (typeof type === 'function') {
    const previousElement = currentElement
    const previousIndex = hookIndex
    currentElement = node
    hookIndex = 0
    props.ref && typeof props.ref === 'object' && (props.ref.current = node)
    const rendered = type({ ...props, children })
    currentElement = previousElement
    hookIndex = previousIndex
    return walk(rendered)
  }
  const childrenWalked = children.map(walk).filter(child => child !== null)
  const element = {
    type: String(type),
    props: { ...props, children: childrenWalked },
    children: childrenWalked,
    /**
     * 布局桩：默认 width 0，让 measureMenuPlacement 判定拿不到布局而退化为纯 CSS 定位；
     * 测试可用 setElementRect 注入真实 rect 来验证内联 fixed 坐标分支。
     * @returns {{width: number, height: number, top: number, bottom: number, left: number}} 矩形。
     */
    getBoundingClientRect() {
      if (elementRectProvider === null) return { width: 0, height: 0, top: 0, bottom: 0, left: 0 }
      return elementRectProvider(element)
    },
  }
  if (props?.ref !== null && typeof props?.ref === 'object') props.ref.current = element
  return element
}

/** 元素矩形注入器（默认 null ⇒ 走纯 CSS 定位分支）。 */
let elementRectProvider = null

/**
 * 注入 getBoundingClientRect 的返回值（验证内联 fixed 定位分支）。
 * @param {(element: object) => {width: number, height: number, top: number, bottom: number, left: number}} provider - 注入器。
 * @returns {void}
 */
function setElementRect(provider) {
  elementRectProvider = provider
}

/** 还原矩形注入器。 */
function resetElementRect() {
  elementRectProvider = null
}

/**
 * 收集一个宿主元素的全部后代（不含自身）。
 * @param {object|undefined} element - 宿主元素。
 * @returns {object[]} 后代列表。
 */
function descendantsOf(element) {
  const out = []
  /**
   * @param {unknown} node - 节点。
   * @returns {void}
   */
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === 'string') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  for (const child of element?.children ?? []) visit(child)
  return out
}

/**
 * 收集叶子文本。
 * @param {unknown} node - 宿主节点。
 * @returns {string[]} 文本片段。
 */
function collectText(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string') return node.trim() === '' ? [] : [node]
  if (Array.isArray(node)) return node.flatMap(collectText)
  return collectText(node.children)
}

/**
 * 收集所有宿主元素。
 * @param {unknown} node - 宿主节点。
 * @param {object[]} [out] - 累加器。
 * @returns {object[]} 元素列表。
 */
function collectElements(node, out = []) {
  if (node === null || node === undefined || typeof node === 'string') return out
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out)
    return out
  }
  out.push(node)
  collectElements(node.children, out)
  return out
}

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------
/**
 * 造的假宿主环境：假 window.__ModuleLoader__ / document / setInterval / fetch。
 * @returns {object} 环境句柄。
 */
function makeEnvironment() {
  const state = {
    module: null,
    /** `locale.register` 收到的词典。 */
    dictionaries: [],
    /** `slots.register` 收到的席位。 */
    registrations: [],
    /** `slots.inject` 请求过的槽位。 */
    injected: [],
    /** `ctx.effect` 的标签。 */
    effectLabels: [],
    /** 所有 fetch 调用。 */
    fetchCalls: [],
    /** 登记的轮询器。 */
    intervals: [],
    styles: [],
    consoleErrors: [],
    /** 假桥接的响应（按 url 给）。 */
    responses: null,
  }

  /** document 上的监听器（用于派发 Escape 等事件）。 */
  const documentListeners = new Map()
  const documentStub = {
    head: { appendChild: node => state.styles.push(node) },
    body: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '', style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
    addEventListener(name, listener) {
      const list = documentListeners.get(name) ?? []
      list.push(listener)
      documentListeners.set(name, list)
    },
    removeEventListener(name, listener) {
      const list = documentListeners.get(name) ?? []
      documentListeners.set(name, list.filter(entry => entry !== listener))
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    /** 派发一个 DOM 事件（测试用）。 */
    dispatch(name, event) {
      for (const listener of [...(documentListeners.get(name) ?? [])]) listener(event)
    },
    /** 当前某类监听器数量（测试用）。 */
    listenerCount(name) {
      return (documentListeners.get(name) ?? []).length
    },
  }

  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        state.module = definition
      },
    },
    document: documentStub,
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'http://127.0.0.1:3080/' },
    navigator: { clipboard: { writeText: async () => {} } },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    navigator: windowStub.navigator,
    location: windowStub.location,
    console: { ...console, error: (...args) => state.consoleErrors.push(args.map(String).join(' ')) },
    setInterval: (fn) => {
      state.intervals.push(fn)
      return state.intervals.length
    },
    clearInterval: (id) => {
      if (typeof id === 'number') state.intervals[id - 1] = null
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    queueMicrotask,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    WeakMap,
    URL,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    fetch: (...args) => {
      state.fetchCalls.push(args)
      const url = String(args[0])
      const impl = state.responses
      if (impl === null) return Promise.reject(new Error(`没有配置假桥接：${url}`))
      return impl(url, args[1])
    },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  return { state, sandbox, windowStub, documentStub }
}

/**
 * 造假 ctx（slots / locale / effect）。
 * @param {object} state - 环境状态。
 * @returns {object} 假 ctx。
 */
function makePluginContext(state, locale = 'zh') {
  /** 当前激活词典（跟着 locale.register 走；按请求的 locale 取 zh/en）。 */
  let active = {}
  const translate = (key, params) => {
    let out = typeof active[key] === 'string' ? active[key] : key
    if (params !== null && typeof params === 'object') {
      for (const name of Object.keys(params)) out = out.split(`{${name}}`).join(String(params[name]))
    }
    return out
  }
  translate.locale = locale
  return {
    effect(callback, label) {
      state.effectLabels.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(ns, provided) {
        state.dictionaries.push({ ns, provided })
        active = provided[locale] ?? provided.zh ?? {}
        return () => {}
      },
      bind() {
        return translate
      },
    },
    slots: {
      inject(name, callback) {
        state.injected.push(name)
        callback()
        return () => {}
      },
      register(descriptor, component) {
        state.registrations.push({ descriptor, component })
        return () => {}
      },
    },
  }
}

/**
 * 把 client.js 装进沙箱并取出模块定义 + 组件。
 * @returns {object} 装载结果。
 */
function loadClient() {
  const env = makeEnvironment()
  const code = readFileSync(CLIENT_PATH, 'utf8')
  const context = vm.createContext(env.sandbox)
  new vm.Script(code, { filename: 'client.js' }).runInContext(context)
  const module = env.state.module
  if (module === null || module === undefined) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  const factory = module.factory
  if (typeof factory !== 'function') throw new Error('模块定义缺少 factory 函数')
  const requested = []
  const exports = factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return React
    throw new Error(`未知依赖：${specifier}`)
  })
  return { ...env, module, exports, requested }
}

/**
 * 一份符合 Host 契约的假桥接。
 * @param {object} options - 候选 / state 序列 / 开关。
 * @returns {Function} fetch 实现。
 */
function makeBridge(options = {}) {
  const settings = { updatesIncludeDisabled: false, updatesIncludePrerelease: false, updatesShowFailed: false, ...(options.settings ?? {}) }
  const calls = []
  let stateIndex = 0
  /** 还要失败几次 GET /updates/state（模拟 Host 退出）。 */
  let stateFailures = options.stateFailures ?? 0
  const impl = async (url, init = {}) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body))
    calls.push({ url, method, body })
    const json = (payload, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })
    if (url === `${API}/updates` && method === 'GET') {
      // updatesDelayMs 用于拉长「POST 已处理、GET 还没回来」的窗口，让中间态可被采样捕捉。
      if (typeof options.updatesDelayMs === 'number' && options.updatesDelayMs > 0) await sleep(options.updatesDelayMs)
      const interrupted = typeof options.interrupted === 'function' ? options.interrupted() : (options.interrupted ?? [])
      return json({
        ok: true,
        candidates: options.candidates ?? [],
        checkedAt: options.checkedAt === undefined ? Date.now() - 60_000 : options.checkedAt,
        index: { sources: 1, packages: (options.candidates ?? []).length, error: null },
        // `updatesConfig` 可显式覆盖（例如给 {} 验证「响应没说」时不得覆盖本地状态）。
        config: options.updatesConfig === undefined ? { ...settings } : options.updatesConfig,
        running: options.running === true,
        interrupted,
      })
    }
    if (url === `${API}/settings` && method === 'POST') {
      Object.assign(settings, body ?? {})
      if (typeof options.settingsResponse === 'function') return json(options.settingsResponse({ ...settings }, body ?? {}))
      if (options.settingsResponse !== undefined) return json(options.settingsResponse)
      return json({ ok: true, saved: true, status: { config: { ...settings } } })
    }
    if (url === `${API}/updates/check`) {
      return json({ ok: true, checked: (options.candidates ?? []).map(item => item.name), skipped: [], unknown: [], candidates: options.candidates ?? [], checkedAt: Date.now() })
    }
    if (url === `${API}/updates/apply`) {
      const items = Array.isArray(body?.items) ? body.items : []
      return json({ ok: true, started: true, requestIds: items.map((_, index) => `req-${index + 1}`), items })
    }
    if (url === `${API}/updates/state`) {
      // stateFailures > 0 时先失败这么多次（模拟 Host 退出），之后恢复正常。
      if (stateFailures > 0) {
        stateFailures -= 1
        throw new Error('fetch failed')
      }
      const sequence = options.stateSequence ?? []
      const payload = sequence.length === 0 ? { ok: true, running: false, stopped: false, finished: false, summary: null, active: null, activeRequestId: null, items: [], logs: [] } : sequence[Math.min(stateIndex, sequence.length - 1)]
      stateIndex += 1
      return json(payload)
    }
    if (url === `${API}/updates/recover`) {
      const items = Array.isArray(body?.items) ? body.items : []
      const all = typeof options.interrupted === 'function' ? options.interrupted() : (options.interrupted ?? [])
      const requested = items.length === 0 ? all : items
      const results = requested.map((item) => {
        const outcome = options.recoverOutcomes?.[item.name]
        if (outcome === undefined) return { name: item.name, ok: true }
        return outcome.ok === true ? { name: item.name, ok: true } : { name: item.name, ok: false, error: outcome.error }
      })
      // 只有「被点名且成功」的项从残留里摘掉；未点名的与失败的都保留。
      const recovered = new Set(results.filter(result => result.ok === true).map(result => result.name))
      const remaining = all.filter(record => !recovered.has(record.name))
      if (typeof options.onRecover === 'function') options.onRecover(remaining)
      return json({ ok: true, results, interrupted: remaining })
    }
    if (url === `${API}/updates/clear-interrupted`) {
      if (typeof options.onRecover === 'function') options.onRecover([])
      return json({ ok: true, cleared: typeof options.interrupted === 'function' ? options.interrupted() : (options.interrupted ?? []), interrupted: [] })
    }
    if (url === `${API}/updates/cancel`) return json({ ok: true, cancelled: 'cancelled', state: { running: false, items: [] } })
    if (url === `${API}/updates/exempt`) return json({ ok: true, runtimeVersion: '0.3.0' })
    if (url === `${API}/status`) return json({ ok: true, sources: [], config: { ...settings }, cacheDir: 'x', shelf: {}, pluginMarket: null })
    if (url === `${API}/refresh`) return json({ ok: true, results: [], status: {} })
    if (url === `${API}/market`) return json({ ok: true, status: {} })
    return json({ ok: false, error: 'unexpected', message: url }, 404)
  }
  impl.calls = calls
  impl.settings = settings
  return impl
}

/** 一份典型候选（npm + git + 不兼容 + 已禁用）。
 *
 * 不兼容项用**真实 Host 形状**：`incompatible: {name, version, runtimeVersion, requirements}`，
 * 其中 `requirements` 是「要求名 → 范围」的扁平记录（DSH `evaluatePluginCompatibility` 的产出）。
 */
const CANDIDATES = [
  { name: 'demo-plugin-a', current: '1.2.0', latest: '1.4.2', kind: 'npm', state: 'available', enabled: true, incompatible: null, prerelease: false, deprecated: null },
  { name: 'demo-plugin-b', current: '0.9.1', latest: '1.0.0', kind: 'git', state: 'available', enabled: true, incompatible: null, prerelease: false, deprecated: null, spec: `git+https://github.com/acme/demo-b.git#${'a'.repeat(40)}` },
  { name: 'demo-plugin-c', current: '2.0.0', latest: '3.0.0', kind: 'npm', state: 'available', enabled: true, prerelease: false, deprecated: null, incompatible: { name: 'demo-plugin-c', version: '3.0.0', runtimeVersion: '0.3.9', requirements: { 'engines.dsh': '>=0.4.0 <0.5.0' } } },
]

// ---------------------------------------------------------------------------
// 1. 装载与模块定义
// ---------------------------------------------------------------------------
section('装载：__ModuleLoader__ / 依赖')
const loaded = loadClient()
eq(loaded.module.id, PACKAGE_NAME, '模块 id 与包名一致')
eq(typeof loaded.module.factory, 'function', '模块定义带 factory')
eq(loaded.requested, ['react'], 'factory 只 require(\'react\')')
{
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const staticImports = [...source.matchAll(/^\s*import\s[^\n]*from\s*['"]([^'"]+)['"]/gmu)].map(match => match[1])
  eq(staticImports, [], 'client.js 没有 ESM 静态 import（无构建步骤）')
  ok(!/\brequire\(\s*['"]@deepseek-ai/u.test(source), '没有 require 任何 @deepseek-ai 包')
  ok(!/^\s*(?:import|export)\s[^\n]*@deepseek-ai/mu.test(source), '没有 import/export 任何 @deepseek-ai 包')
  const deepseekMentions = source.split(/\r?\n/u).map((line, number) => ({ line: line.trim(), number: number + 1 })).filter(entry => entry.line.includes('@deepseek-ai'))
  ok(deepseekMentions.every(entry => /^(\*|\/\/|\/\*)/u.test(entry.line) || entry.line.includes('startsWith')), '@deepseek-ai 只出现在注释或包名前缀判断里（不是模块依赖）', deepseekMentions)
  ok(source.includes('window.__ModuleLoader__.load('), 'client.js 经 window.__ModuleLoader__.load 装载')
  ok(!/fetch\(\s*['"`]https?:\/\//u.test(source), '没有跨域 fetch（只走同源桥）')
  const foreignApi = [...source.matchAll(/fetch\(\s*(?:api\()?\s*`?\$\{API\}[^`'"]*`?/gu)].length
  ok(foreignApi >= 0, '同源桥前缀是唯一 API 入口（前缀常量存在）', foreignApi)
  ok(source.includes("const API = '/api/pluginmarket-plus'"), 'API 前缀等于 /api/pluginmarket-plus')
}
eq(loaded.exports.inject, ['slots', 'locale'], '组件 inject 声明 slots + locale')
eq(typeof loaded.exports.apply, 'function', '组件导出 apply')
eq(typeof loaded.exports.inspectable, 'function', '组件导出 inspectable（只读自检口）')

// ---------------------------------------------------------------------------
// 2. apply → 席位注册 + 词典
// ---------------------------------------------------------------------------
section('注册：plugins.tab 席位与 locale 词典')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)

  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  ok(tab !== undefined, 'registrations 里有「可更新」席位', loaded.state.registrations.map(entry => `${entry.descriptor.name}#${entry.descriptor.id}`))
  eq(tab?.descriptor.name, 'plugins.tab', '「可更新」席位挂在 plugins.tab')
  eq(tab?.descriptor.id, 'pluginmarket-plus-updates', 'plugins.tab 的 id = pluginmarket-plus-updates')
  eq(tab?.descriptor.order, 20, 'plugins.tab 的 order = 20')
  eq(typeof tab?.descriptor.label, 'function', 'plugins.tab 的 label 是 thunk')
  eq(typeof tab?.component, 'function', 'plugins.tab 注册了组件')
  ok(loaded.state.injected.includes('plugins.tab'), 'slots.inject 请求过 plugins.tab', loaded.state.injected)

  // 「插件源缓存」tab：id / order / label，且排在「可更新」之前（discover 之后）。
  const cacheTab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-cache')
  ok(cacheTab !== undefined, 'registrations 里有「插件源缓存」席位', loaded.state.registrations.map(entry => `${entry.descriptor.name}#${entry.descriptor.id}`))
  eq(cacheTab?.descriptor.name, 'plugins.tab', '「插件源缓存」席位挂在 plugins.tab')
  eq(cacheTab?.descriptor.order, 10, '「插件源缓存」的 order = 10')
  eq(typeof cacheTab?.component, 'function', '「插件源缓存」注册了组件')

  // plugins.tab 下只有本插件的两个 tab（discover 由宿主提供，不在本插件注册表里）。
  const tabRegistrations = loaded.state.registrations.filter(entry => entry.descriptor.name === 'plugins.tab')
  eq(tabRegistrations.map(entry => entry.descriptor.id).sort(), ['pluginmarket-plus-cache', 'pluginmarket-plus-updates'], 'plugins.tab 下本插件注册 2 个 tab（缓存 order 10 / 可更新 order 20）')
  const orders = tabRegistrations.map(entry => ({ id: entry.descriptor.id, order: entry.descriptor.order }))
  ok(orders.find(entry => entry.id === 'pluginmarket-plus-cache').order < orders.find(entry => entry.id === 'pluginmarket-plus-updates').order, '缓存 tab 排在「可更新」之前（10 < 20）', orders)

  // 设置侧注册已全部移除。
  eq(loaded.state.registrations.filter(entry => String(entry.descriptor.name).startsWith('settings.')).length, 0, '不再有任何 settings.* 注册', loaded.state.registrations.map(entry => entry.descriptor.name))
  for (const name of ['settings.section', 'settings.plugins.tab', 'settings.section.icon']) {
    eq(loaded.state.registrations.filter(entry => entry.descriptor.name === name && String(entry.descriptor.id).startsWith('pluginmarket-plus')).length, 0, `设置侧没有本插件注册：${name}`)
    ok(!loaded.state.injected.includes(name), `slots.inject 没有请求 ${name}`, loaded.state.injected)
  }
  eq(loaded.state.registrations.length, 2, '本插件只注册 2 个席位（都在 plugins.tab）', loaded.state.registrations.map(entry => entry.descriptor.name))
  // 词典：zh / en 键集合一致。
  const dict = loaded.state.dictionaries.find(entry => entry.ns === DICT_NS)
  ok(dict !== undefined, `locale.register 收到 ${DICT_NS} 词典`, loaded.state.dictionaries.map(entry => entry.ns))
  const zh = dict?.provided.zh ?? {}
  const en = dict?.provided.en ?? {}
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  ok(zhKeys.length > 0, `zh 词典非空（${zhKeys.length} 键）`)
  eq(enKeys.length, zhKeys.length, 'zh / en 键数量一致')
  const zhOnly = zhKeys.filter(key => !enKeys.includes(key))
  const enOnly = enKeys.filter(key => !zhKeys.includes(key))
  eq(zhOnly, [], 'zh 独有键（应为空）')
  eq(enOnly, [], 'en 独有键（应为空）')
  eq(zhKeys, enKeys, 'zh / en 键集合完全一致')
  for (const key of zhKeys) {
    ok(typeof zh[key] === 'string' && zh[key].trim() !== '', `zh.${key} 是非空字符串`)
    ok(typeof en[key] === 'string' && en[key].trim() !== '', `en.${key} 是非空字符串`)
  }

  const label = tab?.descriptor.label()
  eq(label, zh.updatesTab, 'tab label 解析成词典里的 updatesTab')
  ok(typeof zh.updatesTab === 'string' && zh.updatesTab.includes('可更新'), `updatesTab 文案是「可更新」（实际 ${safe(zh.updatesTab)}）`)

  // 样式通过 ctx.effect 挂载。
  ok(loaded.state.styles.length >= 1, 'ctx.effect 里挂上了样式', loaded.state.styles.length)
  ok(loaded.state.effectLabels.some(text => String(text).includes('dictionaries')), '词典注册在 ctx.effect 里（可清理）', loaded.state.effectLabels)
  ok(loaded.state.effectLabels.some(text => String(text).includes('styles')), '样式挂载在 ctx.effect 里（可清理）', loaded.state.effectLabels)

  // inspectable 里的常量与宿主契约一致。
  const info = loaded.exports.inspectable()
  eq(info.updatesApi, `${API}/updates`, 'inspectable.updatesApi 指向同源桥')
  eq(info.id, 'pluginmarket-plus-updates', 'inspectable.id 与席位 id 一致')
  eq(info.order, 20, 'inspectable.order = 20')
  eq(info.slot, 'plugins.tab', 'inspectable.slot = plugins.tab')
  eq(info.namespace, DICT_NS, 'inspectable.namespace 与词典命名空间一致')
  eq(info.dict, loaded.state.dictionaries[0]?.provided, 'inspectable.dict 与注册的词典是同一份')
}

// ---------------------------------------------------------------------------
// 3. 渲染冒烟
// ---------------------------------------------------------------------------
section('插件源缓存 tab：label（zh/en）与 tab 内渲染')
{
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-cache')
  const dict = loaded.state.dictionaries.find(entry => entry.ns === DICT_NS)
  eq(tab?.descriptor.label(), '插件源缓存', '缓存 tab 的 zh label = 插件源缓存')
  eq(dict?.provided.en?.cacheTab, 'Plugin source cache', '词典 en.cacheTab = Plugin source cache')
  eq(dict?.provided.zh?.cacheTab, '插件源缓存', '词典 zh.cacheTab = 插件源缓存')
  eq(dict?.provided.zh?.nav, undefined, '旧 nav 文案键已删除')
  eq(dict?.provided.zh?.title, undefined, '旧 title 文案键已删除')

  // /status 假响应（真实 Host statusPayload 形状）。
  const statusPayload = {
    ok: true,
    origin: 'http://127.0.0.1:3080',
    mirrorBase: 'http://127.0.0.1:3080/pluginmarket-plus/index',
    cacheDir: 'C:/profile/.pluginmarket-plus',
    entryId: 'dsh-pluginmarket-plus',
    nextRefreshAt: Date.now() + 3_600_000,
    config: { autoRefresh: true, refreshIntervalHours: 4, managePluginMarket: true, fetchTimeoutMs: 120000, maxBytes: 67108864, retries: 2 },
    sources: [
      {
        id: 'abc123',
        url: 'https://example.test/index.json',
        mirrorUrl: 'http://127.0.0.1:3080/pluginmarket-plus/index/abc123.json',
        state: 'ok',
        bytes: 2048,
        plugins: 12,
        fetchedAt: Date.now() - 60_000,
        error: null,
        refreshing: false,
        title: '示例索引',
      },
    ],
    pluginMarket: { available: true, managed: true, indexes: ['http://127.0.0.1:3080/pluginmarket-plus/index/abc123.json'], summaries: [], error: null },
    writable: true,
  }

  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => {
    if (url === `${API}/status`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => statusPayload,
        text: async () => JSON.stringify(statusPayload),
      })
    }
    return bridge(url, init)
  }
  const t = ctx.locale.bind()
  const view = render(tab.component, { t })
  await settle(view)

  const hasClass = (name) => element => String(element.props?.className ?? '').split(/\s+/u).includes(name)
  const texts = view.texts()
  const joined = texts.join(' | ')
  ok(joined.includes('插件源缓存') || joined.includes('把「插件 → 发现」读取的索引 JSON'), '缓存 tab 渲染出内容', joined.slice(0, 300))

  // 根节点带 pmp-tabPage（tab 里不要设置页的宽度/内边距）。
  const root = view.elements().find(element => hasClass('pmp-page')(element))
  ok(root !== undefined && hasClass('pmp-tabPage')(root), '根节点带 pmp-tabPage', root?.props?.className)
  const css = latestCss(loaded.state)
  eq(cssValue(css, '.pmp-tabPage', 'max-width'), 'none', '.pmp-tabPage 不限制宽度')
  eq(cssValue(css, '.pmp-tabPage', 'padding'), '0', '.pmp-tabPage 去掉设置页内边距')
  eq(cssRule(css, '.pmp-title'), '', '不再有 .pmp-title 样式')

  // 无重复标题：没有 h1/h2，tab 内只有卡片/分节小标题。
  eq(view.elements().filter(element => element.type === 'h1' || element.type === 'h2').length, 0, '缓存 tab 里没有 h1/h2 重复标题', view.elements().filter(element => element.type === 'h1' || element.type === 'h2').map(element => elementText(element)))
  eq(view.elements().filter(hasClass('pmp-title')).length, 0, '没有 pmp-title 元素')

  // 状态卡 / 索引源行：标题、状态徽标、地址、plugins+size 元信息。
  const cards = view.elements().filter(hasClass('pmp-card'))
  ok(cards.length >= 2, `渲染出状态卡与索引源卡（${cards.length} 张）`, cards.length)
  ok(joined.includes('示例索引'), '索引源卡片显示源标题', joined.slice(0, 400))
  ok(joined.includes('https://example.test/index.json'), '索引源卡片显示源地址')
  ok(/\d+ 个插件/.test(joined), '索引源卡片显示插件数量', joined.match(/\d+ 个插件[^|]*/u)?.[0])
  ok(/KB|B/.test(joined), '索引源卡片显示缓存大小', joined.match(/[\d.]+ ?(?:KB|MB|B)/u)?.[0])
  ok(joined.includes('缓存正常') || joined.includes('缓存过期') || joined.includes('尚未缓存'), '索引源行有状态徽标', joined.slice(0, 400))
  eq(view.elements().filter(element => String(element.props?.className ?? '') === 'pmp-badge' && /缓存|尚未/.test(elementText(element))).length >= 1, true, '状态徽标由 SourceStatusBadge 渲染（不再崩溃）')
  eq(joined.includes('索引源'), true, '有「索引源」分节标题')

  // 工具条：全部刷新 + 自动刷新开关 + 间隔下拉（7 项，默认 4）。
  ok(findClickable(view, text => text.trim() === '全部刷新') !== null, '有「全部刷新」按钮', texts.slice(0, 200))
  const switches = switchButtons(view)
  ok(switches.some(entry => entry.label === '自动刷新'), '有「自动刷新」开关', switches.map(entry => entry.label))
  ok(switches.some(entry => entry.label === '让「发现」页使用本地缓存'), '有「让发现页使用本地缓存」接管开关', switches.map(entry => entry.label))
  const intervalSelect = view.elements().find(element => element.type === 'select' && String(element.props?.className ?? '').includes('pmp-select'))
  ok(intervalSelect !== undefined, '有刷新间隔下拉', view.elements().filter(element => element.type === 'select').map(element => element.props?.className))
  eq((intervalSelect?.children ?? []).filter(child => child?.type === 'option').map(option => option.props?.value), ['1', '2', '4', '6', '8', '12', '24'], '间隔下拉 7 项')
  eq(intervalSelect?.props?.value, '4', '间隔默认 4 小时')

  // 添加源输入 + 按钮。
  const addInput = view.elements().find(element => element.type === 'input' && String(element.props?.className ?? '').includes('pmp-input'))
  ok(addInput !== undefined, '有添加索引源的输入框', view.elements().filter(element => element.type === 'input').map(element => element.props?.className))
  ok(String(addInput?.props?.placeholder ?? '').includes('索引 JSON 地址'), '添加源输入框有占位文案', addInput?.props?.placeholder)
  ok(findClickable(view, text => text.trim() === '添加') !== null, '有「添加」按钮', texts.slice(-6))

  // 索引源行操作：刷新 / 复制镜像地址 / 移除。
  for (const label of ['刷新', '复制镜像地址', '移除']) {
    ok(findClickable(view, text => text.trim() === label) !== null, `索引源行有「${label}」按钮`, texts.slice(-10))
  }
  ok(joined.includes('C:/profile/.pluginmarket-plus'), '显示缓存目录', joined.slice(-300))
  eq(loaded.state.consoleErrors.length, 0, '缓存 tab 渲染没有 console.error', loaded.state.consoleErrors)
}
section('渲染：候选列表 / 计数 / 进度')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()

  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  const texts = view.texts()
  const joined = texts.join(' | ')
  ok(texts.length > 0, 'tab 渲染出文本')
  ok(joined.includes('demo-plugin-a'), '渲染出候选 demo-plugin-a', joined.slice(0, 400))
  ok(joined.includes('demo-plugin-b'), '渲染出候选 demo-plugin-b')
  ok(joined.includes('demo-plugin-c'), '渲染出候选 demo-plugin-c')
  ok(joined.includes('1.4.2'), '渲染出目标版本 1.4.2')
  ok(joined.includes('可更新'), '渲染出「可更新」状态', joined.slice(0, 400))
  ok(!joined.includes('undefined'), '渲染里没有 undefined 文案', joined.slice(0, 600))
  ok(!joined.includes('[object Object]'), '渲染里没有 [object Object]', joined.slice(0, 600))
  ok(loaded.state.consoleErrors.length === 0, '渲染期间没有 console.error', loaded.state.consoleErrors)

  const gets = bridge.calls.filter(call => call.method === 'GET').map(call => call.url)
  ok(gets.includes(`${API}/updates`), '首位渲染会 GET /updates', gets)
  ok(bridge.calls.every(call => call.url.startsWith(`${API}/`)), '所有请求都走 /api/pluginmarket-plus 前缀', bridge.calls.map(call => call.url))

  const buttons = view.elements().filter(element => element.type === 'button')
  ok(buttons.length > 0, `渲染出按钮（${buttons.length} 个）`)
  const buttonTexts = buttons.flatMap(button => collectText(button))
  ok(buttonTexts.some(text => text.includes('检查')), '有「检查更新」类按钮', buttonTexts)

  // 没有任何自动更新：渲染/轮询期间不会 POST /updates/apply。
  const applies = bridge.calls.filter(call => call.url === `${API}/updates/apply`)
  eq(applies.length, 0, '仅渲染不会触发 POST /updates/apply（无自动更新）')
}

section('渲染：Host 报 running 时接上进度')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const runningState = {
    ok: true,
    running: true,
    stopped: false,
    finished: false,
    summary: { total: 2, success: 1, failed: 0, cancelled: 0, pending: 1 },
    active: 'demo-plugin-a',
    activeRequestId: 'req-1',
    items: [
      { name: 'demo-plugin-a', current: '1.2.0', latest: '1.4.2', version: '1.4.2', kind: 'npm', requestId: 'req-1', stage: 'installing', success: false, failed: false, restartRequired: false, cancelled: false, error: null, restore: null },
      { name: 'demo-plugin-b', current: '0.9.1', latest: '1.0.0', version: '1.0.0', kind: 'git', requestId: 'req-2', stage: 'queued', success: false, failed: false, restartRequired: false, cancelled: false, error: null, restore: null },
    ],
    logs: ['pnpm 输出：正在安装 demo-plugin-a'],
  }
  const bridge = makeBridge({ candidates: CANDIDATES, running: true, stateSequence: [runningState, runningState] })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  // 让登记的轮询器跑一次（等价于 700ms 到点）。
  for (const interval of loaded.state.intervals.filter(fn => typeof fn === 'function')) interval()
  await settle(view)

  const joined = view.texts().join(' | ')
  ok(bridge.calls.some(call => call.url === `${API}/updates/state`), 'GET /updates 报 running 时会去读 /updates/state', bridge.calls.map(call => call.url))
  ok(joined.includes('demo-plugin-a'), '进度里能看到正在跑的第 1 项', joined.slice(0, 400))
  ok(loaded.state.consoleErrors.length === 0, '接进度时没有 console.error', loaded.state.consoleErrors)
}

section('渲染：桥接失败不崩')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  loaded.state.responses = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, error: 'updates-failed', message: '内部错误：读取索引失败' }),
    text: async () => JSON.stringify({ ok: false, error: 'updates-failed', message: '内部错误：读取索引失败' }),
  })
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  const joined = view.texts().join(' | ')
  ok(joined.length > 0, '桥接 500 时仍渲染出内容')
  ok(joined.includes('内部错误') || joined.includes('failed') || joined.includes('失败'), '显示了失败信息', joined.slice(0, 400))
  eq(loaded.state.consoleErrors.length, 0, '桥接 500 不产生 console.error')
}

section('工具条单行：检查更新 → 搜索 → 齿轮 → 更新全部 → 更新已选')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const t = ctx.locale.bind()
  const hasClass = (name) => element => String(element.props?.className ?? '').split(/\s+/u).includes(name)
  const toolbarSignature = (view) => {
    const toolbar = view.elements().find(hasClass('pmu-toolbar'))
    if (toolbar === undefined) return []
    return toolbar.children.filter(child => child !== null).map((child) => {
      const classes = String(child.props?.className ?? '').split(/\s+/u)
      if (child.type === 'input' && classes.includes('pmu-search')) return 'search'
      if (classes.includes('pmu-filterWrap')) return 'gearWrap'
      if (child.type === 'button') return `button:${elementText(child).trim()}`
      return `other:${child.type}`
    })
  }
  const gearButton = (view) => view.elements().find(element => element.type === 'button' && element.props?.['aria-label'] === '设置')
  const summaryOf = (view) => view.elements().find(hasClass('pmu-summary'))

  // 已检查：统计条最右显示「上次检查 HH:MM」。
  const checkedAt = Date.now() - 5 * 60_000
  const bridge = makeBridge({ candidates: CANDIDATES, checkedAt })
  loaded.state.responses = (url, init) => bridge(url, init)
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  eq(toolbarSignature(view), ['button:检查更新', 'search', 'gearWrap', 'button:更新全部', 'button:更新已选'], '工具条单行次序：检查更新 → 搜索 → 齿轮 → 更新全部 → 更新已选')
  ok(gearButton(view) !== undefined, '有齿轮设置按钮', view.elements().filter(element => element.type === 'button').map(element => element.props?.['aria-label']))
  eq(gearButton(view)?.props?.['aria-label'], '设置', '齿轮 aria-label=设置')
  eq(elementText(gearButton(view) ?? {}).trim(), '', '齿轮按钮无文字')
  eq(gearButton(view)?.props?.title, '设置', '齿轮 title=设置')
  eq(gearButton(view)?.props?.['aria-haspopup'], 'true', '齿轮 aria-haspopup=true')
  eq(gearButton(view)?.props?.['aria-expanded'], 'false', '齿轮初始 aria-expanded=false')
  eq(view.elements().filter(hasClass('pmu-title')).length, 0, '不再渲染标题')
  eq(view.elements().filter(element => element.type === 'select').length, 0, '页面没有 select 过滤下拉')
  eq(view.elements().filter(hasClass('pmu-filterSelect')).length, 0, '没有 pmu-filterSelect')
  eq(view.elements().filter(hasClass('pmu-chip')).length, 0, '没有 pmu-chip')
  eq(findClickable(view, text => text.trim() === '更新已选')?.props?.disabled, true, '无选中时「更新已选」禁用')
  const toolbarCss = latestCss(loaded.state)
  eq(cssRule(toolbarCss, '.pmu-filterSelect'), '', 'CSS 里没有 .pmu-filterSelect 规则')
  eq(cssRule(toolbarCss, '.pmu-chip'), '', 'CSS 里没有 .pmu-chip 规则')
  ok(cssRule(toolbarCss, '.pmu-gearBtn').includes('width:30px'), 'CSS 里有 .pmu-gearBtn 样式', cssRule(toolbarCss, '.pmu-gearBtn'))

  // 统计条：全选 / 统计文本 / 检查时间，同一行且时间在最右（margin-left:auto）。
  const summary = summaryOf(view)
  ok(summary !== undefined, '有统计条', view.texts().slice(0, 200))
  eq((summary?.children ?? []).map(child => String(child?.props?.className ?? '').split(/\s+/u)[0] ?? ''), ['pmu-selectAll', 'pmu-summaryText', 'pmu-summaryTime'], '统计条同一行：全选 → 统计文本 → 检查时间（最右）')
  const time = new Date(checkedAt)
  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  eq(elementText(summary?.children?.[2] ?? {}).trim(), `上次检查 ${hhmm}`, '统计条时间格式：上次检查 HH:MM')
  eq(cssValue(latestCss(loaded.state), '.pmu-summaryTime', 'margin-left'), 'auto', '统计条时间使用 margin-left:auto 靠右')

  // 未检查：显示「尚未检查」。
  const bridge2 = makeBridge({ candidates: CANDIDATES, checkedAt: null })
  loaded.state.responses = (url, init) => bridge2(url, init)
  const view2 = render(tab.component, { t, openPackage: () => {} })
  await settle(view2)
  eq(elementText(summaryOf(view2)?.children?.[2] ?? {}).trim(), '尚未检查', '未检查时统计条显示「尚未检查」')
  eq(loaded.state.consoleErrors.length, 0, '工具条渲染没有 console.error', loaded.state.consoleErrors)
}


section('默认范围：只显示有更新的项；「显示检查失败的项」开关追加失败类')
{
  const rowNames = (view) => view.elements()
    .filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-nameCell'))
    .map(element => elementText(element).trim())
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const hasClass = (name) => element => String(element.props?.className ?? '').split(/\s+/u).includes(name)
  const gearButton = (view) => view.elements().find(element => element.type === 'button' && element.props?.['aria-label'] === '设置')
  const scopeCandidates = [
    { name: 's-updatable', current: '1.0.0', latest: '1.1.0', kind: 'npm', state: 'available', enabled: true, prerelease: false, deprecated: null },
    { name: 's-skipped', current: '1.0.0', latest: '1.1.0-rc.1', kind: 'npm', state: 'skipped', enabled: true, prerelease: true, deprecated: null },
    { name: 's-incompatible', current: '1.0.0', latest: '2.0.0', kind: 'npm', state: 'available', enabled: true, prerelease: false, deprecated: null, incompatible: { name: 's-incompatible', version: '2.0.0', runtimeVersion: '0.3.9', requirements: { 'engines.dsh': '>=0.4.0' } } },
    { name: 's-failed', current: '1.0.0', latest: '1.1.0', kind: 'npm', state: 'error', enabled: true, prerelease: false, deprecated: null },
    { name: 's-uncheckable', current: '1.0.0', latest: '', kind: 'git', state: 'uncheckable', enabled: true, prerelease: false, deprecated: null },
    { name: 's-unknown', current: '1.0.0', latest: '', kind: 'npm', state: 'unknown', enabled: true, prerelease: false, deprecated: null },
  ]
  /**
   * 渲染一次。
   * @param {object} bridge - 假桥接。
   * @returns {Promise<object>} view。
   */
  const openView = async (bridge) => {
    const ctx = makePluginContext(loaded.state)
    loaded.exports.apply(ctx)
    loaded.state.responses = (url, init) => bridge(url, init)
    const view = render(tab.component, { t: ctx.locale.bind(), openPackage: () => {} })
    await settle(view)
    return view
  }

  const bridge = makeBridge({ candidates: scopeCandidates })
  const view = await openView(bridge)
  eq(rowNames(view), ['s-updatable', 's-skipped', 's-incompatible'], '默认范围只显示 可更新 / 暂不推荐 / 不兼容（failed/uncheckable/unknown 不显示）')

  gearButton(view)?.props.onClick()
  await settle(view)
  eq(switchButtons(view).map(entry => entry.label), ['显示检查失败的项', '包含预发布/已废弃', '包含已禁用的插件'], '齿轮菜单含三个开关')
  eq(switchButtons(view).map(entry => entry.checked), ['false', 'false', 'false'], '三个开关初始都关')
  switchButtons(view)[0].node.props.onClick()
  await settle(view)
  const post = bridge.calls.find(call => call.url === `${API}/settings`)
  eq(post?.body?.updatesShowFailed, true, '打开开关 POST /settings updatesShowFailed:true')
  eq(post?.body?.updatesIncludeDisabled, false, 'POST 同时带上 includeDisabled 当前值')
  eq(post?.body?.updatesIncludePrerelease, false, 'POST 同时带上 includePrerelease 当前值')
  eq(switchButtons(view)[0]?.checked, 'true', '开关 aria-checked 变为 true')
  eq(rowNames(view), ['s-updatable', 's-skipped', 's-incompatible', 's-failed', 's-uncheckable', 's-unknown'], '打开后追加 failed/uncheckable/unknown 三项')

  // 搜索仍叠加。
  const search = view.elements().find(element => element.props?.className === 'pmu-search')
  search?.props?.onChange({ target: { value: 's-failed' } })
  await settle(view)
  eq(rowNames(view), ['s-failed'], '搜索与范围叠加：只剩 s-failed')
  search?.props?.onChange({ target: { value: '' } })
  await settle(view)

  // 关闭开关：失败类消失。
  switchButtons(view)[0].node.props.onClick()
  await settle(view)
  const postOff = bridge.calls.filter(call => call.url === `${API}/settings`).at(-1)
  eq(postOff?.body?.updatesShowFailed, false, '关闭开关 POST updatesShowFailed:false')
  eq(rowNames(view), ['s-updatable', 's-skipped', 's-incompatible'], '关闭后失败类项消失')

  // 空态：只有失败项且开关关闭 → 提示去设置打开。
  const onlyFailed = [{ name: 'only-failed', current: '1.0.0', latest: '1.1.0', kind: 'npm', state: 'error', enabled: true, prerelease: false, deprecated: null }]
  const viewEmpty = await openView(makeBridge({ candidates: onlyFailed }))
  ok(viewEmpty.texts().join(' | ').includes('显示检查失败的项'), '只有失败项且开关关闭时，空态提示打开「显示检查失败的项」', viewEmpty.texts().slice(-300))
  // 收尾：关闭仍打开的齿轮菜单，释放 document keydown。
  if (switchButtons(view).length > 0) {
    gearButton(view)?.props.onClick()
    await settle(view)
  }
  eq(loaded.state.consoleErrors.length, 0, '默认范围用例没有 console.error', loaded.state.consoleErrors)
}


section('齿轮设置菜单：三开关 / 遮罩与 Escape / 持久化')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  const hasClass = (name) => element => String(element.props?.className ?? '').split(/\s+/u).includes(name)
  const menuCount = () => view.elements().filter(hasClass('pmu-settingsMenu')).length
  const gearButton = () => view.elements().find(element => element.type === 'button' && element.props?.['aria-label'] === '设置')
  ok(gearButton() !== undefined, '有齿轮设置按钮')
  eq(gearButton()?.props?.['aria-haspopup'], 'true', '齿轮 aria-haspopup=true')
  eq(gearButton()?.props?.['aria-expanded'], 'false', '初始 aria-expanded=false')
  eq(menuCount(), 0, '初始没有设置菜单')
  eq(switchButtons(view).length, 0, '菜单未打开时没有开关')

  gearButton()?.props.onClick()
  await settle(view)
  eq(gearButton()?.props?.['aria-expanded'], 'true', '打开后 aria-expanded=true')
  const menu = view.elements().find(hasClass('pmu-settingsMenu'))
  ok(menu !== undefined, '点击齿轮打开设置菜单', view.texts().slice(-12))
  eq(menu?.props?.role, 'menu', '菜单 role=menu')
  eq(menu?.props?.['aria-label'], '设置', '菜单 aria-label=设置')
  eq(switchButtons(view).map(entry => entry.label), ['显示检查失败的项', '包含预发布/已废弃', '包含已禁用的插件'], '菜单三个开关（显示检查失败 / 预发布·已废弃 / 已禁用）')
  eq(switchButtons(view).map(entry => entry.checked), ['false', 'false', 'false'], '三个开关初始都是关')

  // 切中间那个（预发布）开关：POST /settings 持久化、菜单不收起、其他开关不变。
  switchButtons(view)[1].node.props.onClick()
  await settle(view)
  eq(menuCount(), 1, '切开关不收起菜单')
  const post = bridge.calls.find(call => call.url === `${API}/settings`)
  eq(post?.method, 'POST', '切开关 POST /settings')
  eq(post?.body?.updatesIncludePrerelease, true, 'POST updatesIncludePrerelease:true')
  eq(post?.body?.updatesShowFailed, false, 'POST 同时带上 showFailed 的当前值 false')
  eq(switchButtons(view).map(entry => entry.checked), ['false', 'true', 'false'], '只有被切的开关变 true')

  // 遮罩点击关闭。
  const layer = view.elements().find(hasClass('pmu-menuLayer'))
  ok(layer !== undefined, '齿轮菜单有全屏遮罩', view.texts().slice(-12))
  layer?.props.onClick()
  await settle(view)
  eq(menuCount(), 0, '点遮罩关闭菜单')
  eq(gearButton()?.props?.['aria-expanded'], 'false', '关闭后 aria-expanded=false')

  // 菜单内点击不关闭。
  gearButton()?.props.onClick()
  await settle(view)
  view.elements().find(hasClass('pmu-settingsMenu'))?.props.onClick({ stopPropagation() {} })
  await settle(view)
  eq(menuCount(), 1, '菜单内点击不关闭')

  // Escape（document 监听）关闭并解绑。
  loaded.documentStub.dispatch('keydown', { key: 'Escape' })
  await settle(view)
  eq(menuCount(), 0, 'Escape 关闭设置菜单')
  eq(loaded.documentStub.listenerCount('keydown'), 0, '关闭后解绑 document keydown')

  // 点齿轮开合。
  gearButton()?.props.onClick()
  await settle(view)
  eq(menuCount(), 1, '点齿轮打开')
  gearButton()?.props.onClick()
  await settle(view)
  eq(menuCount(), 0, '再点齿轮收起')
  eq(loaded.state.consoleErrors.length, 0, '齿轮菜单交互没有 console.error', loaded.state.consoleErrors)
}


section('齿轮开关解析与乐观更新（回归：POST 响应缺配置不得清零）')
{
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  /**
   * 渲染一次并打开齿轮菜单。
   * @param {object} bridge - 假桥接。
   * @returns {Promise<object>} view。
   */
  const openMenu = async (bridge) => {
    const ctx = makePluginContext(loaded.state)
    loaded.exports.apply(ctx)
    loaded.state.responses = (url, init) => bridge(url, init)
    const view = render(tab.component, { t: ctx.locale.bind(), openPackage: () => {} })
    await settle(view)
    view.elements().find(element => element.type === 'button' && element.props?.['aria-label'] === '设置')?.props.onClick()
    await settle(view)
    return view
  }
  const switchEntry = (view, label) => switchButtons(view).find(entry => entry.label === label)
  const switchState = (view) => switchButtons(view).map(entry => entry.checked)
  /**
   * 连续采样三个开关的状态，捕捉「一起被清零」的中间态。
   * @param {object} view - view。
   * @param {number} steps - 采样次数。
   * @returns {Promise<string[]>} 形如 'false/false/false' 的样本。
   */
  const sampleSwitches = async (view, steps = 40) => {
    const samples = []
    for (let index = 0; index < steps; index += 1) {
      await sleep(2)
      view.flush()
      const states = switchState(view)
      if (states.length === 3) samples.push(states.join('/'))
    }
    return samples
  }

  // A) POST 返回 status.config（真实 Host 形状）：三个开关保持该值，中途不出现一起变 false。
  const bridgeA = makeBridge({
    candidates: CANDIDATES,
    settingsResponse: { ok: true, saved: true, status: { config: { updatesShowFailed: true, updatesIncludePrerelease: false, updatesIncludeDisabled: false } } },
    updatesDelayMs: 25,
  })
  const viewA = await openMenu(bridgeA)
  eq(switchState(viewA), ['false', 'false', 'false'], '初始三个开关都关')
  switchEntry(viewA, '显示检查失败的项')?.node.props.onClick()
  viewA.flush()
  eq(switchState(viewA), ['true', 'false', 'false'], '点击后立即乐观显示 true（另外两个保持 false）')
  const samplesA = await sampleSwitches(viewA, 40)
  ok(samplesA.length >= 5, '采样到足够多的中间态（防止空样本导致断言空转）', samplesA.length)
  ok(samplesA.every(sample => sample !== 'false/false/false'), '解析响应 / 重载期间不会出现三个开关一起 false 的中间态', samplesA)
  eq(switchState(viewA), ['true', 'false', 'false'], '最终值与 POST 响应的 status.config 一致')
  const postA = bridgeA.calls.find(call => call.url === `${API}/settings`)
  eq(postA?.body?.updatesShowFailed, true, 'POST /settings 带 updatesShowFailed:true')
  eq(postA?.body?.updatesIncludePrerelease, false, 'POST 带 includePrerelease 当前值 false')

  // B) POST 只回 {ok:true}，且 GET /updates 也不带配置：乐观值不得被覆盖。
  const bridgeB = makeBridge({ candidates: CANDIDATES, settingsResponse: { ok: true }, updatesConfig: {}, updatesDelayMs: 25 })
  const viewB = await openMenu(bridgeB)
  switchEntry(viewB, '显示检查失败的项')?.node.props.onClick()
  viewB.flush()
  eq(switchState(viewB), ['true', 'false', 'false'], 'POST 只回 {ok:true} 时乐观值立即生效')
  const samplesB = await sampleSwitches(viewB, 40)
  ok(samplesB.length >= 5, '缺配置场景同样采样到足够多的中间态', samplesB.length)
  ok(samplesB.every(sample => sample !== 'false/false/false'), '响应缺配置时也没有一起 false 的中间态', samplesB)
  eq(switchState(viewB), ['true', 'false', 'false'], 'GET /updates 缺 config 时乐观值保持不变')

  // C) 单开关切换不影响其他：预发布本来开着，切「显示检查失败」后它必须保持 true。
  const bridgeC = makeBridge({
    candidates: CANDIDATES,
    settings: { updatesIncludePrerelease: true },
    settingsResponse: { ok: true, saved: true, status: { config: { updatesShowFailed: true, updatesIncludePrerelease: true, updatesIncludeDisabled: false } } },
  })
  const viewC = await openMenu(bridgeC)
  eq(switchState(viewC), ['false', 'true', 'false'], '预置预发布开关为开')
  switchEntry(viewC, '显示检查失败的项')?.node.props.onClick()
  const samplesC = await sampleSwitches(viewC, 40)
  ok(samplesC.length >= 5, '单开关场景采样到足够多的中间态', samplesC.length)
  ok(samplesC.every(sample => sample.split('/')[1] === 'true'), '切一个开关期间预发布开关始终为 true', samplesC)
  eq(switchState(viewC), ['true', 'true', 'false'], '最终显示检查失败与预发布都是 true')
  eq(bridgeC.calls.find(call => call.url === `${API}/settings`)?.body?.updatesIncludePrerelease, true, 'POST 带上另一个开关的真实值（未被清零）')

  // D) GET /updates 顶层 config 仍能应用（含 showFailed / includeXxx 别名）。
  const bridgeD = makeBridge({ candidates: CANDIDATES, updatesConfig: { showFailed: true, includePrerelease: true } })
  const viewD = await openMenu(bridgeD)
  eq(switchState(viewD), ['true', 'true', 'false'], 'GET /updates 顶层 config（别名键 showFailed / includePrerelease）正确应用')

  // E/F) settable 由 saved === false 推导；纯函数独立复算。
  const bridgeE = makeBridge({ candidates: CANDIDATES, settingsResponse: { ok: true, saved: false, status: { config: { updatesShowFailed: true, updatesIncludePrerelease: false, updatesIncludeDisabled: false } } } })
  const viewE = await openMenu(bridgeE)
  switchEntry(viewE, '显示检查失败的项')?.node.props.onClick()
  await settle(viewE, 60)
  ok(viewE.texts().join(' | ').includes('只对本次运行生效'), 'saved:false 时提示「只对本次运行生效」', viewE.texts().slice(0, 400))
  const bridgeF = makeBridge({ candidates: CANDIDATES, settingsResponse: { ok: true, saved: true, status: { config: { updatesShowFailed: true, updatesIncludePrerelease: false, updatesIncludeDisabled: false } } } })
  const viewF = await openMenu(bridgeF)
  switchEntry(viewF, '显示检查失败的项')?.node.props.onClick()
  await settle(viewF, 60)
  ok(!viewF.texts().join(' | ').includes('只对本次运行生效'), 'saved:true 时不出现该提示', viewF.texts().slice(0, 400))

  const info = loaded.exports.inspectable()
  eq(typeof info.readSettings, 'function', 'inspectable 暴露 readSettings（纯函数）')
  eq(info.readSettings?.({ ok: true, saved: false, status: { config: { updatesShowFailed: true } } })?.settable, false, 'readSettings：saved:false ⇒ settable=false')
  eq(info.readSettings?.({ ok: true, saved: true, status: { config: { updatesShowFailed: true } } })?.settable, true, 'readSettings：saved:true ⇒ settable=true')
  eq(info.readSettings?.({ ok: true, status: { config: { updatesShowFailed: true, updatesIncludePrerelease: false } } })?.known, true, 'readSettings：嵌套 status.config 命中 ⇒ known=true')
  eq(info.readSettings?.({ ok: true, status: { config: { updatesShowFailed: true } } })?.showFailed, true, 'readSettings：解析 status.config.updatesShowFailed')
  eq(info.readSettings?.({ ok: true, config: { showFailed: true } })?.showFailed, true, 'readSettings：顶层 config.showFailed 别名')
  eq(info.readSettings?.({ ok: true })?.known, false, 'readSettings：无配置 ⇒ known=false')
  eq(info.mergeSettings?.({ includeDisabled: true, includePrerelease: true, showFailed: true, settable: true }, { showFailed: false }), { includeDisabled: true, includePrerelease: true, showFailed: false, settable: true }, 'mergeSettings：只并入确实提供的字段')
  eq(loaded.state.consoleErrors.length, 0, '开关解析用例没有 console.error', loaded.state.consoleErrors)
}


section('筛选菜单结构：不在遮罩内 / 兄弟节点 / 层级与视口约束')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)

  const hasClass = (name) => element => String(element.props?.className ?? '').split(/\s+/u).includes(name)
  const gearButton = () => view.elements().find(element => element.type === 'button' && element.props?.['aria-label'] === '设置')
  gearButton()?.props.onClick()
  await settle(view)

  const filterWrap = view.elements().find(hasClass('pmu-filterWrap'))
  const layer = view.elements().find(hasClass('pmu-menuLayer'))
  const menu = view.elements().find(hasClass('pmu-menu'))
  ok(filterWrap !== undefined && layer !== undefined && menu !== undefined, '打开后有 filterWrap / menuLayer / menu', view.texts().slice(0, 120))

  // 1) 关键回归：菜单不能嵌在全屏 fixed 遮罩里（否则绝对定位的包含块变成视口，菜单掉到屏幕外）。
  ok(!descendantsOf(layer).includes(menu), '菜单不是全屏遮罩的后代')
  ok(!descendantsOf(menu).includes(layer), '遮罩也不是菜单的后代')
  ok(filterWrap?.children.includes(layer) === true, '遮罩是 filterWrap 的直接子节点')
  ok(filterWrap?.children.includes(menu) === true, '菜单是 filterWrap 的直接子节点')
  const childClasses = (filterWrap?.children ?? []).map(child => String(child?.props?.className ?? '').split(/\s+/u))
  const layerIndex = childClasses.findIndex(list => list.includes('pmu-menuLayer'))
  const buttonIndex = childClasses.findIndex(list => list.includes('pmu-gearBtn'))
  const menuIndex = childClasses.findIndex(list => list.includes('pmu-menu'))
  ok(layerIndex < buttonIndex && buttonIndex < menuIndex, 'filterWrap 子节点次序：遮罩 → 按钮 → 菜单', { layerIndex, buttonIndex, menuIndex })
  eq(menu?.props?.['data-anchored'], 'css', '拿不到布局信息时退化为纯 CSS 定位（data-anchored=css）')
  ok(menu?.props?.style === undefined, '纯 CSS 定位时没有内联坐标覆盖', menu?.props?.style)

  // 反向对照：同样的结构若被嵌进遮罩（t21 的旧缺陷），上面的检查必须能发现。
  const fakeMenu = { props: { className: 'pmu-menu' }, children: [] }
  const fakeLayer = { props: { className: 'pmu-menuLayer' }, children: [fakeMenu] }
  const fakeWrap = { props: { className: 'pmu-filterWrap' }, children: [fakeLayer] }
  ok(descendantsOf(fakeLayer).includes(fakeMenu), '对照：菜单嵌在遮罩内时能被检测为后代')
  ok(!fakeWrap.children.includes(fakeMenu), '对照：嵌套时菜单不是 filterWrap 的直接子节点')

  // 2) CSS：定位包含块、层级、视口约束与换向规则。
  const css = latestCss(loaded.state)
  eq(cssValue(css, '.pmu-filterWrap', 'position'), 'relative', 'filterWrap 是定位包含块（position:relative）')
  eq(cssValue(css, '.pmu-menuLayer', 'position'), 'fixed', '遮罩仍是全屏 fixed')
  eq(cssValue(css, '.pmu-menuLayer', 'inset'), '0', '遮罩 inset:0（全屏）')
  eq(cssValue(css, '.pmu-menuLayer', 'z-index'), '30', '遮罩 z-index=30')
  eq(cssValue(css, '.pmu-menu', 'position'), 'absolute', '菜单相对 filterWrap 绝对定位（不再相对全屏遮罩）')
  eq(cssValue(css, '.pmu-menu', 'top'), 'calc(100% + 6px)', '菜单贴在按钮正下方 6px')
  eq(cssValue(css, '.pmu-menu', 'z-index'), '41', '菜单 z-index=41')
  ok(Number(cssValue(css, '.pmu-menu', 'z-index')) > Number(cssValue(css, '.pmu-menuLayer', 'z-index')), '菜单在遮罩之上（41 > 30）')
  ok(Number(cssValue(css, '.pmu-gearBtn', 'z-index')) > Number(cssValue(css, '.pmu-menuLayer', 'z-index')), '齿轮按钮也在遮罩之上，可直接再点收起')
  ok(cssValue(css, '.pmu-menu', 'max-width') === 'min(320px,92vw)' && cssValue(css, '.pmu-menu', 'max-height') === 'min(70vh,360px)', '菜单有视口尺寸约束', { maxWidth: cssValue(css, '.pmu-menu', 'max-width'), maxHeight: cssValue(css, '.pmu-menu', 'max-height') })
  eq(cssValue(css, '.pmu-menu', 'overflow'), 'auto', '菜单内容可滚动')
  ok(/\.pmu-menu\[data-placement="top"\]\[data-anchored="css"\]\{[^}]*bottom:calc\(100% \+ 6px\)/u.test(css), '换向规则只在纯 CSS 定位时生效', css.match(/\.pmu-menu\[data-placement[^}]*\}/u)?.[0])

  // 3) 交互：菜单内点击不关闭 / 再点按钮收起 / 遮罩关闭 / Escape 关闭 / aria-expanded 同步。
  eq(gearButton()?.props?.['aria-expanded'], 'true', '展开时 aria-expanded=true')
  menu?.props.onClick({ stopPropagation() {} })
  await settle(view)
  eq(view.elements().filter(hasClass('pmu-menu')).length, 1, '菜单内点击不关闭')
  gearButton()?.props.onClick()
  await settle(view)
  eq(view.elements().filter(hasClass('pmu-menu')).length, 0, '再点按钮收起')
  eq(gearButton()?.props?.['aria-expanded'], 'false', '收起后 aria-expanded=false')
  gearButton()?.props.onClick()
  await settle(view)
  view.elements().find(hasClass('pmu-menuLayer'))?.props.onClick()
  await settle(view)
  eq(view.elements().filter(hasClass('pmu-menu')).length, 0, '点遮罩关闭')
  gearButton()?.props.onClick()
  await settle(view)
  loaded.documentStub.dispatch('keydown', { key: 'Escape' })
  await settle(view)
  eq(view.elements().filter(hasClass('pmu-menu')).length, 0, 'Escape 关闭')
  eq(gearButton()?.props?.['aria-expanded'], 'false', 'Escape 后 aria-expanded=false')
  eq(loaded.state.consoleErrors.length, 0, '结构交互没有 console.error', loaded.state.consoleErrors)
}

section('menuPlacement 与内联 fixed 兑底（独立复算）')
{
  const info = loaded.exports.inspectable()
  eq(typeof info.menuPlacement, 'function', 'inspectable 暴露 menuPlacement（纯函数）')
  const place = info.menuPlacement
  if (typeof place === 'function') {
    const anchor = { top: 100, bottom: 128, left: 300 }
    const viewport = { width: 1280, height: 800 }
    const size = { width: 240, height: 108 }
    const below = place(anchor, viewport, size)
    eq({ left: below.left, top: below.top, placement: below.placement }, { left: 300, top: 134, placement: 'bottom' }, '下方放得下时贴在按钮下方（bottom + 6）')
    const flipped = place({ top: 760, bottom: 788, left: 1200 }, viewport, size)
    eq(flipped.placement, 'top', '下方放不下时换向到上方')
    eq(flipped.top, 760 - 6 - 108, '换向后 top = anchor.top - gap - menuHeight')
    eq(flipped.left, 1280 - 240 - 8, '右侧贴边收敛到 viewport - menuWidth - 8')
    eq(place({ top: 0, bottom: 20, left: 0 }, { width: 320, height: 200 }, size).left, 8, '左侧贴边保留 8px')
    eq(place(anchor, { width: 0, height: 0 }, size).placement, 'bottom', '视口尺寸未知（0）时保守选下方')
  }

  // 内联 fixed 兑底：给 filterWrap 注入真实 rect（按钮位于视口下方附近）→ 菜单用内联坐标定位。
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  setElementRect(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-filterWrap')
    ? { width: 120, height: 28, top: 570, bottom: 598, left: 100 }
    : { width: 0, height: 0, top: 0, bottom: 0, left: 0 })
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  view.elements().find(element => element.type === 'button' && element.props?.['aria-label'] === '设置')?.props.onClick()
  await settle(view)
  const menu = view.elements().find(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-menu'))
  eq(menu?.props?.['data-anchored'], 'fixed', '拿到布局信息时用内联 fixed 定位')
  eq(menu?.props?.['data-placement'], 'bottom', '视口下方放得下 → placement=bottom')
  eq(menu?.props?.style, { position: 'fixed', left: '100px', top: '604px' }, '内联坐标 = 按钮下方 6px（left=100 / top=598+6）')
  ok(descendantsOf(menu).length >= 2, '内联定位时菜单内容照常渲染', descendantsOf(menu).length)
  resetElementRect()
  eq(loaded.state.consoleErrors.length, 0, '内联 fixed 兑底没有 console.error', loaded.state.consoleErrors)
}
section('更新全部 / 更新已选：同一 apply 载荷；底部批量栏已移除')
{
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')

  /**
   * 渲染一次，按 `trigger` 走完确认流程，返回 apply 请求体。
   * @param {(context: {view: object, bridge: object}) => Promise<object|undefined>} trigger - 交互步骤。
   * @returns {Promise<{body: object|undefined, view: object, bridge: object}>} 结果。
   */
  const runApply = async (trigger) => {
    const ctx = makePluginContext(loaded.state)
    loaded.exports.apply(ctx)
    const bridge = makeBridge({ candidates: CANDIDATES })
    loaded.state.responses = (url, init) => bridge(url, init)
    const view = render(tab.component, { t: ctx.locale.bind(), openPackage: () => {} })
    await settle(view)
    const body = await trigger({ view, bridge })
    return { body, view, bridge }
  }

  // A：「更新全部」。
  const a = await runApply(async ({ view, bridge }) => {
    const button = findClickable(view, text => text.trim() === '更新全部')
    ok(button !== null && button.props?.disabled !== true, '有可安装项时「更新全部」可用', button?.props?.disabled)
    button?.props.onClick()
    await settle(view)
    ok(view.texts().join(' | ').includes('确认更新'), '「更新全部」打开确认框', view.texts().slice(-14))
    findClickable(view, text => text.trim() === '开始更新')?.props.onClick()
    await settle(view)
    return bridge.calls.find(call => call.url === `${API}/updates/apply`)?.body
  })
  ok(a.body !== undefined, '「更新全部」确认后 POST /updates/apply', a.view.texts().slice(-14))

  // B：无选中时禁用；选中一行后只发这一行。
  const b = await runApply(async ({ view, bridge }) => {
    const button = findClickable(view, text => text.trim() === '更新已选')
    ok(button !== null, '头部有「更新已选」按钮')
    eq(button?.props?.disabled, true, '无选中时「更新已选」禁用')
    findInputByLabel(view, 'demo-plugin-a')?.props.onChange({ target: { checked: true }, currentTarget: { checked: true } })
    await settle(view)
    eq(findClickable(view, text => text.trim() === '更新已选')?.props?.disabled, false, '选中一项后「更新已选」可用')
    findClickable(view, text => text.trim() === '更新已选')?.props.onClick()
    await settle(view)
    ok(view.texts().join(' | ').includes('确认更新'), '「更新已选」打开确认框', view.texts().slice(-14))
    findClickable(view, text => text.trim() === '开始更新')?.props.onClick()
    await settle(view)
    return bridge.calls.find(call => call.url === `${API}/updates/apply`)?.body
  })
  eq((b.body?.items ?? []).map(item => item.name), ['demo-plugin-a'], '「更新已选」只发选中的那一项')

  // C：全选后「更新已选」= 原批量更新（与「更新全部」同载荷）。
  const c = await runApply(async ({ view, bridge }) => {
    const selectAll = findCheckable(view)
    ok(selectAll !== null, '统计条有全选勾选框')
    const handler = typeof selectAll?.props?.onChange === 'function' ? selectAll.props.onChange : selectAll?.props?.onClick
    handler?.({ target: { checked: true }, currentTarget: { checked: true } })
    await settle(view)
    findClickable(view, text => text.trim() === '更新已选')?.props.onClick()
    await settle(view)
    findClickable(view, text => text.trim() === '开始更新')?.props.onClick()
    await settle(view)
    return bridge.calls.find(call => call.url === `${API}/updates/apply`)?.body
  })
  eq(c.body?.items, a.body?.items, '全选后「更新已选」的 apply 载荷与「更新全部」完全一致')
  const names = (a.body?.items ?? []).map(item => item.name)
  ok(names.includes('demo-plugin-a') && names.includes('demo-plugin-b'), 'apply 含 demo-plugin-a 与 demo-plugin-b', names)
  ok(!names.includes('demo-plugin-c'), '不兼容的 demo-plugin-c 不进「更新全部 / 更新已选」', names)
  ok((a.body?.items ?? []).every(item => Object.keys(item).every(key => ['name', 'spec', 'commit'].includes(key))), 'apply items 只带 name/spec/commit', a.body?.items)
  ok(a.body?.requestId === undefined, 'apply 请求体不带 requestId（Host 契约不接这个参数）', a.body)
  const gitItem = (a.body?.items ?? []).find(item => item.name === 'demo-plugin-b')
  ok(typeof gitItem?.spec === 'string' && gitItem.spec.includes('#'), 'git 项带上索引里的固定 spec', gitItem)
  eq(loaded.state.consoleErrors.length, 0, '更新交互没有 console.error', loaded.state.consoleErrors)
}

section('新行 UI：插件名即详情入口 / 无详情按钮 / 无展开原因 / 不显示 requirements')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const opened = []
  const view = render(tab.component, { t, openPackage: name => opened.push(name) })
  await settle(view)

  const allText = view.texts().join(' | ')
  const nameButtons = view.elements().filter(element => element.type === 'button' && String(element.props?.className ?? '').split(/\s+/u).includes('pmu-nameLink'))
  eq(nameButtons.map(element => elementText(element).trim()), ['demo-plugin-a', 'demo-plugin-b', 'demo-plugin-c'], '三行插件名都是可点击的 button.pmu-nameLink')
  ok(nameButtons.every(element => element.props?.title === elementText(element).trim()), '名称按钮的 title 是包名', nameButtons.map(element => element.props?.title))
  for (const button of nameButtons) button.props.onClick()
  await settle(view)
  eq(opened, ['demo-plugin-a', 'demo-plugin-b', 'demo-plugin-c'], '点击名称后 openPackage 依次收到包名')

  eq(findClickable(view, text => text.includes('详情')), null, '页面没有「详情」按钮')
  ok(!allText.includes('详情'), '页面文本里没有「详情」字样', allText.slice(0, 600))
  eq(findClickable(view, text => /展开不兼容原因|收起/u.test(text)), null, '页面没有「展开不兼容原因/收起」按钮')
  ok(!/展开不兼容原因|收起/u.test(allText), '页面文本不含展开/收起文案', allText.slice(0, 600))
  ok(!/>=0\.4\.0/u.test(allText), '不兼容行不显示 requirements 范围（>=0.4.0）', allText.slice(0, 600))
  ok(!/不满足项|与当前 DSH 不兼容|运行中的 DSH/u.test(allText), '页面没有不兼容解释区文案', allText.slice(0, 600))

  // owner 未提供 openPackage 时，名称回退成 span（不是按钮）。
  const view2 = render(tab.component, { t })
  await settle(view2)
  eq(view2.elements().filter(element => element.type === 'button' && String(element.props?.className ?? '').split(/\s+/u).includes('pmu-nameLink')).length, 0, 'owner 未提供 openPackage 时名称不是按钮')
  ok(view2.texts().join(' ').includes('demo-plugin-a'), '回退后仍显示插件名')
  eq(loaded.state.consoleErrors.length, 0, '新行 UI 渲染没有 console.error', loaded.state.consoleErrors)
}

section('行布局：名称 → 来源 → 版本 → 状态 → 操作（来源徽标 npm）')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)

  const signatures = rowMainSignatures(view)
  eq(signatures.length, 3, '渲染出 3 行 pmu-rowMain')
  eq(signatures[0], ['checkbox', 'name', 'kind:npm', 'versions', 'spacer', 'status:updatable', 'actions'], '第 1 行次序：勾选→名称→npm→版本→空隙→主状态→操作')
  eq(signatures[1], ['checkbox', 'name', 'kind:git', 'versions', 'spacer', 'status:updatable', 'actions'], '第 2 行来源徽标是 git')
  eq(signatures[2], ['checkbox', 'name', 'kind:npm', 'versions', 'spacer', 'status:incompatible', 'actions'], '第 3 行来源徽标 npm、主状态不兼容')
  ok(!view.texts().join(' | ').includes('registry'), '页面不出现旧来源名 registry', view.texts().slice(0, 400))
  eq(statusBadges(view).length, 3, '每行恰好 1 个主状态徽标')
  ok(statusBadges(view).every(badge => badge.title === undefined), '非「无法检查」状态不设置 title', statusBadges(view))
  const rowActionNodes = view.elements().filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-rowActions'))
  ok(rowActionNodes.length >= 3 && rowActionNodes.slice(0, 3).every(node => node.children.some(child => elementText(child).trim() === '更新')), '每行操作区含「更新」按钮且位于行尾（status 之后）', rowActionNodes.slice(0, 3).map(node => elementText(node).trim()))

  // 兼容旧数据：kind:'registry' 归一为 npm 徽标。
  const legacy = [{ name: 'legacy-reg', current: '1.0.0', latest: '1.1.0', kind: 'registry', state: 'available', enabled: true, prerelease: false, deprecated: null }]
  const bridge2 = makeBridge({ candidates: legacy })
  loaded.state.responses = (url, init) => bridge2(url, init)
  const view2 = render(tab.component, { t, openPackage: () => {} })
  await settle(view2)
  ok(rowMainSignatures(view2)[0]?.includes('kind:npm'), '旧 kind:registry 归一为 npm 徽标', rowMainSignatures(view2))
  eq(statusBadges(view2)[0]?.state, 'updatable', '旧 kind 不影响主状态')
  eq(loaded.state.consoleErrors.length, 0, '行布局渲染没有 console.error', loaded.state.consoleErrors)
}

section('行网格：8 列共享模板与跨行对齐')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)

  const css = latestCss(loaded.state)
  const rowMainRule = cssRule(css, '.pmu-rowMain')
  eq(cssValue(css, '.pmu-rowMain', 'display'), 'grid', '行主区使用 display:grid')
  const template = cssValue(css, '.pmu-rowMain', 'grid-template-columns')
  const tracks = template.split(/\s+/u).filter(Boolean)
  eq(tracks.length, 8, 'grid-template-columns 是 8 条轨道', tracks)
  eq(tracks[0], 'auto', '第 1 轨（复选框）auto')
  eq(tracks[1], 'minmax(0,1fr)', '第 2 轨（名称）minmax(0,1fr)，可伸缩可省略')
  eq(tracks[2], '56px', '第 3 轨（来源）固定 56px')
  eq(tracks[3], '148px', '第 4 轨（版本）固定 148px')
  eq(tracks[4], 'minmax(8px,0.4fr)', '第 5 轨（间隙）弹性空隙')
  eq(tracks[5], '56px', '第 6 轨（已禁用）固定 56px')
  eq(tracks[6], '92px', '第 7 轨（状态）固定 92px')
  ok(tracks[7].startsWith('minmax(112px'), '第 8 轨（操作）最小 112px', tracks[7])
  eq(cssValue(css, '.pmu-rowMain', 'column-gap'), '10px', '列间距 10px')
  eq(cssValue(css, '.pmu-rowMain', 'row-gap'), '6px', '行间距 6px')
  eq(cssValue(css, '.pmu-rowMain', 'align-items'), 'center', '单元格垂直居中')
  ok(rowMainRule.includes('min-width:0'), '行主区 min-width:0（不撑破容器）', rowMainRule)

  // 列顺序：每个网格项显式 grid-column 1..8（同一套规则作用于所有行 → 同一 x 坐标）。
  const columnOf = (selector) => cssValue(css, selector, 'grid-column')
  eq(columnOf('.pmu-check'), '1', '复选框在第 1 列')
  eq(columnOf('.pmu-nameCell'), '2', '名称在第 2 列')
  eq(columnOf('.pmu-kindBadge'), '3', '来源在第 3 列')
  eq(columnOf('.pmu-versions'), '4', '版本在第 4 列')
  eq(columnOf('.pmu-spacer'), '5', '间隙在第 5 列')
  eq(columnOf('.pmu-disabledBadge'), '6', '已禁用在第 6 列')
  eq(columnOf('.pmu-statusBadge'), '7', '状态在第 7 列')
  eq(columnOf('.pmu-rowActions'), '8', '操作在第 8 列')
  eq(
    ['.pmu-check', '.pmu-nameCell', '.pmu-kindBadge', '.pmu-versions', '.pmu-spacer', '.pmu-disabledBadge', '.pmu-statusBadge', '.pmu-rowActions'].map(columnOf),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
    '列顺序：复选框 / 名称 / 来源 / 版本 / 间隙 / 已禁用 / 状态 / 操作',
  )
  ok(Number(columnOf('.pmu-kindBadge')) < Number(columnOf('.pmu-versions')), '来源列在版本列之前（3 < 4）')
  ok(Number(columnOf('.pmu-versions')) > Number(columnOf('.pmu-kindBadge')), '版本列在来源列之后（4 > 3）')
  ok(Number(columnOf('.pmu-disabledBadge')) < Number(columnOf('.pmu-statusBadge')), '已禁用列在状态列左侧（6 < 7）')

  // 跨行对齐：所有行共用同一模板、无行内覆盖，且每行八类网格项齐全（同类项落在同一轨道）。
  const rowMains = view.elements().filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-rowMain'))
  eq(rowMains.length, 3, '三行都有 pmu-rowMain')
  ok(rowMains.every(main => main.props?.style === undefined), '所有行没有行内 grid 覆盖（共用同一模板）', rowMains.map(main => main.props?.style))
  const gridClasses = ['pmu-check', 'pmu-nameCell', 'pmu-kindBadge', 'pmu-versions', 'pmu-spacer', 'pmu-statusBadge', 'pmu-rowActions']
  for (const [index, main] of rowMains.entries()) {
    const classes = main.children.map(child => String(child?.props?.className ?? '').split(/\s+/u))
    for (const cls of gridClasses) {
      eq(classes.filter(list => list.includes(cls)).length, 1, `第 ${index + 1} 行恰好一个 ${cls} 网格项`)
    }
    ok(classes.some(list => list.includes('pmu-rowActions')) && String(main.children.at(-1)?.props?.className ?? '').includes('pmu-rowActions'), `第 ${index + 1} 行操作列在行尾（第 8 列）`)
  }

  // 名称列可省略：min-width:0 + overflow:hidden + 省略号 + nowrap，且名称控件带 title。
  ok(cssRule(css, '.pmu-nameCell').includes('min-width:0') && cssRule(css, '.pmu-nameCell').includes('overflow:hidden'), '.pmu-nameCell 有 min-width:0 + overflow:hidden', cssRule(css, '.pmu-nameCell'))
  for (const selector of ['.pmu-name', '.pmu-nameLink']) {
    ok(cssValue(css, selector, 'text-overflow') === 'ellipsis', `${selector} 使用省略号`, cssValue(css, selector, 'text-overflow'))
    ok(cssValue(css, selector, 'white-space') === 'nowrap', `${selector} 不换行`, cssValue(css, selector, 'white-space'))
    ok(cssRule(css, selector).includes('min-width:0'), `${selector} min-width:0`, cssRule(css, selector))
  }
  const nameCells = view.elements().filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-nameCell'))
  eq(nameCells.length, 3, '三行都有 pmu-nameCell 名称列')
  ok(nameCells.every(element => element.props?.title === elementText(element).trim()), '名称控件 title 为完整包名', nameCells.map(element => element.props?.title))

  // 操作列右对齐 + 内部可换行；每行「更新」按钮都在操作列内。
  eq(cssValue(css, '.pmu-rowActions', 'justify-content'), 'flex-end', '操作列内容右对齐（justify-content:flex-end）')
  eq(cssValue(css, '.pmu-rowActions', 'justify-self'), 'end', '操作列自身靠右（justify-self:end）')
  ok(cssValue(css, '.pmu-rowActions', 'flex-wrap') === 'wrap', '操作列内部可换行（flex-wrap:wrap）')
  for (const [index, main] of rowMains.entries()) {
    const actions = main.children.find(child => String(child?.props?.className ?? '').split(/\s+/u).includes('pmu-rowActions'))
    ok(actions !== undefined && collectText(actions).some(text => text.trim() === '更新'), `第 ${index + 1} 行「更新」按钮在操作列内`, actions === undefined ? undefined : elementText(actions))
  }

  // 窄屏：三条媒体查询仍保持 8 轨结构（跨行对齐在各断点都成立）。
  ok(/@media \(max-width:720px\)\{\.pmu-rowMain\{grid-template-columns:[^}]*\}/u.test(css), '≤720px 有网格收紧规则', css.match(/@media \(max-width:720px\)[^@]*/u)?.[0]?.slice(0, 160))
  ok(/@media \(max-width:560px\)\{[^@]*\.pmu-spacer\{display:none\}/u.test(css), '≤560px 隐藏弹性空隙', css.match(/@media \(max-width:560px\)[^@]*/u)?.[0]?.slice(0, 160))
  ok(/@media \(max-width:420px\)\{\.pmu-rowMain\{grid-template-columns:[^}]*\}/u.test(css), '≤420px 有网格收紧规则')
  const mediaTracks = [...css.matchAll(/@media \(max-width:(\d+)px\)\{\.pmu-rowMain\{grid-template-columns:([^}]*)\}/gu)].map(match => ({ px: Number(match[1]), tracks: match[2].split(/\s+/u).filter(Boolean).length }))
  ok(mediaTracks.length === 3 && mediaTracks.every(entry => entry.tracks === 8), '三条媒体查询的 grid-template-columns 都是 8 轨', mediaTracks)

  eq(loaded.state.consoleErrors.length, 0, '行网格渲染没有 console.error', loaded.state.consoleErrors)
}

section('行网格：非禁用行为空占位、更新按钮右对齐')
{
  const candidates = [
    { name: 'grid-enabled', current: '1.0.0', latest: '1.1.0', kind: 'npm', state: 'available', enabled: true, prerelease: false, deprecated: null },
    { name: 'grid-disabled', current: '1.0.0', latest: '1.1.0', kind: 'npm', state: 'available', enabled: false, prerelease: false, deprecated: null },
  ]
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates, settings: { updatesIncludeDisabled: true } })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)

  const rowMains = view.elements().filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-rowMain'))
  eq(rowMains.length, 2, '启用 / 禁用两行都渲染')
  const disabledCount = (main) => main.children.filter(child => String(child?.props?.className ?? '').split(/\s+/u).includes('pmu-disabledBadge')).length
  eq(disabledCount(rowMains[0]), 0, '未禁用行不渲染「已禁用」徽标（第 6 列为空）')
  eq(disabledCount(rowMains[1]), 1, '已禁用行渲染「已禁用」徽标')
  const statusCount = (main) => main.children.filter(child => String(child?.props?.className ?? '').split(/\s+/u).includes('pmu-statusBadge')).length
  eq([statusCount(rowMains[0]), statusCount(rowMains[1])], [1, 1], '两行状态列都恰好一个徽标（空列不挤动第 7 列）')
  const actionsIndex = (main) => main.children.findIndex(child => String(child?.props?.className ?? '').split(/\s+/u).includes('pmu-rowActions'))
  const statusIndex = (main) => main.children.findIndex(child => String(child?.props?.className ?? '').split(/\s+/u).includes('pmu-statusBadge'))
  ok(statusIndex(rowMains[0]) < actionsIndex(rowMains[0]) && statusIndex(rowMains[1]) < actionsIndex(rowMains[1]), '两行状态列都在操作列之前（第 7 列 → 第 8 列）', [statusIndex(rowMains[0]), actionsIndex(rowMains[0])])
  const css = latestCss(loaded.state)
  eq(cssValue(css, '.pmu-rowActions', 'justify-content'), 'flex-end', '操作列右对齐（静态规则）')
  ok(badgeTexts(view).includes('已禁用') && badgeTexts(view).includes('可更新'), '已禁用徽标与主状态「可更新」并存', badgeTexts(view))
  eq(loaded.state.consoleErrors.length, 0, '空占位渲染没有 console.error', loaded.state.consoleErrors)
}

section('已禁用：DisabledBadge 在主状态左侧，主状态不返回 disabled')
{
  const candidates = [{ name: 'disabled-demo', current: '1.0.0', latest: '2.0.0', kind: 'npm', state: 'available', enabled: false, prerelease: false, deprecated: null }]
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates, settings: { updatesIncludeDisabled: true } })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)

  const signature = rowMainSignatures(view)[0] ?? []
  eq(signature, ['checkbox', 'name', 'kind:npm', 'versions', 'spacer', 'disabled', 'status:updatable', 'actions'], '已禁用行次序：…→空隙→已禁用→主状态→操作')
  ok(signature.indexOf('disabled') >= 0 && signature.indexOf('disabled') < signature.indexOf('status:updatable'), '「已禁用」徽标在主状态左侧', signature)
  ok(badgeTexts(view).includes('已禁用'), '出现独立的「已禁用」徽标', badgeTexts(view))
  eq(statusBadges(view)[0]?.state, 'updatable', '主状态是「可更新」，永不返回 disabled')
  eq(statusBadges(view)[0]?.text, '可更新', '主状态文案是「可更新」')
  eq(loaded.state.consoleErrors.length, 0, '已禁用行渲染没有 console.error', loaded.state.consoleErrors)
}

section('无法检查：主状态徽标 title 带具体原因（zh/en）')
{
  const candidates = [
    { name: 'unc-index', current: '1.0.0', latest: '', kind: 'git', state: 'uncheckable', reason: 'index-miss', enabled: true, prerelease: false, deprecated: null },
    { name: 'unc-unpinned', current: '1.0.0', latest: '', kind: 'git', state: 'uncheckable', reason: 'unpinned-git-spec', enabled: true, prerelease: false, deprecated: null },
    { name: 'unc-other', current: '1.0.0', latest: '', kind: 'git', state: 'uncheckable', enabled: true, prerelease: false, deprecated: null },
  ]
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates, settings: { updatesShowFailed: true } })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  const badges = statusBadges(view)
  eq(badges.map(badge => badge.state), ['uncheckable', 'uncheckable', 'uncheckable'], '三行主状态都是「无法检查」')
  eq(badges[0]?.title, '本地索引中找不到该 Git 包可用的提交记录', 'index-miss → 中文 title')
  eq(badges[1]?.title, 'Git 包未固定 commit，无法检查更新', 'unpinned-git-spec → 中文 title')
  eq(badges[2]?.title, '暂时无法检查更新（原因未知）', '缺失 reason → 中文兜底')
  eq(badges[0]?.text, '无法检查', '主状态文案是「无法检查」')

  // 英文词典同样映射（原生 title）。
  const ctxEn = makePluginContext(loaded.state, 'en')
  loaded.exports.apply(ctxEn)
  const tEn = ctxEn.locale.bind()
  const viewEn = render(tab.component, { t: tEn, openPackage: () => {} })
  await settle(viewEn)
  eq(statusBadges(viewEn)[0]?.title, 'No usable commit for this Git bundle was found in the local index', 'index-miss → 英文 title')
  eq(statusBadges(viewEn)[1]?.title, 'This Git bundle is not pinned to a commit, so updates cannot be checked', 'unpinned-git-spec → 英文 title')
  eq(loaded.state.consoleErrors.length, 0, '无法检查渲染没有 console.error', loaded.state.consoleErrors)
}

section('主状态唯一：预发布/已废弃不重复渲染徽标')
{
  const candidates = [
    { name: 'pre-demo', current: '1.0.0', latest: '2.0.0-rc.1', kind: 'npm', state: 'skipped', enabled: true, prerelease: true, deprecated: null },
    { name: 'dep-demo', current: '1.0.0', latest: '1.5.0', kind: 'npm', state: 'skipped', enabled: true, prerelease: false, deprecated: '旧版本，停止维护' },
  ]
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  eq(statusBadges(view).length, 2, '每行恰好 1 个主状态徽标')
  eq(statusBadges(view).map(badge => badge.state), ['prerelease', 'deprecated'], '主状态分别为预发布 / 已废弃')
  eq(statusBadges(view).map(badge => badge.text), ['预发布', '已废弃'], '主状态文案正确')
  eq(badgeTexts(view).filter(text => text === '预发布').length, 1, '「预发布」徽标只出现一次（无重复附加徽标）')
  eq(badgeTexts(view).filter(text => text === '已废弃').length, 1, '「已废弃」徽标只出现一次（无重复附加徽标）')
  eq(badgeTexts(view).filter(text => text === 'npm').length, 2, '两行来源徽标都是 npm')
  eq(loaded.state.consoleErrors.length, 0, '主状态唯一渲染没有 console.error', loaded.state.consoleErrors)
}

section('交互：版本豁免入口 → 风险勾选 → 二次确认 → exempt + apply')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: CANDIDATES })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)

  const entry = findClickable(view, text => text.trim() === '版本豁免')
  ok(entry !== null, '不兼容且可豁免的行有「版本豁免」入口', view.texts().slice(-14))
  eq(entry?.props?.['aria-expanded'], 'false', '入口初始 aria-expanded=false')
  eq(findClickable(view, text => text.includes('豁免此版本并更新')), null, '未展开时没有「豁免此版本并更新」按钮')

  entry?.props.onClick()
  await settle(view)
  const ack = findCheckableWithin(view, null)
  ok(ack !== null, '点击入口后出现风险勾选', view.elements().filter(element => element.type === 'input').map(element => element.props?.['aria-label']))
  const firstFlow = findClickable(view, text => text.includes('豁免此版本并更新'))
  ok(firstFlow !== null && firstFlow.props.disabled === true, '未勾选风险时「豁免此版本并更新」是禁用的', firstFlow?.props?.disabled)
  eq(findClickable(view, text => text.trim() === '版本豁免')?.props?.['aria-expanded'], 'true', '展开后入口 aria-expanded=true')

  const ackHandler = typeof ack?.props?.onChange === 'function' ? ack.props.onChange : ack?.props?.onClick
  ackHandler?.({ target: { checked: true }, currentTarget: { checked: true } })
  await settle(view)
  const enabledFlow = findClickable(view, text => text.includes('豁免此版本并更新'))
  ok(enabledFlow !== null && enabledFlow.props.disabled !== true, '勾选风险后按钮可用', enabledFlow?.props?.disabled)

  // 再次点入口收起；重新打开时勾选重置、按钮回到禁用。
  findClickable(view, text => text.trim() === '版本豁免')?.props.onClick()
  await settle(view)
  eq(findClickable(view, text => text.includes('豁免此版本并更新')), null, '再次点击入口可收起风险区')
  findClickable(view, text => text.trim() === '版本豁免')?.props.onClick()
  await settle(view)
  const reopenedAck = findCheckableWithin(view, null)
  eq(reopenedAck?.props?.checked, false, '重新打开时风险勾选已重置')
  eq(findClickable(view, text => text.includes('豁免此版本并更新'))?.props?.disabled, true, '重新打开后按钮回到禁用')

  // 勾选 → 二次确认 → exempt → 自动 apply。
  const reopenHandler = typeof reopenedAck?.props?.onChange === 'function' ? reopenedAck.props.onChange : reopenedAck?.props?.onClick
  reopenHandler?.({ target: { checked: true }, currentTarget: { checked: true } })
  await settle(view)
  findClickable(view, text => text.includes('豁免此版本并更新'))?.props.onClick()
  await settle(view)
  const second = findClickable(view, text => text.trim() === '豁免并更新')
  ok(second !== null, '二次确认弹窗出现', view.texts().slice(-20))
  ok(view.texts().join(' ').includes('再次确认：豁免风险版本'), '弹窗标题是「再次确认：豁免风险版本」', view.texts().slice(-20))
  second?.props.onClick()
  await settle(view, 60)
  const exempt = bridge.calls.find(call => call.url === `${API}/updates/exempt`)
  ok(exempt !== undefined, '确认后 POST /updates/exempt', bridge.calls.map(call => `${call.method} ${call.url}`))
  eq(exempt?.method, 'POST', 'exempt 用 POST')
  eq(exempt?.body?.package, 'demo-plugin-c', 'exempt 带上不兼容包的包名')
  eq(exempt?.body?.version, '3.0.0', 'exempt 带上目标版本')
  eq(exempt?.body?.acceptRisk, true, 'exempt 必须显式 acceptRisk:true')
  eq(exempt?.body?.runtimeVersion, '0.3.9', 'exempt 带上不兼容信息里的 runtimeVersion')
  const apply = bridge.calls.find(call => call.url === `${API}/updates/apply`)
  ok(apply !== undefined, '豁免成功后自动发起更新', bridge.calls.map(call => `${call.method} ${call.url}`))
  ok((apply?.body?.items ?? []).some(item => item.name === 'demo-plugin-c'), 'apply items 含刚豁免的包', apply?.body)
  eq(loaded.state.consoleErrors.length, 0, '豁免交互没有 console.error', loaded.state.consoleErrors)
}


// ---------------------------------------------------------------------------
// 4. 真实 Host 契约：不兼容版本是「对象」，不是 boolean
// ---------------------------------------------------------------------------
// 依据：t1 的 `POST /updates/check` 直接把 `pluginManager.listVersions()` 的
// `version.incompatible` 透传到候选上；DSH 侧（dsh-app-boot `evaluatePluginCompatibility`
// → dsh-plugin-manager `incompatiblePlugin`）给的是
//   { name, version, runtimeVersion, requirements: { 'engines.dsh': '>=x' } }
// 即 requirements 是「要求名 → 范围」的扁平记录，绝不是 `{ dsh, required }`。
// 下面用这份真实形状验证 UI 是否把它当「不兼容」处理。
const REAL_INCOMPATIBLE_CANDIDATE = {
  name: 'incompat-real',
  current: '1.0.0',
  latest: '2.0.0',
  kind: 'npm',
  // Host：只有 prerelease/deprecated 才降级为 skipped；纯不兼容仍是 available。
  state: 'available',
  enabled: true,
  prerelease: false,
  deprecated: null,
  spec: 'incompat-real@1.0.0',
  incompatible: {
    name: 'incompat-real',
    version: '2.0.0',
    runtimeVersion: '0.3.9',
    requirements: { 'engines.dsh': '>=0.4.0 <0.5.0' },
  },
}

section('真实 Host 契约：incompatible 对象 → 不兼容标记与豁免入口')
{
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates: [REAL_INCOMPATIBLE_CANDIDATE] })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)

  const rowText = view.texts().join(' | ')
  ok(badgeTexts(view).includes('不兼容'), '真实 incompatible 对象 → 状态徽标是「不兼容」', badgeTexts(view))
  ok(!badgeTexts(view).includes('可更新'), '状态徽标不再显示为「可更新」', badgeTexts(view))
  ok(/不兼容/u.test(rowText), '行内出现不兼容相关文案', rowText.slice(0, 500))

  // 不兼容行不得进入「更新全部 / 全选」的可安装集合。
  const selectAll = findCheckable(view)
  const handler = typeof selectAll?.props?.onChange === 'function' ? selectAll.props.onChange : selectAll?.props?.onClick
  handler?.({ target: { checked: true }, currentTarget: { checked: true } })
  await settle(view)
  const bulk = findClickable(view, text => text.includes('更新全部'))
  ok(bulk === null || bulk.props?.disabled === true, '不兼容项不被「更新全部」自动勾选（按钮禁用/不出现）', bulk === null ? '按钮不存在' : bulk.props?.disabled)
  if (bulk !== null && bulk.props?.disabled !== true) {
    bulk.props.onClick()
    await settle(view)
    const start = findClickable(view, text => text.trim() === '开始更新')
    start?.props.onClick()
    await settle(view)
    const apply = bridge.calls.find(call => call.url === `${API}/updates/apply`)
    ok(!(apply?.body?.items ?? []).some(item => item.name === 'incompat-real'), 'apply 不含不兼容项（没有豁免前不该尝试安装）', apply?.body)
  }

  // 新行 UI：解释区移除，但保留版本豁免入口；不显示 requirements 详情。
  ok(!/>=0\.4\.0/u.test(view.texts().join(' | ')), '不兼容行不显示 requirements 详情', view.texts().join(' | ').slice(0, 600))
  eq(findClickable(view, text => text.includes('详情')), null, '没有「详情」按钮')
  eq(findClickable(view, text => /展开不兼容原因|收起/u.test(text)), null, '没有「展开不兼容原因/收起」按钮')
  ok(findClickable(view, text => text.trim() === '版本豁免') !== null, '不兼容且可豁免的行有「版本豁免」入口', view.texts().slice(-14))

}

// ---------------------------------------------------------------------------
// 5. 端到端接缝：t1 数据层真的产出什么，client 就吃什么
// ---------------------------------------------------------------------------
/**
 * 用 t1 的真实数据层（lib/updates.js，零依赖）产出一份 /updates 候选数组。
 *
 * 链路与 lib/index.js 完全一致：`checkCandidate(collectCandidates(...))` 的结果写进
 * `checkCache`，再 `collectCandidates({cached})` 得到 `/updates` 的 candidates。
 * @param {{name: string, listing: object}} input - 包名与假 listVersions 返回。
 * @returns {Promise<object[]>} 候选数组。
 */
async function hostCandidates(input) {
  const { checkCandidate, collectCandidates } = await import('../lib/updates.js')
  const bundles = [{
    name: input.name,
    version: '1.0.0',
    enabled: true,
    installed: true,
    official: false,
    availability: 'profile',
    source: `${input.name}@1.0.0`,
    update: 'registry',
    rows: [],
    removable: true,
  }]
  const checked = await checkCandidate(collectCandidates({ bundles })[0], {
    listVersions: async () => input.listing,
    latestGit: () => undefined,
    includePrerelease: false,
  })
  return collectCandidates({ bundles, cached: { [checked.name]: checked }, indexInfo: { hasIndex: true } })
}

section('端到端：t1 数据层产出 → client 渲染（不手写 fixture）')
{
  // 真实 listVersions 形状（DSH incompatiblePlugin）。
  const candidates = await hostCandidates({
    name: 'seam-inc',
    listing: {
      status: 'listed', installed: '1.0.0', registry: null, attempts: [], omitted: 0,
      versions: [{
        version: '2.0.0', tags: [], prerelease: false, bundle: true,
        incompatible: { name: 'seam-inc', version: '2.0.0', runtimeVersion: '0.3.9', requirements: { 'engines.dsh': '>=0.4.0 <0.5.0' } },
      }],
    },
  })
  // 先钉住 Host 产出形状（这是 t1 的契约，也是 t2 的输入）。
  const produced = candidates[0]
  eq(produced?.name, 'seam-inc', 't1 产出的候选包名')
  eq(produced?.state, 'available', 't1 对「仅不兼容」的版本给 state=available（只有预发布/已废弃才降级为 skipped）')
  eq(produced?.incompatible?.runtimeVersion, '0.3.9', 't1 透传 incompatible.runtimeVersion')
  eq(produced?.incompatible?.requirements, { 'engines.dsh': '>=0.4.0 <0.5.0' }, 't1 透传扁平 requirements')

  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)

  const rowText = view.texts().join(' | ')
  ok(badgeTexts(view).includes('不兼容'), 't1 真实产出被渲染成状态徽标「不兼容」', badgeTexts(view))
  ok(/不兼容/u.test(rowText), '行内出现不兼容相关文案', rowText.slice(0, 400))
  const rowCheck = findInputByLabel(view, 'seam-inc')
  ok(rowCheck !== null, '候选行有复选框', view.elements().filter(el => el.type === 'input').map(el => el.props?.['aria-label']))
  eq(rowCheck?.props?.disabled, true, '不兼容行的复选框是禁用的')

  // 新行 UI：名称即详情；解释区已移除；版本豁免入口走完整流程。
  ok(view.elements().some(element => element.type === 'button' && elementText(element).trim() === 'seam-inc'), '端到端：插件名是可点击控件')
  ok(!/>=0\.4\.0/u.test(rowText), '端到端：不显示 requirements 详情', rowText.slice(0, 500))
  const exemptEntry = findClickable(view, text => text.trim() === '版本豁免')
  ok(exemptEntry !== null, '端到端：有「版本豁免」入口', view.texts().slice(-14))
  exemptEntry?.props.onClick()
  await settle(view)
  const ack = findCheckableWithin(view, null)
  ok(ack !== null, '端到端：展开后有风险勾选', view.elements().filter(element => element.type === 'input').map(element => element.props?.['aria-label']))
  const ackHandler = typeof ack?.props?.onChange === 'function' ? ack.props.onChange : ack?.props?.onClick
  ackHandler?.({ target: { checked: true }, currentTarget: { checked: true } })
  await settle(view)
  findClickable(view, text => text.includes('豁免此版本并更新'))?.props.onClick()
  await settle(view)
  const second = findClickable(view, text => text.trim() === '豁免并更新')
  ok(second !== null, '端到端：二次确认弹窗出现', view.texts().slice(-16))
  second?.props.onClick()
  await settle(view, 60)
  const exempt = bridge.calls.find(call => call.url === `${API}/updates/exempt`)
  eq(exempt?.body, { package: 'seam-inc', version: '2.0.0', acceptRisk: true, runtimeVersion: '0.3.9' }, 'exempt 请求体与 t1 真实 incompatibility 完全对齐')
  const apply = bridge.calls.find(call => call.url === `${API}/updates/apply`)
  eq((apply?.body?.items ?? []).map(item => item.name), ['seam-inc'], '豁免后自动 apply 且只含该包')
  eq(loaded.state.consoleErrors.length, 0, '端到端渲染没有 console.error', loaded.state.consoleErrors)

}

section('回归：检查失败 / 无法检查 不被「不兼容」掩盖')
{
  const candidates = [
    { name: 'inc-error', current: '1.0.0', latest: '2.0.0', kind: 'npm', state: 'error', enabled: true, prerelease: false, deprecated: null, spec: 'inc-error@1.0.0', incompatible: { name: 'inc-error', version: '2.0.0', runtimeVersion: '0.3.9', requirements: { 'engines.dsh': '>=0.4.0' } } },
    { name: 'inc-uncheckable', current: '1.0.0', latest: '1.0.0', kind: 'git', state: 'uncheckable', enabled: true, prerelease: false, deprecated: null, spec: `git+https://github.com/acme/uncheck.git#${'b'.repeat(40)}`, incompatible: { name: 'inc-uncheckable', version: '1.0.0', runtimeVersion: '0.3.9', requirements: { 'engines.dsh': '>=0.4.0' } } },
  ]
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates, settings: { updatesShowFailed: true } })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  ok(badgeTexts(view).includes('检查失败'), 'error 行的状态徽标是「检查失败」', badgeTexts(view))
  ok(badgeTexts(view).includes('无法检查'), 'uncheckable 行的状态徽标是「无法检查」', badgeTexts(view))
  eq(badgeTexts(view).filter(text => text === '不兼容'), [], '这两种行都没有「不兼容」徽标')
  ok(!/可更新/u.test(badgeTexts(view).join('|')), '这两种行也不显示「可更新」', badgeTexts(view))
  eq(findClickable(view, text => text.trim() === '版本豁免'), null, '检查失败/无法检查的行不提供「版本豁免」入口')
  eq(findClickable(view, text => text.includes('豁免此版本并更新')), null, '也不出现「豁免此版本并更新」按钮')

  // 全选也不该把它们放进 apply。
  const selectAll = findCheckable(view)
  const handler = typeof selectAll?.props?.onChange === 'function' ? selectAll.props.onChange : selectAll?.props?.onClick
  handler?.({ target: { checked: true }, currentTarget: { checked: true } })
  await settle(view)
  const bulk = findClickable(view, text => text.includes('更新全部'))
  if (bulk !== null && bulk.props?.disabled !== true) {
    bulk.props.onClick()
    await settle(view)
    findClickable(view, text => text.trim() === '开始更新')?.props.onClick()
    await settle(view)
  }
  const apply = bridge.calls.find(call => call.url === `${API}/updates/apply`)
  ok(!(apply?.body?.items ?? []).some(item => item.name === 'inc-error' || item.name === 'inc-uncheckable'), 'apply 不含检查失败/无法检查的行', apply?.body)
  eq(loaded.state.consoleErrors.length, 0, '回归渲染没有 console.error', loaded.state.consoleErrors)
}

section('已废弃：字符串原因是真实契约，界面只用徽标（解释区按需求移除）')
{
  const candidates = await hostCandidates({
    name: 'dep-seam',
    listing: {
      status: 'listed', installed: '1.0.0', registry: null, attempts: [], omitted: 0,
      versions: [{ version: '1.5.0', tags: [], prerelease: false, deprecated: '已不再维护，请改用 dep-seam-next', bundle: true }],
    },
  })
  eq(candidates[0]?.state, 'skipped', 't1 对已废弃目标给 state=skipped（显示但不勾选）')
  eq(candidates[0]?.deprecated, '已不再维护，请改用 dep-seam-next', 't1 透传 deprecated 字符串原因')

  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const bridge = makeBridge({ candidates })
  loaded.state.responses = (url, init) => bridge(url, init)
  const t = ctx.locale.bind()
  const view = render(tab.component, { t, openPackage: () => {} })
  await settle(view)
  ok(badgeTexts(view).includes('已废弃'), '已废弃行状态徽标是「已废弃」', badgeTexts(view))
  ok(!/已不再维护/u.test(view.texts().join(' | ')), '页面不显示废弃原因文本（解释区已移除）', view.texts().slice(0, 500))
  eq(findClickable(view, text => /展开|收起/u.test(text)), null, '已废弃行没有展开入口')
  eq(loaded.state.consoleErrors.length, 0, '已废弃渲染没有 console.error', loaded.state.consoleErrors)
}


section('失联提示：连续 3 次轮询失败后停止并提示重启，恢复后清除')
{
  const info = loaded.exports.inspectable()
  eq(info.lostThreshold, 3, 'inspectable 暴露失联阈值 3')
  eq(typeof info.nextPollFailure, 'function', 'inspectable 暴露 nextPollFailure（纯函数）')
  // 纯函数复算：1→2→3 才判定失联。
  if (typeof info.nextPollFailure === 'function') {
    eq(info.nextPollFailure(0), { count: 1, lost: false }, '第 1 次失败：未失联')
    eq(info.nextPollFailure(1), { count: 2, lost: false }, '第 2 次失败：未失联')
    eq(info.nextPollFailure(2), { count: 3, lost: true }, '第 3 次失败：判定失联')
    eq(info.nextPollFailure(3).lost, true, '继续失败仍是失联')
    eq(info.nextPollFailure(undefined), { count: 1, lost: false }, '缺省计数按 0 起算')
  }

  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const runningState = {
    ok: true,
    running: true,
    stopped: false,
    finished: false,
    summary: { total: 1, success: 0, failed: 0, cancelled: 0, pending: 1 },
    active: 'demo-plugin-a',
    activeRequestId: 'req-1',
    items: [{ name: 'demo-plugin-a', current: '1.2.0', latest: '1.4.2', version: '1.4.2', kind: 'npm', requestId: 'req-1', stage: 'installing', success: false, failed: false, restartRequired: false, cancelled: false, error: null, restore: null }],
    logs: [],
  }
  // 只推进本用例新建的定时器：先清空历史 section 留下的登记，再渲染。
  loaded.state.intervals.length = 0
  const bridge = makeBridge({ candidates: CANDIDATES, running: true, stateSequence: [runningState], stateFailures: 3 })
  loaded.state.responses = (url, init) => bridge(url, init)
  const view = render(tab.component, { t: ctx.locale.bind(), openPackage: () => {} })
  await settle(view)
  const liveIntervals = () => loaded.state.intervals.filter(fn => typeof fn === 'function')
  ok(liveIntervals().length >= 1, '检测到 running 后开始轮询', loaded.state.intervals.length)

  /**
   * 推进一次轮询（等价于 POLL_MS 到点）并重渲染。
   * @returns {Promise<void>} 完成。
   */
  const tick = async () => {
    for (const interval of [...liveIntervals()]) interval()
    await settle(view)
  }
  await tick()
  const afterFirst = view.texts().join(' | ')
  ok(afterFirst.includes('进度状态读取失败'), '第 1 次失败提示「进度状态读取失败（可重试）」', afterFirst.slice(0, 300))
  ok(!afterFirst.includes('DSH 已退出或正在重启'), '第 1 次失败还不会显示失联文案', afterFirst.slice(0, 300))
  await tick()
  await tick()
  const afterLost = view.texts().join(' | ')
  ok(afterLost.includes('DSH 已退出或正在重启，请重新启动后继续'), '连续 3 次失败后显示失联文案', afterLost.slice(0, 400))
  ok(!afterLost.includes('进度状态读取失败'), '失联后不再刷「进度状态读取失败（可重试）」', afterLost.slice(0, 400))
  eq(liveIntervals().length, 0, '失联后停止轮询（定时器已清）', loaded.state.intervals)
  ok(view.elements().some(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-lost')), '失联提示用 .pmu-lost 样式', view.elements().filter(element => String(element.props?.className ?? '').includes('pmu-notice')).map(element => element.props?.className))

  // 连接恢复：手动「检查更新」成功后清除失联提示。
  findClickable(view, text => text.trim() === '检查更新')?.props.onClick()
  await settle(view, 60)
  ok(!view.texts().join(' | ').includes('DSH 已退出或正在重启'), '连接恢复后失联提示被清除', view.texts().slice(0, 400))
  eq(loaded.state.consoleErrors.length, 0, '失联用例没有 console.error', loaded.state.consoleErrors)
}

section('重启提示：restartRequired > 0 时提示重启，但不自动重启')
{
  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const finishedState = {
    ok: true,
    running: false,
    stopped: false,
    finished: true,
    summary: { total: 3, success: 3, failed: 0, cancelled: 0, restartRequired: 2, skipped: 0, pending: 0 },
    active: null,
    activeRequestId: null,
    items: [
      { name: 'demo-plugin-a', current: '1.2.0', latest: '1.4.2', version: '1.4.2', kind: 'npm', requestId: 'req-1', stage: 'done', success: true, failed: false, restartRequired: true, cancelled: false, error: null, restore: null },
      { name: 'demo-plugin-b', current: '0.9.1', latest: '1.0.0', version: '1.0.0', kind: 'git', requestId: 'req-2', stage: 'done', success: true, failed: false, restartRequired: true, cancelled: false, error: null, restore: null },
      { name: 'demo-plugin-c', current: '2.0.0', latest: '3.0.0', version: '3.0.0', kind: 'npm', requestId: 'req-3', stage: 'done', success: true, failed: false, restartRequired: false, cancelled: false, error: null, restore: null },
    ],
    logs: [],
  }
  loaded.state.intervals.length = 0
  const bridge = makeBridge({ candidates: CANDIDATES, running: true, stateSequence: [finishedState] })
  loaded.state.responses = (url, init) => bridge(url, init)
  const view = render(tab.component, { t: ctx.locale.bind(), openPackage: () => {} })
  await settle(view)
  for (const interval of [...loaded.state.intervals.filter(fn => typeof fn === 'function')]) interval()
  await settle(view, 60)

  const joined = view.texts().join(' | ')
  ok(joined.includes('2 项已更新，重启 DSH 后生效'), 'restartRequired=2 时显示「2 项已更新，重启 DSH 后生效」', joined.slice(0, 500))
  ok(view.elements().some(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-restartNotice')), '重启提示用 .pmu-restartNotice 样式', view.elements().filter(element => String(element.props?.className ?? '').includes('pmu-notice')).map(element => element.props?.className))
  // 不自动重启、不杀进程：结束时只有 GET，没有写请求，也没有「重启」按钮。
  const writes = bridge.calls.filter(call => call.method !== 'GET').map(call => call.url)
  eq(writes, [], '结束时不发任何写请求（不自动重启/不杀进程）', bridge.calls.map(call => `${call.method} ${call.url}`))
  eq(findClickable(view, text => /^重启( DSH)?$/u.test(text.trim())), null, '没有「重启」按钮')

  // restartRequired=0 时不显示该提示。
  const noRestartState = { ...finishedState, summary: { total: 1, success: 1, failed: 0, cancelled: 0, restartRequired: 0, skipped: 0, pending: 0 }, items: [finishedState.items[2]] }
  loaded.state.intervals.length = 0
  const bridge2 = makeBridge({ candidates: CANDIDATES, running: true, stateSequence: [noRestartState] })
  loaded.state.responses = (url, init) => bridge2(url, init)
  const view2 = render(tab.component, { t: ctx.locale.bind(), openPackage: () => {} })
  await settle(view2)
  for (const interval of [...loaded.state.intervals.filter(fn => typeof fn === 'function')]) interval()
  await settle(view2, 60)
  ok(!view2.texts().join(' | ').includes('重启 DSH 后生效'), 'restartRequired=0 时不显示重启提示', view2.texts().slice(0, 400))
  eq(loaded.state.consoleErrors.length, 0, '重启提示用例没有 console.error', loaded.state.consoleErrors)
}

section('中断恢复区块：渲染 / 重新安装与忽略载荷 / 成功后移除')
{
  const info = loaded.exports.inspectable()
  eq(typeof info.readInterrupted, 'function', 'inspectable 暴露 readInterrupted（纯函数）')
  const interruptedRecords = [
    { name: 'rec-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-npm', phase: 'installing', startedAt: 1_700_000_000_000 },
    { name: 'rec-git', current: '1.0.0', target: '1.1.0', kind: 'git', spec: 'git+https://github.com/acme/demo-git.git#' + 'b'.repeat(40), requestId: 'req-git', phase: 'removing', startedAt: 1_700_000_001_000 },
  ]
  eq(info.readInterrupted?.(interruptedRecords).map(record => record.name), ['rec-npm', 'rec-git'], 'readInterrupted 归一两条记录')
  eq(info.readInterrupted?.(undefined), [], 'readInterrupted(undefined) = []')
  eq(info.readInterrupted?.([{ name: '' }]), [], 'readInterrupted 丢掉没有包名的坏记录')

  const tab = loaded.state.registrations.find(entry => entry.descriptor.id === 'pluginmarket-plus-updates')
  /**
   * 在某个容器元素里按文案找按钮。
   * @param {object} container - 宿主元素。
   * @param {string} label - 按钮文案。
   * @returns {object|null} 按钮。
   */
  const buttonIn = (container, label) => {
    if (container === undefined) return null
    return collectElements(container).find(element => element.type === 'button' && elementText(element).trim() === label) ?? null
  }
  const headOf = (view) => view.elements().find(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-interruptedHead'))
  const rowsOf = (view) => view.elements().filter(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-interruptedRow'))

  let current = interruptedRecords
  const bridge = makeBridge({ candidates: CANDIDATES, interrupted: () => current, onRecover: (next) => { current = next } })
  loaded.state.responses = (url, init) => bridge(url, init)
  const ctx = makePluginContext(loaded.state)
  loaded.exports.apply(ctx)
  const view = render(tab.component, { t: ctx.locale.bind(), openPackage: () => {} })
  await settle(view)

  const joined = view.texts().join(' | ')
  ok(joined.includes('上次更新中断'), '渲染「上次更新中断」标题', joined.slice(0, 400))
  ok(joined.includes('2 项没装完'), '显示「2 项没装完」说明', joined.slice(0, 400))
  ok(view.elements().some(element => String(element.props?.className ?? '').split(/\s+/u).includes('pmu-interrupted')), '区块用 .pmu-interrupted 样式')
  ok(joined.includes('rec-npm') && joined.includes('rec-git'), '逐行显示包名', joined.slice(0, 500))
  ok(joined.includes('1.0.0 → 2.0.0'), '显示当前 → 目标版本', joined.slice(0, 500))
  ok(joined.includes('npm') && joined.includes('git'), '显示来源徽标（npm / git）')
  ok(buttonIn(headOf(view), '重新安装') !== null, '区块头部有整批「重新安装」按钮', elementText(headOf(view) ?? {}).slice(0, 200))
  ok(findClickable(view, text => text.trim() === '忽略') !== null, '有「忽略」按钮', view.texts().slice(0, 400))
  eq(rowsOf(view).length, 2, '两行中断记录')

  // 单行重新安装：{items:[{name}]}。
  const gitRow = rowsOf(view).find(row => elementText(row).includes('rec-git'))
  ok(gitRow !== undefined, '找到 rec-git 那一行', rowsOf(view).map(row => elementText(row)))
  ok(buttonIn(gitRow, '重新安装') !== null, '中断行内有单行「重新安装」按钮', gitRow === undefined ? undefined : elementText(gitRow))
  buttonIn(gitRow, '重新安装')?.props.onClick()
  await settle(view, 60)
  const singleCall = bridge.calls.find(call => call.url === `${API}/updates/recover`)
  eq(singleCall?.body, { items: [{ name: 'rec-git' }] }, '单行重新安装发 {items:[{name}]}')

  // 整批重新安装：{}。
  const before = bridge.calls.filter(call => call.url === `${API}/updates/recover`).length
  buttonIn(headOf(view), '重新安装')?.props.onClick()
  await settle(view, 60)
  const bulkCall = bridge.calls.filter(call => call.url === `${API}/updates/recover`)[before]
  eq(bulkCall?.body, {}, '整批重新安装发 {}')

  // 全部成功 → 区块消失并给反馈。
  // 注意：单行恢复已摘掉 rec-git，整批只剩 rec-npm 一项，所以反馈是「已重新安装 1 项」。
  ok(!view.texts().join(' | ').includes('上次更新中断'), '全部恢复成功后区块消失', view.texts().slice(0, 400))
  ok(view.texts().join(' | ').includes('已重新安装 1 项'), '给出「已重新安装 N 项」反馈（单行+整批共处理完 2 项）', view.texts().slice(0, 400))
  eq(bridge.calls.filter(call => call.url === `${API}/updates/recover`).length, 2, '单行 + 整批各发一次 recover')
  eq(current, [], '恢复完成后残留为空', current)

  // 失败项保留并显示原因。
  current = [
    { name: 'rec-npm', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'req-npm', phase: 'installing', startedAt: 1_700_000_000_000 },
    { name: 'boom-npm', current: '1.0.0', target: '9.9.9', kind: 'npm', requestId: 'req-boom', phase: 'installing', startedAt: 1_700_000_002_000 },
  ]
  const bridge2 = makeBridge({ candidates: CANDIDATES, interrupted: () => current, onRecover: (next) => { current = next }, recoverOutcomes: { 'boom-npm': { ok: false, error: '目标版本不存在' } } })
  loaded.state.responses = (url, init) => bridge2(url, init)
  const view2 = render(tab.component, { t: ctx.locale.bind(), openPackage: () => {} })
  await settle(view2)
  buttonIn(headOf(view2), '重新安装')?.props.onClick()
  await settle(view2, 60)
  const joined2 = view2.texts().join(' | ')
  ok(joined2.includes('boom-npm'), '失败项保留在区块里', joined2.slice(0, 500))
  ok(joined2.includes('目标版本不存在'), '失败项显示原因', joined2.slice(0, 500))
  ok(!joined2.includes('rec-npm'), '成功项从区块移除', joined2.slice(0, 500))
  ok(joined2.includes('已重新安装 1 项，1 项失败'), '给出部分成功反馈', joined2.slice(0, 500))

  // 忽略：POST /updates/clear-interrupted {}，区块消失。
  findClickable(view2, text => text.trim() === '忽略')?.props.onClick()
  await settle(view2, 60)
  eq(bridge2.calls.find(call => call.url === `${API}/updates/clear-interrupted`)?.body, {}, '忽略发 POST /updates/clear-interrupted {}')
  ok(!view2.texts().join(' | ').includes('上次更新中断'), '忽略后区块消失', view2.texts().slice(0, 400))
  ok(view2.texts().join(' | ').includes('已忽略'), '忽略后给出反馈', view2.texts().slice(0, 400))
  eq(loaded.state.consoleErrors.length, 0, '中断恢复用例没有 console.error', loaded.state.consoleErrors)
}


// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n=== t3 客户端装载与渲染冒烟：${passed} 项通过，${failed.length} 项失败 ===`)
if (failed.length > 0) {
  console.error('\n失败明细（含最小复现线索）：')
  for (const entry of failed) {
    console.error(`✗ [${entry.section}] ${entry.label}${entry.detail === undefined ? '' : `\n    ${entry.detail}`}`)
  }
  process.exit(1)
}
console.log('全部通过。')
process.exit(0)
