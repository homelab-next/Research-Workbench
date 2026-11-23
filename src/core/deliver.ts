/** Called with an error a listener threw and the item it was handling. */
export type ListenerErrorHandler<T> = (error: unknown, item: T) => void;

/** Calls `fn`, ignoring anything it throws. Used for error handlers, which must not fail the caller. */
export function ignoreThrow(fn: () => void): void {
  try {
    fn();
  } catch {
    // an error handler that throws is ignored
  }
}

/** The default error handler: one line on stderr naming the entry. */
export function logToStderr(label: string): (error: unknown, entry?: { seq: number }) => void {
  return (error, entry) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${label}${entry ? ` on entry ${entry.seq}` : ""}: ${message}`);
  };
}

/**
 * Delivers items to every listener in the order they were sent. A send from inside a listener only
 * queues; the outer loop delivers it, so listeners always see items in order. A listener that throws
 * is reported to `onError` and does not stop the others.
 */
export class Delivery<L, T> {
  private readonly queue: T[] = [];
  private delivering = false;

  constructor(
    private readonly listeners: ReadonlySet<L>,
    private readonly invoke: (listener: L, item: T) => void,
    private readonly onError: ListenerErrorHandler<T>,
  ) {}

  send(items: readonly T[]): void {
    this.queue.push(...items);
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (let item = this.queue.shift(); item !== undefined; item = this.queue.shift()) {
        for (const fn of [...this.listeners]) {
          try {
            this.invoke(fn, item);
          } catch (err) {
            const failed = item;
            ignoreThrow(() => this.onError(err, failed));
          }
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}
