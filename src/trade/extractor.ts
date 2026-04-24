import type { PageState } from "../schemas/types.js";
import type { SellInstruction } from "./types.js";

const EVM_ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;
const DEPOSIT_ADDRESS_HINT_PATTERN =
  /\b(?:send(?:\s+your)?|deposit|transfer|recipient|wallet address|sale(?:s)? address|sell address|copy address)\b/i;
const QUOTE_ID_PATTERN = /\b(?:quote(?:\s+id)?|reference|ref)\s*[:#-]?\s*([a-z0-9_-]{6,})\b/i;
const EXPIRY_PATTERN = /\b(?:expires?|valid until)\s*[:#-]?\s*([^\n]+)$/i;

const CHAIN_NAME_MAP: Record<string, number> = {
  ethereum: 1,
  mainnet: 1,
  sepolia: 11155111,
  polygon: 137,
  mumbai: 80001,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  avalanche: 43114,
  bsc: 56
};

type ExtractTradeArgs = {
  pageState: PageState;
  taskGoal: string;
  defaultChainId?: number;
};

function inferAssetKind(tokenSymbol: string): "native" | "erc20" {
  const normalized = tokenSymbol.trim().toUpperCase();
  if (["ETH", "MATIC", "POL", "BNB", "AVAX"].includes(normalized)) {
    return "native";
  }

  return "erc20";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function findDepositAddressCandidate(lines: string[]): { address: string; evidence: string[] } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeText(lines[index] || "");
    if (!line) {
      continue;
    }

    const addressMatches = line.match(EVM_ADDRESS_PATTERN) ?? [];
    if (addressMatches.length > 0 && DEPOSIT_ADDRESS_HINT_PATTERN.test(line)) {
      return {
        address: addressMatches[0]!,
        evidence: uniqueStrings([line, lines[index - 1] || "", lines[index + 1] || ""]).slice(0, 4)
      };
    }

    if (DEPOSIT_ADDRESS_HINT_PATTERN.test(line)) {
      const nextWindow = [lines[index + 1] || "", lines[index + 2] || ""];
      for (const candidateLine of nextWindow) {
        const candidateAddress = normalizeText(candidateLine).match(EVM_ADDRESS_PATTERN)?.[0];
        if (candidateAddress) {
          return {
            address: candidateAddress,
            evidence: uniqueStrings([line, candidateLine, lines[index + 2] || ""]).slice(0, 4)
          };
        }
      }
    }
  }

  return null;
}

function parseAmountAndSymbol(taskGoal: string, lines: string[]): { amount: string; tokenSymbol: string } | null {
  const textSources = [taskGoal, ...lines];
  const patterns = [
    /\b(?:sell|send|transfer)\s+([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9]{1,11})\b/i,
    /\b([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9]{1,11})\b.*\b(?:sell|send|transfer)\b/i
  ];

  for (const source of textSources) {
    const normalized = normalizeText(source);
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1] && match?.[2]) {
        return {
          amount: match[1],
          tokenSymbol: match[2].toUpperCase()
        };
      }
    }
  }

  return null;
}

function inferChainId(lines: string[], defaultChainId?: number): number | null {
  const blob = normalizeText(lines.join(" ")).toLowerCase();
  for (const [name, chainId] of Object.entries(CHAIN_NAME_MAP)) {
    if (blob.includes(name)) {
      return chainId;
    }
  }

  return defaultChainId ?? null;
}

function findQuoteId(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = normalizeText(line).match(QUOTE_ID_PATTERN);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function findExpiryLine(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = normalizeText(line).match(EXPIRY_PATTERN);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

export function taskLooksLikeTrade(taskGoal: string): boolean {
  return /\b(?:sell|cash\s*out|offramp|send(?:\s+crypto)?|transfer(?:\s+crypto)?|deposit(?:\s+crypto)?)\b/i.test(taskGoal);
}

export function pageLooksTradeReady(pageState: PageState): boolean {
  const lines = [
    ...pageState.visibleLines,
    ...pageState.headings,
    ...pageState.interactive.map((item) => item.text)
  ];
  return Boolean(findDepositAddressCandidate(lines));
}

export function extractSellInstruction(args: ExtractTradeArgs): SellInstruction | null {
  const evidenceLines = uniqueStrings([
    ...args.pageState.visibleLines,
    ...args.pageState.headings,
    ...args.pageState.interactive.map((item) => item.text)
  ]).slice(0, 80);
  const depositAddress = findDepositAddressCandidate(evidenceLines);
  if (!depositAddress) {
    return null;
  }

  const amountAndSymbol = parseAmountAndSymbol(args.taskGoal, evidenceLines);
  const chainId = inferChainId(depositAddress.evidence.concat(evidenceLines), args.defaultChainId);
  if (!amountAndSymbol || !chainId) {
    return null;
  }

  return {
    mode: "deposit_address_transfer",
    chainFamily: "evm",
    chainId,
    assetKind: inferAssetKind(amountAndSymbol.tokenSymbol),
    tokenSymbol: amountAndSymbol.tokenSymbol,
    tokenContract: undefined,
    tokenDecimals: undefined,
    amount: amountAndSymbol.amount,
    recipientAddress: depositAddress.address,
    recipientMemo: undefined,
    quoteId: findQuoteId(evidenceLines),
    expiresAt: findExpiryLine(evidenceLines),
    sourceUrl: args.pageState.url,
    sourceTitle: args.pageState.title,
    evidenceText: uniqueStrings([...depositAddress.evidence, args.taskGoal]).slice(0, 8)
  };
}
