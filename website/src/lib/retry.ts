// A request that may be slow, given a time limit and one more try: the paper's full text,
// which the reader's browser asks of Europe PMC (src/scripts/reader-paper.ts). Europe PMC's XML
// usually comes in one to six seconds, sometimes far more; a request that fails for a reason
// that may pass (no answer in time, the network, a server's error) is tried once more. Pure:
// tested in tests/reader.test.ts with attempts of its own.

/** A server's answer that is not a success. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Europe PMC answered HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

/** No answer within the time limit. */
export class TimeoutError extends Error {
  readonly seconds: number;
  constructor(seconds: number) {
    super(`Europe PMC did not answer within ${seconds} seconds`);
    this.name = "TimeoutError";
    this.seconds = seconds;
  }
}

/** Whether trying again may help: no answer in time, the network (a TypeError from fetch), a
 *  server's error, or too many requests. Not a missing text, nor text that is not XML. */
export function worthRetrying(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429 || err.status === 408;
  return err instanceof TypeError;
}

export type RetryOptions = {
  /** How many tries in all. */
  tries?: number;
  /** The time limit of each try, in milliseconds. */
  timeout?: number;
  /** The pause before the next try, in milliseconds. */
  pause?: number;
  /** Told before each try after the first. */
  onRetry?: (attempt: number, err: unknown) => void;
  /** Told once a try has waited this long (milliseconds), to say that it is slow. */
  slowAfter?: number;
  onSlow?: (attempt: number) => void;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `attempt(signal)` until it succeeds, or fails for good, or `tries` are spent; each try is
 *  aborted past `timeout` (and then fails with a TimeoutError). The last failure is thrown. */
export async function withRetry<T>(attempt: (signal: AbortSignal) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { tries = 2, timeout = 20_000, pause = 1_500, onRetry, slowAfter = 0, onSlow } = options;
  let last: unknown = null;
  for (let n = 1; n <= tries; n++) {
    if (n > 1) {
      onRetry?.(n, last);
      await wait(pause);
    }
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeout);
    const slow = slowAfter > 0 && onSlow ? setTimeout(() => onSlow(n), slowAfter) : null;
    try {
      return await attempt(ctl.signal);
    } catch (err) {
      last = timedOut ? new TimeoutError(Math.round(timeout / 1000)) : err;
      if (!worthRetrying(last)) break;
    } finally {
      clearTimeout(timer);
      if (slow) clearTimeout(slow);
    }
  }
  throw last;
}
