export class QueueFullError extends Error {
  constructor() {
    super('Render queue is full');
    this.name = 'QueueFullError';
  }
}

/** A counting semaphore with a bounded wait list. */
export class JobQueue {
  constructor({ concurrency, maxQueue }) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.waiting = [];
  }

  get stats() {
    return { active: this.active, queued: this.waiting.length, concurrency: this.concurrency };
  }

  /** Runs `fn` once a slot is free. Rejects with signal.reason if aborted while waiting. */
  async run(fn, signal) {
    await this.#acquire(signal);
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new QueueFullError());

    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((w) => w !== entry);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  #release() {
    const next = this.waiting.shift();
    if (next) next.resolve(); // hand the slot straight over
    else this.active--;
  }
}
