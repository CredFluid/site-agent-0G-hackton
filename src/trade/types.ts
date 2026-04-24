import { z } from "zod";

export const TradeStrategySchema = z.enum(["auto", "dapp_only", "deposit_only"]);
export type TradeStrategy = z.infer<typeof TradeStrategySchema>;

export const TradeRunOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  strategy: TradeStrategySchema.default("auto"),
  confirmations: z.number().int().min(0).max(12).default(1)
});
export type TradeRunOptions = z.infer<typeof TradeRunOptionsSchema>;

export const TradeTokenRegistryEntrySchema = z.object({
  chainId: z.number().int().positive(),
  symbol: z.string().min(1).transform((value) => value.trim().toUpperCase()),
  assetKind: z.enum(["native", "erc20"]),
  contract: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  decimals: z.number().int().min(0).max(36)
});
export type TradeTokenRegistryEntry = z.infer<typeof TradeTokenRegistryEntrySchema>;

export const TradePolicySchema = z.object({
  enabledByDefault: z.boolean().default(false),
  allowlistedChainIds: z.array(z.number().int().positive()).default([]),
  tokenRegistry: z.array(TradeTokenRegistryEntrySchema).default([]),
  maxTokenAmount: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  requireExactTokenContract: z.boolean().default(true),
  receiptTimeoutMs: z.number().int().positive().default(120000),
  confirmationsRequired: z.number().int().min(0).max(12).default(1)
});
export type TradePolicy = z.infer<typeof TradePolicySchema>;

export const SellInstructionSchema = z.object({
  mode: z.enum(["dapp_managed", "deposit_address_transfer"]),
  chainFamily: z.literal("evm"),
  chainId: z.number().int().positive(),
  assetKind: z.enum(["native", "erc20"]),
  tokenSymbol: z.string().min(1).transform((value) => value.trim().toUpperCase()),
  tokenContract: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  tokenDecimals: z.number().int().min(0).max(36).optional(),
  amount: z.string().min(1),
  recipientAddress: z.string().min(1),
  recipientMemo: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  quoteId: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  expiresAt: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  sourceUrl: z.string().url(),
  sourceTitle: z.string(),
  evidenceText: z.array(z.string()).default([])
});
export type SellInstruction = z.infer<typeof SellInstructionSchema>;

export const TradeExecutionStatusSchema = z.enum([
  "dry_run",
  "broadcast",
  "confirmed",
  "blocked",
  "failed"
]);
export type TradeExecutionStatus = z.infer<typeof TradeExecutionStatusSchema>;

export const TradeValidationResultSchema = z.object({
  ok: z.boolean(),
  reasons: z.array(z.string()).default([])
});
export type TradeValidationResult = z.infer<typeof TradeValidationResultSchema>;

export const TradeExecutionRecordSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  time: z.string(),
  source: z.enum(["browser", "cli"]),
  strategy: TradeStrategySchema,
  selectedMode: z.enum(["dapp_managed", "deposit_address_transfer", "unsupported"]),
  dryRun: z.boolean(),
  status: TradeExecutionStatusSchema,
  instruction: SellInstructionSchema.optional(),
  validation: TradeValidationResultSchema,
  txHash: z.string().nullable().default(null),
  confirmationsRequested: z.number().int().min(0).max(12).default(1),
  confirmationsReached: z.number().int().min(0).max(12).default(0),
  receipt: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.string().nullable().default(null),
  note: z.string()
});
export type TradeExecutionRecord = z.infer<typeof TradeExecutionRecordSchema>;

export const TradeExecutionRecordsSchema = z.array(TradeExecutionRecordSchema);
