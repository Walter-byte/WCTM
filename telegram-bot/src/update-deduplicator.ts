const DEFAULT_MAX_TRACKED_UPDATES = 10_000;

export class UpdateDeduplicator {
  private readonly seen = new Set<number>();

  constructor(private readonly maxTracked = DEFAULT_MAX_TRACKED_UPDATES) {}

  accept(updateId: number): boolean {
    if (this.seen.has(updateId)) {
      return false;
    }

    this.seen.add(updateId);

    if (this.seen.size > this.maxTracked) {
      const oldest = this.seen.values().next().value as number | undefined;

      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }

    return true;
  }
}
