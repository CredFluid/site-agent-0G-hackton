import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { assertZGProofEndpoints, resolveZGNetworkEndpoints, type ZGNetworkName } from "./network.js";
import { ZG_AUDIT_REGISTRY_ABI, ZG_AUDIT_REGISTRY_BYTECODE } from "./registryArtifact.js";

type ZgSdk = {
  Indexer: new (rpcUrl: string) => {
    upload(file: unknown, evmRpc: string, signer: Wallet): Promise<[unknown, unknown]>;
  };
  ZgFile: {
    fromFilePath(filePath: string): Promise<{
      merkleTree(): Promise<[{ rootHash(): string } | null, unknown]>;
      close(): Promise<void>;
    }>;
  };
};

export type ZGProofRecord = {
  status: "submitted" | "registered";
  runId: string;
  targetUrlHash: string;
  taskSetHash: string;
  artifactHash: string;
  storagePointer: string;
  storageRootHash: string | null;
  storageUploadTxHash: string | null;
  registryTxHash: string;
  registryContractAddress: string;
  explorerUrl: string;
  agentId: string;
  completedAt: string;
  bundleArtifact: string;
  confirmationNote?: string;
};

type ProofConfig = {
  enabled: boolean;
  network: ZGNetworkName;
  evmRpcUrl: string;
  storageIndexerRpcUrl: string;
  privateKey: string | undefined;
  registryAddress: string | undefined;
  explorerBaseUrl: string;
};

type BuildProofArgs = {
  runDir: string;
  runId: string;
  targetUrl: string;
  tasks: string[];
  overallScore: number;
  agentId: string;
  completedAt: string;
};

const BUNDLE_FILE_NAME = "0g-proof-bundle.json";
const PROOF_FILE_NAME = "0g-proof.json";
const PRIMARY_ARTIFACTS = new Set([
  "report.json",
  "inputs.json",
  "task-results.json",
  "site-checks.json",
  "accessibility.json",
  "raw-events.json"
]);
const EVIDENCE_EXTENSIONS = new Set([".png", ".webp"]);

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readProofConfig(): ProofConfig {
  const privateKey = normalizeOptionalString(process.env.ZG_PRIVATE_KEY) ?? normalizeOptionalString(process.env.WALLET_PRIVATE_KEY);
  const explicitlyEnabled = parseBooleanFlag(process.env.ZG_PROOF_ENABLED, false);
  const endpoints = resolveZGNetworkEndpoints();

  if (explicitlyEnabled) {
    assertZGProofEndpoints(endpoints);
  }

  return {
    enabled: explicitlyEnabled,
    network: endpoints.network,
    evmRpcUrl: endpoints.evmRpcUrl,
    storageIndexerRpcUrl: endpoints.storageIndexerRpcUrl!,
    privateKey,
    registryAddress: normalizeOptionalString(process.env.ZG_AUDIT_REGISTRY_ADDRESS),
    explorerBaseUrl: endpoints.explorerBaseUrl
  };
}

