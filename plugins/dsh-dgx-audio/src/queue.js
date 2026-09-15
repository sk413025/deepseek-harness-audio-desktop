// Bounded async queue with explicit overflow policy, backpressure and cancellation.
//
// Producers (a network reader, a microphone frame source) await `push()`; with the
// `block` policy the promise stays pending while the queue is full, which stops the
// producer from reading more bytes. Rendering-only consumers use `drop-oldest` and
// receive an explicit gap count instead of silently missing frames.

export class QueueClosedError extends Error {
  constructor(message = 'queue closed', options) {
    super(message, options)
    this.name = 'QueueClosedError'
    this.code = 'QUEUE_CLOSED'
  }
}

export class QueueOverflowError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QueueOverflowError'
    this.code = 'BUFFER_OVERFLOW'
  }
}

/**
 * @template T
 */
export class BoundedAsyncQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.maxItems]
   * @param {number} [options.maxBytes]
   * @param {(item: T) => number} [options.sizeOf]
   * @param {'block' | 'error' | 'drop-oldest'} [options.overflow]
   */
  constructor(options = {}) {
    this.maxItems = options.maxItems ?? 256
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    this.sizeOf = options.sizeOf ?? (item => item?.byteLength ?? item?.data?.byteLength ?? 0)
    this.overflow = options.overflow ?? 'block'
    /** @type {{ item: T, size: number }[]} */
    this.items = []
    this.head = 0
    this.bytes = 0
    this.state = 'open' // open → closed (drain then end) | failed (throw) | aborted (discard)
    this.error = undefined
    /** @type {(() => void)[]} */
    this.spaceWaiters = []
    /** @type {(() => void) | undefined} */
    this.itemWaiter = undefined
    this.stats = { pushed: 0, popped: 0, dropped: 0, droppedBytes: 0, highWaterItems: 0, highWaterBytes: 0, blockedPushes: 0 }
  }

  get length() { return this.items.length - this.head }

  full(extra) {
    return this.length > 0 && (this.length + 1 > this.maxItems || this.bytes + extra > this.maxBytes)
  }

  /**
   * Enqueue one item, waiting for space under the `block` policy.
   * An item larger than maxBytes is admitted only into an empty queue, so one
   * oversized frame cannot deadlock a producer.
   * @param {T} item
   * @param {AbortSignal} [signal]
   */
  async push(item, signal) {
    const size = this.sizeOf(item)
    for (;;) {
      this.assertOpen()
      signal?.throwIfAborted()
      if (!this.full(size)) break
      if (this.overflow === 'error') {
        throw new QueueOverflowError(`buffer full (${this.length} items, ${this.bytes} bytes; limits ${this.maxItems} items, ${this.maxBytes} bytes)`)
      }
      if (this.overflow === 'drop-oldest') {
        const dropped = this.shift()
        this.stats.dropped += 1
        this.stats.droppedBytes += dropped.size
        continue
      }
      this.stats.blockedPushes += 1
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          this.spaceWaiters = this.spaceWaiters.filter(w => w !== wake)
          reject(signal.reason)
        }
        const wake = () => { signal?.removeEventListener('abort', onAbort); resolve() }
        this.spaceWaiters.push(wake)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    this.items.push({ item, size })
    this.bytes += size
    this.stats.pushed += 1
    this.stats.highWaterItems = Math.max(this.stats.highWaterItems, this.length)
    this.stats.highWaterBytes = Math.max(this.stats.highWaterBytes, this.bytes)
    this.itemWaiter?.()
  }

  shift() {
    const entry = this.items[this.head]
    this.items[this.head] = undefined
    this.head += 1
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    this.bytes -= entry.size
    return entry
  }

  assertOpen() {
    if (this.state === 'open') return
    throw this.state === 'failed' || this.state === 'aborted'
      ? (this.error ?? new QueueClosedError(`queue ${this.state}`))
      : new QueueClosedError()
  }

  /** Producer finished: the consumer drains what is buffered, then ends. */
  close() {
    if (this.state !== 'open') return
    this.state = 'closed'
    this.wakeAll()
  }

  /** Producer failed: the consumer drains buffered items, then throws `error`. */
  fail(error) {
    if (this.state !== 'open') return
    this.state = 'failed'
    this.error = error
    this.wakeAll()
  }

  /** Cancel: discard buffered items, reject waiting producers and end the consumer with `error`. */
  abort(error = new QueueClosedError('queue aborted')) {
    if (this.state === 'aborted') return
    this.state = 'aborted'
    this.error = error
    this.stats.dropped += this.length
    this.stats.droppedBytes += this.bytes
    this.items = []
    this.head = 0
    this.bytes = 0
    this.wakeAll()
  }

  wakeAll() {
    const waiters = this.spaceWaiters
    this.spaceWaiters = []
    for (const wake of waiters) wake()
    this.itemWaiter?.()
  }

  /**
   * Take the next item; `undefined` once closed and drained.
   * @param {AbortSignal} [signal]
   * @returns {Promise<T | undefined>}
   */
  async next(signal) {
    for (;;) {
      signal?.throwIfAborted()
      if (this.state === 'aborted') throw this.error
      if (this.length > 0) {
        const { item } = this.shift()
        this.stats.popped += 1
        const waiter = this.spaceWaiters.shift()
        waiter?.()
        return item
      }
      if (this.state === 'closed') return undefined
      if (this.state === 'failed') throw this.error
      await new Promise((resolve, reject) => {
        const onAbort = () => { this.itemWaiter = undefined; reject(signal.reason) }
        this.itemWaiter = () => { this.itemWaiter = undefined; signal?.removeEventListener('abort', onAbort); resolve() }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  async * [Symbol.asyncIterator]() {
    let completed = false
    try {
      for (;;) {
        const item = await this.next()
        if (item === undefined && this.state === 'closed' && this.length === 0) { completed = true; return }
        yield /** @type {T} */ (item)
      }
    } finally {
      // A consumer that stops early releases blocked producers instead of stranding them.
      if (!completed && this.state === 'open') this.abort(new QueueClosedError('consumer stopped'))
    }
  }
}
