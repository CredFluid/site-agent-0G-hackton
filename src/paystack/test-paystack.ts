/**
 * Paystack integration smoke-test.
 *
 * Run with:
 *   npx tsx src/paystack/test-paystack.ts
 *
 * What it does (in order):
 *   1. Verifies PAYSTACK_SECRET_KEY is set
 *   2. Creates / retrieves the agent's Dedicated Virtual Account (DVA)
 *   3. Prints the bank account details
 *   4. Fetches the list of supported banks and resolves a sample bank name
 *   5. Runs a DRY-RUN transfer (no money moves unless PAYSTACK_TRANSFER_ENABLED=true)
 *
 * No flags needed — all config is read from .env.
 */

import 'dotenv/config';
import {
  getAgentAccount,
  formatAccountDetails,
  sendMoney,
  listBanks,
  resolveBankCode,
} from './index.js';

const DIVIDER = '─'.repeat(56);

function section(title: string): void {
  console.log(`\n${DIVIDER}`);
  console.log(`  ${title}`);
  console.log(DIVIDER);
}

async function main(): Promise<void> {
  console.log('\n🚀  Site Agent Pro — Paystack Integration Test\n');

  // ── 1. Env check ────────────────────────────────────────────────────────────
  section('1 / 5  Environment');
  const key = process.env['PAYSTACK_SECRET_KEY'];
  if (!key) {
    console.error('❌  PAYSTACK_SECRET_KEY is not set in .env — aborting.');
    process.exit(1);
  }
  const mode = key.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST 🟡';
  console.log(`  Key mode : ${mode}`);
  console.log(
    `  Transfers: ${
      process.env['PAYSTACK_TRANSFER_ENABLED'] === 'true'
        ? 'ENABLED (real money will move)'
        : 'DRY-RUN (safe — nothing will be sent)'
    }`,
  );

  // ── 2. Dedicated Virtual Account ────────────────────────────────────────────
  section('2 / 5  Dedicated Virtual Account');
  console.log('  Fetching / creating agent DVA…');
  const dva = await getAgentAccount();
  console.log('\n' + formatAccountDetails(dva).replace(/^/gm, '  '));

  // ── 3. Bank list ─────────────────────────────────────────────────────────────
  section('3 / 5  Bank List');
  console.log('  Fetching supported banks…');
  const banks = await listBanks();
  console.log(`  ${banks.length} banks returned from Paystack.\n`);

  // Show first 5 as a sample
  banks.slice(0, 5).forEach((b) => {
    console.log(`  ${b.code.padEnd(6)} ${b.name}`);
  });
  if (banks.length > 5) {
    console.log(`  … and ${banks.length - 5} more`);
  }

  // ── 4. Bank code resolution ──────────────────────────────────────────────────
  section('4 / 5  Bank Code Resolution');
  const samples = ['guaranty', 'zenith', 'access', 'firstbank'];
  for (const name of samples) {
    const code = await resolveBankCode(name);
    console.log(`  "${name}" → ${code ?? '(not found)'}`);
  }

  // ── 5. Dry-run transfer ──────────────────────────────────────────────────────
  section('5 / 5  Transfer (dry-run safe)');
  console.log('  Initiating test transfer…\n');

  const { recipient, transfer } = await sendMoney({
    accountNumber: '0123456789',          // ← replace with a real account for live tests
    bankCode: '058',                       // GTBank
    recipientName: 'Test Recipient',
    amountNaira: 100,
    reason: 'Site Agent Pro smoke test',
  });

  console.log(`  Recipient code : ${recipient.recipient_code}`);
  console.log(`  Transfer code  : ${transfer.transfer_code}`);
  console.log(`  Amount         : ₦${(transfer.amount / 100).toLocaleString()}`);
  console.log(`  Status         : ${transfer.status}`);
  console.log(`  Reference      : ${transfer.reference}`);

  console.log(`\n${DIVIDER}`);
  console.log('  ✅  All checks passed.\n');
}

main().catch((err: unknown) => {
  console.error('\n❌  Test failed:', err);
  process.exit(1);
});
