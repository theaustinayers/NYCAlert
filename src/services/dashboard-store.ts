import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import type { Agency, Borough } from '../domain/subscriptions.js';
import { deriveCallType, type CallType } from '../domain/call-type.js';
import { canShowMapMarker, type LocationPrecision } from '../domain/location.js';
import { isGenericIncidentHeadline, normalizeIncidentHeadline, type AlertCategory, type IncidentType, type RadioUnitAssignment } from '../domain/triage.js';
import type { BroadcastifyFeedStatus } from '../providers/broadcastify.js';
import type { IncidentDatabase } from '../storage/incident-database.js';

export interface DashboardIncidentInput {
  title: string;
  headline?: string;
  summary: string;
  occurredAt: Date;
  agency: Agency;
  borough: Borough | 'Citywide';
  category: AlertCategory;
  callType?: CallType;
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
  communitySelected?: boolean;
  communitySourceCallId?: string;
}

export interface CommunityIncidentNote {
  id: string;
  username: string;
  audience: 'buff' | 'news';
  message: string;
  createdAt: string;
}

export interface DashboardIncident {
  id: string;
  title: string;
  summary: string;
  occurredAt: string;
  updatedAt: string;
  agency: Agency;
  agencies: Agency[];
  borough: Borough | 'Citywide';
  category: AlertCategory;
  callType?: CallType;
  location?: string;
  incidentType?: IncidentType;
  latitude?: number;
  longitude?: number;
  locationPrecision: LocationPrecision;
  unitIds: string[];
  unitAssignments: RadioUnitAssignment[];
  boxNumbers: string[];
  updateCount: number;
  updates: Array<{ agency: Agency; headline?: string; summary: string; occurredAt: string; unitIds: string[]; unitAssignments: RadioUnitAssignment[]; boxNumbers: string[]; location?: string; previousLocation?: string; isExplicitLocationCorrection?: boolean }>;
  communityNotes?: CommunityIncidentNote[];
  confidence: number;
  newsworthinessScore: number;
  buffInterestScore: number;
  assignmentDeskScore: number;
  hasAudio: boolean;
  communitySelected?: boolean;
  communitySourceCallId?: string;
}

export interface DashboardIncidentUpdateInput {
  title?: string;
  headline?: string;
  summary: string;
  occurredAt: Date;
  agency?: Agency;
  location?: string;
  isExplicitLocationCorrection?: boolean;
  /** Superseded report when a corrected located call absorbs an earlier pending report. */
  previousLocation?: string;
  callType?: CallType;
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
  headline?: string;
  category: AlertCategory | 'routine';
  callType?: CallType;
  incidentType?: IncidentType;
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
  headline?: string;
  category: AlertCategory | 'routine';
  callType?: CallType;
  incidentType?: IncidentType;
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
  private readonly liveCallChangeListeners = new Set<() => void>();
  private readonly communityIncidentNotes = new Map<string, CommunityIncidentNote[]>();
  private readonly feedStatusChangeListeners = new Set<() => void>();
  private readonly feedAlerts = new Map<string, { severity: 'newsworthy' | 'breaking'; until: number }>();
  private readonly feedCallActivity = new Map<string, number[]>();
  private readonly pipelineDiagnostics = new Map<string, PipelineDiagnostics>([['calls-api', {
    state: 'disabled', stage: 'Not configured', callsProcessed: 0, callsRetried: 0, callsFailed: 0
  }]]);

  constructor(
    private readonly allowPublicAudio: boolean,
    private readonly maxIncidents = 300,
    private readonly allowPublicTranscripts = false,
    private readonly maxLiveCalls = 100,
    private readonly incidentDatabase?: IncidentDatabase
  ) {}

  async init(): Promise<void> {
    await this.incidentDatabase?.init();
  }

  close(): void {
    this.incidentDatabase?.close();
  }

  setFeedStatusProvider(provider: () => BroadcastifyFeedStatus[]): void {
    this.feedStatusProvider = provider;
  }

