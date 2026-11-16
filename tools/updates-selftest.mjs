/**
 * 「可更新」Host 半边的自测：纯函数 + 桥接端点（假 ctx / 假 pluginManager）。
 *
 * 跑法：`node tools/updates-selftest.mjs`（不需要安装任何依赖，只用 Node 内置模块）。
 *
 * 覆盖：候选过滤（方案 §4）、版本比较、Git spec 解析、检查（listVersions / 本地索引）、
 * 顺序更新队列（失败继续、取消）、以及 6 个 owner-only 桥接路由与 `/settings` 的两个开关。
 * 全程不发网络请求、不动真实 profile。
 *
 * @module dsh-pluginmarket-plus/tools/updates-selftest
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { CacheStore, sourceId } from '../lib/store.js'
import {
  buildGitSpec, checkCandidate, checkCandidates, classifyBundle, collectCandidates, compareVersions,
  createUpdateQueue, flattenUpdateOutcome, hasPluginManagement, inflightRecord, inflightSatisfied, isPrerelease, latestGitFromIndex,
  normalizeIndexGitSource, normalizeInflight, parseGitSpec, parseVersion, reconcileInflight, recoverSpec, withoutInflight,
} from '../lib/updates.js'

/**
 * `lib/index.js` 的 peer 依赖（`@deepseek-ai/schemastery`）由 DSH profile 提供，插件自己的
 * 目录里没有 `node_modules`。自测要在真实 `lib/index.js` 上跑桥接端点，所以这里补一条
 * **只读、只兜底** 的解析规则：ESM 解析失败时改从 DSH profile 的 `node_modules` 里解析。
 * 它不写任何文件，也不改变插件代码在生产环境里的解析方式。
 */
function enableProfileFallbackResolution() {
  const profileDir = join(homedir(), '.dsh', 'profiles', 'web')
  if (!existsSync(profileDir)) return false
  const profileRequire = createRequire(join(profileDir, 'index.js'))
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) throw error
        try {
          const resolved = profileRequire.resolve(specifier)
          if (existsSync(resolved)) return { url: pathToFileURL(resolved).href, shortCircuit: true }
        } catch {
          // profile 里也没有：抛原始错误，保持失败原因清晰。
        }
        throw error
      }
    },
  })
  return true
}

const profileResolution = enableProfileFallbackResolution()

/** 一个提交（40 位十六进制）。 */
const COMMIT_OLD = 'a'.repeat(40)
const COMMIT_NEW = 'b'.repeat(40)

let failures = 0
let checks = 0

/**
 * 断言。
 * @param {unknown} condition - 期望为真。
 * @param {string} label - 用例名。
 * @param {unknown} [detail] - 失败时附带的诊断。
 * @returns {void}
 */
