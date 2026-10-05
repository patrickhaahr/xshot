/** The outcome of an operation that can fail in an expected way. */
export type Result<T, E> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: E }

/**
 * Wrap a successful value.
 *
 * @template T - The success type.
 * @param value - The value the operation produced.
 * @returns A successful result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { _tag: "ok", value }
}

/**
 * Wrap an expected failure.
 *
 * @template E - The error type.
 * @param error - Why the operation failed.
 * @returns A failed result.
 */
export function err<E>(error: E): Result<never, E> {
  return { _tag: "err", error }
}

/**
 * Settle a promise into a result, so a rejected browser API call becomes a value.
 *
 * @template T - The value the promise resolves to.
 * @param promise - The promise to settle.
 * @returns The resolved value, or the rejection as an `Error`.
 */
export async function attempt<T>(promise: Promise<T>): Promise<Result<T, Error>> {
  return promise.then(ok, (cause: unknown) =>
    err(cause instanceof Error ? cause : new Error(String(cause)))
  )
}

/**
 * Mark a branch that exhaustive handling of a union makes unreachable.
 *
 * @param unexpectedCase - The value TypeScript has narrowed to `never`.
 * @throws Always, because reaching it means a union member went unhandled.
 */
export function casesHandled(unexpectedCase: never): never {
  throw new Error(`Unhandled case: ${String(unexpectedCase)}`)
}
