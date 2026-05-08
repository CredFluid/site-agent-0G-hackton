import dotenv from "dotenv";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { assertZGMainnetEndpoints, resolveZGNetworkEndpoints } from "../zerog/network.js";
import { ZG_AUDIT_REGISTRY_ABI, ZG_AUDIT_REGISTRY_BYTECODE } from "../zerog/registryArtifact.js";

dotenv.config();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function main(): Promise<void> {
  const endpoints = resolveZGNetworkEndpoints();
  assertZGMainnetEndpoints(endpoints);

  const rpcUrl = endpoints.evmRpcUrl;
  const privateKey = process.env.ZG_PRIVATE_KEY?.trim() || requiredEnv("WALLET_PRIVATE_KEY");
  const explorerBaseUrl = endpoints.explorerBaseUrl.replace(/\/$/, "");

  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  const balance = await provider.getBalance(signer.address);

  console.log(`Deploying ZGAuditRegistry from ${signer.address}`);
  console.log(`0G network: ${endpoints.network}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Signer balance: ${formatEther(balance)} OG`);

  const factory = new ContractFactory(ZG_AUDIT_REGISTRY_ABI, ZG_AUDIT_REGISTRY_BYTECODE, signer);
  const contract = await factory.deploy();
  const deploymentTx = contract.deploymentTransaction();

  if (deploymentTx) {
    console.log(`Deployment tx: ${deploymentTx.hash}`);
    console.log(`Explorer: ${explorerBaseUrl}/tx/${deploymentTx.hash}`);
  }

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`ZGAuditRegistry deployed: ${address}`);
  console.log(`Add this to .env: ZG_AUDIT_REGISTRY_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
