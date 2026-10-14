import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import type { Agency, Borough } from '../domain/subscriptions.js';
import { canShowMapMarker, type LocationPrecision } from '../domain/location.js';
import { isGenericIncidentHeadline, normalizeIncidentHeadline, type AlertCategory, type IncidentType, type RadioUnitAssignment } from '../domain/triage.js';
import type { BroadcastifyFeedStatus } from '../providers/broadcastify.js';

export interface DashboardIncidentInput {
  title: string;
  headline?: string;
  summary: string;
  occurredAt: Date;
  agency: Agency;
  borough: Borough | 'Citywide';
  category: AlertCategory;
  location?: string;
  incidentType?: IncidentType;
  latitude?: number;
  longitude?: number;
  locationPrecision?: LocationPrecision;
  unitIds?: string[];
  unitAssignments?: RadioUnitAssignment[];
  boxNumbers?: string[];
  confidence: number;
  newsworthinessScore: number;
  buffInterestScore?: number;
  assignmentDeskScore?: number;
  audioPath?: string;
  audioContentType?: string;
}

export interface DashboardIncident {
  id: string;
  title: string;
  summary: string;
  occurredAt: string;
  updatedAt: string;
  agency: Agency;
  borough: Borough | 'Citywide';
  category: AlertCategory;
  location?: string;
  incidentType?: IncidentType;
  latitude?: number;
  longitude?: number;
  locationPrecision: LocationPrecision;
  unitIds: string[];
  unitAssignments: RadioUnitAssignment[];
  boxNumbers: string[];
  updateCount: number;
  updates: Array<{ headline?: string; summary: string; occurredAt: string; unitIds: string[]; unitAssignments: RadioUnitAssignment[]; boxNumbers: string[] }>;
  confidence: number;
  newsworthinessScore: number;
  buffInterestScore: number;
  assignmentDeskScore: number;
  hasAudio: boolean;
}

export interface DashboardIncidentUpdateInput {
  title?: string;
  headline?: string;
  summary: string;
  occurredAt: Date;
  location?: string;
  incidentType?: IncidentType;
  latitude?: number;
  longitude?: number;
  locationPrecision?: LocationPrecision;
  unitIds: string[];
  unitAssignments?: RadioUnitAssignment[];
  boxNumbers?: string[];
  confidence: number;
  newsworthinessScore: number;
  buffInterestScore?: number;
  assignmentDeskScore?: number;
  category: AlertCategory | 'routine';
  audioPath?: string;
  audioContentType?: string;
}

export interface DashboardLiveCallInput {
  sourceId: string;
  groupName?: string;
  occurredAt: Date;
  agency: Agency;
  borough: Borough | 'Citywide';
  transcript: string;
  category: AlertCategory | 'routine';
  location?: string;
  summary: string;
  confidence: number;
  newsworthinessScore: number;
  buffInterestScore?: number;
  assignmentDeskScore?: number;
  unitAssignments?: RadioUnitAssignment[];
  boxNumbers?: string[];
  audioPath?: string;
  audioContentType?: string;
}

export interface DashboardLiveCall {
  id: string;
  sourceId: string;
  groupName?: string;
  occurredAt: string;
  agency: Agency;
  borough: Borough | 'Citywide';
  transcript?: string;
  category: AlertCategory | 'routine';
  location?: string;
  summary: string;
  confidence: number;
  newsworthinessScore: number;
  buffInterestScore: number;
  assignmentDeskScore: number;
  unitAssignments: RadioUnitAssignment[];
  boxNumbers: string[];
  hasAudio: boolean;
}

export interface PipelineDiagnostics {
  state: 'disabled' | 'starting' | 'polling' | 'processing' | 'error';
  stage: string;
  startedAt?: string;
  lastPollAt?: string;
  lastCallAt?: string;
  callsProcessed: number;
  callsRetried: number;
  callsFailed: number;
  lastError?: string;
}

