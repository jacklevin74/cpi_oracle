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

export class TradingRepository {
  private db: Database;
  private enableLogging: boolean;

  constructor(config: TradingRepositoryConfig) {
    this.db = config.db;
    this.enableLogging = config.enableLogging ?? false;
  }

  /**
   * Get trading history for a specific user
   */
  findByUserPrefix(userPrefix: string, limit: number = 100): TradingHistoryRow[] {
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM trading_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT ?'
      );
      const rows = stmt.all(userPrefix, limit) as TradingHistoryRow[];

      if (this.enableLogging) {
        console.log(`[TradingRepository] Found ${rows.length} trades for user ${userPrefix}`);
      }

      return rows;
    } catch (err) {
      console.error('[TradingRepository] Failed to get trading history:', err);
      return [];
    }
  }

  /**
   * Add a new trade to history
   */
  insert(trade: Omit<TradingHistoryRow, 'id'>): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO trading_history (
          user_prefix, action, side, shares, cost_usd, avg_price, pnl, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        trade.user_prefix,
        trade.action,
        trade.side,
        trade.shares,
        trade.cost_usd,
        trade.avg_price,
        trade.pnl,
        trade.timestamp
      );

      if (this.enableLogging) {
        console.log(`[TradingRepository] Added trade for user ${trade.user_prefix}`);
      }

      return true;
    } catch (err) {
      console.error('[TradingRepository] Failed to insert trade:', err);
      return false;
    }
  }

  /**
   * Cleanup old trading records
   */
  cleanup(maxAgeHours: number): number {
    try {
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      const stmt = this.db.prepare('DELETE FROM trading_history WHERE timestamp < ?');
      const result = stmt.run(cutoffTime);

      if (this.enableLogging && result.changes > 0) {
        console.log(`[TradingRepository] Cleaned up ${result.changes} old trading records`);
      }

      return result.changes;
    } catch (err) {
      console.error('[TradingRepository] Failed to cleanup old trading history:', err);
      return 0;
    }
  }

  /**
   * Get total count of trades for a user
   */
  countByUserPrefix(userPrefix: string): number {
    try {
      const stmt = this.db.prepare(
        'SELECT COUNT(*) as count FROM trading_history WHERE user_prefix = ?'
      );
      const result = stmt.get(userPrefix) as { count: number };
      return result.count;
    } catch (err) {
      console.error('[TradingRepository] Failed to count trades:', err);
      return 0;
    }
  }
}
