/**
 * 「可更新」纯数据层：候选收集、检查结果合并、顺序更新队列。
 *
 * 这里只处理数据，不碰 Cordis 服务，也不发网络请求：
 *
 * - 候选收集（{@link collectCandidates}）只用 `pluginManager.listBundles()` 的结果加本插件缓存
 *   的市场索引，按方案 §4 的规则决定哪些 bundle 能出现在「可更新」列表里。
 * - 检查（{@link checkCandidate}）注入两个数据源：npm 包走 `listVersions()`，
 *   Git 包走本地索引里该包最新版本的 `source.commit`。
 * - 队列（{@link createUpdateQueue}）是纯状态机，执行动作由调用方注入，便于单测。
 *
 * 方案见 `docs/05-updates-tab-plan.md` §3 / §4 / §6 / §7。
 *
 * @module dsh-pluginmarket-plus/lib/updates
 */

/** 队列项的阶段（写进 `/updates/state` 的 `items[].stage`）。 */
export const STAGES = [
  /** 已入队，还没轮到。 */
  'queued',
  /** 正在检查目标版本是否可装。 */
  'checking',
  /** 正在移除已安装版本（`plugin-manager/update-state` 的 removing）。 */
  'removing',
  /** 正在安装目标版本。 */
  'installing',
  /** 目标失败后正在装回旧版本。 */
  'restoring',
  /** 成功（未必已生效，看 `restartRequired`）。 */
  'done',
  /** 失败（`pluginManager.updateBundle` 抛错或返回值不可读）。 */
  'failed',
  /** 被取消；正在跑的那一项走后端取消流程后落到这里。 */
  'cancelled',
]

/**
 * `plugin-manager/update-state` 的 step → 队列阶段。
 * @type {Record<string, string>}
 */
export const UPDATE_STEP_STAGE = {
  checking: 'checking',
  removing: 'removing',
  installing: 'installing',
  restoring: 'restoring',
}

// --- 版本比较（只用 Node 内置模块，自己实现 SemVer 比较）------------------------

/** 严格的 SemVer 解析：`major.minor.patch[-prerelease][+build]`。 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

/**
 * 解析一个版本号。
 * @param {unknown} value - 候选版本字符串。
 * @returns {{major: number, minor: number, patch: number, pre: string[]}|undefined} 解析结果；非法版本返回 undefined。
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined
  const match = SEMVER.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * 比较两个版本号（SemVer 2.0.0 的优先级规则，忽略 build 元数据）。
 * @param {string} left - 左版本。
 * @param {string} right - 右版本。
 * @returns {number} 左大于右为 1，小于为 -1，相等为 0。
 * @throws {TypeError} 任一侧不是合法版本时抛出（调用方应先用 {@link parseVersion} 判断）。
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) throw new TypeError(`不是合法的 semver 版本：${String(left)} / ${String(right)}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  // 有先行版本号的版本低于同号正式版。
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index++) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numericX = /^\d+$/u.test(x)
    const numericY = /^\d+$/u.test(y)
    if (numericX && numericY) return Number(x) > Number(y) ? 1 : -1
    // 数字标识符的优先级永远低于字母数字标识符。
    if (numericX !== numericY) return numericX ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

/**
 * 一个版本是否带先行版本号（预发布）。
 * @param {unknown} value - 版本号。
 * @returns {boolean} 是预发布为 true。
 */
export function isPrerelease(value) {
  const parsed = parseVersion(value)
  return parsed !== undefined && parsed.pre.length > 0
}

// --- Git spec 解析 --------------------------------------------------------------

/** 完整提交（小写或大写 40 位十六进制）。 */
const FULL_COMMIT = /^[0-9a-f]{40}$/iu
/** 带 scp 形式的 git 地址，例如 `git@github.com:owner/repo.git`。 */
const SCP_GIT = /^git@([^:]+):(.+)$/iu
/** `host/owner/repo` 简写。 */
const SHORTHAND_HOSTS = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', gist: 'gist.github.com' }

/**
 * 解析 `git+<url>#<commit>[&path:/dir]` 形态的 spec。
 *
 * 只有固定 40 位 commit 的 Git spec 才算得上「可更新」：分支、标签、范围、
 * `github:owner/repo` 简写都无法在更新失败时装回原来的版本（方案 §3）。
 * @param {unknown} spec - 已安装副本的 spec（`BundleInfo.source`）。
 * @returns {{host: string, path: string, repository: string, commit: string, spec: string}|undefined} 解析结果；不是固定 commit 的 Git spec 时 undefined。
 */
