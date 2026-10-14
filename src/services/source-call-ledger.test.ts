import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SourceCallLedger } from './source-call-ledger.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-source-call-ledger-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

describe('SourceCallLedger', () => {
  it('atomically claims a source call and suppresses its repeat after reopening the database', async () => {
    const ledger = new SourceCallLedger(testDirectory);
    await ledger.init();

    assert.equal(ledger.claim('FDNY', 'call-123'), true);
    assert.equal(ledger.claim('FDNY', 'call-123'), false);
    ledger.complete('FDNY', 'call-123');
    ledger.close();

    const restarted = new SourceCallLedger(testDirectory);
    await restarted.init();
    assert.equal(restarted.claim('FDNY', 'call-123'), false);
    assert.equal(restarted.claim('NYPD', 'call-123'), true);
    restarted.close();
  });

  it('allows retry after a failed processing claim is released', async () => {
    const ledger = new SourceCallLedger(testDirectory);
    await ledger.init();

    assert.equal(ledger.claim('FDNY', 'retry-call'), true);
    ledger.release('FDNY', 'retry-call');
    assert.equal(ledger.claim('FDNY', 'retry-call'), true);
    ledger.close();
  });
});
