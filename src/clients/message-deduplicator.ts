/** Bounds the message history retained across WebSocket reconnects and handoffs. */
export class MessageDeduplicator {
  private readonly seen = new Set<string>();

  constructor(private readonly limit = 1000) {}

  accept(id?: string): boolean {
    if (!id) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
}
