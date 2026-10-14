import Database from 'better-sqlite3';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Agency } from '../domain/subscriptions.js';

/** Durable, single-process idempotency gate for source-call deliveries. */
export class SourceCallLedger {
  private database?: Database.Database;
  private readonly staleProcessingMs = 60 * 60 * 1000;

  constructor(private readonly dataDirectory: string) {}

  async init(): Promise<void> {
    if (this.database) return;
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.dataDirectory, 0o700);
    const database = new Database(join(this.dataDirectory, 'source-call-ledger.sqlite'));
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.exec(`
      CREATE TABLE IF NOT EXISTS source_calls (
        agency TEXT NOT NULL CHECK (agency IN ('FDNY', 'NYPD')),
        call_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('processing', 'complete')),
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY (agency, call_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS source_calls_claimed_at ON source_calls(claimed_at);
    `);
    await chmod(join(this.dataDirectory, 'source-call-ledger.sqlite'), 0o600);
    this.database = database;
  }

  /** Atomically claim a source call before side effects; duplicate or in-progress keys return false. */
  claim(agency: Agency, callId: string): boolean {
    const database = this.getDatabase();
    const claim = database.transaction(() => {
      const now = Date.now();
      database.prepare(`
        DELETE FROM source_calls WHERE state = 'processing' AND claimed_at < ?
      `).run(now - this.staleProcessingMs);
      const result = database.prepare(`
        INSERT OR IGNORE INTO source_calls (agency, call_id, state, claimed_at)
        VALUES (?, ?, 'processing', ?)
      `).run(agency, callId, now);
      return result.changes === 1;
    });
    return claim.immediate();
  }

  complete(agency: Agency, callId: string): void {
    this.getDatabase().prepare(`
      UPDATE source_calls SET state = 'complete', claimed_at = ?
      WHERE agency = ? AND call_id = ? AND state = 'processing'
    `).run(Date.now(), agency, callId);
  }

  /** Release only failed/retryable attempts; completed keys cannot be reopened accidentally. */
  release(agency: Agency, callId: string): void {
    this.getDatabase().prepare(`
      DELETE FROM source_calls WHERE agency = ? AND call_id = ? AND state = 'processing'
    `).run(agency, callId);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private getDatabase(): Database.Database {
    if (!this.database) throw new Error('Source call ledger has not been initialized.');
    return this.database;
  }
}
