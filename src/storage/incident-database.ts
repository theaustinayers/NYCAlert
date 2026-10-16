import Database from 'better-sqlite3';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Agency, Borough } from '../domain/subscriptions.js';
import type { CallType } from '../domain/call-type.js';
import type { AlertCategory, IncidentType, RadioUnitAssignment } from '../domain/triage.js';
import type { LocationPrecision } from '../domain/location.js';
import type { CommunityIncidentNote, DashboardIncident } from '../services/dashboard-store.js';

interface IncidentRow {
  id: string;
  title: string;
  summary: string;
  occurred_at: string;
  updated_at: string;
  agency: Agency;
  agencies_json: string;
  borough: Borough | 'Citywide';
  category: AlertCategory;
  call_type: CallType | null;
  location: string | null;
  incident_type: IncidentType | null;
  latitude: number | null;
  longitude: number | null;
  location_precision: LocationPrecision;
  unit_ids_json: string;
  unit_assignments_json: string;
  box_numbers_json: string;
  confidence: number;
  newsworthiness_score: number;
  buff_interest_score: number;
  assignment_desk_score: number;
  community_selected: number;
  community_source_call_id: string | null;
}

interface IncidentUpdateRow {
  incident_id: string;
  seq: number;
  agency: Agency;
  headline: string | null;
  summary: string;
  occurred_at: string;
  location: string | null;
  previous_location: string | null;
  is_explicit_location_correction: number;
  unit_ids_json: string;
  unit_assignments_json: string;
  box_numbers_json: string;
}

interface CommunityNoteRow {
  id: string;
  incident_id: string;
  username: string;
  audience: 'buff' | 'news';
  author_role: 'owner' | 'admin' | 'moderator' | 'reviewer' | null;
  message: string;
  created_at: string;
}

interface IncidentWriteRow {
  id: string; title: string; summary: string; occurredAt: string; updatedAt: string; agency: Agency; agencies: string;
  borough: Borough | 'Citywide'; category: AlertCategory; callType: CallType | null; location: string | null;
  incidentType: IncidentType | null; latitude: number | null; longitude: number | null; locationPrecision: LocationPrecision;
  unitIds: string; unitAssignments: string; boxNumbers: string; confidence: number; newsworthinessScore: number;
  buffInterestScore: number; assignmentDeskScore: number; communitySelected: number; communitySourceCallId: string | null;
}

const schema = `
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    agency TEXT NOT NULL CHECK (agency IN ('FDNY', 'NYPD')),
    agencies_json TEXT NOT NULL,
    borough TEXT NOT NULL CHECK (borough IN ('Manhattan', 'Bronx', 'Queens', 'Brooklyn', 'Staten Island', 'Citywide')),
    category TEXT NOT NULL,
    call_type TEXT CHECK (call_type IS NULL OR call_type IN ('fire', 'ems', 'pd')),
    location TEXT,
    incident_type TEXT,
    latitude REAL,
    longitude REAL,
    location_precision TEXT NOT NULL,
    unit_ids_json TEXT NOT NULL,
    unit_assignments_json TEXT NOT NULL,
    box_numbers_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    newsworthiness_score INTEGER NOT NULL,
    buff_interest_score INTEGER NOT NULL,
    assignment_desk_score INTEGER NOT NULL,
    community_selected INTEGER NOT NULL DEFAULT 0,
    community_source_call_id TEXT
  );
  CREATE INDEX IF NOT EXISTS incidents_updated_at_idx ON incidents(updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS incidents_occurred_at_idx ON incidents(occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS incidents_borough_updated_idx ON incidents(borough, updated_at DESC);
  CREATE INDEX IF NOT EXISTS incidents_call_type_updated_idx ON incidents(call_type, updated_at DESC);
  CREATE INDEX IF NOT EXISTS incidents_location_idx ON incidents(latitude, longitude, updated_at DESC);
  CREATE TABLE IF NOT EXISTS incident_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    agency TEXT NOT NULL CHECK (agency IN ('FDNY', 'NYPD')),
    headline TEXT,
    summary TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    location TEXT,
    previous_location TEXT,
    is_explicit_location_correction INTEGER NOT NULL DEFAULT 0,
    unit_ids_json TEXT NOT NULL,
    unit_assignments_json TEXT NOT NULL,
    box_numbers_json TEXT NOT NULL,
    UNIQUE (incident_id, seq)
  );
  CREATE INDEX IF NOT EXISTS incident_updates_parent_seq_idx ON incident_updates(incident_id, seq);
  CREATE TABLE IF NOT EXISTS incident_community_notes (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    audience TEXT NOT NULL CHECK (audience IN ('buff', 'news')),
    author_role TEXT CHECK (author_role IS NULL OR author_role IN ('owner', 'admin', 'moderator', 'reviewer')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS incident_community_notes_parent_created_idx ON incident_community_notes(incident_id, created_at);
  CREATE VIRTUAL TABLE IF NOT EXISTS incidents_fts USING fts5(incident_id UNINDEXED, title, summary, location, units, boxes, tokenize='unicode61 remove_diacritics 2');
`;

