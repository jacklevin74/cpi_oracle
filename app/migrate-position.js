#!/usr/bin/env node
// app/migrate-position.js - Close old position account and reinitialize with new layout

const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey, Keypair, SystemProgram, Transaction } = require('@solana/web3.js');
const fs = require('fs');

const RPC = process.env.ANCHOR_PROVIDER_URL || 'https://rpc.testnet.x1.xyz';
const PID = new PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
const AMM_SEED = Buffer.from('amm_btc_v6');
const POS_SEED = Buffer.from('pos');

function getAmmPda() {
  const [pda] = PublicKey.findProgramAddressSync([AMM_SEED], PID);
  return pda;
}

function getPositionPda(amm, user) {
  const [pda] = PublicKey.findProgramAddressSync(
    [POS_SEED, amm.toBuffer(), user.toBuffer()],
    PID
  );
  return pda;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: node app/migrate-position.js <wallet.json>');
    console.log('');
    console.log('This tool will:');
    console.log('  1. Close the old position account (97 bytes)');
    console.log('  2. Reinitialize a new position account (901 bytes)');
    console.log('');
    console.log('WARNING: This will lose any existing shares in the position!');
    console.log('         Only use if position has 0 shares or for migration.');
    process.exit(1);
  }

  const walletPath = args[0];
  const wallet = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')))
  );

  const connection = new Connection(RPC, 'confirmed');
  const ammPda = getAmmPda();
  const positionPda = getPositionPda(ammPda, wallet.publicKey);

  console.log('🔧 Position Migration Tool');
  console.log('━'.repeat(60));
  console.log(`RPC:      ${RPC}`);
  console.log(`User:     ${wallet.publicKey.toString()}`);
  console.log(`AMM:      ${ammPda.toString()}`);
  console.log(`Position: ${positionPda.toString()}`);
  console.log('━'.repeat(60));

  // Check if position exists
  const positionInfo = await connection.getAccountInfo(positionPda);
  if (!positionInfo) {
    console.log('❌ Position account does not exist. Nothing to migrate.');
    console.log('   Use: ANCHOR_WALLET=' + walletPath + ' node app/trade.js init-pos');
    process.exit(0);
  }

  console.log(`\n📊 Current Position Account:`);
  console.log(`   Size: ${positionInfo.data.length} bytes`);
  console.log(`   Owner: ${positionInfo.owner.toString()}`);
  console.log(`   Lamports: ${positionInfo.lamports}`);

  if (positionInfo.data.length === 901) {
    console.log('\n✅ Position account is already using the new layout (901 bytes).');
    console.log('   No migration needed!');
    process.exit(0);
  }

  if (positionInfo.data.length !== 97) {
    console.log(`\n⚠️  Warning: Unexpected position size (${positionInfo.data.length} bytes)`);
    console.log('   Expected 97 bytes (old layout) or 901 bytes (new layout)');
    console.log('   Proceeding anyway...');
  }

  console.log('\n⚠️  WARNING: This will close and recreate your position account.');
  console.log('   Any existing shares will be LOST!');
  console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...');

  await new Promise(resolve => setTimeout(resolve, 5000));

  // Step 1: Close the old account by transferring lamports back to user
  console.log('\n📤 Step 1: Closing old position account...');
  try {
    // Create a transaction to close the account
    // We'll transfer all lamports from the position PDA back to the user
    // and zero out the account data

    // Since we can't call the smart contract (account won't deserialize),
    // we need to use a raw Solana account close if possible
    // But actually, PDAs can only be closed by the program that owns them

    console.log('⚠️  Note: Position accounts are PDAs owned by the program.');
    console.log('   They can only be closed by calling the program\'s close_position instruction.');
    console.log('   However, the old account layout cannot be deserialized by the current program.');
    console.log('');
    console.log('❌ MIGRATION NOT POSSIBLE WITHOUT PROGRAM UPDATE');
    console.log('');
    console.log('Options:');
    console.log('  1. Update the program to handle both old and new Position layouts');
    console.log('  2. Deploy a migration instruction that can read old layout and close it');
    console.log('  3. Use program upgrade authority to close accounts manually');
    console.log('');
    console.log('For now, the simplest solution is:');
    console.log('  - Users with old positions cannot trade until their position is migrated');
    console.log('  - Admin needs to add a migration instruction or use upgrade authority');

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
