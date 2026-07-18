export interface SseMessage {
  id: number;
  event: string;
  data: any;
}

/** Minimal text/event-stream client for asserting against the app-wide stream. */
export class SseClient {
  readonly messages: SseMessage[] = [];
  #controller = new AbortController();

  private constructor() {}

  static async connect(url: string, lastEventId?: number): Promise<SseClient> {
    const client = new SseClient();
    const response = await fetch(url, {
      headers: {
        accept: "text/event-stream",
        ...(lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) }),
      },
      signal: client.#controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`SSE connect failed: ${response.status}`);
    }
    void client.#read(response.body);
    return client;
  }

  async #read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.#parseBlock(block);
        }
      }
    } catch {
      // aborted — expected on close()
    }
  }

  #parseBlock(block: string): void {
    let id = -1;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trim());
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    this.messages.push({ id, event, data: JSON.parse(dataLines.join("\n")) });
  }

  /** Poll until at least `count` messages matching `event` arrive (or time out). */
  async waitFor(event: string, count = 1, timeoutMs = 2000): Promise<SseMessage[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const matches = this.messages.filter((m) => m.event === event);
      if (matches.length >= count) return matches;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${count}× "${event}"; saw ${JSON.stringify(this.messages)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.#controller.abort();
  }
}
