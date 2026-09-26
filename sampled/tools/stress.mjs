// How often does playing straight after start glitch? The hardest moment for
// the streaming: the page has just said every key is ready, the rest of the
// library is still arriving and being decoded, and someone plays -- a note,
// then a pedalled chord that starts thirty-odd streams at once.
//
// A measurement, not a pass/fail check: it depends on the machine, and on a
// busy one the answer is "sometimes". It loads the page RUNS times (default
// 5) and reports the underruns per gesture, so a change to the streaming can
// be compared against the last one. Slow: about 25 s per load.
//
//   npm run sampled:stress [-- RUNS]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const PORT = process.env.PORT || '8141';
const RUNS = +process.argv[2] || 5;
const server = spawn(process.execPath, [join(REPO, 'tools', 'serve.mjs')], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});

const GESTURES = ['one note, ff', 'one note, pp', 'a note under the pedal', 'an eight-note pedalled chord'];
const all = [];
for (let run = 0; run < RUNS; run++) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/sampled/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.getElementById('installChk').checked = false; });
  await page.click('#startBtn');
  await page.waitForFunction(() => window.piano, null, { timeout: 30000 });
  await page.waitForFunction(() => window.piano.lib.keysReady() >= 88, null, { timeout: 120000 });
  const got = await page.evaluate(async () => {
    const { engine, lib } = window.piano;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const gestures = [
      async () => { engine.noteOn(60, 110); await wait(400); engine.noteOff(60); },
      async () => { engine.noteOn(60, 25); await wait(400); engine.noteOff(60); },
      async () => { engine.setPedal(1); engine.noteOn(55, 110); await wait(200); engine.noteOff(55); await wait(700); engine.setPedal(0); },
      async () => { engine.setPedal(1); for (const m of [36, 43, 48, 52, 55, 60, 64, 67]) engine.noteOn(m, 100); await wait(800); engine.setPedal(0); },
    ];
    const out = [];
    for (const g of gestures) {
      const before = lib.streamer.underruns;
      await g(); await wait(500);
      out.push(lib.streamer.underruns - before);
      engine.panic(); await wait(400);
    }
    return out;
  });
  all.push(got);
  console.log(`  load ${run + 1}: ${got.join(' ')}`);
  await context.close();
}
await browser.close();
server.kill();

console.log('\n  underruns per gesture, over', RUNS, 'loads:');
GESTURES.forEach((g, i) => console.log(`    ${g.padEnd(30)} ${all.reduce((a, r) => a + r[i], 0)}`));
console.log(`  loads with any underrun: ${all.filter((r) => r.some((x) => x)).length} of ${RUNS}\n`);
