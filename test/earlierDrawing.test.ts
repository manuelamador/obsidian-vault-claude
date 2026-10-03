import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { EarlierDrawing } from '../src/earlierTurns';
import { answer, message, prompt } from './transcript';

/**
 * Ten earlier turns ("p0" oldest … "p9" newest), newest first as historyParts gives them, drawn into
 * a scroller as one bubble per turn; a stretch draws one turn, so a drawing takes several.
 */
const tenTurns = () => Array.from({ length: 10 }, (_, i) => [message('user', `p${i}`, `p${i}`), message('assistant', [{ type: 'text', text: `a${i}` }])]).reverse();

function setup(options: { turns?: SessionMessage[][]; ownSlot?: boolean; held?: () => boolean } = {}) {
  const { window } = new JSDOM('<div id="scroller"></div>');
  const document = window.document;
  const scroller = document.getElementById('scroller') as HTMLElement;
  const caughtUp: boolean[] = [];
  const drawing = new EarlierDrawing(options.turns ?? tenTurns(), scroller, {
    scroller,
    // A bubble per turn, named by its first message's uuid.
    drawTurn(turn, holder) {
      const prompt = turn[0].uuid;
      const bubble = document.createElement('div');
      bubble.className = 'vc-user';
      bubble.textContent = prompt;
      holder.appendChild(bubble);
    },
    held: options.held ?? (() => false),
    caughtUp: (done) => void caughtUp.push(done),
    // One turn per stretch, unless the test is of the class's own idle-time wait.
    ...(options.ownSlot ? {} : { slot: () => new Promise<number>((resolve) => setTimeout(() => resolve(0), 1)) }),
  });
  // The chat's last turns, drawn after the line.
  scroller.appendChild(document.createElement('div')).className = 'tail';
  const drawn = () => [...scroller.querySelectorAll('.vc-user')].map((el) => el.textContent).join(',');
  const line = scroller.querySelector('.vc-earlier') as HTMLElement;
  return { drawing, line, drawn, caughtUp, window };
}

/** Until `done` holds, at most two seconds. */
async function until(done: () => boolean): Promise<void> {
  for (const end = Date.now() + 2000; !done() && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('the line goes above the last turns, says how many exchanges are above, and Show all is a button', () => {
  const { line } = setup();
  assert.equal(line.nextElementSibling?.className, 'tail');
  assert.equal(line.getAttribute('data-no-find'), '');
  assert.equal(line.textContent, 'Scroll up for 10 earlier exchanges · Show all');
  const all = line.querySelector('.vc-earlier-link');
  assert.equal(all?.getAttribute('role'), 'button');
  assert.equal(all?.getAttribute('tabindex'), '0');
});

test('turns are drawn newest first above the drawn ones, and each request is answered when its own turns are in', async () => {
  const { drawing, drawn, line, caughtUp } = setup();
  assert.equal(drawing.idle, true);
  const everything = drawing.draw(10);
  assert.equal(drawing.idle, false);
  assert.equal(await drawing.draw(2), true);
  assert.equal(drawn(), 'p8,p9');
  assert.equal(await everything, true);
  assert.equal(drawn(), 'p0,p1,p2,p3,p4,p5,p6,p7,p8,p9');
  assert.equal(line.isConnected, false);
  // Told once, at the end, that every turn is drawn.
  assert.deepEqual(caughtUp, [true]);
  assert.equal(drawing.idle, true);
});

test('Show all draws every turn, from a click or from Enter', async () => {
  for (const press of ['click', 'Enter']) {
    const { line, drawn, window } = setup();
    const all = line.querySelector('.vc-earlier-link') as HTMLElement;
    if (press === 'click') all.click();
    else all.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await until(() => !line.isConnected);
    assert.equal(drawn(), 'p0,p1,p2,p3,p4,p5,p6,p7,p8,p9', press);
  }
});

test('a drawing whose line is gone draws nothing and says so', async () => {
  const { drawing, line } = setup();
  line.remove();
  assert.equal(await drawing.draw(3), false);
  assert.equal(await drawing.drawTo('a4'), false);
});

test('a request made as a drawing finishes starts a new drawing', async () => {
  const { drawing, drawn } = setup();
  const chained = drawing.draw(1).then(() => drawing.draw(1));
  const outcome = await Promise.race([chained, new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))]);
  assert.equal(outcome, true);
  assert.equal(drawn(), 'p8,p9');
});

test('the list goes to an undrawn message, drawing back to it', async () => {
  const { drawing, drawn } = setup();
  const listed = drawing.listed();
  assert.deepEqual(
    listed.map((entry) => entry.summary),
    Array.from({ length: 10 }, (_, i) => `p${i}`),
  );
  const bubble = await listed[6].show();
  assert.equal(bubble?.textContent, 'p6');
  assert.equal(drawn(), 'p6,p7,p8,p9');
});

