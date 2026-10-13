import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DeploymentUpdater } from './deployment-updater.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setupUpdater(queuedTimeoutMs = 120_000) {
  const directory = await mkdtemp(join(tmpdir(), 'nyc-alert-updater-test-'));
  directories.push(directory);
  const dataDirectory = join(directory, 'data');
  const statusPath = join(directory, 'updater', 'status.json');
  const installedPaths = ['helper', 'path-unit', 'service-unit'].map((name) => join(directory, name));
  await mkdir(dataDirectory, { recursive: true });
  await Promise.all(installedPaths.map((path) => writeFile(path, 'installed')));
  return {
    dataDirectory,
    statusPath,
    updater: new DeploymentUpdater(dataDirectory, { statusPath, installedPaths, queuedTimeoutMs })
  };
}

describe('DeploymentUpdater', () => {
  it('reports a fresh request as queued', async () => {
    const { dataDirectory, updater } = await setupUpdater();
    const requestedAt = new Date().toISOString();
    await writeFile(join(dataDirectory, 'update-request'), `${requestedAt}\n`);

    const status = await updater.getStatus();

    assert.equal(status.state, 'queued');
  });

  it('reports a stale queued request as failed and safely replaces it on retry', async () => {
    const { dataDirectory, updater } = await setupUpdater();
    await writeFile(join(dataDirectory, 'update-request'), '2020-01-01T00:00:00.000Z\n');

    const stale = await updater.getStatus();
    assert.equal(stale.state, 'failed');
    assert.match(stale.message, /did not start within two minutes/);

    const retried = await updater.trigger();
    assert.equal(retried.state, 'queued');
    assert.equal((await updater.getStatus()).state, 'queued');
  });

  it('shows a helper failure instead of masking it with its leftover request marker', async () => {
    const { dataDirectory, statusPath, updater } = await setupUpdater();
    const requestedAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(join(dataDirectory, 'update-request'), `${requestedAt}\n`);
    await mkdir(dirname(statusPath), { recursive: true });
    await writeFile(statusPath, JSON.stringify({
      state: 'failed',
      requestedAt,
      finishedAt: new Date().toISOString(),
      message: 'The deploy key is missing.'
    }));

    const status = await updater.getStatus();

    assert.equal(status.state, 'failed');
    assert.equal(status.message, 'The deploy key is missing.');
  });
});
