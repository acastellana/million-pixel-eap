#!/usr/bin/env node
/**
 * deploy-base-sepolia.mjs
 *
 * Deploys AgenticCommerce.sol to Base Sepolia using viem.
 * Constructor args:
 *   _bridgeReceiver: 0xc3e6aE892A704c875bF74Df46eD873308db15d82  (LZ bridge receiver)
 *   _oracleRelayer:  0x7b9797c4c2DA625b120A27AD2c07bECB7A0E30fa  (relay fallback)
 *
 * Saves deployed address to artifacts/deployment.json
 * Uses exporter key for deployment.
 */

import { createPublicClient, createWalletClient, http, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const RPC   = "https://sepolia.base.org";

// ── Known addresses ───────────────────────────────────────────────────────────
const BRIDGE_RECEIVER = "0xc3e6aE892A704c875bF74Df46eD873308db15d82";
const ORACLE_RELAYER  = "0x7b9797c4c2DA625b120A27AD2c07bECB7A0E30fa";

// ── Load exporter key ─────────────────────────────────────────────────────────
function loadKey(path) {
  const k = readFileSync(path, "utf8").trim();
  return k.startsWith("0x") ? k : "0x" + k;
}

const EXPORTER_KEY = loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`);
const account      = privateKeyToAccount(EXPORTER_KEY);
console.log("Deployer:", account.address);

// ── Viem clients ──────────────────────────────────────────────────────────────
const transport  = http(RPC);
const pub        = createPublicClient({ chain: baseSepolia, transport });
const wallet     = createWalletClient({ chain: baseSepolia, transport, account });

// ── Load compiled artifact ────────────────────────────────────────────────────
const artifact   = JSON.parse(readFileSync(`${ROOT}/out/AgenticCommerce.sol/AgenticCommerce.json`, "utf8"));
const bytecode   = artifact.bytecode.object;
const abi        = artifact.abi;

async function main() {
  // Check balance
  const balance = await pub.getBalance({ address: account.address });
  console.log(`Balance: ${Number(balance) / 1e18} ETH`);
  if (balance < 1_000_000_000_000n) { // < 0.000001 ETH
    throw new Error("Insufficient balance for deployment");
  }

  console.log("\nDeploying AgenticCommerce...");
  console.log("  BRIDGE_RECEIVER:", BRIDGE_RECEIVER);
  console.log("  ORACLE_RELAYER: ", ORACLE_RELAYER);

  // Encode deploy data (constructor args)
  const deployData = encodeDeployData({
    abi,
    bytecode,
    args: [BRIDGE_RECEIVER, ORACLE_RELAYER],
  });

  // Send deployment transaction
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [BRIDGE_RECEIVER, ORACLE_RELAYER],
  });

  console.log("Deploy tx hash:", hash);
  console.log("Waiting for receipt...");

  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") {
    throw new Error(`Deployment reverted: ${hash}`);
  }

  const contractAddress = receipt.contractAddress;
  console.log("\n✅ AgenticCommerce deployed at:", contractAddress);
  console.log("   Tx:", hash);
  console.log("   Explorer: https://sepolia.basescan.org/address/" + contractAddress);

  // ── Save deployment ───────────────────────────────────────────────────────
  mkdirSync(`${ROOT}/artifacts`, { recursive: true });

  // Load existing deployment.json if present
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(`${ROOT}/artifacts/deployment.json`, "utf8"));
  } catch {}

  const deployment = {
    ...existing,
    project: "Million Pixel EAP",
    deployments: {
      ...(existing.deployments || {}),
      base_sepolia: {
        network:         "base-sepolia",
        contract:        "AgenticCommerce",
        address:         contractAddress,
        deployer:        account.address,
        bridge_receiver: BRIDGE_RECEIVER,
        oracle_relayer:  ORACLE_RELAYER,
        deployedAt:      new Date().toISOString(),
        txHash:          hash,
        explorer:        `https://sepolia.basescan.org/address/${contractAddress}`,
      },
    },
  };

  writeFileSync(`${ROOT}/artifacts/deployment.json`, JSON.stringify(deployment, null, 2));
  console.log("\nSaved to artifacts/deployment.json");

  return contractAddress;
}

main().catch(err => { console.error("Deployment failed:", err.message); process.exit(1); });
