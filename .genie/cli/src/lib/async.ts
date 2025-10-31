/**
 * Delays execution for a specified number of milliseconds.
 *
 * @param {number} ms Number of milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 * @example
 * ```ts
 * await sleep(100); // pauses execution for 100ms
 * ```
 */
export function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError('sleep: ms must be a non-negative finite number');
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Error thrown when an operation exceeds the configured timeout window.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Combined settlement type returned when sequential execution does not stop on error.
 */
export type SequentialSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: Error };

function normalizeError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const errorMessage =
    typeof reason === 'string'
      ? reason
      : `Non-Error rejection: ${JSON.stringify(reason)}`;
  const error = new Error(errorMessage);
  error.name = 'NonErrorThrown';
  return error;
}

/**
 * Executes a promise factory function with an exponential backoff retry strategy.
 *
 * @template T The expected return type of the promise.
 * @param {() => Promise<T>} fn The function that returns the promise to execute.
 * @param {number} [maxAttempts=3] The maximum number of attempts before throwing the final error.
 * @param {number} [baseDelay=1000] The base delay (in milliseconds) used for the backoff calculation.
 * @returns {Promise<T>} A promise that resolves with the successful result or rejects after max attempts.
 * @throws {TypeError | RangeError} When inputs are invalid.
 * @example
 * ```ts
 * const result = await retryWithBackoff(() => fetchData(), 5, 200);
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  if (typeof fn !== 'function') {
    throw new TypeError('retryWithBackoff: fn must be a function that returns a promise');
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('retryWithBackoff: maxAttempts must be an integer greater than 0');
  }

  if (!Number.isFinite(baseDelay) || baseDelay < 0) {
    throw new RangeError('retryWithBackoff: baseDelay must be a non-negative finite number');
  }

  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      lastError = normalizeError(error);
      if (attempt >= maxAttempts) {
        break;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error('retryWithBackoff: operation failed without providing an error');
}

/**
 * Wraps a promise with a timeout. Rejects if the promise takes longer than the specified duration.
 *
 * @template T The expected return type of the promise.
 * @param {Promise<T>} promise The promise to wrap.
 * @param {number} ms The timeout duration in milliseconds.
 * @param {Error} [timeoutError] An optional custom error to throw on timeout. Defaults to an internal TimeoutError.
 * @returns {Promise<T>} A promise that resolves with the result of the wrapped promise or rejects on timeout.
 * @throws {RangeError} When `ms` is not a positive finite number.
 * @example
 * ```ts
 * const data = await withTimeout(fetchData(), 5000);
 * ```
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutError?: Error
): Promise<T> {
  if (!(promise instanceof Promise)) {
    throw new TypeError('withTimeout: promise must be a Promise instance');
  }

  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError('withTimeout: ms must be a positive finite number');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError ?? new TimeoutError(`Operation timed out after ${ms} ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * Executes an array of asynchronous functions (promise factories) sequentially.
 *
 * @template T The expected return type of each promise.
 * @param {Array<() => Promise<T>>} promiseFactories An array of functions that each return a promise.
 * @param {boolean} [stopOnError=true] If true, stops immediately and rejects on the first error.
 * @returns {Promise<T[] | SequentialSettlement<T>[]>} A promise with the aggregated results.
 * - If stopOnError=true (default), resolves to T[] or rejects with the first error.
 * - If stopOnError=false, resolves to an array of settlement objects (similar to Promise.allSettled).
 * @throws {TypeError} When inputs are invalid.
 * @example
 * ```ts
 * const tasks = [() => fetchUser(), () => fetchOrders()];
 * const results = await runSequential(tasks);
 * ```
 */
export async function runSequential<T>(
  promiseFactories: Array<() => Promise<T>>,
  stopOnError: boolean = true
): Promise<T[] | SequentialSettlement<T>[]> {
  if (!Array.isArray(promiseFactories)) {
    throw new TypeError('runSequential: promiseFactories must be an array of functions');
  }

  if (typeof stopOnError !== 'boolean') {
    throw new TypeError('runSequential: stopOnError must be a boolean value');
  }

  const results: T[] = [];
  const settlements: SequentialSettlement<T>[] = [];

  for (const factory of promiseFactories) {
    if (typeof factory !== 'function') {
      const typeError = new TypeError('runSequential: each entry in promiseFactories must be a function');
      if (stopOnError) {
        throw typeError;
      }
      settlements.push({ status: 'rejected', reason: typeError });
      continue;
    }

    try {
      const value = await factory();
      if (stopOnError) {
        results.push(value);
      } else {
        settlements.push({ status: 'fulfilled', value });
      }
    } catch (error) {
      const normalized = normalizeError(error);
      if (stopOnError) {
        throw normalized;
      }
      settlements.push({ status: 'rejected', reason: normalized });
    }
  }

  return stopOnError ? results : settlements;
}
