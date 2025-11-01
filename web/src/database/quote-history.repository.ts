/**
 * Quote history repository - handles LMSR quote snapshots per market cycle
 */

import Database from 'better-sqlite3';
import { QuoteHistoryRow, CycleInfo } from '../types';

/**
 * Repository for managing quote (probability) history across market cycles
 */
export class QuoteHistoryRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Add a quote snapshot for a cycle
   */
  public insert(cycleId: string, upPrice: number, downPrice: number): boolean {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO quote_history (cycle_id, up_price, down_price, timestamp) VALUES (?, ?, ?, ?)'
      );
      stmt.run(cycleId, upPrice, downPrice, Date.now());

      return true;
    } catch (err) {
      console.error('Failed to add quote snapshot:', (err as Error).message);
      return false;
    }
  }

  /**
   * Get quote history for a specific cycle
   */
  public findByCycle(cycleId: string): QuoteHistoryRow[] {
    try {
      const stmt = this.db.prepare(
        'SELECT up_price, down_price, timestamp FROM quote_history WHERE cycle_id = ? ORDER BY timestamp ASC'
      );
      return stmt.all(cycleId) as QuoteHistoryRow[];
    } catch (err) {
      console.error('Failed to get quote history:', (err as Error).message);
      return [];
    }
  }

  /**
   * Get list of recent cycles
   */
  public getRecentCycles(limit: number = 10): CycleInfo[] {
    try {
      const stmt = this.db.prepare(
        'SELECT DISTINCT cycle_id, cycle_start_time FROM volume_history ORDER BY cycle_start_time DESC LIMIT ?'
      );
      return stmt.all(limit) as CycleInfo[];
    } catch (err) {
      console.error('Failed to get recent cycles:', (err as Error).message);
      return [];
    }
  }

  /**
   * Clean up old quote history records
   */
  public cleanup(maxAgeHours: number): number {
    try {
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      const stmt = this.db.prepare('DELETE FROM quote_history WHERE timestamp < ?');
      const result = stmt.run(cutoffTime);

      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} old quote history records`);
      }

      return result.changes;
    } catch (err) {
      console.error('Failed to cleanup old quote history:', (err as Error).message);
      return 0;
    }
  }

  /**
   * Get the most recent quote for a cycle
   */
  public getLatestForCycle(cycleId: string): QuoteHistoryRow | null {
    try {
      const stmt = this.db.prepare(
        'SELECT up_price, down_price, timestamp FROM quote_history WHERE cycle_id = ? ORDER BY timestamp DESC LIMIT 1'
      );
      return stmt.get(cycleId) as QuoteHistoryRow | undefined || null;
    } catch (err) {
      console.error('Failed to get latest quote:', (err as Error).message);
      return null;
    }
  }

  /**
   * Get quote count for a specific cycle
   */
  public countByCycle(cycleId: string): number {
    try {
      const result = this.db.prepare(
        'SELECT COUNT(*) as count FROM quote_history WHERE cycle_id = ?'
      ).get(cycleId) as { count: number };
      return result.count;
    } catch (err) {
      console.error('Failed to count quotes for cycle:', (err as Error).message);
      return 0;
    }
  }

  /**
   * Get quote history for a time range within a cycle
   */
  public findByCycleAndTimeRange(cycleId: string, startTime: number, endTime: number): QuoteHistoryRow[] {
    try {
      const stmt = this.db.prepare(
        'SELECT up_price, down_price, timestamp FROM quote_history WHERE cycle_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
      );
      return stmt.all(cycleId, startTime, endTime) as QuoteHistoryRow[];
    } catch (err) {
      console.error('Failed to get quote history by time range:', (err as Error).message);
      return [];
    }
  }
}
