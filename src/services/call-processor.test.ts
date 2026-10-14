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
import { LearningLog } from './learning-log.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-call-processor-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

describe('CallProcessor', () => {
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
      { async geocode() { return { latitude: 40.75, longitude: -73.98 }; } },
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
      { async geocode() { return { latitude: 40.72, longitude: -73.82 }; } }
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
      { async geocode(_location, borough) { geocodedBorough = borough; return { latitude: 40.75, longitude: -73.98 }; } }
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

  it('routes Discord notifications independently to Public, Buff, and News Media scores', async () => {
    const sentMentions: string[] = [];
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
    const processor = new CallProcessor(client, { listForCall: () => subscriptions } as unknown as SubscriptionStore, analysis, dashboard, false, 0.78, 4, undefined, 4);

    const result = await processor.process({
      id: 'buff-only-incident', agency: 'FDNY', borough: 'Queens', occurredAt: new Date(),
      transcript: 'Specialized FDNY unit assignment at 123 Main Street.'
    });

    assert.equal(result, 'alert');
    assert.equal(dashboard.search().length, 1);
    assert.deepEqual(sentMentions, ['<@&news-role>', '<@&buff-role>']);
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
      { async geocode() { return { latitude: 40.72, longitude: -73.82 }; } });
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
    const transcripts = ['[ Silence ]', '[BLANK_AUDIO]', 'No relevant information provided in the transcript.'];
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

    for (let index = 0; index < 3; index += 1) {
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
});