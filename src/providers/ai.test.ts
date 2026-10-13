import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WhisperCppTranscriber } from './ai.js';

describe('WhisperCppTranscriber', () => {
  it('calls whisper.cpp with the local model and returns its text output', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'whisper-test-'));
    const audioPath = join(tempDirectory, 'call.mp3');
    await writeFile(audioPath, Buffer.from('audio'));
    const invocations: Array<{ executable: string; args: string[] }> = [];
    const transcriber = new WhisperCppTranscriber('/models/ggml-base.en.bin', '/usr/local/bin/whisper-cli', 3, async (executable, args) => {
      invocations.push({ executable, args });
      if (executable === 'ffmpeg') await writeFile(args.at(-1)!, Buffer.from('wav-audio'));
      else {
        const outputPrefix = args[args.indexOf('-of') + 1]!;
        await writeFile(`${outputPrefix}.txt`, '  Engine 12 responding to a dispatch.  ');
      }
    });

    try {
      const transcript = await transcriber.transcribe(audioPath);
      assert.equal(transcript, 'Engine 12 responding to a dispatch.');
      assert.equal(invocations.length, 2);
      assert.equal(invocations[0]?.executable, 'ffmpeg');
      assert.deepEqual(invocations[0]?.args.slice(-7), ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', invocations[0]?.args.at(-1)]);
      assert.equal(invocations[1]?.executable, '/usr/local/bin/whisper-cli');
      assert.deepEqual(invocations[1]?.args.slice(0, 6), ['-m', '/models/ggml-base.en.bin', '-f', invocations[0]?.args.at(-1), '-t', '3']);
      assert.equal(invocations[1]?.args.includes('-otxt'), true);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it('cleans up temporary output when whisper.cpp fails', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'whisper-fail-'));
    const audioPath = join(tempDirectory, 'call.mp3');
    await writeFile(audioPath, Buffer.from('audio'));
    let outputPrefix = '';
    const transcriber = new WhisperCppTranscriber('model.bin', 'whisper-cli', 2, async (path, args) => {
      if (path === 'ffmpeg') await writeFile(args.at(-1)!, Buffer.from('wav-audio'));
      else {
        outputPrefix = args[args.indexOf('-of') + 1]!;
        throw Object.assign(new Error('command failed'), { stderr: 'model failed: invalid audio payload' });
      }
    });

    try {
      await assert.rejects(transcriber.transcribe(audioPath), /Local whisper\.cpp transcription failed.*model failed: invalid audio payload/);
      await assert.rejects(access(`${outputPrefix}.txt`));
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
