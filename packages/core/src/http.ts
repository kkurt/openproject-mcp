/**
 * Low-level HTTP transport for the OpenProject API v3.
 *
 * Responsibilities:
 *  - Basic auth (`apikey:<key>`) and base URL (`${url}/api/v3`).
 *  - Typed errors for every non-2xx response (see ./errors).
 *  - Exponential-backoff retry for 429 and 5xx (and transient network errors),
 *    honoring `Retry-After`. `sleep` is injectable so tests stay fast/deterministic.
 *
 * The API key lives only inside the Authorization header and is never logged.
 */
import { NetworkError, OpenProjectError, errorFromResponse } from './errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** OpenProject base URL, e.g. https://op.example.com (with or without trailing slash). */
  url: string;
  /** OpenProject API key. */
  apiKey: string;
  /** Override fetch (tests / custom agents). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Override the delay function (tests). Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Max retry attempts for 429/5xx/network errors. Default 3. */
  maxRetries?: number;
  /** Base backoff delay in ms (grows as base * 2^attempt). Default 500. */
  backoffBaseMs?: number;
  /** Per-request timeout in ms. Default 30000. 0 disables. */
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (seconds or HTTP-date) into ms, or undefined. */
export function parseRetryAfter(headerValue: string | null, now: number = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now);
  return undefined;
}

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiBase: string;
  private readonly authHeader: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions) {
    if (!options.url) throw new Error('HttpClient: `url` is required');
    if (!options.apiKey) throw new Error('HttpClient: `apiKey` is required');
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.apiBase = `${this.baseUrl}/api/v3`;
    this.authHeader = `Basic ${Buffer.from(`apikey:${options.apiKey}`).toString('base64')}`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options);
  }
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.apiBase}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private backoff(attempt: number): number {
    return this.backoffBaseMs * 2 ** attempt;
  }

  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    if (!this.timeoutMs) return this.fetchImpl(url, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/hal+json',
      ...options.headers,
    };
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let lastError: OpenProjectError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(url, init);
      } catch (err) {
        lastError = new NetworkError((err as Error)?.message || 'network request failed', 0, { cause: err });
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw lastError;
      }

      if (res.ok) return this.parseBody<T>(res);

      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const retryable = res.status === 429 || res.status >= 500;
      const body = await this.readErrorBody(res);
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryAfterMs ?? this.backoff(attempt));
        continue;
      }
      throw errorFromResponse(res.status, body, { retryAfterMs });
    }
    // Unreachable in practice; keeps the type checker happy.
    throw lastError ?? new OpenProjectError('request failed after retries', 0);
  }

  private async parseBody<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async readErrorBody(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => '');
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
