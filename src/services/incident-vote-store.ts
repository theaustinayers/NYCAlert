import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DashboardIncident, DashboardLiveCall } from './dashboard-store.js';

export type IncidentVote = 'up' | 'down';

export interface IncidentVoteSummary {
  up: number;
  down: number;
  myVote: IncidentVote | null;
}

export interface CastIncidentVoteResult extends IncidentVoteSummary {
  accepted: boolean;
}

/** Durable feedback store. Raw browser device IDs are hashed and never persisted. */
export class IncidentVoteStore {
  private database?: Database.Database;

  constructor(private readonly dataDirectory: string) {}

  async init(): Promise<void> {
    if (this.database) return;
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.dataDirectory, 0o700);
    const database = new Database(join(this.dataDirectory, 'incident-votes.sqlite'));
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.exec(`
      CREATE TABLE IF NOT EXISTS incident_votes (
        incident_id TEXT NOT NULL,
        device_hash TEXT NOT NULL,
        vote TEXT NOT NULL CHECK (vote IN ('up', 'down')),
        voted_at TEXT NOT NULL,
        agency TEXT NOT NULL,
        borough TEXT NOT NULL,
        incident_type TEXT,
        category TEXT NOT NULL,
        public_score INTEGER NOT NULL,
        buff_score INTEGER NOT NULL,
        news_score INTEGER NOT NULL,
        PRIMARY KEY (incident_id, device_hash)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS incident_votes_incident_id ON incident_votes(incident_id);
    `);
    await chmod(join(this.dataDirectory, 'incident-votes.sqlite'), 0o600);
    this.database = database;
  }

  getSummary(incidentId: string, deviceId?: string): IncidentVoteSummary {
    const database = this.getDatabase();
    const rows = database.prepare(`
      SELECT vote, COUNT(*) AS count FROM incident_votes WHERE incident_id = ? GROUP BY vote
    `).all(incidentId) as Array<{ vote: IncidentVote; count: number }>;
    const totals = { up: 0, down: 0 };
    for (const row of rows) totals[row.vote] = Number(row.count) || 0;
    const myVote = deviceId
      ? (database.prepare('SELECT vote FROM incident_votes WHERE incident_id = ? AND device_hash = ?')
        .get(incidentId, hashDeviceId(deviceId)) as { vote: IncidentVote } | undefined)?.vote ?? null
      : null;
    return { ...totals, myVote };
  }

  castVote(incident: DashboardIncident, deviceId: string, vote: IncidentVote): CastIncidentVoteResult {
    const database = this.getDatabase();
    const result = database.prepare(`
      INSERT OR IGNORE INTO incident_votes
        (incident_id, device_hash, vote, voted_at, agency, borough, incident_type, category, public_score, buff_score, news_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      incident.id,
      hashDeviceId(deviceId),
      vote,
      new Date().toISOString(),
      incident.agency,
      incident.borough,
      incident.incidentType ?? null,
      incident.category,
      incident.newsworthinessScore,
      incident.buffInterestScore,
      incident.assignmentDeskScore
    );
    return { ...this.getSummary(incident.id, deviceId), accepted: result.changes === 1 };
  }

  getLiveCallSummary(liveCallId: string, deviceId?: string): IncidentVoteSummary {
    return this.getSummary(`live-call:${liveCallId}`, deviceId);
  }

  castLiveCallVote(call: DashboardLiveCall, deviceId: string, vote: IncidentVote): CastIncidentVoteResult {
    const database = this.getDatabase();
    const liveVoteId = `live-call:${call.id}`;
    const result = database.prepare(`
      INSERT OR IGNORE INTO incident_votes
        (incident_id, device_hash, vote, voted_at, agency, borough, incident_type, category, public_score, buff_score, news_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      liveVoteId,
      hashDeviceId(deviceId),
      vote,
      new Date().toISOString(),
      call.agency,
      call.borough,
      call.incidentType ?? null,
      call.category,
      call.newsworthinessScore,
      call.buffInterestScore,
      call.assignmentDeskScore
    );
    return { ...this.getSummary(liveVoteId, deviceId), accepted: result.changes === 1 };
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private getDatabase(): Database.Database {
    if (!this.database) throw new Error('Incident vote store has not been initialized.');
    return this.database;
  }
}

function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

export function isIncidentVote(value: unknown): value is IncidentVote {
  return value === 'up' || value === 'down';
}
