// Neither the provider stream nor tool execution had any timeout anywhere in
// this file — a stalled network read (dropped connection, hung local proxy)
// or a tool that never resolves (e.g. a background process waiting on
// output that never comes) would freeze the whole turn forever with no way
// to recover. These watchdogs turn a silent, permanent hang into a visible,
// recoverable error.
export const STREAM_IDLE_TIMEOUT_MS = 45_000;
export const TOOL_EXECUTION_TIMEOUT_MS = 120_000;

export function withIdleTimeout<T>(
  iterable: AsyncGenerator<T>,
  ms: number,
  controller: AbortController,
): AsyncGenerator<T> {
  const it = iterable[Symbol.asyncIterator]();
  return (async function* () {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`No response from the model for ${Math.round(ms / 1000)}s — the connection likely stalled.`));
        }, ms);
      });
      try {
        const result = await Promise.race([it.next(), timeout]);
        if (result.done) return;
        yield result.value;
      } finally {
        clearTimeout(timer);
      }
    }
  })();
}
