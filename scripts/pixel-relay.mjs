#!/usr/bin/env node
/**
 * pixel-relay.mjs
 *
 * Relay service for the Million Pixel Page.
 *
 * Flow:
 *   1. Watch AgenticCommerce on Base Sepolia for JobSubmitted events
 *   2. Parse pixel coords + image URL + link URL from job description
 *   3. Call verify_pixel_placement on PixelVerifier (GenLayer)
 *   4. Wait for GenLayer finalization
 *   5. Read verdict; call resolveViaRelayer() on AgenticCommerce (direct path)
 *      (bridge delivery from GenLayer is aspirational; relayer path is primary)
 *   6. On JobCompleted event: update pixels.json, git commit + push
 *   7. Track processed jobs in artifacts/relay-state.json
 *
 * Usage:
 *   node scripts/pixel-relay.mjs           # one-shot (process all pending)
 *   node scripts/pixel-relay.mjs --watch   # continuous poll every 30s
 */

import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const RPC   = "https://sepolia.base.org";
const GL_RPC = "https://studio.genlayer.com/api";

// ── Load deployments ──────────────────────────────────────────────────────────
const deployJson    = JSON.parse(readFileSync(`${ROOT}/artifacts/deployment.json`, "utf8"));
const glDeploy      = JSON.parse(readFileSync(`${ROOT}/artifacts/genlayer-deployment.json`, "utf8"));

const AGENTIC_COMMERCE = deployJson.deployments.base_sepolia.address;
const PIXEL_VERIFIER   = glDeploy.address;
const GL_PRIVATE_KEY   = glDeploy.privateKey;
const WEBSITE_URL      = glDeploy.websiteUrl;

console.log("AgenticCommerce:", AGENTIC_COMMERCE);
console.log("PixelVerifier:  ", PIXEL_VERIFIER);

// ── Load keys ─────────────────────────────────────────────────────────────────
function loadKey(path) {
  const k = readFileSync(path, "utf8").trim();
  return k.startsWith("0x") ? k : "0x" + k;
}
const RELAYER_KEY = loadKey(
  `/home/albert/clawd/projects/conditional-payment-cross-border-trade/base-sepolia/.wallets/relayer.key`
);

// ── Viem clients ──────────────────────────────────────────────────────────────
const transport    = http(RPC);
const pub          = createPublicClient({ chain: baseSepolia, transport });
const relayerAcct  = privateKeyToAccount(RELAYER_KEY);
const relayerW     = createWalletClient({ chain: baseSepolia, transport, account: relayerAcct });

console.log("Relayer:        ", relayerAcct.address);

// ── GenLayer client ───────────────────────────────────────────────────────────
const glAccount = createAccount(GL_PRIVATE_KEY);
const glClient  = createClient({ chain: studionet, account: glAccount });

// ── ABIs ──────────────────────────────────────────────────────────────────────
const AC_ABI = parseAbi([
  "event JobSubmitted(bytes32 indexed jobId, string resultLocation)",
  "event JobCompleted(bytes32 indexed jobId)",
  "event JobRejected(bytes32 indexed jobId, string reason)",
  "function getJobDescription(bytes32 jobId) view returns (string)",
  "function getJobProvider(bytes32 jobId) view returns (address)",
  "function getJobClient(bytes32 jobId) view returns (address)",
  "function getJobStatus(bytes32 jobId) view returns (uint8)",
  "function jobs(bytes32) view returns (address client, address provider, address evaluator, uint256 budget, uint256 expiredAt, uint8 status, string description, string resultLocation, address hook)",
  "function resolveViaRelayer(bytes32 jobId, bool approved, string reason)",
]);

// Job statuses (matches JobStatus enum)
const STATUS = { Open:0, Funded:1, Submitted:2, Completed:3, Rejected:4, Expired:5 };

// ── State ─────────────────────────────────────────────────────────────────────
const STATE_FILE  = `${ROOT}/artifacts/relay-state.json`;
const PIXELS_FILE = `${ROOT}/pixels.json`;

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return { processed: {}, lastBlock: 0 };
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Parse pixel description ────────────────────────────────────────────────────
// Format: "PIXEL_PLACEMENT:x,y,WxH|imageUrl|linkUrl"
function parsePixelDescription(desc) {
  const prefix = "PIXEL_PLACEMENT:";
  if (!desc.startsWith(prefix)) return null;
  const rest  = desc.slice(prefix.length);
  const parts = rest.split("|");
  if (parts.length < 3) return null;
  const coords = parts[0].split(",");
  if (coords.length < 3) return null;
  const x = parseInt(coords[0]);
  const y = parseInt(coords[1]);
  const dims = coords[2].split("x");
  const w = parseInt(dims[0]);
  const h = parseInt(dims[1]);
  const imageUrl = parts[1];
  const linkUrl  = parts[2];
  if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return null;
  return { x, y, width: w, height: h, imageUrl, linkUrl };
}

