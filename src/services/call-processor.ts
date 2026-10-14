import type { Client } from 'discord.js';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { subscriptionAudience, type AlertSubscription } from '../domain/subscriptions.js';
import { analyzeFdnyTransmission } from '../domain/fdny-radio.js';
import { curateIncidentHeadline, shouldNotify, type CallTriage, type RadioCall } from '../domain/triage.js';
import type { IncidentPostPublisher } from '../providers/x-post.js';
import type { CallAnalysisProvider } from '../providers/ai.js';
import type { MapCoordinates } from '../providers/map-geocoder.js';
import { logger } from '../logger.js';
import { extractActingAsAssignments, extractBoxNumbers, extractUnitIds, isSameIncident, type IncidentIdentity } from './incident-correlation.js';
import { RecentRepeatDetector } from './repeat-detection.js';
import type { SubscriptionStore } from '../storage/subscription-store.js';
import type { DashboardStore, DashboardIncident } from './dashboard-store.js';
import { LearningLog, type LearningEvent, type LearningWorkflowStage } from './learning-log.js';

const nonSpeechPlaceholders = new Set([
  '', 'silence', 'blank audio', 'inaudible', 'no speech',
  'no relevant information provided in the transcript',
  'no information provided in the transcript',
  'no content available for analysis'
]);