  getFeedStatuses(): BroadcastifyFeedStatus[] {
    const now = Date.now();
    const statuses = this.feedStatusProvider?.() ?? [];
    return statuses.map((status) => {
      const key = feedKey(status.agency, status.borough);
      const alert = this.feedAlerts.get(key);
      if (alert && alert.until <= now) this.feedAlerts.delete(key);
      const activeAlert = alert && alert.until > now ? alert : undefined;
      const activity = (this.feedCallActivity.get(key) ?? []).filter((timestamp) => timestamp > now - 5 * 60_000);
      if (activity.length) this.feedCallActivity.set(key, activity);
      else this.feedCallActivity.delete(key);
      const buckets = Array.from({ length: 40 }, (_, index) => {
        const start = now - (39 - index) * 7_500;
        return activity.filter((timestamp) => timestamp >= start && timestamp < start + 7_500).length;
      });
      const maxBucket = Math.max(1, ...buckets);
      const mostRecentCallAt = activity.at(-1);
      return {
        ...status,
        ...(activeAlert ? { alertSeverity: activeAlert.severity, alertUntil: new Date(activeAlert.until).toISOString() } : {}),
        callActivityLevels: buckets.map((value) => value / maxBucket),
        ...(mostRecentCallAt ? { callActivityAt: new Date(mostRecentCallAt).toISOString() } : {}),
        meterSource: status.audioLevels ? 'pcm' as const : 'call-activity' as const
      };
    });
  }

  recordFeedCallActivity(agency: Agency, borough: Borough | 'Citywide', occurredAt = Date.now()): void {
    const key = feedKey(agency, borough);
    const activity = (this.feedCallActivity.get(key) ?? []).filter((timestamp) => timestamp > occurredAt - 5 * 60_000);
    activity.push(occurredAt);
    this.feedCallActivity.set(key, activity.slice(-200));
    this.notifyFeedStatusChange();
  }

