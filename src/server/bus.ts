export interface BusEvent {
  seq: number;
  type: string;
  data: unknown;
}

const BUFFER_LIMIT = 5000;

/**
 * In-process fan-out for the app-wide SSE stream. Seq is monotonic for the
 * life of the process; the buffer backs Last-Event-ID resume for clients
 * that reconnect while the app is still running.
 */
export class EventBus {
  #seq = 0;
  #buffer: BusEvent[] = [];
  #subscribers = new Set<(event: BusEvent) => void>();
  #dispatching = false;
  #pending: BusEvent[] = [];

  emit(type: string, data: unknown): void {
    const event: BusEvent = { seq: ++this.#seq, type, data };
    this.#buffer.push(event);
    if (this.#buffer.length > BUFFER_LIMIT) this.#buffer.shift();
    // A subscriber may emit while we're dispatching (the worker pool claims
    // in reaction to promotions). Queue instead of recursing so every
    // subscriber still sees events in seq order.
    this.#pending.push(event);
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      let next: BusEvent | undefined;
      while ((next = this.#pending.shift()) !== undefined) {
        for (const subscriber of this.#subscribers) subscriber(next);
      }
    } finally {
      this.#dispatching = false;
    }
  }

  eventsSince(seq: number): BusEvent[] {
    return this.#buffer.filter((event) => event.seq > seq);
  }

  subscribe(subscriber: (event: BusEvent) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }
}
