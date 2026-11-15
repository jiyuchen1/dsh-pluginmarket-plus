/**
 * 磁盘缓存：每个插件源一份索引 JSON 正文 + 一份状态清单。
 *
 * 目录布局（默认 `<profile>/.pluginmarket-plus/`）：
 *   - `index-<id>.json`  索引正文（已把相对 icon 改写为绝对地址）
 *   - `state.json`       `{ version, sources: string[], entries: { [id]: Entry } }`
 *
 * 写正文和写清单都走「临时文件 + rename」的原子替换，任何时刻磁盘上要么是旧副本，
 * 要么是新副本，不会出现被截断的半个 JSON。
 *
 * @module dsh-pluginmarket-plus/lib/store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeIndexGitSource } from './updates.js'

/** 状态清单版本；结构不兼容变更时递增。 */
const STATE_VERSION = 1

/**
 * 一个索引源的稳定短 id：URL 的 sha256 前 16 位十六进制。
 *
 * 同一 URL 永远得到同一 id，所以镜像地址在重启后保持不变。
 * @param {string} url - 上游索引地址。
 * @returns {string} 16 位十六进制 id。
 */
export function sourceId(url) {
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 16)
}

/** 一个索引源的缓存状态。 */
/**
 * @typedef {object} CacheEntry
 * @property {string} url - 上游索引地址。
 * @property {number} [fetchedAt] - 最近一次成功抓取的 Unix 毫秒时间。
 * @property {number} [bytes] - 正文字节数。
 * @property {number} [plugins] - 插件条数。
 * @property {unknown} [title] - 索引自带的标题（LocalizedText）。
 * @property {string|null} [error] - 最近一次失败原因；成功后清空。
 * @property {number} [errorAt] - 最近一次失败的 Unix 毫秒时间。
 */

/** 正文与清单的读写。 */
export class CacheStore {
  /**
   * @param {string} dir - 缓存目录绝对路径。
   */
  constructor(dir) {
    this.dir = dir
    this.state = { version: STATE_VERSION, sources: [], entries: {} }
    /** @type {{signature: string, size: number, names: Map<string, object[]>}|undefined} 上次解析出来的索引查询表。 */
    this.#indexCache = undefined
    mkdirSync(dir, { recursive: true })
    this.#load()
  }

  /** @type {{signature: string, size: number, names: Map<string, object[]>}|undefined} */
  #indexCache

  /** 读取清单；损坏或缺失时以空清单开始（缓存是派生数据，可以重建）。 */
  #load() {
    try {
      const raw = readFileSync(join(this.dir, 'state.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) return
      const entries = parsed.entries !== null && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
        ? parsed.entries
        : {}
      this.state = {
        version: STATE_VERSION,
        sources: Array.isArray(parsed.sources) ? parsed.sources.filter(url => typeof url === 'string') : [],
        entries,
      }
    } catch {
      // 首次运行或清单损坏：保持空状态。旧正文文件会被下一次抓取覆盖。
    }
  }

  /** 原子写回清单。 */
  save() {
    const target = join(this.dir, 'state.json')
    const tmp = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, target)
  }

  /** @returns {string[]} 没有活跃配置时保留的源列表（首次从插件市场接管时写入）。 */
  get sources() {
    return this.state.sources.slice()
  }

  /**
   * @param {string[]} urls - 要记住的源列表。
   */
  set sources(urls) {
    this.state.sources = urls.slice()
  }

  /**
   * @param {string} id - 源 id。
   * @returns {CacheEntry|undefined} 该源的缓存状态。
   */
  entry(id) {
    return this.state.entries[id]
  }

  /**
   * 合并写入一条状态。
   * @param {string} id - 源 id。
   * @param {Partial<CacheEntry>} patch - 要合并的字段。
   * @returns {void}
   */
  update(id, patch) {
    this.state.entries[id] = { ...this.state.entries[id], ...patch }
  }

  /**
   * @param {string} id - 源 id。
   * @returns {boolean} 是否有可用的正文文件。
   */
  hasBody(id) {
    return existsSync(join(this.dir, `index-${id}.json`))
  }

  /**
   * @param {string} id - 源 id。
   * @returns {Buffer|undefined} 正文；缺失时 undefined。
   */
  readBody(id) {
    try {
      return readFileSync(join(this.dir, `index-${id}.json`))
    } catch {
      return undefined
    }
  }