export class DashboardStore {
  private readonly incidents: DashboardIncident[] = [];
  private readonly liveCalls: DashboardLiveCall[] = [];
  private readonly audioFiles = new Map<string, { path: string; contentType: string }>();
  private readonly liveCallAudioFiles = new Map<string, { path: string; contentType: string }>();
  private feedStatusProvider?: () => BroadcastifyFeedStatus[];
  private readonly incidentChangeListeners = new Set<() => void>();
  private readonly pipelineDiagnostics = new Map<string, PipelineDiagnostics>([['calls-api', {
    state: 'disabled', stage: 'Not configured', callsProcessed: 0, callsRetried: 0, callsFailed: 0
  }]]);

  constructor(
    private readonly allowPublicAudio: boolean,
    private readonly maxIncidents = 300,
    private readonly allowPublicTranscripts = false,
    private readonly maxLiveCalls = 100
  ) {}

  setFeedStatusProvider(provider: () => BroadcastifyFeedStatus[]): void {
    this.feedStatusProvider = provider;
  }

  getFeedStatuses(): BroadcastifyFeedStatus[] {
    return this.feedStatusProvider?.() ?? [];
  }

  setPipelineDiagnostics(diagnostics: PipelineDiagnostics, pipeline = 'calls-api'): void {
    this.pipelineDiagnostics.set(pipeline, { ...diagnostics });
  }

  getPipelineDiagnostics(): Record<string, PipelineDiagnostics> {
    return Object.fromEntries([...this.pipelineDiagnostics].map(([name, value]) => [name, { ...value }]));
  }

  onIncidentChange(listener: () => void): () => void {
    this.incidentChangeListeners.add(listener);
    return () => this.incidentChangeListeners.delete(listener);
  }

  async recordLiveCall(input: DashboardLiveCallInput): Promise<DashboardLiveCall> {
    const id = randomUUID();
    const record: DashboardLiveCall = {
      id,
      sourceId: input.sourceId.slice(0, 160),
      ...(input.groupName ? { groupName: input.groupName.slice(0, 120) } : {}),
      occurredAt: input.occurredAt.toISOString(),
      agency: input.agency,
      borough: input.borough,
      ...(this.allowPublicTranscripts && input.location ? { location: input.location.slice(0, 180) } : {}),
      ...(this.allowPublicTranscripts ? { transcript: input.transcript.slice(0, 4_000) } : {}),
      category: input.category,
      summary: this.allowPublicTranscripts ? input.summary.slice(0, 700) : 'Transcript and call summary display is disabled.',
      confidence: Math.max(0, Math.min(1, input.confidence)),
      newsworthinessScore: Math.max(1, Math.min(5, Math.round(input.newsworthinessScore))),
      buffInterestScore: Math.max(1, Math.min(5, Math.round(input.buffInterestScore ?? input.newsworthinessScore))),
      assignmentDeskScore: Math.max(1, Math.min(5, Math.round(input.assignmentDeskScore ?? input.newsworthinessScore))),
      unitAssignments: normalizeUnitAssignments(input.unitAssignments ?? []),
      boxNumbers: normalizeBoxNumbers(input.boxNumbers ?? []),
      hasAudio: false
    };
    this.liveCalls.unshift(record);
    while (this.liveCalls.length > this.maxLiveCalls) {
      const removed = this.liveCalls.pop();
      if (removed) {
        this.liveCallAudioFiles.delete(removed.id);
      }
    }
    return record;
  }

  listLiveCalls(query = '', boroughs?: readonly Borough[]): DashboardLiveCall[] {
    const normalized = query.trim().toLowerCase();
    return this.liveCalls.filter((call) => boroughMatches(call.borough, boroughs) && (!normalized ||
      `${call.sourceId} ${call.transcript ?? ''} ${call.summary} ${call.agency} ${call.borough} ${call.category}`.toLowerCase().includes(normalized)));
  }

  getLiveCallAudio(callId: string): { path: string; contentType: string } | undefined {
    return this.liveCallAudioFiles.get(callId);
  }

