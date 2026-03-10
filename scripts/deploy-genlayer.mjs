import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import fs from "fs";

const GL_RPC = "https://studio.genlayer.com/api";

async function main() {
    const privateKey = generatePrivateKey();
    const account = createAccount(privateKey);
    console.log("GenLayer account:", account.address);
    
    const client = createClient({ chain: studionet, account });
    
    // Fund from faucet
    console.log("Funding from faucet...");
    await fetch(GL_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            method: "sim_fundAccount",
            params: [account.address, 10_000_000],
            id: 1,
        }),
    });
    
    // Initialize consensus
    console.log("Initializing consensus...");
    try {
        await client.initializeConsensusSmartContract();
    } catch (err) {
        console.log("Skipping initializeConsensusSmartContract (it may not be required for this SDK version or already initialized).", err.message);
    }
    
    // Deploy
    const code = fs.readFileSync("contracts/PixelVerifier.py", "utf8");
    console.log("Deploying PixelVerifier...");
    
    const websiteUrl = "https://acastellana.github.io/million-pixel-eap";
    const hash = await client.deployContract({ code, args: [websiteUrl] });
    console.log("Deploy tx hash:", hash);
    
    const receipt = await client.waitForTransactionReceipt({
        hash, status: "ACCEPTED", retries: 120, interval: 5000,
    });
    
    const contractAddress = receipt.data?.contract_address;
    console.log("PixelVerifier deployed at:", contractAddress);
    
    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync("artifacts/genlayer-deployment.json", JSON.stringify({
        network: "genlayer-studionet",
        contract: "PixelVerifier",
        address: contractAddress,
        account: account.address,
        privateKey: privateKey,
        websiteUrl,
        deployedAt: new Date().toISOString(),
        txHash: hash,
    }, null, 2));
    console.log("Saved to artifacts/genlayer-deployment.json");
}

main().catch(err => { console.error("Failed:", err); process.exit(1); });
