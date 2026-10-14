type AuditRecord = Record<string, unknown>;

type EventSummary = {
  stages: Set<string>;
  latestStage?: string;
  hasTriageLocation?: boolean;
  hasTriageRecord?: boolean;
};

const knownStages = new Set([
  'received', 'transcription', 'transcription-error', 'transcription-ignored', 'repeat-suppressed',
  'triage', 'triage-error', 'geocoding', 'correlation', 'pending-queue', 'incident-published',
  'incident-updated', 'incident-suppressed', 'incident-withheld', 'discord-routing', 'pending-expired',
  'pending-attached', 'pending-discarded', 'pending-approved', 'retry', 'error'
]);
const knownCategories = new Set(['breaking', 'newsworthy', 'funny', 'weird_unique', 'routine']);
const knownIncidentTypes = new Set(['medical', 'vehicle', 'fire', 'police', 'other']);
const knownConfidenceKinds = new Set(['triage-evidence-fit', 'legacy-unlabeled']);
const knownRoutingOutcomes = new Set([
  'alerts-sent', 'no-eligible-subscriptions', 'partially-sent', 'discord-send-failed',
  'discord-channel-fetch-failed', 'no-sendable-discord-destination',
  'no-eligible-discord-destination-or-send-failed'
]);

function isRecord(value: unknown): value is AuditRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function increment(counter: Record<string, number>, key: unknown): void {
  if (typeof key !== 'string' || !key) return;
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
  counter[key] = (counter[key] ?? 0) + 1;
}

