import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  PaystackWebhookPayloadSchema,
  type PaystackWebhookPayload,
} from './types.js';

/**
 * Paystack Webhook handler.
 *
 * Usage — wire into your Express/Node HTTP server:
 *
 *   import { handleWebhook } from './paystack/webhook.js';
 *
 *   app.post('/webhooks/paystack', express.raw({ type: 'application/json' }), (req, res) => {
 *     handleWebhook(req, res, {
 *       onChargeSuccess:   (data) => { ... },
 *       onTransferSuccess: (data) => { ... },
 *       onTransferFailed:  (data) => { ... },
 *     });
 *   });
 *
 * IMPORTANT: The route MUST use raw body parsing (not JSON parsing) so the
 * HMAC signature can be verified against the exact bytes Paystack sent.
 * With Express: express.raw({ type: 'application/json' })
 *
 * Paystack signs every webhook with your secret key via HMAC-SHA512.
 * Requests with an invalid signature are rejected with HTTP 400.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type WebhookEventData = Record<string, unknown>;

export interface WebhookHandlers {
  /** Fired when a customer successfully pays into the agent's DVA */
  onChargeSuccess?: (data: WebhookEventData) => void | Promise<void>;
  /** Fired when an outbound transfer completes successfully */
  onTransferSuccess?: (data: WebhookEventData) => void | Promise<void>;
  /** Fired when an outbound transfer fails */
  onTransferFailed?: (data: WebhookEventData) => void | Promise<void>;
  /** Fired when an outbound transfer is reversed */
  onTransferReversed?: (data: WebhookEventData) => void | Promise<void>;
  /** Catch-all for any other event */
  onUnknownEvent?: (event: string, data: WebhookEventData) => void | Promise<void>;
}

// ─── Signature verification ───────────────────────────────────────────────────

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = process.env['PAYSTACK_SECRET_KEY'];
  if (!secret) {
    console.error('[paystack/webhook] PAYSTACK_SECRET_KEY is not set — rejecting all webhooks');
    return false;
  }
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

// ─── Body reader ─────────────────────────────────────────────────────────────

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Verifies the Paystack signature and dispatches to the appropriate handler.
 * Works with both raw Node http.IncomingMessage and Express Request
 * (as long as the body has NOT already been parsed — use express.raw()).
 *
 * Always responds to Paystack with 200 OK once the signature is valid,
 * regardless of handler outcome, to prevent Paystack from retrying.
 */
export async function handleWebhook(
  req: IncomingMessage & { body?: Buffer },
  res: ServerResponse,
  handlers: WebhookHandlers,
): Promise<void> {
  // Support pre-read body (e.g. express.raw middleware) or read it ourselves
  const rawBody: Buffer =
    req.body instanceof Buffer ? req.body : await readRawBody(req);

  const signature = req.headers['x-paystack-signature'] as string | undefined;

  if (!verifySignature(rawBody, signature)) {
    console.warn('[paystack/webhook] Invalid signature — request rejected');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid signature' }));
    return;
  }

  // Acknowledge immediately — Paystack expects a fast 200
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ received: true }));

  // Parse and dispatch
  let payload: PaystackWebhookPayload;
  try {
    payload = PaystackWebhookPayloadSchema.parse(JSON.parse(rawBody.toString('utf8')));
  } catch (err) {
    console.error('[paystack/webhook] Failed to parse payload:', err);
    return;
  }

  const { event, data } = payload;
  console.log(`[paystack/webhook] Received event: ${event}`);

  try {
    switch (event) {
      case 'charge.success':
        await handlers.onChargeSuccess?.(data as WebhookEventData);
        break;

      case 'transfer.success':
        await handlers.onTransferSuccess?.(data as WebhookEventData);
        break;

      case 'transfer.failed':
        await handlers.onTransferFailed?.(data as WebhookEventData);
        break;

      case 'transfer.reversed':
        await handlers.onTransferReversed?.(data as WebhookEventData);
        break;

      default:
        await handlers.onUnknownEvent?.(event, data as WebhookEventData);
        break;
    }
  } catch (err) {
    console.error(`[paystack/webhook] Handler error for event "${event}":`, err);
  }
}

// ─── Express middleware factory (convenience) ─────────────────────────────────

/**
 * Returns an Express-compatible middleware that handles Paystack webhooks.
 * Mount this BEFORE any body-parser middleware on the webhook route.
 *
 * @example
 * import express from 'express';
 * import { paystackWebhookMiddleware } from './paystack/webhook.js';
 *
 * const app = express();
 * app.post(
 *   '/webhooks/paystack',
 *   paystackWebhookMiddleware({
 *     onChargeSuccess: async (data) => {
 *       console.log('Payment received:', data['amount'], 'kobo');
 *       // → queue the audit run here
 *     },
 *     onTransferSuccess: async (data) => {
 *       console.log('Transfer completed:', data['transfer_code']);
 *     },
 *     onTransferFailed: async (data) => {
 *       console.error('Transfer failed:', data['transfer_code']);
 *     },
 *   }),
 * );
 */
export function paystackWebhookMiddleware(handlers: WebhookHandlers) {
  return async (
    req: IncomingMessage & { body?: Buffer },
    res: ServerResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: () => void,
  ): Promise<void> => {
    await handleWebhook(req, res, handlers);
  };
}
