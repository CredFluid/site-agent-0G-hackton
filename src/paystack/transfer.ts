import crypto from 'crypto';
import { getPaystackClient } from './client.js';
import {
  TransferRequestSchema,
  PaystackRecipientSchema,
  PaystackTransferSchema,
  type TransferRequest,
  type PaystackRecipient,
  type PaystackTransfer,
} from './types.js';

/**
 * Paystack Transfer module.
 *
 * Supports two operations:
 *   1. ensureRecipient()  — creates a transfer recipient (bank account holder)
 *                           or returns an existing one if already registered
 *   2. sendTransfer()     — initiates a Naira transfer to a recipient
 *
 * A convenience wrapper sendMoney() combines both steps.
 *
 * NOTE: Real transfers require:
 *   - A live Paystack secret key
 *   - Transfers feature enabled on your Paystack dashboard
 *   - Sufficient Paystack balance
 *
 * Set PAYSTACK_TRANSFER_ENABLED=true in .env to allow live transfers.
 * Omitting this variable (or setting it to false) will log the transfer
 * details but NOT submit them to Paystack — safe for testing.
 */

const TRANSFER_ENABLED =
  process.env['PAYSTACK_TRANSFER_ENABLED'] === 'true';

// ─── Recipient ────────────────────────────────────────────────────────────────

/**
 * Creates a Paystack transfer recipient for the given bank account.
 * If a recipient with the same account_number + bank_code already exists
 * on your Paystack account, Paystack returns the existing record.
 */
export async function ensureRecipient(
  accountNumber: string,
  bankCode: string,
  name: string,
): Promise<PaystackRecipient> {
  const client = getPaystackClient();

  const raw = await client.post<PaystackRecipient>('/transferrecipient', {
    type: 'nuban',
    currency: 'NGN',
    account_number: accountNumber,
    bank_code: bankCode,
    name,
  });

  return PaystackRecipientSchema.parse(raw);
}

// ─── Transfer ─────────────────────────────────────────────────────────────────

function generateReference(): string {
  return `sa-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}

/**
 * Initiates a transfer to an already-created recipient.
 * In dry-run mode (PAYSTACK_TRANSFER_ENABLED != true) this logs and returns
 * a mock pending record without hitting the API.
 */
export async function sendTransfer(
  recipientCode: string,
  amountNaira: number,
  reason = 'Site Agent Pro payout',
  reference?: string,
): Promise<PaystackTransfer> {
  const ref = reference ?? generateReference();
  const amountKobo = nairaToKobo(amountNaira);

  if (!TRANSFER_ENABLED) {
    console.warn(
      `[paystack/transfer] DRY-RUN — transfer NOT submitted.\n` +
      `  Recipient : ${recipientCode}\n` +
      `  Amount    : ₦${amountNaira.toLocaleString()} (${amountKobo} kobo)\n` +
      `  Reason    : ${reason}\n` +
      `  Reference : ${ref}\n` +
      `  → Set PAYSTACK_TRANSFER_ENABLED=true to send for real.`,
    );

    // Return a synthetic pending record so callers can handle the result uniformly
    return {
      id: 0,
      transfer_code: 'TRF_dryrun',
      reference: ref,
      amount: amountKobo,
      currency: 'NGN',
      status: 'pending',
      recipient: { recipient_code: recipientCode },
      reason,
      createdAt: new Date().toISOString(),
    };
  }

  const client = getPaystackClient();
  const raw = await client.post<PaystackTransfer>('/transfer', {
    source: 'balance',
    currency: 'NGN',
    recipient: recipientCode,
    amount: amountKobo,
    reason,
    reference: ref,
  });

  const transfer = PaystackTransferSchema.parse(raw);
  console.log(
    `[paystack/transfer] Transfer initiated — code: ${transfer.transfer_code}, ` +
    `status: ${transfer.status}, ref: ${transfer.reference}`,
  );
  return transfer;
}

// ─── Convenience wrapper ──────────────────────────────────────────────────────

/**
 * One-shot helper: creates the recipient then immediately sends the transfer.
 *
 * @example
 * const result = await sendMoney({
 *   accountNumber: '0123456789',
 *   bankCode: '058',           // GTBank
 *   recipientName: 'Ada Obi',
 *   amountNaira: 5000,
 *   reason: 'Audit payout',
 * });
 */
export async function sendMoney(request: TransferRequest): Promise<{
  recipient: PaystackRecipient;
  transfer: PaystackTransfer;
}> {
  const validated = TransferRequestSchema.parse(request);

  const recipient = await ensureRecipient(
    validated.accountNumber,
    validated.bankCode,
    validated.recipientName,
  );

  const transfer = await sendTransfer(
    recipient.recipient_code,
    validated.amountNaira,
    validated.reason,
    validated.reference,
  );

  return { recipient, transfer };
}

// ─── Bank list helper ─────────────────────────────────────────────────────────

export interface PaystackBank {
  name: string;
  slug: string;
  code: string;
  country: string;
  currency: string;
}

/**
 * Returns the full list of Nigerian banks supported by Paystack transfers.
 * Useful for letting users (or the LLM planner) resolve a bank name to its code.
 */
export async function listBanks(): Promise<PaystackBank[]> {
  const client = getPaystackClient();
  return client.get<PaystackBank[]>('/bank', { country: 'nigeria', perPage: 100 });
}

/**
 * Resolve a bank name or partial name to its CBN code.
 * Returns the first match (case-insensitive).
 *
 * @example
 * const code = await resolveBankCode('guaranty');  // → '058'
 */
export async function resolveBankCode(nameOrSlug: string): Promise<string | null> {
  const banks = await listBanks();
  const q = nameOrSlug.toLowerCase();
  const match = banks.find(
    (b) =>
      b.name.toLowerCase().includes(q) ||
      b.slug.toLowerCase().includes(q) ||
      b.code === nameOrSlug,
  );
  return match?.code ?? null;
}