  setFeedCallAlert(agency: Agency, borough: Borough | 'Citywide', severity: 'newsworthy' | 'breaking', now = Date.now()): void {
    const key = feedKey(agency, borough);
    const current = this.feedAlerts.get(key);
    const requestedUntil = now + (severity === 'breaking' ? 30_000 : 15_000);
    if (current && current.until > now && current.severity === 'breaking' && severity === 'newsworthy') return;
    this.feedAlerts.set(key, {
      severity: current?.until && current.until > now && current.severity === 'breaking' ? 'breaking' : severity,
      until: Math.max(current?.until ?? 0, requestedUntil)
    });
    this.notifyFeedStatusChange();
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

  onLiveCallChange(listener: () => void): () => void {
    this.liveCallChangeListeners.add(listener);
    return () => this.liveCallChangeListeners.delete(listener);
  }

  onFeedStatusChange(listener: () => void): () => void {
    this.feedStatusChangeListeners.add(listener);
    return () => this.feedStatusChangeListeners.delete(listener);
  }

  private notifyFeedStatusChange(): void {
    for (const listener of this.feedStatusChangeListeners) listener();
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
      ...(input.headline?.trim() ? { headline: input.headline.trim().slice(0, 180) } : {}),
      category: input.category,
      ...(input.callType ?? deriveCallType(input.agency, input.incidentType) ? { callType: input.callType ?? deriveCallType(input.agency, input.incidentType) } : {}),
      ...(input.incidentType ? { incidentType: input.incidentType } : {}),
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
    for (const listener of this.liveCallChangeListeners) listener();
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

  getLiveCall(callId: string): DashboardLiveCall | undefined {
    return this.liveCalls.find((call) => call.id === callId);
  }

  async promoteLiveCallFromCommunity(callId: string, votes: { up: number; down: number }): Promise<DashboardIncident | undefined> {
    const existing = this.incidentDatabase?.findCommunityPromotion(callId)
      ?? this.incidents.find((incident) => incident.communitySourceCallId === callId);
    if (existing) return existing;
    const call = this.getLiveCall(callId);
    if (!call || call.category === 'routine') return undefined;
    return this.publish({
      title: `${call.agency} radio report selected by community`,
      headline: `${call.agency} Radio Report · Community Selected`,
      summary: `Community-selected radio report (${votes.up} upvotes, ${votes.down} downvotes). Community support is not incident verification. ${call.summary}`.slice(0, 700),
      occurredAt: new Date(call.occurredAt),
      agency: call.agency,
      borough: call.borough,
      category: call.category as AlertCategory,
      ...(call.callType ? { callType: call.callType } : {}),
      ...(call.location ? { location: call.location } : {}),
      ...(call.incidentType ? { incidentType: call.incidentType } : {}),
      unitIds: call.unitAssignments.map((assignment) => assignment.unitId),
      unitAssignments: call.unitAssignments,
      boxNumbers: call.boxNumbers,
      confidence: call.confidence,
      newsworthinessScore: call.newsworthinessScore,
      buffInterestScore: call.buffInterestScore,
      assignmentDeskScore: call.assignmentDeskScore,
      communitySelected: true,
      communitySourceCallId: callId
    });
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
      agencies: [input.agency],
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
      ...(input.callType ?? deriveCallType(input.agency, input.incidentType) ? { callType: input.callType ?? deriveCallType(input.agency, input.incidentType) } : {}),
      confidence: Math.max(0, Math.min(1, input.confidence)),
      newsworthinessScore: Math.max(1, Math.min(5, Math.round(input.newsworthinessScore))),
      buffInterestScore: Math.max(1, Math.min(5, Math.round(input.buffInterestScore ?? input.newsworthinessScore))),
      assignmentDeskScore: Math.max(1, Math.min(5, Math.round(input.assignmentDeskScore ?? input.newsworthinessScore))),
      hasAudio,
      ...(input.communitySelected ? { communitySelected: true } : {}),
      ...(input.communitySourceCallId ? { communitySourceCallId: input.communitySourceCallId } : {})
    };
    if (this.incidentDatabase) this.incidentDatabase.upsert(incident);
    else {
      this.incidents.unshift(incident);
      while (this.incidents.length > this.maxIncidents) {
        const removed = this.incidents.pop();
        if (removed) {
          const audio = this.audioFiles.get(removed.id);
          this.audioFiles.delete(removed.id);
          if (audio) await this.releaseAudio(audio.path);
        }
      }
    }
    await this.trimAudioReferences();
    this.notifyIncidentChange();
    return incident;
  }

  async updateIncident(incidentId: string, input: DashboardIncidentUpdateInput): Promise<DashboardIncident | undefined> {
    const index = this.incidents.findIndex((incident) => incident.id === incidentId);
    const current = this.getIncident(incidentId);
    if (!current) return undefined;
    let hasAudio = Boolean(this.audioFiles.get(current.id)) || current.hasAudio;
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
    const scopedNegativeFinding = /\bno (?:fire|smoke) found\b/i.test(input.headline ?? '')
      && input.newsworthinessScore < current.newsworthinessScore;
    const headline = (preserveExistingIncidentHeadline || scopedNegativeFinding || !input.headline || isGenericIncidentHeadline(input.headline) || oldHeadlineIsMoreDescriptive)
      ? oldHeadline
      : incomingHeadline;
    const hasMapMarker = isValidCoordinates(input.latitude, input.longitude) && canShowMapMarker(input.locationPrecision);
    const acceptLocation = Boolean(input.location && (input.isExplicitLocationCorrection || hasMapMarker || !current.location
      || (!canShowMapMarker(current.locationPrecision) && input.locationPrecision !== 'borough')));
    const nextLocation = acceptLocation ? input.location : current.location;
    const locationChanged = nextLocation !== current.location;
    const updated: DashboardIncident = {
      ...current,
      agencies: [...new Set([...current.agencies, input.agency ?? current.agency])],
      title: formatIncidentTitle(
        headline,
        nextLocation,
        current.agency,
        current.borough,
        nextCategory
      ),
      updatedAt: input.occurredAt.toISOString(),
      ...(acceptLocation ? { location: input.location!.slice(0, 180) } : {}),
      ...(input.incidentType && input.incidentType !== 'other' ? { incidentType: input.incidentType } : {}),
      ...((input.callType ?? current.callType ?? deriveCallType(input.agency ?? current.agency, input.incidentType)) ? { callType: input.callType ?? current.callType ?? deriveCallType(input.agency ?? current.agency, input.incidentType) } : {}),
      ...(hasMapMarker ? { latitude: input.latitude, longitude: input.longitude } : locationChanged ? { latitude: undefined, longitude: undefined } : {}),
      locationPrecision: hasMapMarker ? input.locationPrecision! : locationChanged ? input.locationPrecision ?? 'unresolved' : current.locationPrecision,
      unitIds: [...new Set([...current.unitIds, ...input.unitIds])].slice(0, 12),
      unitAssignments: normalizeUnitAssignments([...current.unitAssignments, ...(input.unitAssignments ?? [])]),
      boxNumbers: normalizeBoxNumbers([...current.boxNumbers, ...(input.boxNumbers ?? [])]),
      updateCount: current.updateCount + 1,
      updates: [...current.updates, {
        agency: input.agency ?? current.agency,
        ...(input.headline && !isGenericIncidentHeadline(input.headline) ? { headline: normalizeIncidentHeadline(input.headline, input.category) } : {}),
        summary: input.summary.slice(0, 700),
        occurredAt: input.occurredAt.toISOString(),
        ...(input.location ? { location: input.location.slice(0, 180) } : {}),
        ...(input.isExplicitLocationCorrection && (locationChanged || input.previousLocation) ? {
          isExplicitLocationCorrection: true,
          ...((input.previousLocation ?? current.location) ? { previousLocation: (input.previousLocation ?? current.location)!.slice(0, 180) } : {})
        } : {}),
        unitIds: [...new Set(input.unitIds)].slice(0, 12),
        unitAssignments: normalizeUnitAssignments(input.unitAssignments ?? []),
        boxNumbers: normalizeBoxNumbers(input.boxNumbers ?? [])
      }],
      category: nextCategory,
      confidence: Math.max(current.confidence, Math.max(0, Math.min(1, input.confidence))),
      newsworthinessScore: Math.max(current.newsworthinessScore, Math.max(1, Math.min(5, Math.round(input.newsworthinessScore)))),
      buffInterestScore: Math.max(current.buffInterestScore, Math.max(1, Math.min(5, Math.round(input.buffInterestScore ?? input.newsworthinessScore)))),
      assignmentDeskScore: Math.max(current.assignmentDeskScore, Math.max(1, Math.min(5, Math.round(input.assignmentDeskScore ?? input.newsworthinessScore)))),
      hasAudio
    };
    if (this.incidentDatabase) this.incidentDatabase.upsert(updated);
    else if (index >= 0) this.incidents[index] = updated;
    this.notifyIncidentChange();
    return updated;
  }

  addCommunityIncidentNote(incidentId: string, input: { username: string; audience: 'buff' | 'news'; message: string }): CommunityIncidentNote | undefined {
    if (!this.getIncident(incidentId)) return undefined;
    const note: CommunityIncidentNote = {
      id: randomUUID(),
      username: input.username.trim().slice(0, 24),
      audience: input.audience,
      message: input.message.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 500),
      createdAt: new Date().toISOString()
    };
    if (!note.username || !note.message) throw new Error('A username and community note message are required.');
    if (this.incidentDatabase) this.incidentDatabase.addCommunityNote(incidentId, note);
    else this.communityIncidentNotes.set(incidentId, [...(this.communityIncidentNotes.get(incidentId) ?? []), note]);
    this.notifyIncidentChange();
    return note;
  }