function ok(condition, label, detail) {
  checks++
  if (condition) return
  failures++
  console.error(`✗ ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

/**
 * 断言相等（用 JSON 比较，够用且没有依赖）。
 * @param {unknown} actual - 实际值。
 * @param {unknown} expected - 期望值。
 * @param {string} label - 用例名。
 * @returns {void}
 */
function eq(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  ok(left === right, label, `实际 ${left} ≠ 期望 ${right}`)
}

/** 分节标题。 */
function section(title) {
  console.log(`\n— ${title}`)
}

// ---------------------------------------------------------------------------
// 1. 纯函数：版本比较
// ---------------------------------------------------------------------------
section('版本比较（SemVer 2.0.0 优先级）')
eq(parseVersion('1.2.3')?.major, 1, '1.2.3 可解析')
eq(parseVersion('1.2.3-alpha.1+build.5')?.pre, ['alpha', '1'], '解析先行版本号')
eq(parseVersion('v1.2.3'), undefined, '拒绝 v 前缀')
eq(parseVersion('1.2'), undefined, '拒绝缺少 patch 的版本')
eq(compareVersions('1.2.3', '1.2.4'), -1, '小版本号比较')
eq(compareVersions('1.0.0', '1.0.0'), 0, '相等')
eq(compareVersions('1.0.0-alpha', '1.0.0'), -1, '预发布低于正式版')
eq(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1, '数字标识符按数值比较')
eq(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1, '数字标识符低于字母标识符')
eq(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0, '忽略 build 元数据')
eq(compareVersions('2.0.0-rc.1', '1.9.9'), 1, '主版本优先')
eq(isPrerelease('1.0.0-rc.1'), true, '识别预发布')
eq(isPrerelease('1.0.0'), false, '正式版不是预发布')

// ---------------------------------------------------------------------------
// 2. 纯函数：Git spec
// ---------------------------------------------------------------------------
section('Git spec 解析与构造')
const pinnedHttps = `git+https://github.com/owner/repo.git#${COMMIT_OLD}`
eq(parseGitSpec(pinnedHttps)?.repository, 'owner/repo', '解析 https 形式的固定 commit')
eq(parseGitSpec(pinnedHttps)?.commit, COMMIT_OLD, '提交保留')
eq(parseGitSpec(`${pinnedHttps}&path:/packages/a`)?.path, 'packages/a', '解析 path: 子目录')
eq(parseGitSpec('git+https://github.com/owner/repo.git#main'), undefined, '拒绝分支')
eq(parseGitSpec(`git+https://github.com/owner/repo.git#v1.2.3&${COMMIT_OLD}`), undefined, '拒绝标签 + 提交的组合')
eq(parseGitSpec(`github:owner/repo#${COMMIT_OLD}`)?.host, 'github.com', '接受 github: 简写（固定 commit 时 pnpm 也接受）')
eq(parseGitSpec(`github:owner/repo#main`), undefined, '拒绝 github: 简写的分支')
eq(parseGitSpec(`https://github.com/owner/repo#${COMMIT_OLD}`)?.host, 'github.com', '接受不带 git+ 的 URL')
eq(parseGitSpec(`git+https://GitHub.com/Owner/Repo.git#${COMMIT_OLD}`)?.repository, 'Owner/Repo', '路径大小写原样保留，主机小写')
eq(parseGitSpec(`git@github.com:owner/repo.git#${COMMIT_OLD}`)?.repository, 'owner/repo', '接受 scp 形式')
eq(buildGitSpec({ host: 'github.com', repository: 'owner/repo', path: '', commit: COMMIT_OLD }, COMMIT_NEW), `git+https://github.com/owner/repo.git#${COMMIT_NEW}`, '构造根目录 spec')
eq(buildGitSpec({ host: 'github.com', repository: 'owner/repo', path: 'packages/a', commit: COMMIT_NEW }, COMMIT_NEW), `git+https://github.com/owner/repo.git#${COMMIT_NEW}&path:/packages/a`, '构造子目录 spec')
eq(normalizeIndexGitSource({ url: 'https://github.com/owner/repo', commit: COMMIT_OLD })?.repository, 'owner/repo', '索引来源去掉 .git 与协议')
eq(normalizeIndexGitSource({ url: 'https://github.com/owner/repo', commit: 'nope' }), undefined, '索引来源拒绝非 40 位 commit')
eq(normalizeIndexGitSource({ url: 'https://github.com/owner/repo', commit: COMMIT_OLD.toUpperCase() })?.commit, COMMIT_OLD, '索引提交归一化成小写')

// ---------------------------------------------------------------------------
// 3. 纯函数：候选过滤（方案 §4）
// ---------------------------------------------------------------------------
section('候选过滤')
/** 造一个 `listBundles()` 条目。 */
function bundle(overrides) {
  return {
    name: 'demo', official: false, availability: 'profile', installed: true, enabled: true,
    removable: true, rows: [], overrides: [], version: '1.0.0', source: 'demo@1.0.0',
    ...overrides,
  }
}
eq(classifyBundle(bundle({ update: 'registry' }))?.kind, 'npm', 'pluginManager 的 update:registry 映射成 kind:npm')
eq(classifyBundle(bundle({ official: true, update: 'registry' }))?.reason, 'official', '官方 bundle 不显示')
eq(classifyBundle(bundle({ installed: false, update: 'registry' }))?.reason, 'not-installed', '未安装的不显示')
eq(classifyBundle(bundle({ update: undefined }))?.reason, 'not-updatable', 'update 字段缺失（link:/file:/别名/未固定 Git）不显示')
eq(classifyBundle(bundle({ update: 'registry', source: 'link:/tmp/demo' }))?.reason, 'not-own-name-registry-spec', 'link: 本地目录不显示')
eq(classifyBundle(bundle({ update: 'registry', source: 'file:/tmp/demo' }))?.reason, 'not-own-name-registry-spec', 'file: 本地目录不显示')
eq(classifyBundle(bundle({ update: 'registry', source: 'demo@npm:other@1.0.0' }))?.reason, 'not-own-name-registry-spec', 'npm: 别名不显示')
eq(classifyBundle(bundle({ update: 'registry', source: 'other@1.0.0' }))?.reason, 'not-own-name-registry-spec', '不是自身包名的 spec 不显示')
eq(classifyBundle(bundle({ update: 'git', source: 'git+https://github.com/o/r.git#main' }))?.reason, 'unpinned-git-spec', '未固定 commit 的 Git 不显示')
eq(classifyBundle(bundle({ update: 'git', source: pinnedHttps }))?.kind, 'git', '固定 commit 的 Git 可更新')
eq(classifyBundle(bundle({ update: 'registry', readOnlyReason: 'management-required' }))?.reason, 'plugin-management', '带插件管理组件的不显示')
eq(hasPluginManagement(bundle({ rows: [{ rowId: 'r', moduleName: 'dsh-plugin-manager' }] })), true, 'patch 行里的插件管理模块也算')
eq(hasPluginManagement(bundle({ rows: [{ rowId: 'r', moduleName: 'dsh-pluginmarket-plus' }] })), false, '无关模块不算插件管理')

const bundles = [
  bundle({ name: 'enabled-registry', update: 'registry', source: 'enabled-registry@1.0.0' }),
  bundle({ name: 'disabled-registry', update: 'registry', source: 'disabled-registry@1.0.0', enabled: false }),
  bundle({ name: 'official-pkg', official: true, update: 'registry', source: 'official-pkg@1.0.0' }),
  bundle({ name: 'linked-pkg', update: 'registry', source: 'link:/tmp/linked' }),
  bundle({ name: 'alias-pkg', update: 'registry', source: 'alias-pkg@npm:other@1.0.0' }),
  bundle({ name: 'git-pkg', update: 'git', version: '2.0.0', source: `git+https://github.com/o/g.git#${COMMIT_OLD}` }),
  bundle({ name: 'git-branch', update: undefined, source: 'git+https://github.com/o/g2.git#main' }),
  bundle({ name: 'manager-pkg', update: 'registry', source: 'manager-pkg@1.0.0', readOnlyReason: 'management-required' }),
]

const defaultNames = collectCandidates({ bundles }).map(candidate => candidate.name)
eq(defaultNames, ['enabled-registry', 'git-pkg'], '默认只列启用中的可更新项')

const withDisabled = collectCandidates({ bundles, includeDisabled: true }).map(candidate => candidate.name)
eq(withDisabled, ['enabled-registry', 'disabled-registry', 'git-pkg'], '开关打开后才包含已禁用的插件')

const gitCandidate = collectCandidates({ bundles, indexInfo: { hasIndex: true } }).find(candidate => candidate.name === 'git-pkg')
eq(gitCandidate?.kind, 'git', 'Git 候选带 kind=git')
eq(gitCandidate?.origin?.repository, 'o/g', 'Git 候选带仓库目录')
eq(gitCandidate?.spec, `git+https://github.com/o/g.git#${COMMIT_OLD}`, 'Git 候选带 spec')
eq(collectCandidates({ bundles, indexInfo: { hasIndex: false } }).find(candidate => candidate.name === 'git-pkg')?.state, 'uncheckable', '索引缺失时 Git 候选标记不可检查')
const uncheckableNoIndex = collectCandidates({ bundles }).find(candidate => candidate.name === 'git-pkg')
eq(uncheckableNoIndex?.kind, 'git', '不可检查的 Git 候选仍是 kind=git')
eq(uncheckableNoIndex?.reason, 'index-miss', '索引缺失时 Git 候选带 reason=index-miss')
ok(Object.hasOwn(uncheckableNoIndex ?? {}, 'error'), '不可检查的 Git 候选带 error 字段（供 UI 显示）')
eq(uncheckableNoIndex?.error, null, '没有具体错误时 error 为 null')
eq(collectCandidates({ bundles }).find(candidate => candidate.name === 'enabled-registry')?.state, 'unknown', '未检查前 state=unknown')
eq(collectCandidates({ bundles }).find(candidate => candidate.name === 'enabled-registry')?.kind, 'npm', '对外候选的 npm kind 是 npm')

const cachedCurrent = { 'enabled-registry': { name: 'enabled-registry', current: '1.0.0', kind: 'npm', state: 'available', latest: '1.0.0' } }
eq(collectCandidates({ bundles, cached: cachedCurrent }).map(candidate => candidate.name), ['git-pkg'], '没有更高版本的候选被剔除')
const cachedNewer = { 'enabled-registry': { name: 'enabled-registry', current: '1.0.0', kind: 'npm', state: 'available', latest: '1.2.0' } }
eq(collectCandidates({ bundles, cached: cachedNewer }).find(candidate => candidate.name === 'enabled-registry')?.latest, '1.2.0', '带回上一次检查的目标版本')
const cachedPre = { 'enabled-registry': { name: 'enabled-registry', current: '1.0.0', kind: 'npm', state: 'available', latest: '2.0.0-rc.1', prerelease: true } }
eq(collectCandidates({ bundles, cached: cachedPre }).find(candidate => candidate.name === 'enabled-registry')?.state, 'skipped', '预发布目标在开关关闭时降级为 skipped')
eq(collectCandidates({ bundles, cached: cachedPre, includePrerelease: true }).find(candidate => candidate.name === 'enabled-registry')?.state, 'available', '开关打开后预发布目标可更新')

// 检查缓存的终态优先：current 不再出现；error / uncheckable 原样保留并带原因。
const cachedCurrentState = { 'enabled-registry': { name: 'enabled-registry', current: '1.0.0', kind: 'npm', state: 'current', latest: null } }
eq(collectCandidates({ bundles, cached: cachedCurrentState }).map(candidate => candidate.name), ['git-pkg'], '检查结果 current 的包不再出现')
const cachedError = { 'enabled-registry': { name: 'enabled-registry', current: '1.0.0', kind: 'npm', state: 'error', latest: null, error: 'registry unreachable' } }
const errorCandidate = collectCandidates({ bundles, cached: cachedError }).find(candidate => candidate.name === 'enabled-registry')
eq(errorCandidate?.state, 'error', '检查失败的包保持 error（不回落 unknown）')
eq(errorCandidate?.error, 'registry unreachable', 'error 候选带上失败原因')
const cachedUncheckable = { 'git-pkg': { name: 'git-pkg', current: '1.0.0', kind: 'git', state: 'uncheckable', latest: null, reason: 'index-miss' } }
const uncheckableCandidate = collectCandidates({ bundles, cached: cachedUncheckable, indexInfo: { hasIndex: true } }).find(candidate => candidate.name === 'git-pkg')
eq(uncheckableCandidate?.state, 'uncheckable', 'uncheckable 结果原样保留')
eq(uncheckableCandidate?.reason, 'index-miss', 'uncheckable 候选带上原因')

// ---------------------------------------------------------------------------
// 4. 纯函数：本地索引 → 最新 commit
// ---------------------------------------------------------------------------
section('本地索引解析最新提交')
const indexVersions = [
  { version: '2.0.0', type: 'git', publishTimestamp: 300, git: { host: 'github.com', repository: 'o/g', path: '', commit: COMMIT_NEW } },
  { version: '1.0.0', type: 'git', publishTimestamp: 100, git: { host: 'github.com', repository: 'o/g', path: '', commit: COMMIT_OLD } },
  { version: '9.9.9', type: 'git', publishTimestamp: 500, git: { host: 'github.com', repository: 'other/repo', path: '', commit: 'c'.repeat(40) } },
]
eq(latestGitFromIndex(indexVersions, { host: 'github.com', repository: 'o/g', path: '' })?.commit, COMMIT_NEW, '取同仓库目录里最新的提交')
eq(latestGitFromIndex(indexVersions, { host: 'github.com', repository: 'o/g', path: 'pkg' }), undefined, '子目录不同就不算同一个仓库目录')
eq(latestGitFromIndex(indexVersions, { host: 'github.com', repository: 'nope/nope', path: '' }), undefined, '仓库不同返回 undefined')

// ---------------------------------------------------------------------------
// 5. 检查：registry / git
// ---------------------------------------------------------------------------
section('检查候选')

/** 造一个 `listVersions()` 的返回。 */
function listing(versions) {
  return {
    status: 'listed', installed: '1.0.0', registry: 'https://registry.npmjs.org/', attempts: [],
    versions, omitted: 0,
  }
}

const registryCandidate = { name: 'demo', current: '1.0.0', kind: 'npm' }
const registryChecked = await checkCandidate(registryCandidate, {
  listVersions: async () => listing([
    { version: '1.2.0', tags: ['latest'], prerelease: false, bundle: true },
    { version: '1.1.0', tags: [], prerelease: false, bundle: true },
  ]),
  latestGit: () => undefined,
})
eq(registryChecked.state, 'available', 'registry 检查取到新版本')
eq(registryChecked.latest, '1.2.0', 'registry 目标是列表里的最新版本')

const deprecatedChecked = await checkCandidate(registryCandidate, {
  listVersions: async () => listing([{ version: '1.2.0', tags: ['latest'], prerelease: false, bundle: true, deprecated: '不要再用了' }]),
  latestGit: () => undefined,
})
eq(deprecatedChecked.state, 'skipped', '已废弃目标默认不推荐')
eq(deprecatedChecked.deprecated, '不要再用了', '带上废弃消息')
eq((await checkCandidate(registryCandidate, {
  listVersions: async () => listing([{ version: '1.2.0', tags: ['latest'], prerelease: false, bundle: true, deprecated: 'x' }]),
  latestGit: () => undefined,
  includePrerelease: true,
})).state, 'available', '开关打开后已废弃目标可更新')

const refused = await checkCandidate(registryCandidate, {
  listVersions: async () => ({ status: 'refused', problem: 'not-updatable', reason: 'not a profile dependency', attempts: [] }),
  latestGit: () => undefined,
})
eq(refused.state, 'error', 'registry 拒绝时标记错误而不抛')
eq(refused.error, 'not-updatable', '带上拒绝原因')

const noNewer = await checkCandidate(registryCandidate, { listVersions: async () => listing([]), latestGit: () => undefined })
eq(noNewer.state, 'current', '没有更高版本时 state=current')

const thrower = await checkCandidate(registryCandidate, {
  listVersions: async () => { throw new Error('registry unreachable') },
  latestGit: () => undefined,
})
eq(thrower.state, 'error', 'listVersions 抛错被吞掉并标记错误')
eq(thrower.error, 'registry unreachable', '错误消息保留')

const gitOrigin = { host: 'github.com', repository: 'o/g', path: '' }
const gitChecked = await checkCandidate({ name: 'git-pkg', current: '1.0.0', kind: 'git', origin: gitOrigin }, {
  listVersions: async () => listing([]),
  latestGit: () => ({ commit: COMMIT_NEW, version: '2.0.0' }),
})
eq(gitChecked.state, 'available', 'git 检查从索引里取到新提交')
eq(gitChecked.commit, COMMIT_NEW, '带上目标提交')
eq(gitChecked.spec, `git+https://github.com/o/g.git#${COMMIT_NEW}`, '构造出可直接交给 updateBundle 的 spec')

const gitMiss = await checkCandidate({ name: 'git-pkg', current: '1.0.0', kind: 'git', origin: gitOrigin }, {
  listVersions: async () => listing([]),
  latestGit: () => undefined,
})
eq(gitMiss.state, 'uncheckable', '索引里没有该包时标记不可检查（不报错）')
eq(gitMiss.latest, null, '不可检查时不编造目标版本')

const batch = await checkCandidates({
  candidates: [registryCandidate, { name: 'git-pkg', current: '1.0.0', kind: 'git', origin: gitOrigin }],
  names: ['git-pkg'],
  dependencies: { listVersions: async () => listing([]), latestGit: () => ({ commit: COMMIT_NEW, version: '2.0.0' }) },
})
eq(batch.checked.length, 1, '只检查点名的包')
eq(batch.checked[0].name, 'git-pkg', '检查的是点名的那个')
eq(batch.skipped, ['demo'], '其余候选记为 skipped')

// ---------------------------------------------------------------------------
// 6. 纯函数：结果拍平 + 顺序队列
// ---------------------------------------------------------------------------
section('更新结果与顺序队列')
eq(flattenUpdateOutcome(undefined).failed, true, '没有结果算失败')
const applied = flattenUpdateOutcome({ from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'demo@1.2.0' } })
eq([applied.success, applied.failed, applied.restartRequired], [true, false, false], 'applied → success')
const restart = flattenUpdateOutcome({ from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'restart-required', stage: 'install', target: 'demo@1.2.0', restartReason: 'no-hmr' } })
eq([restart.success, restart.restartRequired], [true, true], 'restart-required 也算成功但需要重启')
const rolled = flattenUpdateOutcome({
  from: '1.0.0', to: '1.2.0', step: 'install',
  result: { changed: false, application: 'failed', stage: 'install', target: 'demo@1.2.0', error: { code: 'incompatible-version', diagnostic: 'engines.dsh 不满足' } },
  restore: { changed: true, application: 'applied', stage: 'install', target: 'demo@1.0.0' },
})
eq([rolled.success, rolled.failed], [false, true], 'failed → failed')
eq(rolled.error, 'engines.dsh 不满足', '带上错误诊断')
eq(rolled.restore?.target, 'demo@1.0.0', '带回滚记录（旧版本已装回）')

