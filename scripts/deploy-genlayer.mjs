#!/usr/bin/env node
/**
 * deploy-genlayer.mjs
 *
 * Deploys PixelVerifier.py on GenLayer Studionet with bridge args.
 * Uses the existing funded account from artifacts/genlayer-deployment.json.
 *
 * Constructor args:
 *   website_url:      https://acastellana.github.io/million-pixel-eap
 *   bridge_sender:    0xC94bE65Baf99590B1523db557D157fabaD2DA729
 *   target_chain_eid: 40245  (Base Sepolia LZ EID)
 */

import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const GL_RPC = "https://studio.genlayer.com/api";

// ── Known constants ───────────────────────────────────────────────────────────
const WEBSITE_URL     = "https://acastellana.github.io/million-pixel-eap";
const BRIDGE_SENDER   = "0xC94bE65Baf99590B1523db557D157fabaD2DA729";
const TARGET_CHAIN_EID = 40245;

async function main() {
  // Load existing funded private key
  const existing = JSON.parse(readFileSync(`${ROOT}/artifacts/genlayer-deployment.json`, "utf8"));
  const privateKey = existing.privateKey;
  const account    = createAccount(privateKey);
  console.log("GenLayer account:", account.address);

  const client = createClient({ chain: studionet, account });

  // Initialize consensus (may already be initialized)
  console.log("Initializing consensus...");
  try {
    await client.initializeConsensusSmartContract();
  } catch (err) {
    console.log("Skipping initializeConsensusSmartContract:", err.message);
  }

  // Deploy
  const code = readFileSync(`${ROOT}/contracts/PixelVerifier.py`, "utf8");
  console.log("\nDeploying PixelVerifier with bridge args...");
  console.log("  website_url:     ", WEBSITE_URL);
  console.log("  bridge_sender:   ", BRIDGE_SENDER);
  console.log("  target_chain_eid:", TARGET_CHAIN_EID);

  const hash = await client.deployContract({
    code,
    args: [WEBSITE_URL, BRIDGE_SENDER, TARGET_CHAIN_EID],
  });
  console.log("Deploy tx hash:", hash);
  console.log("Explorer: https://explorer-studio.genlayer.com/transactions/" + hash);

  console.log("\nWaiting for ACCEPTED status (~60-120s)...");
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "ACCEPTED",
    retries: 120,
    interval: 5000,
  });

  const contractAddress = receipt.data?.contract_address;
  if (!contractAddress) {
    console.error("Receipt data:", JSON.stringify(receipt, null, 2));
    throw new Error("Could not get contract address from receipt");
  }

  console.log("\n✅ PixelVerifier deployed at:", contractAddress);

  // Save
  mkdirSync(`${ROOT}/artifacts`, { recursive: true });
  const deployment = {
    network:          "genlayer-studionet",
    contract:         "PixelVerifier",
    address:          contractAddress,
    account:          account.address,
    privateKey:       privateKey,
    websiteUrl:       WEBSITE_URL,
    bridgeSender:     BRIDGE_SENDER,
    targetChainEid:   TARGET_CHAIN_EID,
    deployedAt:       new Date().toISOString(),
    txHash:           hash,
  };

  writeFileSync(`${ROOT}/artifacts/genlayer-deployment.json`, JSON.stringify(deployment, null, 2));
  console.log("Saved to artifacts/genlayer-deployment.json");

  // Also update deployment.json
  try {
    const mainDeploy = JSON.parse(readFileSync(`${ROOT}/artifacts/deployment.json`, "utf8"));
    mainDeploy.deployments = mainDeploy.deployments || {};
    mainDeploy.deployments.genlayer = deployment;
    writeFileSync(`${ROOT}/artifacts/deployment.json`, JSON.stringify(mainDeploy, null, 2));
    console.log("Updated artifacts/deployment.json");
  } catch {}
}

main().catch(err => { console.error("Deployment failed:", err); process.exit(1); });
