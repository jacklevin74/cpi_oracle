/**
 * Volume repository - handles cumulative volume tracking per market cycle
 */

import Database from 'better-sqlite3';
import { CumulativeVolume, VolumeHistoryRow } from '../types';

/**
 * Repository for managing volume data across market cycles
 */
export class VolumeRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Load the most recent cycle's volume data
   */
  public loadCurrent(): CumulativeVolume | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM volume_history ORDER BY cycle_start_time DESC LIMIT 1');
      const row = stmt.get() as VolumeHistoryRow | undefined;

      if (row) {
        console.log(`Loaded volume for cycle ${row.cycle_id}: ${row.total_volume.toFixed(2)} XNT total`);
        return this.rowToVolume(row);
      }

      return null;
    } catch (err) {
      console.error('Failed to load volume from database:', (err as Error).message);
      return null;
    }
  }

  /**
   * Save or update volume data for a cycle
   */
  public save(volume: CumulativeVolume): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO volume_history (
          cycle_id, cycle_start_time, up_volume, down_volume, total_volume,
          up_shares, down_shares, total_shares, last_update, market_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cycle_id) DO UPDATE SET
          up_volume = excluded.up_volume,
          down_volume = excluded.down_volume,
          total_volume = excluded.total_volume,
          up_shares = excluded.up_shares,
          down_shares = excluded.down_shares,
          total_shares = excluded.total_shares,
          last_update = excluded.last_update,
          market_state = excluded.market_state
      `);

      stmt.run(
        volume.cycleId,
        volume.cycleStartTime,
        volume.upVolume,
        volume.downVolume,
        volume.totalVolume,
        volume.upShares,
        volume.downShares,
        volume.totalShares,
        volume.lastUpdate,
        null // market_state (can be populated later if needed)
      );

      return true;
    } catch (err) {
      console.error('Failed to save volume to database:', (err as Error).message);
      return false;
    }
  }

  /**
   * Create a new cycle with initial volume data
   */
  public createNewCycle(): CumulativeVolume {
    const cycleId = `cycle_${Date.now()}`;
    const volume: CumulativeVolume = {
      cycleId,
      upVolume: 0,
      downVolume: 0,
      totalVolume: 0,
      upShares: 0,
      downShares: 0,
      totalShares: 0,
      lastUpdate: Date.now(),
      cycleStartTime: Date.now(),
    };

    this.save(volume);
    console.log(`New volume cycle started: ${cycleId}`);

    return volume;
  }

  /**
   * Get volume data for a specific cycle
   */
  public findByCycleId(cycleId: string): CumulativeVolume | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM volume_history WHERE cycle_id = ?');
      const row = stmt.get(cycleId) as VolumeHistoryRow | undefined;

      return row ? this.rowToVolume(row) : null;
    } catch (err) {
      console.error('Failed to find volume by cycle ID:', (err as Error).message);
      return null;
    }
  }

  /**
   * Get all volume history (recent cycles)
   */
  public findRecent(limit: number = 10): CumulativeVolume[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM volume_history ORDER BY cycle_start_time DESC LIMIT ?');
      const rows = stmt.all(limit) as VolumeHistoryRow[];

      return rows.map(row => this.rowToVolume(row));
    } catch (err) {
      console.error('Failed to get recent volume history:', (err as Error).message);
      return [];
    }
  }

  /**
   * Convert database row to CumulativeVolume object
   */
  private rowToVolume(row: VolumeHistoryRow): CumulativeVolume {
    return {
      cycleId: row.cycle_id,
      upVolume: row.up_volume,
      downVolume: row.down_volume,
      totalVolume: row.total_volume,
      upShares: row.up_shares,
      downShares: row.down_shares,
      totalShares: row.total_shares,
      lastUpdate: row.last_update,
      cycleStartTime: row.cycle_start_time,
    };
  }

  /**
   * Update volume for a specific side (YES/NO)
   */
  public addVolume(
    volume: CumulativeVolume,
    side: 'YES' | 'NO',
    amount: number,
    shares: number
  ): CumulativeVolume {
    const updated = { ...volume };

    if (side === 'YES') {
      updated.upVolume += amount;
      updated.upShares += shares;
    } else {
      updated.downVolume += amount;
      updated.downShares += shares;
    }

    updated.totalVolume = updated.upVolume + updated.downVolume;
    updated.totalShares = updated.upShares + updated.downShares;
    updated.lastUpdate = Date.now();

    this.save(updated);

    return updated;
  }
}
