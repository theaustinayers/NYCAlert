import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SubscriptionStore } from './subscription-store.js';

const dataDirectory = await mkdtemp(join(tmpdir(), 'nyc-subscriptions-'));
after(async () => rm(dataDirectory, { recursive: true, force: true }));

describe('SubscriptionStore notification roles', () => {
  it('persists, updates, and clears an optional notification role', async () => {
    const store = new SubscriptionStore(dataDirectory);
    await store.init();
    const base = { guildId: 'guild-1', channelId: 'channel-1', borough: 'Manhattan' as const, agency: 'FDNY' as const };

    assert.equal(await store.add({ ...base, notifyRoleId: 'role-1' }), true);
    assert.equal(await store.add({ ...base, notifyRoleId: 'role-2' }), true);
    assert.deepEqual(store.list('guild-1', 'channel-1')[0], { ...base, notifyRoleId: 'role-2' });
    assert.equal(await store.add(base), true);
    assert.deepEqual(store.list('guild-1', 'channel-1')[0], base);

    const persisted = JSON.parse(await readFile(join(dataDirectory, 'subscriptions.json'), 'utf8')) as unknown[];
    assert.deepEqual(persisted[0], base);
  });

  it('stores News Media and Buff subscriptions independently and defaults omitted audiences to News Media', async () => {
    const store = new SubscriptionStore(dataDirectory);
    await store.init();
    const base = { guildId: 'guild-2', channelId: 'channel-2', borough: 'Queens' as const, agency: 'FDNY' as const };

    assert.equal(await store.add(base), true);
    assert.equal(await store.add({ ...base, audience: 'buff' }), true);
    assert.equal(await store.add({ ...base, audience: 'public' }), true);
    assert.equal(await store.add({ ...base, audience: 'public', notifyRoleId: 'public-role' }), true);
    assert.deepEqual(store.list('guild-2', 'channel-2').map((subscription) => subscription.audience ?? 'news').sort(), ['buff', 'news', 'public']);
    assert.equal(store.list('guild-2', 'channel-2').find((subscription) => subscription.audience === 'public')?.notifyRoleId, 'public-role');
    assert.equal(await store.remove('guild-2', 'channel-2', 'Queens', 'FDNY', 'buff'), true);
    assert.equal(store.list('guild-2', 'channel-2').length, 2);
    assert.equal(store.list('guild-2', 'channel-2').find((subscription) => subscription.audience === undefined)?.audience, undefined);
  });
});
