import { z } from 'zod';

// ─── Customer ────────────────────────────────────────────────────────────────

export const PaystackCustomerSchema = z.object({
  id: z.number(),
  customer_code: z.string(),
  email: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
});
export type PaystackCustomer = z.infer<typeof PaystackCustomerSchema>;

// ─── Dedicated Virtual Account ───────────────────────────────────────────────

export const PaystackBankSchema = z.object({
  name: z.string(),
  id: z.number(),
  slug: z.string(),
});

export const PaystackAccountSchema = z.object({
  bank: PaystackBankSchema,
  account_name: z.string(),
  account_number: z.string(),
});

export const PaystackDVASchema = z.object({
  id: z.number(),
  account_name: z.string(),
  account_number: z.string(),
  assigned: z.boolean(),
  currency: z.string(),
  bank: PaystackBankSchema,
  customer: PaystackCustomerSchema,
  active: z.boolean(),
  createdAt: z.string(),
});
export type PaystackDVA = z.infer<typeof PaystackDVASchema>;

// ─── Transfer Recipient ───────────────────────────────────────────────────────

export const PaystackRecipientSchema = z.object({
  id: z.number(),
  recipient_code: z.string(),
  name: z.string(),
  account_number: z.string(),
  bank_code: z.string(),
  currency: z.string(),
  type: z.string(),
});
export type PaystackRecipient = z.infer<typeof PaystackRecipientSchema>;

// ─── Transfer ─────────────────────────────────────────────────────────────────

export const PaystackTransferSchema = z.object({
  id: z.number(),
  transfer_code: z.string(),
  reference: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(['pending', 'success', 'failed', 'reversed', 'otp']),
  recipient: z.object({ recipient_code: z.string() }),
  reason: z.string().optional(),
  createdAt: z.string(),
});
export type PaystackTransfer = z.infer<typeof PaystackTransferSchema>;

// ─── Transfer Request (input) ─────────────────────────────────────────────────

export const TransferRequestSchema = z.object({
  /** Destination bank account number */
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
  /** CBN bank code, e.g. "058" for GTBank */
  bankCode: z.string(),
  /** Display name for the recipient */
  recipientName: z.string().min(1),
  /** Amount in Naira (will be converted to kobo internally) */
  amountNaira: z.number().positive(),
  /** Optional narrative shown on the recipient's bank statement */
  reason: z.string().optional(),
  /** Optional idempotency reference — auto-generated if omitted */
  reference: z.string().optional(),
});
export type TransferRequest = z.infer<typeof TransferRequestSchema>;

// ─── Webhook payloads ─────────────────────────────────────────────────────────

export const PaystackWebhookPayloadSchema = z.object({
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type PaystackWebhookPayload = z.infer<typeof PaystackWebhookPayloadSchema>;

// ─── Generic API response wrapper ────────────────────────────────────────────

export interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}