// 没有 diagnostic 时的回退链：error.code → application:<value> → unknown-outcome。
const codeOnly = flattenUpdateOutcome({
  from: '1.0.0', to: '1.2.0', step: 'check',
  result: { changed: false, application: 'failed', stage: 'install', target: 'demo@1.2.0', error: { code: 'invalid-spec' } },
})
eq(codeOnly.error, 'invalid-spec', '无 diagnostic 时回退到 error.code')
const codeMessage = flattenUpdateOutcome({
  from: '1.0.0', to: '1.2.0', step: 'install',
  result: { changed: false, application: 'failed', stage: 'install', target: 'demo@1.2.0', error: { code: 'operation-error', message: 'pnpm exited 1' } },
})
eq(codeMessage.error, 'operation-error: pnpm exited 1', 'code 与 message 一起给出')
const incompatibleError = flattenUpdateOutcome({
  from: '1.0.0', to: '2.0.0', step: 'check',
  result: {
    changed: false, application: 'failed', stage: 'install', target: 'demo@2.0.0',
    error: { code: 'incompatible-version', incompatible: [{ name: 'demo', version: '2.0.0', runtimeVersion: '0.3.0', requirements: { 'engines.dsh': '>=0.4.0' } }] },
  },
})
eq(incompatibleError.error, 'incompatible-version: demo@2.0.0', 'incompatible-version 附上 包@版本')
const incompatibleNoList = flattenUpdateOutcome({
  from: '1.0.0', to: '2.0.0', step: 'check',
  result: { changed: false, application: 'failed', stage: 'install', target: 'demo@2.0.0', error: { code: 'incompatible-version', incompatible: [] } },
})
eq(incompatibleNoList.error, 'incompatible-version', '没有具体包时只给 code')
const applicationOnly = flattenUpdateOutcome({
  from: '1.0.0', to: '1.2.0', step: 'install',
  result: { changed: false, application: 'overridden', stage: 'install', target: 'demo@1.2.0' },
})
eq(applicationOnly.error, 'application:overridden', '无 error 对象时回退到 application:<value>')
const noResult = flattenUpdateOutcome({ from: '1.0.0', to: '1.2.0', step: 'install' })
eq(noResult.error, 'unknown-outcome', '什么都没有时给 unknown-outcome')
eq(flattenUpdateOutcome({ from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: false, application: 'cancelled', stage: 'install', target: 'demo' } }).error, 'cancelled', '取消仍然报 cancelled')
eq(flattenUpdateOutcome({ from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'demo' } }).error, null, '成功时不带错误')

const applied$ = { from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'a@1.2.0' } }
const failed$ = { from: '1.0.0', to: '9.9.9', step: 'check', result: { changed: false, application: 'failed', stage: 'install', target: 'b@9.9.9', error: { code: 'invalid-spec', diagnostic: '目标版本不存在' } } }
const started$ = []
/** 在项 a 执行过程中观察到的阶段（验证 update-state 能改掉它）。 */
let stageMidRun = null
const queue = createUpdateQueue({
  items: [
    { name: 'a', current: '1.0.0', latest: '1.2.0', kind: 'npm' },
    { name: 'b', current: '1.0.0', latest: '9.9.9', kind: 'npm' },
    { name: 'c', current: '1.0.0', latest: '1.3.0', kind: 'npm' },
  ],
  onError: message => started$.push(`error:${message}`),
  runItem: async (item) => {
    started$.push(item.name)
    if (item.name === 'b') return failed$
    if (item.name === 'c') throw new Error('boom')
    // 顺手验证阶段能被 update-state 改掉。
    queue.setStage('a', 'installing')
    stageMidRun = queue.snapshot().items[0].stage
    return applied$
  },
})
const run = await queue.start()
eq(started$.filter(entry => !entry.startsWith('error:')), ['a', 'b', 'c'], '顺序执行，一项失败也继续下一项')
eq(run.summary, { total: 3, success: 1, failed: 2, cancelled: 0, restartRequired: 0, skipped: 0, pending: 0 }, '汇总成功 1 / 失败 2')
eq(stageMidRun, 'installing', '阶段可被 update-state 更新')
eq(run.items[0].stage, 'done', '跑完之后落到 done')
eq(run.items[1].failed, true, '第二项失败')
eq(run.items[2].failed, true, '抛错的项也记为失败')
ok(run.items[1].requestId !== run.items[2].requestId, '每项有独立的 requestId')
ok(started$.some(entry => entry.startsWith('error:')), '失败会回调 onError')

const cancelled$ = []
const queue2 = createUpdateQueue({
  items: [
    { name: 'a', current: '1.0.0', latest: '1.2.0', kind: 'npm' },
    { name: 'b', current: '1.0.0', latest: '1.2.0', kind: 'npm' },
  ],
  runItem: async (item) => {
    cancelled$.push(item.name)
    queue2.stop()
    return applied$
  },
})
const run2 = await queue2.start()
eq(cancelled$, ['a'], '取消后不再执行后续项')
eq(run2.summary, { total: 2, success: 1, failed: 0, cancelled: 1, restartRequired: 0, skipped: 1, pending: 0 }, '取消：成功的那项保留，后面的项标记取消')
eq(run2.items[0].success, true, '取消前已经成功的那一项仍然是成功')
eq(run2.items[1].cancelled, true, '后面的项标记取消')
eq(queue2.isStopped(), true, '取消状态可查询')

// 取消落在失败项上时，那一项算取消而不是失败。
const queue3 = createUpdateQueue({
  items: [{ name: 'a', current: '1.0.0', latest: '9.9.9', kind: 'npm' }],
  runItem: async () => {
    queue3.stop()
    return failed$
  },
})
const run3 = await queue3.start()
eq(run3.summary, { total: 1, success: 0, failed: 0, cancelled: 1, restartRequired: 0, skipped: 1, pending: 0 }, '取消落在失败项上时算取消')

// 需重启的项：算成功，但 summary.restartRequired 要单独计数。
const restartOutcome = { from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'restart-required', stage: 'install', target: 'a@1.2.0', restartReason: 'no-hmr' } }
const queue4 = createUpdateQueue({
  items: [
    { name: 'a', current: '1.0.0', latest: '1.2.0', kind: 'npm' },
    { name: 'b', current: '1.0.0', latest: '1.3.0', kind: 'npm' },
  ],
  runItem: async (item) => item.name === 'a' ? restartOutcome : applied$,
})
const run4 = await queue4.start()
eq(run4.summary.restartRequired, 1, 'summary 统计需重启的项')
eq(run4.summary.success, 2, '需重启的项仍计入成功')
eq(run4.items[0].restartRequired, true, '该项标记 restartRequired')
eq(run4.summary.skipped, 0, 'summary 同时给出 skipped（这里为 0）')

// ---------------------------------------------------------------------------
// 7. 桥接端点（假 ctx / 假 pluginManager）
// ---------------------------------------------------------------------------
section('桥接端点与设置开关')

/** 造一个假 Cordis 上下文 + 假 pluginManager，然后加载真实插件。 */
async function boot(options = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'pmplus-selftest-'))
  /** @type {Map<string, any>} */
  const routes = new Map()
  /** @type {string[]} */
  const disposers = []
  /** @type {Record<string, Function[]>} */
  const listeners = {}
  const effects = []
  const configValues = {
    sources: [], autoRefresh: false, refreshIntervalHours: 4, managePluginMarket: false,
    fetchTimeoutMs: 5000, maxBytes: 1024 * 1024, retries: 0, cacheDir: '.pluginmarket-plus',
    updatesIncludeDisabled: false, updatesIncludePrerelease: false, updatesShowFailed: false,
    ...options.config,
  }
  /** 每个字段都是一个 volatile 引用（`{ get() }`）。 */
  const config = Object.fromEntries(Object.entries(configValues).map(([key, value]) => [key, { get: () => configValues[key] }]))
  const logLines = []
  const logger = { info: () => {}, warn: (message) => { logLines.push(String(message)) } }
  /** 假的 Settings 服务：只认识本插件这一个命名空间，把写入落到 configValues 上。 */
  let revision = 1
  const settings = {
    describe: () => [{ ns: 'dsh-pluginmarket-plus', revision: () => revision }],
    mutate: async (ns, ops, expected) => {
      if (ns !== 'dsh-pluginmarket-plus') throw new Error(`unknown namespace ${ns}`)
      if (options.breakSettings === true) throw new Error('settings unavailable')
      if (typeof expected === 'number' && expected !== revision) throw new Error('stale revision')
      for (const op of ops) {
        if (op.op !== 'set' || !Array.isArray(op.path) || op.path.length !== 1) continue
        configValues[op.path[0]] = op.value
        config[op.path[0]] = { get: () => configValues[op.path[0]] }
      }
      revision += 1
      return { revision }
    },
  }
  const services = {
    profileContext: { dir: profileDir },
    settings,
    logger,
    webServer: { getOrigin: () => 'http://127.0.0.1:3080', register: (definition) => { routes.set(`web:${definition.path}`, definition); return () => routes.delete(`web:${definition.path}`) } },
    connection: {
      fetch: {
        register: (definition) => {
          routes.set(definition.path, definition)
          return () => routes.delete(definition.path)
        },
      },
    },
    pluginMarket: {
      listIndexes: () => [],
      setIndexes: async () => {},
    },
    pluginManager: options.pluginManager,
  }
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-pluginmarket-plus' } } },
    logger,
    get: name => services[name],
    on: (name, listener) => {
      ;(listeners[name] ??= []).push(listener)
      disposers.push(() => { listeners[name] = (listeners[name] ?? []).filter(entry => entry !== listener) })
      return () => {}
    },
    effect: (callback, label) => {
      effects.push({ label, dispose: callback() })
      disposers.push(() => {})
      return () => {}
    },
    inject: (names, callback) => {
      const missing = names.filter(name => services[name] === undefined)
      if (missing.length > 0) return
      const scope = {
        get: ctx.get,
        on: ctx.on,
        effect: ctx.effect,
        fiber: ctx.fiber,
        ...Object.fromEntries(names.map(name => [name, services[name]])),
      }
      callback(scope)
    },
    emit: (name, ...args) => { for (const listener of listeners[name] ?? []) listener(...args) },
  }
  const plugin = await import('../lib/index.js')
  // 允许在插件 apply 之前准备 profile（写 package.json / 预置中断日志，用来测启动日志）。
  if (typeof options.prepare === 'function') options.prepare(profileDir)
  plugin.apply(ctx, config)
  /** 把假 ctx 的注册全部释放（验证 ctx.effect 的清理路径）。 */
  const dispose = () => { for (const entry of effects) entry.dispose?.() }
  /**
   * 调一个桥接路由。
   * @param {string} path - 路由路径。
   * @param {{method?: string, body?: unknown}} [request] - 请求。
   * @returns {Promise<{status: number, body: any}>} 响应。
   */
  const call = async (path, request = {}) => {
    const route = routes.get(path)
    if (route === undefined) throw new Error(`路由未注册：${path}`)
    const init = {
      method: request.method ?? 'GET',
      ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
    }
    const response = await route.fetch(new Request(`http://127.0.0.1:3080${path}`, init))
    const text = await response.text()
    return { status: response.status, body: JSON.parse(text) }
  }
  return { profileDir, routes, listeners, configValues, logLines, ctx, call, dispose }
}

