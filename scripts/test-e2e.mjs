#!/usr/bin/env node
/**
 * test-e2e.mjs
 *
 * End-to-end test: create pixel job → fund → submit → relay verifies → pixels.json updated
 *
 * Uses exporter wallet as client and relayer wallet as provider.
 */

import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const RPC   = "https://sepolia.base.org";

// ── Load deployment ───────────────────────────────────────────────────────────
const deployJson = JSON.parse(readFileSync(`${ROOT}/artifacts/deployment.json`, "utf8"));
const CONTRACT   = deployJson.deployments.base_sepolia.address;
console.log("AgenticCommerce:", CONTRACT);

// ── Keys ─────────────────────────────────────────────────────────────────────
function loadKey(p) {
  const k = readFileSync(p, "utf8").trim();
  return k.startsWith("0x") ? k : "0x" + k;
}
const EXPORTER_KEY = loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`);
const RELAYER_KEY  = loadKey(`/home/albert/clawd/projects/conditional-payment-cross-border-trade/base-sepolia/.wallets/relayer.key`);

const clientAcct   = privateKeyToAccount(EXPORTER_KEY);
const providerAcct = privateKeyToAccount(RELAYER_KEY);

const transport  = http(RPC);
const pub        = createPublicClient({ chain: baseSepolia, transport });
const clientW    = createWalletClient({ chain: baseSepolia, transport, account: clientAcct });
const providerW  = createWalletClient({ chain: baseSepolia, transport, account: providerAcct });

console.log("Client (exporter):", clientAcct.address);
console.log("Provider (relayer):", providerAcct.address);

// ── ABI ───────────────────────────────────────────────────────────────────────
const AC_ABI = parseAbi([
  "event JobCreated(bytes32 indexed jobId, address indexed client, address evaluator, uint256 budget, string description)",
  "event JobFunded(bytes32 indexed jobId, uint256 amount)",
  "event JobSubmitted(bytes32 indexed jobId, string resultLocation)",
  "event JobCompleted(bytes32 indexed jobId)",
  "function createPixelJob(uint256 expiredAt, uint256 pixelX, uint256 pixelY, uint256 blockWidth, uint256 blockHeight, string imageUrl, string linkUrl, address hook) returns (bytes32)",
  "function setProvider(bytes32 jobId, address provider)",
  "function setBudget(bytes32 jobId, uint256 budget)",
  "function fund(bytes32 jobId, uint256 expectedBudget) payable",
  "function submit(bytes32 jobId, string resultLocation)",
  "function jobs(bytes32) view returns (address client, address provider, address evaluator, uint256 budget, uint256 expiredAt, uint8 status, string description, string resultLocation, address hook)",
]);

async function waitTx(hash, label) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ✅ ${label}: ${hash}`);
  return r;
}

async function main() {
  const budget     = parseEther("0.0001"); // 0.0001 ETH
  const expiredAt  = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days

  // Test pixel: at position (500,300), 30x30 pixels
  const pixelX  = 500;
  const pixelY  = 300;
  const width   = 30;
  const height  = 30;
  const imageUrl = "https://acastellana.github.io/million-pixel-eap/test-pixel.png";
  const linkUrl  = "https://genlayer.com";

  console.log("\n" + "═".repeat(60));
  console.log("E2E TEST: Pixel Placement Flow");
  console.log("═".repeat(60));
  console.log(`  Pixel: (${pixelX},${pixelY}) ${width}x${height}`);
  console.log(`  Image: ${imageUrl}`);
  console.log(`  Budget: ${Number(budget)/1e18} ETH`);
  console.log();

  // ── Step 1: createPixelJob ────────────────────────────────────────────────
  console.log("Step 1: createPixelJob...");
  const createHash = await clientW.writeContract({
    address: CONTRACT,
    abi: AC_ABI,
    functionName: "createPixelJob",
    args: [expiredAt, pixelX, pixelY, width, height, imageUrl, linkUrl, "0x0000000000000000000000000000000000000000"],
  });
  const createReceipt = await waitTx(createHash, "createPixelJob");

  // Extract jobId from logs
  const jobCreatedLog = createReceipt.logs.find(l =>
    l.topics[0]?.toLowerCase() === "0x18f2a1dcb16e0d154157f83e14f5c418da21b56dc9a976c9d52fb06e37a9f5dd"
  );
  if (!jobCreatedLog) throw new Error("JobCreated event not found in receipt");
  const jobId = jobCreatedLog.topics[1];
  console.log(`  JobId: ${jobId}`);

  // ── Step 2: setProvider ───────────────────────────────────────────────────
  console.log("\nStep 2: setProvider...");
  const spHash = await clientW.writeContract({
    address: CONTRACT, abi: AC_ABI, functionName: "setProvider",
    args: [jobId, providerAcct.address],
  });
  await waitTx(spHash, "setProvider");

  // ── Step 3: setBudget ─────────────────────────────────────────────────────
  console.log("\nStep 3: setBudget...");
  const sbHash = await clientW.writeContract({
    address: CONTRACT, abi: AC_ABI, functionName: "setBudget",
    args: [jobId, budget],
  });
  await waitTx(sbHash, "setBudget");

  // ── Step 4: fund ──────────────────────────────────────────────────────────
  console.log("\nStep 4: fund...");
  const fHash = await clientW.writeContract({
    address: CONTRACT, abi: AC_ABI, functionName: "fund",
    args: [jobId, budget],
    value: budget,
  });
  await waitTx(fHash, "fund");

  // ── Step 5: submit (by provider) ──────────────────────────────────────────
  console.log("\nStep 5: submit (by provider)...");
  const submitData = JSON.stringify({ jobId, pixelX, pixelY, width, height, imageUrl, linkUrl });
  const sHash = await providerW.writeContract({
    address: CONTRACT, abi: AC_ABI, functionName: "submit",
    args: [jobId, submitData],
  });
  await waitTx(sHash, "submit");

  console.log("\n" + "═".repeat(60));
  console.log("✅ Job submitted on-chain! Ready for relay.");
  console.log("═".repeat(60));
  console.log("\nJob details:");
  console.log(`  JobId:    ${jobId}`);
  console.log(`  Contract: ${CONTRACT}`);
  console.log(`  Explorer: https://sepolia.basescan.org/address/${CONTRACT}`);
  console.log("\nNow run: node scripts/pixel-relay.mjs");
  console.log("The relay will call verify_pixel_placement on GenLayer and deliver the verdict.\n");

  return jobId;
}

main().catch(e => { console.error("Test failed:", e); process.exit(1); });