export function parseGitSpec(spec) {
  if (typeof spec !== 'string') return undefined
  const trimmed = spec.trim()
  const hash = trimmed.indexOf('#')
  if (hash === -1) return undefined
  const location = trimmed.slice(0, hash)
  const parameters = trimmed.slice(hash + 1).split('&')
  const paths = parameters.filter(part => part.startsWith('path:'))
  const others = parameters.filter(part => !part.startsWith('path:'))
  // pnpm 取重复参数里最后一个，重复的 path: 或多余参数都不指向唯一仓库目录。
  if (paths.length > 1 || others.length !== 1 || !FULL_COMMIT.test(others[0])) return undefined
  const parsed = parseGitLocation(location)
  if (parsed === undefined) return undefined
  const path = (paths[0] ?? '').slice('path:'.length).replace(/^\/+|\/+$/gu, '')
  return {
    host: parsed.host,
    path,
    repository: parsed.repository,
    commit: /** @type {string} */ (others[0]).toLowerCase(),
    spec: trimmed,
  }
}

/**
 * 从一个 git 地址里取出主机与仓库路径（去掉传输方式、用户信息、`.git` 后缀、大小写差异）。
 * @param {string} location - 例如 `git+https://github.com/owner/repo.git`。
 * @returns {{host: string, repository: string}|undefined} 解析结果。
 */
function parseGitLocation(location) {
  const scp = SCP_GIT.exec(location)
  if (scp !== null) {
    return { host: scp[1].toLowerCase(), repository: normalizeRepository(scp[2]) }
  }
  let text = location.replace(/^github:/iu, `${SHORTHAND_HOSTS.github}/`)
    .replace(/^gitlab:/iu, `${SHORTHAND_HOSTS.gitlab}/`)
    .replace(/^bitbucket:/iu, `${SHORTHAND_HOSTS.bitbucket}/`)
    .replace(/^gist:/iu, `${SHORTHAND_HOSTS.gist}/`)
  text = text.replace(/^git\+/iu, '')
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    // github:owner/repo 形式没有协议头。
    if (!/^[^/\s]+\/[^/\s]+/u.test(text)) return undefined
    text = `https://${text}`
  }
  let url
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.host === '') return undefined
  return { host: url.host.toLowerCase(), repository: normalizeRepository(`${url.pathname}${url.search}`) }
}

/**
 * 归一化仓库路径：去掉首尾斜杠与 `.git` 后缀，去掉查询串。
 * @param {string} value - 原始路径。
 * @returns {string} 归一化后的 `owner/repo[/dir]`。
 */
function normalizeRepository(value) {
  return value.split('?')[0].replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '').replace(/\/+$/gu, '')
}

/**
 * 索引里一条 Git 版本的来源，转成可比较的形态。
 * @param {{url?: unknown, commit?: unknown, path?: unknown}} source - 索引版本的 `source`。
 * @returns {{host: string, repository: string, path: string, commit: string}|undefined} 归一化结果。
 */
export function normalizeIndexGitSource(source) {
  if (source === null || typeof source !== 'object') return undefined
  const url = typeof source.url === 'string' ? source.url : undefined
  const commit = typeof source.commit === 'string' ? source.commit.toLowerCase() : undefined
  if (url === undefined || commit === undefined || !FULL_COMMIT.test(commit)) return undefined
  const parsed = parseGitLocation(url)
  if (parsed === undefined) return undefined
  const path = typeof source.path === 'string' ? source.path.replace(/^\/+|\/+$/gu, '') : ''
  return { host: parsed.host, repository: parsed.repository, path, commit }
}

/**
 * 构造 Git 包的更新 spec。
 *
 * 必须与已安装副本的**仓库和子目录一致**、且固定 full commit，否则 `updateBundle` 会拒绝。
 * @param {{repository: string, host: string, path: string}} origin - 已安装副本的仓库目录。
 * @param {string} commit - 目标提交。
 * @returns {string} `git+https://<host>/<repository>.git#<commit>[&path:/<path>]`。
 */
export function buildGitSpec(origin, commit) {
  const base = `git+https://${origin.host}/${origin.repository}.git#${commit}`
  return origin.path === '' ? base : `${base}&path:/${origin.path}`
}

// --- 候选收集 ------------------------------------------------------------------

/**
 * 索引里某一条版本的来源与发布时间（`collectCandidates` 只用到这两项）。
 * @typedef {object} IndexVersion
 * @property {string} version
 * @property {'npm'|'git'} type
 * @property {number} [publishTimestamp]
 * @property {{url: string, path: string, commit: string, host: string, repository: string}} [git]
 */

/**
 * 该 bundle 是否带插件管理组件（`listBundles()` 会用 `readOnlyReason` 标出来）。
 * @param {Record<string, unknown>} bundle - `BundleInfo`。
 * @returns {boolean} 带插件管理为 true。
 */
export function hasPluginManagement(bundle) {
  if (bundle.readOnlyReason !== undefined) return true
  // 极老或测试用的形态：patch 行里直接出现插件管理模块。
  const rows = Array.isArray(bundle.rows) ? bundle.rows : []
  return rows.some(row => row !== null && typeof row === 'object'
    && /(?:^|[-/])(?:dsh-)?plugin-manager(?:$|[-/])/u.test(String(/** @type {Record<string, unknown>} */ (row).moduleName ?? '')))
}