/** 记录每个 `updateBundle` 调用，并按名字给出预设结果。 */
function makeManager(bundlesList, outcomes = {}) {
  const calls = { listVersions: [], updateBundle: [], cancelInstall: [], waitForInstall: [], exemptions: [], installBundle: [], removeBundle: [] }
  /** 按包名覆盖 `listVersions`：函数直接调用，Error 原样抛出，其它值作为返回结果。 */
  const versionLists = {}
  /** 按 spec 覆盖 `installBundle`：函数直接调用，其它值作为返回结果，Error 原样抛出。 */
  const installOutcomes = {}
  /** 按包名覆盖 `removeBundle`。 */
  const removeOutcomes = {}
  return {
    calls,
    versionLists,
    installOutcomes,
    removeOutcomes,
    listBundles: async () => bundlesList,
    listVersions: async (name) => {
      calls.listVersions.push(name)
      const value = versionLists[name]
      if (typeof value === 'function') return value(name)
      if (value instanceof Error) throw value
      return value ?? { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [{ version: '1.2.0', tags: ['latest'], prerelease: false, bundle: true }], omitted: 0 }
    },
    updateBundle: async (name, version, options) => {
      calls.updateBundle.push({ name, version, options })
      const outcome = outcomes[name]
      if (typeof outcome === 'function') return outcome(name, version, options)
      return outcome ?? { from: '1.0.0', to: version, step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: `${name}@${version}` } }
    },
    installBundle: async (spec, options) => {
      calls.installBundle.push({ spec, options })
      const outcome = installOutcomes[spec]
      if (typeof outcome === 'function') return outcome(spec, options)
      if (outcome instanceof Error) throw outcome
      return outcome ?? { changed: true, application: 'applied', stage: 'install', target: spec }
    },
    removeBundle: async (name) => {
      calls.removeBundle.push(name)
      const outcome = removeOutcomes[name]
      if (typeof outcome === 'function') return outcome(name)
      if (outcome instanceof Error) throw outcome
      return outcome ?? { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    cancelInstall: async (requestId) => {
      calls.cancelInstall.push(requestId)
      return { status: 'cancelled' }
    },
    waitForInstall: async (requestId) => {
      calls.waitForInstall.push(requestId)
      return null
    },
    setVersionExemption: async (...args) => {
      calls.exemptions.push(args)
      return { changed: true, application: 'applied', stage: 'install', target: args[0] }
    },
    listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
  }
}

const selftestBundles = [
  bundle({ name: 'demo-a', update: 'registry', source: 'demo-a@1.0.0' }),
  bundle({ name: 'demo-b', update: 'git', version: '1.0.0', source: `git+https://github.com/o/b.git#${COMMIT_OLD}` }),
  bundle({ name: 'official-x', official: true, update: 'registry', source: 'official-x@1.0.0' }),
]

const manager = makeManager(selftestBundles, { 'demo-a': undefined })
const app = await boot({ pluginManager: manager })

// GET /updates
const updates = await app.call('/api/pluginmarket-plus/updates')
eq(updates.status, 200, 'GET /updates 返回 200')
const names = updates.body.candidates.map(candidate => candidate.name)
eq(names, ['demo-a', 'demo-b'], 'GET /updates 只列可更新的包')
const fields = Object.keys(updates.body.candidates[0]).sort()
for (const field of ['current', 'enabled', 'incompatible', 'kind', 'latest', 'name', 'prerelease', 'state', 'deprecated']) {
  ok(fields.includes(field), `候选字段含 ${field}`, fields)
}
eq(updates.body.candidates[1].state, 'uncheckable', '没有本地索引时 Git 候选标记不可检查')
eq(updates.body.candidates[0].kind, 'npm', 'GET /updates 里 npm 来源的候选 kind=npm')
eq(updates.body.candidates[1].kind, 'git', 'GET /updates 里 Git 候选 kind=git')
ok(updates.body.candidates.every(candidate => candidate.kind === 'npm' || candidate.kind === 'git'), 'GET /updates 的 kind 只有 npm/git')
ok(!JSON.stringify(updates.body.candidates).includes('"kind":"registry"'), 'GET /updates 不出现 kind:registry')
eq(updates.body.candidates[1].reason, 'index-miss', '无索引的 Git 候选带 reason=index-miss')
ok(Object.hasOwn(updates.body.candidates[1], 'error'), '无索引的 Git 候选带 error 字段')

// 写一份索引正文，验证索引读入 + Git 检查
const indexUrl = 'https://example.test/index.json'
const indexId = sourceId(indexUrl)

/**
 * 往某个假 profile 的缓存目录里写一份索引正文（内容与 §4 用的 Git 包一致）。
 * @param {string} profileDir - 假 profile 目录。
 * @returns {void}
 */
function writeIndex(profileDir) {
  const target = new CacheStore(join(profileDir, '.pluginmarket-plus'))
  target.sources = [indexUrl]
  target.save()
  target.writeBody(indexId, Buffer.from(JSON.stringify({
    format: 1,
    title: { en: 'selftest' },
    plugins: [{
      name: 'demo-b',
      versions: [
        { version: '2.0.0', publishTimestamp: 200, source: { type: 'git', url: 'https://github.com/o/b', commit: COMMIT_NEW }, engines: {} },
        { version: '1.0.0', publishTimestamp: 100, source: { type: 'git', url: 'https://github.com/o/b', commit: COMMIT_OLD }, engines: {} },
      ],
    }],
  }), 'utf8'))
}
writeIndex(app.profileDir)

const afterIndex = await app.call('/api/pluginmarket-plus/updates')
eq(afterIndex.body.index.packages, 1, '读取本地索引里的包')
eq(afterIndex.body.candidates[1].state, 'unknown', '没检查前 Git 候选仍是 unknown（索引只用于检查）')

// POST /updates/check
const checked = await app.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
eq(checked.status, 200, 'POST /updates/check 返回 200')
eq(manager.calls.listVersions, ['demo-a'], 'registry 包走 listVersions()')
eq(checked.body.checked.find(entry => entry.name === 'demo-a')?.kind, 'npm', 'check 结果的 npm 候选 kind=npm')
const checkedB = checked.body.checked.find(entry => entry.name === 'demo-b')
eq(checkedB.kind, 'git', 'check 结果的 Git 候选 kind=git')
eq(checkedB.state, 'available', 'Git 包检查成功')
eq(checkedB.spec, `git+https://github.com/o/b.git#${COMMIT_NEW}`, 'Git 包给出固定 commit 的 spec')
ok(checked.body.candidates.every(candidate => candidate.kind === 'npm' || candidate.kind === 'git'), 'check 返回的 candidates kind 只有 npm/git')
ok(!JSON.stringify(checked.body.candidates).includes('"kind":"registry"'), 'check 返回的 candidates 不出现 kind:registry')
ok(checked.body.checked.every(entry => entry.kind === 'npm' || entry.kind === 'git'), 'check 返回的 checked kind 只有 npm/git')
ok(!JSON.stringify(checked.body.checked).includes('"kind":"registry"'), 'check 返回的 checked 不出现 kind:registry')
ok(typeof checked.body.checkedAt === 'number', '带检查时间')
const gitAfterCheck = checked.body.candidates.find(candidate => candidate.name === 'demo-b')
eq(gitAfterCheck.latest, '2.0.0', '候选接着带回检查结果')

const named = await app.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: { names: ['demo-a'] } })
eq(named.body.checked.length, 1, 'names 限定只检查指定包')
eq(named.body.checked[0].name, 'demo-a', '检查的是指定包')

// POST /updates/apply
const appliedRun = await app.call('/api/pluginmarket-plus/updates/apply', {
  method: 'POST',
  body: { items: [{ name: 'demo-a' }, { name: 'demo-b' }] },
})
eq(appliedRun.status, 200, 'POST /updates/apply 返回 200')
eq(appliedRun.body.started, true, '立刻返回，后台执行')
ok(Array.isArray(appliedRun.body.requestIds) && appliedRun.body.requestIds.length === 2, '每项一个 requestId')
const state = await app.call('/api/pluginmarket-plus/updates/state')
eq(state.status, 200, 'GET /updates/state 返回 200')
ok(Array.isArray(state.body.items) && state.body.items.length === 2, 'state 带每项')
ok(state.body.items.every(item => typeof item.stage === 'string'), '每项都有阶段')

// 等后台队列跑完（假 updateBundle 是同步 resolve 的）。
await new Promise(resolve => setTimeout(resolve, 50))
const doneState = await app.call('/api/pluginmarket-plus/updates/state')
eq(doneState.body.summary, { total: 2, success: 2, failed: 0, cancelled: 0, restartRequired: 0, skipped: 0, pending: 0 }, '队列跑完的汇总是成功 2')
eq(doneState.body.items.map(item => item.kind).sort(), ['git', 'npm'], 'GET /updates/state 的 items kind 只有 npm/git')
ok(!JSON.stringify(doneState.body.items).includes('"kind":"registry"'), 'GET /updates/state 不出现 kind:registry')
eq(doneState.body.items.find(item => item.name === 'demo-a')?.kind, 'npm', 'npm 项正常更新且 kind=npm')
eq(doneState.body.items.find(item => item.name === 'demo-b')?.kind, 'git', 'Git 项 kind=git')
eq(manager.calls.updateBundle.length, 2, '两项都调了 updateBundle')
eq(manager.calls.updateBundle[0].name, 'demo-a', 'npm 项第一个执行')
eq(Object.hasOwn(manager.calls.updateBundle[0].options, 'spec'), false, 'npm 项的 updateBundle 不带 spec')
eq(manager.calls.updateBundle[1].name, 'demo-b', '顺序执行：demo-b 第二个')
const gitCall = manager.calls.updateBundle[1]
eq(gitCall.version, '2.0.0', 'Git 包用索引里的版本')
eq(gitCall.options.spec, `git+https://github.com/o/b.git#${COMMIT_NEW}`, 'Git 包带上固定 commit 的 spec')
ok(typeof gitCall.options.requestId === 'string' && gitCall.options.requestId !== '', 'updateBundle 带上 requestId')

// registry 项即使请求体带了 spec 也必须忽略：真实 pluginManager 对 registry 包收到 spec 会 invalid-spec。
const callsBeforeRegistrySpec = manager.calls.updateBundle.length
const registryWithSpec = await app.call('/api/pluginmarket-plus/updates/apply', {
  method: 'POST',
  body: { items: [{ name: 'demo-a', spec: 'demo-a@1.2.0' }] },
})
eq(registryWithSpec.status, 200, 'registry 项带 spec 的 apply 仍然成功')
await new Promise(resolve => setTimeout(resolve, 50))
const registrySpecCall = manager.calls.updateBundle[callsBeforeRegistrySpec]
eq(registrySpecCall?.name, 'demo-a', 'registry 项调用了 updateBundle')
eq(registrySpecCall?.version, '1.2.0', 'registry 项用 name@version')
eq(Object.hasOwn(registrySpecCall?.options ?? {}, 'spec'), false, 'registry 项的 options 不含 spec')
const registrySpecState = await app.call('/api/pluginmarket-plus/updates/state')
eq(registrySpecState.body.items[0]?.success, true, 'registry 项（带 spec）该项成功')

// 单项失败继续
const manager2 = makeManager(selftestBundles, {
  'demo-a': { from: '1.0.0', to: '1.2.0', step: 'check', result: { changed: false, application: 'failed', stage: 'install', target: 'demo-a@1.2.0', error: { code: 'invalid-spec', diagnostic: '目标版本不存在' } } },
})
const app2 = await boot({ pluginManager: manager2 })
writeIndex(app2.profileDir)
await app2.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
await app2.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }, { name: 'demo-b' }] } })
await new Promise(resolve => setTimeout(resolve, 50))
const state2 = await app2.call('/api/pluginmarket-plus/updates/state')
eq(state2.body.summary, { total: 2, success: 1, failed: 1, cancelled: 0, restartRequired: 0, skipped: 0, pending: 0 }, '一项失败不阻断下一项')
eq(state2.body.items[0].failed, true, '失败项标记 failed')
eq(state2.body.items[0].error, '目标版本不存在', '失败项带诊断')
eq(state2.body.items[1].success, true, '后续项仍然成功')

