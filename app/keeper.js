#!/usr/bin/env ts-node
"use strict";
// app/keeper.ts — Keeper bot for executing dark pool limit orders
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var anchor = __importStar(require("@coral-xyz/anchor"));
var bn_js_1 = __importDefault(require("bn.js"));
var web3_js_1 = require("@solana/web3.js");
var axios_1 = __importDefault(require("axios"));
function loadConfig() {
    var configPath = path.resolve(process.cwd(), 'keeper.config.json');
    try {
        if (fs.existsSync(configPath)) {
            var configData = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(configData);
        }
    }
    catch (err) {
        console.warn('⚠️  Failed to load keeper.config.json, using defaults');
    }
    return {};
}
var config = loadConfig();
var RPC = process.env.ANCHOR_PROVIDER_URL || config.rpc || 'http://127.0.0.1:8899';
var KEEPER_WALLET = process.env.KEEPER_WALLET || process.env.ANCHOR_WALLET || config.keeperWallet || "".concat(process.env.HOME, "/.config/solana/id.json");
var ORDER_BOOK_API = process.env.ORDER_BOOK_API || config.orderbookApi || 'http://localhost:3436';
var CHECK_INTERVAL = parseInt(process.env.KEEPER_CHECK_INTERVAL || String(config.pollIntervalMs || 2000)); // ms
var MIN_PROFIT_LAMPORTS = parseInt(process.env.KEEPER_MIN_PROFIT || '100000'); // 0.0001 SOL
// Program IDs
var PID = new web3_js_1.PublicKey('EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF');
var AMM_SEED = Buffer.from('amm_btc_v6');
var POS_SEED = Buffer.from('pos');
var VAULT_SOL_SEED = Buffer.from('vault_sol');
var USER_VAULT_SEED = Buffer.from('user_vault');
/* ==================== HELPERS ==================== */
function loadKeeper(path) {
    var rawKey = JSON.parse(fs.readFileSync(path, 'utf8'));
    return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(rawKey));
}
function getAmmPda() {
    var pda = web3_js_1.PublicKey.findProgramAddressSync([AMM_SEED], PID)[0];
    return pda;
}
function getPositionPda(amm, user) {
    var pda = web3_js_1.PublicKey.findProgramAddressSync([POS_SEED, amm.toBuffer(), user.toBuffer()], PID)[0];
    return pda;
}
function getVaultPda(amm) {
    var pda = web3_js_1.PublicKey.findProgramAddressSync([VAULT_SOL_SEED, amm.toBuffer()], PID)[0];
    return pda;
}
function getUserVaultPda(position) {
    var pda = web3_js_1.PublicKey.findProgramAddressSync([USER_VAULT_SEED, position.toBuffer()], PID)[0];
    return pda;
}
function serializeOrder(order) {
    // Serialize LimitOrder struct to match Rust Borsh encoding
    // Order must match Rust struct field order exactly
    var buffers = [];
    // market: Pubkey (32 bytes)
    buffers.push(order.market.toBuffer());
    // user: Pubkey (32 bytes)
    buffers.push(order.user.toBuffer());
    // action: u8 (1 byte)
    var actionBuf = Buffer.alloc(1);
    actionBuf.writeUInt8(order.action);
    buffers.push(actionBuf);
    // side: u8 (1 byte)
    var sideBuf = Buffer.alloc(1);
    sideBuf.writeUInt8(order.side);
    buffers.push(sideBuf);
    // shares_e6: i64 (8 bytes, little-endian)
    var sharesBuf = Buffer.alloc(8);
    sharesBuf.writeBigInt64LE(BigInt(order.sharesE6.toString()));
    buffers.push(sharesBuf);
    // limit_price_e6: i64 (8 bytes, little-endian)
    var limitPriceBuf = Buffer.alloc(8);
    limitPriceBuf.writeBigInt64LE(BigInt(order.limitPriceE6.toString()));
    buffers.push(limitPriceBuf);
    // max_cost_e6: i64 (8 bytes, little-endian)
    var maxCostBuf = Buffer.alloc(8);
    maxCostBuf.writeBigInt64LE(BigInt(order.maxCostE6.toString()));
    buffers.push(maxCostBuf);
    // min_proceeds_e6: i64 (8 bytes, little-endian)
    var minProceedsBuf = Buffer.alloc(8);
    minProceedsBuf.writeBigInt64LE(BigInt(order.minProceedsE6.toString()));
    buffers.push(minProceedsBuf);
    // expiry_ts: i64 (8 bytes, little-endian)
    var expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(order.expiryTs.toString()));
    buffers.push(expiryBuf);
    // nonce: u64 (8 bytes, little-endian)
    var nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(order.nonce.toString()));
    buffers.push(nonceBuf);
    // keeper_fee_bps: u16 (2 bytes, little-endian)
    var keeperFeeBuf = Buffer.alloc(2);
    keeperFeeBuf.writeUInt16LE(order.keeperFeeBps);
    buffers.push(keeperFeeBuf);
    // min_fill_bps: u16 (2 bytes, little-endian)
    var minFillBuf = Buffer.alloc(2);
    minFillBuf.writeUInt16LE(order.minFillBps);
    buffers.push(minFillBuf);
    return Buffer.concat(buffers);
}
/* ==================== PRICE CALCULATION ==================== */
function calculateLmsrCost(amm, qYes, qNo) {
    // b uses same 10M scaling as Q values (matches app.js)
    var b = amm.b.toNumber() / 10000000;
    var a = qYes / b;
    var c = qNo / b;
    var m = Math.max(a, c);
    var ea = Math.exp(a - m);
    var ec = Math.exp(c - m);
    return b * (m + Math.log(ea + ec));
}
function calculateCurrentPrice(amm, action, side, shares) {
    // Calculate price for buying/selling shares (shares in regular units, not e6)
    // Q values use 10M scaling on-chain (10_000_000 = 1 share) - matches app.js
    var currentQYesShares = amm.qYes.toNumber() / 10000000;
    var currentQNoShares = amm.qNo.toNumber() / 10000000;
    var baseCost = calculateLmsrCost(amm, currentQYesShares, currentQNoShares);
    var targetCost;
    if (action === 1) { // BUY
        if (side === 1) { // YES
            targetCost = calculateLmsrCost(amm, currentQYesShares + shares, currentQNoShares);
        }
        else { // NO
            targetCost = calculateLmsrCost(amm, currentQYesShares, currentQNoShares + shares);
        }
    }
    else { // SELL
        if (side === 1) { // YES
            targetCost = calculateLmsrCost(amm, currentQYesShares - shares, currentQNoShares);
        }
        else { // NO
            targetCost = calculateLmsrCost(amm, currentQYesShares, currentQNoShares - shares);
        }
    }
    var netCost = Math.abs(targetCost - baseCost);
    // Apply fees
    var feeBps = amm.feeBps;
    var grossCost = action === 1
        ? netCost / (1 - feeBps / 10000)
        : netCost * (1 - feeBps / 10000);
    // Average price per share in e6 scale
    var avgPrice = (grossCost / shares) * 1e6; // Price in USD with e6 scaling
    return Math.floor(avgPrice);
}
/* ==================== ORDER CHECKING ==================== */
function fetchPendingOrders() {
    return __awaiter(this, void 0, void 0, function () {
        var response, err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, axios_1.default.get("".concat(ORDER_BOOK_API, "/api/orders/pending"), {
                            params: { limit: 100 }
                        })];
                case 1:
                    response = _a.sent();
                    return [2 /*return*/, response.data.orders];
                case 2:
                    err_1 = _a.sent();
                    console.error('❌ Error fetching pending orders:', err_1.message);
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function checkIfExecutable(connection, amm, order) {
    return __awaiter(this, void 0, void 0, function () {
        var now, qShares, currentPrice, SLIPPAGE_BPS, slippageFactor, orderShares, execPrice, onChainTolerance, maxAcceptable, executable, maxAllowedOnChain, minAcceptable, executable, minAllowedOnChain;
        return __generator(this, function (_a) {
            try {
                // Check market is open
                if (amm.status !== 1) {
                    return [2 /*return*/, false];
                }
                now = Math.floor(Date.now() / 1000);
                if (order.expiry_ts <= now) {
                    return [2 /*return*/, false];
                }
                // For SELL orders, check if user has enough shares outstanding
                if (order.action === 2) { // SELL
                    qShares = order.side === 1 ? amm.qYes.toNumber() : amm.qNo.toNumber();
                    if (qShares < order.shares_e6) {
                        console.log("   \u26A0\uFE0F  Insufficient shares outstanding (need ".concat(order.shares_e6, ", have ").concat(qShares, ")"));
                        return [2 /*return*/, false];
                    }
                }
                currentPrice = calculateCurrentPrice(amm, order.action, order.side, 1);
                SLIPPAGE_BPS = 50;
                slippageFactor = SLIPPAGE_BPS / 10000;
                console.log("   Current price: $".concat((currentPrice / 1e6).toFixed(6), " | Limit: $").concat((order.limit_price_e6 / 1e6).toFixed(6)));
                orderShares = order.shares_e6 / 10000000;
                execPrice = calculateCurrentPrice(amm, order.action, order.side, orderShares);
                onChainTolerance = 0.002;
                console.log("   Order size: ".concat(orderShares.toFixed(2), " shares | Exec price: $").concat((execPrice / 1e6).toFixed(6)));
                // Check price condition with slippage buffer
                if (order.action === 1) { // BUY
                    maxAcceptable = order.limit_price_e6 * (1 - slippageFactor);
                    executable = currentPrice <= maxAcceptable;
                    console.log("   BUY condition: ".concat(currentPrice, " <= ").concat(Math.floor(maxAcceptable), " (limit=").concat(order.limit_price_e6, " - ").concat(slippageFactor * 100, "%) = ").concat(executable));
                    maxAllowedOnChain = order.limit_price_e6 * (1 + onChainTolerance);
                    if (executable && execPrice > maxAllowedOnChain) {
                        console.log("   \u26A0\uFE0F  Would fail on-chain: exec ".concat(execPrice, " > ").concat(Math.floor(maxAllowedOnChain), " (limit + 0.2%)"));
                        // For partial fill orders (min_fill_bps = 0), still try - on-chain will find max executable
                        if (order.min_fill_bps === 0) {
                            console.log("   \uD83D\uDD04 Partial fill enabled - will attempt execution (on-chain will find max amount)");
                            return [2 /*return*/, true];
                        }
                        return [2 /*return*/, false];
                    }
                    // Even if conservative check failed, try partial fill orders - let on-chain decide
                    if (!executable && order.min_fill_bps === 0 && currentPrice <= order.limit_price_e6) {
                        console.log("   \uD83D\uDD04 Partial fill enabled - attempting despite conservative buffer (current ".concat(currentPrice, " <= limit ").concat(order.limit_price_e6, ")"));
                        return [2 /*return*/, true];
                    }
                    return [2 /*return*/, executable];
                }
                else { // SELL
                    minAcceptable = order.limit_price_e6 * (1 + slippageFactor);
                    executable = currentPrice >= minAcceptable;
                    console.log("   SELL condition: ".concat(currentPrice, " >= ").concat(Math.floor(minAcceptable), " (limit=").concat(order.limit_price_e6, " + ").concat(slippageFactor * 100, "%) = ").concat(executable));
                    minAllowedOnChain = order.limit_price_e6 * (1 - onChainTolerance);
                    if (executable && execPrice < minAllowedOnChain) {
                        console.log("   \u26A0\uFE0F  Would fail on-chain: exec ".concat(execPrice, " < ").concat(Math.floor(minAllowedOnChain), " (limit - 0.2%)"));
                        // For partial fill orders (min_fill_bps = 0), still try - on-chain will find max executable
                        if (order.min_fill_bps === 0) {
                            console.log("   \uD83D\uDD04 Partial fill enabled - will attempt execution (on-chain will find max amount)");
                            return [2 /*return*/, true];
                        }
                        return [2 /*return*/, false];
                    }
                    // Even if conservative check failed, try partial fill orders - let on-chain decide
                    if (!executable && order.min_fill_bps === 0 && currentPrice >= order.limit_price_e6) {
                        console.log("   \uD83D\uDD04 Partial fill enabled - attempting despite conservative buffer (current ".concat(currentPrice, " >= limit ").concat(order.limit_price_e6, ")"));
                        return [2 /*return*/, true];
                    }
                    return [2 /*return*/, executable];
                }
            }
            catch (err) {
                console.error("\u274C Error checking executability:", err.message);
                return [2 /*return*/, false];
            }
            return [2 /*return*/];
        });
    });
}
/* ==================== ORDER EXECUTION ==================== */
function executeOrder(connection, keeper, order, signature, orderId) {
    return __awaiter(this, void 0, void 0, function () {
        var ammPda, userPubkey, positionPda, vaultSolPda, userVaultPda, idl, provider, program, ammAccountInfo, feeDest, limitOrderStruct, signatureBytes, signatureArray, messageBytes, ED25519_PROGRAM_ID, publicKeyBytes, numSignatures, publicKeyOffset, signatureOffset, messageDataOffset, messageDataSize, signatureInstructionIndex, publicKeyInstructionIndex, messageInstructionIndex, headerBuffer, ed25519InstructionData, ed25519Ix, computeBudgetIx, tx, txDetails, filledShares, executionPrice, _i, _a, log, dqMatch, priceMatch, err_2;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 5, , 6]);
                    ammPda = getAmmPda();
                    userPubkey = new web3_js_1.PublicKey(order.user);
                    positionPda = getPositionPda(ammPda, userPubkey);
                    vaultSolPda = getVaultPda(ammPda);
                    userVaultPda = getUserVaultPda(positionPda);
                    console.log("\n\uD83D\uDD27 Building transaction for order ".concat(orderId, "..."));
                    console.log("   User: ".concat(order.user));
                    console.log("   Action: ".concat(order.action === 1 ? 'BUY' : 'SELL', " ").concat(order.side === 1 ? 'YES' : 'NO'));
                    console.log("   Shares: ".concat(order.shares_e6 / 10000000));
                    console.log("   Limit Price: $".concat((order.limit_price_e6 / 1e6).toFixed(6)));
                    idl = JSON.parse(fs.readFileSync('target/idl/cpi_oracle.json', 'utf8'));
                    provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper), { commitment: 'confirmed' });
                    program = new anchor.Program(idl, provider);
                    return [4 /*yield*/, connection.getAccountInfo(ammPda)];
                case 1:
                    ammAccountInfo = _b.sent();
                    if (!ammAccountInfo) {
                        throw new Error('AMM account not found');
                    }
                    feeDest = new web3_js_1.PublicKey(ammAccountInfo.data.slice(70, 102));
                    limitOrderStruct = {
                        market: new web3_js_1.PublicKey(order.market),
                        user: userPubkey,
                        action: order.action,
                        side: order.side,
                        sharesE6: new bn_js_1.default(order.shares_e6),
                        limitPriceE6: new bn_js_1.default(order.limit_price_e6),
                        maxCostE6: new bn_js_1.default(order.max_cost_e6),
                        minProceedsE6: new bn_js_1.default(order.min_proceeds_e6),
                        expiryTs: new bn_js_1.default(order.expiry_ts),
                        nonce: new bn_js_1.default(order.nonce),
                        keeperFeeBps: order.keeper_fee_bps,
                        minFillBps: order.min_fill_bps,
                    };
                    signatureBytes = Buffer.from(signature, 'hex');
                    if (signatureBytes.length !== 64) {
                        throw new Error("Invalid signature length: ".concat(signatureBytes.length, " (expected 64)"));
                    }
                    signatureArray = Array.from(signatureBytes);
                    messageBytes = serializeOrder(limitOrderStruct);
                    ED25519_PROGRAM_ID = new web3_js_1.PublicKey('Ed25519SigVerify111111111111111111111111111');
                    publicKeyBytes = userPubkey.toBytes();
                    numSignatures = 1;
                    publicKeyOffset = 16;
                    signatureOffset = 48;
                    messageDataOffset = 112;
                    messageDataSize = messageBytes.length;
                    signatureInstructionIndex = 0xffff;
                    publicKeyInstructionIndex = 0xffff;
                    messageInstructionIndex = 0xffff;
                    headerBuffer = Buffer.alloc(16);
                    headerBuffer.writeUInt8(numSignatures, 0); // offset 0: num_signatures
                    headerBuffer.writeUInt8(0, 1); // offset 1: padding
                    headerBuffer.writeUInt16LE(signatureOffset, 2); // offset 2-3: signature_offset
                    headerBuffer.writeUInt16LE(signatureInstructionIndex, 4); // offset 4-5: signature_instruction_index
                    headerBuffer.writeUInt16LE(publicKeyOffset, 6); // offset 6-7: public_key_offset
                    headerBuffer.writeUInt16LE(publicKeyInstructionIndex, 8); // offset 8-9: public_key_instruction_index
                    headerBuffer.writeUInt16LE(messageDataOffset, 10); // offset 10-11: message_data_offset
                    headerBuffer.writeUInt16LE(messageDataSize, 12); // offset 12-13: message_data_size
                    headerBuffer.writeUInt16LE(messageInstructionIndex, 14); // offset 14-15: message_instruction_index
                    ed25519InstructionData = Buffer.concat([
                        headerBuffer, // 16 bytes: header
                        Buffer.from(publicKeyBytes), // 32 bytes: public key
                        signatureBytes, // 64 bytes: signature
                        messageBytes, // variable: message
                    ]);
                    ed25519Ix = new web3_js_1.TransactionInstruction({
                        keys: [], // Empty array - no accounts referenced
                        programId: ED25519_PROGRAM_ID,
                        data: ed25519InstructionData,
                    });
                    computeBudgetIx = web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({
                        units: 1400000, // Increased for binary search in partial fills
                    });
                    console.log("   Executing on-chain with Anchor...");
                    console.log("     - AMM: ".concat(ammPda.toString()));
                    console.log("     - Position: ".concat(positionPda.toString()));
                    console.log("     - User Vault: ".concat(userVaultPda.toString()));
                    console.log("     - Fee Dest: ".concat(feeDest.toString()));
                    console.log("     - Vault Sol: ".concat(vaultSolPda.toString()));
                    console.log("     - User: ".concat(userPubkey.toString()));
                    console.log("     - Keeper: ".concat(keeper.publicKey.toString()));
                    console.log("     - Instructions Sysvar: ".concat(web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY.toString()));
                    return [4 /*yield*/, program.methods
                            .executeLimitOrder(limitOrderStruct, signatureArray)
                            .accountsStrict({
                            amm: ammPda,
                            position: positionPda,
                            userVault: userVaultPda,
                            feeDest: feeDest,
                            vaultSol: vaultSolPda,
                            user: userPubkey,
                            keeper: keeper.publicKey,
                            instructions: web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY,
                            systemProgram: web3_js_1.SystemProgram.programId,
                        })
                            .preInstructions([
                            computeBudgetIx, // Increase compute budget first
                            ed25519Ix, // Ed25519 verification must come before the main instruction
                        ])
                            .rpc()];
                case 2:
                    tx = _b.sent();
                    console.log("\u2705 Transaction sent: ".concat(tx));
                    console.log("   View: https://explorer.solana.com/tx/".concat(tx, "?cluster=custom"));
                    // Wait for transaction confirmation and fetch logs to parse actual filled amount
                    return [4 /*yield*/, connection.confirmTransaction(tx, 'confirmed')];
                case 3:
                    // Wait for transaction confirmation and fetch logs to parse actual filled amount
                    _b.sent();
                    return [4 /*yield*/, connection.getTransaction(tx, {
                            commitment: 'confirmed',
                            maxSupportedTransactionVersion: 0
                        })];
                case 4:
                    txDetails = _b.sent();
                    if (!txDetails || !txDetails.meta || !txDetails.meta.logMessages) {
                        console.error('❌ Could not fetch transaction details');
                        return [2 /*return*/, null];
                    }
                    filledShares = order.shares_e6;
                    executionPrice = order.limit_price_e6;
                    for (_i = 0, _a = txDetails.meta.logMessages; _i < _a.length; _i++) {
                        log = _a[_i];
                        dqMatch = log.match(/dq=(\d+)/);
                        if (dqMatch) {
                            filledShares = parseInt(dqMatch[1]);
                            console.log("\uD83D\uDCCA Parsed filled shares from logs: ".concat(filledShares, " (").concat(filledShares / 10000000, " shares)"));
                        }
                        priceMatch = log.match(/exec_price=(\d+)/);
                        if (priceMatch) {
                            executionPrice = parseInt(priceMatch[1]);
                            console.log("\uD83D\uDCB0 Parsed execution price from logs: ".concat(executionPrice, " ($").concat((executionPrice / 1e6).toFixed(6), ")"));
                        }
                    }
                    return [2 /*return*/, {
                            txSignature: tx,
                            filledShares: filledShares,
                            executionPrice: executionPrice
                        }];
                case 5:
                    err_2 = _b.sent();
                    console.error("\u274C Error executing order ".concat(orderId, ":"), err_2.message);
                    if (err_2.logs) {
                        console.error('Transaction logs:', err_2.logs);
                    }
                    return [2 /*return*/, null];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function markOrderFilled(orderId, txSignature, sharesFilled, executionPrice, keeperPubkey) {
    return __awaiter(this, void 0, void 0, function () {
        var err_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, axios_1.default.post("".concat(ORDER_BOOK_API, "/api/orders/").concat(orderId, "/fill"), {
                            tx_signature: txSignature,
                            shares_filled: sharesFilled,
                            execution_price: executionPrice,
                            keeper_pubkey: keeperPubkey,
                        })];
                case 1:
                    _a.sent();
                    console.log("\u2705 Order ".concat(orderId, " marked as filled in database"));
                    return [3 /*break*/, 3];
                case 2:
                    err_3 = _a.sent();
                    console.error("\u274C Error marking order ".concat(orderId, " as filled:"), err_3.message);
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/* ==================== MAIN LOOP ==================== */
function keeperLoop() {
    return __awaiter(this, void 0, void 0, function () {
        var keeper, connection, ammPda, iteration, timestamp, orders, ammAccountInfo, d, o, bump, decimals, bRaw, feeBps, qYesRaw, qNoRaw, feesRaw, vaultE6Raw, status_1, amm, _i, orders_1, orderData, order, signature, order_id, executable, result, err_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    keeper = loadKeeper(KEEPER_WALLET);
                    connection = new web3_js_1.Connection(RPC, 'confirmed');
                    ammPda = getAmmPda();
                    console.log('🤖 Keeper Bot Started');
                    console.log('━'.repeat(60));
                    console.log("Keeper:         ".concat(keeper.publicKey.toString()));
                    console.log("RPC:            ".concat(RPC));
                    console.log("Order Book API: ".concat(ORDER_BOOK_API));
                    console.log("AMM:            ".concat(ammPda.toString()));
                    console.log("Check Interval: ".concat(CHECK_INTERVAL, "ms"));
                    console.log('━'.repeat(60));
                    iteration = 0;
                    _a.label = 1;
                case 1:
                    if (!true) return [3 /*break*/, 20];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 17, , 18]);
                    iteration++;
                    timestamp = new Date().toISOString();
                    return [4 /*yield*/, fetchPendingOrders()];
                case 3:
                    orders = _a.sent();
                    if (!(orders.length === 0)) return [3 /*break*/, 4];
                    if (iteration % 10 === 0) {
                        console.log("[".concat(timestamp, "] \uD83D\uDCA4 No pending orders (checked ").concat(iteration, " times)"));
                    }
                    return [3 /*break*/, 16];
                case 4:
                    console.log("\n[".concat(timestamp, "] \uD83D\uDCCB Found ").concat(orders.length, " pending order(s)"));
                    return [4 /*yield*/, connection.getAccountInfo(ammPda)];
                case 5:
                    ammAccountInfo = _a.sent();
                    if (!!ammAccountInfo) return [3 /*break*/, 7];
                    console.error('❌ AMM account not found');
                    return [4 /*yield*/, sleep(CHECK_INTERVAL)];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 1];
                case 7:
                    d = ammAccountInfo.data;
                    o = 8;
                    bump = d.readUInt8(o);
                    o += 1;
                    decimals = d.readUInt8(o);
                    o += 1;
                    bRaw = d.readBigInt64LE(o);
                    o += 8;
                    feeBps = d.readUInt16LE(o);
                    o += 2;
                    qYesRaw = d.readBigInt64LE(o);
                    o += 8;
                    qNoRaw = d.readBigInt64LE(o);
                    o += 8;
                    feesRaw = d.readBigInt64LE(o);
                    o += 8;
                    vaultE6Raw = d.readBigInt64LE(o);
                    o += 8;
                    status_1 = d.readUInt8(o);
                    o += 1;
                    amm = {
                        bump: bump,
                        decimals: decimals,
                        b: new bn_js_1.default(bRaw.toString()),
                        feeBps: feeBps,
                        qYes: new bn_js_1.default(qYesRaw.toString()),
                        qNo: new bn_js_1.default(qNoRaw.toString()),
                        fees: new bn_js_1.default(feesRaw.toString()),
                        vaultE6: new bn_js_1.default(vaultE6Raw.toString()),
                        status: status_1,
                        winner: 0,
                        wTotalE6: new bn_js_1.default(0),
                        ppsE6: new bn_js_1.default(0),
                        feeDest: keeper.publicKey,
                        vaultSolBump: 0,
                        startPriceE6: new bn_js_1.default(0),
                        startTs: new bn_js_1.default(0),
                        settlePriceE6: new bn_js_1.default(0),
                        settleTs: new bn_js_1.default(0),
                        marketEndSlot: new bn_js_1.default(0),
                        marketEndTime: new bn_js_1.default(0),
                    };
                    console.log("\uD83D\uDCCA AMM State: qYes=".concat(amm.qYes.toNumber() / 1e6, ", qNo=").concat(amm.qNo.toNumber() / 1e6, ", status=").concat(amm.status));
                    _i = 0, orders_1 = orders;
                    _a.label = 8;
                case 8:
                    if (!(_i < orders_1.length)) return [3 /*break*/, 16];
                    orderData = orders_1[_i];
                    order = orderData.order, signature = orderData.signature, order_id = orderData.order_id;
                    console.log("\n\uD83D\uDD0D Checking order ".concat(order_id, ":"));
                    console.log("   ".concat(order.action === 1 ? 'BUY' : 'SELL', " ").concat(order.shares_e6 / 10000000, " ").concat(order.side === 1 ? 'YES' : 'NO', " @ limit $").concat((order.limit_price_e6 / 1e6).toFixed(6)));
                    return [4 /*yield*/, checkIfExecutable(connection, amm, order)];
                case 9:
                    executable = _a.sent();
                    if (!executable) return [3 /*break*/, 14];
                    console.log("\u2705 Order ".concat(order_id, " is executable!"));
                    return [4 /*yield*/, executeOrder(connection, keeper, order, signature, order_id)];
                case 10:
                    result = _a.sent();
                    if (!result) return [3 /*break*/, 12];
                    console.log("\u2705 Order ".concat(order_id, " executed: ").concat(result.txSignature));
                    console.log("   Filled: ".concat(result.filledShares / 10000000, " shares (requested: ").concat(order.shares_e6 / 10000000, ")"));
                    console.log("   Execution Price: $".concat((result.executionPrice / 1e6).toFixed(6)));
                    // Mark as filled in database with ACTUAL filled shares
                    return [4 /*yield*/, markOrderFilled(order_id, result.txSignature, result.filledShares, // Use actual filled shares from transaction logs
                        result.executionPrice, // Use actual execution price from logs
                        keeper.publicKey.toString())];
                case 11:
                    // Mark as filled in database with ACTUAL filled shares
                    _a.sent();
                    return [3 /*break*/, 13];
                case 12:
                    console.log("\u26A0\uFE0F  Order ".concat(order_id, " execution skipped (implementation pending)"));
                    _a.label = 13;
                case 13: return [3 /*break*/, 15];
                case 14:
                    console.log("\u274C Order ".concat(order_id, " not executable yet (price condition not met or expired)"));
                    _a.label = 15;
                case 15:
                    _i++;
                    return [3 /*break*/, 8];
                case 16: return [3 /*break*/, 18];
                case 17:
                    err_4 = _a.sent();
                    console.error('❌ Error in keeper loop:', err_4.message);
                    return [3 /*break*/, 18];
                case 18: return [4 /*yield*/, sleep(CHECK_INTERVAL)];
                case 19:
                    _a.sent();
                    return [3 /*break*/, 1];
                case 20: return [2 /*return*/];
            }
        });
    });
}
function sleep(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}
/* ==================== START ==================== */
keeperLoop().catch(function (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
