import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardLiveCall } from './dashboard-store.js';
import { qualifiesForCommunityPromotion } from './community-promotion.js';

const call: DashboardLiveCall = {
  id: 'community-call', sourceId: 'broadcast-call-1', occurredAt: '2026-10-14T12:00:00.000Z',
  agency: 'FDNY', borough: 'Queens', category: 'newsworthy', summary: 'Reported gas odor.',
  confidence: 0.9, newsworthinessScore: 3, buffInterestScore: 3, assignmentDeskScore: 3,
  unitAssignments: [], boxNumbers: [], hasAudio: false
};

describe('qualifiesForCommunityPromotion', () => {
  it('requires ten upvotes, an eight-vote net margin, and adequate non-routine triage evidence', () => {
    assert.equal(qualifiesForCommunityPromotion(call, { up: 10, down: 2 }), true);
    assert.equal(qualifiesForCommunityPromotion(call, { up: 9, down: 0 }), false);
    assert.equal(qualifiesForCommunityPromotion(call, { up: 10, down: 3 }), false);
    assert.equal(qualifiesForCommunityPromotion({ ...call, confidence: 0.77 }, { up: 20, down: 0 }), false);
    assert.equal(qualifiesForCommunityPromotion({ ...call, newsworthinessScore: 2 }, { up: 20, down: 0 }), false);
    assert.equal(qualifiesForCommunityPromotion({ ...call, category: 'routine' }, { up: 100, down: 0 }), false);
  });
});
