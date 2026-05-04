import fs from 'fs';
import path from 'path';
import { getPaystackClient } from './client.js';
import {
  PaystackCustomerSchema,
  PaystackDVASchema,
  type PaystackCustomer,
  type PaystackDVA,
} from './types.js';

/**
 * Manages the agent's Dedicated Virtual Account (DVA).
 *
 * On first call, createAgentAccount() will:
 *   1. Create (or retrieve) a Paystack customer for the agent
 *   2. Create a dedicated virtual bank account tied to that customer
 *   3. Cache the result locally so restarts don't re-create it
 *
 * The cached account file is written to:
 *   <SITE_AGENT_DATA_DIR>/paystack/dva.json   (if env var set)
 *   ./data/paystack/dva.json                  (fallback)
 */

const DVA_PROVIDER =
  (process.env['PAYSTACK_DVA_PROVIDER'] as 'wema-bank' | 'guaranty-trust-bank') ??
  'wema-bank';

const AGENT_EMAIL =
  process.env['PAYSTACK_AGENT_EMAIL'] || 'agent@site-agent-pro.com';

const AGENT_FIRST_NAME =
  process.env['PAYSTACK_AGENT_FIRST_NAME'] ?? 'Site';

const AGENT_LAST_NAME =
  process.env['PAYSTACK_AGENT_LAST_NAME'] ?? 'Agent';

function dvaCachePath(): string {
  const base = process.env['SITE_AGENT_DATA_DIR'] ?? path.join(process.cwd(), 'data');
  return path.join(base, 'paystack', 'dva.json');
}

function loadCachedDVA(): PaystackDVA | null {
  try {
    const raw = fs.readFileSync(dvaCachePath(), 'utf8');
    const parsed = PaystackDVASchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function cacheDVA(dva: PaystackDVA): void {
  const p = dvaCachePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(dva, null, 2), 'utf8');
}

// ─── Customer helpers ─────────────────────────────────────────────────────────

async function findOrCreateCustomer(): Promise<PaystackCustomer> {
  const client = getPaystackClient();

  // Search for existing customer by email
  try {
    const existing = await client.get<PaystackCustomer>(
      `/customer/${encodeURIComponent(AGENT_EMAIL)}`,
    );
    const parsed = PaystackCustomerSchema.safeParse(existing);
    if (parsed.success) {
      console.log(`[paystack/account] Found existing customer: ${parsed.data.customer_code}`);
      return parsed.data;
    }
  } catch {
    // 404 → customer doesn't exist yet, fall through to create
  }

  const created = await client.post<PaystackCustomer>('/customer', {
    email: AGENT_EMAIL,
    first_name: AGENT_FIRST_NAME,
    last_name: AGENT_LAST_NAME,
  });

  const parsed = PaystackCustomerSchema.parse(created);
  console.log(`[paystack/account] Created new customer: ${parsed.customer_code}`);
  return parsed;
}

// ─── DVA helpers ──────────────────────────────────────────────────────────────

async function createDVA(customerCode: string): Promise<PaystackDVA> {
  const client = getPaystackClient();
  const raw = await client.post<PaystackDVA>('/dedicated_account', {
    customer: customerCode,
    preferred_bank: DVA_PROVIDER,
  });
  return PaystackDVASchema.parse(raw);
}

async function listDVAsForCustomer(customerCode: string): Promise<PaystackDVA[]> {
  const client = getPaystackClient();
  const raw = await client.get<PaystackDVA[]>('/dedicated_account', {
    customer: customerCode,
  });
  return Array.isArray(raw) ? raw.map((d) => PaystackDVASchema.parse(d)) : [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the agent's dedicated virtual account, creating it on first call.
 * Subsequent calls return the locally cached result (no extra API hit).
 */
export async function getAgentAccount(): Promise<PaystackDVA> {
  const cached = loadCachedDVA();
  if (cached) {
    return cached;
  }

  const customer = await findOrCreateCustomer();

  // Check if a DVA already exists for this customer
  const existing = await listDVAsForCustomer(customer.customer_code);
  if (existing.length > 0) {
    const dva = existing[0]!;
    cacheDVA(dva);
    return dva;
  }

  // Create a new DVA
  const dva = await createDVA(customer.customer_code);
  cacheDVA(dva);

  console.log(
    `[paystack/account] DVA created: ${dva.account_number} (${dva.bank.name})`,
  );
  return dva;
}

/**
 * Pretty-prints the agent's virtual account details.
 */
export function formatAccountDetails(dva: PaystackDVA): string {
  return [
    `Bank:           ${dva.bank.name}`,
    `Account Number: ${dva.account_number}`,
    `Account Name:   ${dva.account_name}`,
    `Currency:       ${dva.currency}`,
    `Active:         ${dva.active ? 'Yes' : 'No'}`,
  ].join('\n');
}