/**
 * 读取 bundle 的 spec（`BundleInfo.source` 在实现里可缺省）。
 * @param {Record<string, unknown>} bundle - `BundleInfo`。
 * @returns {string|undefined} spec。
 */
function sourceOf(bundle) {
  return typeof bundle.source === 'string' && bundle.source.trim() !== '' ? bundle.source : undefined
}

/**
 * 判定一个 `listBundles()` 条目能否出现在「可更新」列表里，以及它的更新类型。
 *
 * 与方案 §4 一一对应：
 *
 * - `official === true`、`installed !== true`、`availability !== 'profile'`、无 `source`、
 *   带插件管理组件 → 一律不显示（官方自带 bundle 跟随 DSH 版本升级）。
 * - `update` 字段缺失 → 不显示；它由 `pluginManager` 的 `updateRefusal()` 计算，
 *   已经把 `link:` / `file:` / `npm:` 别名 / 未固定 commit 的 Git / 非自有 registry spec
 *   全都挡在外面。这里再显式判一遍同样的规则，避免上游形态变化时静默放行。
 * @param {Record<string, unknown>} bundle - `BundleInfo`。
 * @returns {{kind: 'npm'|'git', name: string, current: string, enabled: boolean, spec?: string, origin?: {host: string, repository: string, path: string, commit: string}}|{reason: string}} 可更新目标，或拒绝原因。
 */
export function classifyBundle(bundle) {
  const name = typeof bundle.name === 'string' ? bundle.name : ''
  if (name === '') return { reason: 'no-name' }
  if (bundle.official === true) return { reason: 'official' }
  if (bundle.installed !== true) return { reason: 'not-installed' }
  if (bundle.availability !== undefined && bundle.availability !== 'profile') return { reason: `availability:${String(bundle.availability)}` }
  if (hasPluginManagement(bundle)) return { reason: 'plugin-management' }
  const spec = sourceOf(bundle)
  if (spec === undefined) return { reason: 'no-source' }
  // pluginManager 的 BundleInfo.update 是 'registry' | 'git'；对外契约统一用 'npm' | 'git'。
  const updateKind = bundle.update
  if (updateKind !== 'registry' && updateKind !== 'git') return { reason: 'not-updatable' }
  const kind = updateKind === 'registry' ? 'npm' : 'git'
  const current = typeof bundle.version === 'string' ? bundle.version : ''
  if (current === '') return { reason: 'no-version' }
  const enabled = bundle.enabled === true
  if (kind === 'npm') {
    // 必须是「用自身包名的 registry spec」：`npm:` 别名会把别的包装成这个名字。
    if (/^npm:/u.test(spec) || /^[a-z][a-z0-9+.-]*:/iu.test(spec)) return { reason: 'not-own-name-registry-spec' }
    const at = spec.indexOf('@', 1)
    const specName = at === -1 ? spec : spec.slice(0, at)
    const range = at === -1 ? undefined : spec.slice(at + 1)
    if (specName !== name) return { reason: 'not-own-name-registry-spec' }
    if (range !== undefined && range.includes(':')) return { reason: 'not-own-name-registry-spec' }
    return { kind, name, current, enabled, spec }
  }
  const git = parseGitSpec(spec)
  if (git === undefined) return { reason: 'unpinned-git-spec' }
  return { kind, name, current, enabled, spec, origin: { host: git.host, repository: git.repository, path: git.path, commit: git.commit } }
}

/**
 * 收集候选（只读：缓存索引 + `listBundles()`，不联网）。
 *
 * `latest` / `incompatible` / `prerelease` / `deprecated` 来自上一次检查的缓存结果
 * （`POST /updates/check` 写入），没有缓存时 `latest` 为 null、`state` 为 `unknown`。
 * 没有任何更高版本的候选（`state === 'current'`）会被剔除。
 *
 * @param {object} input - 输入。
 * @param {Record<string, unknown>[]} input.bundles - `pluginManager.listBundles()` 的结果。
 * @param {string[]} [input.indexSignatures] - 已缓存索引的签名（仅用于让结果可解释，可为空）。
 * @param {Record<string, {latest?: string|null, incompatible?: unknown, prerelease?: boolean, deprecated?: string}>|undefined} [input.cached] - 上一次检查的结果，按包名索引。
 * @param {{hasIndex?: boolean}} [input.indexInfo] - 本地索引是否可用；不可用时 Git 候选标 `uncheckable`。
 * @param {boolean} [input.includeDisabled] - 含已禁用的插件（设置开关，默认关）。
 * @param {boolean} [input.includePrerelease] - 含预发布/已废弃版本（设置开关，默认关）。
 * @returns {object[]} 候选数组。
 */
