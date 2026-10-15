import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DashboardStore } from './dashboard-store.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-dashboard-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

const input = {
  title: 'Newsworthy incident — FDNY, Manhattan',
  summary: 'A test alert summary.',
  occurredAt: new Date('2026-01-01T12:00:00Z'),
  agency: 'FDNY' as const,
  borough: 'Manhattan' as const,
  category: 'newsworthy' as const,
  confidence: 0.94,
  newsworthinessScore: 4
};

describe('DashboardStore', () => {
  it('publishes/searches curated incidents without storing audio by default', async () => {
    const store = new DashboardStore(false);
    const incident = await store.publish({ ...input, audioPath: join(testDirectory, 'not-allowed.mp3') });
    assert.equal(incident.hasAudio, false);
    assert.equal(store.search('MANHATTAN').length, 1);
    assert.equal(store.getAudio(incident.id), undefined);
  });

  it('serves audio only when public redistribution is enabled and the file exists', async () => {
    const audioPath = join(testDirectory, 'approved.mp3');
    await writeFile(audioPath, Buffer.from('test-audio'));
    const store = new DashboardStore(true);
    const incident = await store.publish({ ...input, audioPath });
    assert.equal(incident.hasAudio, true);
    assert.deepEqual(store.getAudio(incident.id), { path: audioPath, contentType: 'audio/mpeg' });
  });

  it('formats the card title as concise headline, location, agency, and borough', async () => {
    const store = new DashboardStore(false);
    const incident = await store.publish({
      ...input,
      title: 'Newsworthy incident generic fallback',
      headline: 'Retaining Wall Collapsed',
      location: 'East 201 Street between Valentine Avenue and Briggs Avenue'
    });

    assert.equal(incident.title, 'Retaining Wall Collapsed | East 201 Street between Valentine Avenue and Briggs Avenue | FDNY | Manhattan');
  });

  it('stores independent news and buff scores for audience-specific dashboard views', async () => {
    const store = new DashboardStore(false);
    const incident = await store.publish({ ...input, newsworthinessScore: 3, buffInterestScore: 5, assignmentDeskScore: 4 });
    const liveCall = await store.recordLiveCall({
      sourceId: 'score-test', occurredAt: input.occurredAt, agency: 'FDNY', borough: 'Manhattan',
      transcript: 'Elevated assignment', headline: 'Units Responding to Reported Fire', category: 'newsworthy', summary: 'Elevated assignment.',
      confidence: 0.9, newsworthinessScore: 3, buffInterestScore: 5, assignmentDeskScore: 4
    });

    assert.equal(incident.newsworthinessScore, 3);
    assert.equal(incident.buffInterestScore, 5);
    assert.equal(incident.assignmentDeskScore, 4);
    assert.equal(liveCall.newsworthinessScore, 3);
    assert.equal(liveCall.buffInterestScore, 5);
    assert.equal(liveCall.assignmentDeskScore, 4);
    assert.equal(liveCall.headline, 'Units Responding to Reported Fire');
  });

  it('indexes explicit acting-as unit identities in incident call history', async () => {
    const store = new DashboardStore(false);
    const incident = await store.publish({
      ...input,
      unitIds: ['ENGINE 7'],
      unitAssignments: [{ unitId: 'ENGINE 7', actingAsUnitId: 'ENGINE 39' }]
    });

    assert.deepEqual(incident.unitAssignments, [{ unitId: 'ENGINE 7', actingAsUnitId: 'ENGINE 39' }]);
    assert.equal(store.search('Engine 7').length, 1);
    assert.equal(store.search('Engine 39').length, 0);
  });

  it('updates a correlated incident with unit/status history and keeps the update searchable', async () => {
    const store = new DashboardStore(false);
    const incident = await store.publish({
      ...input,
      occurredAt: new Date('2026-10-13T12:00:00Z'),
      headline: 'Reported Vehicle Crash',
      location: '123 Main Street',
      incidentType: 'vehicle',
      unitIds: ['ENGINE 12']
    });
    const updated = await store.updateIncident(incident.id, {
      headline: 'Units Returning to Service',
      summary: 'Engine 12 returned to service; Rescue 1 remains on scene.',
      occurredAt: new Date('2026-10-13T12:03:00Z'),
      unitIds: ['ENGINE 12', 'RESCUE 1'],
      confidence: 0.98,
      newsworthinessScore: 1,
      category: 'routine'
    });

    assert.equal(updated?.updateCount, 1);
    assert.equal(updated?.title, incident.title);
    assert.equal(updated?.updates[0]?.headline, 'Units Returning to Service');
    assert.deepEqual(updated?.unitIds, ['ENGINE 12', 'RESCUE 1']);
    assert.equal(updated?.newsworthinessScore, 4);
    assert.equal(updated?.category, 'newsworthy');
    assert.equal(store.search('Rescue 1 remains').length, 1);
  });

  it('preserves primary agency while recording a cross-agency follow-up source', async () => {
    const store = new DashboardStore(false);
    const incident = await store.publish({ ...input, headline: 'Reported Fire', incidentType: 'fire' });
    const updated = await store.updateIncident(incident.id, {
      agency: 'NYPD', headline: 'Units Assisting', summary: 'NYPD reports units assisting at the fire.',
      occurredAt: new Date('2026-01-01T12:03:00Z'), unitIds: ['NYPD CAR 1234'], confidence: 0.9,
      newsworthinessScore: 4, category: 'newsworthy'
    });

    assert.equal(updated?.agency, 'FDNY');
    assert.deepEqual(updated?.agencies, ['FDNY', 'NYPD']);
    assert.equal(updated?.updates[0]?.agency, 'NYPD');
  });

  it('surfaces a community-selected live call once and labels it as unverified', async () => {
    const store = new DashboardStore(false);
    const call = await store.recordLiveCall({
      sourceId: 'community-source-call', occurredAt: input.occurredAt, agency: 'FDNY', borough: 'Queens',
      transcript: 'Reported gas odor.', category: 'newsworthy', incidentType: 'other', summary: 'Reported gas odor.',
      confidence: 0.9, newsworthinessScore: 3
    });
    const promoted = await store.promoteLiveCallFromCommunity(call.id, { up: 10, down: 2 });
    const repeated = await store.promoteLiveCallFromCommunity(call.id, { up: 12, down: 2 });
    assert.equal(promoted?.communitySelected, true);
    assert.equal(promoted?.communitySourceCallId, call.id);
    assert.match(promoted?.summary ?? '', /Community support is not incident verification/);
    assert.equal(repeated?.id, promoted?.id);

    const routine = await store.recordLiveCall({
      sourceId: 'routine-source-call', occurredAt: input.occurredAt, agency: 'FDNY', borough: 'Queens',
      transcript: 'Routine status.', category: 'routine', summary: 'Routine status.', confidence: 1, newsworthinessScore: 1
    });
    assert.equal(await store.promoteLiveCallFromCommunity(routine.id, { up: 100, down: 0 }), undefined);
  });

  it('adds recent FDNY call activity and timed per-feed Newsworthy/Breaking flash state', () => {
    const store = new DashboardStore(false);
    const now = Date.now();
    store.setFeedStatusProvider(() => [{
      id: 'fdny-queens', name: 'FDNY Queens Dispatch', agency: 'FDNY', borough: 'Queens', state: 'online', callsSeen: 4
    }]);
    store.recordFeedCallActivity('FDNY', 'Queens', now);
    store.setFeedCallAlert('FDNY', 'Queens', 'newsworthy', now);
    let status = store.getFeedStatuses()[0]!;
    assert.equal(status.meterSource, 'call-activity');
    assert.ok(status.callActivityLevels?.some((level) => level > 0));
    assert.equal(status.alertSeverity, 'newsworthy');
    assert.equal(Date.parse(status.alertUntil!) - now, 15_000);

    store.setFeedCallAlert('FDNY', 'Queens', 'breaking', now + 1);
    status = store.getFeedStatuses()[0]!;
    assert.equal(status.alertSeverity, 'breaking');
    assert.equal(Date.parse(status.alertUntil!) - now, 30_001);
  });

  it('exposes processed NYPD call time separately from its PCM audio-level telemetry', () => {
    const store = new DashboardStore(false);
    const now = Date.now();
    store.setFeedStatusProvider(() => [{
      id: 'nypd-citywide', name: 'NYPD Citywide', agency: 'NYPD', borough: 'Citywide', state: 'online',
      callsSeen: 2, audioLevels: Array.from({ length: 48 }, () => 0), meterSource: 'pcm'
    }]);
    store.recordFeedCallActivity('NYPD', 'Citywide', now);

    const status = store.getFeedStatuses()[0]!;
    assert.equal(status.meterSource, 'pcm');
    assert.equal(status.audioLevels?.every((level) => level === 0), true);
    assert.equal(status.callActivityAt, new Date(now).toISOString());
    assert.equal(status.callActivityLevels?.some((level) => level > 0), true);
  });

  it('upgrades a generic incident title when a follow-up identifies smoke from the roof', async () => {
    const store = new DashboardStore(false);
    const incident = await store.publish({
      ...input,
      category: 'newsworthy',
      title: 'Routine Unit Status Update',
      headline: 'Routine Unit Status Update',
      location: 'Location Unconfirmed'
    });
    const updated = await store.updateIncident(incident.id, {
      headline: 'Smoke From Roof',
      summary: 'Units report smoke coming from the roof.',
      occurredAt: new Date('2026-01-01T12:03:00Z'),
      unitIds: ['ENGINE 12'],
      confidence: 0.92,
      newsworthinessScore: 3,
      category: 'routine'
    });

    assert.equal(updated?.title, 'Smoke From Roof | Location Unconfirmed | FDNY | Manhattan');
  });

  it('does not downgrade a specific incident headline to a generic routine update', async () => {
    const store = new DashboardStore(false);
    const incident = await store.publish({ ...input, headline: 'Smoke From Roof' });
    const updated = await store.updateIncident(incident.id, {
      headline: 'Routine Unit Status Update',
      summary: 'Engine 12 is investigating.',
      occurredAt: new Date('2026-01-01T12:03:00Z'),
      unitIds: ['ENGINE 12'],
      confidence: 0.92,
      newsworthinessScore: 1,
      category: 'routine'
    });

    assert.match(updated?.title ?? '', /^Smoke From Roof \|/);
  });

  it('keeps the 30-minute map window separate from incident search and requires valid NYC coordinates', async () => {
    const store = new DashboardStore(false);
    await store.publish({ ...input, occurredAt: new Date('2026-10-13T12:00:00Z'), latitude: 40.7, longitude: -73.9, locationPrecision: 'street_address', incidentType: 'vehicle' });
    await store.publish({ ...input, title: 'No coordinates', occurredAt: new Date('2026-10-13T12:01:00Z') });
    await store.publish({ ...input, title: 'Old map record', occurredAt: new Date('2026-10-13T11:00:00Z'), latitude: 40.7, longitude: -73.9, locationPrecision: 'street_address' });

    assert.equal(store.search().length, 3);
    const mapIncidents = store.listMapIncidents(Date.parse('2026-10-13T12:05:00Z'));
    assert.equal(mapIncidents.length, 1);
    assert.equal(mapIncidents[0]?.incidentType, 'vehicle');
  });

  it('clears a pin after an admin changes the address and removes deleted incidents from the map', async () => {
    const store = new DashboardStore(false);
    const changed = await store.publish({
      ...input, title: 'Original incident', headline: 'Original incident', location: '123 Main Street',
      occurredAt: new Date('2026-10-13T12:00:00Z'), latitude: 40.75, longitude: -73.98, locationPrecision: 'street_address'
    });
    const edited = await store.adminEditIncident(changed.id, {
      headline: 'Corrected incident location', summary: 'Admin corrected the location.', location: 'Location pending verification'
    });

    assert.equal(edited?.latitude, undefined);
    assert.equal(store.listMapIncidents(Date.now() + 60_000).length, 0);
    assert.equal(await store.deleteIncident(changed.id), true);
    assert.equal(store.search().length, 0);
    assert.equal(await store.deleteIncident(changed.id), false);
  });

  it('filters incidents and map pins by multiple selected boroughs, including none selected', async () => {
    const store = new DashboardStore(false);
    await store.publish({ ...input, borough: 'Manhattan', title: 'Manhattan call', occurredAt: new Date('2026-10-13T12:00:00Z'), latitude: 40.75, longitude: -73.98, locationPrecision: 'street_address' });
    await store.publish({ ...input, borough: 'Queens', title: 'Queens call', occurredAt: new Date('2026-10-13T12:01:00Z'), latitude: 40.72, longitude: -73.82, locationPrecision: 'street_address' });
    await store.publish({ ...input, borough: 'Brooklyn', title: 'Brooklyn call', occurredAt: new Date('2026-10-13T12:02:00Z'), latitude: 40.68, longitude: -73.95, locationPrecision: 'street_address' });

    assert.deepEqual(store.search('', ['Manhattan', 'Queens']).map((incident) => incident.borough), ['Queens', 'Manhattan']);
    assert.deepEqual(store.listMapIncidents(Date.parse('2026-10-13T12:10:00Z'), 30 * 60 * 1000, ['Queens']).map((incident) => incident.borough), ['Queens']);
    assert.equal(store.search('', []).length, 0);
    assert.equal(store.listMapIncidents(Date.parse('2026-10-13T12:10:00Z'), 30 * 60 * 1000, []).length, 0);
  });

  it('bounds retained incident count and audio references', async () => {
    const store = new DashboardStore(true, 1);
    const oldAudioPath = join(testDirectory, 'evicted.mp3');
    await writeFile(oldAudioPath, Buffer.from('old-audio'));
    const first = await store.publish({ ...input, audioPath: oldAudioPath });
    const second = await store.publish({ ...input, title: 'Second incident' });
    assert.equal(store.search().length, 1);
    assert.equal(store.search()[0]?.id, second.id);
    assert.equal(store.getAudio(first.id), undefined);
    await assert.rejects(stat(oldAudioPath));
  });

  it('keeps transcripts private by default and never retains NYPD audio', async () => {
    const audioPath = join(testDirectory, 'nypd-private.mp3');
    await writeFile(audioPath, Buffer.from('private radio audio'));
    const store = new DashboardStore(true);
    const call = await store.recordLiveCall({
      sourceId: 'nypd-test-call', occurredAt: new Date(), agency: 'NYPD', borough: 'Citywide',
      transcript: 'Sensitive test transcript', location: '123 Private Street', category: 'routine', summary: 'Routine dispatch',
      confidence: 0.9, newsworthinessScore: 1, audioPath, audioContentType: 'audio/mpeg'
    });
    assert.equal(call.transcript, undefined);
    assert.equal(call.location, undefined);
    assert.equal(call.hasAudio, false);
    assert.equal(store.getLiveCallAudio(call.id), undefined);
    assert.equal(store.listLiveCalls().length, 1);
    assert.equal(store.listLiveCalls()[0]?.summary, 'Transcript and call summary display is disabled.');
  });

  it('exposes transcript text only when the explicit public-transcript option is enabled', async () => {
    const store = new DashboardStore(false, 300, true);
    const call = await store.recordLiveCall({
      sourceId: 'fdny-test-call', occurredAt: new Date(), agency: 'FDNY', borough: 'Queens',
      transcript: 'Engine responding', location: '123 Main Street', category: 'routine', summary: 'Routine call',
      confidence: 0.8, newsworthinessScore: 2
    });
    assert.equal(call.transcript, 'Engine responding');
    assert.equal(call.location, '123 Main Street');
  });

  it('never retains audio for Live Radio Calls, even when incident playback is enabled', async () => {
    const audioPath = join(testDirectory, 'fdny-live.mp3');
    await writeFile(audioPath, Buffer.from('approved audio'));
    const store = new DashboardStore(true);
    const call = await store.recordLiveCall({
      sourceId: 'fdny-test-call', occurredAt: new Date(), agency: 'FDNY', borough: 'Queens',
      transcript: 'Engine responding', category: 'routine', summary: 'Routine call',
      confidence: 0.8, newsworthinessScore: 2, audioPath, audioContentType: 'audio/mpeg'
    });
    assert.equal(call.hasAudio, false);
    assert.equal(store.getLiveCallAudio(call.id), undefined);
  });
});
