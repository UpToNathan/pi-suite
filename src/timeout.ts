import { Effect } from "effect";
import type { CancellableOptions } from "./types.js";

/** Effect-native timeout and cancellation wrapper for an external Promise.
 * @template T Promise fulfillment type preserved by the wrapper.
 */
export function withTimeoutEffect<T>(promise: PromiseLike<T>, timeout: number, label: string, options: CancellableOptions) {
  return Effect.callback<T, unknown>((resume) => {
    let settled = false;
    const finish = (effect: Effect.Effect<T, unknown>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const timer = setTimeout(
      () => finish(Effect.fail(new Error(`${label} timed out after ${timeout}ms`))),
      timeout,
    );
    const abort = () => finish(Effect.fail(new DOMException(`${label} aborted`, "AbortError")));
    options.signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(Effect.succeed(value)),
      (error) => finish(Effect.fail(error)),
    );
    if (options.signal?.aborted) abort();
    return Effect.sync(() => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    });
  });
}

/** Promise adapter for third-party SDK calls.
 * @template T Promise fulfillment type preserved by the adapter.
 */
export function withTimeout<T>(promise: Promise<T>, timeout: number, label: string, options: CancellableOptions): Promise<T> {
  return Effect.runPromise(withTimeoutEffect(promise, timeout, label, options));
}
