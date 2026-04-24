import { getWalletAddress, getWalletChainId, isWalletConfigured } from "../wallet/wallet.js";
import { parseTokenAmount, readErc20Balance, readNativeBalance } from "./evm/erc20.js";
import { resolveTokenRegistryEntry } from "./policy.js";
import type { SellInstruction, TradePolicy, TradeRunOptions, TradeValidationResult } from "./types.js";

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function isNumberishDecimal(value: string): boolean {
  return /^[0-9]+(?:\.[0-9]+)?$/.test(value.trim());
}

function compareDecimalStrings(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.trim().split(".");
  const [rightWhole = "0", rightFraction = ""] = right.trim().split(".");
  const normalizedLeftWhole = leftWhole.replace(/^0+/, "") || "0";
  const normalizedRightWhole = rightWhole.replace(/^0+/, "") || "0";

  if (normalizedLeftWhole.length !== normalizedRightWhole.length) {
    return normalizedLeftWhole.length > normalizedRightWhole.length ? 1 : -1;
  }

  if (normalizedLeftWhole !== normalizedRightWhole) {
    return normalizedLeftWhole > normalizedRightWhole ? 1 : -1;
  }

  const maxFractionLength = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeftFraction = leftFraction.padEnd(maxFractionLength, "0");
  const normalizedRightFraction = rightFraction.padEnd(maxFractionLength, "0");
  if (normalizedLeftFraction === normalizedRightFraction) {
    return 0;
  }

  return normalizedLeftFraction > normalizedRightFraction ? 1 : -1;
}

export async function validateSellInstruction(args: {
  instruction: SellInstruction;
  policy: TradePolicy;
  runOptions: TradeRunOptions;
}): Promise<{ validation: TradeValidationResult; normalizedInstruction: SellInstruction }> {
  const reasons: string[] = [];
  const walletChainId = getWalletChainId();
  const normalizedInstruction: SellInstruction = {
    ...args.instruction,
    tokenSymbol: args.instruction.tokenSymbol.trim().toUpperCase(),
    recipientAddress: args.instruction.recipientAddress.trim()
  };

  if (!args.runOptions.enabled) {
    reasons.push("Trade execution is disabled for this run.");
  }

  if (!isWalletConfigured()) {
    reasons.push("Wallet execution is not configured.");
  }

  if (normalizedInstruction.chainFamily !== "evm") {
    reasons.push("Only EVM trade execution is supported in this build.");
  }

  if (!isEvmAddress(normalizedInstruction.recipientAddress)) {
    reasons.push("Recipient address is not a valid EVM address.");
  }

  if (!isNumberishDecimal(normalizedInstruction.amount)) {
    reasons.push("Amount must be a numeric decimal string.");
  }

  if (normalizedInstruction.chainId !== walletChainId) {
    reasons.push(
      `Instruction chain ${normalizedInstruction.chainId} does not match the configured wallet chain ${walletChainId}.`
    );
  }

  if (
    args.policy.allowlistedChainIds.length > 0 &&
    !args.policy.allowlistedChainIds.includes(normalizedInstruction.chainId)
  ) {
    reasons.push(`Chain ${normalizedInstruction.chainId} is not in the allowed trade chain list.`);
  }

  if (normalizedInstruction.recipientMemo) {
    reasons.push("Recipient memo or tag flows are not supported for EVM transfers in this build.");
  }

  if (normalizedInstruction.expiresAt) {
    const expiresAtMs = Date.parse(normalizedInstruction.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      reasons.push("Instruction expiry could not be parsed.");
    } else if (expiresAtMs <= Date.now()) {
      reasons.push("Instruction quote or deposit window has already expired.");
    }
  }

  const registryResolution = resolveTokenRegistryEntry({
    policy: args.policy,
    chainId: normalizedInstruction.chainId,
    symbol: normalizedInstruction.tokenSymbol,
    contract: normalizedInstruction.tokenContract
  });
  if (registryResolution.ambiguous) {
    reasons.push(
      `Token symbol '${normalizedInstruction.tokenSymbol}' maps to multiple registry entries on chain ${normalizedInstruction.chainId}; a contract address is required.`
    );
  }

  const registryEntry = registryResolution.entry;
  if (registryEntry) {
    normalizedInstruction.assetKind = registryEntry.assetKind;
    normalizedInstruction.tokenDecimals = registryEntry.decimals;
    if (registryEntry.contract) {
      normalizedInstruction.tokenContract = registryEntry.contract;
    }
  }

  if (normalizedInstruction.assetKind === "native" && normalizedInstruction.tokenDecimals === undefined) {
    normalizedInstruction.tokenDecimals = 18;
  }

  if (normalizedInstruction.assetKind === "erc20") {
    if (!normalizedInstruction.tokenContract) {
      reasons.push(`No ERC-20 contract address is known for token '${normalizedInstruction.tokenSymbol}'.`);
    }

    if (args.policy.requireExactTokenContract && !normalizedInstruction.tokenContract) {
      reasons.push("Trade policy requires an exact token contract for ERC-20 transfers.");
    }

    if (normalizedInstruction.tokenDecimals === undefined) {
      reasons.push(`No decimals are known for token '${normalizedInstruction.tokenSymbol}'.`);
    }
  }

  if (
    args.policy.maxTokenAmount &&
    isNumberishDecimal(normalizedInstruction.amount) &&
    compareDecimalStrings(normalizedInstruction.amount, args.policy.maxTokenAmount) > 0
  ) {
    reasons.push(
      `Amount ${normalizedInstruction.amount} exceeds the configured max token amount ${args.policy.maxTokenAmount}.`
    );
  }

  if (reasons.length === 0) {
    try {
      const walletAddress = await getWalletAddress();
      if (normalizedInstruction.assetKind === "native") {
        const balance = await readNativeBalance(walletAddress);
        const amountBaseUnits = await parseTokenAmount(
          normalizedInstruction.amount,
          normalizedInstruction.tokenDecimals ?? 18
        );
        if (balance <= 0n) {
          reasons.push("The wallet does not have a native balance available for this transfer.");
        } else if (balance < amountBaseUnits) {
          reasons.push("The wallet does not have enough native balance for this transfer amount.");
        }
      } else if (normalizedInstruction.tokenContract) {
        const balance = await readErc20Balance({
          contract: normalizedInstruction.tokenContract,
          owner: walletAddress
        });
        const amountBaseUnits = await parseTokenAmount(
          normalizedInstruction.amount,
          normalizedInstruction.tokenDecimals ?? 0
        );
        if (balance <= 0n) {
          reasons.push(`The wallet does not hold a positive ${normalizedInstruction.tokenSymbol} balance.`);
        } else if (balance < amountBaseUnits) {
          reasons.push(`The wallet does not hold enough ${normalizedInstruction.tokenSymbol} for this transfer amount.`);
        }
      }
    } catch (error) {
      reasons.push(
        `Unable to verify wallet balance before execution: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    validation: {
      ok: reasons.length === 0,
      reasons
    },
    normalizedInstruction
  };
}