  async publish(input: DashboardIncidentInput): Promise<DashboardIncident> {
    const id = randomUUID();
    let hasAudio = false;
    if (this.allowPublicAudio && input.agency === 'FDNY' && input.audioPath) {
      try {
        const fileInfo = await stat(input.audioPath);
        hasAudio = fileInfo.isFile();
        if (hasAudio) this.audioFiles.set(id, { path: input.audioPath, contentType: input.audioContentType ?? 'audio/mpeg' });
      } catch {
        hasAudio = false;
      }
    }

    const incident: DashboardIncident = {
      id,
      title: formatIncidentTitle(input.headline, input.location, input.agency, input.borough, input.category),
      summary: input.summary.slice(0, 700),
      occurredAt: input.occurredAt.toISOString(),
      updatedAt: input.occurredAt.toISOString(),
      agency: input.agency,
      borough: input.borough,
      ...(input.location ? { location: input.location.slice(0, 180) } : {}),
      ...(input.incidentType ? { incidentType: input.incidentType } : {}),
      ...(isValidCoordinates(input.latitude, input.longitude) && canShowMapMarker(input.locationPrecision)
        ? { latitude: input.latitude, longitude: input.longitude }
        : {}),
      locationPrecision: input.locationPrecision ?? 'unresolved',
      unitIds: [...new Set(input.unitIds ?? [])].slice(0, 12),
      unitAssignments: normalizeUnitAssignments(input.unitAssignments ?? []),
      boxNumbers: normalizeBoxNumbers(input.boxNumbers ?? []),
      updateCount: 0,
      updates: [],
      category: input.category,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      newsworthinessScore: Math.max(1, Math.min(5, Math.round(input.newsworthinessScore))),
      buffInterestScore: Math.max(1, Math.min(5, Math.round(input.buffInterestScore ?? input.newsworthinessScore))),
      assignmentDeskScore: Math.max(1, Math.min(5, Math.round(input.assignmentDeskScore ?? input.newsworthinessScore))),
      hasAudio
    };
    this.incidents.unshift(incident);
    while (this.incidents.length > this.maxIncidents) {
      const removed = this.incidents.pop();
      if (removed) {
        const audio = this.audioFiles.get(removed.id);
        this.audioFiles.delete(removed.id);
        if (audio) await this.releaseAudio(audio.path);
      }
    }
    this.notifyIncidentChange();
    return incident;
  }