// ── GenLayer raw RPC ──────────────────────────────────────────────────────────
async function glRpc(method, params) {
  const r = await fetch(GL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`GL RPC error: ${JSON.stringify(d.error)}`);
  return d?.result ?? null;
}

// ── Call verify_pixel_placement on GenLayer ────────────────────────────────────
async function callVerifyOnGenLayer(jobId, pixel, agenticCommerceAddress) {
  console.log(`[GL] Calling verify_pixel_placement for job ${jobId.slice(0,10)}...`);
  console.log(`[GL]   pixel: (${pixel.x},${pixel.y}) ${pixel.width}x${pixel.height}`);
  console.log(`[GL]   imageUrl: ${pixel.imageUrl}`);

  const txHash = await glClient.writeContract({
    address: PIXEL_VERIFIER,
    functionName: "verify_pixel_placement",
    args: [
      jobId,
      pixel.x,
      pixel.y,
      pixel.width,
      pixel.height,
      pixel.imageUrl,
      agenticCommerceAddress,
    ],
  });

  console.log(`[GL] Call tx: ${txHash}`);
  console.log(`[GL] Explorer: https://explorer-studio.genlayer.com/transactions/${txHash}`);
  return txHash;
}

// ── Wait for GL finalization ──────────────────────────────────────────────────
async function waitForFinalization(txHash, timeoutMs = 5 * 60 * 1000) {
  const start  = Date.now();
  const pollMs = 5000;
  const maxIter = Math.ceil(timeoutMs / pollMs);

  console.log(`[GL] Waiting for finalization (up to ${timeoutMs / 1000}s)...`);

  for (let i = 0; i < maxIter; i++) {
    await sleep(pollMs);
    try {
      const tx     = await glClient.getTransaction({ hash: txHash });
      const status = tx?.statusName ?? "UNKNOWN";
      const result = tx?.resultName ?? "";

      if (i % 6 === 0) {
        console.log(`[GL]   ${Math.round((Date.now()-start)/1000)}s — status: ${status} ${result}`);
      }

      if (status === "FINALIZED") {
        console.log(`[GL] ✅ Finalized! result: ${result}`);
        return { status, result };
      }

      if (["CANCELED"].includes(status) ||
          ["FAILURE","DISAGREE","DETERMINISTIC_VIOLATION"].includes(result)) {
        console.error(`[GL] ❌ Terminal: ${status}/${result}`);
        return { status, result };
      }
    } catch { /* not indexed yet */ }
  }

  console.error(`[GL] ⏰ Timed out after ${timeoutMs/1000}s`);
  return { status: "TIMEOUT", result: "" };
}

// ── Read verdict from GL contract state ───────────────────────────────────────
async function readVerdict(txHash) {
  // After FINALIZED, fetch the full transaction via glClient (not raw RPC).
  // GL indexing may lag by a few seconds — retry up to 5x with 3s delay.
  let rawTx = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(3000);
    try {
      rawTx = await glClient.getTransaction({ hash: txHash });
      if (rawTx) {
        if (attempt === 0) {
          // Log FULL raw tx on first attempt so we can inspect the actual structure
          console.log(`[GL] RAW tx object (attempt 0):`, JSON.stringify(rawTx, null, 2).slice(0, 2000));
        }
        break;
      }
    } catch (err) {
      console.warn(`[GL] readVerdict attempt ${attempt + 1} failed: ${err.message}`);
    }
  }

  if (!rawTx) {
    console.error(`[GL] readVerdict: could not fetch tx after 5 attempts`);
    return { approved: false, reason: "Could not parse GL result" };
  }

  // Try all known result paths in order
  const candidates = [
    rawTx.data,
    rawTx.result,
    rawTx.execution_result,
    rawTx.data?.result,
    rawTx.consensusData?.finalVotes?.[0]?.executionResult,
    rawTx.consensus_data?.final_votes?.[0]?.execution_result,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = typeof candidate === "string"
        ? JSON.parse(candidate)
        : candidate;
      if (parsed && typeof parsed === "object" && "verified" in parsed) {
        console.log(`[GL] Verdict parsed successfully: verified=${parsed.verified}`);
        return {
          approved: !!parsed.verified,
          reason:   parsed.reason || "",
        };
      }
      // Maybe it's double-encoded (string containing JSON)
      if (typeof parsed === "string") {
        const inner = JSON.parse(parsed);
        if (inner && "verified" in inner) {
          return { approved: !!inner.verified, reason: inner.reason || "" };
        }
      }
    } catch {}
  }

  console.error(`[GL] readVerdict: exhausted all result paths, defaulting to rejected`);
  console.error(`[GL] rawTx keys: ${Object.keys(rawTx).join(", ")}`);
  return { approved: false, reason: "Could not parse GL result" };
}