  /**
   * 原子写入正文。
   * @param {string} id - 源 id。
   * @param {Buffer} bytes - 正文。
   * @returns {void}
   */
  writeBody(id, bytes) {
    const target = join(this.dir, `index-${id}.json`)
    const tmp = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`
    writeFileSync(tmp, bytes)
    renameSync(tmp, target)
    this.#indexCache = undefined
  }

  /**
   * 删除一个源的正文与状态（源被移除时调用）。
   * @param {string} id - 源 id。
   * @returns {void}
   */
  remove(id) {
    delete this.state.entries[id]
    try {
      rmSync(join(this.dir, `index-${id}.json`), { force: true })
    } catch {
      // 删除失败不影响后续逻辑；下次写入会覆盖。
    }
    this.#indexCache = undefined
  }

  /**
   * 所有已缓存正文的源 id。
   *
   * 先按源列表与状态清单的顺序取，再扫一遍目录补上清单里没记到的正文文件——这样清单损坏或
   * 被别的进程改写时，已下载的索引仍然可用。
   * @returns {string[]} 源 id 列表。
   */
  cachedIds() {
    /** @type {string[]} */
    const ids = []
    const push = (id) => {
      if (!ids.includes(id) && this.hasBody(id)) ids.push(id)
    }
    for (const url of this.state.sources) push(sourceId(url))
    for (const id of Object.keys(this.state.entries)) push(id)
    let names = []
    try {
      names = readdirSync(this.dir)
    } catch {
      names = []
    }
    for (const name of names) {
      const match = /^index-([a-f0-9]{16})\.json$/u.exec(name)
      if (match !== null) push(match[1])
    }
    return ids
  }

  /**
   * 一份已缓存索引的签名：正文文件的大小与修改时间。
   *
   * 索引动辄几 MB，解析一次要几百毫秒；用签名判断「有没有变过」，没变就直接复用上次解析结果。
   * @returns {string} 形如 `id:bytes:mtime` 的签名串。
   */
  indexSignature() {
    const parts = []
    for (const id of this.cachedIds()) {
      try {
        const stat = statSync(join(this.dir, `index-${id}.json`))
        parts.push(`${id}:${String(stat.size)}:${String(stat.mtimeMs)}`)
      } catch {
        parts.push(`${id}:missing`)
      }
    }
    return parts.join('|')
  }

  /**
   * 把已缓存的索引读成「包名 → 版本来源」的查询表。
   *
   * 只读取 `plugins[].versions[]` 里更新判断需要的字段（版本号、发布时间、`source`），
   * 正文损坏或格式不符的源直接跳过——缓存是派生数据，坏一份不该影响其它源。
   * @returns {{signature: string, size: number, names: Map<string, object[]>}} 查询表；`size` 是收录的包数量。
   */
  cachedIndex() {
    const signature = this.indexSignature()
    if (this.#indexCache !== undefined && this.#indexCache.signature === signature) return this.#indexCache
    /** @type {Map<string, object[]>} */
    const names = new Map()
    for (const id of this.cachedIds()) {
      let document
      try {
        document = JSON.parse(readFileSync(join(this.dir, `index-${id}.json`), 'utf8'))
      } catch {
        continue
      }
      if (document === null || typeof document !== 'object' || document.format !== 1 || !Array.isArray(document.plugins)) continue
      for (const plugin of document.plugins) {
        if (plugin === null || typeof plugin !== 'object' || typeof plugin.name !== 'string' || !Array.isArray(plugin.versions)) continue
        const versions = names.get(plugin.name) ?? []
        for (const version of plugin.versions) {
          if (version === null || typeof version !== 'object' || typeof version.version !== 'string') continue
          const source = version.source
          if (source === null || typeof source !== 'object') continue
          if (source.type === 'npm') {
            versions.push({ version: version.version, type: 'npm', publishTimestamp: Number(version.publishTimestamp ?? 0) })
            continue
          }
          if (source.type !== 'git') continue
          const git = normalizeIndexGitSource(source)
          if (git === undefined) continue
          versions.push({ version: version.version, type: 'git', publishTimestamp: Number(version.publishTimestamp ?? 0), git })
        }
        names.set(plugin.name, versions)
      }
    }
    this.#indexCache = { signature, size: names.size, names }
    return this.#indexCache
  }
}
