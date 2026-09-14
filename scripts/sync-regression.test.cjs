/** Caption-locked sync regression tests (plain node, no display).
 *
 * Locks in HOW the sync works so it can't silently break again:
 *  1. Tagged filenames parse: NN_ prefix and [open N]/[close N] agree,
 *     trigger phrase extracts, fullText strips the tags.
 *  2. captionWordClock reproduces the karaoke highlight math exactly
 *     (weights = max(1, word.length) splitting each cue span).
 *  3. planImageSync is absolute: stretching one trigger never moves later
 *     images (no lastExit chaining), dissolves fit the inter-tag gaps,
 *     spans tile without holes, output is deterministic.
 *  4. findCutBefore still finds butt-cuts AND gap-covering overlaps when a
 *     transition record covers the overlap (longer dissolves must fire).
 *  5. showcaseSlotSpans (timeline filmstrip) is identical to the slot times
 *     buildShowTimeline feeds renderShowcaseFrame — incl. absolute starts
 *     never being clamped to the previous exitEnd (the drift regression).
 *
 * Run: npm test
 */
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-regression-'));
execSync(
  `npx -y tsc src/engine/showcase.ts src/engine/imageSync.ts src/engine/editorTypes.ts --module commonjs --target es2020 --outDir ${JSON.stringify(tmp)} --skipLibCheck`,
  { cwd: ROOT, stdio: 'pipe' },
);
const { parseTaggedFilename, captionWordClock, sentenceWordClock, planImageSync } = require(path.join(tmp, 'imageSync.js'));
const { findCutBefore } = require(path.join(tmp, 'editorTypes.js'));
const { buildShowTimeline, showcaseSlotSpans } = require(path.join(tmp, 'showcase.js'));

