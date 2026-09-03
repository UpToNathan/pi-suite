import { Effect } from "effect";
import type { CancellableOptions } from "./types.js";

/** Effect-native timeout and cancellation wrapper.
 * @template T Effect success type preserved by the wrapper.
 */
export function withTimeoutEffect<T>(
  effect: Effect.Effect<T, unknown>,
  timeout: number,
  label: string,
  options: CancellableOptions,
) {
  const signal = options.signal;
  const cancelled = signal
    ? Effect.callback<never, DOMException>((resume) => {
        const handler = () => resume(Effect.fail(new DOMException(`${label} aborted`, "AbortError")));
        signal.addEventListener("abort", handler, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", handler));
      })
    : Effect.never;

  return Effect.race(effect, cancelled).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new Error(`${label} timed out after ${timeout}ms`)),
    }),
  );
}

/** Promise adapter for third-party SDK calls.
 * @template T Promise fulfillment type preserved by the adapter.
 */
export function withTimeout<T>(promise: Promise<T>, timeout: number, label: string, options: CancellableOptions): Promise<T> {
  options.signal?.throwIfAborted();
  return Effect.runPromise(
    withTimeoutEffect(Effect.tryPromise({ try: () => promise, catch: (error) => error }), timeout, label, options),
  );
}
