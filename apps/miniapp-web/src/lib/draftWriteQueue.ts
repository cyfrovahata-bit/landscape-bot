/** Serializes PUT/DELETE, including requests already in flight at clear time. */
export class DraftWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  invalidate() { this.generation++; }
  enqueue<T>(job: () => Promise<T>, clearing = false): Promise<T | undefined> {
    const generation = this.generation;
    const next = this.tail.then(() => generation !== this.generation && !clearing ? undefined : job());
    this.tail = next.catch(() => {});
    return next;
  }
}