  search(query = '', boroughs?: readonly Borough[]): DashboardIncident[] {
    if (this.incidentDatabase) return this.incidentDatabase.list(query, boroughs).map((incident) => this.withAudioAvailability(incident));
    const normalized = query.trim().toLowerCase();
    const matches = !normalized ? this.incidents.filter((incident) => boroughMatches(incident.borough, boroughs))
      : this.incidents.filter((incident) => boroughMatches(incident.borough, boroughs) &&
      stripActingAsTarget(`${incident.title} ${incident.summary} ${incident.updates.map((update) => `${update.summary} ${update.unitIds.join(' ')} ${update.boxNumbers.join(' ')}`).join(' ')} ${incident.unitIds.join(' ')} ${incident.boxNumbers.join(' ')} ${incident.agency} ${incident.borough} ${incident.category}`).toLowerCase().includes(normalized)
      );
    return matches.map((incident) => this.withAudioAvailability(incident));
  }

  getIncident(incidentId: string): DashboardIncident | undefined {
    const incident = this.incidentDatabase?.get(incidentId) ?? this.incidents.find((item) => item.id === incidentId);
    return incident ? this.withAudioAvailability(incident) : undefined;
  }

  listIncidentPage(query = '', boroughs?: readonly Borough[], callType?: CallType, limit = 50, offset = 0): { incidents: DashboardIncident[]; total: number; limit: number; offset: number } {
    if (!this.incidentDatabase) {
      const all = this.search(query, boroughs).filter((incident) => !callType || (incident.callType ?? deriveCallType(incident.agency, incident.incidentType)) === callType);
      const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      const safeOffset = Math.max(0, Math.floor(offset));
      return { incidents: all.slice(safeOffset, safeOffset + safeLimit), total: all.length, limit: safeLimit, offset: safeOffset };
    }
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    return {
      incidents: this.incidentDatabase.list(query, boroughs, safeLimit, safeOffset, callType).map((incident) => this.withAudioAvailability(incident)),
      total: this.incidentDatabase.count(query, boroughs, callType),
      limit: safeLimit,
      offset: safeOffset
    };
  }

