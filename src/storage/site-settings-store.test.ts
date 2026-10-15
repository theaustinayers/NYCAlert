import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SiteSettingsStore } from './site-settings-store.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-site-settings-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

describe('SiteSettingsStore', () => {
  it('persists supported analytics IDs and verification tags while rejecting invalid formats', async () => {
    const dataDirectory = join(testDirectory, 'persistent');
    const store = new SiteSettingsStore(dataDirectory);
    await store.init();
    const settings = await store.update({
      googleAnalyticsId: 'G-ABCD1234', metaPixelId: '123456789012345',
      googleSiteVerification: 'google_Token-1234', bingSiteVerification: 'bing_Token-5678',
      aboveHeaderCode: '<script async src="https://example.test/ads.js"></script><meta name="provider" content="verified">'
    });
    assert.deepEqual(settings, {
      googleAnalyticsId: 'G-ABCD1234', metaPixelId: '123456789012345',
      googleSiteVerification: 'google_Token-1234', bingSiteVerification: 'bing_Token-5678',
      aboveHeaderCode: '<script async src="https://example.test/ads.js"></script><meta name="provider" content="verified">'
    });
    assert.deepEqual(JSON.parse(await readFile(join(dataDirectory, 'site-settings.json'), 'utf8')), settings);
    await assert.rejects(store.update({ googleAnalyticsId: 'https://evil.test' }), /Invalid googleAnalyticsId/);
    await assert.rejects(store.update({ aboveHeaderCode: '<script>doThing()</script><img src=x onerror=alert(1)>' }), /event handlers/);
    await assert.rejects(store.update({ aboveHeaderCode: '<script src="javascript:alert(1)"></script>' }), /unsafe URL/);
  });

  it('persists editable Open Graph metadata and rejects unsafe or oversized values', async () => {
    const dataDirectory = join(testDirectory, 'open-graph');
    const store = new SiteSettingsStore(dataDirectory);
    await store.init();

    const settings = await store.update({
      openGraphTitle: 'NYC Alert — Live Desk',
      openGraphDescription: 'Verified New York City public-safety radio updates.',
      openGraphImage: '/social-card.jpg'
    });

    assert.equal(settings.openGraphTitle, 'NYC Alert — Live Desk');
    assert.equal(settings.openGraphDescription, 'Verified New York City public-safety radio updates.');
    assert.equal(settings.openGraphImage, '/social-card.jpg');
    assert.deepEqual(JSON.parse(await readFile(join(dataDirectory, 'site-settings.json'), 'utf8')), settings);
    await assert.rejects(store.update({ openGraphImage: 'http://insecure.example/card.jpg' }), /HTTPS URL/);
    await assert.rejects(store.update({ openGraphImage: '//evil.example/card.jpg' }), /HTTPS URL/);
    await assert.rejects(store.update({ openGraphTitle: 'x'.repeat(121) }), /Invalid openGraphTitle/);
  });
});