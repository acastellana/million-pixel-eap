# The Million Pixel Page — Powered by EIP-8183 & GenLayer

## Concept

This project is a modern evolution of the original Million Dollar Homepage, reimagined for the **Agentic Web**. It combines **EIP-8183 (Agentic Commerce Protocol)** for trustless job management with **GenLayer Intelligent Contracts** for automated, AI-powered verification.

### Key Components

1.  **EIP-8183 (Agentic Commerce):** A Solidity contract (`AgenticCommerce.sol`) that manages the workflow: job creation, funding, submission, completion, and payment distribution.
2.  **GenLayer Evaluator:** An intelligent contract (`PixelVerifier.py`) that acts as the trusted evaluator. It can autonomously fetch the live website's `pixels.json`, verify if a pixel was placed correctly, and trigger the Solidity contract's `complete()` or `reject()` functions via a cross-chain bridge.
3.  **Million Pixel Frontend:** A clean, dark-themed HTML/JS page that displays a 1000x1000 pixel grid of 10,000 blocks (10x10 pixels each).

---

## Architecture

```text
+-------------------+           +-----------------------+           +-----------------------+
|  CLIENT (Buyer)   |           |    PROVIDER (Dev)     |           | GENLAYER (Evaluator)  |
+---------+---------+           +----------+------------+           +-----------+-----------+
          |                                |                                    |
          | 1. Create Job (EIP-8183)       |                                    |
          +------------------------------->+                                    |
          | 2. Fund Job                    |                                    |
          +------------------------------->+                                    |
          |                                | 3. Update pixels.json              |
          |                                +----------------------------------->+
          |                                | 4. Submit Job                      |
          |                                +----------------------------------->+
          |                                |                                    | 5. Verify (Web Fetch)
          |                                |                                    +-----------------+
          |                                |                                    |                 |
          |                                |                                    | <---------------+
          |                                |                                    | 6. Complete (Bridge)
          |                                | 7. Receive Payment <---------------+
          |                                +------------------------------------+
```

---

## How it works (Step-by-Step)

1.  **Job Creation:** A Client calls `createPixelJob()` on the `AgenticCommerce` contract on **Base Sepolia**, specifying the pixel coordinates, image, and link.
2.  **Funding:** The Client funds the job by calling `fund()` with the required ETH budget.
3.  **Implementation:** The Provider (the website owner or developer) updates the `pixels.json` on the live website to include the new pixel block.
4.  **Submission:** The Provider calls `submit()` on the Solidity contract, providing the URL of the updated website.
5.  **Verification:** The **GenLayer Intelligent Contract** (`PixelVerifier.py`) is triggered as the evaluator. It:
    *   Fetches the `pixels.json` using `gl.nondet.web.get()`.
    *   Verifies that the pixel data matches the job description.
    *   Uses `gl.eq_principle.strict_eq` to reach consensus on the verification result.
6.  **Settlement:** Once verified, GenLayer calls `complete()` on the Base Sepolia contract (via bridge), which releases the escrowed funds to the Provider.

---

## Deployment

### 1. Frontend
Deploy the `index.html` and `pixels.json` to any static hosting provider (e.g., Vercel, Netlify, or GitHub Pages).

### 2. Solidity Contract (Base Sepolia)
```bash
# Set your environment variables
export RPC="https://sepolia.base.org"
export KEY="your_private_key"

# Using Foundry (example)
cd contracts
forge create AgenticCommerce --rpc-url $RPC --private-key $KEY
```

### 3. GenLayer Intelligent Contract (Studionet)
Use the `genlayer-js` SDK or the GenLayer Studio at `https://studio.genlayer.com` to deploy `contracts/PixelVerifier.py`. Pass your live website URL as the constructor argument.

---

## References
*   [EIP-8183: Agentic Commerce Protocol](https://github.com/ethereum/EIPs/pull/8183)
*   [GenLayer Documentation](https://docs.genlayer.com)
