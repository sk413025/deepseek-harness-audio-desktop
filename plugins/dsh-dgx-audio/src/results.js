// Durable structured results for the shared audio UI (mic HANDOFF_NEXT §2, option A): the answer footer carries one
// link line `- [🧾 <uiTask> result](/api/dsh-dgx-audio/v1/result?id=<resultId>)` and the JSON lives next to the
// recordings, so a fenced JSON block never renders verbatim in the conversation and results survive a host restart.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ROUTE_PREFIX } from './constants.js'

export const RESULT_ID = /^res_[A-Za-z0-9_-]{8,120}$/

export class ResultStore {
  /** @param {{ outputDir: () => string, log?: (m: string) => void }} options */
  constructor(options) {
    this.outputDir = options.outputDir
    this.log = options.log ?? (() => {})
  }

  /** Absolute path for a valid id inside `<outputDir>/results/`, else undefined. */
  pathOf(id) {
    if (typeof id !== 'string' || !RESULT_ID.test(id)) return undefined
    const root = resolve(this.outputDir(), 'results')
    const full = resolve(root, `${id}.json`)
    return full.startsWith(root + sep) ? full : undefined
  }

  /**
   * Persist one result object; returns its id, or undefined when it could not be written (caller falls back to a fence).
   * @param {Record<string, unknown>} result
   */
  async save(result) {
    const id = `res_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const path = this.pathOf(id)
    try {
      await mkdir(join(this.outputDir(), 'results'), { recursive: true })
      await writeFile(`${path}.part`, JSON.stringify({ ...result, resultId: id }))
      await rename(`${path}.part`, path)
      return id
    } catch (error) {
      this.log(`dsh-dgx-audio: cannot save result: ${error?.message ?? error}`)
      return undefined
    }
  }

  /** @returns {Promise<Record<string, unknown> | undefined>} */
  async load(id) {
    const path = this.pathOf(id)
    if (path === undefined) return undefined
    try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
  }
}

/** Footer link line the mic's RESULT_LINK regex reads; the Markdown renderer shows only the label. */
export function resultLinkLine(uiTask, id) {
  return `- [🧾 ${uiTask} result](${ROUTE_PREFIX}/result?id=${id})`
}
