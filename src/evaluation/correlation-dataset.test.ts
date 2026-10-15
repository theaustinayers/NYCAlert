import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadReviewedCorrelationDataset } from './correlation-dataset.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-eval-dataset-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

const baseCase = {
  id: 'reviewed-case-01', labelStatus: 'human-reviewed', expectedSameIncident: true,
  existing: { agency: 'FDNY', borough: 'Bronx', incidentType: 'fire', location: '999 Example Road', unitIds: [], occurredAt: 1000 },
  incoming: { agency: 'FDNY', borough: 'Queens', incidentType: 'fire', location: '999 Example Rd', unitIds: [], occurredAt: 2000 }
};

describe('loadReviewedCorrelationDataset', () => {
  it('loads bounded, allowlisted cases only after human review', async () => {
    const path = join(testDirectory, 'reviewed.jsonl');
    await writeFile(path, `${JSON.stringify(baseCase)}\n`);
    const cases = await loadReviewedCorrelationDataset(path);
    assert.equal(cases.length, 1);
    assert.equal(cases[0]?.labelStatus, 'human-reviewed');
    assert.equal(cases[0]?.existing.location, '999 Example Road');
  });

  it('rejects unreviewed labels and raw transcript fields', async () => {
    const path = join(testDirectory, 'unreviewed.jsonl');
    await writeFile(path, `${JSON.stringify({ ...baseCase, labelStatus: 'synthetic-unverified' })}\n`);
    await assert.rejects(loadReviewedCorrelationDataset(path), /must be human-reviewed or adjudicated/);

    await writeFile(path, `${JSON.stringify({ ...baseCase, rawTranscript: 'sensitive radio audio transcript' })}\n`);
    await assert.rejects(loadReviewedCorrelationDataset(path), /unsupported case shape/);
  });
});
