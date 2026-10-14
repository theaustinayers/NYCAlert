import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { analyzeLearningLog } from '../services/learning-log-audit.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npm run audit:learning-log -- <path-to-learning-debug.jsonl>');
  process.exitCode = 2;
} else {
  try {
    const input = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
    const report = await analyzeLearningLog(input);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    console.error('Could not read or analyze the learning log. Check the path and file permissions.');
    process.exitCode = 1;
  }
}
