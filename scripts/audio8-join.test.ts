import assert from 'node:assert';
import { chunkAudio8Script, crossfadeJoin } from '../src/engine/audio8.ts';

const rate = 44100;
const sine = (freq: number, secs: number) => {
  const n = Math.round(secs * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};

// single chunk passes through untouched
{
  const a = sine(110, 1);
  const { samples, spans } = crossfadeJoin([a], rate, 0.45);
  assert.strictEqual(samples.length, a.length);
  assert.deepStrictEqual(spans, [{ start: 0, end: 1 }]);
  assert.ok(samples.every((v, i) => v === a[i]));
}

// two chunks: layout = A + silence gap + overlap blend
{
  const A = sine(100, 2);
  const B = sine(140, 2);
  const pause = 0.45;
  const O = Math.round(0.25 * rate);
  const G = Math.round(pause * rate) - O;
  const { samples, spans } = crossfadeJoin([A, B], rate, pause);
  assert.strictEqual(samples.length, A.length + G + B.length - O);
  assert.strictEqual(spans.length, 2);
  // span continuity: B starts exactly O samples before A ends, minus the gap
  assert.ok(Math.abs(spans[0].end - A.length / rate) < 1e-9);
  assert.ok(Math.abs(spans[1].start - (A.length + G - O) / rate) < 1e-9);
  assert.ok(Math.abs(spans[1].end - samples.length / rate) < 1e-9);
  // pristine regions untouched
  for (let i = 0; i < A.length + G - O; i++) assert.strictEqual(samples[i], i < A.length ? A[i] : 0);
  // blend region is a true mix (differs from both raw edges)
  const mid = A.length + G - Math.floor(O / 2);
  assert.notStrictEqual(samples[mid], A[mid]);
  // tail of B untouched
  const tailAt = A.length + G - O + O + 100;
  assert.strictEqual(samples[tailAt], B[O + 100]);
}

// pause=0 still blends, output shorter than plain concat
{
  const A = sine(100, 1);
  const B = sine(140, 1);
  const { samples } = crossfadeJoin([A, B], rate, 0);
  assert.strictEqual(samples.length, A.length + B.length - Math.round(0.25 * rate));
}

// tiny chunks shrink the overlap instead of breaking
{
  const A = sine(100, 0.05);
  const B = sine(140, 0.05);
  const { samples, spans } = crossfadeJoin([A, B], rate, 0.45);
  assert.ok(samples.length > 0 && spans[1].end > spans[1].start);
}

// chunker still caps at 150 chars
{
  const long = 'Hello world. '.repeat(40);
  for (const b of chunkAudio8Script(long)) assert.ok(b.length <= 150, b.length);
}

console.log('audio8.join.test: ALL OK');
