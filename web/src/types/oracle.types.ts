/**
 * Oracle-related type definitions
 * Based on the X1 oracle program structure
 */

/**
 * Oracle price data with triplet structure
 */
export interface OracleTriplet {
  param1: bigint;
  param2: bigint;
  param3: bigint;
  timestamp1: bigint;
  timestamp2: bigint;
  timestamp3: bigint;
}

/**
 * Parsed oracle price result
 */
export interface OraclePrice {
  /** BTC price in USD (with decimal precision) */
  price: number;
  /** Age of the price data in seconds */
  age: number;
  /** Timestamp when this price was fetched (ms) */
  timestamp: number;
}

/**
 * Raw oracle account data structure
 */
export interface OracleAccountData {
  /** Account discriminator (8 bytes) */
  discriminator: Buffer;
  /** Update authority public key (32 bytes) */
  updateAuthority: Buffer;
  /** BTC price triplet */
  btc: OracleTriplet;
  /** ETH price triplet */
  eth: OracleTriplet;
  /** SOL price triplet */
  sol: OracleTriplet;
  /** Decimals used for price values */
  decimals: number;
}

/**
 * Oracle configuration
 */
export interface OracleConfig {
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Oracle state account public key */
  oracleState: string;
  /** Polling interval in milliseconds */
  pollInterval: number;
  /** Maximum age for valid price data (seconds) */
  maxAge: number;
}
