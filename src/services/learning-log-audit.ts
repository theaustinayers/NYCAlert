type AuditRecord = Record<string, unknown>;

type EventSummary = {
  stages: Set<string>;
  latestStage?: string;
  hasTriageLocation?: boolean;
  hasTriageRecord?: boolean;
  locationKind?: 'borough-only' | 'specific' | 'none';
  geocodeMatched?: boolean;
};

const knownPrecisions = new Set(['rooftop', 'street_address', 'intersection', 'road_segment', 'box_area', 'neighborhood', 'borough', 'place', 'unresolved', 'legacy-unlabeled']);
const boroughOnlyLocations = new Set(['manhattan', 'bronx', 'queens', 'brooklyn', 'staten island', 'citywide']);

const knownStages = new Set([
  'received', 'transcription', 'transcription-error', 'transcription-ignored', 'source-duplicate-suppressed', 'incident-feedback', 'repeat-suppressed',
  'triage', 'triage-error', 'geocoding', 'correlation', 'pending-queue', 'incident-published',
  'incident-updated', 'incident-suppressed', 'incident-withheld', 'discord-routing', 'x-publishing', 'pending-expired',
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
  const geocodePrecisions: Record<string, number> = {};
  const xPublishingOutcomes: Record<string, number> = {};
  const feedbackVotes: Record<string, number> = {};
  const feedbackIncidentTypes: Record<string, number> = {};
  const publishedIdsBySourceCall = new Map<string, Set<string>>();
  const events = new Map<string, EventSummary>();
  let totalLines = 0;
  let validRecords = 0;
  let invalidJsonLines = 0;
  let recordsWithoutEventId = 0;
  let triageRecords = 0;
  let triageRecordsWithLocation = 0;
  let triageRecordsWithoutLocation = 0;
  let medicalTriageRecords = 0;
  let medicalNewsQualified = 0;
  let medicalPublicQualified = 0;
  let medicalRecordsWithLocation = 0;
  let discordRoutingRecords = 0;
  let eligibleSubscriptions = 0;
  let successfulDestinations = 0;
  let channelFetchFailures = 0;
  let unsupportedDestinations = 0;
  let sendFailures = 0;
  let geocodingRecords = 0;
  let geocodeAttempts = 0;
  let geocodeMatches = 0;
  let boroughOnlyGeocodeAttempts = 0;
  let publishedRecords = 0;
  let publishedWithoutPublicQualification = 0;
  let publishedRoutineRecords = 0;
  let feedbackRecords = 0;

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
    const eventId = stage !== 'incident-feedback' && typeof parsed.eventId === 'string' ? parsed.eventId : undefined;
    if (!eventId) recordsWithoutEventId += 1;
    const event = eventId ? (events.get(eventId) ?? { stages: new Set<string>() }) : undefined;
    if (event && stage) {
      event.stages.add(stage);
      event.latestStage = stage;
      if (stage === 'triage') {
        event.hasTriageRecord = true;
        event.hasTriageLocation = typeof parsed.location === 'string' && parsed.location.trim().length > 0;
        const normalizedLocation = typeof parsed.location === 'string'
          ? parsed.location.toLowerCase().replace(/[^a-z]+/g, ' ').trim()
          : '';
        event.locationKind = !normalizedLocation ? 'none'
          : boroughOnlyLocations.has(normalizedLocation) ? 'borough-only' : 'specific';
      }
      if (stage === 'geocoding' && isRecord(parsed.geocode)) {
        event.geocodeMatched = parsed.geocode.matched === true;
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
      if (parsed.incidentType === 'medical') {
        medicalTriageRecords += 1;
        if (hasLocation) medicalRecordsWithLocation += 1;
        if (isRecord(parsed.qualifications)) {
          if (parsed.qualifications.newsMedia === true) medicalNewsQualified += 1;
          if (parsed.qualifications.public === true) medicalPublicQualified += 1;
        }
      }
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

    if (stage === 'geocoding') {
      geocodingRecords += 1;
      if (isRecord(parsed.geocode)) {
        if (parsed.geocode.attempted === true) geocodeAttempts += 1;
        if (parsed.geocode.matched === true) geocodeMatches += 1;
        if (parsed.geocode.attempted === true && parsed.geocode.precision === 'borough') boroughOnlyGeocodeAttempts += 1;
        incrementKnown(geocodePrecisions, parsed.geocode.precision ?? 'legacy-unlabeled', knownPrecisions);
      }
    }

    if (stage === 'incident-published') {
      publishedRecords += 1;
      if (parsed.category === 'routine') publishedRoutineRecords += 1;
      if (isRecord(parsed.qualifications) && parsed.qualifications.public !== true) publishedWithoutPublicQualification += 1;
      if (typeof parsed.agency === 'string' && typeof parsed.callId === 'string' && typeof parsed.incidentId === 'string') {
        const key = `${parsed.agency}\u0000${parsed.callId}`;
        const ids = publishedIdsBySourceCall.get(key) ?? new Set<string>();
        ids.add(parsed.incidentId);
        publishedIdsBySourceCall.set(key, ids);
      }
    }

    if (stage === 'x-publishing') {
      incrementKnown(xPublishingOutcomes, parsed.disposition, new Set([
        'x-post-created', 'x-post-failed', 'x-post-withheld-sensitive-medical', 'x-post-skipped-incident-unavailable'
      ]));
    }

    if (stage === 'incident-feedback') {
      feedbackRecords += 1;
      incrementKnown(feedbackVotes, parsed.feedbackVote, new Set(['up', 'down']));
      incrementKnown(feedbackIncidentTypes, parsed.incidentType, knownIncidentTypes);
    }
  }

  const latestObservedStageCounts: Record<string, number> = {};
  let eventsWithReceived = 0;
  let eventsWithTriage = 0;
  let eventsMissingTriage = 0;
  let eventsMissingTranscription = 0;
  let eventsWithLocationAtTriage = 0;
  let boroughOnlyLocationsWithMatchedGeocode = 0;
  let sourceCallsWithMultipleIncidentIds = 0;
  for (const incidentIds of publishedIdsBySourceCall.values()) {
    if (incidentIds.size > 1) sourceCallsWithMultipleIncidentIds += 1;
  }
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
      if (event.locationKind === 'borough-only' && event.geocodeMatched) boroughOnlyLocationsWithMatchedGeocode += 1;
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
      boroughOnlyLocationsWithMatchedGeocode,
      latestObservedStageCounts
    },
    triage: {
      records: triageRecords,
      recordsWithLocation: triageRecordsWithLocation,
      recordsWithoutLocation: triageRecordsWithoutLocation,
      categories,
      incidentTypes,
      confidenceKinds,
      thresholdConfigurations,
      medical: {
        records: medicalTriageRecords,
        withLocation: medicalRecordsWithLocation,
        newsMediaQualified: medicalNewsQualified,
        publicQualified: medicalPublicQualified
      }
    },
    geocoding: {
      records: geocodingRecords,
      attempts: geocodeAttempts,
      matches: geocodeMatches,
      boroughOnlyAttempts: boroughOnlyGeocodeAttempts,
      precisions: geocodePrecisions
    },
    publishing: {
      incidentPublishedRecords: publishedRecords,
      routinePublications: publishedRoutineRecords,
      recordsWithoutPublicQualification: publishedWithoutPublicQualification,
      sourceCallsWithMultipleIncidentIds
    },
    xPublishing: { records: Object.values(xPublishingOutcomes).reduce((sum, count) => sum + count, 0), outcomes: xPublishingOutcomes },
    feedback: {
      records: feedbackRecords,
      votes: feedbackVotes,
      incidentTypes: feedbackIncidentTypes
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
