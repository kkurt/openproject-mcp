import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  AuthError,
  HttpClient,
  NetworkError,
  NotFoundError,
  RateLimitError,
  UnprocessableError,
  parseRetryAfter,
} from '@openproject-agent/core';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = 'https://op.test';

function makeClient(overrides: Record<string, unknown> = {}): HttpClient {
  return new HttpClient({ url: BASE, apiKey: 'secret', backoffBaseMs: 500, timeoutMs: 0, ...overrides });
}

function errBody(message: string, subErrors: string[] = []): unknown {
  return {
    _type: 'Error',
    errorIdentifier: 'urn:openproject-org:api:v3:errors:PropertyConstraintViolation',
    message,
    _embedded: { errors: subErrors.map((m) => ({ _type: 'Error', message: m })) },
  };
}

describe('parseRetryAfter', () => {
  it('parses seconds, dates, and rejects garbage', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
    const now = Date.parse('2024-01-01T00:00:00Z');
    expect(parseRetryAfter('Mon, 01 Jan 2024 00:00:10 GMT', now)).toBe(10_000);
  });
});

describe('HttpClient auth & errors', () => {
  it('sends HTTP Basic auth with the apikey username', async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${BASE}/api/v3/users/me`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ id: 1, name: 'Me' });
      }),
    );
    await makeClient().get('/users/me');
    expect(auth).toBe(`Basic ${Buffer.from('apikey:secret').toString('base64')}`);
  });

  it('maps status codes to typed errors and surfaces sub-error details', async () => {
    server.use(
      http.get(`${BASE}/api/v3/a`, () => HttpResponse.json(errBody('unauthorized'), { status: 401 })),
      http.get(`${BASE}/api/v3/b`, () => HttpResponse.json(errBody('missing'), { status: 404 })),
      http.get(`${BASE}/api/v3/c`, () => HttpResponse.json(errBody('bad', ['subject is required']), { status: 422 })),
    );
    const client = makeClient();
    await expect(client.get('/a')).rejects.toBeInstanceOf(AuthError);
    await expect(client.get('/b')).rejects.toBeInstanceOf(NotFoundError);
    const err = (await client.get('/c').catch((e) => e)) as UnprocessableError;
    expect(err).toBeInstanceOf(UnprocessableError);
    expect(err.status).toBe(422);
    expect(err.details.map((d) => d.message)).toContain('subject is required');
  });
});

describe('HttpClient retry/backoff', () => {
  it('retries 429 with exponential backoff, then succeeds', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/api/v3/rl`, () => {
        calls += 1;
        if (calls <= 2) return HttpResponse.json(errBody('slow down'), { status: 429 });
        return HttpResponse.json({ ok: true });
      }),
    );
    const sleep = vi.fn(async () => {});
    const res = await makeClient({ sleep }).get('/rl');
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it('honors Retry-After and throws RateLimitError after exhausting retries', async () => {
    server.use(
      http.get(`${BASE}/api/v3/rl2`, () =>
        HttpResponse.json(errBody('slow'), { status: 429, headers: { 'Retry-After': '2' } }),
      ),
    );
    const sleep = vi.fn(async () => {});
    const err = (await makeClient({ sleep, maxRetries: 2 }).get('/rl2').catch((e) => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(2000);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 2000]);
  });

  it('retries 5xx then succeeds', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/api/v3/srv`, () => {
        calls += 1;
        if (calls === 1) return new HttpResponse('boom', { status: 503 });
        return HttpResponse.json({ ok: true });
      }),
    );
    const sleep = vi.fn(async () => {});
    expect(await makeClient({ sleep }).get('/srv')).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('retries transient network failures then throws NetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const sleep = vi.fn(async () => {});
    const client = new HttpClient({ url: BASE, apiKey: 'k', fetchImpl, sleep, maxRetries: 2, timeoutMs: 0 });
    const err = (await client.get('/x').catch((e) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
