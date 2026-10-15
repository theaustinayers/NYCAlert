import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActivePresence } from './active-presence.js';

describe('ActivePresence', () => {
  it('returns active browser totals and authenticated audience aggregates without double-counting heartbeats', () => {
    const presence = new ActivePresence();
    const now = 1_000_000;
    assert.deepEqual(presence.heartbeat('browser-a', 'buff', now), { total: 1, buff: 1, newsMedia: 0 });
    assert.deepEqual(presence.heartbeat('browser-a', 'buff', now + 20_000), { total: 1, buff: 1, newsMedia: 0 });
    assert.deepEqual(presence.heartbeat('browser-b', 'news', now + 21_000), { total: 2, buff: 1, newsMedia: 1 });
    assert.deepEqual(presence.heartbeat('browser-c', undefined, now + 22_000), { total: 3, buff: 1, newsMedia: 1 });
  });

  it('expires idle sessions and supports authenticated audience changes', () => {
    const presence = new ActivePresence();
    const now = 2_000_000;
    presence.heartbeat('browser-a', 'buff', now);
    assert.deepEqual(presence.heartbeat('browser-a', 'news', now + 1), { total: 1, buff: 0, newsMedia: 1 });
    assert.deepEqual(presence.getCounts(now + 75_002), { total: 0, buff: 0, newsMedia: 0 });
  });
});
