import { PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF");
const amm = new PublicKey("<AMM_PUBKEY>"); // the PDA for your Amm account

const [vaultSolPda, vaultSolBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_sol"), amm.toBuffer()],
  PROGRAM_ID
);

console.log("vault_sol =", vaultSolPda.toBase58(), "bump =", vaultSolBump);