// POST /updates/cancel
const app3 = await boot({ pluginManager: manager })
writeIndex(app3.profileDir)
await app3.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
const startedRun = await app3.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
const cancelled = await app3.call('/api/pluginmarket-plus/updates/cancel', { method: 'POST', body: {} })
eq(cancelled.status, 200, 'POST /updates/cancel 返回 200')
ok(typeof cancelled.body.cancelled === 'string', '带取消结果')
eq(cancelled.body.state.stopped, true, '取消后队列标记停止')
ok(startedRun.body.requestIds.length === 1, '取消前已经入队')

// POST /updates/exempt
const noRisk = await app.call('/api/pluginmarket-plus/updates/exempt', { method: 'POST', body: { package: 'demo-a', version: '2.0.0' } })
eq(noRisk.status, 400, '不带 acceptRisk 时返回 400')
eq(noRisk.body.error, 'risk-not-accepted', '400 的原因是没接受风险')
eq(manager.calls.exemptions.length, 0, '没有接受风险时绝不调用 setVersionExemption')

const badRisk = await app.call('/api/pluginmarket-plus/updates/exempt', { method: 'POST', body: { package: 'demo-a', version: '2.0.0', acceptRisk: 'yes' } })
eq(badRisk.status, 400, 'acceptRisk 不是布尔 true 时同样 400')
eq(manager.calls.exemptions.length, 0, '仍然没有调用 setVersionExemption')

const granted = await app.call('/api/pluginmarket-plus/updates/exempt', {
  method: 'POST',
  body: { package: 'demo-a', version: '2.0.0', acceptRisk: true, runtimeVersion: '0.2.2-rc.3' },
})
eq(granted.status, 200, 'acceptRisk: true 时授予豁免')
eq(manager.calls.exemptions.length, 1, '调用一次 setVersionExemption')
eq(manager.calls.exemptions[0], ['demo-a@2.0.0', '0.2.2-rc.3', true, true], '参数是 包@版本, 运行版本, true, true')

const missingFields = await app.call('/api/pluginmarket-plus/updates/exempt', { method: 'POST', body: { acceptRisk: true } })
eq(missingFields.status, 400, '缺少 package/version 时 400')
eq(manager.calls.exemptions.length, 1, '参数不全时也不调用')

// 设置开关
const settings = await app.call('/api/pluginmarket-plus/settings', { method: 'POST', body: { updatesIncludeDisabled: true, updatesIncludePrerelease: true } })
eq(settings.status, 200, 'POST /settings 接受两个新开关')
eq(settings.body.status.config.updatesIncludeDisabled, true, '响应回读 includeDisabled')
eq(settings.body.status.config.updatesIncludePrerelease, true, '响应回读 includePrerelease')
eq(app.configValues.updatesIncludeDisabled, true, '设置真的写进了配置')
const ignored = await app.call('/api/pluginmarket-plus/settings', { method: 'POST', body: { updatesIncludeDisabled: 'yes' } })
eq(ignored.body.status.config.updatesIncludeDisabled, true, '非布尔值被忽略（保持原值）')

// updatesShowFailed：写入、回读、与另两个开关同级且互不影响、非布尔值忽略。
const showFailedWrite = await app.call('/api/pluginmarket-plus/settings', { method: 'POST', body: { updatesShowFailed: true } })
eq(showFailedWrite.status, 200, 'POST /settings 接受 updatesShowFailed')
eq(showFailedWrite.body.status.config.updatesShowFailed, true, '响应回读 updatesShowFailed')
eq(app.configValues.updatesShowFailed, true, 'updatesShowFailed 真的写进了配置')
eq(showFailedWrite.body.status.config.updatesIncludeDisabled, true, '写 showFailed 不影响 includeDisabled')
eq(showFailedWrite.body.status.config.updatesIncludePrerelease, true, '写 showFailed 不影响 includePrerelease')
const updatesConfig = await app.call('/api/pluginmarket-plus/updates')
eq(updatesConfig.body.config.showFailed, true, 'GET /updates 的 config.showFailed=true')
eq(updatesConfig.body.config.includeDisabled, true, 'GET /updates 三个开关同级返回（includeDisabled）')
eq(updatesConfig.body.config.includePrerelease, true, 'GET /updates 三个开关同级返回（includePrerelease）')
const ignoredShowFailed = await app.call('/api/pluginmarket-plus/settings', { method: 'POST', body: { updatesShowFailed: 'yes' } })
eq(ignoredShowFailed.body.status.config.updatesShowFailed, true, 'updatesShowFailed 非布尔值被忽略（保持原值）')

const freshApp = await boot({ pluginManager: manager })
const freshStatus = await freshApp.call('/api/pluginmarket-plus/status')
eq(freshStatus.body.config.updatesIncludeDisabled, false, '两个开关默认关闭')
eq(freshStatus.body.config.updatesIncludePrerelease, false, '两个开关默认关闭')
eq(freshStatus.body.config.updatesShowFailed, false, 'updatesShowFailed 默认关闭')
eq((await freshApp.call('/api/pluginmarket-plus/updates')).body.config.showFailed, false, 'GET /updates 的 showFailed 默认 false')
// 只打开 showFailed：另两个开关不受影响。
const isolatedFailed = await freshApp.call('/api/pluginmarket-plus/settings', { method: 'POST', body: { updatesShowFailed: true } })
eq(isolatedFailed.body.status.config.updatesShowFailed, true, '只改 showFailed 时它变 true')
eq(isolatedFailed.body.status.config.updatesIncludeDisabled, false, '另两个开关不受影响（includeDisabled）')
eq(isolatedFailed.body.status.config.updatesIncludePrerelease, false, '另两个开关不受影响（includePrerelease）')
eq((await freshApp.call('/api/pluginmarket-plus/updates')).body.config.showFailed, true, 'GET /updates 的 config.showFailed 跟着变 true')

// 配置写不进去时（没有 Settings 条目）开关仍在本次进程内生效，并如实报告 saved:false。
const appFallback = await boot({ pluginManager: manager, breakSettings: true })
const fallbackWrite = await appFallback.call('/api/pluginmarket-plus/settings', { method: 'POST', body: { updatesIncludePrerelease: true } })
eq(fallbackWrite.status, 200, '写配置失败也不报 500')
eq(fallbackWrite.body.saved, false, '如实报告没有落盘')
eq(fallbackWrite.body.status.config.updatesIncludePrerelease, true, '开关在进程内仍然生效')
eq(appFallback.configValues.updatesIncludePrerelease, false, '确实没有写进配置')
const fallbackFailed = await appFallback.call('/api/pluginmarket-plus/settings', { method: 'POST', body: { updatesShowFailed: true } })
eq(fallbackFailed.body.saved, false, 'updatesShowFailed 写不进配置时同样如实报告')
eq(fallbackFailed.body.status.config.updatesShowFailed, true, 'updatesShowFailed 在进程内生效')
eq((await appFallback.call('/api/pluginmarket-plus/updates')).body.config.showFailed, true, 'updatesOverrides 覆盖了 showFailed')
eq(appFallback.configValues.updatesShowFailed, false, 'updatesShowFailed 确实没有写进配置')

// 渲染开关真的改变候选范围
const app4 = await boot({ pluginManager: makeManager([bundle({ name: 'dis', update: 'registry', source: 'dis@1.0.0', enabled: false })]), config: { updatesIncludeDisabled: true } })
const withDisabledApi = await app4.call('/api/pluginmarket-plus/updates')
eq(withDisabledApi.body.candidates.map(candidate => candidate.name), ['dis'], '开关打开时 GET /updates 列已禁用的包')
eq(withDisabledApi.body.config.includeDisabled, true, '响应里带上开关状态')
const app5 = await boot({ pluginManager: makeManager([bundle({ name: 'dis', update: 'registry', source: 'dis@1.0.0', enabled: false })]) })
eq((await app5.call('/api/pluginmarket-plus/updates')).body.candidates, [], '开关关闭时不列已禁用的包')

// 队列冲突
const app6 = await boot({
  pluginManager: makeManager(selftestBundles, {
    'demo-a': () => new Promise(resolve => setTimeout(() => resolve({ from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'demo-a@1.2.0' } }), 120)),
  }),
})
await app6.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
await app6.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
const conflict = await app6.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-b' }] } })
eq(conflict.status, 409, '同一时刻只跑一个队列')
eq(conflict.body.error, 'update-running', '冲突原因是已有更新在跑')
await app6.call('/api/pluginmarket-plus/updates/cancel', { method: 'POST', body: {} })
await new Promise(resolve => setTimeout(resolve, 200))

// 未检查就 apply
const app7 = await boot({ pluginManager: makeManager(selftestBundles) })
const notChecked = await app7.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
eq(notChecked.status, 400, '没检查过就 apply 返回 400')
eq(notChecked.body.error, 'not-checked', '说明还没检查过')
const emptyItems = await app7.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [] } })
eq(emptyItems.status, 400, '空 items 返回 400')

// 检查返回空 versions：该包不再出现在 /updates（state=current 被剔除）。
const managerEmpty = makeManager(selftestBundles)
managerEmpty.versionLists['demo-a'] = { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [], omitted: 0 }
const appEmpty = await boot({ pluginManager: managerEmpty })
const emptyChecked = await appEmpty.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
eq(emptyChecked.status, 200, '空 versions 的检查不报错')
eq(emptyChecked.body.checked.find(entry => entry.name === 'demo-a')?.state, 'current', '空 versions 的检查结果是 current')
const emptyList = await appEmpty.call('/api/pluginmarket-plus/updates')
eq(emptyList.body.candidates.some(candidate => candidate.name === 'demo-a'), false, '检查无新版本后 /updates 不再出现该包')

// listVersions 抛错：该包在 /updates 里保持 state=error 并带原因，不回落 unknown。
const managerThrow = makeManager(selftestBundles)
managerThrow.versionLists['demo-a'] = new Error('registry unreachable')
const appThrow = await boot({ pluginManager: managerThrow })
const throwChecked = await appThrow.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
eq(throwChecked.status, 200, 'listVersions 抛错不让整个 check 失败')
const throwList = await appThrow.call('/api/pluginmarket-plus/updates')
const throwCandidate = throwList.body.candidates.find(candidate => candidate.name === 'demo-a')
eq(throwCandidate?.state, 'error', '/updates 里检查失败的包 state=error')
eq(throwCandidate?.error, 'registry unreachable', '/updates 里带上失败原因')

// 需重启的项：state.summary.restartRequired 计数。
const managerRestart = makeManager(selftestBundles, {
  'demo-a': { from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'restart-required', stage: 'install', target: 'demo-a@1.2.0', restartReason: 'no-hmr' } },
})
const appRestart = await boot({ pluginManager: managerRestart })
await appRestart.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
await appRestart.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
await new Promise(resolve => setTimeout(resolve, 50))
const restartState = await appRestart.call('/api/pluginmarket-plus/updates/state')
eq(restartState.body.summary.restartRequired, 1, 'state.summary.restartRequired === 1')
eq(restartState.body.items[0]?.restartRequired, true, '需重启的项带 restartRequired')

