// Test Ed25519 instruction creation
const { PublicKey, Ed25519Program } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');

// Sample order data from API (order #9)
const order = {
  market: new PublicKey("3Mgfh1zgsuRbvBzVCfW6VvvCYHLku8sk7GM5HLhw8Vgc"),
  user: new PublicKey("47Vckihe8sZifmYpvATMbcUfeAzqbSsSZLnS1hHM2K1S"),
  action: 1,
  side: 1,
  sharesE6: new anchor.BN(5000000),
  limitPriceE6: new anchor.BN(600000),
  maxCostE6: new anchor.BN(9007199254740991),
  minProceedsE6: new anchor.BN(0),
  expiryTs: new anchor.BN(1762302750),
  nonce: new anchor.BN("1762216350398740"),
  keeperFeeBps: 50,
  minFillBps: 5000,
};

// Serialize order
function serializeOrder(order) {
  const buffers = [];

  buffers.push(order.market.toBuffer());
  buffers.push(order.user.toBuffer());

  const actionBuf = Buffer.alloc(1);
  actionBuf.writeUInt8(order.action);
  buffers.push(actionBuf);

  const sideBuf = Buffer.alloc(1);
  sideBuf.writeUInt8(order.side);
  buffers.push(sideBuf);

  const sharesBuf = Buffer.alloc(8);
  sharesBuf.writeBigInt64LE(BigInt(order.sharesE6.toString()));
  buffers.push(sharesBuf);

  const limitPriceBuf = Buffer.alloc(8);
  limitPriceBuf.writeBigInt64LE(BigInt(order.limitPriceE6.toString()));
  buffers.push(limitPriceBuf);

  const maxCostBuf = Buffer.alloc(8);
  maxCostBuf.writeBigInt64LE(BigInt(order.maxCostE6.toString()));
  buffers.push(maxCostBuf);

  const minProceedsBuf = Buffer.alloc(8);
  minProceedsBuf.writeBigInt64LE(BigInt(order.minProceedsE6.toString()));
  buffers.push(minProceedsBuf);

  const expiryBuf = Buffer.alloc(8);
  expiryBuf.writeBigInt64LE(BigInt(order.expiryTs.toString()));
  buffers.push(expiryBuf);

  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(order.nonce.toString()));
  buffers.push(nonceBuf);

  const keeperFeeBuf = Buffer.alloc(2);
  keeperFeeBuf.writeUInt16LE(order.keeperFeeBps);
  buffers.push(keeperFeeBuf);

  const minFillBuf = Buffer.alloc(2);
  minFillBuf.writeUInt16LE(order.minFillBps);
  buffers.push(minFillBuf);

  return Buffer.concat(buffers);
}

const messageBytes = serializeOrder(order);
const signature = Buffer.from("41fd3dbb27dccfae2e69b7ba1797c3df2feb6ec064fd0a4ab4bddeb5c80de5dfda50f9c654c5d82ac1c8fe3bad1cfbd381be99e1d5b043ec65f03e14b3d8c40f", "hex");

console.log("Message length:", messageBytes.length);
console.log("Message (hex):", messageBytes.toString("hex"));
console.log("");
console.log("Signature length:", signature.length);
console.log("Signature (hex):", signature.toString("hex"));
console.log("");

// Create Ed25519 instruction
const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
  publicKey: order.user.toBytes(),
  message: messageBytes,
  signature: signature,
});

console.log("Ed25519 Instruction:");
console.log("  Program ID:", ed25519Ix.programId.toString());
console.log("  Data length:", ed25519Ix.data.length);
console.log("  Data (hex):", ed25519Ix.data.toString("hex"));
console.log("");

// Parse the instruction data according to the expected format
console.log("Parsing instruction data:");
console.log("  num_signatures (offset 0):", ed25519Ix.data[0]);
console.log("  padding (offset 1):", ed25519Ix.data[1]);
console.log("  signature_offset (offset 2-3):", ed25519Ix.data.readUInt16LE(2));
console.log("  signature_instruction_index (offset 4-5):", ed25519Ix.data.readUInt16LE(4));
console.log("  public_key_offset (offset 6-7):", ed25519Ix.data.readUInt16LE(6));
console.log("  public_key_instruction_index (offset 8-9):", ed25519Ix.data.readUInt16LE(8));
console.log("  message_data_offset (offset 10-11):", ed25519Ix.data.readUInt16LE(10));
console.log("  message_data_size (offset 12-13):", ed25519Ix.data.readUInt16LE(12));
console.log("");

const ixPubkey = ed25519Ix.data.slice(14, 46);
const ixSignature = ed25519Ix.data.slice(46, 110);
const ixMessage = ed25519Ix.data.slice(110);

console.log("Extracted from instruction:");
console.log("  Public key (14-46):", ixPubkey.toString("hex"));
console.log("  Expected pubkey:   ", order.user.toBuffer().toString("hex"));
console.log("  Match:", ixPubkey.equals(order.user.toBuffer()));
console.log("");
console.log("  Signature (46-110):", ixSignature.toString("hex"));
console.log("  Expected signature:", signature.toString("hex"));
console.log("  Match:", ixSignature.equals(signature));
console.log("");
console.log("  Message (110-end):", ixMessage.toString("hex").slice(0, 64) + "...");
console.log("  Expected message: ", messageBytes.toString("hex").slice(0, 64) + "...");
console.log("  Match:", ixMessage.equals(messageBytes));
