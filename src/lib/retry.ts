import { HttpError } from './http-error.js';

export interface RetryDecisionContext {
  attempt: number;
  maxAttempts: number;
}

export interface RetryContext extends RetryDecisionContext {
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  onRetry?: (context: RetryContext) => void | Promise<void>;
  shouldRetry?: (error: unknown, context: RetryDecisionContext) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
}

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function normalizeRetryOptions(options: RetryOptions): Required<RetryOptions> {
  return {
    maxAttempts: Math.max(1, options.maxAttempts ?? 3),
    delayMs: Math.max(0, options.delayMs ?? 2000),
    backoffMultiplier: Math.max(1, options.backoffMultiplier ?? 1),
    maxDelayMs:
      options.maxDelayMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, options.maxDelayMs),
    onRetry: options.onRetry ?? (async () => undefined),
    shouldRetry: options.shouldRetry ?? (() => true),
    sleep: options.sleep ?? sleep
  };
}

export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const normalized = normalizeRetryOptions(options);
  let nextDelayMs = normalized.delayMs;

  for (let attempt = 1; attempt <= normalized.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const shouldRetry =
        attempt < normalized.maxAttempts &&
        normalized.shouldRetry(error, {
          attempt,
          maxAttempts: normalized.maxAttempts
        });

      if (!shouldRetry) {
        throw error;
      }

      await normalized.onRetry({
        attempt,
        maxAttempts: normalized.maxAttempts,
        delayMs: nextDelayMs,
        error
      });
      await normalized.sleep(nextDelayMs);
      nextDelayMs = Math.min(
        normalized.maxDelayMs,
        Math.round(nextDelayMs * normalized.backoffMultiplier)
      );
    }
  }

  throw new Error('Retry exhausted without returning or throwing');
}

/** Transient HTTP statuses safe to retry for read operations. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function extractStatus(error: unknown): number | undefined {
  if (error instanceof HttpError) {
    return error.status;
  }
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  if (error && typeof error === 'object' && 'cause' in error) {
    return extractStatus((error as { cause?: unknown }).cause);
  }
  return undefined;
}

/**
 * Safe-read retry gate: retry network failures and transient HTTP statuses.
 * Ordinary 4xx responses are never retried.
 */
export function shouldRetryReadError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status === undefined) {
    // Network / disconnect / abort without an HTTP status.
    return true;
  }
  return isTransientHttpStatus(status);
}

/**
 * Mutation POST that may have been accepted upstream but returned an ambiguous
 * transport/server failure. Ordinary 4xx are never ambiguous.
 */
export function isAmbiguousMutationFailure(error: unknown): boolean {
  const status = extractStatus(error);
  if (status === undefined) {
    return true;
  }
  return isTransientHttpStatus(status);
}

export const SAFE_READ_RETRY: RetryOptions = {
  maxAttempts: 3,
  delayMs: 2000,
  backoffMultiplier: 2,
  shouldRetry: (error) => shouldRetryReadError(error)
};
