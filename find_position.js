#!/usr/bin/env node
/**
 * Find the Position PDA for a given session wallet
 */

const web3 = require('@solana/web3.js');

const PROGRAM_ID = new web3.PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v3');
const POS_SEED = Buffer.from('pos');

async function main() {
    const sessionWalletStr = process.argv[2];

    if (!sessionWalletStr) {
        console.error('Usage: node find_position.js <session_wallet_pubkey>');
        console.log('Example: node find_position.js 3utn1NM4oUJoH8Vd9PwfuMfxeffQU381uqieBUmfh7gm');
        process.exit(1);
    }

    const sessionWallet = new web3.PublicKey(sessionWalletStr);
    console.log(`Session wallet: ${sessionWallet.toString()}`);

    // Find AMM PDA
    const [ammPda] = await web3.PublicKey.findProgramAddressSync(
        [AMM_SEED],
        PROGRAM_ID
    );
    console.log(`AMM PDA: ${ammPda.toString()}`);

    // Find Position PDA
    const [posPda, posBump] = await web3.PublicKey.findProgramAddressSync(
        [POS_SEED, ammPda.toBuffer(), sessionWallet.toBuffer()],
        PROGRAM_ID
    );
    console.log(`Position PDA: ${posPda.toString()}`);
    console.log(`Position bump: ${posBump}`);

    // Find user vault PDA
    const USER_VAULT_SEED = Buffer.from('user_vault');
    const [userVaultPda, vaultBump] = await web3.PublicKey.findProgramAddressSync(
        [USER_VAULT_SEED, posPda.toBuffer()],
        PROGRAM_ID
    );
    console.log(`User Vault PDA: ${userVaultPda.toString()}`);
    console.log(`Vault bump: ${vaultBump}`);

    // Check if position exists
    const connection = new web3.Connection('https://api.devnet.solana.com', 'confirmed');
    const posInfo = await connection.getAccountInfo(posPda);

    if (!posInfo) {
        console.log('\n✅ No position account exists');
        return;
    }

    console.log(`\n📊 Position account:`);
    console.log(`   Size: ${posInfo.data.length} bytes (expected: ${8 + 89} = 97 bytes)`);
    console.log(`   Rent: ${posInfo.lamports / 1e9} SOL`);
    console.log(`   Owner: ${posInfo.owner.toString()}`);

    if (posInfo.data.length !== 97) {
        console.log('\n⚠️  WRONG SIZE! Need to close this account.');
    } else {
        console.log('\n✅ Correct size');
    }
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
