/**
 * src/paystack/index.ts
 * ─────────────────────
 * Public surface of the Paystack module.
 * Import from here rather than individual files.
 *
 * @example
 * import { getAgentAccount, sendMoney, paystackWebhookMiddleware } from './paystack/index.js';
 */

export { PaystackClient, PaystackError, getPaystackClient } from './client.js';
export { getAgentAccount, formatAccountDetails } from './account.js';
export {
  ensureRecipient,
  sendTransfer,
  sendMoney,
  listBanks,
  resolveBankCode,
} from './transfer.js';
export {
  handleWebhook,
  paystackWebhookMiddleware,
  type WebhookHandlers,
  type WebhookEventData,
} from './webhook.js';
export type {
  PaystackDVA,
  PaystackCustomer,
  PaystackRecipient,
  PaystackTransfer,
  TransferRequest,
  PaystackWebhookPayload,
} from './types.js';