  async updateIncident(incidentId: string, input: DashboardIncidentUpdateInput): Promise<DashboardIncident | undefined> {
    const index = this.incidents.findIndex((incident) => incident.id === incidentId);
    if (index < 0) return undefined;
    const current = this.incidents[index]!;
    let hasAudio = current.hasAudio;
    if (!hasAudio && this.allowPublicAudio && current.agency === 'FDNY' && input.audioPath) {
      try {
        hasAudio = (await stat(input.audioPath)).isFile();
        if (hasAudio) this.audioFiles.set(current.id, { path: input.audioPath, contentType: input.audioContentType ?? 'audio/mpeg' });
      } catch {
        hasAudio = false;
      }
    }
    const nextCategory = input.category !== 'routine' && priority(input.category) > priority(current.category)
      ? input.category
      : current.category;
    const oldHeadline = current.title.split(' | ')[0] ?? '';
    const incomingHeadline = normalizeIncidentHeadline(input.headline, input.category);
    const oldHeadlineIsMoreDescriptive = !isGenericIncidentHeadline(oldHeadline)
      && oldHeadline.split(/\s+/).length > incomingHeadline.split(/\s+/).length;
    const preserveExistingIncidentHeadline = input.category === 'routine' && !isGenericIncidentHeadline(oldHeadline);
    const headline = (preserveExistingIncidentHeadline || !input.headline || isGenericIncidentHeadline(input.headline) || oldHeadlineIsMoreDescriptive)
      ? oldHeadline
      : incomingHeadline;
    const hasMapMarker = isValidCoordinates(input.latitude, input.longitude) && canShowMapMarker(input.locationPrecision);
    const locationChanged = input.location !== undefined && input.location !== current.location;
    const updated: DashboardIncident = {
      ...current,
      title: formatIncidentTitle(
        headline,
        input.location ?? current.location,
        current.agency,
        current.borough,
        nextCategory
      ),
      updatedAt: input.occurredAt.toISOString(),
      ...(input.location ? { location: input.location.slice(0, 180) } : {}),
      ...(input.incidentType && input.incidentType !== 'other' ? { incidentType: input.incidentType } : {}),
      ...(hasMapMarker ? { latitude: input.latitude, longitude: input.longitude } : locationChanged ? { latitude: undefined, longitude: undefined } : {}),
      locationPrecision: hasMapMarker ? input.locationPrecision! : locationChanged ? input.locationPrecision ?? 'unresolved' : current.locationPrecision,
      unitIds: [...new Set([...current.unitIds, ...input.unitIds])].slice(0, 12),
      unitAssignments: normalizeUnitAssignments([...current.unitAssignments, ...(input.unitAssignments ?? [])]),
      boxNumbers: normalizeBoxNumbers([...current.boxNumbers, ...(input.boxNumbers ?? [])]),
      updateCount: current.updateCount + 1,
      updates: [...current.updates, {
        ...(input.headline && !isGenericIncidentHeadline(input.headline) ? { headline: normalizeIncidentHeadline(input.headline, input.category) } : {}),
        summary: input.summary.slice(0, 700),
        occurredAt: input.occurredAt.toISOString(),
        unitIds: [...new Set(input.unitIds)].slice(0, 12),
        unitAssignments: normalizeUnitAssignments(input.unitAssignments ?? []),
        boxNumbers: normalizeBoxNumbers(input.boxNumbers ?? [])
      }].slice(-12),
      category: nextCategory,
      confidence: Math.max(current.confidence, Math.max(0, Math.min(1, input.confidence))),
      newsworthinessScore: Math.max(current.newsworthinessScore, Math.max(1, Math.min(5, Math.round(input.newsworthinessScore)))),
      buffInterestScore: Math.max(current.buffInterestScore, Math.max(1, Math.min(5, Math.round(input.buffInterestScore ?? input.newsworthinessScore)))),
      assignmentDeskScore: Math.max(current.assignmentDeskScore, Math.max(1, Math.min(5, Math.round(input.assignmentDeskScore ?? input.newsworthinessScore)))),
      hasAudio
    };
    this.incidents[index] = updated;
    this.notifyIncidentChange();
    return updated;
  }

  search(query = '', boroughs?: readonly Borough[]): DashboardIncident[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.incidents.filter((incident) => boroughMatches(incident.borough, boroughs));
    return this.incidents.filter((incident) => boroughMatches(incident.borough, boroughs) &&
      stripActingAsTarget(`${incident.title} ${incident.summary} ${incident.updates.map((update) => `${update.summary} ${update.unitIds.join(' ')} ${update.boxNumbers.join(' ')}`).join(' ')} ${incident.unitIds.join(' ')} ${incident.boxNumbers.join(' ')} ${incident.agency} ${incident.borough} ${incident.category}`).toLowerCase().includes(normalized)
    );
  }

  getIncident(incidentId: string): DashboardIncident | undefined {
    return this.incidents.find((incident) => incident.id === incidentId);
  }

  async adminEditIncident(incidentId: string, input: { headline: string; summary: string; location?: string }): Promise<DashboardIncident | undefined> {
    const index = this.incidents.findIndex((incident) => incident.id === incidentId);
    if (index < 0) return undefined;
    const current = this.incidents[index]!;
    const headline = normalizeIncidentHeadline(input.headline, current.category);
    const summary = input.summary.trim().slice(0, 700);
    const location = input.location?.trim().slice(0, 180) || undefined;
    if (!headline || !summary) throw new Error('Incident headline and summary are required.');
    const locationChanged = location !== current.location;
    const updated: DashboardIncident = {
      ...current,
      title: formatIncidentTitle(headline, location, current.agency, current.borough, current.category),
      summary,
      updatedAt: new Date().toISOString(),
      ...(location ? { location } : { location: undefined }),
      ...(locationChanged ? { latitude: undefined, longitude: undefined, locationPrecision: 'unresolved' } : {})
    };
    this.incidents[index] = updated;
    this.notifyIncidentChange();
    return updated;
  }

