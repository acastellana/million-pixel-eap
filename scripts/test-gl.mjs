import { createClient, createAccount } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { readFileSync } from 'fs';

const glDeploy = JSON.parse(readFileSync('artifacts/genlayer-deployment.json', 'utf8'));
const GL_PRIVATE_KEY = glDeploy.privateKey;
const glAccount = createAccount(GL_PRIVATE_KEY);
const glClient = createClient({ chain: studionet, account: glAccount });

// Try common genlayer methods to find which returns execution result
const txHash = '0xad57446c3e3eaa1e72d0f1e567a4ef0b1619090d1ece7765c5e6abcdd111c414';

console.log('Testing getTransaction...');
try {
    const tx = await glClient.getTransaction({ hash: txHash });
    console.log('Transaction status:', tx?.statusName);
    console.log('Transaction result:', tx?.resultName);
}

console.log('\nTesting gen_getTransactionReceipt...');
try {
    // Use direct RPC for receipt
    const resp = await fetch('https://studio.genlayer.com/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gen_getTransactionReceipt', params: [txHash] })
    });
    const d = await resp.json();
    console.log('RPC response:', JSON.stringify(d, null, 2));
} catch (e) {
    console.log('Error:', e.message);
}
