import { getWalletConfig, getWalletProvider } from "../../wallet/wallet.js";

type EthersModule = {
  Interface: new (fragments: string[]) => {
    encodeFunctionData: (name: string, args: unknown[]) => string;
  };
  JsonRpcProvider: new (url: string) => {
    call: (tx: { to: string; data: string }) => Promise<string>;
    getBalance: (address: string) => Promise<bigint>;
    waitForTransaction: (hash: string, confirmations?: number, timeout?: number) => Promise<unknown>;
  };
  parseUnits: (value: string, unit?: number) => bigint;
};

async function loadEthers(): Promise<EthersModule> {
  const mod = (await import("ethers")) as unknown as EthersModule & { default?: EthersModule };
  return mod.default ?? mod;
}

async function resolveRpcProvider(): Promise<InstanceType<EthersModule["JsonRpcProvider"]>> {
  const walletConfig = await getWalletConfig();
  if (!walletConfig?.rpcUrl) {
    throw new Error("Wallet RPC configuration is required for EVM trade execution.");
  }

  const ethers = await loadEthers();
  return new ethers.JsonRpcProvider(walletConfig.rpcUrl);
}

export async function parseTokenAmount(value: string, decimals: number): Promise<bigint> {
  const ethers = await loadEthers();
  return ethers.parseUnits(value, decimals);
}

export async function encodeErc20Transfer(args: {
  recipientAddress: string;
  amountBaseUnits: bigint;
}): Promise<string> {
  const ethers = await loadEthers();
  const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  return iface.encodeFunctionData("transfer", [args.recipientAddress, args.amountBaseUnits]);
}

export async function readNativeBalance(address: string): Promise<bigint> {
  const provider = await resolveRpcProvider();
  return provider.getBalance(address);
}

export async function readErc20Balance(args: { contract: string; owner: string }): Promise<bigint> {
  const ethers = await loadEthers();
  const provider = await resolveRpcProvider();
  const iface = new ethers.Interface(["function balanceOf(address owner) view returns (uint256)"]);
  const data = iface.encodeFunctionData("balanceOf", [args.owner]);
  const result = await provider.call({ to: args.contract, data });
  return BigInt(result);
}

export async function waitForEvmReceipt(args: {
  txHash: string;
  confirmations: number;
  timeoutMs: number;
}): Promise<Record<string, unknown> | null> {
  const provider = (await getWalletProvider()) as {
    waitForTransaction?: (hash: string, confirmations?: number, timeout?: number) => Promise<unknown>;
    send?: (method: string, params: unknown[]) => Promise<unknown>;
  };

  if (provider?.waitForTransaction) {
    const receipt = await provider.waitForTransaction(args.txHash, args.confirmations, args.timeoutMs);
    return (receipt as Record<string, unknown> | null) ?? null;
  }

  const rpcProvider = await resolveRpcProvider();
  const receipt = await rpcProvider.waitForTransaction(args.txHash, args.confirmations, args.timeoutMs);
  return (receipt as Record<string, unknown> | null) ?? null;
}
