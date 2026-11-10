export class StateEvents {
  private listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private value = "";
  private encoder = new TextEncoder();
  publish(state: unknown): void {
    const value = JSON.stringify(state);
    if (value === this.value) return;
    this.value = value;
    for (const listener of this.listeners) {
      try { listener.enqueue(this.encoder.encode(`event: state\ndata: ${value}\n\n`)); }
      catch { this.listeners.delete(listener); }
    }
  }
  response(): Response {
    let connection: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setInterval>;
    return new Response(new ReadableStream<Uint8Array>({
      start: controller => {
        connection = controller; this.listeners.add(controller);
        if (this.value) controller.enqueue(this.encoder.encode(`event: state\ndata: ${this.value}\n\n`));
        timer = setInterval(() => { try { controller.enqueue(this.encoder.encode(": heartbeat\n\n")); } catch { clearInterval(timer); this.listeners.delete(controller); } }, 20000);
      },
      cancel: () => { clearInterval(timer); this.listeners.delete(connection); }
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
