import { resolve } from 'node:path';
import { series4CorrelationCases } from '../evaluation/series-4-correlation-cases.js';
import { loadReviewedCorrelationDataset } from '../evaluation/correlation-dataset.js';
import { evaluateCorrelationCases } from '../services/correlation-evaluator.js';

const datasetPath = process.argv[2];
const cases = datasetPath ? await loadReviewedCorrelationDataset(resolve(datasetPath)) : series4CorrelationCases;
const result = evaluateCorrelationCases(cases);
console.log(JSON.stringify({
	dataset: datasetPath ? 'human-reviewed-correlation-jsonl' : 'series-4-correlation-regressions-v1',
	warning: datasetPath ? undefined : 'Bundled cases are synthetic and unverified; this is regression coverage, not model accuracy.',
	...result
}, null, 2));
if (result.failed > 0) process.exitCode = 1;
