/**
 * Typed error hierarchy for OpenProject API failures.
 *
 * Every non-2xx HTTP response is turned into one of these via {@link errorFromResponse}.
 * Errors are never swallowed and never carry the API key.
 */

export interface OpenProjectErrorDetail {
  message: string;
  errorIdentifier?: string;
}

export interface OpenProjectErrorOptions {
  details?: OpenProjectErrorDetail[];
  /** Parsed response body (already secret-free). */
  body?: unknown;
  cause?: unknown;
  /** For 429 responses: how long to wait before retrying, in ms. */
  retryAfterMs?: number;
}

/** Base class for all OpenProject client errors. */
export class OpenProjectError extends Error {
  readonly status: number;
  readonly details: OpenProjectErrorDetail[];
  readonly body: unknown;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, status: number, options: OpenProjectErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.details = options.details ?? [];
    this.body = options.body;
    this.retryAfterMs = options.retryAfterMs;
    // Preserve the prototype chain when targeting ES2022 with downleveled classes.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 / 403 — authentication or authorization failed. */
export class AuthError extends OpenProjectError {}
/** 404 — resource not found. */
export class NotFoundError extends OpenProjectError {}
/** 409 — lockVersion conflict; the resource changed under us. */
export class ConflictError extends OpenProjectError {}
/** 422 — request understood but semantically invalid (e.g. disallowed status transition). */
export class UnprocessableError extends OpenProjectError {}
/** 429 — rate limited. Check {@link OpenProjectError.retryAfterMs}. */
export class RateLimitError extends OpenProjectError {}
/** 5xx — server side failure. */
export class ServerError extends OpenProjectError {}
/** Transport failure (DNS, socket, timeout) before any HTTP status was received. status === 0. */
export class NetworkError extends OpenProjectError {}

/** Pull a human message + per-field details out of an OpenProject HAL error body. */
export function extractErrorInfo(body: unknown): { message: string; details: OpenProjectErrorDetail[] } {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const message = typeof b['message'] === 'string' ? b['message'] : 'OpenProject API error';
    const details: OpenProjectErrorDetail[] = [];
    const embedded = b['_embedded'] as Record<string, unknown> | undefined;
    const errs = embedded?.['errors'];
    if (Array.isArray(errs)) {
      for (const e of errs) {
        if (e && typeof e === 'object') {
          const eo = e as Record<string, unknown>;
          details.push({
            message: typeof eo['message'] === 'string' ? eo['message'] : String(eo['message'] ?? ''),
            errorIdentifier: typeof eo['errorIdentifier'] === 'string' ? eo['errorIdentifier'] : undefined,
          });
        }
      }
    }
    if (details.length === 0 && typeof b['errorIdentifier'] === 'string') {
      details.push({ message, errorIdentifier: b['errorIdentifier'] });
    }
    return { message, details };
  }
  if (typeof body === 'string' && body.trim()) {
    return { message: body, details: [] };
  }
  return { message: 'OpenProject API error', details: [] };
}

/** Build the correct typed error for an HTTP status + parsed body. */
export function errorFromResponse(
  status: number,
  body: unknown,
  extra: { retryAfterMs?: number } = {},
): OpenProjectError {
  const { message, details } = extractErrorInfo(body);
  const options: OpenProjectErrorOptions = { details, body, retryAfterMs: extra.retryAfterMs };
  if (status === 401 || status === 403) return new AuthError(message, status, options);
  if (status === 404) return new NotFoundError(message, status, options);
  if (status === 409) return new ConflictError(message, status, options);
  if (status === 422) return new UnprocessableError(message, status, options);
  if (status === 429) return new RateLimitError(message, status, options);
  if (status >= 500) return new ServerError(message, status, options);
  return new OpenProjectError(message, status, options);
}
