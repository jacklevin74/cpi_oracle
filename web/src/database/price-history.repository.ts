/**
 * Price history repository - handles price data storage and retrieval
 */

import Database from 'better-sqlite3';
import { PriceHistoryRow, PriceHistoryOptions } from '../types';

/**
 * Repository for managing price history data
 */
export class PriceHistoryRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Get total count of price records
   */
  public count(): number {
    try {
      const result = this.db.prepare('SELECT COUNT(*) as count FROM price_history').get() as { count: number };
      return result.count;
    } catch (err) {
      console.error('Failed to get price count:', (err as Error).message);
      return 0;
    }
  }

  /**
   * Find price history records with optional filters
   */
  public find(options: PriceHistoryOptions = {}): PriceHistoryRow[] {
    try {
      let query = 'SELECT price, timestamp FROM price_history';
      const params: number[] = [];

      // Add time range filter
      if (options.seconds) {
        const cutoffTime = Date.now() - (options.seconds * 1000);
        query += ' WHERE timestamp >= ?';
        params.push(cutoffTime);
      }

      // Add ordering
      query += ' ORDER BY timestamp ASC';

      // Add pagination
      if (options.limit) {
        query += ' LIMIT ?';
        params.push(options.limit);
      }

      if (options.offset) {
        query += ' OFFSET ?';
        params.push(options.offset);
      }

      const stmt = this.db.prepare(query);
      return stmt.all(...params) as PriceHistoryRow[];
    } catch (err) {
      console.error('Failed to query price history:', (err as Error).message);
      return [];
    }
  }

  /**
   * Insert a new price record
   */
  public insert(price: number, timestamp: number = Date.now()): boolean {
    try {
      const stmt = this.db.prepare('INSERT INTO price_history (price, timestamp) VALUES (?, ?)');
      stmt.run(price, timestamp);
      return true;
    } catch (err) {
      console.error('Failed to add price:', (err as Error).message);
      return false;
    }
  }

  /**
   * Delete old price records beyond the retention period
   */
  public cleanup(maxAgeHours: number): number {
    try {
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      const stmt = this.db.prepare('DELETE FROM price_history WHERE timestamp < ?');
      const result = stmt.run(cutoffTime);

      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} old price records`);
      }

      return result.changes;
    } catch (err) {
      console.error('Failed to cleanup old prices:', (err as Error).message);
      return 0;
    }
  }

  /**
   * Get the most recent price
   */
  public getLatest(): PriceHistoryRow | null {
    try {
      const stmt = this.db.prepare('SELECT price, timestamp FROM price_history ORDER BY timestamp DESC LIMIT 1');
      return stmt.get() as PriceHistoryRow | undefined || null;
    } catch (err) {
      console.error('Failed to get latest price:', (err as Error).message);
      return null;
    }
  }

  /**
   * Get price history for a specific time range
   */
  public findByTimeRange(startTime: number, endTime: number): PriceHistoryRow[] {
    try {
      const stmt = this.db.prepare(
        'SELECT price, timestamp FROM price_history WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
      );
      return stmt.all(startTime, endTime) as PriceHistoryRow[];
    } catch (err) {
      console.error('Failed to query price history by time range:', (err as Error).message);
      return [];
    }
  }
}