export function collectCandidates(input) {
  const bundles = Array.isArray(input.bundles) ? input.bundles : []
  const cached = input.cached ?? {}
  const indexInfo = input.indexInfo ?? {}
  const includeDisabled = input.includeDisabled === true
  const includePrerelease = input.includePrerelease === true
  const candidates = []
  for (const bundle of bundles) {
    if (bundle === null || typeof bundle !== 'object') continue
    const classified = classifyBundle(bundle)
    if (classified.kind === undefined) continue
    if (classified.enabled === false && !includeDisabled) continue
    const previous = cached[classified.name]
    const previousState = typeof previous?.state === 'string' ? previous.state : undefined
    // 检查缓存里的终态优先：已是最新的不再出现；检查失败/不可检查的原样保留，不能回落成 unknown。
    if (previousState === 'current') continue
    const latest = typeof previous?.latest === 'string' && previous.latest !== '' ? previous.latest : null
    let state
    if (previousState === 'error') {
      state = 'error'
    } else if (previousState === 'uncheckable') {
      state = 'uncheckable'
    } else {
      state = latest === null ? 'unknown' : 'available'
      if (latest !== null && classified.kind === 'npm') {
        try {
          if (compareVersions(latest, classified.current) <= 0) state = 'current'
        } catch {
          state = 'unknown'
        }
      }
    }
    if (state === 'current') continue
    const prerelease = previous?.prerelease === true || (latest !== null && isPrerelease(latest))
    const deprecated = typeof previous?.deprecated === 'string' && previous.deprecated !== '' ? previous.deprecated : null
    if (state === 'available' && (prerelease || deprecated !== null) && !includePrerelease) {
      // 目标版本是预发布/已废弃：开关关着时降级为「暂不推荐」，仍显示但不勾选。
      state = 'skipped'
    }
    let reason = typeof previous?.reason === 'string' && previous.reason !== '' ? previous.reason : null
    if (classified.kind === 'git' && indexInfo.hasIndex !== true && state !== 'error') {
      // 本地没有索引：Git 包无法比提交，标记不可检查并把原因给界面。
      state = 'uncheckable'
      if (reason === null) reason = 'index-miss'
    }
    candidates.push({
      name: classified.name,
      current: classified.current,
      latest,
      kind: classified.kind,
      state,
      enabled: classified.enabled,
      incompatible: previous?.incompatible ?? null,
      prerelease,
      deprecated,
      // 检查失败/不可检查的原因：界面「检查失败」筛选与展开详情都依赖它。
      error: typeof previous?.error === 'string' && previous.error !== '' ? previous.error : null,
      reason,
      ...classified.spec === undefined ? {} : { spec: classified.spec },
      ...classified.kind === 'git' ? { origin: classified.origin } : {},
    })
  }
  return candidates
}

// --- 检查 ----------------------------------------------------------------------

/**
 * 从索引版本列表里挑指定仓库目录的最新 Git 提交。
 * @param {IndexVersion[]} versions - 该包在索引里的版本（可以来自多份索引的合并结果）。
 * @param {{host: string, repository: string, path: string}} origin - 已安装副本的仓库目录。
 * @returns {{commit: string, version: string}|undefined} 最新提交；没有匹配的仓库目录时 undefined。
 */
export function latestGitFromIndex(versions, origin) {
  let best
  for (const version of versions) {
    if (version === null || typeof version !== 'object' || version.type !== 'git' || version.git === undefined) continue
    if (version.git.host !== origin.host || version.git.repository !== origin.repository) continue
    if (version.git.path !== origin.path) continue
    if (best === undefined || isGreaterVersion(version, best)) best = { commit: version.git.commit, version: version.version, publishTimestamp: version.publishTimestamp ?? 0 }
  }
  return best
}

/**
 * 两条索引版本里，`candidate` 是否比 `best` 更新。
 *
 * 索引版本按 semver 降序排列，正常情况下第一条就是最新；同一版本的多个提交、
 * 或 semver 不可比时用发布时间兜底，保证总有一个确定答案。
 * @param {IndexVersion} candidate - 待比较的版本。
 * @param {{commit: string, version: string, publishTimestamp?: number}} best - 当前最佳。
 * @returns {boolean} 候选更新时为 true。
 */
function isGreaterVersion(candidate, best) {
  if (candidate.git === undefined) return false
  if (candidate.git.commit === best.commit) return false
  const left = parseVersion(candidate.version)
  const right = parseVersion(best.version)
  if (left !== undefined && right !== undefined) {
    try {
      const compare = compareVersions(candidate.version, best.version)
      if (compare !== 0) return compare > 0
    } catch {
      // 落到发布时间比较。
    }
  }
  return (candidate.publishTimestamp ?? 0) > (best.publishTimestamp ?? 0)
}

