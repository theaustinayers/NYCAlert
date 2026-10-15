import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { after, describe, it } from 'node:test';
import type { CallAnalysisProvider } from '../providers/ai.js';
import type { SubscriptionStore } from '../storage/subscription-store.js';
import { DashboardStore } from './dashboard-store.js';
import { CallProcessor, roleMentionOptions } from './call-processor.js';
import { SourceCallLedger } from './source-call-ledger.js';
import { LearningLog } from './learning-log.js';
import type { IncidentPostPublisher, XIncidentPost } from '../providers/x-post.js';
import type { CallTriage } from '../domain/triage.js';
import type { WebhookDeliveryRequest } from '../providers/webhook-delivery.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-call-processor-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

describe('CallProcessor', () => {
  it('schedules only qualified Buff and News Media webhooks for published incidents and updates', async () => {
    const calls: WebhookDeliveryRequest[] = [];
    let index = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript supplied'); },
      async triage() {
        index += 1;
        return { shouldAlert: true, category: 'newsworthy', headline: 'Working Fire', summary: 'Units responding.', location: '100 Example Street', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4, buffInterestScore: 5, assignmentDeskScore: 4 };
      }
    };
    const delivery = { async deliver(request: WebhookDeliveryRequest) { calls.push(request); return []; } };
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, new DashboardStore(false),
      false, 0.78, 4, undefined, 4, 4, undefined, undefined, 'https://nycalert.ai', 60_000, undefined, delivery);
    const occurredAt = new Date(Date.now() - 2 * 60_000);
    await processor.process({ id: 'webhook-create', borough: 'Brooklyn', agency: 'FDNY', occurredAt, transcript: 'Working fire at 100 Example Street.' });
    await processor.process({ id: 'webhook-update', borough: 'Brooklyn', agency: 'FDNY', occurredAt: new Date(occurredAt.getTime() + 60_000), transcript: 'Primary search completed; fire extinguished at 100 Example Street.' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((call) => call.event), ['incident.created', 'incident.updated']);
    assert.deepEqual(calls[0]?.audiences, ['buff', 'news']);
    assert.deepEqual(calls[1]?.audiences, ['buff', 'news']);
  });

  it('replays a synthetic Series 5 Box sequence: pending address, explicit correction, late operational report, scoped negative', async () => {
    const triages: CallTriage[] = [
      { shouldAlert: true, category: 'newsworthy', headline: 'Reported Dwelling Fire', summary: 'Reported dwelling fire at initial address.', location: '121-11 Example Street', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4 },
      { shouldAlert: true, category: 'newsworthy', headline: 'All Hands Working Fire', summary: 'Corrected address reported; all hands working.', location: '123-45 Example Avenue', incidentType: 'fire', confidence: 0.95, newsworthinessScore: 4 },
      { shouldAlert: true, category: 'newsworthy', headline: 'Probably Will Hold', summary: 'Primary searches negative; one line operating, probably will hold.', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4 },
      { shouldAlert: false, category: 'newsworthy', headline: 'No Fire Found', summary: 'No fire found in the garage checked by a unit.', incidentType: 'other', confidence: 0.85, newsworthinessScore: 1 }
    ];
    let index = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript supplied'); },
      async triage() { return triages[index++]!; }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard,
      false, 0.78, 4, { async geocode(location) {
        return location === '123-45 Example Avenue' ? { latitude: 40.72, longitude: -73.81, precision: 'street_address' as const } : undefined;
      } });
    const base = Date.now() - 20 * 60_000;
    const texts = [
      'Box 4001, reported dwelling fire at 121-11 Example Street.',
      'Box 4001, corrected address 123-45 Example Avenue, all hands working fire.',
      'Box 4001, primary searches negative, one line operating, probably will hold.',
      'Box 4001, no fire found in the garage checked by this unit.'
    ];
    const offsets = [0, 6, 18, 19];
    for (let step = 0; step < texts.length; step += 1) {
      await processor.process({ id: `series5-synthetic-${step}`, agency: 'FDNY', borough: 'Queens',
        occurredAt: new Date(base + offsets[step]! * 60_000), transcript: texts[step]! });
      if (step === 0) assert.equal(processor.listPendingIncidents().length, 1);
    }
    const incidents = dashboard.search();
    assert.equal(incidents.length, 1);
    const incident = incidents[0]!;
    assert.equal(incident.location, '123-45 Example Avenue');
    assert.equal(incident.locationPrecision, 'street_address');
    assert.equal(incident.latitude, 40.72);
    assert.equal(incident.updateCount, 3);
    assert.match(incident.title, /^All Hands Working Fire/);
    assert.match(incident.summary, /all hands working/);
    assert.equal(incident.updates[0]?.previousLocation, '121-11 Example Street');
    assert.equal(incident.updates[0]?.isExplicitLocationCorrection, true);
    assert.match(incident.updates[2]?.summary ?? '', /garage/);
    assert.equal(processor.listPendingIncidents().length, 0);
  });

  it('does not attach an addressless Box update when two active same-Box incidents are plausible', async () => {
    let index = 0;
    const triages: CallTriage[] = [
      { shouldAlert: true, category: 'newsworthy', headline: 'Reported Fire', summary: 'Fire reported at first address.', location: '100 Example Street', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4 },
      { shouldAlert: true, category: 'newsworthy', headline: 'Reported Fire', summary: 'Fire reported at a different address.', location: '200 Other Avenue', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4 },
      { shouldAlert: false, category: 'routine', headline: 'Probably Will Hold', summary: 'One line operating; probably will hold.', incidentType: 'other', confidence: 0.9, newsworthinessScore: 1 }
    ];
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript supplied'); },
      async triage() { return triages[index++]!; }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);
    const base = Date.now() - 15 * 60_000;
    const transcripts = ['Box 4001, fire at 100 Example Street.', 'Box 4001, fire at 200 Other Avenue.', 'Box 4001, one line operating; probably will hold.'];
    for (const [step, transcript] of transcripts.entries()) {
      await processor.process({ id: `ambiguous-box-${step}`, agency: 'FDNY', borough: 'Queens', occurredAt: new Date(base + [0, 1, 14][step]! * 60_000), transcript });
    }
    assert.equal(dashboard.search().length, 2);
    assert.equal(dashboard.search().every((incident) => incident.updateCount === 0), true);
  });

  it('transcribes an audio file, triages it and publishes a qualifying incident', async () => {
    const audioPath = join(testDirectory, 'call.mp3');
    await writeFile(audioPath, Buffer.from('sample audio'));
    const calls: string[] = [];
    const analysis: CallAnalysisProvider = {
      async transcribe(path) {
        calls.push(`transcribe:${path}`);
        return 'dispatch transcript';
      },
      async triage(transcript, agency) {
        calls.push(`triage:${agency}:${transcript}`);
        return { shouldAlert: true, category: 'newsworthy', summary: 'Verified test alert.', location: '123 Main Street', confidence: 0.95, newsworthinessScore: 5 };
      }
    };
    const store = { listForCall: () => [] } as unknown as SubscriptionStore;
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, store, analysis, dashboard);

    await processor.process({
      id: 'test-call',
      borough: 'Manhattan',
      agency: 'FDNY',
      occurredAt: new Date('2026-01-01T12:00:00Z'),
      audioPath
    });

    assert.deepEqual(calls, [`transcribe:${audioPath}`, 'triage:FDNY:dispatch transcript']);
    assert.equal(dashboard.search().length, 1);
    assert.equal(dashboard.search()[0]?.category, 'newsworthy');
    assert.equal(dashboard.search()[0]?.location, '123 Main Street');
    assert.equal(dashboard.listLiveCalls().length, 1);
    assert.equal(dashboard.listLiveCalls()[0]?.summary, 'Transcript and call summary display is disabled.');
  });

  it('does not publish routine classifications', async () => {
    const audioPath = join(testDirectory, 'routine.mp3');
    await writeFile(audioPath, Buffer.from('sample audio'));
    const analysis: CallAnalysisProvider = {
      async transcribe() { return 'routine dispatch'; },
      async triage() { return { shouldAlert: false, category: 'routine', summary: 'Routine call.', confidence: 0.99, newsworthinessScore: 1 }; }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);

    await processor.process({ id: 'routine-call', borough: 'Queens', agency: 'NYPD', occurredAt: new Date(), audioPath });

    assert.equal(dashboard.search().length, 0);
    assert.equal(dashboard.listLiveCalls().length, 1);
  });

  it('uses the Broadcastify transcription without invoking local Whisper', async () => {
    const calls: string[] = [];
    const analysis: CallAnalysisProvider = {
      async transcribe() {
        calls.push('transcribe');
        throw new Error('Whisper should not be needed when API transcription exists');
      },
      async triage(transcript) {
        calls.push(`triage:${transcript}`);
        return { shouldAlert: false, category: 'routine', summary: 'Routine dispatch.', confidence: 0.98, newsworthinessScore: 1 };
      }
    };
    const dashboard = new DashboardStore(false, 300, true);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);

    const result = await processor.process({
      id: 'broadcastify-transcribed-call',
      borough: 'Manhattan',
      agency: 'FDNY',
      occurredAt: new Date(),
      transcript: 'Engine 12 responding to 123 Main Street.'
    });

    assert.equal(result, 'processed');
    assert.deepEqual(calls, ['triage:Engine 12 responding to 123 Main Street.']);
    assert.equal(dashboard.listLiveCalls()[0]?.transcript, 'Engine 12 responding to 123 Main Street.');
  });

  it('logs transcript once and links triage, geocoding, correlation, publish, and Discord outcomes by event ID', async () => {
    const log = new LearningLog(join(testDirectory, 'learning-workflow'), true, 30, 100);
    await log.init();
    const transcript = 'Engine 4 reports a fire at 123 Main Street, Manhattan.';
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Supplied transcript should be used.'); },
      async triage() {
        return {
          shouldAlert: true, category: 'newsworthy', headline: 'Reported Building Fire', summary: 'Engine 4 reports a fire.',
          location: '123 Main Street, Manhattan', incidentType: 'fire', confidence: 0.92,
          newsworthinessScore: 4, buffInterestScore: 5, assignmentDeskScore: 3
        };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard,
      false, 0.78, 4,
      { async geocode() { return { latitude: 40.75, longitude: -73.98, precision: 'street_address' as const }; } },
      4, 4, log
    );
    await processor.process({
      id: 'workflow-call-1', agency: 'FDNY', borough: 'Manhattan', occurredAt: new Date(), groupName: 'Manhattan FDNY', transcript
    });
    await log.flush();

    const events = await log.readRecent(100);
    const eventId = events.find((event) => event.stage === 'transcription')?.eventId;
    const related = events.filter((event) => event.eventId === eventId);
    assert.ok(eventId);
    assert.equal(related.filter((event) => event.transcript !== undefined).length, 1);
    assert.equal(related.find((event) => event.stage === 'transcription')?.transcript, transcript);
    assert.ok(related.some((event) => event.stage === 'triage' && event.scores?.buff === 5));
    const triageEvent = related.find((event) => event.stage === 'triage');
    assert.equal(triageEvent?.confidenceKind, 'triage-evidence-fit');
    assert.deepEqual(triageEvent?.thresholds, { triageConfidence: 0.78, public: 4, buff: 4, newsMedia: 4 });
    assert.ok(related.some((event) => event.stage === 'geocoding' && event.geocode?.matched));
    assert.ok(related.some((event) => event.stage === 'correlation'));
    assert.ok(related.some((event) => event.stage === 'incident-published'));
    assert.ok(related.some((event) => event.stage === 'discord-routing'));
    const delivery = related.find((event) => event.stage === 'discord-routing');
    assert.equal(delivery?.disposition, 'no-eligible-subscriptions');
    assert.equal(delivery?.routing?.eligibleSubscriptions, 0);
    assert.equal(delivery?.routing?.sendFailures, 0);
    assert.ok(related.filter((event) => event.category).every((event) => event.trafficType === 'incident'));
    assert.equal(related.find((event) => event.stage === 'received')?.trafficType, 'unclassified');
    assert.equal(related.some((event) => 'audioPath' in event || 'audioBytes' in event), false);
  });

  it('logs FDNY radio cues and Queens address candidates without changing the selected location', async () => {
    const log = new LearningLog(join(testDirectory, 'learning-fdny-grammar'), true, 30, 100);
    await log.init();
    const location = '158 24 81st Street';
    const transcript = `Queens Box 981, ${location}. Transmitting 10-75.`;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        return {
          shouldAlert: true, category: 'newsworthy', headline: 'Reported Fire', summary: 'Fire reported.',
          location, incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4
        };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard,
      false, 0.78, 4, undefined, 4, 4, log
    );

    await processor.process({ id: 'fdny-queens-grammar', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(), transcript });
    await log.flush();

    const triage = (await log.readRecent(100)).find((event) => event.stage === 'triage');
    assert.equal(triage?.fdnyRadioAnalysis?.grammarVersion, 'fdny-literal-signals-v1');
    assert.deepEqual(triage?.fdnyRadioAnalysis?.signals.map((signal) => transcript.slice(signal.evidence.start, signal.evidence.end)), ['Box 981', '10-75']);
    assert.equal(triage?.fdnyRadioAnalysis?.queensAddressCandidates[0]?.normalized, '158-24 81st Street');
    assert.equal(triage?.fdnyRadioAnalysis?.queensAddressCandidates[0]?.verification, 'candidate-only');
    assert.equal(dashboard.search()[0]?.location, location);
    assert.equal(dashboard.search()[0]?.latitude, undefined);
  });

  it('marks routine radio traffic as non-incident in the learning log', async () => {
    const log = new LearningLog(join(testDirectory, 'learning-routine'), true, 30, 100);
    await log.init();
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Provided transcript should be used.'); },
      async triage() { return { shouldAlert: false, category: 'routine', summary: 'Routine unit status.', confidence: 0.99, newsworthinessScore: 1 }; }
    };
    const processor = new CallProcessor(
      {} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, new DashboardStore(false),
      false, 0.78, 4, undefined, 4, 4, log
    );
    await processor.process({ id: 'routine-learning-call', agency: 'FDNY', borough: 'Manhattan', occurredAt: new Date(), transcript: 'Engine 4 returning to service.' });
    await log.flush();
    const events = await log.readRecent(20);
    assert.ok(events.length > 0);
    assert.ok(events.filter((event) => event.category).every((event) => event.trafficType === 'routine'));
    assert.equal(events.find((event) => event.stage === 'received')?.trafficType, 'unclassified');
    assert.ok(events.some((event) => event.disposition === 'below-audience-threshold-or-routine'));
  });

  it('flashes a source feed only after a confident non-routine call is saved to Live Radio', async () => {
    for (const scenario of [
      { category: 'newsworthy', confidence: 0.9, score: 3, location: undefined, flashes: true },
      { category: 'breaking', confidence: 0.9, score: 3, location: undefined, flashes: true },
      { category: 'newsworthy', confidence: 0.5, score: 3, location: undefined, flashes: false },
      { category: 'routine', confidence: 0.99, score: 1, location: undefined, flashes: false },
      { category: 'newsworthy', confidence: 0.9, score: 4, location: undefined, flashes: false }
    ] as const) {
      const dashboard = new DashboardStore(false);
      dashboard.setFeedStatusProvider(() => [{
        id: 'source-bronx', name: 'Bronx Dispatch', agency: 'FDNY', borough: 'Bronx', state: 'online', callsSeen: 1
      }]);
      const analysis: CallAnalysisProvider = {
        async transcribe() { throw new Error('Provided transcript should be used'); },
        async triage() { return {
          shouldAlert: scenario.category !== 'routine', category: scenario.category,
          summary: 'Radio report for test.', confidence: scenario.confidence,
          newsworthinessScore: scenario.score, location: scenario.location
        }; }
      };
      const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);
      await processor.process({
        id: 'source-alert-test', agency: 'FDNY', borough: 'Bronx', occurredAt: new Date(),
        transcript: 'Radio report from the Bronx channel.'
      });
      assert.equal(Boolean(dashboard.getFeedStatuses()[0]?.alertSeverity), scenario.flashes);
      if (scenario.flashes) assert.equal(dashboard.listLiveCalls().length, 1);
    }
  });

  it('downloads incident audio only after triage qualifies an incident', async () => {
    let audioLoads = 0;
    const audioPath = join(testDirectory, 'incident-only.mp3');
    await writeFile(audioPath, Buffer.from('approved incident audio'));
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Whisper is not needed'); },
      async triage() { return { shouldAlert: true, category: 'newsworthy', summary: 'A clear qualifying incident.', location: '123 Main Street', confidence: 0.95, newsworthinessScore: 5 }; }
    };
    const dashboard = new DashboardStore(true);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);

    await processor.process({
      id: 'incident-audio-call', borough: 'Manhattan', agency: 'FDNY', occurredAt: new Date(),
      transcript: 'A confirmed serious incident at 123 Main Street.'
    }, async () => {
      audioLoads += 1;
      return { path: audioPath, contentType: 'audio/mpeg' };
    });

    assert.equal(audioLoads, 1);
    assert.equal(dashboard.search()[0]?.hasAudio, true);
    assert.equal(dashboard.listLiveCalls()[0]?.hasAudio, false);
  });

  it('adds a routine unit status follow-up to the matching incident without a second alert', async () => {
    let triageNumber = 0;
    const analyses: CallAnalysisProvider = {
      async transcribe() { throw new Error('Broadcastify transcription is supplied'); },
      async triage() {
        triageNumber += 1;
        return triageNumber === 1
          ? { shouldAlert: true, category: 'newsworthy', summary: 'Vehicle crash reported at 123 Main Street.', location: '123 Main Street', incidentType: 'vehicle', confidence: 0.95, newsworthinessScore: 4 }
          : { shouldAlert: false, category: 'routine', summary: 'Engine 12 is back in service after the call.', incidentType: 'other', confidence: 0.94, newsworthinessScore: 1 };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client,
      { listForCall: () => [] } as unknown as SubscriptionStore,
      analyses,
      dashboard,
      false,
      0.78,
      4,
      { async geocode() { return { latitude: 40.72, longitude: -73.82, precision: 'street_address' as const }; } }
    );
    const occurredAt = new Date();

    const firstResult = await processor.process({
      id: 'incident-1', agency: 'FDNY', borough: 'Queens', occurredAt,
      transcript: 'Engine 12 reports vehicle crash at 123 Main Street, requesting response.'
    });
    const updateResult = await processor.process({
      id: 'incident-2', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(occurredAt.getTime() + 60_000),
      transcript: 'Engine 12 is back in service after the call.'
    });

    assert.equal(firstResult, 'alert');
    assert.equal(updateResult, 'processed');
    assert.equal(dashboard.search().length, 1);
    assert.equal(dashboard.search()[0]?.updateCount, 1);
    assert.deepEqual(dashboard.search()[0]?.unitIds, ['ENGINE 12']);
    assert.match(dashboard.search()[0]?.updates[0]?.summary ?? '', /back in service/);
  });

  it('keeps one incident when the same address and fire arrive from three borough feeds', async () => {
    const summaries = [
      'Second alarm fire in an apartment.',
      'Second alarm transmitted for fire on the top floor.',
      'Second alarm for fire in multiple dwellings.'
    ];
    const locations = [
      '598 West 178 Street',
      '598 West 178th Street between Saint Nicholas Avenue and Audubon Avenue',
      '598 West 178 Street'
    ];
    let triageIndex = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Broadcastify transcript is supplied'); },
      async triage() {
        const index = triageIndex++;
        return {
          shouldAlert: true,
          category: 'breaking',
          headline: 'Second Alarm Fire',
          summary: summaries[index]!,
          location: locations[index]!,
          incidentType: 'fire',
          confidence: 0.9,
          newsworthinessScore: 4
        };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);
    const occurredAt = new Date();

    const first = await processor.process({
      id: 'manhattan-feed-call', agency: 'FDNY', borough: 'Manhattan', occurredAt,
      transcript: 'Second alarm fire at 598 West 178 Street.'
    });
    const second = await processor.process({
      id: 'staten-island-feed-call', agency: 'FDNY', borough: 'Staten Island', occurredAt: new Date(occurredAt.getTime() + 5_000),
      transcript: 'Second alarm fire at 598 West 178 Street.'
    });
    const third = await processor.process({
      id: 'queens-feed-call', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(occurredAt.getTime() + 10_000),
      transcript: 'Second alarm fire at 598 West 178 Street.'
    });

    const incidents = dashboard.search();
    assert.equal(first, 'alert');
    assert.equal(second, 'processed');
    assert.equal(third, 'processed');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.borough, 'Manhattan');
    assert.equal(incidents[0]?.updateCount, 2);
  });

  it('keeps the audit-derived West Farms fire as one incident across feed-borough mismatches and attaches control status', async () => {
    const triages = [
      { shouldAlert: true, category: 'breaking', headline: 'Heavy Fire Reported', summary: 'Heavy fire reported at a commercial building; second alarm transmitted.', location: '1717 West Farms Rd', incidentType: 'fire', confidence: 0.92, newsworthinessScore: 5 },
      { shouldAlert: true, category: 'newsworthy', headline: 'Second Alarm Transmitted', summary: 'Second alarm transmitted at 1717 West Farms Road; defensive operation reported.', location: '1717 West Farms Road', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4 },
      { shouldAlert: false, category: 'routine', headline: 'Fire Under Control', summary: 'Fire reported under control at 1717 West Farms Road.', location: '1717 West Farms Road, Bronx', incidentType: 'other', confidence: 0.85, newsworthinessScore: 1 }
    ] as const;
    let index = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Broadcastify transcript is supplied'); },
      async triage() { return triages[index++]!; }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);
    const startedAt = new Date();

    assert.equal(await processor.process({
      id: 'west-farms-bronx-original', agency: 'FDNY', borough: 'Bronx', occurredAt: startedAt,
      transcript: 'Heavy fire reported, Box 2908, 1717 West Farms Road, second alarm.'
    }), 'alert');
    assert.equal(await processor.process({
      id: 'west-farms-queens-simulcast', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(startedAt.getTime() + 13 * 60_000),
      transcript: 'Second alarm transmitted, Box 2910, 1717 West Farms Road, defensive operation.'
    }), 'processed');
    assert.equal(await processor.process({
      id: 'west-farms-manhattan-control', agency: 'FDNY', borough: 'Manhattan', occurredAt: new Date(startedAt.getTime() + 16 * 60_000),
      transcript: 'Fire under control, 1717 West Farms Road, Bronx.'
    }), 'processed');

    const incidents = dashboard.search();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.borough, 'Bronx');
    assert.equal(incidents[0]?.updateCount, 2);
    assert.equal(incidents[0]?.updates[1]?.headline, 'Fire Under Control');
    assert.equal(processor.listPendingIncidents().length, 0);
  });

  it('flashes a feed only after a Newsworthy call is recorded in Live Radio, not for a private pending report', async () => {
    const dashboard = new DashboardStore(false);
    dashboard.setFeedStatusProvider(() => [{
      id: 'fdny-queens', name: 'FDNY Queens', agency: 'FDNY', borough: 'Queens', state: 'online', callsSeen: 0
    }]);
    let triageCount = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Broadcastify transcript is supplied'); },
      async triage() {
        triageCount += 1;
        return triageCount === 1
          ? { shouldAlert: false, category: 'newsworthy', headline: 'Smoke Investigation', summary: 'Smoke investigation reported.', location: 'Queens', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 2 }
          : { shouldAlert: true, category: 'breaking', headline: 'Reported Structure Fire', summary: 'Structure fire reported.', incidentType: 'fire', confidence: 0.95, newsworthinessScore: 5 };
      }
    };
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);

    await processor.process({
      id: 'visible-newsworthy-call', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(), transcript: 'Smoke investigation in Queens.'
    });
    assert.equal(dashboard.listLiveCalls().length, 1);
    assert.equal(dashboard.getFeedStatuses()[0]?.alertSeverity, 'newsworthy');

    const pendingDashboard = new DashboardStore(false);
    pendingDashboard.setFeedStatusProvider(() => [{
      id: 'fdny-bronx', name: 'FDNY Bronx', agency: 'FDNY', borough: 'Bronx', state: 'online', callsSeen: 0
    }]);
    const pendingProcessor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, {
      async transcribe() { throw new Error('Broadcastify transcript is supplied'); },
      async triage() {
        return { shouldAlert: true, category: 'breaking', headline: 'Reported Structure Fire', summary: 'Structure fire reported.', incidentType: 'fire', confidence: 0.95, newsworthinessScore: 5 };
      }
    }, pendingDashboard);
    await pendingProcessor.process({
      id: 'private-pending-call', agency: 'FDNY', borough: 'Bronx', occurredAt: new Date(), transcript: 'Structure fire, location unclear.'
    });
    assert.equal(pendingProcessor.listPendingIncidents().length, 1);
    assert.equal(pendingDashboard.listLiveCalls().length, 0);
    assert.equal(pendingDashboard.getFeedStatuses()[0]?.alertSeverity, undefined);
  });

  it('groups corroborating EDP train-car fire reports when one transcript only names the borough', async () => {
    let triageIndex = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Broadcastify transcript is supplied'); },
      async triage() {
        const second = triageIndex++ > 0;
        return {
          shouldAlert: true,
          category: 'newsworthy',
          headline: second ? 'EDP Setting Fires' : 'Reported EDP Fire',
          summary: second ? 'EDP setting fires in train car at Brooklyn Center Station.' : 'Reported fire set by EDP in train car.',
          location: second ? '2345 Atlantic Avenue, Brooklyn' : 'Brooklyn',
          incidentType: 'fire',
          confidence: 0.9,
          newsworthinessScore: 4
        };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);
    const occurredAt = new Date();

    const firstResult = await processor.process({
      id: 'edp-report-call', agency: 'FDNY', borough: 'Brooklyn', occurredAt,
      transcript: 'Box alarm activation. Reported fire set by EDP in train car in Brooklyn.'
    });
    const secondResult = await processor.process({
      id: 'edp-station-call', agency: 'FDNY', borough: 'Brooklyn', occurredAt: new Date(occurredAt.getTime() + 45_000),
      transcript: 'EDP setting fires in train car at Brooklyn Center Station, 2345 Atlantic Avenue.'
    });

    const incidents = dashboard.search();
    assert.equal(firstResult, 'alert');
    assert.equal(secondResult, 'processed');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.updateCount, 1);
    assert.match(incidents[0]?.title ?? '', /^Box Alarm For EDP Train Car Fire \|/);
  });

  it('holds qualified locationless reports privately until a uniquely corroborating located call arrives', async () => {
    let triageIndex = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        const located = triageIndex++ > 0;
        return {
          shouldAlert: true,
          category: 'newsworthy',
          headline: 'Reported EDP Train Fire',
          summary: located ? 'Reported EDP fire in train car at 123 Main Street.' : 'Reported EDP fire in train car.',
          ...(located ? { location: '123 Main Street' } : {}),
          incidentType: 'fire',
          confidence: 0.9,
          newsworthinessScore: 4
        };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);
    const occurredAt = new Date();

    const pendingResult = await processor.process({
      id: 'unlocated-edp-call', agency: 'FDNY', borough: 'Manhattan', occurredAt,
      transcript: 'EDP fire in train car, location unknown.'
    });
    assert.equal(pendingResult, 'processed');
    assert.equal(dashboard.search().length, 0);
    assert.equal(dashboard.listLiveCalls().length, 0);

    const locatedResult = await processor.process({
      id: 'located-edp-call', agency: 'FDNY', borough: 'Manhattan', occurredAt: new Date(occurredAt.getTime() + 60_000),
      transcript: 'EDP fire in train car at 123 Main Street.'
    });
    const incidents = dashboard.search();
    assert.equal(locatedResult, 'alert');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.updateCount, 1);
    assert.equal(dashboard.listLiveCalls().length, 1);
    assert.match(incidents[0]?.updates[0]?.summary ?? '', /Earlier unlocated radio report/);
  });

  it('uses a geocoder-confirmed explicitly stated borough instead of a mismatched radio feed label', async () => {
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        return {
          shouldAlert: true, category: 'newsworthy', headline: 'Second Alarm Under Control',
          summary: 'Second alarm at Brooklyn Avenue, Manhattan is under control.',
          location: 'Brooklyn Avenue, Manhattan', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4
        };
      }
    };
    let geocodedBorough = '';
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client,
      { listForCall: () => [] } as unknown as SubscriptionStore,
      analysis,
      dashboard,
      false,
      0.78,
      4,
      { async geocode(_location, borough) { geocodedBorough = borough; return { latitude: 40.75, longitude: -73.98, precision: 'street_address' as const }; } }
    );

    await processor.process({
      id: 'manhattan-address-queens-radio', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(),
      transcript: 'Second alarm under control, Brooklyn Avenue, Manhattan.'
    });

    assert.equal(geocodedBorough, 'Manhattan');
    assert.equal(dashboard.search()[0]?.borough, 'Manhattan');
    assert.equal(dashboard.listLiveCalls()[0]?.borough, 'Manhattan');
  });

  it('withholds a conflicting-borough address from public feeds when geocoding cannot confirm it', async () => {
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        return {
          shouldAlert: true, category: 'newsworthy', headline: 'Second Alarm',
          summary: 'A second alarm at 598 West 178 Street, Manhattan.',
          location: '598 West 178 Street, Manhattan', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4
        };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client,
      { listForCall: () => [] } as unknown as SubscriptionStore,
      analysis,
      dashboard,
      false,
      0.78,
      4,
      { async geocode() { return undefined; } }
    );

    await processor.process({
      id: 'cross-borough-address-no-geocode', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(),
      transcript: 'Second alarm, 598 West 178 Street, Manhattan.'
    });

    assert.equal(dashboard.search().length, 0);
    assert.equal(dashboard.listLiveCalls().length, 0);
  });

  it('never treats a borough-only geocoder result as an incident pin', async () => {
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        return {
          shouldAlert: true, category: 'newsworthy', headline: 'Reported Fire', summary: 'Fire reported in Queens.',
          location: 'Queens', incidentType: 'fire', confidence: 0.95, newsworthinessScore: 4
        };
      }
    };
    let geocoderCalls = 0;
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard,
      false, 0.78, 4,
      { async geocode() { geocoderCalls += 1; return { latitude: 40.7135078, longitude: -73.8283132, precision: 'borough' as const }; } }
    );

    await processor.process({
      id: 'borough-only-location', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(),
      transcript: 'Fire reported in Queens.'
    });

    assert.equal(geocoderCalls, 0);
    assert.equal(dashboard.search().length, 0);
    assert.equal(processor.listPendingIncidents()[0]?.location, 'Queens');
    assert.equal(dashboard.listMapIncidents().length, 0);
  });

  it('routes Discord notifications independently to Public, Buff, and News Media scores', async () => {
    const sentMentions: string[] = [];
    let xPosts = 0;
    const channel = {
      isTextBased: () => true,
      async send(options: { content?: string }) {
        sentMentions.push(options.content ?? 'no mention');
        return { id: `message-${sentMentions.length}` };
      }
    };
    const client = { channels: { async fetch() { return channel; } } } as unknown as Client;
    const subscriptions = [
      { guildId: 'g', channelId: 'public-channel', borough: 'Queens' as const, agency: 'FDNY' as const, audience: 'public' as const, notifyRoleId: 'public-role' },
      { guildId: 'g', channelId: 'news-channel', borough: 'Queens' as const, agency: 'FDNY' as const, audience: 'news' as const, notifyRoleId: 'news-role' },
      { guildId: 'g', channelId: 'buff-channel', borough: 'Queens' as const, agency: 'FDNY' as const, audience: 'buff' as const, notifyRoleId: 'buff-role' }
    ];
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Broadcastify transcript is supplied'); },
      async triage() {
        return {
          shouldAlert: false, category: 'newsworthy', headline: 'Special Unit Assignment',
          summary: 'Specialized FDNY units assigned; incident details remain limited.',
          location: '123 Main Street', incidentType: 'other', confidence: 0.95,
          newsworthinessScore: 3, buffInterestScore: 5, assignmentDeskScore: 4
        };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(client, { listForCall: () => subscriptions } as unknown as SubscriptionStore, analysis, dashboard, false, 0.78, 4, undefined, 4, 4, undefined, {
      async publishIncident() { xPosts += 1; return { postId: 'unused', text: '', url: '' }; }
    });

    const result = await processor.process({
      id: 'buff-only-incident', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(),
      transcript: 'Specialized FDNY unit assignment at 123 Main Street.'
    });

    assert.equal(result, 'alert');
    assert.equal(dashboard.search().length, 1);
    assert.deepEqual(sentMentions, ['<@&news-role>', '<@&buff-role>']);
    assert.equal(xPosts, 0, 'a high Buff score without Public qualification must not be posted to X');
  });

  it('posts one Public-qualified new incident to X and does not repost its follow-up update', async () => {
    const posts: XIncidentPost[] = [];
    const publisher: IncidentPostPublisher = {
      async publishIncident(incident) {
        posts.push(incident);
        return { postId: '123456789', text: 'created', url: 'https://x.com/i/web/status/123456789' };
      }
    };
    let triageCount = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        triageCount += 1;
        return triageCount === 1
          ? { shouldAlert: true, category: 'newsworthy', headline: 'Reported Building Fire', summary: 'Fire reported.', location: '123 Main Street', incidentType: 'fire', confidence: 0.95, newsworthinessScore: 4 }
          : { shouldAlert: false, category: 'routine', summary: 'Engine 12 is on scene.', location: '123 Main Street', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 1 };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard,
      false, 0.78, 4, undefined, 4, 4, new LearningLog(join(testDirectory, 'x-publish-test'), false), publisher, 'https://nycalert.ai', 0
    );
    const occurredAt = new Date();

    await processor.process({ id: 'x-new-incident', agency: 'FDNY', borough: 'Manhattan', occurredAt, transcript: 'Fire at 123 Main Street.' });
    await processor.process({ id: 'x-incident-follow-up', agency: 'FDNY', borough: 'Manhattan', occurredAt: new Date(occurredAt.getTime() + 60_000), transcript: 'Engine 12 is on scene at 123 Main Street.' });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.headline, 'Reported Building Fire');
    assert.equal(posts[0]?.location, '123 Main Street');
    assert.equal(dashboard.search()[0]?.updateCount, 1);
  });

  it('withholds medical incidents from automatic X posting', async () => {
    let posts = 0;
    const publisher: IncidentPostPublisher = {
      async publishIncident() {
        posts += 1;
        return { postId: '123456789', text: 'created', url: 'https://x.com/i/web/status/123456789' };
      }
    };
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        return {
          shouldAlert: true, category: 'newsworthy', headline: 'Medical Emergency Reported',
          summary: 'Medical response reported.', location: '123 Main Street', incidentType: 'medical',
          confidence: 0.95, newsworthinessScore: 4
        };
      }
    };
    const processor = new CallProcessor(
      {} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, new DashboardStore(false),
      false, 0.78, 4, undefined, 4, 4, new LearningLog(join(testDirectory, 'x-medical-private'), false), publisher,
      'https://nycalert.ai', 0
    );

    await processor.process({
      id: 'medical-x-withheld', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(),
      transcript: 'Medical emergency reported at 123 Main Street.'
    });

    assert.equal(posts, 0);
  });

  it('suppresses a replayed source call ID before a second triage or incident publication', async () => {
    const ledger = new SourceCallLedger(join(testDirectory, 'source-call-idempotency'));
    await ledger.init();
    let triageCalls = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        triageCalls += 1;
        return {
          shouldAlert: true, category: 'newsworthy', headline: 'Reported Fire', summary: 'Fire reported.',
          location: '123 Main Street', incidentType: 'fire', confidence: 0.95, newsworthinessScore: 4
        };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard,
      false, 0.78, 4, undefined, 4, 4, new LearningLog(join(testDirectory, 'source-call-idempotency-log'), false),
      undefined, 'https://nycalert.ai', 0, ledger
    );
    const call = {
      id: 'same-broadcastify-call-id', agency: 'FDNY' as const, borough: 'Brooklyn' as const,
      occurredAt: new Date(), transcript: 'Fire reported at 123 Main Street.'
    };

    try {
      assert.equal(await processor.process(call), 'alert');
      assert.equal(await processor.process(call), 'ignored');
      assert.equal(triageCalls, 1);
      assert.equal(dashboard.search().length, 1);
    } finally {
      ledger.close();
    }
  });

  it('waits before posting to X and includes fields from a correlated follow-up', async () => {
    const posts: XIncidentPost[] = [];
    const publisher: IncidentPostPublisher = {
      async publishIncident(incident) {
        posts.push(incident);
        return { postId: '987654321', text: 'created', url: 'https://x.com/i/web/status/987654321' };
      }
    };
    let triageCount = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        triageCount += 1;
        return triageCount === 1
          ? { shouldAlert: true, category: 'newsworthy', headline: 'Reported Building Fire', summary: 'Fire reported.', location: '123 Main Street', incidentType: 'fire', confidence: 0.95, newsworthinessScore: 4 }
          : { shouldAlert: false, category: 'routine', summary: 'Ladder 3 reports to the fire; Box 1234.', location: '123 Main Street', incidentType: 'fire', confidence: 0.94, newsworthinessScore: 1 };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor(
      {} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard,
      false, 0.78, 4, undefined, 4, 4, new LearningLog(join(testDirectory, 'x-delayed-follow-up'), false), publisher, 'https://nycalert.ai', 100
    );
    const occurredAt = new Date();

    await processor.process({
      id: 'x-delayed-first-call', agency: 'FDNY', borough: 'Manhattan', occurredAt,
      transcript: 'Engine 12 reports a fire at 123 Main Street.'
    });
    assert.equal(posts.length, 0);
    await processor.process({
      id: 'x-delayed-follow-up', agency: 'FDNY', borough: 'Manhattan', occurredAt: new Date(occurredAt.getTime() + 15_000),
      transcript: 'Ladder 3 reports to the fire at 123 Main Street. Box 1234.'
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]?.unitIds, ['ENGINE 12', 'LADDER 3']);
    assert.deepEqual(posts[0]?.boxNumbers, ['BOX 1234']);
  });

  it('records Discord send failures separately from empty subscription matches', async () => {
    const log = new LearningLog(join(testDirectory, 'learning-discord-send-failure'), true, 30, 100);
    await log.init();
    const channel = {
      isTextBased: () => true,
      async send() { throw new Error('Discord transport failed'); }
    };
    const client = { channels: { async fetch() { return channel; } } } as unknown as Client;
    const subscription = { guildId: 'guild', channelId: 'channel', borough: 'Queens' as const, agency: 'FDNY' as const, audience: 'public' as const };
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is supplied'); },
      async triage() {
        return { shouldAlert: true, category: 'newsworthy', headline: 'Reported Fire', summary: 'Fire reported.', location: '123 Main Street', incidentType: 'fire', confidence: 0.95, newsworthinessScore: 4 };
      }
    };
    const processor = new CallProcessor(
      client, { listForCall: () => [subscription] } as unknown as SubscriptionStore, analysis, new DashboardStore(false),
      false, 0.78, 4, undefined, 4, 4, log
    );

    await processor.process({ id: 'discord-send-failure', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(), transcript: 'Fire reported at 123 Main Street.' });
    await log.flush();

    const delivery = (await log.readRecent(100)).find((event) => event.stage === 'discord-routing');
    assert.equal(delivery?.disposition, 'discord-send-failed');
    assert.equal(delivery?.routing?.eligibleSubscriptions, 1);
    assert.equal(delivery?.routing?.sendFailures, 1);
    assert.deepEqual(delivery?.routing?.destinations, [{ result: 'send-failed', errorCategory: 'unknown-error' }]);
  });

  it('edits the original Discord alert on a match without sending a second role ping', async () => {
    let triageNumber = 0;
    let sends = 0;
    let edits = 0;
    let secondAllowedMentions: unknown;
    const originalMessage = {
      id: 'message-1',
      async edit() { edits += 1; }
    };
    const channel = {
      isTextBased: () => true,
      messages: { async fetch() { return originalMessage; } },
      async send(options: { allowedMentions?: unknown }) {
        sends += 1;
        secondAllowedMentions = options.allowedMentions;
        return originalMessage;
      }
    };
    const client = { channels: { async fetch() { return channel; } } } as unknown as Client;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript is included'); },
      async triage() {
        triageNumber += 1;
        return triageNumber === 1
          ? { shouldAlert: true, category: 'newsworthy', summary: 'Vehicle crash at 123 Main Street.', location: '123 Main Street', incidentType: 'vehicle', confidence: 0.96, newsworthinessScore: 4 }
          : { shouldAlert: false, category: 'routine', summary: 'Engine 12 returning to service.', incidentType: 'other', confidence: 0.94, newsworthinessScore: 1 };
      }
    };
    const subscription = { guildId: 'guild', channelId: 'channel', borough: 'Queens' as const, agency: 'FDNY' as const, notifyRoleId: 'role-123' };
    const store = { listForCall: () => [subscription] } as unknown as SubscriptionStore;
    const processor = new CallProcessor(client, store, analysis, new DashboardStore(false), false, 0.78, 4,
      { async geocode() { return { latitude: 40.72, longitude: -73.82, precision: 'street_address' as const }; } });
    const occurredAt = new Date();

    await processor.process({ id: 'first-message-call', agency: 'FDNY', borough: 'Queens', occurredAt, transcript: 'Engine 12 reports a vehicle crash at 123 Main Street.' });
    await processor.process({ id: 'follow-up-call', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(occurredAt.getTime() + 60_000), transcript: 'Engine 12 returning to service.' });

    assert.equal(sends, 1);
    assert.equal(edits, 1);
    assert.deepEqual(secondAllowedMentions, { parse: [], roles: ['role-123'] });
  });

  it('does not download incident audio for routine calls', async () => {
    let audioLoads = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Whisper is not needed'); },
      async triage() { return { shouldAlert: false, category: 'routine', summary: 'Routine unit status update.', confidence: 0.95, newsworthinessScore: 1 }; }
    };
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, new DashboardStore(true));

    await processor.process({
      id: 'routine-no-audio', borough: 'Manhattan', agency: 'FDNY', occurredAt: new Date(),
      transcript: 'Rescue 1 back in service.'
    }, async () => {
      audioLoads += 1;
      throw new Error('Routine calls must not download audio');
    });

    assert.equal(audioLoads, 0);
  });

  it('restricts alert mentions to unique subscription roles only', () => {
    const options = roleMentionOptions([
      { guildId: 'g', channelId: 'c', borough: 'Manhattan', agency: 'FDNY', notifyRoleId: 'role-a' },
      { guildId: 'g', channelId: 'c', borough: 'Brooklyn', agency: 'FDNY', notifyRoleId: 'role-a' },
      { guildId: 'g', channelId: 'c', borough: 'Queens', agency: 'FDNY', notifyRoleId: 'role-b' },
      { guildId: 'g', channelId: 'c', borough: 'Queens', agency: 'NYPD' }
    ]);

    assert.equal(options.content, '<@&role-a> <@&role-b>');
    assert.deepEqual(options.allowedMentions, { parse: [], roles: ['role-a', 'role-b'] });
    assert.deepEqual(roleMentionOptions([]), { allowedMentions: { parse: [], roles: [] } });
  });

  it('skips silence and Whisper placeholder transcripts without triaging or archiving them', async () => {
    const audioPath = join(testDirectory, 'silence.mp3');
    await writeFile(audioPath, Buffer.from('silent audio'));
    const transcripts = ['[ Silence ]', '[BLANK_AUDIO]', 'No relevant information provided in the transcript.',
      '[ Silence ] [ Silence ] [ Silence ]', '(crickets chirping)\n(crickets chirping)',
      '[static] (indistinct radio chatter) [radio noise]', '[Unintelligible]'];
    const transcriptCount = transcripts.length;
    let triageCalls = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { return transcripts.shift() ?? ''; },
      async triage() {
        triageCalls += 1;
        return { shouldAlert: false, category: 'routine', summary: 'Routine.', confidence: 1, newsworthinessScore: 1 };
      }
    };
    const dashboard = new DashboardStore(false);
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, dashboard);

    for (let index = 0; index < transcriptCount; index += 1) {
      assert.equal(await processor.process({
        id: `silent-call-${index}`,
        borough: 'Citywide',
        agency: 'NYPD',
        occurredAt: new Date(),
        audioPath
      }), 'ignored');
    }

    assert.equal(triageCalls, 0);
    assert.equal(dashboard.search().length, 0);
    assert.equal(dashboard.listLiveCalls().length, 0);
  });

  it('does not discard intelligible speech mixed with noise markers or short radio codes', async () => {
    let triageCalls = 0;
    const analysis: CallAnalysisProvider = {
      async transcribe() { throw new Error('Transcript supplied'); },
      async triage() {
        triageCalls += 1;
        return { shouldAlert: false, category: 'routine', summary: 'Radio communication.', confidence: 0.5, newsworthinessScore: 1 };
      }
    };
    const processor = new CallProcessor({} as Client, { listForCall: () => [] } as unknown as SubscriptionStore, analysis, new DashboardStore(false));
    for (const [index, transcript] of ['[static] Car 1234 requesting assistance.', '(silence) 10-4.', '[Unit requesting help]'].entries()) {
      assert.equal(await processor.process({ id: `mixed-noise-${index}`, agency: 'NYPD', borough: 'Citywide', occurredAt: new Date(), transcript }), 'processed');
    }
    assert.equal(triageCalls, 3);
  });
});