function isNonSpeechTranscript(transcript: string): boolean {
  const normalized = transcript.normalize('NFKC').toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[\[\](){}"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/g, '').trim();
  return nonSpeechPlaceholders.has(normalized);
}

export function roleMentionOptions(subscriptions: AlertSubscription[]): { content?: string; allowedMentions: { parse: []; roles: string[] } } {
  const roles = [...new Set(subscriptions
    .filter((subscription) => Boolean(subscription.notifyRoleId) && subscription.notifyRoleId !== subscription.guildId)
    .map((subscription) => subscription.notifyRoleId!))];
  return {
    ...(roles.length ? { content: roles.map((roleId) => `<@&${roleId}>`).join(' ') } : {}),
    allowedMentions: { parse: [], roles }
  };
}

export interface IncidentGeocoder {
  geocode(location: string, borough: string): Promise<MapCoordinates | undefined>;
}

interface TrackedIncident {
  id: string;
  identity: IncidentIdentity;
  messages: Array<{ channelId: string; messageId: string }>;
}

interface PendingIncident {
  id: string;
  eventId: string;
  callId: string;
  workflowPath: string[];
  identity: IncidentIdentity;
  headline?: string;
  summary: string;
  category: CallTriage['category'];
  confidence: number;
  newsworthinessScore: number;
  buffInterestScore: number;
  assignmentDeskScore: number;
  unitAssignments: ReturnType<typeof extractActingAsAssignments>;
  expiresAt: number;
}

interface LearningTrace {
  eventId: string;
  path: string[];
  transcript?: string;
  transcriptSource?: 'broadcastify' | 'local-whisper';
  headline?: string;
  summary?: string;
  category?: string;
  incidentType?: string;
  confidence?: number;
  confidenceKind?: LearningEvent['confidenceKind'];
  scores?: LearningEvent['scores'];
  qualifications?: LearningEvent['qualifications'];
  location?: string;
  geocode?: LearningEvent['geocode'];
}

export class CallProcessor {
  private readonly repeatDetector = new RecentRepeatDetector();
  private readonly trackedIncidents: TrackedIncident[] = [];
  private readonly pendingIncidents: PendingIncident[] = [];
  private readonly pendingCleanupTimer = setInterval(() => this.prunePendingIncidents(Date.now()), 60_000).unref();

  constructor(
    private readonly client: Client,
    private readonly store: SubscriptionStore,
    private readonly analysis: CallAnalysisProvider,
    private readonly dashboard: DashboardStore,
    private readonly allowAudioRedistribution = false,
    private readonly minTriageConfidence = 0.78,
    private readonly minNewsworthiness = 4,
    private readonly geocoder?: IncidentGeocoder,
    private readonly minBuffInterest = 4,
    private readonly minNewsMediaDesk = 4,
    private readonly learningLog = new LearningLog('./data', false),
    private readonly incidentPublisher?: IncidentPostPublisher,
    private readonly publicUrl = 'https://nycalert.ai'
  ) {}

  listPendingIncidents(): Array<{ id: string; agency: RadioCall['agency']; borough: RadioCall['borough']; eventType?: CallTriage['incidentType']; summary: string; location?: string; createdAt: string; expiresAt: string }> {
    this.prunePendingIncidents(Date.now());
    return this.pendingIncidents.map((pending) => ({
      id: pending.id,
      agency: pending.identity.agency,
      borough: pending.identity.borough,
      ...(pending.identity.incidentType ? { eventType: pending.identity.incidentType } : {}),
      summary: pending.summary,
      ...(pending.identity.location ? { location: pending.identity.location } : {}),
      createdAt: new Date(pending.identity.occurredAt).toISOString(),
      expiresAt: new Date(pending.expiresAt).toISOString()
    }));
  }

  discardPendingIncident(id: string): boolean {
    const index = this.pendingIncidents.findIndex((pending) => pending.id === id);
    if (index < 0) return false;
    const [pending] = this.pendingIncidents.splice(index, 1);
    if (pending) {
      pending.workflowPath.push('pending-discarded');
      this.learningLog.record({
        eventId: pending.eventId,
        callId: pending.callId,
        occurredAt: new Date(pending.identity.occurredAt).toISOString(),
        loggedAt: new Date().toISOString(),
        stage: 'pending-discarded',
        workflowPath: [...pending.workflowPath],
        agency: pending.identity.agency,
        feedBorough: pending.identity.borough,
        disposition: 'manually-discarded-by-admin'
      });
    }
    return true;
  }

  async allowPendingIncident(id: string): Promise<{ incidentId: string } | undefined> {
    const index = this.pendingIncidents.findIndex((pending) => pending.id === id);
    if (index < 0) return undefined;
    const [pending] = this.pendingIncidents.splice(index, 1);
    if (!pending) return undefined;
    const incident = await this.dashboard.publish({
      title: pending.headline || pending.summary,
      headline: pending.headline,
      summary: `Admin-approved pending radio report. Location has not been verified. ${pending.summary}`.slice(0, 700),
      occurredAt: new Date(pending.identity.occurredAt),
      agency: pending.identity.agency,
      borough: pending.identity.borough,
      category: pending.category as Exclude<CallTriage['category'], 'routine'>,
      ...(pending.identity.location ? { location: pending.identity.location } : {}),
      ...(pending.identity.incidentType ? { incidentType: pending.identity.incidentType } : {}),
      unitIds: pending.identity.unitIds,
      unitAssignments: pending.unitAssignments,
      boxNumbers: pending.identity.boxNumbers ?? [],
      confidence: pending.confidence,
      newsworthinessScore: pending.newsworthinessScore,
      buffInterestScore: pending.buffInterestScore,
      assignmentDeskScore: pending.assignmentDeskScore
    });
    pending.workflowPath.push('pending-approved');
    this.learningLog.record({
      eventId: pending.eventId,
      callId: pending.callId,
      occurredAt: new Date(pending.identity.occurredAt).toISOString(),
      loggedAt: new Date().toISOString(),
      stage: 'pending-approved',
      workflowPath: [...pending.workflowPath],
      agency: pending.identity.agency,
      feedBorough: pending.identity.borough,
      headline: pending.headline,
      summary: pending.summary,
      category: pending.category,
      incidentType: pending.identity.incidentType,
      confidence: pending.confidence,
      scores: { public: pending.newsworthinessScore, buff: pending.buffInterestScore, newsMedia: pending.assignmentDeskScore },
      location: pending.identity.location,
      disposition: 'admin-approved-for-public-board-location-unverified',
      incidentId: incident.id
    });
    this.trackedIncidents.unshift({ id: incident.id, identity: pending.identity, messages: [] });
    this.trackedIncidents.length = Math.min(this.trackedIncidents.length, 300);
    return { incidentId: incident.id };
  }

  async process(call: RadioCall, loadIncidentAudio?: () => Promise<{ path: string; contentType: string }>): Promise<'processed' | 'alert' | 'retry' | 'ignored'> {
    const trace: LearningTrace = { eventId: randomUUID(), path: [] };
    try {
      return await this.processCall(call, loadIncidentAudio, trace);
    } catch (error) {
      this.recordLearning(call, trace, 'error', {
        disposition: 'processing-error',
        error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }

  private async processCall(
    call: RadioCall,
    loadIncidentAudio: (() => Promise<{ path: string; contentType: string }>) | undefined,
    trace: LearningTrace
  ): Promise<'processed' | 'alert' | 'retry' | 'ignored'> {
    this.recordLearning(call, trace, 'received', { disposition: call.transcript ? 'broadcastify-transcript-present' : call.audioPath ? 'audio-received' : 'missing-input' });
    if (!call.audioPath && !call.transcript) {
      logger.warn({ callId: call.id }, 'Skipping call without a locally available audio file');
      this.recordLearning(call, trace, 'retry', { disposition: 'no-audio-or-transcript' });
      return 'retry';
    }
    trace.transcriptSource = call.transcript?.trim() ? 'broadcastify' : 'local-whisper';
    let transcript: string;
    try {
      transcript = call.transcript?.trim() || await this.analysis.transcribe(call.audioPath!);
    } catch (error) {
      this.recordLearning(call, trace, 'transcription-error', {
        transcriptSource: trace.transcriptSource,
        disposition: 'transcription-failed',
        error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
    trace.transcript = transcript;
    this.recordLearning(call, trace, 'transcription', { transcript, transcriptSource: trace.transcriptSource, transcriptCharacters: transcript.length });
    if (isNonSpeechTranscript(transcript)) {
      logger.info({ callId: call.id }, 'Skipping silence or non-speech transcript');
      this.recordLearning(call, trace, 'transcription-ignored', { disposition: 'non-speech-placeholder' });
      return 'ignored';
    }
    if (this.repeatDetector.isRepeatedTranscript(call, transcript)) {
      logger.info({ callId: call.id }, 'Skipping repeated radio transcript within the deduplication window');
      this.recordLearning(call, trace, 'repeat-suppressed', { disposition: 'repeated-transcript' });
      return 'ignored';
    }

    let analyzedTriage: CallTriage;
    try {
      analyzedTriage = await this.analysis.triage(transcript, call.agency);
    } catch (error) {
      this.recordLearning(call, trace, 'triage-error', {
        disposition: 'triage-failed',
        error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
    const triage: CallTriage = {
      ...analyzedTriage,
      headline: curateIncidentHeadline(analyzedTriage.headline, transcript, call.agency)
    };
    trace.headline = triage.headline;
    trace.summary = triage.summary;
    trace.category = triage.category;
    trace.incidentType = triage.incidentType;
    trace.confidence = triage.confidence;
    trace.confidenceKind = 'triage-evidence-fit';
    const unitAssignments = extractActingAsAssignments(transcript);
    const unitIds = extractUnitIds(transcript);
    const boxNumbers = call.agency === 'FDNY' ? extractBoxNumbers(transcript) : [];
    const fdnyRadioAnalysis = this.learningLog.isEnabled && call.agency === 'FDNY'
      ? analyzeFdnyTransmission(transcript, call.agency, call.borough, triage.location)
      : undefined;
    const publicQualified = shouldNotify(triage, this.minTriageConfidence, this.minNewsworthiness);
    const buffQualified = triage.category !== 'routine'
      && triage.confidence >= this.minTriageConfidence
      && (triage.buffInterestScore ?? triage.newsworthinessScore) >= this.minBuffInterest;
    const newsDeskQualified = triage.category !== 'routine'
      && triage.confidence >= this.minTriageConfidence
      && (triage.assignmentDeskScore ?? triage.newsworthinessScore) >= this.minNewsMediaDesk;
    const qualifiesAsIncident = publicQualified || buffQualified || newsDeskQualified;
    trace.scores = { public: triage.newsworthinessScore, buff: triage.buffInterestScore ?? triage.newsworthinessScore, newsMedia: triage.assignmentDeskScore ?? triage.newsworthinessScore };
    trace.qualifications = { public: publicQualified, buff: buffQualified, newsMedia: newsDeskQualified };
    trace.location = triage.location;
    this.recordLearning(call, trace, 'triage', {
      headline: triage.headline,
      summary: triage.summary,
      category: triage.category,
      incidentType: triage.incidentType,
      confidence: triage.confidence,
      confidenceKind: trace.confidenceKind,
      ...(fdnyRadioAnalysis ? { fdnyRadioAnalysis } : {}),
      scores: trace.scores,
      thresholds: { triageConfidence: this.minTriageConfidence, public: this.minNewsworthiness, buff: this.minBuffInterest, newsMedia: this.minNewsMediaDesk },
      qualifications: trace.qualifications,
      location: triage.location,
      units: unitIds,
      boxNumbers
    });
    let coordinates: MapCoordinates | undefined;
    const explicitLocationBorough = boroughExplicitlyStated(triage.location);
    const searchBorough = explicitLocationBorough ?? call.borough;
    if (triage.location && this.geocoder && (qualifiesAsIncident || unitIds.length > 0)) {
      try {
        coordinates = await this.geocoder.geocode(triage.location, searchBorough);
      } catch (error) {
        logger.warn({ error, callId: call.id }, 'Incident location could not be geocoded');
        trace.geocode = { attempted: true, borough: searchBorough, matched: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!trace.geocode) trace.geocode = { attempted: true, borough: searchBorough, matched: Boolean(coordinates), ...(coordinates ?? {}) };
    } else {
      trace.geocode = { attempted: false, borough: searchBorough, matched: false };
    }
    this.recordLearning(call, trace, 'geocoding', { location: triage.location, geocode: trace.geocode });
    const incidentBorough = explicitLocationBorough && coordinates ? explicitLocationBorough : call.borough;
    const effectiveCall: RadioCall = { ...call, borough: incidentBorough };
    const unresolvedBoroughConflict = Boolean(explicitLocationBorough && explicitLocationBorough !== call.borough && !coordinates);
    const recordLiveCall = () => this.dashboard.recordLiveCall({
      sourceId: call.id,
      groupName: call.groupName,
      occurredAt: call.occurredAt,
      agency: call.agency,
      borough: incidentBorough,
      transcript,
      category: triage.category,
      location: triage.location,
      summary: triage.summary,
      confidence: triage.confidence,
      newsworthinessScore: triage.newsworthinessScore,
      buffInterestScore: triage.buffInterestScore,
      assignmentDeskScore: triage.assignmentDeskScore,
      unitAssignments,
      boxNumbers
    });
    const callSubscriptions = this.store.listForCall(effectiveCall);
    const eligibleSubscriptions = callSubscriptions.filter((subscription) =>
      subscriptionAudience(subscription) === 'buff' ? buffQualified
        : subscriptionAudience(subscription) === 'news' ? newsDeskQualified
          : publicQualified
    );
    const identity: IncidentIdentity = {
      agency: call.agency,
      borough: explicitLocationBorough ?? incidentBorough,
      incidentType: triage.incidentType,
      eventDescription: [triage.headline, triage.summary].filter(Boolean).join(' '),
      location: triage.location,
      ...(coordinates ? { latitude: coordinates.latitude, longitude: coordinates.longitude } : {}),
      unitIds,
      boxNumbers,
      occurredAt: call.occurredAt.getTime()
    };
    this.pruneTrackedIncidents(Date.now());
    this.prunePendingIncidents(Date.now());
    const candidates = this.trackedIncidents.filter((tracked) => isSameIncident(tracked.identity, identity));
    const matchingIncident = candidates.length === 1 ? candidates[0] : undefined;
    this.recordLearning(call, trace, 'correlation', {
      correlation: { candidateCount: candidates.length, ...(matchingIncident ? { incidentId: matchingIncident.id } : {}) },
      disposition: matchingIncident ? 'existing-incident-match' : candidates.length > 1 ? 'ambiguous-match' : 'no-existing-match'
    });
    if (candidates.length > 1) logger.warn({ callId: call.id, candidates: candidates.length }, 'Ambiguous incident follow-up left separate');

    if (unresolvedBoroughConflict) {
      if (qualifiesAsIncident && triage.category !== 'routine') this.enqueuePendingIncident({ identity, triage, unitAssignments, call, trace });
      logger.info({ callId: call.id, pendingCount: this.pendingIncidents.length }, 'Cross-borough location could not be verified; withholding public call');
      this.recordLearning(call, trace, 'incident-withheld', { disposition: 'explicit-borough-conflict-unverified', location: triage.location });
      return 'processed';
    }

    if (matchingIncident) {
      await recordLiveCall();
      let updateCall = call;
      if (!call.audioPath && qualifiesAsIncident && loadIncidentAudio) {
        try {
          const audio = await loadIncidentAudio();
          updateCall = { ...call, audioPath: audio.path, audioContentType: audio.contentType };
        } catch (error) {
          logger.warn({ error, callId: call.id }, 'Could not retrieve optional follow-up audio');
        }
      }
      const updated = await this.dashboard.updateIncident(matchingIncident.id, {
        headline: triage.headline,
        summary: triage.summary,
        occurredAt: call.occurredAt,
        location: triage.location,
        incidentType: triage.incidentType,
        ...(coordinates ? { latitude: coordinates.latitude, longitude: coordinates.longitude } : {}),
        unitIds,
        unitAssignments,
        boxNumbers,
        confidence: triage.confidence,
        newsworthinessScore: triage.newsworthinessScore,
        buffInterestScore: triage.buffInterestScore,
        assignmentDeskScore: triage.assignmentDeskScore,
        category: triage.category,
        audioPath: updateCall.audioPath,
        audioContentType: updateCall.audioContentType
      });
      if (updated) {
        matchingIncident.identity = {
          ...matchingIncident.identity,
          incidentType: updated.incidentType,
          eventDescription: [updated.title.split(' | ')[0], updated.summary].filter(Boolean).join(' '),
          location: updated.location,
          latitude: updated.latitude,
          longitude: updated.longitude,
          unitIds: updated.unitIds,
          boxNumbers: updated.boxNumbers
        };
        await this.editTrackedMessages(matchingIncident, buildIncidentEmbed(updated));
        logger.info({ incidentId: matchingIncident.id, callId: call.id, unitIds }, 'Updated existing incident with radio follow-up');
        this.recordLearning(call, trace, 'incident-updated', { incidentId: matchingIncident.id, disposition: 'correlated-follow-up', correlation: { candidateCount: candidates.length, incidentId: matchingIncident.id } });
      } else {
        this.recordLearning(call, trace, 'incident-suppressed', { incidentId: matchingIncident.id, disposition: 'matched-incident-update-failed' });
      }
      return 'processed';
    }

    if (!qualifiesAsIncident || triage.category === 'routine') {
      await recordLiveCall();
      this.recordLearning(call, trace, 'incident-suppressed', { disposition: 'below-audience-threshold-or-routine' });
      return 'processed';
    }
    const locationUnverified = Boolean(this.geocoder && !coordinates);
    if (!triage.location || locationUnverified || unresolvedBoroughConflict) {
      const pendingMatches = this.pendingIncidents.filter((pending) => isSameIncident(pending.identity, identity));
      if (pendingMatches.length === 1) {
        const pending = pendingMatches[0]!;
        pending.identity = {
          ...pending.identity,
          eventDescription: `${pending.identity.eventDescription} ${identity.eventDescription}`.trim(),
          unitIds: [...new Set([...pending.identity.unitIds, ...unitIds])],
          boxNumbers: [...new Set([...(pending.identity.boxNumbers ?? []), ...boxNumbers])]
        };
        pending.summary = `${pending.summary} ${triage.summary}`.slice(0, 1_200);
        pending.expiresAt = Math.max(pending.expiresAt, Date.now() + 30 * 60 * 1000);
      } else {
        this.enqueuePendingIncident({ identity, triage, unitAssignments, call, trace });
      }
      logger.info({ callId: call.id, pendingCount: this.pendingIncidents.length }, 'Qualified call held privately pending location/corroboration');
      this.recordLearning(call, trace, 'pending-queue', { disposition: 'awaiting-located-corroboration', correlation: { candidateCount: candidates.length, pendingMatchCount: pendingMatches.length } });
      return 'processed';
    }
    await recordLiveCall();
    const alertDescription = [triage.category, triage.location, triage.summary].filter(Boolean).join(' ');
    if (this.repeatDetector.isRepeatedIncident(effectiveCall, alertDescription)) {
      logger.info({ callId: call.id }, 'Suppressing a repeated incident alert within the deduplication window');
      this.recordLearning(call, trace, 'incident-suppressed', { disposition: 'repeated-incident-alert' });
      return 'processed';
    }
    const pendingMatches = this.pendingIncidents.filter((pending) => isSameIncident(pending.identity, identity));
    const matchingPending = pendingMatches.length === 1 ? pendingMatches[0] : undefined;
    if (pendingMatches.length > 1) logger.warn({ callId: call.id, candidates: pendingMatches.length }, 'Ambiguous pending reports left unmerged');
    if (matchingPending) this.pendingIncidents.splice(this.pendingIncidents.indexOf(matchingPending), 1);

    let incidentCall = call;
    if (!incidentCall.audioPath && loadIncidentAudio) {
      try {
        const audio = await loadIncidentAudio();
        incidentCall = { ...call, audioPath: audio.path, audioContentType: audio.contentType };
      } catch (error) {
        logger.warn({ error, callId: call.id }, 'Could not retrieve optional incident audio; sending alert without playback');
      }
    }

    let incident = await this.dashboard.publish({
      title: triage.headline ?? triage.summary,
      headline: triage.headline,
      summary: triage.summary,
      occurredAt: call.occurredAt,
      agency: call.agency,
      borough: incidentBorough,
      category: triage.category,
      location: triage.location,
      incidentType: triage.incidentType,
      ...(coordinates ? { latitude: coordinates.latitude, longitude: coordinates.longitude } : {}),
      unitIds,
      unitAssignments,
      boxNumbers,
      confidence: triage.confidence,
      newsworthinessScore: triage.newsworthinessScore,
      buffInterestScore: triage.buffInterestScore,
      assignmentDeskScore: triage.assignmentDeskScore,
      audioPath: incidentCall.audioPath,
      audioContentType: incidentCall.audioContentType
    });
    this.repeatDetector.rememberIncident(effectiveCall, alertDescription);
    const tracked: TrackedIncident = { id: incident.id, identity, messages: [] };
    this.trackedIncidents.unshift(tracked);
    this.trackedIncidents.length = Math.min(this.trackedIncidents.length, 300);
    if (matchingPending) {
      const pendingAt = new Date(matchingPending.identity.occurredAt);
      const attached = await this.dashboard.updateIncident(incident.id, {
        headline: triage.headline,
        summary: `Earlier unlocated radio report (${pendingAt.toISOString()}): ${matchingPending.summary}`,
        occurredAt: call.occurredAt,
        location: triage.location,
        incidentType: triage.incidentType,
        ...(coordinates ? { latitude: coordinates.latitude, longitude: coordinates.longitude } : {}),
        unitIds: matchingPending.identity.unitIds,
        unitAssignments: matchingPending.unitAssignments,
        boxNumbers: matchingPending.identity.boxNumbers ?? [],
        confidence: Math.min(matchingPending.confidence, triage.confidence),
        newsworthinessScore: Math.min(matchingPending.newsworthinessScore, triage.newsworthinessScore),
        buffInterestScore: Math.min(matchingPending.buffInterestScore, triage.buffInterestScore ?? triage.newsworthinessScore),
        assignmentDeskScore: Math.min(matchingPending.assignmentDeskScore, triage.assignmentDeskScore ?? triage.newsworthinessScore),
        category: triage.category
      });
      if (attached) {
        incident = attached;
        tracked.identity.unitIds = [...new Set([...tracked.identity.unitIds, ...matchingPending.identity.unitIds])];
        tracked.identity.boxNumbers = [...new Set([...(tracked.identity.boxNumbers ?? []), ...(matchingPending.identity.boxNumbers ?? [])])];
        await this.editTrackedMessages(tracked, buildIncidentEmbed(attached));
      }
      matchingPending.workflowPath.push('pending-attached');
      this.learningLog.record({
        eventId: matchingPending.eventId, callId: matchingPending.callId,
        occurredAt: new Date(matchingPending.identity.occurredAt).toISOString(), loggedAt: new Date().toISOString(),
        stage: 'pending-attached', workflowPath: [...matchingPending.workflowPath], agency: matchingPending.identity.agency,
        feedBorough: matchingPending.identity.borough, incidentId: incident.id, disposition: 'attached-to-unique-located-incident'
      });
    }
    this.recordLearning(call, trace, 'incident-published', {
      incidentId: incident.id,
      disposition: matchingPending ? 'published-and-attached-pending-report' : 'new-public-incident',
      correlation: { candidateCount: candidates.length, pendingMatchCount: pendingMatches.length, incidentId: incident.id }
    });

    const xPostTask = this.incidentPublisher && publicQualified
      ? this.incidentPublisher.publishIncident({
          id: incident.id,
          headline: triage.headline ?? incident.title.split(' | ')[0] ?? 'Incident',
          ...(triage.incidentType ? { incidentType: triage.incidentType } : {}),
          agency: call.agency,
          borough: incident.borough,
          ...(incident.location ? { location: incident.location } : {}),
          unitIds: incident.unitIds,
          boxNumbers: incident.boxNumbers,
          newsworthinessScore: incident.newsworthinessScore,
          incidentUrl: `${this.publicUrl}/incident/${encodeURIComponent(incident.id)}`
        }).then((posted) => {
          this.recordLearning(call, trace, 'x-publishing', {
            incidentId: incident.id,
            disposition: 'x-post-created',
            socialPost: { provider: 'x', postId: posted.postId, url: posted.url }
          });
        }).catch((error: unknown) => {
          logger.error({ error, incidentId: incident.id, callId: call.id }, 'Could not publish incident to X');
          this.recordLearning(call, trace, 'x-publishing', {
            incidentId: incident.id,
            disposition: 'x-post-failed',
            error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
          });
        })
      : undefined;

    const destinations = new Map<string, AlertSubscription[]>();
    for (const subscription of eligibleSubscriptions) {
      const channelSubscriptions = destinations.get(subscription.channelId) ?? [];
      channelSubscriptions.push(subscription);
      destinations.set(subscription.channelId, channelSubscriptions);
    }

    const embed = buildIncidentEmbed(incident);
    let discordMessagesSent = 0;
    let channelFetchFailures = 0;
    let unsupportedDestinations = 0;
    let sendFailures = 0;
    const destinationResults: NonNullable<LearningEvent['routing']>['destinations'] = [];
    for (const [channelId, subscriptions] of destinations) {
      let channel;
      try {
        channel = await this.client.channels.fetch(channelId);
      } catch (error) {
        channelFetchFailures += 1;
        destinationResults.push({ result: 'channel-fetch-failed', errorCategory: discordErrorCategory(error) });
        logger.warn({ channelId, error }, 'Could not fetch notification channel');
        continue;
      }
      if (!channel?.isTextBased() || !('send' in channel)) {
        unsupportedDestinations += 1;
        destinationResults.push({ result: 'unsupported-channel' });
        continue;
      }
      const rolePings = roleMentionOptions(subscriptions);
      try {
        const message = await channel.send({
          embeds: [embed],
          ...(rolePings.content ? { content: rolePings.content } : {}),
          ...(this.allowAudioRedistribution && call.agency === 'FDNY' && incidentCall.audioPath ? { files: [new AttachmentBuilder(incidentCall.audioPath, { name: `${call.id}.${audioExtension(incidentCall.audioContentType)}` })] } : {}),
          allowedMentions: rolePings.allowedMentions
        });
        tracked.messages.push({ channelId, messageId: message.id });
        discordMessagesSent += 1;
        destinationResults.push({ result: 'sent' });
      } catch (error) {
        sendFailures += 1;
        destinationResults.push({ result: 'send-failed', errorCategory: discordErrorCategory(error) });
        logger.error({ error, channelId, callId: call.id }, 'Could not send alert to Discord channel');
      }
    }
    const disposition = eligibleSubscriptions.length === 0 ? 'no-eligible-subscriptions'
      : discordMessagesSent > 0 && destinationResults.some((destination) => destination.result !== 'sent') ? 'partially-sent'
        : discordMessagesSent > 0 ? 'alerts-sent'
          : sendFailures > 0 ? 'discord-send-failed'
            : channelFetchFailures > 0 ? 'discord-channel-fetch-failed'
              : 'no-sendable-discord-destination';
    this.recordLearning(call, trace, 'discord-routing', {
      incidentId: incident.id,
      disposition,
      routing: {
        eligibleSubscriptions: eligibleSubscriptions.length,
        public: eligibleSubscriptions.filter((subscription) => subscriptionAudience(subscription) === 'public').length,
        buff: eligibleSubscriptions.filter((subscription) => subscriptionAudience(subscription) === 'buff').length,
        newsMedia: eligibleSubscriptions.filter((subscription) => subscriptionAudience(subscription) === 'news').length,
        destinationCount: destinations.size,
        successfulDestinations: discordMessagesSent,
        channelFetchFailures,
        unsupportedDestinations,
        sendFailures,
        discordMessagesSent,
        destinations: destinationResults
      }
    });
    await xPostTask;
    return 'alert';
  }

  private recordLearning(call: RadioCall, trace: LearningTrace, stage: LearningWorkflowStage, details: Partial<LearningEvent> = {}): void {
    trace.path.push(stage);
    this.learningLog.record({
      eventId: trace.eventId,
      callId: call.id,
      occurredAt: call.occurredAt.toISOString(),
      loggedAt: new Date().toISOString(),
      stage,
      workflowPath: [...trace.path],
      agency: call.agency,
      feedBorough: call.borough,
      ...(call.groupName ? { sourceGroup: call.groupName.slice(0, 120) } : {}),
      ...(trace.transcriptSource ? { transcriptSource: trace.transcriptSource } : {}),
      ...(trace.headline ? { headline: trace.headline } : {}),
      ...(trace.summary ? { summary: trace.summary } : {}),
      ...(trace.category ? { category: trace.category } : {}),
      trafficType: (details.category ?? trace.category) === 'routine'
        ? 'routine'
        : (details.category ?? trace.category) ? 'incident' : 'unclassified',
      ...(trace.incidentType ? { incidentType: trace.incidentType } : {}),
      ...(trace.confidence !== undefined ? { confidence: trace.confidence } : {}),
      ...(trace.confidenceKind ? { confidenceKind: trace.confidenceKind } : {}),
      ...(trace.scores ? { scores: trace.scores } : {}),
      ...(trace.qualifications ? { qualifications: trace.qualifications } : {}),
      ...(trace.location ? { location: trace.location } : {}),
      ...(trace.geocode ? { geocode: trace.geocode } : {}),
      ...details
    });
  }

  private pruneTrackedIncidents(now: number): void {
    for (let index = this.trackedIncidents.length - 1; index >= 0; index -= 1) {
      if (now - this.trackedIncidents[index]!.identity.occurredAt > 30 * 60 * 1000) this.trackedIncidents.splice(index, 1);
    }
  }

  private prunePendingIncidents(now: number): void {
    for (let index = this.pendingIncidents.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingIncidents[index]!;
      if (pending.expiresAt <= now) {
        this.pendingIncidents.splice(index, 1);
        pending.workflowPath.push('pending-expired');
        this.learningLog.record({
          eventId: pending.eventId,
          callId: pending.callId,
          occurredAt: new Date(pending.identity.occurredAt).toISOString(),
          loggedAt: new Date(now).toISOString(),
          stage: 'pending-expired',
          workflowPath: [...pending.workflowPath],
          agency: pending.identity.agency,
          feedBorough: pending.identity.borough,
          disposition: 'expired-unmatched-after-30-minutes'
        });
      }
    }
  }

  private enqueuePendingIncident(input: {
    identity: IncidentIdentity;
    triage: CallTriage;
    unitAssignments: ReturnType<typeof extractActingAsAssignments>;
    call: RadioCall;
    trace: LearningTrace;
  }): void {
    this.pendingIncidents.unshift({
      id: randomUUID(),
      eventId: input.trace.eventId,
      callId: input.call.id,
      workflowPath: input.trace.path,
      identity: input.identity,
      headline: input.triage.headline,
      summary: input.triage.summary.slice(0, 700),
      category: input.triage.category,
      confidence: input.triage.confidence,
      newsworthinessScore: input.triage.newsworthinessScore,
      buffInterestScore: input.triage.buffInterestScore ?? input.triage.newsworthinessScore,
      assignmentDeskScore: input.triage.assignmentDeskScore ?? input.triage.newsworthinessScore,
      unitAssignments: input.unitAssignments,
      expiresAt: Date.now() + 30 * 60 * 1000
    });
    this.pendingIncidents.length = Math.min(this.pendingIncidents.length, 300);
  }

  private async editTrackedMessages(incident: TrackedIncident, embed: EmbedBuilder): Promise<void> {
    for (const reference of incident.messages) {
      const channel = await this.client.channels.fetch(reference.channelId).catch(() => null);
      if (!channel?.isTextBased() || !('messages' in channel)) continue;
      const message = await channel.messages.fetch(reference.messageId).catch(() => null);
      if (!message) continue;
      await message.edit({ embeds: [embed] }).catch((error: unknown) => {
        logger.warn({ error, incidentId: incident.id, channelId: reference.channelId }, 'Could not edit original Discord incident alert');
      });
    }
  }
}

function boroughExplicitlyStated(location?: string): IncidentIdentity['borough'] | undefined {
  if (!location) return undefined;
  const match = location.match(/(?:,\s*|\bin\s+|\bnear\s+)(Manhattan|Bronx|Queens|Brooklyn|Staten\s+Island)\s*$/i);
  if (!match) return undefined;
  const value = match[1]!.replace(/\s+/g, ' ').toLowerCase();
  if (value === 'manhattan') return 'Manhattan';
  if (value === 'bronx') return 'Bronx';
  if (value === 'queens') return 'Queens';
  if (value === 'brooklyn') return 'Brooklyn';
  return 'Staten Island';
}

function discordErrorCategory(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === 50001) return 'missing-access';
  if (code === 50013) return 'missing-permissions';
  if (code === 10003) return 'unknown-channel';
  if (typeof code === 'number') return 'discord-api-error';
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  if (name.includes('timeout') || name.includes('network') || name.includes('fetch')) return 'network-error';
  return 'unknown-error';
}

function buildIncidentEmbed(incident: DashboardIncident): EmbedBuilder {
  const recentUpdates = incident.updates.slice(-5).map((update) => `• ${update.summary}${update.unitIds.length ? ` [${update.unitIds.join(', ')}]` : ''}`);
  return new EmbedBuilder()
    .setTitle(incident.title)
    .setDescription([incident.summary, ...recentUpdates].join('\n\n').slice(0, 4_000))
    .addFields(
      { name: 'FDNY Box', value: incident.boxNumbers.join(', ') || 'Not identified', inline: true },
      { name: 'Address / cross streets', value: incident.location ?? 'Not stated clearly in the transmission', inline: false },
      { name: 'Responding units', value: incident.unitIds.join(', ') || 'Not identified', inline: true },
      { name: 'Newsworthiness', value: `${incident.newsworthinessScore}/5`, inline: true },
      { name: 'Buff interest', value: `${incident.buffInterestScore}/5`, inline: true },
      { name: 'Assignment desk', value: `${incident.assignmentDeskScore}/5`, inline: true },
      { name: 'Triage evidence fit', value: `${Math.round(incident.confidence * 100)}%`, inline: true },
      { name: 'Updates', value: String(incident.updateCount), inline: true }
    )
    .setFooter({ text: 'AI-assisted radio summary; verify details independently.' });
}

function audioExtension(contentType?: string): string {
  switch (contentType?.toLowerCase()) {
    case 'audio/mp4':
    case 'video/mp4': return 'mp4';
    case 'audio/wav':
    case 'audio/x-wav': return 'wav';
    case 'audio/aac': return 'aac';
    default: return 'mp3';
  }
}
