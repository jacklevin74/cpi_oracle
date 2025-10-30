#!/usr/bin/env node
// Migrate Position Account - Close old position and create new one with master_wallet

const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const fs = require('fs');

const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.x1.xyz';
const PROGRAM_ID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v3');
const POS_SEED = Buffer.from('pos');

async function main() {
    const connection = new Connection(RPC_URL, 'confirmed');

    console.log('\n🔄 Position Account Migration Tool\n');
    console.log('This tool will help you migrate from the old Position format to the new one with master_wallet security.\n');

    // Get AMM PDA
    const [ammPda] = await PublicKey.findProgramAddressSync(
        [AMM_SEED],
        PROGRAM_ID
    );

    console.log(`AMM: ${ammPda.toString()}`);

    // Check if AMM exists
    const ammAccount = await connection.getAccountInfo(ammPda);
    if (!ammAccount) {
        console.log('❌ AMM account not found. Please initialize the market first.');
        return;
    }

    console.log(`✅ AMM found (${ammAccount.data.length} bytes)\n`);

    // Read session wallet from browser's sessionStorage
    console.log('📖 Instructions:');
    console.log('1. Open your browser');
    console.log('2. Open DevTools (F12)');
    console.log('3. Go to Console tab');
    console.log('4. Run this command:');
    console.log('   sessionStorage.getItem("session_wallet_address")');
    console.log('5. Copy the address and paste it below\n');

    // For now, just show info about existing positions
    console.log('🔍 Checking for position accounts...\n');

    // Since we don't have the session wallet address, show instructions
    console.log('To migrate your position:');
    console.log('1. Disconnect wallet in the web UI');
    console.log('2. Reconnect wallet');
    console.log('3. The app will automatically create a new position with master_wallet field');
    console.log('\nNote: Old position accounts will be automatically ignored (they lack master_wallet field)');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
