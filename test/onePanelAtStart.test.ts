import assert from 'node:assert/strict';
import { test } from 'node:test';
import VaultClaudePlugin from '../src/main';
import { ChatView } from '../src/view';

/** A plugin whose workspace holds Vault Claude tabs `leaves`, a sidebar being `sidebar`. */
function setup(leaves: { getRoot(): unknown; view: unknown; detach(): void }[], sidebar: unknown) {
  const p = new (VaultClaudePlugin as unknown as new () => VaultClaudePlugin)();
  p.saveSettings = async () => undefined;
  (p as unknown as { app: unknown }).app = {
    workspace: { getLeavesOfType: () => leaves.filter((leaf) => !(leaf as { gone?: boolean }).gone), leftSplit: {}, rightSplit: sidebar },
  };
  return p;
}

/** A tab in `root`; its view a panel when `panel` says what it runs and which margin tabs it has. */
function leaf(root: unknown, panel?: { runs: boolean; tabs: string[]; taken?: string[] }) {
  const view = panel
    ? Object.assign(Object.create(ChatView.prototype) as ChatView, {
        runsAnything: () => panel.runs,
        doneTabList: () => panel.tabs.map((id) => ({ id, title: id, text: '', at: 0 })),
        takeDoneTabs: (tabs: { id: string }[]) => void (panel.taken = tabs.map((tab) => tab.id)),
      })
    : {};
  const made = { gone: false, view, getRoot: () => root, detach: () => void (made.gone = true) };
  return made;
}

test('at start, the sidebar panel is kept and the other tabs close, their margin tabs going to it', () => {
  const sidebar = {};
  const main = {};
  const kept = { runs: false, tabs: ['k'] as string[], taken: [] as string[] };
  const first = leaf(main, { runs: false, tabs: ['a'] });
  const running = leaf(main, { runs: true, tabs: [] });
  const notShown = leaf(main);
  const side = leaf(sidebar, kept);
  setup([first, running, notShown, side], sidebar).closeExtraPanels();
  assert.deepEqual([first.gone, running.gone, notShown.gone, side.gone], [true, false, true, false]);
  assert.deepEqual(kept.taken, ['a']);
});

test('with no sidebar panel the first tab is kept; one tab alone stays', () => {
  const main = {};
  const first = leaf(main, { runs: false, tabs: [] });
  const second = leaf(main, { runs: false, tabs: [] });
  setup([first, second], {}).closeExtraPanels();
  assert.deepEqual([first.gone, second.gone], [false, true]);
  const only = leaf(main, { runs: false, tabs: [] });
  setup([only], {}).closeExtraPanels();
  assert.equal(only.gone, false);
});