// ── Deliver verdict to Base Sepolia ──────────────────────────────────────────
async function deliverVerdict(jobId, approved, reason) {
  console.log(`[Base] Delivering verdict: approved=${approved} for job ${jobId.slice(0,10)}...`);
  console.log(`[Base]   reason: ${reason.slice(0, 100)}`);

  const hash = await relayerW.writeContract({
    address: AGENTIC_COMMERCE,
    abi: AC_ABI,
    functionName: "resolveViaRelayer",
    args: [jobId, approved, reason.slice(0, 500)],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") {
    throw new Error(`resolveViaRelayer reverted: ${hash}`);
  }

  console.log(`[Base] ✅ Verdict delivered! tx: ${hash}`);
  return hash;
}

// ── Update pixels.json + git push ─────────────────────────────────────────────
async function updatePixelsJson(jobId, pixel, jobInfo) {
  console.log(`[Git] Updating pixels.json for job ${jobId.slice(0,10)}...`);

  let pixels = [];
  try {
    pixels = JSON.parse(readFileSync(PIXELS_FILE, "utf8"));
  } catch {
    pixels = [];
  }

  // Check if already added
  if (pixels.some(p => p.jobId === jobId)) {
    console.log("[Git] Pixel already in pixels.json — skipping");
    return;
  }

  const newEntry = {
    x:        pixel.x,
    y:        pixel.y,
    width:    pixel.width,
    height:   pixel.height,
    imageUrl: pixel.imageUrl,
    linkUrl:  pixel.linkUrl,
    owner:    jobInfo.client,
    jobId:    jobId,
  };

  pixels.push(newEntry);
  writeFileSync(PIXELS_FILE, JSON.stringify(pixels, null, 2));
  console.log(`[Git] Added pixel entry: (${pixel.x},${pixel.y}) ${pixel.width}x${pixel.height}`);

  // Git commit + push
  try {
    const branch = execSync("git branch --show-current", { cwd: ROOT, encoding: "utf8" }).trim();
    execSync(`git add pixels.json`, { cwd: ROOT, encoding: "utf8" });
    execSync(
      `git commit -m "Add pixel at (${pixel.x},${pixel.y}) via job ${jobId.slice(0,10)}"`,
      { cwd: ROOT, encoding: "utf8" }
    );
    execSync(`git push origin ${branch}`, { cwd: ROOT, encoding: "utf8" });
    console.log(`[Git] ✅ Pushed to GitHub Pages (branch: ${branch})`);
  } catch (err) {
    console.error("[Git] ⚠️ Git push failed:", err.message);
    console.error("[Git]    pixels.json updated locally but not pushed");
  }
}

// ── Process one job ───────────────────────────────────────────────────────────
async function processJob(jobId, state) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Processing job: ${jobId}`);

  // Read job details
  const jobData = await pub.readContract({
    address: AGENTIC_COMMERCE,
    abi: AC_ABI,
    functionName: "jobs",
    args: [jobId],
  });

  const [client, provider, evaluator, budget, expiredAt, status, description, resultLocation, hook] = jobData;
  console.log(`  Status: ${status}  Client: ${client}  Provider: ${provider}`);
  console.log(`  Description: ${description}`);

  // Parse pixel info
  const pixel = parsePixelDescription(description);
  if (!pixel) {
    console.error(`  ⚠️ Could not parse pixel description — skipping`);
    state.processed[jobId] = { error: "bad description", skippedAt: new Date().toISOString() };
    saveState(state);
    return;
  }

  // 1. Call verify_pixel_placement on GenLayer
  let glTxHash;
  try {
    glTxHash = await callVerifyOnGenLayer(jobId, pixel, AGENTIC_COMMERCE);
  } catch (err) {
    console.error(`[GL] Deploy/call failed: ${err.message}`);
    state.processed[jobId] = { error: `GL call failed: ${err.message}`, failedAt: new Date().toISOString() };
    saveState(state);
    return;
  }

  // 2. Wait for finalization
  const { status: glStatus } = await waitForFinalization(glTxHash, 6 * 60 * 1000);

  // 3. Read verdict (regardless of finalization status, try to read)
  let approved = false, reason = "Evaluation did not finalize";
  if (glStatus === "FINALIZED") {
    const verdict = await readVerdict(glTxHash);
    approved = verdict.approved;
    reason   = verdict.reason;
    console.log(`[GL] Verdict: approved=${approved} — ${reason.slice(0, 100)}`);
  } else {
    console.warn(`[GL] Finalization failed (${glStatus}), defaulting to rejected`);
  }

  // 4. Deliver verdict to Base Sepolia via relayer (direct path)
  let deliveryTx;
  try {
    deliveryTx = await deliverVerdict(jobId, approved, reason);
  } catch (err) {
    console.error(`[Base] Delivery failed: ${err.message}`);
    state.processed[jobId] = {
      error: `Delivery failed: ${err.message}`,
      glTxHash,
      glStatus,
      approved,
      reason,
      failedAt: new Date().toISOString(),
    };
    saveState(state);
    return;
  }

  // 5. If approved, update pixels.json + push
  if (approved) {
    try {
      await updatePixelsJson(jobId, pixel, { client, provider });
    } catch (err) {
      console.error(`[Git] pixels.json update error: ${err.message}`);
    }
  }

  // 6. Save state
  const result = {
    jobId,
    pixel,
    client,
    provider,
    glTxHash,
    glStatus,
    approved,
    reason: reason.slice(0, 500),
    deliveryTx,
    processedAt: new Date().toISOString(),
  };
  state.processed[jobId] = result;
  saveState(state);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`✅ Job ${jobId.slice(0,10)} complete: approved=${approved}`);
  console.log(`   GL tx:   ${glTxHash}`);
  console.log(`   Base tx: ${deliveryTx}`);
  console.log(`${"─".repeat(60)}\n`);

  return result;
}

// ── Fetch submitted jobs from logs ────────────────────────────────────────────
async function fetchSubmittedJobs(fromBlock) {
  try {
    const logs = await pub.getLogs({
      address: AGENTIC_COMMERCE,
      event: AC_ABI[0], // JobSubmitted
      fromBlock: BigInt(fromBlock),
      toBlock: "latest",
    });
    return logs.map(l => ({
      jobId:          l.args.jobId,
      resultLocation: l.args.resultLocation,
      blockNumber:    Number(l.blockNumber),
    }));
  } catch (err) {
    console.error("[Base] getLogs failed:", err.message);
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const watchMode = process.argv.includes("--watch");
  console.log("🚀 Pixel Relay starting...");
  console.log(`   Mode: ${watchMode ? "WATCH (continuous)" : "ONE-SHOT"}`);
  console.log(`   AgenticCommerce: ${AGENTIC_COMMERCE}`);
  console.log(`   PixelVerifier:   ${PIXEL_VERIFIER}`);
  console.log(`   Relayer:         ${relayerAcct.address}`);

  const runOnce = async () => {
    const state      = loadState();
    const currentBlock = Number(await pub.getBlockNumber());
    const fromBlock  = state.lastBlock || Math.max(0, currentBlock - 10000);

    console.log(`\n[Base] Scanning blocks ${fromBlock} → ${currentBlock}...`);

    const submissions = await fetchSubmittedJobs(fromBlock);
    console.log(`[Base] Found ${submissions.length} JobSubmitted event(s)`);

    for (const sub of submissions) {
      const jobId = sub.jobId;
      if (state.processed[jobId]) {
        if (!state.processed[jobId].error) {
          console.log(`[Relay] ${jobId.slice(0,10)} already processed — skipping`);
          continue;
        }
        console.log(`[Relay] ${jobId.slice(0,10)} previously failed — retrying`);
      }

      // Check current on-chain status (only process Submitted=2 jobs)
      const onChainStatus = await pub.readContract({
        address: AGENTIC_COMMERCE,
        abi: AC_ABI,
        functionName: "getJobStatus",
        args: [jobId],
      });

      if (onChainStatus !== 2) { // Not Submitted
        console.log(`[Relay] ${jobId.slice(0,10)} status=${onChainStatus} (not Submitted) — skipping`);
        continue;
      }

      await processJob(jobId, state);
      await sleep(3000);
    }

    state.lastBlock = currentBlock;
    saveState(state);

    console.log("\n" + "═".repeat(60));
    const results = Object.values(state.processed).filter(r => r.processedAt);
    console.log(`RELAY COMPLETE — ${results.length} job(s) processed`);
    results.forEach(r => {
      console.log(`  ${r.jobId?.slice(0,10)}: approved=${r.approved} | GL=${r.glTxHash?.slice(0,12)} | Base=${r.deliveryTx?.slice(0,12)}`);
    });
    console.log("═".repeat(60));
  };

  if (watchMode) {
    while (true) {
      await runOnce().catch(err => console.error("Run error:", err.message));
      console.log("\n[Watch] Sleeping 30s...");
      await sleep(30_000);
    }
  } else {
    await runOnce();
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
