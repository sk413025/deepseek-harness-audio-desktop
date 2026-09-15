// Live-turn provenance (CONTRACT.md §5): a live duplex exchange runs outside the agent loop, so
// its captured input is staged as a normal Harness file upload on close. When that file is sent
// as a prompt, the adapter replays the answer the live session already produced, keyed by the
// input recording's sha256, instead of asking the model a second time. The session log then holds
// the model-visible input (the file) and the answer the user actually heard.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class LiveTurnRegistry {
  /** @param {{ file?: () => string | undefined, maxEntries?: number, log?: (m: string) => void }} [options] */
  constructor(options = {}) {
    this.file = options.file ?? (() => undefined)
    this.maxEntries = options.maxEntries ?? 200
    this.log = options.log ?? (() => {})
    /** @type {Map<string, any>} sha256 → turn */
    this.turns = new Map()
    this.loaded = false
    this.saving = Promise.resolve()
  }

  load() {
    this.loading ??= (async () => {
      const file = this.file()
      if (!file) return
      try {
        for (const turn of JSON.parse(await readFile(file, 'utf8')).turns ?? []) if (!this.turns.has(turn.inputSha256)) this.turns.set(turn.inputSha256, turn)
      } catch { /* no turns yet */ }
      this.loaded = true
    })()
    return this.loading
  }

  /** @param {{ inputSha256: string, sessionId: string, liveId: string, provider: string, model: string, responses: any[], input: any }} turn */
  register(turn) {
    this.turns.set(turn.inputSha256, { ...turn, bound: false, closedAt: new Date().toISOString() })
    while (this.turns.size > this.maxEntries) this.turns.delete(this.turns.keys().next().value)
    this.persist()
  }

  /** Unbound turn for this input digest, if any. */
  find(sha256) {
    const turn = this.turns.get(sha256)
    return turn !== undefined && !turn.bound ? turn : undefined
  }

  markBound(sha256, info) {
    const turn = this.turns.get(sha256)
    if (turn === undefined) return
    turn.bound = true
    turn.boundAt = new Date().toISOString()
    Object.assign(turn, info)
    this.persist()
  }

  persist() {
    const file = this.file()
    if (!file) return
    const body = JSON.stringify({ version: 1, turns: [...this.turns.values()] }, null, 2)
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, body)
      } catch (error) {
        this.log(`dsh-dgx-audio: cannot save live turns: ${error?.message ?? error}`)
      }
    })
  }
}
