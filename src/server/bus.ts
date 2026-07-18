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

  emit(type: string, data: unknown): void {
    const event: BusEvent = { seq: ++this.#seq, type, data };
    this.#buffer.push(event);
    if (this.#buffer.length > BUFFER_LIMIT) this.#buffer.shift();
    for (const subscriber of this.#subscribers) subscriber(event);
  }

  eventsSince(seq: number): BusEvent[] {
    return this.#buffer.filter((event) => event.seq > seq);
  }

  subscribe(subscriber: (event: BusEvent) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }
}
