import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { DashboardIncident } from './dashboard-store.js';
import { IncidentVoteStore } from './incident-vote-store.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-incident-votes-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

const incident: DashboardIncident = {
  id: 'incident-vote-test', title: 'Reported Fire', summary: 'Fire reported.',
  occurredAt: '2026-10-14T12:00:00.000Z', updatedAt: '2026-10-14T12:00:00.000Z',
  agency: 'FDNY', borough: 'Queens', category: 'newsworthy', incidentType: 'fire',
  location: '123 Main Street', locationPrecision: 'street_address', unitIds: [], unitAssignments: [], boxNumbers: [],
  updateCount: 0, updates: [], confidence: 0.9, newsworthinessScore: 4, buffInterestScore: 4,
  assignmentDeskScore: 4, hasAudio: false
};

describe('IncidentVoteStore', () => {
  it('stores one immutable vote per device per incident and returns aggregate totals', async () => {
    const store = new IncidentVoteStore(testDirectory);
    await store.init();

    assert.deepEqual(store.castVote(incident, 'device-a', 'up'), { up: 1, down: 0, myVote: 'up', accepted: true });
    assert.deepEqual(store.castVote(incident, 'device-a', 'down'), { up: 1, down: 0, myVote: 'up', accepted: false });
    assert.deepEqual(store.castVote(incident, 'device-b', 'down'), { up: 1, down: 1, myVote: 'down', accepted: true });
    assert.deepEqual(store.getSummary(incident.id), { up: 1, down: 1, myVote: null });
    store.close();

    const reopened = new IncidentVoteStore(testDirectory);
    await reopened.init();
    assert.deepEqual(reopened.getSummary(incident.id, 'device-a'), { up: 1, down: 1, myVote: 'up' });
    reopened.close();
  });
});