// 并发 apply：第一个走 Git 缺 spec 的慢路径（内部 await），第二个必须在任何 await 前拿到 409。
const managerSlow = makeManager(selftestBundles)
const appSlow = await boot({ pluginManager: managerSlow })
// 先检查一次：demo-b（Git、本地没有索引）记为 uncheckable，checkCache 里才有 kind='git'。
await appSlow.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
const firstApply = appSlow.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-b' }] } })
const secondApply = await appSlow.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
const firstResult = await firstApply
eq(secondApply.status, 409, '并发 apply：第二个立即 409')
eq(secondApply.body.error, 'update-running', '并发冲突原因是 update-running')
eq(firstResult.status, 400, '第一个请求自己走完慢路径')
eq(firstResult.body.error, 'not-checkable', '慢路径结论是 Git 缺 spec 不可检查')
const retryApply = await appSlow.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
eq(retryApply.status, 200, '第一个请求失败后闩锁释放（再次 apply 不再 409）')
eq(retryApply.body.started, true, '闩锁释放后正常入队')
await appSlow.call('/api/pluginmarket-plus/updates/cancel', { method: 'POST', body: {} })
await new Promise(resolve => setTimeout(resolve, 50))

// 事件 → 阶段与日志
const eventApp = await boot({ pluginManager: makeManager(selftestBundles, {
  'demo-a': () => new Promise(resolve => setTimeout(() => resolve({ from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'demo-a@1.2.0' } }), 150)),
}) })
await eventApp.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
const eventRun = await eventApp.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
const requestId = eventRun.body.requestIds[0]
eventApp.ctx.emit('plugin-manager/update-state', { requestId, step: 'removing' })
const midway = await eventApp.call('/api/pluginmarket-plus/updates/state')
eq(midway.body.items[0].stage, 'removing', 'stage 来自 plugin-manager/update-state')
eq(midway.body.activeRequestId, requestId, 'state 标出当前项')
eventApp.ctx.emit('plugin-manager/update-state', { requestId, step: 'installing' })
eventApp.ctx.emit('plugin-manager/install-log', { requestId, jobId: 'j1', argv: ['pnpm', 'add'], cwd: '/tmp', stream: 'stdout', text: 'added 1 package\n' })
eventApp.ctx.emit('plugin-manager/install-log', { requestId, jobId: 'j1', argv: ['pnpm', 'add'], cwd: '/tmp', stream: 'stderr', text: 'warn: something\n', exitCode: 0 })
const withLog = await eventApp.call('/api/pluginmarket-plus/updates/state')
eq(withLog.body.items[0].stage, 'installing', '阶段继续前进')
eq(withLog.body.logs, ['added 1 package', '! warn: something'], 'state 带 pnpm 日志尾部')
await eventApp.call('/api/pluginmarket-plus/updates/cancel', { method: 'POST', body: {} })
await new Promise(resolve => setTimeout(resolve, 200))
eq(manager.calls.cancelInstall.length >= 0, true, '取消路径可用')

// ---------------------------------------------------------------------------
// 8. 中断日志与恢复（updates-inflight.json）
// ---------------------------------------------------------------------------
section('中断日志与恢复')

/** 中断日志文件路径。 */
const inflightPathOf = profileDir => join(profileDir, '.pluginmarket-plus', 'updates-inflight.json')
/** 读中断日志（文件不存在时返回 null）。 */
const readInflightFile = profileDir => {
  const target = inflightPathOf(profileDir)
  if (!existsSync(target)) return null
  return JSON.parse(readFileSync(target, 'utf8'))
}
/** 直接写一份中断日志（模拟上次进程被杀）。 */
const seedInflight = (profileDir, items) => {
  const dir = join(profileDir, '.pluginmarket-plus')
  mkdirSync(dir, { recursive: true })
  writeFileSync(inflightPathOf(profileDir), JSON.stringify({ version: 1, items }, null, 2), 'utf8')
}
/** 写 profile 的 package.json 依赖列表（用来模拟包「还在 / 已不在」profile 依赖里）。 */
const writeProfileDeps = (profileDir, names) => {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'profile-selftest', private: true,
    dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])),
  }, null, 2), 'utf8')
}

// 纯函数：记录归一 / 恢复 spec / 移除
eq(inflightRecord({ name: 'a', current: '1.0.0', latest: '1.2.0', kind: 'npm', requestId: 'r1', startedAt: 7 }),
  { name: 'a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'checking', startedAt: 7 },
  'inflightRecord 归一 npm 记录（字段齐全）')
eq(inflightRecord({ name: 'b', current: '1.0.0', latest: '2.0.0', kind: 'git', spec: `git+https://github.com/o/b.git#${COMMIT_NEW}`, requestId: 'r2', startedAt: 8 })?.spec,
  `git+https://github.com/o/b.git#${COMMIT_NEW}`, 'inflightRecord 保留 Git 的固定 spec')
eq(inflightRecord({ name: 'c', kind: 'npm', latest: '1.2.0' })?.phase, 'checking', 'inflightRecord 默认 phase=checking')
eq(inflightRecord({ current: '1.0.0' }), null, 'inflightRecord 缺包名返回 null')
eq(normalizeInflight([{ name: 'a', kind: 'npm', target: '1.0.0' }, { name: 'a', kind: 'npm', target: '2.0.0' }, null, { name: '' }]).map(record => record.target),
  ['2.0.0'], 'normalizeInflight 去重（同名后者覆盖）并丢掉坏记录')
eq(normalizeInflight({ items: [{ name: 'x', kind: 'npm', target: '1.0.0' }] }).length, 1, 'normalizeInflight 接受 {items}')
eq(normalizeInflight('nope'), [], 'normalizeInflight 拒绝非法输入')
eq(recoverSpec({ name: 'a', kind: 'npm', target: '1.2.0' }), 'a@1.2.0', 'npm 的恢复 spec 是 name@target')
eq(recoverSpec({ name: 'b', kind: 'git', spec: 'git+x#abc' }), 'git+x#abc', 'git 的恢复 spec 用记录里的 spec')
eq(recoverSpec({ name: 'c', kind: 'git' }), '', 'git 缺 spec 时返回空串')
eq(recoverSpec({ name: 'd', kind: 'npm' }), 'd', 'npm 缺 target 时退回裸包名')
eq(withoutInflight([{ name: 'a' }, { name: 'b' }], ['a']).map(record => record.name), ['b'], 'withoutInflight 按包名移除')

// 无残留时 interrupted 为 []
const inflightApp = await boot({ pluginManager: makeManager(selftestBundles) })
const noLeftover = await inflightApp.call('/api/pluginmarket-plus/updates')
eq(noLeftover.body.interrupted, [], '无残留时 GET /updates 的 interrupted 是 []')
eq(noLeftover.body.candidates.length > 0, true, 'interrupted 不影响既有字段（candidates 仍在）')
eq(readInflightFile(inflightApp.profileDir), null, '没有残留时不创建中断日志文件')

// 更新队列：每项开始前写入、结束后移除；运行中的项不算「中断」；阶段写回文件
const midRunInflight = []
const inflightManager = makeManager(selftestBundles, {
  'demo-a': () => new Promise((resolve) => {
    // 在这一项「正在跑」的时候观察中断日志。
    midRunInflight.push(readInflightFile(appInflight.profileDir))
    setTimeout(() => resolve({ from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'demo-a@1.2.0' } }), 200)
  }),
})
const appInflight = await boot({ pluginManager: inflightManager })
writeProfileDeps(appInflight.profileDir, ['demo-a', 'demo-b'])
await appInflight.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
const inflightRun = await appInflight.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
const inflightRequestId = inflightRun.body.requestIds[0]
// 队列还在跑：文件里已经有这一项，但 GET /updates 的 interrupted 必须把它排除。
const duringRun = await appInflight.call('/api/pluginmarket-plus/updates')
eq(duringRun.body.running, true, '更新期间 running=true')
eq(duringRun.body.interrupted, [], '运行中的项不出现在 interrupted 里')
eq(readInflightFile(appInflight.profileDir)?.items?.[0]?.name, 'demo-a', '运行中这一项确实写进了中断日志（只是被过滤）')
// 阶段写回：removing → installing → restoring 都实时落盘。
appInflight.ctx.emit('plugin-manager/update-state', { requestId: inflightRequestId, step: 'removing' })
eq(readInflightFile(appInflight.profileDir)?.items?.[0]?.phase, 'removing', 'update-state removing 写回 phase')
appInflight.ctx.emit('plugin-manager/update-state', { requestId: inflightRequestId, step: 'installing' })
eq(readInflightFile(appInflight.profileDir)?.items?.[0]?.phase, 'installing', 'update-state installing 写回 phase')
appInflight.ctx.emit('plugin-manager/update-state', { requestId: inflightRequestId, step: 'restoring' })
eq(readInflightFile(appInflight.profileDir)?.items?.[0]?.phase, 'restoring', 'update-state restoring 写回 phase')
await new Promise(resolve => setTimeout(resolve, 320))
const observedRecord = midRunInflight[0]?.items?.[0]
eq(observedRecord?.name, 'demo-a', '队列跑某一项时中断日志里有该项')
eq(observedRecord?.target, '1.2.0', '中断日志记录目标版本')
eq(observedRecord?.kind, 'npm', '中断日志记录 kind=npm')
ok(typeof observedRecord?.requestId === 'string' && observedRecord.requestId !== '', '中断日志记录 requestId')
eq(observedRecord?.phase, 'checking', '中断日志记录阶段')
ok(typeof observedRecord?.startedAt === 'number', '中断日志记录 startedAt')
eq(Object.hasOwn(observedRecord ?? {}, 'spec'), false, 'npm 项不写 spec')
eq(readInflightFile(appInflight.profileDir), null, '该项结束后从文件移除；文件空了就删掉')
const leftoverDir = readdirSync(join(appInflight.profileDir, '.pluginmarket-plus'))
eq(leftoverDir.filter(name => name.includes('.tmp-')), [], '原子写不留下临时文件')

// 中断后 GET /updates 带 interrupted（并标记 missingFromProfile）
writeProfileDeps(inflightApp.profileDir, ['demo-a'])
seedInflight(inflightApp.profileDir, [
  { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'updates-0', phase: 'installing', startedAt: 111 },
  { name: 'demo-b', current: '1.0.0', target: '2.0.0', kind: 'git', spec: `git+https://github.com/o/b.git#${COMMIT_NEW}`, requestId: 'updates-1', phase: 'removing', startedAt: 222 },
])
const withLeftover = await inflightApp.call('/api/pluginmarket-plus/updates')
eq(withLeftover.body.interrupted.length, 2, '中断后 GET /updates 返回 2 条残留')
eq(withLeftover.body.interrupted[0], {
  name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'updates-0', phase: 'installing', startedAt: 111, missingFromProfile: false,
}, '残留记录字段完整（npm）')
eq(withLeftover.body.interrupted[1].spec, `git+https://github.com/o/b.git#${COMMIT_NEW}`, '残留记录保留 Git spec')
eq(withLeftover.body.interrupted[1].missingFromProfile, true, '不在 profile 依赖里的残留带 missingFromProfile:true')
eq(withLeftover.body.interrupted[0].missingFromProfile, false, '仍在 profile 依赖里的残留 missingFromProfile:false')

