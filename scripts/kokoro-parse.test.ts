import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWavPcm16, splitSentences } from '../src/engine/voiceover.ts';

// sentence splitter: Intl.Segmenter path
{
  const s = splitSentences('Hello world. How are you today? I am fine!');
  assert.deepStrictEqual(s, ['Hello world.', 'How are you today?', 'I am fine!']);
}
// empty + single sentence
{
  assert.deepStrictEqual(splitSentences('   '), []);
  assert.deepStrictEqual(splitSentences('No punctuation here'), ['No punctuation here']);
}
// real server output parses bit-exact (24kHz mono PCM16)
{
  const dir = os.tmpdir();
  for (const f of ['knew1.wav', 'knew2.wav', 'knew3.wav']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const { samples, rate } = parseWavPcm16(ab);
    assert.strictEqual(rate, 24000, f);
    assert.ok(samples.length > rate, `${f}: has audio`);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);
    assert.ok(peak > 0.05 && peak <= 1, `${f}: sane peak ${peak}`);
    assert.ok(rms > 0.005, `${f}: not silent (rms ${rms})`);
    assert.ok(peak / rms > 2, `${f}: speech-like crest`);
  }
}
// malformed input throws (never silent garbage)
{
  assert.throws(() => parseWavPcm16(new ArrayBuffer(44)));
}
console.log('kokoro-parse.test: ALL OK');