function incrementKnown(counter: Record<string, number>, value: unknown, allowed: Set<string>): void {
  if (typeof value !== 'string') return;
  increment(counter, allowed.has(value) ? value : 'other');
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readThresholds(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const triageConfidence = typeof value.triageConfidence === 'number' ? value.triageConfidence : value.confidence;
  const names = ['public', 'buff', 'newsMedia'] as const;
  if (typeof triageConfidence !== 'number' || !Number.isFinite(triageConfidence)
    || !names.every((name) => typeof value[name] === 'number' && Number.isFinite(value[name]))) return undefined;
  const thresholds = value as Record<(typeof names)[number], number>;
  if (triageConfidence < 0 || triageConfidence > 1
    || !Number.isInteger(thresholds.public) || thresholds.public < 1 || thresholds.public > 5
    || !Number.isInteger(thresholds.buff) || thresholds.buff < 1 || thresholds.buff > 5
    || !Number.isInteger(thresholds.newsMedia) || thresholds.newsMedia < 1 || thresholds.newsMedia > 5) return undefined;
  return [`triageConfidence=${triageConfidence}`, ...names.map((name) => `${name}=${value[name]}`)].join(',');
}

/** Aggregate an exported learning log without retaining or returning transcript or other personal data. */
export async function analyzeLearningLog(lines: Iterable<string> | AsyncIterable<string>) {
  const stageRecords: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const incidentTypes: Record<string, number> = {};
  const confidenceKinds: Record<string, number> = {};
  const thresholdConfigurations: Record<string, number> = {};
  const routingOutcomes: Record<string, number> = {};
  const events = new Map<string, EventSummary>();
  let totalLines = 0;
  let validRecords = 0;
  let invalidJsonLines = 0;
  let recordsWithoutEventId = 0;
  let triageRecords = 0;
  let triageRecordsWithLocation = 0;
  let triageRecordsWithoutLocation = 0;
  let discordRoutingRecords = 0;
  let eligibleSubscriptions = 0;
  let successfulDestinations = 0;
  let channelFetchFailures = 0;
  let unsupportedDestinations = 0;
  let sendFailures = 0;

  for await (const line of lines) {
    totalLines += 1;
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { invalidJsonLines += 1; continue; }
    if (!isRecord(parsed)) { invalidJsonLines += 1; continue; }
    validRecords += 1;

    const stage = typeof parsed.stage === 'string' && knownStages.has(parsed.stage) ? parsed.stage : undefined;
    increment(stageRecords, stage);
    const eventId = typeof parsed.eventId === 'string' ? parsed.eventId : undefined;
    if (!eventId) recordsWithoutEventId += 1;
    const event = eventId ? (events.get(eventId) ?? { stages: new Set<string>() }) : undefined;
    if (event && stage) {
      event.stages.add(stage);
      event.latestStage = stage;
      if (stage === 'triage') {
        event.hasTriageRecord = true;
        event.hasTriageLocation = typeof parsed.location === 'string' && parsed.location.trim().length > 0;
      }
      events.set(eventId!, event);
    }

    if (stage === 'triage') {
      triageRecords += 1;
      const hasLocation = typeof parsed.location === 'string' && parsed.location.trim().length > 0;
      if (hasLocation) triageRecordsWithLocation += 1;
      else triageRecordsWithoutLocation += 1;
      incrementKnown(categories, parsed.category, knownCategories);
      incrementKnown(incidentTypes, parsed.incidentType, knownIncidentTypes);
      incrementKnown(
        confidenceKinds,
        typeof parsed.confidenceKind === 'string' ? parsed.confidenceKind : 'legacy-unlabeled',
        knownConfidenceKinds
      );
      const thresholds = readThresholds(parsed.thresholds);
      if (thresholds) increment(thresholdConfigurations, thresholds);
    }

    if (stage === 'discord-routing') {
      discordRoutingRecords += 1;
      incrementKnown(routingOutcomes, parsed.disposition, knownRoutingOutcomes);
      if (isRecord(parsed.routing)) {
        eligibleSubscriptions += safeCount(parsed.routing.eligibleSubscriptions);
        successfulDestinations += safeCount(parsed.routing.successfulDestinations);
        channelFetchFailures += safeCount(parsed.routing.channelFetchFailures);
        unsupportedDestinations += safeCount(parsed.routing.unsupportedDestinations);
        sendFailures += safeCount(parsed.routing.sendFailures);
      }
    }
  }

  const latestObservedStageCounts: Record<string, number> = {};
  let eventsWithReceived = 0;
  let eventsWithTriage = 0;
  let eventsMissingTriage = 0;
  let eventsMissingTranscription = 0;
  let eventsWithLocationAtTriage = 0;
  for (const event of events.values()) {
    increment(latestObservedStageCounts, event.latestStage);
    if (event.stages.has('received')) {
      eventsWithReceived += 1;
      if (!event.stages.has('triage')) eventsMissingTriage += 1;
      if (!event.stages.has('transcription')) eventsMissingTranscription += 1;
    }
    if (event.hasTriageRecord) {
      eventsWithTriage += 1;
      if (event.hasTriageLocation) eventsWithLocationAtTriage += 1;
    }
  }

  return {
    privacy: 'Aggregate counts only. Transcripts, addresses, event IDs, call IDs, and raw records are not included.',
    records: { totalLines, validRecords, invalidJsonLines, recordsWithoutEventId, stageCounts: stageRecords },
    events: {
      distinctEventIds: events.size,
      withReceived: eventsWithReceived,
      withTriage: eventsWithTriage,
      missingTriageAfterReceived: eventsMissingTriage,
      missingTranscriptionAfterReceived: eventsMissingTranscription,
      withLocationAtTriage: eventsWithLocationAtTriage,
      latestObservedStageCounts
    },
    triage: {
      records: triageRecords,
      recordsWithLocation: triageRecordsWithLocation,
      recordsWithoutLocation: triageRecordsWithoutLocation,
      categories,
      incidentTypes,
      confidenceKinds,
      thresholdConfigurations
    },
    discord: {
      routingRecords: discordRoutingRecords,
      outcomes: routingOutcomes,
      eligibleSubscriptions,
      successfulDestinations,
      channelFetchFailures,
      unsupportedDestinations,
      sendFailures
    }
  };
}
