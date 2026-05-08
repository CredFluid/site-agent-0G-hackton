export type ZGNetworkName = "galileo" | "mainnet";

export type ZGNetworkEndpoints = {
  network: ZGNetworkName;
  evmRpcUrl: string;
  storageIndexerRpcUrl: string | undefined;
  explorerBaseUrl: string;
};

const ZG_NETWORK_DEFAULTS: Record<
  ZGNetworkName,
  {
    evmRpcUrl: string;
    storageIndexerRpcUrl?: string;
    explorerBaseUrl: string;
  }
> = {
  galileo: {
    evmRpcUrl: "https://evmrpc-testnet.0g.ai",
    storageIndexerRpcUrl: "https://indexer-storage-testnet-turbo.0g.ai",
    explorerBaseUrl: "https://chainscan-galileo.0g.ai"
  },
  mainnet: {
    evmRpcUrl: "https://evmrpc.0g.ai",
    explorerBaseUrl: "https://chainscan.0g.ai"
  }
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveZGNetworkName(value: string | undefined): ZGNetworkName {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return "galileo";
  }
  if (normalized === "mainnet" || normalized === "aristotle") {
    return "mainnet";
  }
  if (normalized === "galileo" || normalized === "testnet") {
    return "galileo";
  }

  throw new Error(`ZG_NETWORK must be "galileo" or "mainnet"; received "${value}".`);
}

export function resolveZGNetworkEndpoints(env: NodeJS.ProcessEnv = process.env): ZGNetworkEndpoints {
  const network = resolveZGNetworkName(env.ZG_NETWORK);
  const defaults = ZG_NETWORK_DEFAULTS[network];

  return {
    network,
    evmRpcUrl: normalizeOptionalString(env.ZG_CHAIN_RPC_URL) ?? defaults.evmRpcUrl,
    storageIndexerRpcUrl: normalizeOptionalString(env.ZG_STORAGE_INDEXER_RPC) ?? defaults.storageIndexerRpcUrl,
    explorerBaseUrl: normalizeOptionalString(env.ZG_EXPLORER_URL) ?? defaults.explorerBaseUrl
  };
}

export function assertZGMainnetEndpoints(endpoints: Pick<ZGNetworkEndpoints, "network" | "evmRpcUrl" | "explorerBaseUrl">): void {
  if (endpoints.network !== "mainnet") {
    return;
  }

  const values = [
    ["ZG_CHAIN_RPC_URL", endpoints.evmRpcUrl],
    ["ZG_EXPLORER_URL", endpoints.explorerBaseUrl]
  ] as const;

  for (const [name, value] of values) {
    if (/(galileo|testnet)/i.test(value)) {
      throw new Error(`${name} points to a testnet endpoint while ZG_NETWORK=mainnet: ${value}`);
    }
  }
}

export function assertZGProofEndpoints(endpoints: ZGNetworkEndpoints): void {
  assertZGMainnetEndpoints(endpoints);

  if (!endpoints.storageIndexerRpcUrl) {
    throw new Error(
      `ZG_NETWORK=${endpoints.network} requires ZG_STORAGE_INDEXER_RPC for 0G Storage uploads.`
    );
  }

  if (endpoints.network === "mainnet" && /(galileo|testnet)/i.test(endpoints.storageIndexerRpcUrl)) {
    throw new Error(
      `ZG_STORAGE_INDEXER_RPC points to a testnet endpoint while ZG_NETWORK=mainnet: ${endpoints.storageIndexerRpcUrl}`
    );
  }
}
