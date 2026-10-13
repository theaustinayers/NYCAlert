import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesSubscription, type AlertSubscription } from './subscriptions.js';

const subscription: AlertSubscription = { guildId: 'g1', channelId: 'c1', borough: 'Queens', agency: 'FDNY' };

describe('matchesSubscription', () => {
  it('matches only the selected borough and agency', () => {
    assert.equal(matchesSubscription(subscription, { borough: 'Queens', agency: 'FDNY' }), true);
    assert.equal(matchesSubscription(subscription, { borough: 'Queens', agency: 'NYPD' }), false);
    assert.equal(matchesSubscription(subscription, { borough: 'Bronx', agency: 'FDNY' }), false);
  });
});
