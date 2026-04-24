import { config } from "../config.js";
import type { TradePolicy, TradeRunOptions, TradeTokenRegistryEntry } from "./types.js";

export function getTradePolicy(): TradePolicy {
  return config.tradePolicy;
}

export function buildDefaultTradeRunOptions(overrides?: Partial<TradeRunOptions>): TradeRunOptions {
  return {
    enabled: overrides?.enabled ?? config.tradePolicy.enabledByDefault,
    dryRun: overrides?.dryRun ?? false,
    strategy: overrides?.strategy ?? "auto",
    confirmations: overrides?.confirmations ?? config.tradePolicy.confirmationsRequired
  };
}

export function resolveTokenRegistryEntry(args: {
  policy: TradePolicy;
  chainId: number;
  symbol: string;
  contract: string | undefined;
}): {
  entry: TradeTokenRegistryEntry | null;
  ambiguous: boolean;
} {
  const normalizedSymbol = args.symbol.trim().toUpperCase();
  const normalizedContract = args.contract?.trim().toLowerCase();
  const matches = args.policy.tokenRegistry.filter((entry) => {
    if (entry.chainId !== args.chainId) {
      return false;
    }

    if (entry.symbol !== normalizedSymbol) {
      return false;
    }

    if (!normalizedContract) {
      return true;
    }

    return (entry.contract || "").trim().toLowerCase() === normalizedContract;
  });

  if (matches.length === 0) {
    return { entry: null, ambiguous: false };
  }

  if (matches.length > 1 && !normalizedContract) {
    return { entry: null, ambiguous: true };
  }

  return { entry: matches[0] ?? null, ambiguous: false };
}
