#!/usr/bin/env node
/**
 * Close old Position account (wrong size) and recover rent.
 * This allows a fresh Position account to be created with the correct size.
 */

const anchor = require('@project-serum/anchor');
const web3 = require('@solana/web3.js');
const fs = require('fs');

const PROGRAM_ID = new web3.PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v3');
const POS_SEED = Buffer.from('pos');

async function main() {
    // Get session wallet from command line or use default
    const sessionWalletPath = process.argv[2] || './userA.json';

    if (!fs.existsSync(sessionWalletPath)) {
        console.error(`❌ Session wallet not found: ${sessionWalletPath}`);
        console.log('Usage: node close_old_position.js <session_wallet_pubkey_string> <master_wallet_path>');
        process.exit(1);
    }

    const sessionWalletJson = JSON.parse(fs.readFileSync(sessionWalletPath));
    const sessionWallet = web3.Keypair.fromSecretKey(new Uint8Array(sessionWalletJson));

    console.log(`Session wallet: ${sessionWallet.publicKey.toString()}`);

    // Connect to devnet
    const connection = new web3.Connection('https://api.devnet.solana.com', 'confirmed');

    // Find AMM PDA
    const [ammPda] = await web3.PublicKey.findProgramAddressSync(
        [AMM_SEED],
        PROGRAM_ID
    );
    console.log(`AMM PDA: ${ammPda.toString()}`);

    // Find Position PDA
    const [posPda, posBump] = await web3.PublicKey.findProgramAddressSync(
        [POS_SEED, ammPda.toBuffer(), sessionWallet.publicKey.toBuffer()],
        PROGRAM_ID
    );
    console.log(`Position PDA: ${posPda.toString()}`);

    // Check if position exists
    const posInfo = await connection.getAccountInfo(posPda);
    if (!posInfo) {
        console.log('✅ No position account exists - you can create a fresh one!');
        process.exit(0);
    }

    console.log(`Found position account: ${posInfo.data.length} bytes (should be 89 bytes with discriminator)`);

    if (posInfo.data.length === 8 + 89) {
        console.log('✅ Position account has correct size! No need to close it.');
        process.exit(0);
    }

    console.log('⚠️  Position account has wrong size - closing it...');

    // Master wallet needed to receive rent refund
    const masterWalletPath = process.argv[3] || process.env.ANCHOR_WALLET || './operator.json';
    const masterWalletJson = JSON.parse(fs.readFileSync(masterWalletPath));
    const masterWallet = web3.Keypair.fromSecretKey(new Uint8Array(masterWalletJson));

    console.log(`Master wallet (rent recipient): ${masterWallet.publicKey.toString()}`);

    // Create a simple transaction to close the account
    // We'll transfer all lamports to master wallet and set data length to 0
    const closeIx = new web3.TransactionInstruction({
        programId: web3.SystemProgram.programId,
        keys: [
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: masterWallet.publicKey, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([]), // Empty instruction
    });

    // Actually, we need to use the program's authority to close it
    // Since Position is a PDA, we need the session wallet to authorize

    console.log('\n⚠️  MANUAL STEP REQUIRED:');
    console.log('The Position account is owned by the program and has the wrong size.');
    console.log('We need to manually close it using solana CLI:\n');
    console.log(`solana program close ${posPda.toString()} --recipient ${masterWallet.publicKey.toString()}`);
    console.log('\nOR clear your browser storage and use a different session wallet.');

    process.exit(1);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
