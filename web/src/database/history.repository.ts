/**
 * History repository - handles settlement and trading history
 */

import Database from 'better-sqlite3';
import { SettlementHistoryRow, TradingHistoryRow } from '../types';

/**
 * Repository for managing settlement and trading history
 */
export class HistoryRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ==================== Settlement History ====================

  /**
   * Add a settlement record
   */
  public addSettlement(
    userPrefix: string,
    result: string,
    amount: number,
    side: string,
    snapshotPrice: number | null = null,
    settlePrice: number | null = null
  ): boolean {
    try {
      const timestamp = Date.now();

      // Get timestamp of last settlement for this user to determine cycle boundary
      let cycleStartTime = 0;
      const lastSettlementStmt = this.db.prepare(
        'SELECT timestamp FROM settlement_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT 1'
      );
      const lastSettlement = lastSettlementStmt.get(userPrefix) as { timestamp: number } | undefined;

      if (lastSettlement) {
        cycleStartTime = lastSettlement.timestamp;
      }

      // Calculate total buys, sells, and net spent from trading history SINCE LAST SETTLEMENT
      let totalBuys = 0;
      let totalSells = 0;

      const tradingStmt = this.db.prepare(
        'SELECT action, cost_usd FROM trading_history WHERE user_prefix = ? AND timestamp > ? AND timestamp <= ? ORDER BY timestamp ASC'
      );
      const trades = tradingStmt.all(userPrefix, cycleStartTime, timestamp) as Array<{ action: string; cost_usd: number }>;

      for (const trade of trades) {
        if (trade.action === 'BUY') {
          totalBuys += trade.cost_usd;
        } else if (trade.action === 'SELL') {
          totalSells += trade.cost_usd;
        }
      }

      const netSpent = totalBuys - totalSells;

      const stmt = this.db.prepare(
        'INSERT INTO settlement_history (user_prefix, result, amount, side, timestamp, snapshot_price, settle_price, total_buys, total_sells, net_spent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      stmt.run(userPrefix, result, amount, side, timestamp, snapshotPrice, settlePrice, totalBuys, totalSells, netSpent);

      return true;
    } catch (err) {
      console.error('Failed to add settlement:', (err as Error).message);
      return false;
    }
  }

  /**
   * Get settlement history (most recent first)
   */
  public getSettlements(limit: number = 100): SettlementHistoryRow[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM settlement_history ORDER BY timestamp DESC LIMIT ?');
      return stmt.all(limit) as SettlementHistoryRow[];
    } catch (err) {
      console.error('Failed to get settlement history:', (err as Error).message);
      return [];
    }
  }

  /**
   * Get settlement history for a specific user
   */
  public getSettlementsByUser(userPrefix: string, limit: number = 100): SettlementHistoryRow[] {
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM settlement_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT ?'
      );
      return stmt.all(userPrefix, limit) as SettlementHistoryRow[];
    } catch (err) {
      console.error('Failed to get user settlement history:', (err as Error).message);
      return [];
    }
  }

  /**
   * Clean up old settlement records
   */
  public cleanupSettlements(maxAgeHours: number): number {
    try {
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      const stmt = this.db.prepare('DELETE FROM settlement_history WHERE timestamp < ?');
      const result = stmt.run(cutoffTime);

      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} old settlement records`);
      }

      return result.changes;
    } catch (err) {
      console.error('Failed to cleanup old settlements:', (err as Error).message);
      return 0;
    }
  }

  // ==================== Trading History ====================

  /**
   * Add a trading record
   */
  public addTrade(
    userPrefix: string,
    action: string,
    side: string,
    shares: number,
    costUsd: number,
    avgPrice: number,
    pnl: number | null = null
  ): boolean {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO trading_history (user_prefix, action, side, shares, cost_usd, avg_price, pnl, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      stmt.run(userPrefix, action, side, shares, costUsd, avgPrice, pnl, Date.now());

      return true;
    } catch (err) {
      console.error('Failed to add trading history:', (err as Error).message);
      return false;
    }
  }

  /**
   * Get trading history for a specific user
   */
  public getTradesByUser(userPrefix: string, limit: number = 100): TradingHistoryRow[] {
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM trading_history WHERE user_prefix = ? ORDER BY timestamp DESC LIMIT ?'
      );
      return stmt.all(userPrefix, limit) as TradingHistoryRow[];
    } catch (err) {
      console.error('Failed to get trading history:', (err as Error).message);
      return [];
    }
  }

  /**
   * Get all trading history (most recent first)
   */
  public getAllTrades(limit: number = 100): TradingHistoryRow[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM trading_history ORDER BY timestamp DESC LIMIT ?');
      return stmt.all(limit) as TradingHistoryRow[];
    } catch (err) {
      console.error('Failed to get all trading history:', (err as Error).message);
      return [];
    }
  }

  /**
   * Clean up old trading records
   */
  public cleanupTrades(maxAgeHours: number): number {
    try {
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      const stmt = this.db.prepare('DELETE FROM trading_history WHERE timestamp < ?');
      const result = stmt.run(cutoffTime);

      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} old trading records`);
      }

      return result.changes;
    } catch (err) {
      console.error('Failed to cleanup old trading history:', (err as Error).message);
      return 0;
    }
  }
}