/**
 * 检查一个候选的目标版本。
 *
 * npm 包：`listVersions()` 是权威来源（含兼容性、标签、废弃标记）；
 * Git 包：从本地索引里该仓库目录的最新 `source.commit` 解析，索引里没有该包时标记不可检查。
 *
 * @param {object} candidate - {@link collectCandidates} 返回的候选。
 * @param {object} dependencies - 注入的数据源。
 * @param {(name: string) => Promise<unknown>} dependencies.listVersions - `pluginManager.listVersions`。
 * @param {(name: string, origin: {host: string, repository: string, path: string}) => {commit: string, version: string}|undefined} dependencies.latestGit - 从本地索引解析最新提交。
 * @param {boolean} [dependencies.includePrerelease] - 含预发布/已废弃版本。
 * @returns {Promise<object>} 检查结果（可直接合并进候选与 `/updates` 响应）。
 */
export async function checkCandidate(candidate, dependencies) {
  const includePrerelease = dependencies.includePrerelease === true
  if (candidate === null || typeof candidate !== 'object' || typeof candidate.name !== 'string') {
    return { name: '', state: 'error', latest: null, error: 'invalid-candidate' }
  }
  const base = {
    name: candidate.name,
    current: typeof candidate.current === 'string' ? candidate.current : '',
    kind: candidate.kind === 'git' ? 'git' : 'npm',
  }
  try {
    if (base.kind === 'git') {
      if (candidate.origin === undefined) {
        return { ...base, state: 'uncheckable', latest: null, reason: 'unpinned-git-spec' }
      }
      const found = dependencies.latestGit(candidate.name, candidate.origin)
      if (found === undefined) {
        return { ...base, state: 'uncheckable', latest: null, reason: 'index-miss' }
      }
      const current = typeof candidate.current === 'string' ? candidate.current : ''
      // 提交不同就算有更新：索引里版本号没变也可能推了新提交（内容不同）。
      if (found.commit === candidate.origin.commit) return { ...base, state: 'current', latest: null, commit: found.commit }
      return {
        ...base,
        state: 'available',
        // Git 包的目标是提交；版本号只是给界面看的（真正安装的是 `spec` 里固定的 commit）。
        latest: found.version,
        commit: found.commit,
        spec: buildGitSpec(candidate.origin, found.commit),
        incompatible: null,
        prerelease: false,
        deprecated: null,
      }
    }
    const listing = await dependencies.listVersions(base.name)
    if (listing === null || typeof listing !== 'object' || listing.status !== 'listed') {
      return {
        ...base,
        state: 'error',
        latest: null,
        error: listing !== null && typeof listing === 'object' && typeof listing.problem === 'string' ? listing.problem : 'not-updatable',
      }
    }
    const versions = Array.isArray(listing.versions) ? listing.versions : []
    const usable = versions.filter(version => version !== null && typeof version === 'object'
      && parseVersion(version.version) !== undefined && version.bundle !== false)
    if (usable.length === 0) return { ...base, state: 'current', latest: null }
    const target = usable[0]
    let state = 'available'
    if (target.prerelease === true || target.deprecated !== undefined) {
      if (!includePrerelease) state = 'skipped'
    }
    return {
      ...base,
      state,
      latest: target.version,
      incompatible: target.incompatible ?? null,
      prerelease: target.prerelease === true,
      deprecated: typeof target.deprecated === 'string' && target.deprecated !== '' ? target.deprecated : null,
      registry: typeof listing.registry === 'string' || listing.registry === null ? listing.registry : undefined,
    }
  } catch (error) {
    return { ...base, state: 'error', latest: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 批量检查候选。
 * @param {object} input - 输入。
 * @param {object[]} input.candidates - {@link collectCandidates} 的结果。
 * @param {string[]} [input.names] - 只检查这些包名；省略时全部检查。
 * @param {object} input.dependencies - 同 {@link checkCandidate}。
 * @returns {Promise<{checked: object[], skipped: string[], unknown: string[]}>} 结果与未命中的包名。
 */
export async function checkCandidates(input) {
  const all = Array.isArray(input.candidates) ? input.candidates : []
  const wanted = Array.isArray(input.names) && input.names.length > 0 ? new Set(input.names) : undefined
  const targets = wanted === undefined ? all : all.filter(candidate => wanted.has(candidate.name))
  const unknown = wanted === undefined ? [] : [...wanted].filter(name => !all.some(candidate => candidate.name === name))
  const skipped = all.filter(candidate => wanted !== undefined && !wanted.has(candidate.name)).map(candidate => candidate.name)
  const checked = await Promise.all(targets.map(candidate => checkCandidate(candidate, input.dependencies)))
  return { checked, skipped, unknown }
}

// --- 顺序更新队列 ---------------------------------------------------------------

/** 队列项对外的形态（写进 `/updates/state` 的 `items[]`）。 */
/**
 * @typedef {object} QueueItem
 * @property {string} name
 * @property {string} current
 * @property {string} latest
 * @property {string} version
 * @property {'npm'|'git'} kind
 * @property {string} [spec]
 * @property {string} requestId
 * @property {string} stage
 * @property {boolean} success
 * @property {boolean} failed
 * @property {boolean} restartRequired
 * @property {boolean} cancelled
 * @property {string|null} error
 * @property {object|null} restore
 * @property {number} startedAt
 * @property {number|null} endedAt
 */

/**
 * 把 `ManagementError` 压成一句能显示给用户的失败原因。
 *
 * 优先级：`diagnostic`（最具体）→ `code`（`incompatible-version` 时附上具体
 * `incompatible[].name@version`）→ `message` → `application:<application>`。
 * @param {unknown} error - `updateBundle().result.error`。
 * @param {string|undefined} application - `result.application`。
 * @returns {string} 失败原因。
 */
function describeUpdateError(error, application) {
  if (error !== null && typeof error === 'object') {
    const value = /** @type {Record<string, unknown>} */ (error)
    const diagnostic = typeof value.diagnostic === 'string' ? value.diagnostic.trim() : ''
    if (diagnostic !== '') return diagnostic
    const code = typeof value.code === 'string' ? value.code : ''
    if (code === 'incompatible-version' && Array.isArray(value.incompatible)) {
      const rejected = value.incompatible.map((entry) => {
        const item = entry !== null && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : {}
        const name = typeof item.name === 'string' ? item.name : ''
        const version = typeof item.version === 'string' ? item.version : ''
        return name === '' ? '' : `${name}@${version === '' ? '?' : version}`
      }).filter(entry => entry !== '')
      return rejected.length === 0 ? code : `${code}: ${rejected.join(', ')}`
    }
    if (code !== '') {
      const message = typeof value.message === 'string' ? value.message.trim() : ''
      return message === '' || message === code ? code : `${code}: ${message}`
    }
    const message = typeof value.message === 'string' ? value.message.trim() : ''
    if (message !== '') return message
  }
  if (typeof application === 'string' && application !== '') return `application:${application}`
  return 'unknown-outcome'
}

/**
 * 把一个 `pluginManager.updateBundle()` 的结果拍平成队列项要的字段。
 *
 * `success` / `failed` / `restartRequired` / `restore` 是契约字段，另外保留 `result`
 * 供界面展开看诊断；`restore` 非空表示目标版本安装失败后已经装回旧版本。
 * @param {unknown} outcome - `updateBundle()` 的返回值。
 * @returns {{success: boolean, failed: boolean, restartRequired: boolean, restore: object|null, error: string|null, result: unknown}} 拍平结果。
 */
export function flattenUpdateOutcome(outcome) {
  if (outcome === null || typeof outcome !== 'object') {
    return { success: false, failed: true, restartRequired: false, restore: null, error: 'updateBundle returned no result', result: outcome }
  }
  const value = /** @type {Record<string, unknown>} */ (outcome)
  const result = value.result !== null && typeof value.result === 'object' ? /** @type {Record<string, unknown>} */ (value.result) : undefined
  const application = result?.application
  const restore = value.restore !== null && typeof value.restore === 'object' ? /** @type {object} */ (value.restore) : null
  const success = application === 'applied'
  const restartRequired = application === 'restart-required'
  const cancelled = application === 'cancelled'
  const error = cancelled
    ? 'cancelled'
    : success || restartRequired
      ? null
      : describeUpdateError(result?.error, typeof application === 'string' ? application : undefined)
  return { success: success || restartRequired, failed: !success && !restartRequired && !cancelled, restartRequired, restore, error, result: outcome }
}

/**
 * 中断日志文件名（放在插件的缓存目录里）。
 *
 * 更新队列每项开始前写入、结束后移除；进程被杀时文件里留下的就是「上次没跑完」的项，
 * 下一次 `GET /updates` 会把它作为 `interrupted` 返回，由 `POST /updates/recover` 重装。
 */
export const INFLIGHT_FILENAME = 'updates-inflight.json'

/**
 * 把队列项归一成中断日志的一条记录。
 *
 * 只保留恢复需要的最小信息：包名、当前版本、目标版本、来源类型、Git 的固定 spec、
 * requestId、阶段与开始时间。缺包名时返回 null（这条记录没法恢复）。
 * @param {object} item - 队列项（或 `{name, current, latest, kind, spec, requestId, stage, startedAt}`）。
 * @param {string} [phase] - 阶段；省略时用 `item.stage`，再退回 'checking'。
 * @returns {object|null} 记录，或 null。
 */
export function inflightRecord(item, phase) {
  if (item === null || typeof item !== 'object') return null
  const name = typeof item.name === 'string' ? item.name : ''
  if (name === '') return null
  const target = typeof item.latest === 'string' && item.latest !== ''
    ? item.latest
    : typeof item.version === 'string' ? item.version : ''
  const kind = item.kind === 'git' ? 'git' : 'npm'
  const record = {
    name,
    current: typeof item.current === 'string' ? item.current : '',
    target,
    kind,
    requestId: typeof item.requestId === 'string' ? item.requestId : '',
    phase: typeof phase === 'string' && phase !== '' ? phase : typeof item.stage === 'string' && item.stage !== '' ? item.stage : 'checking',
    startedAt: typeof item.startedAt === 'number' && item.startedAt > 0 ? item.startedAt : Date.now(),
  }
  if (kind === 'git' && typeof item.spec === 'string' && item.spec !== '') record.spec = item.spec
  return record
}

/**
 * 归一化读回来的中断日志：丢掉坏记录、按包名去重（后写的覆盖先写的）。
 * @param {unknown} value - 文件里解析出来的值（对象或数组都接受）。
 * @returns {object[]} 记录列表。
 */
export function normalizeInflight(value) {
  const list = Array.isArray(value) ? value : value !== null && typeof value === 'object' && Array.isArray(/** @type {{items?: unknown}} */ (value).items)
    ? /** @type {{items: unknown[]}} */ (value).items
    : []
  /** @type {Map<string, object>} */
  const byName = new Map()
  for (const entry of list) {
    const record = inflightRecord(entry, typeof entry?.phase === 'string' ? entry.phase : undefined)
    if (record === null) continue
    if (typeof entry.target === 'string' && entry.target !== '') record.target = entry.target
    if (typeof entry.requestId === 'string') record.requestId = entry.requestId
    if (typeof entry.startedAt === 'number') record.startedAt = entry.startedAt
    byName.set(record.name, record)
  }
  return [...byName.values()]
}

/**
 * 恢复一项时要交给 `pluginManager.installBundle()` 的 spec。
 *
 * npm 包用 `name@target`（与 `updateBundle` 的 registry 路径一致）；Git 包必须用它原来的
 * 固定 commit spec——重装别的提交会改变用户已装的版本。
 * @param {object} record - 中断日志记录。
 * @returns {string} 安装 spec；信息不足时返回空串。
 */
export function recoverSpec(record) {
  if (record === null || typeof record !== 'object') return ''
  const name = typeof record.name === 'string' ? record.name : ''
  if (name === '') return ''
  if (record.kind === 'git') return typeof record.spec === 'string' ? record.spec : ''
  const target = typeof record.target === 'string' ? record.target : ''
  return target === '' ? name : `${name}@${target}`
}

/**
 * 从一份中断日志里删掉指定包名。
 * @param {object[]} records - 现有记录。
 * @param {string[]} names - 要删掉的包名。
 * @returns {object[]} 剩下的记录。
 */
export function withoutInflight(records, names) {
  const removed = new Set(Array.isArray(names) ? names : [])
  return (Array.isArray(records) ? records : []).filter(record => !removed.has(record?.name))
}

/**
 * 创建一个顺序更新队列（纯状态机，不自己发请求）。
 *
 * 执行动作由调用方通过 `runItem` 注入（通常是 `pluginManager.updateBundle`）：
 * 单项抛错或返回失败结果都只标记该项失败，**继续下一项**；`stop()` 之后队列停在新项之前，
 * 正在跑的那一项由调用方按后端取消流程结束。
 *
 * @param {object} options - 选项。
 * @param {object[]} options.items - 要更新的项：`{name, current, latest, kind, spec?}`。
 * @param {(item: object) => Promise<unknown>} options.runItem - 执行一项；返回值交给 {@link flattenUpdateOutcome}。
 * @param {(message: string) => void} [options.onError] - 单项失败时的回调（用于写日志）。
 * @param {(name: string) => string} [options.requestIdFor] - 为一项生成 requestId；默认 `updates-<序号>-<时间戳>`。
 * @param {(item: object) => void} [options.onItemStart] - 某项开始前调用（用于写中断日志）。
 * @param {(item: object) => void} [options.onItemEnd] - 某项结束后调用（成功/失败/取消都会调，用于清中断日志）。
 * @returns {{start: () => Promise<object>, stop: () => void, isStopped: () => boolean, isRunning: () => boolean, snapshot: () => object, setStage: (name: string, stage: string) => boolean, requestIdOf: (name: string) => string|undefined}} 队列句柄。
 */
export function createUpdateQueue(options) {
  const inputs = Array.isArray(options.items) ? options.items : []
  const runItem = options.runItem
  const onError = options.onError ?? (() => {})
  /** 某项开始前的钩子（写中断日志）；抛错不影响队列。 */
  const onItemStart = options.onItemStart ?? (() => {})
  /** 某项结束后的钩子（清中断日志）；抛错不影响队列。 */
  const onItemEnd = options.onItemEnd ?? (() => {})
  const requestIdFor = options.requestIdFor ?? ((name, index) => `updates-${String(index)}-${name}-${String(Date.now())}`)
  const startedAt = Date.now()
  /** @type {QueueItem[]} */
  const items = inputs.map((item, index) => ({
    name: String(item.name),
    current: typeof item.current === 'string' ? item.current : '',
    latest: typeof item.latest === 'string' ? item.latest : '',
    version: typeof item.version === 'string' ? item.version : typeof item.latest === 'string' ? item.latest : '',
    kind: item.kind === 'git' ? 'git' : 'npm',
    ...item.spec === undefined ? {} : { spec: item.spec },
    requestId: requestIdFor(String(item.name), index),
    stage: 'queued',
    success: false,
    failed: false,
    restartRequired: false,
    cancelled: false,
    error: null,
    restore: null,
    startedAt: 0,
    endedAt: null,
  }))
  let stopped = false
  let running = false
  /** 当前正在跑的下标；-1 表示没有。 */
  let active = -1
  let finished = false
  const summary = () => ({
    total: items.length,
    success: items.filter(item => item.success).length,
    failed: items.filter(item => item.failed).length,
    cancelled: items.filter(item => item.cancelled).length,
    // 「需重启」是成功的一种：单独计数，界面汇总要显示。
    restartRequired: items.filter(item => item.restartRequired).length,
    skipped: items.filter(item => item.cancelled).length,
    pending: items.filter(item => !item.success && !item.failed && !item.cancelled).length,
  })

  /**
   * 把一项标记为取消。
   * @param {QueueItem} item - 队列项。
   * @param {string|null} [reason] - 取消前已经拿到的失败诊断。
   * @returns {void}
   */
  function markCancelled(item, reason) {
    item.cancelled = true
    item.success = false
    item.failed = false
    item.restartRequired = false
    item.error = item.error ?? reason ?? 'cancelled'
    item.stage = 'cancelled'
    item.endedAt = Date.now()
  }

  return {
    /** 依次执行所有项；每项失败都继续下一项。 */
    async start() {
      if (running) return { requestIds: items.map(item => item.requestId), items, summary: summary(), running: true, stopped }
      running = true
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        if (stopped) {
          markCancelled(item)
          continue
        }
        active = index
        item.stage = 'checking'
        item.startedAt = Date.now()
        // 开始前先记中断日志：进程在这之后被杀，下次启动就知道这一项没跑完。
        try {
          onItemStart(item)
        } catch {
          // 中断日志写不进去不该让更新停下。
        }
        /** @type {unknown} */
        let outcome
        try {
          outcome = await runItem(item)
        } catch (error) {
          outcome = undefined
          item.error = error instanceof Error ? error.message : String(error)
        }
        const flat = outcome === undefined && item.error !== null
          ? { success: false, failed: true, restartRequired: false, restore: null, error: item.error, result: null }
          : flattenUpdateOutcome(outcome)
        if (stopped && !flat.success) {
          // 被取消的那一项：成功的结果照常记下，没成功的落到取消。
          item.restore = flat.restore
          item.result = flat.result
          markCancelled(item, flat.error)
        } else {
          item.success = flat.success
          item.failed = flat.failed
          item.restartRequired = flat.restartRequired
          item.error = flat.error
          item.restore = flat.restore
          item.result = flat.result
          item.stage = flat.success ? 'done' : 'failed'
        }
        item.endedAt = Date.now()
        if (item.failed) onError(`${item.name}: ${flat.error ?? 'failed'}`)
        // 这一项已经有结论（成功/失败/取消）：从中断日志里摘掉。
        try {
          onItemEnd(item)
        } catch {
          // 同上：清理失败不影响队列。
        }
        active = -1
      }
      finished = true
      running = false
      return { requestIds: items.map(item => item.requestId), items, summary: summary(), running: false, stopped }
    },
    /** 停止队列：当前项交给调用方的取消流程，后面的项直接标记取消。 */
    stop() {
      stopped = true
    },
    /** @returns {boolean} 是否已请求停止。 */
    isStopped() {
      return stopped
    },
    /** @returns {boolean} 是否还有项在跑。 */
    isRunning() {
      return running
    },
    /** @returns {boolean} 是否全部走完（成功、失败或取消）。 */
    isFinished() {
      return finished
    },
    /** @returns {number} 当前正在跑的下标；-1 表示没有。 */
    activeIndex() {
      return active
    },
    /** 更新某项的阶段（来自 `plugin-manager/update-state`）。 */
    setStage(name, stage) {
      const item = items.find(entry => entry.name === name)
      if (item === undefined || typeof stage !== 'string') return false
      if (['queued', 'done', 'failed', 'cancelled'].includes(item.stage)) return false
      item.stage = stage
      return true
    },
    /** @param {string} name - 包名。 @returns {string|undefined} 该项的 requestId。 */
    requestIdOf(name) {
      return items.find(item => item.name === name)?.requestId
    },
    /** @returns {object} 队列快照（`/updates/state` 的 `queue` 字段）。 */
    snapshot() {
      return {
        startedAt,
        running,
        stopped,
        finished,
        summary: summary(),
        items: items.map(item => ({ ...item })),
      }
    },
  }
}
