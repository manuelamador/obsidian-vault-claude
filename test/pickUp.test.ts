import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateOf, chatsToLookAt, clueLines, keptToday, localDay, pickUpPrompt, readPickUp, remindersNow } from '../src/pickUp';
import { answer, message, prompt, result } from './transcript';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 6);

test('recent chats first; older ones in a random order; never-suggested chats left out, skipped ones until due', () => {
  const items = [
    { id: 'today', title: 'Today', updatedAt: now - 1000 },
    { id: 'week', title: 'Week', updatedAt: now - 7 * DAY },
    { id: 'month', title: 'Month', updatedAt: now - 30 * DAY },
    { id: 'season', title: 'Two months', updatedAt: now - 60 * DAY },
    { id: 'year', title: 'Too old', updatedAt: now - 300 * DAY },
    { id: 'aside', title: 'Never', updatedAt: now - 2 * DAY },
    { id: 'back', title: 'Never, worked on since', updatedAt: now - 1 * DAY },
    { id: 'skip', title: 'Skipped', updatedAt: now - 3 * DAY },
    { id: 'due', title: 'Skip run out', updatedAt: now - 4 * DAY },
  ];
  const state = { hidden: { aside: now - 2 * DAY, back: now - 5 * DAY }, skipped: { skip: now + DAY, due: now - DAY } };
  const { recent, older } = chatsToLookAt(items, state, now, () => 0);
  assert.deepEqual(recent.map((item) => item.id), ['today', 'due', 'week']);
  // Both older ones, the year-old one left out; their order is the shuffle's.
  assert.deepEqual(older.map((item) => item.id).sort(), ['month', 'season']);
  assert.deepEqual(chatsToLookAt(items, state, now, () => 0).older.map((item) => item.id), ['season', 'month']);
  assert.deepEqual(chatsToLookAt(items, state, now, () => 0.99).older.map((item) => item.id), ['month', 'season']);
});

test('clues: a closing question, a plan not answered, unticked boxes (ticks counted), your unanswered message, a memo Next', () => {
  const asked = [prompt('Fix it?'), answer('Done for one file.\n\nApply it to the other two as well?')];
  assert.ok(clueLines(asked, {}, [])[0].startsWith("Claude's last reply ends with a question"));
  const boxes = message('assistant', [{ type: 'text', text: '- [ ] one\n- [ ] two' }], 'reply');
  assert.ok(clueLines([boxes], {}, []).some((clue) => clue.includes('2 unticked checkboxes')));
  assert.ok(clueLines([boxes], { reply: [0] }, []).some((clue) => clue.includes('1 unticked checkbox ')));
  const plan = message('assistant', [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: '## Steps\n1. Rename.' } }]);
  assert.ok(clueLines([plan], {}, []).some((clue) => clue.startsWith('A plan was put to you and not answered; it begins: "## Steps 1. Rename."')));
  assert.ok(!clueLines([plan, result('p1')], {}, []).some((clue) => clue.startsWith('A plan')));
  assert.deepEqual(clueLines([answer('Done.'), prompt('And then?')], {}, []), ['Your last message has no reply after it.']);
  assert.deepEqual(clueLines([answer('Done.')], {}, ['Check the bound.']), ['A memo saved from this chat has under Next: "Check the bound."']);
});

test('the request names each chat by id, with its age, clues and last exchanges', () => {
  const item = { id: 'c1', title: 'Debt model', updatedAt: now - 3 * DAY };
  const candidate = candidateOf(item, false, [prompt('Does it converge?'), answer('Yes. Shall I add the proof?')], {}, []);
  const text = pickUpPrompt([candidate], now);
  assert.ok(text.includes('id: c1\ntitle: Debt model\nlast worked on: 3 days ago\nclues:'));
  assert.ok(text.includes('You: Does it converge?\nClaude: Yes. Shall I add the proof?'));
  assert.ok(text.includes('Older conversations that may be unfinished (up to 183 days back):\n(none)'));
});