// --- 1. filename convention -------------------------------------------
{
  const p = parseTaggedFilename('01_In 1789, the people were restless. [open 1] Citizens marched on the Bastille [close 1] demanding gunpowder.jpg');
  assert.strictEqual(p.index, 1, 'prefix index');
  assert.strictEqual(p.tagIndex, 1, 'tag index agrees with prefix');
  assert.strictEqual(p.triggerText, 'Citizens marched on the Bastille', 'trigger extracts');
  assert.strictEqual(p.fullText, 'In 1789, the people were restless. Citizens marched on the Bastille demanding gunpowder', 'tags stripped');
  const q = parseTaggedFilename('118_After them, the [open 118] night sky became something [close 118] to fear.png');
  assert.strictEqual(q.index, 118, '3-digit index');
  assert.strictEqual(q.tagIndex, 118, '3-digit tag agrees');
  assert.ok(!/[\\/:*?"<>|]/.test(q.triggerText), 'trigger is Windows-safe');
  console.log('1. filename convention: OK');
}

// --- 2. caption word clock == karaoke math ------------------------------
{
  const cues = [
    { words: ['Then,', 'a', 'weird', 'speck'], start: 10, end: 12 },
    { words: ['of', 'light', 'in', 'the', 'sky'], start: 12, end: 15 },
  ];
  const clock = captionWordClock(cues);
  assert.strictEqual(clock.length, 9, 'every word clocked');
  for (const cue of cues) {
    const weights = cue.words.map((w) => Math.max(1, w.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    cue.words.forEach((w, i) => {
      const s = cue.start + (acc / total) * (cue.end - cue.start);
      acc += weights[i];
      const e = cue.start + (acc / total) * (cue.end - cue.start);
      const got = clock.find((c) => Math.abs(c.start - s) < 1e-9 && c.word === w);
      assert.ok(got, `word "${w}" flips exactly when highlighted`);
      assert.ok(Math.abs(got.end - Math.max(s + 0.01, e)) < 1e-9, `word "${w}" end matches`);
    });
  }
  console.log('2. caption word clock == karaoke math: OK');
}

// --- synthetic 120-sentence script --------------------------------------
function makeScript() {
  const names = [];
  const sentences = [];
  let t = 0;
  for (let i = 1; i <= 120; i++) {
    const text = `Sentence number ${i} carries the story forward with steady narration`;
    const dur = text.split(' ').length / 3;
    sentences.push({ text, start: t, end: t + dur });
    const NN = i < 100 ? String(i).padStart(2, '0') : String(i);
    names.push(`${NN}_Sentence number ${i} [open ${i}] carries the story forward [close ${i}] with steady narration.png`);
    t += dur + (i % 3 === 2 ? 0.05 : 0.35);
  }
  return { names, sentences };
}

// --- 3. planner is absolute ---------------------------------------------
{
  const { names, sentences } = makeScript();
  const clock = sentenceWordClock(sentences);
  const plan = planImageSync(names, sentences, clock);
  assert.strictEqual(plan.length, 120, 'plans every image');
  assert.ok(plan.every((p) => p.matched), 'all triggers caption-locked');
  plan.forEach((p, i) => {
    assert.ok(i === 0 ? p.transIn === 0 : (p.transIn >= 0.15 && p.transIn <= 0.5), `dissolve ${i} sized from gap`);
    assert.ok(p.start <= p.openAt + 1e-9 && p.start >= p.openAt - 0.300001, `start ${i} absolute`);
    if (i + 1 < plan.length) assert.ok(Math.abs(p.end - (plan[i + 1].start + plan[i + 1].transIn)) < 1e-9, `no holes after ${i}`);
  });
  // THE regression: overlapping segments must not chain — later starts stay
  // absolute (a lastExit-chained implementation pushes them after the
  // previous clip's end instead).
  const dense = sentences.map((s, i) => (i % 2 === 1 ? { ...s, start: sentences[i - 1].start + 0.5 } : s));
  const denseClock = sentenceWordClock(dense);
  const densePlan = planImageSync(names, dense, denseClock);
  densePlan.forEach((p, i) => {
    const lead = i === 0 ? 0 : Math.min(0.3, p.transIn);
    assert.ok(Math.abs(p.start - Math.max(0, p.openAt - lead)) < 1e-9, `slot ${i} absolute under overlap`);
  });
  const again = planImageSync(names, sentences, clock);
  assert.deepStrictEqual(again, plan, 'pure + deterministic');
  console.log('3. planner absolute + deterministic: OK');
}

// --- 4. findCutBefore ----------------------------------------------------
{
  const mk = (id, trackId, kind, start, duration) => ({ id, trackId, kind, start, duration, offset: 0 });
  // plain butt-cut, no transitions
  const p1 = { clips: [mk(1, 7, 'image', 0, 5), mk(2, 7, 'image', 5, 5)], transitions: [] };
  assert.strictEqual(findCutBefore(p1, p1.clips[1]).id, 1, 'butt-cut found');
  // gap-covering overlap WITH a transition record must fire the dissolve
  const p2 = {
    clips: [mk(1, 7, 'image', 10, 5.8), mk(2, 7, 'image', 15.3, 4)],
    transitions: [{ id: 9, trackId: 7, clipId: 2, type: 'dissolve', duration: 0.5 }],
  };
  assert.strictEqual(findCutBefore(p2, p2.clips[1]).id, 1, 'overlap covered by transition found');
  // same overlap WITHOUT a transition record: old epsilon behavior kept
  const p3 = { clips: p2.clips, transitions: [] };
  assert.strictEqual(findCutBefore(p3, p3.clips[1]), null, 'no false dissolve without record');
  // the latest-ending prior clip on the track is the A side (even across a gap)
  const p4 = { clips: [mk(1, 7, 'image', 0, 2), mk(2, 7, 'image', 10, 2)], transitions: [] };
  assert.strictEqual(findCutBefore(p4, p4.clips[1]).id, 1, 'prior clip across gap still the A side');
  // other tracks and audio never qualify
  const p5 = { clips: [mk(1, 8, 'image', 9.9, 2), mk(2, 7, 'image', 10, 2), mk(3, 7, 'audio', 9.9, 2)], transitions: [] };
  assert.strictEqual(findCutBefore(p5, p5.clips[1]), null, 'cross-track/audio ignored');
  console.log('4. findCutBefore transition-aware: OK');
}

// --- 5. strip == player slot times ---------------------------------------
{
  const lineup = { layout: 'dock', tileSize: 160, gap: 12, gridCols: 6, maxTilt: 8, seed: 7, connect: false, connectColor: '#fff' };
  const items = Array.from({ length: 24 }, (_, i) => ({
    id: i + 1, name: `img${i + 1}`, url: `blob:img${i + 1}`,
    img: { naturalWidth: 1600, naturalHeight: 900 },
  }));
  // absolute starts that OVERLAP previous exits (the old Math.max clamp broke these)
  const starts = items.map((_, i) => i * 2.0);
  const holds = items.map(() => 2.6);
  const transs = items.map(() => 0.4);
  const tl = buildShowTimeline(items, 3, 0.9, 1.2, lineup, 0, holds, transs, starts);
  const spans = showcaseSlotSpans(items.length, { starts, holds, transs, hold: 3, trans: 0.9, sketch: 0 });
  assert.strictEqual(tl.slots.length, spans.length, 'same slot count');
  tl.slots.forEach((s, i) => {
    assert.ok(Math.abs(s.start - spans[i].start) < 1e-9, `slot ${i} start identical (no re-chain)`);
    assert.ok(Math.abs(s.holdEnd - spans[i].holdEnd) < 1e-9, `slot ${i} holdEnd identical`);
    assert.ok(Math.abs(s.exitEnd - spans[i].exitEnd) < 1e-9, `slot ${i} exitEnd identical`);
  });
  assert.ok(tl.slots[5].start < tl.slots[4].exitEnd, 'overlap preserved, not clamped');
  // chained fallback (no starts) still chains identically
  const tl2 = buildShowTimeline(items, 3, 0.9, 1.2, lineup, 0);
  const sp2 = showcaseSlotSpans(items.length, { hold: 3, trans: 0.9 });
  tl2.slots.forEach((s, i) => {
    assert.ok(Math.abs(s.start - sp2[i].start) < 1e-9, `fallback slot ${i} identical`);
  });
  console.log('5. filmstrip == player slot times: OK');
}

console.log('sync-regression: ALL OK');