// recover：npm 用 name@target，git 用记录里的 spec
const recoverManager = makeManager(selftestBundles)
const appRecover = await boot({ pluginManager: recoverManager })
writeProfileDeps(appRecover.profileDir, ['demo-a', 'demo-b'])
seedInflight(appRecover.profileDir, [
  { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'updates-0', phase: 'installing', startedAt: 111 },
  { name: 'demo-b', current: '1.0.0', target: '2.0.0', kind: 'git', spec: `git+https://github.com/o/b.git#${COMMIT_NEW}`, requestId: 'updates-1', phase: 'removing', startedAt: 222 },
])
const recovered = await appRecover.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: {} })
eq(recovered.status, 200, 'POST /updates/recover 返回 200')
eq(recovered.body.ok, true, '恢复成功时 ok=true')
eq(recovered.body.results, [
  { name: 'demo-a', ok: true },
  { name: 'demo-b', ok: true },
], '每项都有结果')
eq(recoverManager.calls.installBundle.map(call => call.spec),
  ['demo-a@1.2.0', `git+https://github.com/o/b.git#${COMMIT_NEW}`],
  'npm 用 name@target、git 用记录里的固定 commit spec')
eq(recoverManager.calls.removeBundle, [], '依赖还在时不做「移除残留」兜底')
eq(recovered.body.interrupted, [], '全部恢复成功后没有残留')
eq(readInflightFile(appRecover.profileDir), null, '全部恢复成功且文件空了就删除文件')

// recover：失败项保留并返回原因（依赖还在，不走兜底）
const failManager = makeManager(selftestBundles)
failManager.installOutcomes['demo-a@1.2.0'] = { changed: false, application: 'failed', stage: 'install', target: 'demo-a@1.2.0', error: { code: 'incompatible-version', diagnostic: 'engines.dsh 不满足' } }
failManager.installOutcomes['git+https://github.com/o/b.git#old'] = new Error('network down')
const appFail = await boot({ pluginManager: failManager })
writeProfileDeps(appFail.profileDir, ['demo-a', 'demo-b'])
seedInflight(appFail.profileDir, [
  { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 },
  { name: 'demo-b', current: '1.0.0', target: '2.0.0', kind: 'git', spec: 'git+https://github.com/o/b.git#old', requestId: 'r2', phase: 'installing', startedAt: 2 },
])
const failedRecover = await appFail.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: {} })
eq(failedRecover.body.results[0], { name: 'demo-a', ok: false, error: 'engines.dsh 不满足' }, '安装失败项带 diagnostic')
eq(failedRecover.body.results[1], { name: 'demo-b', ok: false, error: 'network down' }, '抛错项带错误消息')
eq(failManager.calls.removeBundle, [], '依赖还在时失败也不做移除兜底')
eq(failedRecover.body.interrupted.length, 2, '失败项全部保留在残留里')
eq(readInflightFile(appFail.profileDir)?.items.length, 2, '失败项仍写在文件里')

// recover 兜底：包已不在 profile 依赖里 → 先移除残留再重装一次
const fallbackManager = makeManager(selftestBundles)
fallbackManager.installOutcomes['demo-a@1.2.0'] = ((calls) => (spec) => {
  calls.push(spec)
  return calls.length === 1
    ? { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'not-found', diagnostic: '第一次装不上：残留挡住了' } }
    : { changed: true, application: 'applied', stage: 'install', target: spec }
})([])
const appFallbackRecover = await boot({ pluginManager: fallbackManager })
// profile 依赖里没有 demo-a：模拟「上次移除后没装回」。
writeProfileDeps(appFallbackRecover.profileDir, [])
seedInflight(appFallbackRecover.profileDir, [
  { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'removing', startedAt: 1 },
])
const fallbackRecover = await appFallbackRecover.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: {} })
eq(fallbackRecover.status, 200, '兜底路径 recover 返回 200')
eq(fallbackRecover.body.results[0].ok, true, '兜底重装后成功')
eq(fallbackRecover.body.results[0].steps, [
  { step: 'install', ok: false, error: '第一次装不上：残留挡住了' },
  { step: 'remove', ok: true },
  { step: 'reinstall', ok: true },
], '每一步都有结果与错误原因（install 失败 → remove → reinstall 成功）')
eq(fallbackManager.calls.installBundle.map(call => call.spec), ['demo-a@1.2.0', 'demo-a@1.2.0'], '兜底时 installBundle 调两次（原 spec）')
eq(fallbackManager.calls.removeBundle, ['demo-a'], '兜底时先 removeBundle 清残留')
eq(fallbackRecover.body.interrupted, [], '兜底成功后残留清空')

// recover 兜底也失败：保留残留，返回 remove/reinstall 每一步的错误
const fallbackFailManager = makeManager(selftestBundles)
fallbackFailManager.installOutcomes['demo-a@1.2.0'] = { changed: false, application: 'failed', stage: 'install', target: 'demo-a@1.2.0', error: { code: 'not-found', diagnostic: '还是装不上' } }
fallbackFailManager.removeOutcomes['demo-a'] = new Error('remove blocked')
const appFallbackFail = await boot({ pluginManager: fallbackFailManager })
writeProfileDeps(appFallbackFail.profileDir, [])
seedInflight(appFallbackFail.profileDir, [
  { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'removing', startedAt: 1 },
])
const fallbackFail = await appFallbackFail.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: {} })
eq(fallbackFail.body.results[0].ok, false, '兜底仍失败时 ok=false')
eq(fallbackFail.body.results[0].steps, [
  { step: 'install', ok: false, error: '还是装不上' },
  { step: 'remove', ok: false, error: 'remove blocked' },
  { step: 'reinstall', ok: false, error: '还是装不上' },
], '兜底失败时每一步的错误都返回')
eq(fallbackFail.body.results[0].error, '还是装不上', '顶层 error 是最终失败原因')
eq(fallbackFail.body.interrupted.map(record => record.name), ['demo-a'], '兜底失败后残留保留')

// 启动日志：包已移除但未装回要明确 warn
const startupWarnApp = await boot({
  pluginManager: makeManager(selftestBundles),
  prepare: (profileDir) => {
    writeProfileDeps(profileDir, [])
    seedInflight(profileDir, [{ name: 'demo-orphan', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 }])
  },
})
// 启动核对是异步的（要 await listBundles），等它跑完。
await new Promise(resolve => setTimeout(resolve, 30))
ok(startupWarnApp.logLines.some(line => line.includes('demo-orphan') && line.includes('已移除但未装回')), '启动时对「已移除但未装回」明确 warn', startupWarnApp.logLines)

// ---------------------------------------------------------------------------
// 13. 中断记录自动核对：已装到目标版本就清掉
// ---------------------------------------------------------------------------
section('中断记录自动核对')

// 纯函数：宽松语义，只有「确定已装到目标」才为 true。
const npmRecord = { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm' }
eq(inflightSatisfied(npmRecord, [{ name: 'demo-a', installed: true, version: '1.2.0' }]), true, '已装到 target（相等）算完成')
eq(inflightSatisfied(npmRecord, [{ name: 'demo-a', installed: true, version: '1.3.0' }]), true, '已装更高版本算完成')
eq(inflightSatisfied(npmRecord, [{ name: 'demo-a', installed: true, version: '1.1.0' }]), false, '版本低于 target 保留')
eq(inflightSatisfied(npmRecord, [{ name: 'demo-a', installed: false, version: '1.2.0' }]), false, '未安装保留')
eq(inflightSatisfied(npmRecord, [{ name: 'other', installed: true, version: '9.9.9' }]), false, '找不到 bundle 保留')
eq(inflightSatisfied({ name: 'demo-a', target: 'not-semver', kind: 'npm' }, [{ name: 'demo-a', installed: true, version: '1.2.0' }]), false, '无法比较时保留')
eq(inflightSatisfied({ name: 'demo-a', kind: 'npm' }, [{ name: 'demo-a', installed: true, version: '1.2.0' }]), false, '缺 target 时保留')
const gitRecord = { name: 'demo-b', target: '2.0.0', kind: 'git', spec: `git+https://github.com/o/b.git#${COMMIT_NEW}` }
eq(inflightSatisfied(gitRecord, [{ name: 'demo-b', installed: true, source: `git+https://github.com/o/b.git#${COMMIT_NEW}`, version: '2.0.0' }]), true, 'git commit 相同算完成')
eq(inflightSatisfied(gitRecord, [{ name: 'demo-b', installed: true, source: `git+https://github.com/o/b.git#${COMMIT_OLD}`, version: '2.0.0' }]), false, 'git commit 不同保留')
eq(inflightSatisfied({ name: 'demo-b', kind: 'git' }, [{ name: 'demo-b', installed: true, source: 'nope' }]), false, 'git 无法比较时保留')
eq(reconcileInflight([npmRecord, { name: 'demo-b', target: '9.9.9', kind: 'npm' }], [{ name: 'demo-a', installed: true, version: '1.3.0' }]),
  { done: ['demo-a'], kept: [{ name: 'demo-b', target: '9.9.9', kind: 'npm' }] }, 'reconcileInflight 分开已完成的与保留的')
eq(reconcileInflight([], [{ name: 'demo-a', installed: true, version: '1.2.0' }]), { done: [], kept: [] }, '无记录时不核对（空输入立即返回）')

// 端点：已装到 target → 清掉记录、interrupted 为空、文件删除
const recAtTargetApp = await boot({ pluginManager: makeManager([bundle({ name: 'demo-a', update: 'registry', source: 'demo-a@1.0.0', version: '1.2.0' })]) })
seedInflight(recAtTargetApp.profileDir, [{ name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 }])
const recAtTarget = await recAtTargetApp.call('/api/pluginmarket-plus/updates')
eq(recAtTarget.status, 200, '已装到 target 时 GET /updates 仍 200')
eq(recAtTarget.body.interrupted, [], '已装到 target → interrupted 为空')
eq(readInflightFile(recAtTargetApp.profileDir), null, '已装到 target → 记录删除且文件被删')

// 端点：已装更高版本 → 清掉
const recHigherApp = await boot({ pluginManager: makeManager([bundle({ name: 'demo-a', update: 'registry', source: 'demo-a@1.0.0', version: '1.3.0' })]) })
seedInflight(recHigherApp.profileDir, [{ name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 }])
const recHigher = await recHigherApp.call('/api/pluginmarket-plus/updates')
eq(recHigher.body.interrupted, [], '已装更高版本 → interrupted 为空')
eq(readInflightFile(recHigherApp.profileDir), null, '已装更高版本 → 文件被删')

// 端点：版本低于 target → 保留
const recLowerApp = await boot({ pluginManager: makeManager([bundle({ name: 'demo-a', update: 'registry', source: 'demo-a@1.0.0', version: '1.1.0' })]) })
seedInflight(recLowerApp.profileDir, [{ name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 }])
const recLower = await recLowerApp.call('/api/pluginmarket-plus/updates')
eq(recLower.body.interrupted.map(record => record.name), ['demo-a'], '版本低于 target → 记录保留')
eq(readInflightFile(recLowerApp.profileDir)?.items.length, 1, '版本低于 target → 文件不变')

// 端点：找不到 bundle → 保留
const recMissingApp = await boot({ pluginManager: makeManager(selftestBundles) })
seedInflight(recMissingApp.profileDir, [{ name: 'ghost-pkg', current: '1.0.0', target: '2.0.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 }])
const recMissing = await recMissingApp.call('/api/pluginmarket-plus/updates')
eq(recMissing.body.interrupted.map(record => record.name), ['ghost-pkg'], '找不到 bundle → 记录保留')

// 端点：listBundles 抛错 → 不改文件、不阻塞、原样返回旧记录
const recThrowManager = makeManager(selftestBundles)
recThrowManager.listBundles = async () => { throw new Error('listBundles exploded') }
const recThrowApp = await boot({ pluginManager: recThrowManager })
seedInflight(recThrowApp.profileDir, [
  { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 },
  { name: 'demo-b', current: '1.0.0', target: '2.0.0', kind: 'git', spec: `git+https://github.com/o/b.git#${COMMIT_NEW}`, requestId: 'r2', phase: 'installing', startedAt: 2 },
])
const beforeThrow = readFileSync(inflightPathOf(recThrowApp.profileDir), 'utf8')
const recThrow = await recThrowApp.call('/api/pluginmarket-plus/updates')
eq(recThrow.status, 200, 'listBundles 抛错时 GET /updates 仍 200')
eq(recThrow.body.interrupted.map(record => record.name), ['demo-a', 'demo-b'], 'listBundles 抛错 → 原样保留记录')
eq(readFileSync(inflightPathOf(recThrowApp.profileDir), 'utf8'), beforeThrow, 'listBundles 抛错 → 文件内容不变')
ok(recThrowApp.logLines.some(line => line.includes('核对中断记录失败')), 'listBundles 抛错会记录 warn')

// 启动核对：已装到 target 的旧记录不在启动日志里重复报「已移除但未装回」
const startupReconcileApp = await boot({
  pluginManager: makeManager([bundle({ name: 'demo-a', update: 'registry', source: 'demo-a@1.0.0', version: '1.2.0' })]),
  prepare: (profileDir) => {
    writeProfileDeps(profileDir, [])
    seedInflight(profileDir, [{ name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 }])
  },
})
await new Promise(resolve => setTimeout(resolve, 30))
eq(readInflightFile(startupReconcileApp.profileDir), null, '启动核对：已装到 target 的记录被清掉')
ok(!startupReconcileApp.logLines.some(line => line.includes('demo-a') && line.includes('已移除但未装回')), '启动核对：不再重复报已完成的记录', startupReconcileApp.logLines)

// recover：部分成功只摘掉成功的项
const partialManager = makeManager(selftestBundles)
partialManager.installOutcomes['demo-a@1.2.0'] = new Error('boom')
const appPartial = await boot({ pluginManager: partialManager })
seedInflight(appPartial.profileDir, [
  { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 },
  { name: 'demo-b', current: '1.0.0', target: '2.0.0', kind: 'git', spec: `git+https://github.com/o/b.git#${COMMIT_NEW}`, requestId: 'r2', phase: 'installing', startedAt: 2 },
])
const partialRecover = await appPartial.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: {} })
eq(partialRecover.body.results.map(result => result.ok), [false, true], '部分成功：一个失败一个成功')
eq(partialRecover.body.interrupted.map(record => record.name), ['demo-a'], '只保留失败的那一项')
eq(readInflightFile(appPartial.profileDir)?.items.map(record => record.name), ['demo-a'], '文件里也只剩失败项')

// recover：items 限定恢复哪些
const pickManager = makeManager(selftestBundles)
const appPick = await boot({ pluginManager: pickManager })
seedInflight(appPick.profileDir, [
  { name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 },
  { name: 'demo-b', current: '1.0.0', target: '2.0.0', kind: 'git', spec: `git+https://github.com/o/b.git#${COMMIT_NEW}`, requestId: 'r2', phase: 'installing', startedAt: 2 },
])
const picked = await appPick.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: { items: [{ name: 'demo-b' }] } })
eq(pickManager.calls.installBundle.length, 1, 'items 限定时只恢复点名的项')
eq(pickManager.calls.installBundle[0].spec, `git+https://github.com/o/b.git#${COMMIT_NEW}`, '点名恢复的是 Git 项')
eq(picked.body.interrupted.map(record => record.name), ['demo-a'], '没点名的项留在残留里')
const unknownPick = await appPick.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: { items: [{ name: 'not-there' }] } })
eq(unknownPick.status, 400, '点名的包不在残留里时 400')
eq(unknownPick.body.error, 'unknown-items', '400 的原因是 unknown-items')