test('stopping answers requests false and draws nothing more', async () => {
  const { drawing, drawn } = setup();
  const pending = drawing.draw(10);
  drawing.stop();
  assert.equal(await pending, false);
  assert.equal(await drawing.draw(3), false);
  assert.equal(await drawing.listed()[0].show(), null);
  assert.equal(drawn(), '');
});

test('find draws back to the newest turn with a match', async () => {
  const { drawing, drawn } = setup();
  assert.equal(drawing.count('a4'), 1);
  assert.equal(await drawing.drawTo('a4'), true);
  assert.equal(drawing.count('a4'), 0);
  assert.equal(drawn(), 'p4,p5,p6,p7,p8,p9');
  assert.equal(await drawing.drawTo('absent'), false);
});

test("a memo's link draws back to the turn holding its message", async () => {
  const { drawing, drawn } = setup();
  assert.equal(await drawing.drawToMessage('p4'), true);
  assert.equal(drawn(), 'p4,p5,p6,p7,p8,p9');
  assert.equal(await drawing.drawToMessage('absent'), false);
});

// Newest first, as historyParts gives them: turn 2 is the latest; the second has a queued message.
const threeTurns = () => [
  [prompt('third'), answer('The yield curve again')],
  [prompt('second'), answer('nothing here'), prompt('queued follow-up')],
  [prompt('first'), answer('the Yield curve')],
];

test('find counts matches in the prompts and replies not drawn, without regard to case', () => {
  const { drawing } = setup({ turns: threeTurns() });
  assert.equal(drawing.count('yield curve'), 2);
  assert.equal(drawing.count('follow-up'), 1);
  assert.equal(drawing.count(''), 0);
});

test('drawing a turn takes it out of the count, the list and the search', async () => {
  const { drawing, drawn } = setup({ turns: threeTurns() });
  assert.deepEqual(
    drawing.listed().map((entry) => entry.summary),
    ['first', 'second', 'queued follow-up', 'third'],
  );
  await drawing.draw(1);
  assert.equal(drawn(), 'third');
  assert.equal(drawing.count('yield curve'), 1);
  assert.deepEqual(
    drawing.listed().map((entry) => entry.summary),
    ['first', 'second', 'queued follow-up'],
  );
  // The queued message is the second bubble of its turn.
  assert.equal(drawing.count('queued'), 1);
  assert.equal(await drawing.drawTo('queued'), true);
  assert.equal(drawn(), 'second,third');
});

test('a drawing with no turns left lists nothing and draws nothing', async () => {
  const { drawing, drawn } = setup({ turns: [] });
  assert.deepEqual(drawing.listed(), []);
  assert.equal(drawing.count('x'), 0);
  assert.equal(await drawing.draw(1), true);
  assert.equal(drawn(), '');
});

/** Stands in for the browser's requestIdleCallback on the test's window, counting its calls. */
function idleCallbacks(window: Window, deadline: { didTimeout: boolean; timeRemaining: () => number }) {
  let calls = 0;
  (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (callback: (deadline: unknown) => void) => {
    calls += 1;
    setTimeout(() => callback(deadline), 1);
    return calls;
  };
  return () => calls;
}

test('its own wait draws in the idle time given: none left means a turn per stretch', async () => {
  const { drawing, drawn, window } = setup({ ownSlot: true });
  const calls = idleCallbacks(window, { didTimeout: false, timeRemaining: () => 0 });
  await drawing.draw(10);
  assert.equal(drawn(), 'p0,p1,p2,p3,p4,p5,p6,p7,p8,p9');
  assert.equal(calls(), 10);
});

test('a wait that timed out, with no idle time for a second, gets a full stretch', async () => {
  const { drawing, drawn, window } = setup({ ownSlot: true });
  const calls = idleCallbacks(window, { didTimeout: true, timeRemaining: () => 0 });
  await drawing.draw(10);
  assert.equal(drawn(), 'p0,p1,p2,p3,p4,p5,p6,p7,p8,p9');
  assert.equal(calls(), 1);
});

test('without idle callbacks it still draws, a stretch after a short pause', async () => {
  const { drawing, drawn } = setup({ ownSlot: true });
  await drawing.draw(10);
  assert.equal(drawn(), 'p0,p1,p2,p3,p4,p5,p6,p7,p8,p9');
});

test('nothing is drawn while a dialog holds the window, and the drawing goes on once it closes', async () => {
  let open = true;
  const { drawing, drawn } = setup({ ownSlot: true, held: () => open });
  const all = drawing.draw(10);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(drawn(), '');
  open = false;
  await all;
  assert.equal(drawn(), 'p0,p1,p2,p3,p4,p5,p6,p7,p8,p9');
});
