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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    mkdirSync(dir, { recursive: true })
    this.#load()
  }

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
  }
}
