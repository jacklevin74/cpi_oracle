#!/usr/bin/env node
// app/read-web3.js — call oracle_reader::log_oracle with correct accounts
import {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction
} from "@solana/web3.js";
import fs from "fs";

// ---------- CONFIG ----------
const RPC    = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WALLET = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

// Reader program id (your deployed reader)
const READER_PID = new PublicKey("FyhgimJq9KN9BZukjzfJKuNKZSGLnzsTpQq6yevDpp8r");
// Oracle program id (owner of the state PDA)
const ORACLE_PID = new PublicKey("7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE");

// Discriminator for `log_oracle` (from your IDL)
const LOG_ORACLE_DISC = Uint8Array.from([20, 181, 251, 120, 168, 221, 21, 153]);

function readKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

(async () => {
  const payer = readKeypair(WALLET);
  const connection = new Connection(RPC, "processed");

  // Derive oracle_state PDA with oracle PID + "state_v2"
  const [oracleStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("state_v2")],
    ORACLE_PID
  );

  // Sanity: ensure the PDA exists and is owned by the oracle program
  const info = await connection.getAccountInfo(oracleStatePda, "processed");
  if (!info) {
    throw new Error(`oracle_state PDA not found: ${oracleStatePda.toBase58()}`);
  }
  if (info.owner.toBase58() !== ORACLE_PID.toBase58()) {
    throw new Error(
      `oracle_state owner mismatch: ${info.owner.toBase58()} (expected ${ORACLE_PID.toBase58()})`
    );
  }

  // PASS ONLY ONE ACCOUNT: oracle_state
  const keys = [
    { pubkey: oracleStatePda, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: READER_PID,
    keys,
    data: Buffer.from(LOG_ORACLE_DISC), // no args
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    skipPreflight: false,
    commitment: "processed",
  });

  console.log("tx:", sig);
  console.log("Check logs for '--- ORACLE SNAPSHOT ---'.");
})().catch(async (e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});

