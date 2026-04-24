import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/* ------------------------------------------------------------------ */
/*  Environment schema                                                 */
/* ------------------------------------------------------------------ */

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  
  // Strip surrounding quotes if they exist
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  
  return trimmed;
}

const WalletEnvSchema = z.object({
  WALLET_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  WALLET_MNEMONIC: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  WALLET_RPC_URL: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  WALLET_CHAIN_ID: z.coerce.number().int().positive().default(11155111),
  WALLET_METAMASK_EXTENSION_PATH: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  WALLET_METAMASK_USER_DATA_DIR: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value))
});

const parsed = WalletEnvSchema.parse(process.env);

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type WalletConfig = {
  address: string;
  chainId: number;
  rpcUrl: string;
  metamaskExtensionPath?: string | undefined;
  metamaskUserDataDir?: string | undefined;
};

type EthersWallet = {
  address: string;
  populateTransaction: (tx: Record<string, unknown>) => Promise<Record<string, unknown>>;
  signTransaction: (tx: Record<string, unknown>) => Promise<string>;
  signMessage: (message: string | Uint8Array) => Promise<string>;
  signTypedData: (
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>
  ) => Promise<string>;
  provider: unknown;
};

type EthersModule = {
  Wallet: new (privateKey: string, provider?: unknown) => EthersWallet;
  HDNodeWallet: { fromMnemonic: (mnemonic: unknown) => EthersWallet };
  Mnemonic: { fromPhrase: (phrase: string) => unknown };
  JsonRpcProvider: new (url: string) => unknown;
};

/* ------------------------------------------------------------------ */
/*  Lazy singleton                                                     */
/* ------------------------------------------------------------------ */

let cachedEthers: EthersModule | null = null;
let cachedWallet: EthersWallet | null = null;

async function loadEthers(): Promise<EthersModule> {
  if (cachedEthers) {
    return cachedEthers;
  }

  const mod = (await import("ethers")) as unknown as EthersModule & { default?: EthersModule };
  cachedEthers = mod.default ?? mod;
  return cachedEthers;
}

async function resolveWallet(): Promise<EthersWallet> {
  if (cachedWallet) {
    return cachedWallet;
  }

  const ethers = await loadEthers();
  const rpcUrl = parsed.WALLET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("WALLET_RPC_URL is required when a wallet private key or mnemonic is configured.");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  if (parsed.WALLET_PRIVATE_KEY) {
    const key = parsed.WALLET_PRIVATE_KEY.startsWith("0x")
      ? parsed.WALLET_PRIVATE_KEY
      : `0x${parsed.WALLET_PRIVATE_KEY}`;
    cachedWallet = new ethers.Wallet(key, provider);
    return cachedWallet;
  }

  if (parsed.WALLET_MNEMONIC) {
    const mnemonic = ethers.Mnemonic.fromPhrase(parsed.WALLET_MNEMONIC);
    const hdWallet = ethers.HDNodeWallet.fromMnemonic(mnemonic);
    // HDNodeWallet needs to be reconnected with the provider
    cachedWallet = new ethers.Wallet(
      (hdWallet as unknown as { privateKey: string }).privateKey,
      provider
    );
    return cachedWallet;
  }

  throw new Error("Either WALLET_PRIVATE_KEY or WALLET_MNEMONIC must be set.");
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export function isWalletConfigured(): boolean {
  return Boolean((parsed.WALLET_PRIVATE_KEY || parsed.WALLET_MNEMONIC) && parsed.WALLET_RPC_URL);
}

export function getWalletChainId(): number {
  return parsed.WALLET_CHAIN_ID;
}

export function getMetaMaskExtensionPath(): string | undefined {
  return parsed.WALLET_METAMASK_EXTENSION_PATH;
}

export function getMetaMaskUserDataDir(): string | undefined {
  return parsed.WALLET_METAMASK_USER_DATA_DIR;
}

export async function getWalletConfig(): Promise<WalletConfig | null> {
  if (!isWalletConfigured()) {
    return null;
  }

  const wallet = await resolveWallet();
  return {
    address: wallet.address,
    chainId: parsed.WALLET_CHAIN_ID,
    rpcUrl: parsed.WALLET_RPC_URL!,
    metamaskExtensionPath: parsed.WALLET_METAMASK_EXTENSION_PATH,
    metamaskUserDataDir: parsed.WALLET_METAMASK_USER_DATA_DIR
  };
}

export async function getWalletAddress(): Promise<string> {
  const wallet = await resolveWallet();
  return wallet.address;
}

export async function getWalletProvider(): Promise<unknown> {
  const wallet = await resolveWallet();
  return wallet.provider;
}

export async function signTransaction(tx: Record<string, unknown>): Promise<string> {
  const wallet = await resolveWallet();
  return wallet.signTransaction(tx);
}

export async function signMessage(message: string): Promise<string> {
  const wallet = await resolveWallet();
  return wallet.signMessage(message);
}

export async function signTypedData(
  domain: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
  value: Record<string, unknown>
): Promise<string> {
  const wallet = await resolveWallet();
  return wallet.signTypedData(domain, types, value);
}

/**
 * Send a raw transaction via the wallet's connected provider.
 * Returns the transaction hash.
 */
export async function sendTransaction(tx: Record<string, unknown>): Promise<string> {
  const wallet = await resolveWallet();
  const populated = await wallet.populateTransaction(tx);
  const signed = await wallet.signTransaction(populated);
  const provider = wallet.provider as { send: (method: string, params: unknown[]) => Promise<string> };
  return provider.send("eth_sendRawTransaction", [signed]);
}