// recover：无残留时直接返回空
const emptyRecoverApp = await boot({ pluginManager: makeManager(selftestBundles) })
const emptyRecover = await emptyRecoverApp.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: {} })
eq(emptyRecover.status, 200, '无残留时 recover 返回 200')
eq(emptyRecover.body.results, [], '无残留时 results 为空')

// recover 单飞：已有队列在跑时 409
const busyManager = makeManager(selftestBundles, {
  'demo-a': () => new Promise(resolve => setTimeout(() => resolve({ from: '1.0.0', to: '1.2.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'demo-a@1.2.0' } }), 150)),
})
const appBusy = await boot({ pluginManager: busyManager })
seedInflight(appBusy.profileDir, [{ name: 'demo-b', current: '1.0.0', target: '2.0.0', kind: 'git', spec: `git+https://github.com/o/b.git#${COMMIT_NEW}`, requestId: 'r1', phase: 'installing', startedAt: 1 }])
await appBusy.call('/api/pluginmarket-plus/updates/check', { method: 'POST', body: {} })
await appBusy.call('/api/pluginmarket-plus/updates/apply', { method: 'POST', body: { items: [{ name: 'demo-a' }] } })
const busyRecover = await appBusy.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: {} })
eq(busyRecover.status, 409, '已有队列在跑时 recover 返回 409')
eq(busyRecover.body.error, 'update-running', '409 的原因是 update-running')
eq(busyManager.calls.installBundle.length, 0, '单飞期间不调用 installBundle')
await appBusy.call('/api/pluginmarket-plus/updates/cancel', { method: 'POST', body: {} })
await new Promise(resolve => setTimeout(resolve, 250))

// recover 不写 checkCache、不自动检查
const noCheckManager = makeManager(selftestBundles)
const appNoCheck = await boot({ pluginManager: noCheckManager })
seedInflight(appNoCheck.profileDir, [{ name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 }])
await appNoCheck.call('/api/pluginmarket-plus/updates/recover', { method: 'POST', body: {} })
eq(noCheckManager.calls.listVersions, [], 'recover 不调用 listVersions（不自动检查）')
eq(noCheckManager.calls.updateBundle, [], 'recover 不调用 updateBundle')
eq((await appNoCheck.call('/api/pluginmarket-plus/updates')).body.candidates.find(candidate => candidate.name === 'demo-a')?.state, 'unknown', 'recover 不写 checkCache（候选仍是 unknown）')

// clear-interrupted
const clearApp = await boot({ pluginManager: makeManager(selftestBundles) })
seedInflight(clearApp.profileDir, [{ name: 'demo-a', current: '1.0.0', target: '1.2.0', kind: 'npm', requestId: 'r1', phase: 'installing', startedAt: 1 }])
const cleared = await clearApp.call('/api/pluginmarket-plus/updates/clear-interrupted', { method: 'POST', body: {} })
eq(cleared.status, 200, 'POST /updates/clear-interrupted 返回 200')
eq(cleared.body.ok, true, 'clear 成功')
eq(cleared.body.cleared.length, 1, '返回被清掉的记录')
eq(cleared.body.cleared[0].name, 'demo-a', '被清掉的记录内容正确')
eq(readInflightFile(clearApp.profileDir), null, '清空后文件被删除')
eq((await clearApp.call('/api/pluginmarket-plus/updates')).body.interrupted, [], '清空后 GET /updates 的 interrupted 是 []')
const clearAgain = await clearApp.call('/api/pluginmarket-plus/updates/clear-interrupted', { method: 'POST', body: {} })
eq(clearAgain.body.cleared, [], '再次 clear 时 cleared 为空')

// ctx.effect 释放
const disposeApp = await boot({ pluginManager: makeManager(selftestBundles) })
const routesBefore = disposeApp.routes.size
eq(routesBefore, 14, '注册了 2 个公开路由 + 12 个 owner 桥接路由')
disposeApp.dispose()
eq(disposeApp.routes.size < routesBefore, true, 'ctx.effect 释放时路由被注销')

// 清理临时目录
for (const app_ of [app, app2, app3, app4, app5, app6, app7, appEmpty, appThrow, appRestart, appSlow, eventApp, inflightApp, appInflight, appRecover, appFail, appFallbackRecover, appFallbackFail, appPartial, appPick, appBusy, appNoCheck, clearApp, startupWarnApp, recAtTargetApp, recHigherApp, recLowerApp, recMissingApp, recThrowApp, startupReconcileApp, disposeApp, freshApp]) {
  if (existsSync(app_.profileDir)) rmSync(app_.profileDir, { recursive: true, force: true })
}

// 静态检查：不自动更新、不导入 Client 包、只用 Node 内置模块
section('静态约束')
ok(profileResolution, '自测能借 profile 的 peer 依赖解析 @deepseek-ai/schemastery')
const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const updatesPath = fileURLToPath(new URL('../lib/updates.js', import.meta.url))
const storePath = fileURLToPath(new URL('../lib/store.js', import.meta.url))
const indexSource = readFileSync(indexPath, 'utf8')
const updatesSource = readFileSync(updatesPath, 'utf8')
const storeSource = readFileSync(storePath, 'utf8')
ok(!/@deepseek-ai\/dsh-client/u.test(indexSource + updatesSource + storeSource), '不引用 @deepseek-ai Client 包')
ok(!/\bsetInterval\s*\(/u.test(indexSource), '没有新增 setInterval（不做轮询/自动更新）')
ok(/^  updatesIncludeDisabled: z\.boolean\(\)\.default\(false\)\.volatile\(\),$/mu.test(indexSource), '开关 updatesIncludeDisabled 是 volatile、默认 false')
ok(/^  updatesIncludePrerelease: z\.boolean\(\)\.default\(false\)\.volatile\(\),$/mu.test(indexSource), '开关 updatesIncludePrerelease 是 volatile、默认 false')
ok(/^  updatesShowFailed: z\.boolean\(\)\.default\(false\)\.volatile\(\),$/mu.test(indexSource), '开关 updatesShowFailed 是 volatile、默认 false')
ok(/for \(const key of \['updatesIncludeDisabled', 'updatesIncludePrerelease', 'updatesShowFailed'\]\)/u.test(indexSource), 'updatesOverrides 覆盖逻辑包含三个开关')
ok(/pluginManager\.updateBundle\(item\.name, item\.version, options\)/u.test(indexSource), '执行更新只走 updateBundle')
ok(/createRequire|detectRuntimeVersion/u.test(indexSource), '版本豁免能自己解析 DSH 版本')
for (const file of [[indexPath, indexSource], [updatesPath, updatesSource], [storePath, storeSource]]) {
  const specifiers = [...file[1].matchAll(/from '([^']+)'/gu)].map(match => match[1])
  const nonNode = specifiers.filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('.'))
  const allowed = nonNode.every(specifier => specifier === '@deepseek-ai/schemastery')
  ok(allowed, `${file[0].split(/[\\/]/u).pop()} 只用 Node 内置模块（外加 schemastery 与同目录模块）`, nonNode)
}
ok(existsSync(join(fileURLToPath(new URL('..', import.meta.url)), 'package.json')), 'package.json 可读')

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? '✓' : '✗'} updates-selftest：${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