/** Durable source of truth for published incidents shared by all dashboard views. Live Radio remains ephemeral. */
export class IncidentDatabase {
  private database?: Database.Database;
  private readonly filePath: string;

  constructor(dataDirectory: string) {
    this.filePath = join(dataDirectory, 'nycalert.sqlite');
  }

  async init(): Promise<void> {
    if (this.database) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const database = new Database(this.filePath);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    const version = Number(database.pragma('user_version', { simple: true }));
    if (version > 3) {
      database.close();
      throw new Error(`Incident database schema version ${version} is newer than this application supports.`);
    }
    database.exec(schema);
    if (version === 0) database.pragma('user_version = 3');
    else if (version < 3) {
      database.transaction(() => {
        const columns = database.prepare('PRAGMA table_info(incident_community_notes)').all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === 'author_role')) {
          database.exec("ALTER TABLE incident_community_notes ADD COLUMN author_role TEXT CHECK (author_role IS NULL OR author_role IN ('owner', 'admin', 'moderator', 'reviewer'))");
        }
        database.pragma('user_version = 3');
      })();
    }
    await chmod(dirname(this.filePath), 0o700);
    await chmod(this.filePath, 0o600);
    this.database = database;
  }

  upsert(incident: DashboardIncident): void {
    const db = this.getDatabase();
    const transaction = db.transaction(() => {
      db.prepare(`INSERT INTO incidents (
        id,title,summary,occurred_at,updated_at,agency,agencies_json,borough,category,call_type,location,incident_type,
        latitude,longitude,location_precision,unit_ids_json,unit_assignments_json,box_numbers_json,confidence,
        newsworthiness_score,buff_interest_score,assignment_desk_score,community_selected,community_source_call_id
      ) VALUES (
        @id,@title,@summary,@occurredAt,@updatedAt,@agency,@agencies,@borough,@category,@callType,@location,@incidentType,
        @latitude,@longitude,@locationPrecision,@unitIds,@unitAssignments,@boxNumbers,@confidence,
        @newsworthinessScore,@buffInterestScore,@assignmentDeskScore,@communitySelected,@communitySourceCallId
      ) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, summary=excluded.summary, occurred_at=excluded.occurred_at, updated_at=excluded.updated_at,
        agency=excluded.agency, agencies_json=excluded.agencies_json, borough=excluded.borough, category=excluded.category,
        call_type=excluded.call_type, location=excluded.location, incident_type=excluded.incident_type,
        latitude=excluded.latitude, longitude=excluded.longitude, location_precision=excluded.location_precision,
        unit_ids_json=excluded.unit_ids_json, unit_assignments_json=excluded.unit_assignments_json,
        box_numbers_json=excluded.box_numbers_json, confidence=excluded.confidence,
        newsworthiness_score=excluded.newsworthiness_score, buff_interest_score=excluded.buff_interest_score,
        assignment_desk_score=excluded.assignment_desk_score, community_selected=excluded.community_selected,
        community_source_call_id=excluded.community_source_call_id`).run(toRow(incident));
      db.prepare('DELETE FROM incident_updates WHERE incident_id = ?').run(incident.id);
      const insertUpdate = db.prepare(`INSERT INTO incident_updates (
        incident_id,seq,agency,headline,summary,occurred_at,location,previous_location,
        is_explicit_location_correction,unit_ids_json,unit_assignments_json,box_numbers_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      incident.updates.forEach((update, seq) => insertUpdate.run(
        incident.id, seq, update.agency, update.headline ?? null, update.summary, update.occurredAt,
        update.location ?? null, update.previousLocation ?? null, update.isExplicitLocationCorrection ? 1 : 0,
        JSON.stringify(update.unitIds), JSON.stringify(update.unitAssignments), JSON.stringify(update.boxNumbers)
      ));
      this.refreshSearchIndex(incident);
    });
    transaction();
  }

  get(id: string): DashboardIncident | undefined {
    const row = this.getDatabase().prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRow | undefined;
    return row ? this.hydrate([row])[0] : undefined;
  }

  addCommunityNote(incidentId: string, note: CommunityIncidentNote): void {
    this.getDatabase().prepare(`INSERT INTO incident_community_notes (id, incident_id, username, audience, author_role, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(note.id, incidentId, note.username, note.audience ?? 'news', note.role ?? null, note.message, note.createdAt);
  }

  deleteCommunityNote(incidentId: string, noteId: string): boolean {
    return this.getDatabase().prepare('DELETE FROM incident_community_notes WHERE incident_id = ? AND id = ?').run(incidentId, noteId).changes > 0;
  }

  list(query = '', boroughs?: readonly Borough[], limit = 100_000, offset = 0, callType?: CallType): DashboardIncident[] {
    const db = this.getDatabase();
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (boroughs !== undefined) {
      if (boroughs.length === 0) return [];
      clauses.push(`(borough IN (${boroughs.map(() => '?').join(',')}) OR borough = 'Citywide')`);
      values.push(...boroughs);
    }
    if (callType) { clauses.push('call_type = ?'); values.push(callType); }
    const normalized = query.trim();
    if (normalized) {
      const fts = normalized.replace(/["*:^(){}\[\]\\]/g, ' ').trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
      if (fts) {
        clauses.push('id IN (SELECT incident_id FROM incidents_fts WHERE incidents_fts MATCH ?)');
        values.push(fts);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(100_000, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const rows = db.prepare(`SELECT * FROM incidents ${where} ORDER BY updated_at DESC, occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, safeLimit, safeOffset) as IncidentRow[];
    return this.hydrate(rows);
  }

  count(query = '', boroughs?: readonly Borough[], callType?: CallType): number {
    const db = this.getDatabase();
    const clauses: string[] = [];
    const values: string[] = [];
    if (boroughs !== undefined) {
      if (boroughs.length === 0) return 0;
      clauses.push(`(borough IN (${boroughs.map(() => '?').join(',')}) OR borough = 'Citywide')`);
      values.push(...boroughs);
    }
    if (callType) { clauses.push('call_type = ?'); values.push(callType); }
    const normalized = query.trim();
    if (normalized) {
      const fts = normalized.replace(/["*:^(){}\[\]\\]/g, ' ').trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
      if (fts) { clauses.push('id IN (SELECT incident_id FROM incidents_fts WHERE incidents_fts MATCH ?)'); values.push(fts); }
    }
    return (db.prepare(`SELECT COUNT(*) AS count FROM incidents ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`).get(...values) as { count: number }).count;
  }

  listMap(now: number, windowMs: number, boroughs?: readonly Borough[]): DashboardIncident[] {
    const db = this.getDatabase();
    const values: Array<string | number> = [new Date(now - windowMs).toISOString(), new Date(now).toISOString(), 40.45, 40.95, -74.30, -73.65];
    let boroughFilter = '';
    if (boroughs !== undefined) {
      if (boroughs.length === 0) return [];
      boroughFilter = `AND (borough IN (${boroughs.map(() => '?').join(',')}) OR borough = 'Citywide')`;
      values.push(...boroughs);
    }
    const rows = db.prepare(`SELECT * FROM incidents WHERE updated_at >= ? AND updated_at <= ?
      AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
      AND location_precision IN ('rooftop','street_address','intersection','road_segment') ${boroughFilter}
      ORDER BY updated_at DESC, occurred_at DESC`).all(...values) as IncidentRow[];
    return this.hydrate(rows);
  }

  findCommunityPromotion(sourceCallId: string): DashboardIncident | undefined {
    const row = this.getDatabase().prepare('SELECT * FROM incidents WHERE community_source_call_id = ? LIMIT 1').get(sourceCallId) as IncidentRow | undefined;
    return row ? this.hydrate([row])[0] : undefined;
  }

  delete(id: string): boolean {
    const db = this.getDatabase();
    const remove = db.transaction(() => {
      const changed = db.prepare('DELETE FROM incidents WHERE id = ?').run(id).changes > 0;
      if (changed) db.prepare('DELETE FROM incidents_fts WHERE incident_id = ?').run(id);
      return changed;
    });
    return remove();
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private hydrate(rows: IncidentRow[]): DashboardIncident[] {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const updatesByIncident = new Map<string, DashboardIncident['updates']>();
    const communityNotesByIncident = new Map<string, CommunityIncidentNote[]>();
    for (let start = 0; start < ids.length; start += 400) {
      const batch = ids.slice(start, start + 400);
      const placeholders = batch.map(() => '?').join(',');
      const updateRows = this.getDatabase().prepare(`SELECT * FROM incident_updates WHERE incident_id IN (${placeholders}) ORDER BY incident_id, seq`).all(...batch) as IncidentUpdateRow[];
      for (const update of updateRows) {
        const updates = updatesByIncident.get(update.incident_id) ?? [];
        updates.push({
          agency: update.agency,
          ...(update.headline ? { headline: update.headline } : {}),
          summary: update.summary,
          occurredAt: update.occurred_at,
          unitIds: parseJson<string[]>(update.unit_ids_json, []),
          unitAssignments: parseJson<RadioUnitAssignment[]>(update.unit_assignments_json, []),
          boxNumbers: parseJson<string[]>(update.box_numbers_json, []),
          ...(update.location ? { location: update.location } : {}),
          ...(update.previous_location ? { previousLocation: update.previous_location } : {}),
          ...(update.is_explicit_location_correction ? { isExplicitLocationCorrection: true } : {})
        });
        updatesByIncident.set(update.incident_id, updates);
      }
      const communityNotes = this.getDatabase().prepare(`SELECT * FROM incident_community_notes WHERE incident_id IN (${placeholders}) ORDER BY incident_id, created_at, id`).all(...batch) as CommunityNoteRow[];
      for (const note of communityNotes) {
        const notes = communityNotesByIncident.get(note.incident_id) ?? [];
        notes.push({
          id: note.id,
          username: note.username,
          ...(note.author_role ? { role: note.author_role } : { audience: note.audience }),
          message: note.message,
          createdAt: note.created_at
        });
        communityNotesByIncident.set(note.incident_id, notes);
      }
    }
    return rows.map((row) => {
      const updates = updatesByIncident.get(row.id) ?? [];
      return {
        id: row.id,
        title: row.title,
        summary: row.summary,
        occurredAt: row.occurred_at,
        updatedAt: row.updated_at,
        agency: row.agency,
        agencies: parseJson<Agency[]>(row.agencies_json, [row.agency]),
        borough: row.borough,
        category: row.category,
        ...(row.call_type ? { callType: row.call_type } : {}),
        ...(row.location ? { location: row.location } : {}),
        ...(row.incident_type ? { incidentType: row.incident_type } : {}),
        ...(typeof row.latitude === 'number' ? { latitude: row.latitude } : {}),
        ...(typeof row.longitude === 'number' ? { longitude: row.longitude } : {}),
        locationPrecision: row.location_precision,
        unitIds: parseJson<string[]>(row.unit_ids_json, []),
        unitAssignments: parseJson<RadioUnitAssignment[]>(row.unit_assignments_json, []),
        boxNumbers: parseJson<string[]>(row.box_numbers_json, []),
        updateCount: updates.length,
        updates,
        communityNotes: communityNotesByIncident.get(row.id) ?? [],
        confidence: row.confidence,
        newsworthinessScore: row.newsworthiness_score,
        buffInterestScore: row.buff_interest_score,
        assignmentDeskScore: row.assignment_desk_score,
        hasAudio: false,
        ...(row.community_selected ? { communitySelected: true } : {}),
        ...(row.community_source_call_id ? { communitySourceCallId: row.community_source_call_id } : {})
      };
    });
  }

  private refreshSearchIndex(incident: DashboardIncident): void {
    const db = this.getDatabase();
    db.prepare('DELETE FROM incidents_fts WHERE incident_id = ?').run(incident.id);
    const updateText = incident.updates.map((update) => `${update.summary} ${update.unitIds.join(' ')} ${update.boxNumbers.join(' ')}`).join(' ');
    db.prepare('INSERT INTO incidents_fts (incident_id,title,summary,location,units,boxes) VALUES (?,?,?,?,?,?)').run(
      incident.id,
      incident.title,
      `${incident.summary} ${updateText} ${incident.agencies.join(' ')} ${incident.borough} ${incident.category} ${incident.callType ?? ''} ${incident.incidentType ?? ''}`,
      incident.location ?? '',
      incident.unitIds.join(' '),
      incident.boxNumbers.join(' ')
    );
  }

  private getDatabase(): Database.Database {
    if (!this.database) throw new Error('IncidentDatabase has not been initialized.');
    return this.database;
  }
}

function toRow(incident: DashboardIncident): IncidentWriteRow {
  return {
    id: incident.id,
    title: incident.title,
    summary: incident.summary,
    occurredAt: incident.occurredAt,
    updatedAt: incident.updatedAt,
    agency: incident.agency,
    agencies: JSON.stringify(incident.agencies),
    borough: incident.borough,
    category: incident.category,
    callType: incident.callType ?? null,
    location: incident.location ?? null,
    incidentType: incident.incidentType ?? null,
    latitude: incident.latitude ?? null,
    longitude: incident.longitude ?? null,
    locationPrecision: incident.locationPrecision,
    unitIds: JSON.stringify(incident.unitIds),
    unitAssignments: JSON.stringify(incident.unitAssignments),
    boxNumbers: JSON.stringify(incident.boxNumbers),
    confidence: incident.confidence,
    newsworthinessScore: incident.newsworthinessScore,
    buffInterestScore: incident.buffInterestScore,
    assignmentDeskScore: incident.assignmentDeskScore,
    communitySelected: incident.communitySelected ? 1 : 0,
    communitySourceCallId: incident.communitySourceCallId ?? null
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