function sha256Hex(buffer: Buffer | string): string {
  return `0x${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function listBundleFiles(runDir: string): string[] {
  const files: string[] = [];

  function visit(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      const relativePath = path.relative(runDir, filePath).replaceAll(path.sep, "/");

      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }

      if (relativePath === BUNDLE_FILE_NAME || relativePath === PROOF_FILE_NAME) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (PRIMARY_ARTIFACTS.has(relativePath) || EVIDENCE_EXTENSIONS.has(ext)) {
        files.push(relativePath);
      }
    }
  }

  visit(runDir);
  return files.sort((left, right) => left.localeCompare(right));
}

function writeProofBundle(args: BuildProofArgs): { bundlePath: string; artifactHash: string; targetUrlHash: string; taskSetHash: string } {
  const files = listBundleFiles(args.runDir).map((relativePath) => {
    const filePath = path.join(args.runDir, relativePath);
    const content = fs.readFileSync(filePath);
    const includeContent = PRIMARY_ARTIFACTS.has(relativePath);
    return {
      path: relativePath,
      sha256: sha256Hex(content),
      size: content.byteLength,
      contentEncoding: includeContent ? "base64" : "sha256-only",
      ...(includeContent ? { contentBase64: content.toString("base64") } : {})
    };
  });
  const targetUrlHash = sha256Hex(args.targetUrl);
  const taskSetHash = sha256Hex(stableJson(args.tasks));
  const completedAt = args.completedAt;
  const bundle = {
    schemaVersion: 1,
    runId: args.runId,
    targetUrlHash,
    taskSetHash,
    overallScore: args.overallScore,
    agentId: args.agentId,
    completedAt,
    generatedAt: new Date().toISOString(),
    files
  };
  const serialized = `${stableJson(bundle)}\n`;
  const bundlePath = path.join(args.runDir, BUNDLE_FILE_NAME);
  fs.writeFileSync(bundlePath, serialized, "utf8");

  return {
    bundlePath,
    artifactHash: sha256Hex(Buffer.from(serialized, "utf8")),
    targetUrlHash,
    taskSetHash
  };
}

async function loadZgSdk(): Promise<ZgSdk> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<ZgSdk>;
  return await dynamicImport("@0gfoundation/0g-storage-ts-sdk");
}

function normalizeTxHash(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object") {
    const maybeHash =
      (value as { hash?: unknown; transactionHash?: unknown; txHash?: unknown }).hash ??
      (value as { transactionHash?: unknown }).transactionHash ??
      (value as { txHash?: unknown }).txHash;
    return typeof maybeHash === "string" && maybeHash.trim() ? maybeHash.trim() : null;
  }
  return null;
}

function normalizeStorageRootHash(value: unknown, fallback: string | null): string | null {
  if (value && typeof value === "object") {
    const maybeRootHash = (value as { rootHash?: unknown }).rootHash;
    if (typeof maybeRootHash === "string" && maybeRootHash.trim()) {
      return maybeRootHash.trim();
    }

    const maybeRootHashes = (value as { rootHashes?: unknown }).rootHashes;
    if (
      Array.isArray(maybeRootHashes) &&
      maybeRootHashes.every((item) => typeof item === "string" && item.trim()) &&
      maybeRootHashes.length > 0
    ) {
      return maybeRootHashes.join(",");
    }
  }

  return fallback;
}

async function uploadBundleTo0G(bundlePath: string, config: ProofConfig, signer: Wallet): Promise<{
  storageRootHash: string | null;
  storageUploadTxHash: string | null;
  storagePointer: string;
}> {
  const sdk = await loadZgSdk();
  const file = await sdk.ZgFile.fromFilePath(bundlePath);

  try {
    const [tree, treeError] = await file.merkleTree();
    if (treeError !== null || !tree) {
      throw new Error(`0G merkle tree failed: ${treeError instanceof Error ? treeError.message : String(treeError)}`);
    }

    const storageRootHash = tree.rootHash();
    if (!storageRootHash) {
      throw new Error("0G merkle tree completed without a root hash.");
    }

    const indexer = new sdk.Indexer(config.storageIndexerRpcUrl);
    const [tx, uploadError] = await indexer.upload(file, config.evmRpcUrl, signer);
    if (uploadError !== null) {
      throw new Error(`0G upload failed: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
    }
    const uploadedRootHash = normalizeStorageRootHash(tx, storageRootHash);

    return {
      storageRootHash: uploadedRootHash,
      storageUploadTxHash: normalizeTxHash(tx),
      storagePointer: `0g://storage/${uploadedRootHash ?? storageRootHash}`
    };
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function resolveRegistryAddress(config: ProofConfig, signer: Wallet): Promise<string> {
  if (config.registryAddress) {
    return config.registryAddress;
  }

  const factory = new ContractFactory(ZG_AUDIT_REGISTRY_ABI, ZG_AUDIT_REGISTRY_BYTECODE, signer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return await contract.getAddress();
}

function buildExplorerTxUrl(baseUrl: string, txHash: string): string {
  return `${baseUrl.replace(/\/$/, "")}/tx/${txHash}`;
}

export async function createAndRegisterZGProof(args: BuildProofArgs): Promise<ZGProofRecord | null> {
  const proofConfig = readProofConfig();
  if (!proofConfig.enabled) {
    return null;
  }
  if (!proofConfig.privateKey) {
    throw new Error("ZG_PROOF_ENABLED is true, but ZG_PRIVATE_KEY or WALLET_PRIVATE_KEY is not configured.");
  }

  const { artifactHash, bundlePath, targetUrlHash, taskSetHash } = writeProofBundle(args);
  const provider = new JsonRpcProvider(proofConfig.evmRpcUrl);
  const signer = new Wallet(proofConfig.privateKey, provider);
  const storage = await uploadBundleTo0G(bundlePath, proofConfig, signer);
  const registryAddress = await resolveRegistryAddress(proofConfig, signer);
  const registry = new Contract(registryAddress, ZG_AUDIT_REGISTRY_ABI, signer) as Contract & {
    registerProof(
      runId: string,
      targetUrlHash: string,
      taskSetHash: string,
      artifactHash: string,
      storagePointer: string,
      overallScore: number,
      agentId: string,
      completedAt: number
    ): Promise<{ wait(): Promise<unknown>; hash?: string }>;
  };
  const completedAtSeconds = Math.floor(new Date(args.completedAt).getTime() / 1000);
  const tx = await registry.registerProof(
    args.runId,
    targetUrlHash,
    taskSetHash,
    artifactHash,
    storage.storagePointer,
    Math.round(args.overallScore),
    args.agentId,
    Number.isFinite(completedAtSeconds) ? completedAtSeconds : Math.floor(Date.now() / 1000)
  );
  const registryTxHash = normalizeTxHash(tx);
  if (!registryTxHash) {
    throw new Error("0G registry transaction was submitted without a transaction hash.");
  }

  const proof: ZGProofRecord = {
    status: "submitted",
    runId: args.runId,
    targetUrlHash,
    taskSetHash,
    artifactHash,
    storagePointer: storage.storagePointer,
    storageRootHash: storage.storageRootHash,
    storageUploadTxHash: storage.storageUploadTxHash,
    registryTxHash,
    registryContractAddress: registryAddress,
    explorerUrl: buildExplorerTxUrl(proofConfig.explorerBaseUrl, registryTxHash),
    agentId: args.agentId,
    completedAt: args.completedAt,
    bundleArtifact: BUNDLE_FILE_NAME,
    confirmationNote: "Registry transaction was submitted; open the explorer URL for live confirmation status."
  };
  fs.writeFileSync(path.join(args.runDir, PROOF_FILE_NAME), JSON.stringify(proof, null, 2), "utf8");
  return proof;
}
