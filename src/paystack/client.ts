import type { PaystackResponse } from './types.js';

/**
 * Thin fetch-based wrapper for the Paystack REST API.
 * Uses Node 20+ built-in fetch — no external dependencies required.
 * Reads PAYSTACK_SECRET_KEY from the environment.
 *
 * All public methods return the unwrapped `data` field from
 * Paystack's standard { status, message, data } envelope, and
 * throw a descriptive PaystackError on any non-2xx response.
 */

const BASE_URL = 'https://api.paystack.co';
const TIMEOUT_MS = 30_000;

export class PaystackError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(`Paystack API error (${statusCode}): ${message}`);
    this.name = 'PaystackError';
  }
}

export class PaystackClient {
  private readonly headers: Record<string, string>;

  constructor(secretKey?: string) {
    const key = secretKey ?? process.env['PAYSTACK_SECRET_KEY'];
    if (!key) {
      throw new Error(
        'PAYSTACK_SECRET_KEY is not set. Add it to your .env file.',
      );
    }
    this.headers = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  // ─── Core request helpers ─────────────────────────────────────────────────

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return this.request<T>(url.toString(), { method: 'GET' });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(`${BASE_URL}${path}`, {
      method: 'POST',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(`${BASE_URL}${path}`, {
      method: 'PUT',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  // ─── Internal fetch with timeout ─────────────────────────────────────────

  private async request<T>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: this.headers,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new PaystackError(0, `Request timed out after ${TIMEOUT_MS}ms`);
      }
      throw new PaystackError(0, String(err), err);
    } finally {
      clearTimeout(timer);
    }

    let json: PaystackResponse<T>;
    try {
      json = (await res.json()) as PaystackResponse<T>;
    } catch {
      throw new PaystackError(res.status, `Non-JSON response from Paystack (${res.status})`);
    }

    if (!res.ok || !json.status) {
      throw new PaystackError(
        res.status,
        json.message ?? `HTTP ${res.status}`,
        json,
      );
    }

    return json.data;
  }
}

// Singleton — reuse across the process lifetime
let _client: PaystackClient | null = null;

export function getPaystackClient(): PaystackClient {
  if (!_client) _client = new PaystackClient();
  return _client;
}