  async adminEditIncident(incidentId: string, input: { headline: string; summary: string; location?: string; callType?: CallType; incidentType?: IncidentType }): Promise<DashboardIncident | undefined> {
    const index = this.incidents.findIndex((incident) => incident.id === incidentId);
    const current = this.getIncident(incidentId);
    if (!current) return undefined;
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
      ...(input.callType ? { callType: input.callType } : {}),
      ...(input.incidentType ? { incidentType: input.incidentType } : {}),
      ...(locationChanged ? { latitude: undefined, longitude: undefined, locationPrecision: 'unresolved' } : {})
    };
    if (this.incidentDatabase) this.incidentDatabase.upsert(updated);
    else if (index >= 0) this.incidents[index] = updated;
    this.notifyIncidentChange();
    return updated;
  }

  async deleteIncident(incidentId: string): Promise<boolean> {
    const index = this.incidents.findIndex((incident) => incident.id === incidentId);
    const deleted = this.incidentDatabase ? this.incidentDatabase.delete(incidentId) : index >= 0;
    if (!deleted) return false;
    if (!this.incidentDatabase && index >= 0) this.incidents.splice(index, 1);
    const audio = this.audioFiles.get(incidentId);
    this.audioFiles.delete(incidentId);
    this.communityIncidentNotes.delete(incidentId);
    if (audio) await this.releaseAudio(audio.path);
    this.notifyIncidentChange();
    return true;
  }

  listMapIncidents(now = Date.now(), windowMs = 30 * 60 * 1000, boroughs?: readonly Borough[]): DashboardIncident[] {
    if (this.incidentDatabase) return this.incidentDatabase.listMap(now, windowMs, boroughs).map((incident) => this.withAudioAvailability(incident));
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

  private withAudioAvailability(incident: DashboardIncident): DashboardIncident {
    return {
      ...incident,
      hasAudio: Boolean(this.audioFiles.get(incident.id)),
      communityNotes: this.incidentDatabase ? incident.communityNotes ?? [] : [...(this.communityIncidentNotes.get(incident.id) ?? [])]
    };
  }

  private async trimAudioReferences(): Promise<void> {
    while (this.audioFiles.size > this.maxIncidents) {
      const oldestId = this.audioFiles.keys().next().value as string | undefined;
      if (!oldestId) return;
      const audio = this.audioFiles.get(oldestId);
      this.audioFiles.delete(oldestId);
      if (audio) await this.releaseAudio(audio.path);
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

function feedKey(agency: Agency, borough: Borough | 'Citywide'): string {
  return `${agency}:${borough}`;
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