test('the reply: only chats given, each once, at most seven recent and four older; none when it says so', () => {
  const candidate = (id: string, older: boolean) => ({ id, title: id, updatedAt: now, older, exchanges: [], clues: [] });
  const candidates = [candidate('r1', false), candidate('r2', false), candidate('o1', true), candidate('o2', true), candidate('o3', true), candidate('o4', true), candidate('o5', true)];
  const reply = JSON.stringify({
    suggestions: [
      { id: 'r1', why: 'Left open.', next: 'Decide whether to go on.' },
      { id: 'r1', why: 'Again.', next: 'Again.' },
      { id: 'unknown', why: 'x', next: 'y' },
      { id: 'o1', why: 'Old.', next: 'Look again.' },
      { id: 'o2', why: 'Old.', next: 'Look again.' },
      { id: 'o3', why: 'Old.', next: 'Look again.' },
      { id: 'o4', why: 'Old.', next: 'Look again.' },
      { id: 'o5', why: 'Old.', next: 'Look again.' },
      { id: 'r2', why: '', next: 'No why.' },
    ],
  });
  assert.deepEqual(readPickUp(`Here: ${reply}`, candidates)?.suggestions.map((suggestion) => suggestion.id), ['r1', 'o1', 'o2', 'o3', 'o4']);
  assert.deepEqual(readPickUp('{"suggestions": [], "note": "Nothing looks left open."}', candidates), { suggestions: [], note: 'Nothing looks left open.' });
  assert.equal(readPickUp('no JSON here', candidates), null);
});

test("today's suggestions are kept for the day, without chats set aside or worked on since; another day, none", () => {
  const at = new Date(2026, 9, 6, 9, 0).getTime();
  const candidate = (id: string) => ({ id, title: id, updatedAt: at - DAY, older: false, exchanges: [], clues: [] });
  const kept = { day: localDay(at), at, note: '', candidates: [candidate('a'), candidate('b'), candidate('c')], suggestions: ['a', 'b', 'c'].map((id) => ({ id, why: 'w', next: 'n' })) };
  const state = { hidden: { b: at - DAY }, kept };
  const later = new Date(2026, 9, 6, 17, 0).getTime();
  const updated = (id: string) => (id === 'c' ? at + 1000 : at - DAY);
  assert.deepEqual(keptToday(state, later, updated)?.suggestions.map((suggestion) => suggestion.id), ['a']);
  assert.equal(keptToday(state, new Date(2026, 9, 7, 8, 0).getTime(), updated), null);
});

test('a reminder shows on five days, today counted once; then it goes; one just asked for waits for next time', () => {
  const day = (n: number) => new Date(2026, 9, 6 + n, 10, 0).getTime();
  const state = { hidden: {}, later: { a: { why: 'w', next: 'n', at: day(0) - 1000, days: [] as string[] }, fresh: { why: 'w', next: 'n', at: day(0) + 500, days: [] as string[] } } };
  const left = (n: number) => remindersNow(state, day(n), day(n) - 1, () => true).filter((reminder) => reminder.id === 'a').map((reminder) => reminder.left);
  assert.deepEqual(remindersNow(state, day(0), day(0), () => true).map((reminder) => [reminder.id, reminder.left]), [['a', 4]]);
  // Opened again the same day: still four left.
  assert.deepEqual(left(0), [4]);
  assert.deepEqual([left(1), left(2), left(3), left(4)], [[3], [2], [1], [0]]);
  assert.deepEqual(left(5), []);
  assert.equal(state.later.a, undefined);
});

test('clues read as a reader would: a question however marked up, checkboxes numbered or in a quote, none in code', () => {
  assert.ok(clueLines([answer('Done.\n\n**Shall I go on?**')], {}, [])[0].startsWith("Claude's last reply ends with a question"));
  assert.ok(clueLines([answer('Fertig. Weiter？')], {}, [])[0].startsWith("Claude's last reply ends with a question"));
  const boxes = (text: string) => clueLines([message('assistant', [{ type: 'text', text }], 'r')], {}, []).find((clue) => clue.includes('unticked'));
  assert.ok(boxes('1. [ ] first\n2. [ ] second')?.includes('2 unticked checkboxes'));
  assert.equal(boxes('Example:\n\n```md\n- [ ] not a task\n```'), undefined);
});

test("today's kept list leaves out deleted chats, and when none of them is left it asks again", () => {
  const at = new Date(2026, 9, 6, 9, 0).getTime();
  const candidate = (id: string) => ({ id, title: id, updatedAt: at - DAY, older: false, exchanges: [], clues: [] });
  const kept = { day: localDay(at), at, note: '', candidates: [candidate('a'), candidate('gone')], suggestions: ['a', 'gone'].map((id) => ({ id, why: 'w', next: 'n' })) };
  const later = new Date(2026, 9, 6, 12, 0).getTime();
  assert.deepEqual(keptToday({ hidden: {}, kept }, later, (id) => (id === 'a' ? at - DAY : undefined))?.suggestions.map((suggestion) => suggestion.id), ['a']);
  assert.equal(keptToday({ hidden: { a: at } , kept }, later, (id) => (id === 'a' ? at - DAY : undefined)), null);
});
