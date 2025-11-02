/**
 * TradingRepository - Trading history database operations
 *
 * Manages trading_history table:
 * - Query trades by user prefix
 * - Add new trade records
 * - Cleanup old records
 */
import type { Database } from 'better-sqlite3';
import type { TradingHistoryRow } from '../types/database.types';
export interface TradingRepositoryConfig {
    db: Database;
    enableLogging?: boolean;
}
export declare class TradingRepository {
    private db;
    private enableLogging;
    constructor(config: TradingRepositoryConfig);
    /**
     * Get trading history for a specific user
     */
    findByUserPrefix(userPrefix: string, limit?: number): TradingHistoryRow[];
    /**
     * Add a new trade to history
     */
    insert(trade: Omit<TradingHistoryRow, 'id'>): boolean;
    /**
     * Cleanup old trading records
     */
    cleanup(maxAgeHours: number): number;
    /**
     * Get total count of trades for a user
     */
    countByUserPrefix(userPrefix: string): number;
}
//# sourceMappingURL=trading.repository.d.ts.map