  async deleteIncident(incidentId: string): Promise<boolean> {
    const index = this.incidents.findIndex((incident) => incident.id === incidentId);
    if (index < 0) return false;
    this.incidents.splice(index, 1);
    const audio = this.audioFiles.get(incidentId);
    this.audioFiles.delete(incidentId);
    if (audio) await this.releaseAudio(audio.path);
    this.notifyIncidentChange();
    return true;
  }

  listMapIncidents(now = Date.now(), windowMs = 30 * 60 * 1000, boroughs?: readonly Borough[]): DashboardIncident[] {
    return this.incidents.filter((incident) => {
      const lastActivityAt = Date.parse(incident.updatedAt || incident.occurredAt);
      return boroughMatches(incident.borough, boroughs)
        && Number.isFinite(lastActivityAt) && lastActivityAt <= now && now - lastActivityAt <= windowMs;
    }).filter((incident) => isValidCoordinates(incident.latitude, incident.longitude) && canShowMapMarker(incident.locationPrecision));
  }

  getAudio(incidentId: string): { path: string; contentType: string } | undefined {
    return this.audioFiles.get(incidentId);
  }

  private async releaseAudio(path: string): Promise<void> {
    if (![...this.audioFiles.values(), ...this.liveCallAudioFiles.values()].some((audio) => audio.path === path)) {
      await rm(path, { force: true });
    }
  }

  private notifyIncidentChange(): void {
    for (const listener of this.incidentChangeListeners) listener();
  }
}

function isValidCoordinates(latitude?: number, longitude?: number): boolean {
  return typeof latitude === 'number' && Number.isFinite(latitude)
    && typeof longitude === 'number' && Number.isFinite(longitude)
    && latitude >= 40.45 && latitude <= 40.95
    && longitude >= -74.30 && longitude <= -73.65;
}

function formatIncidentTitle(
  headline: string | undefined,
  location: string | undefined,
  agency: Agency,
  borough: Borough | 'Citywide',
  category: AlertCategory | 'routine'
): string {
  const safeHeadline = normalizeIncidentHeadline(headline, category);
  const safeLocation = location?.trim() || 'Location Unconfirmed';
  return `${safeHeadline} | ${safeLocation} | ${agency} | ${borough}`.slice(0, 256);
}

function priority(category: AlertCategory): number {
  return category === 'breaking' ? 4 : category === 'newsworthy' ? 3 : category === 'weird_unique' ? 2 : 1;
}

function boroughMatches(value: Borough | 'Citywide', selected?: readonly Borough[]): boolean {
  if (selected === undefined) return true;
  if (selected.length === 0) return false;
  return value === 'Citywide' || selected.includes(value);
}

function normalizeUnitAssignments(assignments: readonly RadioUnitAssignment[]): RadioUnitAssignment[] {
  const unique = new Map<string, RadioUnitAssignment>();
  for (const assignment of assignments) {
    const unitId = assignment.unitId.trim().toUpperCase().replace(/\s+/g, ' ');
    const actingAsUnitId = assignment.actingAsUnitId?.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!unitId) continue;
    unique.set(`${unitId}|${actingAsUnitId ?? ''}`, {
      unitId,
      ...(actingAsUnitId ? { actingAsUnitId } : {})
    });
  }
  return [...unique.values()].slice(-24);
}

function stripActingAsTarget(text: string): string {
  return text.replace(/\b((?:engine|eng|e|ladder|truck|t|rescue|r|squad|sq|battalion|bc|chief|marine|hazmat|tower)\s*[-#]?\s*\d{1,3}[a-z]?)\s+(?:is\s+)?acting\s+as\s+(?:engine|eng|e|ladder|truck|t|rescue|r|squad|sq|battalion|bc|chief|marine|hazmat|tower)\s*[-#]?\s*\d{1,3}[a-z]?\b/gi, '$1');
}

function normalizeBoxNumbers(boxNumbers: readonly string[]): string[] {
  return [...new Set(boxNumbers.map((box) => box.trim().toUpperCase().replace(/^BOX\s*/, '').replace(/\D/g, '')).filter((box) => /^\d{3,5}$/.test(box)).map((box) => `BOX ${box}`))].slice(0, 4);
}