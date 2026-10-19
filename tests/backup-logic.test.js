import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addBackupToSession,
  applyAutoGroupPreview,
  applyImport,
  autoSaveClosedWindow,
  clearSaved,
  connectDrive,
  deleteBackup,
  deleteSession,
  disconnectDrive,
  editGroupBackup,
  editSessionGroup,
  sessionGroupFormTabs,
  editSuggestion,
  exportBackup,
  exportLibrary,
  exportSession,
  findOpenTab,
  moveSessionGroup,
  pinSession,
  planCloseTabs,
  planNewGroup,
  planSaveAndClose,
  planSelectiveRestore,
  planSessionRestore,
  planSiteSortMoves,
  previewAutoGroups,
  previewImport,
  reconnectDrive,
  rememberSort,
  renameSession,
  reorderSessionGroups,
  reorderSessionWindows,
  restoreGroupBackup,
  saveActiveRow,
  saveAllGroups,
  saveSession,
  saveWindow,
  searchLibrary,
  setPreviewCollapsed,
  sortActiveGroups,
  sortSavedItems,
  sortTabsBySite,
  syncDrive,
  undoUpdates,
  updateSettings,
} from '../src/backup-logic.js';

const windowSnapshot = {
  windowId: 1,
  groups: [
    {
      id: 'g-named',
      title: 'Research',
      color: 'blue',
      tabs: [
        { url: 'https://a.example/1', title: 'A' },
        { url: 'https://a.example/2', title: 'B' },
      ],
    },
    {
      id: 'g-unnamed',
      title: '   ',
      color: 'red',
      tabs: [{ url: 'https://b.example/1', title: 'C' }],
    },
  ],
  ungrouped: [{ url: 'https://c.example/1', title: 'D' }],
};

function save(store, selection, options = {}) {
  let n = store.backups.length;
  return saveActiveRow(store, windowSnapshot, selection, {
    now: '2026-10-18T00:00:00.000Z',
    createId: () => `id-${++n}`,
    ...options,
  });
}

test('saves only the selected row, keeps names, order, color, and the backup after restore', () => {
  const empty = { backups: [] };

  const named = save(empty, { kind: 'group', groupId: 'g-named' });
  assert.equal(named.ok, true);
  assert.equal(named.backup.name, 'Research');
  assert.equal(named.backup.color, 'blue');
  assert.deepEqual(named.backup.tabs, [
    { url: 'https://a.example/1', title: 'A' },
    { url: 'https://a.example/2', title: 'B' },
  ]);
  assert.equal(JSON.stringify(named.backup).includes('b.example'), false);
  assert.equal(JSON.stringify(named.backup).includes('c.example'), false);
  assert.equal(empty.backups.length, 0);

  const unnamedBlocked = save(named.store, { kind: 'group', groupId: 'g-unnamed' });
  assert.equal(unnamedBlocked.ok, false);
  assert.equal(unnamedBlocked.code, 'name-required');
  assert.equal(unnamedBlocked.store.backups.length, 1);

  const draft = save(unnamedBlocked.store, { kind: 'group', groupId: 'g-unnamed' }, {
    enteredName: 'Draft',
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.backup.name, 'Draft');
  assert.equal(draft.backup.color, 'red');
  assert.deepEqual(draft.backup.tabs, [{ url: 'https://b.example/1', title: 'C' }]);

  const looseBlocked = save(draft.store, { kind: 'ungrouped' });
  assert.equal(looseBlocked.ok, false);
  assert.equal(looseBlocked.code, 'name-required');
  assert.equal(looseBlocked.store.backups.length, draft.store.backups.length);

  const loose = save(looseBlocked.store, { kind: 'ungrouped' }, { enteredName: 'Loose' });
  assert.equal(loose.ok, true);
  assert.equal(loose.backup.name, 'Loose');
  assert.equal(loose.backup.color, null);
  assert.deepEqual(loose.backup.tabs, [{ url: 'https://c.example/1', title: 'D' }]);

  assert.deepEqual(
    loose.store.backups.map((backup) => backup.tabs.map((tab) => tab.url)),
    [
      ['https://a.example/1', 'https://a.example/2'],
      ['https://b.example/1'],
      ['https://c.example/1'],
    ],
  );

  const research = loose.store.backups[0];
  const restored = restoreGroupBackup(loose.store, research.id);
  assert.equal(restored.ok, true);
  assert.equal(restored.open.name, 'Research');
  assert.equal(restored.open.color, 'blue');
  assert.deepEqual(restored.open.urls, ['https://a.example/1', 'https://a.example/2']);
  assert.equal(
    restored.store.backups.some((backup) => backup.id === research.id),
    true,
  );
  assert.deepEqual(
    restored.store.backups.find((backup) => backup.id === research.id).tabs.map((tab) => tab.url),
    ['https://a.example/1', 'https://a.example/2'],
  );
});

test('saves an 11th new copy and an update still replaces one slot', () => {
  const backups = Array.from({ length: 10 }, (_, index) => ({
    id: `slot-${index}`,
    name: `Old ${index}`,
    color: null,
    tabs: [{ url: `https://old.example/${index}`, title: 'Old' }],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }));
  const full = { backups };

  const added = save(full, { kind: 'group', groupId: 'g-named' });
  assert.equal(added.ok, true);
  assert.equal(added.message, '备份已保存');
  assert.equal(added.store.backups.length, 11);
  assert.equal(full.backups.length, 10);

  const updated = save(full, { kind: 'group', groupId: 'g-named' }, {
    mode: 'update',
    existingId: 'slot-3',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.store.backups.length, 10);
  const slot = updated.store.backups.find((backup) => backup.id === 'slot-3');
  assert.equal(slot.name, 'Research');
  assert.equal(slot.color, 'blue');
  assert.deepEqual(slot.tabs.map((tab) => tab.url), [
    'https://a.example/1',
    'https://a.example/2',
  ]);
  assert.equal(slot.createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(full.backups[3].name, 'Old 3');
});

const liveWindows = [
  {
    windowId: 1,
    width: 800,
    groups: [
      {
        id: 'research',
        title: 'Research',
        color: 'blue',
        tabs: [
          { url: 'https://a.example/1', title: 'A', pinned: true },
          { url: 'https://a.example/2', title: 'B' },
        ],
      },
      {
        id: 'blank',
        title: '',
        color: 'grey',
        tabs: [{ url: 'https://blank.example/', title: 'Blank' }],
      },
    ],
    ungrouped: [{ url: 'https://loose.example/', title: 'Loose' }],
  },
  {
    windowId: 2,
    groups: [
      {
        id: 'other',
        title: 'Other',
        color: 'green',
        tabs: [{ url: 'https://other.example/', title: 'Other' }],
      },
    ],
    ungrouped: [],
  },
];

test('updates a matching group in place, saves a new copy, and undo keeps later edits and deletions', () => {
  let seq = 0;
  const created = saveAllGroups({ backups: [] }, liveWindows, {
    mode: 'update',
    now: '2026-10-18T01:00:00.000Z',
    createId: () => `new-${seq += 1}`,
  });
  assert.equal(created.saved.length, 2);
  assert.equal(created.failed.some((item) => item.reason === '请输入名称'), true);
  assert.equal(created.store.backups.length, 2);

  const changedWindows = [{
    windowId: 1,
    groups: [
      {
        id: 'research',
        title: 'Research',
        color: 'blue',
        backupId: 'new-1',
        tabs: [
          { url: 'https://a.example/1', title: 'A' },
          { url: 'https://a.example/3', title: 'C' },
        ],
      },
      {
        id: 'same-name',
        title: 'Research',
        color: 'red',
        tabs: [{ url: 'https://different.example/', title: 'Nope' }],
      },
    ],
  }];
  const updated = saveAllGroups(created.store, changedWindows, {
    mode: 'update',
    now: '2026-10-18T02:00:00.000Z',
    createId: () => `new-${seq += 1}`,
  });
  assert.equal(updated.updated.length, 1);
  assert.equal(updated.saved.length, 1);
  assert.equal(updated.store.backups.length, 3);
  assert.equal(updated.store.backups.find((item) => item.id === 'new-1').tabs[1].url, 'https://a.example/3');

  const copied = saveAllGroups(updated.store, changedWindows, {
    mode: 'new',
    now: '2026-10-18T03:00:00.000Z',
    createId: () => `copy-${seq += 1}`,
  });
  assert.equal(copied.saved.length, 2);
  assert.equal(copied.updated.length, 0);
  assert.equal(copied.store.backups.length, 5);

  const edited = editGroupBackup(updated.store, 'new-1', {
    name: 'Research edited',
    color: 'blue',
    tabs: [{ url: 'https://a.example/9', title: 'Later', password: 'secret' }],
  }, { now: '2026-10-18T04:00:00.000Z' });
  assert.equal(edited.backup.tabs[0].password, undefined);
  const removed = deleteBackup(edited.store, updated.saved[0].id);
  const undone = undoUpdates(removed.store);
  const research = undone.store.backups.find((item) => item.id === 'new-1');
  assert.equal(research.name, 'Research edited');
  assert.equal(undone.store.backups.some((item) => item.id === updated.saved[0].id), false);
  assert.equal(undone.store.backups.find((item) => item.id === 'new-2').name, 'Other');
});

test('saves a second session, restores one new window, and keeps pinned state without window geometry', () => {
  const first = saveSession({ backups: [] }, liveWindows, {
    name: 'Friday',
    now: '2026-10-18T01:00:00.000Z',
    createId: () => 'session-1',
  });
  const second = saveSession(first.store, liveWindows, {
    name: 'Monday',
    now: '2026-10-18T02:00:00.000Z',
    createId: () => 'session-2',
  });
  assert.equal(second.ok, true);
  assert.equal(second.store.sessions.length, 2);
  assert.equal(second.session.windows[0].width, undefined);
  assert.equal(second.session.windows[0].groups[0].tabs[0].pinned, true);

  const whole = planSessionRestore(second.store, 'session-2');
  assert.equal(whole.store.sessions.length, 2);
  assert.equal(whole.openWindows.length, 2);
  assert.equal(whole.openWindows[0].width, undefined);
  assert.equal(whole.openWindows[0].groups[0].tabs[0].pinned, true);

  const one = planSessionRestore(second.store, 'session-2', { windowId: 2 });
  assert.equal(one.openWindows.length, 1);
  assert.equal(one.openWindows[0].groups[0].name, 'Other');
  assert.equal(second.store.sessions.length, 2);
});

test('skips restricted urls on restore and keeps the saved copy', () => {
  const store = {
    backups: [{
      id: 'mixed',
      name: 'Mixed',
      color: 'blue',
      tabs: [
        { url: 'https://ok.example/', title: 'OK' },
        { url: 'chrome://settings', title: 'Settings' },
        { url: 'chrome-extension://abcdefgh/page.html', title: 'Ext' },
      ],
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
    }],
  };
  const restored = restoreGroupBackup(store, 'mixed');
  assert.deepEqual(restored.open.urls, ['https://ok.example/']);
  assert.equal(restored.open.skipped.length, 2);
  assert.match(restored.message, /没有打开/);
  assert.equal(restored.store.backups[0].tabs.length, 3);
});

test('auto group stays inside one window and does not touch named groups', () => {
  const preview = previewAutoGroups([
    {
      windowId: 1,
      groups: [{ id: 'named', title: 'Research', tabs: [{ url: 'https://news.example/kept', tabId: 7 }] }],
      ungrouped: [
        { url: 'https://news.example/1', tabId: 1 },
        { url: 'https://news.example/2', tabId: 2 },
        { url: 'https://solo.example/1', tabId: 3 },
      ],
    },
    {
      windowId: 2,
      groups: [],
      ungrouped: [{ url: 'https://news.example/9', tabId: 9 }],
    },
  ]);
  assert.equal(preview.windows[0].suggestions.length, 1);
  assert.deepEqual(preview.windows[0].suggestions[0].tabs.map((tab) => tab.tabId), [1, 2]);
  assert.equal(preview.windows[0].suggestions[0].tabs.some((tab) => tab.tabId === 7), false);
  assert.equal(preview.windows[1].unchanged, true);
  assert.equal(preview.windows[1].suggestions.length, 0);

  const collapsed = setPreviewCollapsed(preview, 1, true);
  assert.equal(collapsed.windows[0].collapsed, true);
  assert.equal(collapsed.windows[0].suggestions[0].selected, true);

  const deselected = editSuggestion(collapsed, 1, collapsed.windows[0].suggestions[0].id, {
    selected: false,
    name: 'News',
    color: 'orange',
  });
  assert.equal(applyAutoGroupPreview(deselected).moves.length, 0);
  const selected = editSuggestion(deselected, 1, deselected.windows[0].suggestions[0].id, { selected: true });
  const applied = applyAutoGroupPreview(selected);
  assert.equal(applied.moves.length, 1);
  assert.equal(applied.moves[0].windowId, 1);
  assert.equal(applied.moves[0].name, 'News');
  assert.deepEqual(applied.undo[0].tabIds, [1, 2]);
});

test('search includes a collapsed saved group and does not change the library', () => {
  const store = {
    backups: [{
      id: 'b1',
      name: 'Reading',
      color: null,
      tabs: [{ url: 'https://docs.example/hidden-tab', title: 'Buried title' }],
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
    }],
    sessions: [{
      id: 's1',
      name: 'Friday',
      pinned: false,
      windows: [{
        id: 1,
        name: '窗口 1',
        groups: [{ id: 'g', name: 'Buried group', color: 'blue', tabs: [{ url: 'https://group.example/', title: 'Inside' }] }],
        ungrouped: [{ url: 'https://loose.example/', title: 'Loose buried' }],
      }],
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
    }],
  };
  const openWindows = [{
    windowId: 3,
    groups: [{ id: 'live', title: 'Live', tabs: [{ url: 'https://live.example/', title: 'Buried title', tabId: 11 }] }],
    ungrouped: [],
  }];
  const found = searchLibrary(store, openWindows, 'Buried', { scope: 'all', collapsedSessionIds: ['s1'] });
  assert.equal(found.results.some((item) => item.kind === 'session-group'), true);
  const loose = found.results.find((item) => item.url === 'https://loose.example/');
  assert.equal(loose.kind, 'session-tab');
  const restoredLoose = planSelectiveRestore(store, loose);
  assert.equal(restoredLoose.openWindows[0].ungrouped[0].url, 'https://loose.example/');
  assert.equal(restoredLoose.store.sessions.length, 1);
  assert.equal(found.results.some((item) => item.kind === 'backup-tab'), true);
  assert.equal(found.results.some((item) => item.tabId === 11), true);
  assert.equal(found.store.sessions[0].name, 'Friday');
  const savedOnly = searchLibrary(store, openWindows, 'Buried', { scope: 'saved' });
  assert.equal(savedOnly.results.some((item) => item.tabId === 11), false);
  const focused = findOpenTab(openWindows, { tabId: 11 });
  assert.equal(focused.tabId, 11);
});

test('sorting the list does not reorder saved tabs or live tab urls inside a group', () => {
  const store = {
    backups: [{
      id: 'keep',
      name: 'Keep',
      color: null,
      tabs: [{ url: 'https://keep.example/1', title: 'K' }],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }],
  };
  const groups = [
    { title: 'B', tabs: [{ url: 'https://z.example/2' }, { url: 'https://a.example/1' }] },
    { title: 'A', tabs: [{ url: 'https://a.example/' }] },
  ];
  const sorted = sortActiveGroups(groups, 'name');
  assert.equal(sorted[0].title, 'A');
  assert.deepEqual(groups[0].tabs.map((tab) => tab.url), ['https://z.example/2', 'https://a.example/1']);
  const moved = sortTabsBySite(groups[0].tabs);
  assert.deepEqual(moved.map((tab) => tab.url), ['https://a.example/1', 'https://z.example/2']);
  const placed = planSiteSortMoves([
    { url: 'https://z.example/2', tabId: 8, index: 6 },
    { url: 'https://a.example/1', tabId: 7, index: 5 },
  ]);
  assert.deepEqual(placed, [
    { tabId: 7, index: 5 },
    { tabId: 8, index: 6 },
  ]);
  assert.equal(store.backups[0].tabs[0].url, 'https://keep.example/1');
  const remembered = rememberSort({ ...store, sort: { active: 'browser', saved: 'recent' } }, 'active', 'count');
  assert.equal(remembered.sort.active, 'count');
  assert.equal(remembered.sort.saved, 'recent');
});

test('markdown import stays a link list while json import restores structure past ten backups', () => {
  const backup = {
    id: 'b',
    name: 'Research',
    color: 'blue',
    tabs: [{ url: 'https://a.example/1', title: 'A' }],
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
  const session = {
    id: 's',
    name: 'Friday',
    pinned: false,
    windows: [{ id: 1, name: '窗口 1', groups: [{ id: 'g', name: 'Research', color: 'blue', tabs: [{ url: 'https://a.example/1', title: 'A' }] }], ungrouped: [] }],
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
  const markdown = exportBackup(backup, 'markdown');
  const preview = previewImport(markdown, 'markdown');
  assert.equal(preview.restorable, false);
  const full = {
    backups: Array.from({ length: 10 }, (_, index) => ({
      id: `old-${index}`,
      name: `Old ${index}`,
      color: null,
      tabs: [{ url: `https://old.example/${index}`, title: 'Old' }],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    })),
  };
  const links = applyImport(full, preview, { createId: () => 'list-1' });
  assert.equal(links.ok, true);
  assert.equal(links.store.backups.length, 10);
  assert.equal(restoreGroupBackup(links.store, 'list-1').ok, false);

  const json = exportLibrary({ backups: [backup], sessions: [session] }, 'json');
  const jsonPreview = previewImport(json, 'json');
  assert.equal(jsonPreview.restorable, true);
  let n = 0;
  const imported = applyImport(full, jsonPreview, { createId: () => `imp-${n += 1}` });
  assert.equal(imported.store.backups.length, 11);
  assert.equal(imported.store.sessions[0].windows[0].groups[0].color, 'blue');
  const csv = exportSession(session, 'csv');
  assert.equal(previewImport(csv, 'csv').restorable, false);
});

test('editing a group backup leaves other sessions alone, and session edits can move and insert', () => {
  const saved = saveSession({ backups: [] }, liveWindows, { name: 'Friday', createId: () => 'session-1' });
  const backup = saveActiveRow(saved.store, liveWindows[0], { kind: 'group', groupId: 'research' }, { createId: () => 'backup-1' });
  const edited = editGroupBackup(backup.store, 'backup-1', {
    name: 'Renamed',
    color: 'pink',
    tabs: [{ url: 'https://a.example/9', title: 'Nine' }],
  });
  assert.equal(edited.store.sessions[0].windows[0].groups[0].name, 'Research');
  const renamed = renameSession(edited.store, 'session-1', 'Friday research');
  const reordered = reorderSessionWindows(renamed.store, 'session-1', [2, 1]);
  assert.deepEqual(reordered.session.windows.map((win) => win.id), [2, 1]);
  const groups = reorderSessionGroups(reordered.store, 'session-1', 1, ['blank', 'research']);
  assert.equal(groups.session.windows.find((win) => win.id === 1).groups[0].id, 'blank');
  const moved = moveSessionGroup(groups.store, 'session-1', 'research', 2);
  assert.equal(moved.session.windows.find((win) => win.id === 2).groups.some((group) => group.id === 'research'), true);
  const inserted = addBackupToSession(moved.store, 'session-1', 2, 'backup-1', { createId: () => 'inserted' });
  assert.equal(inserted.store.backups.some((item) => item.id === 'backup-1'), true);
  assert.equal(inserted.session.windows.find((win) => win.id === 2).groups.some((group) => group.name === 'Renamed'), true);
  const pinned = pinSession(inserted.store, 'session-1');
  const ordered = sortSavedItems(pinned.store, 'name');
  assert.equal(ordered.sessions[0].pinned, true);
  const removed = deleteSession(pinned.store, 'session-1');
  assert.equal(removed.store.backups.length, 1);
});

test('selective restore asks for one tab and still leaves the session in place', () => {
  const saved = saveSession({ backups: [] }, [{
    windowId: 4,
    groups: [{
      id: 'g',
      title: 'Read',
      color: 'orange',
      tabs: [
        { url: 'https://keep.example/page', title: 'Keep' },
        { url: 'chrome://newtab', title: 'New' },
      ],
    }],
    ungrouped: [],
  }], { name: 'Once', createId: () => 'session-9' });
  const planned = planSelectiveRestore(saved.store, {
    kind: 'session-tab',
    sessionId: 'session-9',
    windowId: 4,
    groupId: 'g',
    url: 'https://keep.example/page',
  });
  assert.equal(planned.openWindows[0].groups[0].tabs.length, 1);
  assert.equal(planned.store.sessions.length, 1);
  const blocked = planSelectiveRestore(saved.store, {
    kind: 'session-tab',
    sessionId: 'session-9',
    windowId: 4,
    groupId: 'g',
    url: 'chrome://newtab',
  });
  assert.equal(blocked.openWindows[0].groups[0].tabs.length, 0);
  assert.equal(blocked.skipped.length, 1);
});

test('update keeps one backup when the same chrome group gains a url and the snapshot has no backupId', () => {
  const snap = (urls) => [{
    windowId: 7,
    groups: [{
      id: 42,
      title: 'Research',
      color: 'blue',
      tabs: urls.map((url, index) => ({ url, title: `T${index}`, pinned: false, tabId: index + 1 })),
    }],
    ungrouped: [],
  }];
  const created = saveAllGroups({ backups: [] }, snap(['https://a.example/1']), {
    mode: 'update',
    now: '2026-10-18T01:00:00.000Z',
    createId: () => 'gb-1',
  });
  assert.equal(created.saved.length, 1);
  assert.equal(created.store.backups.length, 1);
  const updated = saveAllGroups(created.store, snap(['https://a.example/1', 'https://a.example/2']), {
    mode: 'update',
    now: '2026-10-18T02:00:00.000Z',
    createId: () => 'gb-2',
  });
  assert.deepEqual(updated.saved.map((item) => item.id), []);
  assert.equal(updated.updated.length, 1);
  assert.equal(updated.store.backups.length, 1);
  assert.equal(updated.store.backups[0].id, 'gb-1');
  assert.equal(updated.store.backups[0].tabs[1].url, 'https://a.example/2');

  const row = saveActiveRow({ backups: [] }, snap(['https://a.example/1'])[0], { kind: 'group', groupId: 42 }, {
    now: '2026-10-18T03:00:00.000Z',
    createId: () => 'row-1',
  });
  const again = saveAllGroups(row.store, snap(['https://changed.example/']), {
    mode: 'update',
    now: '2026-10-18T04:00:00.000Z',
    createId: () => 'gb-9',
  });
  assert.equal(again.saved.length, 0);
  assert.equal(again.updated[0].id, 'row-1');
  assert.equal(again.store.backups.length, 1);
  assert.equal(again.store.backups[0].tabs[0].url, 'https://changed.example/');
});

test('editing a session group changes its title, urls, order, and membership only inside that session', () => {
  const store = {
    backups: [{
      id: 'keep',
      name: 'Keep',
      color: null,
      tabs: [{ url: 'https://keep.example/', title: 'K' }],
      createdAt: 't',
      updatedAt: 't',
    }],
    sessions: [
      {
        id: 's1',
        name: 'One',
        pinned: false,
        windows: [{
          id: 1,
          name: 'W',
          groups: [{
            id: 'g',
            name: 'Old',
            color: 'blue',
            tabs: [
              { url: 'https://a.example/', title: 'A' },
              { url: 'https://b.example/', title: 'B' },
            ],
          }],
          ungrouped: [],
        }],
        createdAt: 't',
        updatedAt: 't',
      },
      {
        id: 's2',
        name: 'Two',
        pinned: false,
        windows: [{
          id: 2,
          name: 'W2',
          groups: [{
            id: 'g',
            name: 'Old',
            color: 'blue',
            tabs: [{ url: 'https://a.example/', title: 'A' }],
          }],
          ungrouped: [],
        }],
        createdAt: 't',
        updatedAt: 't',
      },
    ],
  };
  const moved = editSessionGroup(store, 's1', 'g', {
    tabs: [
      { url: 'https://b.example/', title: 'B' },
      { url: 'https://a.example/', title: 'A' },
    ],
  });
  assert.deepEqual(moved.group.tabs.map((tab) => tab.url), ['https://b.example/', 'https://a.example/']);
  const edited = editSessionGroup(moved.store, 's1', 'g', {
    name: 'New title',
    tabs: [
      { url: 'https://b.example/moved', title: 'B2', password: 'secret' },
      { url: 'https://c.example/', title: 'Added' },
    ],
  });
  assert.equal(edited.group.name, 'New title');
  assert.deepEqual(edited.group.tabs, [
    { url: 'https://b.example/moved', title: 'B2' },
    { url: 'https://c.example/', title: 'Added' },
  ]);
  assert.equal(edited.store.sessions[1].windows[0].groups[0].name, 'Old');
  assert.deepEqual(edited.store.sessions[1].windows[0].groups[0].tabs, [{ url: 'https://a.example/', title: 'A' }]);
  assert.equal(edited.store.backups[0].tabs[0].url, 'https://keep.example/');
  assert.equal(store.sessions[0].windows[0].groups[0].name, 'Old');
});

test('session group save keeps pinned on an existing tab and leaves a new url unpinned', () => {
  const existing = [
    { url: 'https://a.example/', title: 'A', pinned: true },
    { url: 'https://b.example/', title: 'B' },
  ];
  const fields = [
    { url: 'https://a.example/edited', title: 'A2' },
    { url: 'https://b.example/', title: 'B' },
  ];
  const payload = sessionGroupFormTabs(existing, fields, { url: 'https://c.example/', title: 'Added' });
  assert.equal(payload[0].pinned, true);
  assert.equal(payload[1].pinned, undefined);
  assert.equal(payload[2].pinned, undefined);
  const store = {
    sessions: [{
      id: 's1',
      name: 'One',
      pinned: false,
      windows: [{
        id: 1,
        name: 'W',
        groups: [{ id: 'g', name: 'Old', color: 'blue', tabs: existing }],
        ungrouped: [],
      }],
      createdAt: 't',
      updatedAt: 't',
    }],
  };
  const dropped = editSessionGroup(store, 's1', 'g', { name: 'Renamed', tabs: fields });
  assert.equal(dropped.group.tabs[0].pinned, undefined);
  const kept = editSessionGroup(store, 's1', 'g', { name: 'Renamed', tabs: payload });
  assert.equal(kept.group.name, 'Renamed');
  assert.equal(kept.group.tabs[0].pinned, true);
  assert.equal(kept.group.tabs[0].url, 'https://a.example/edited');
  assert.equal(kept.group.tabs[2].url, 'https://c.example/');
  assert.equal(kept.group.tabs[2].pinned, undefined);
  assert.equal(store.sessions[0].windows[0].groups[0].tabs[0].pinned, true);
});

test('window close auto-save can be off, and a second close still appends no cap', () => {
  const snapshot = liveWindows[0];
  const skipped = autoSaveClosedWindow({ backups: [] }, snapshot, { enabled: false, createId: () => 'nope' });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.store.backups.length, 0);
  const once = autoSaveClosedWindow({ backups: [] }, snapshot, {
    enabled: true,
    createId: () => 'auto-1',
    now: '2026-10-18T01:00:00.000Z',
  });
  assert.equal(once.store.backups.length, 1);
  const twice = autoSaveClosedWindow(once.store, {
    ...snapshot,
    groups: [{
      ...snapshot.groups[0],
      tabs: [{ url: 'https://brand-new.example/', title: 'New' }],
    }],
  }, {
    enabled: true,
    createId: () => 'auto-2',
    now: '2026-10-18T02:00:00.000Z',
  });
  assert.equal(twice.ok, true);
  assert.equal(twice.store.backups.length, 2);
});

test('drive sync keeps local copies and does not store the access token', async () => {
  const missing = connectDrive({ backups: [] }, {});
  assert.equal(missing.ok, false);
  const token = 'user-supplied-token';
  const connected = connectDrive({
    backups: [{
      id: 'b',
      name: 'Research',
      color: null,
      tabs: [{ url: 'https://a.example/', title: 'A' }],
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
    }],
  }, { accountLabel: 'me@example.com', accessToken: token });
  assert.equal(JSON.stringify(connected.store).includes(token), false);
  let seen = '';
  const synced = await syncDrive(connected.store, {
    accessToken: token,
    now: '2026-10-18T03:00:00.000Z',
    createId: () => 'hist-1',
    fetchImpl: async (_url, init) => {
      seen = init.body;
      return { ok: true };
    },
  });
  assert.equal(synced.ok, true);
  assert.equal(synced.store.backups.length, 1);
  assert.equal(synced.store.drive.history.length, 1);
  assert.equal(seen.includes(token), false);
  const disconnected = disconnectDrive(synced.store);
  assert.equal(disconnected.store.drive.connected, false);
  assert.equal(disconnected.store.backups.length, 1);
  const again = reconnectDrive(disconnected.store, { accountLabel: 'me@example.com', accessToken: token });
  assert.equal(again.store.drive.history.length, 1);
  assert.equal(again.store.backups[0].name, 'Research');
});

test('new group, save-and-close, and settings do not add a plan gate', () => {
  assert.equal(planNewGroup({ name: '  ' }).ok, false);
  assert.equal(planNewGroup({ name: 'Inbox', color: 'cyan' }).color, 'cyan');
  const closed = planCloseTabs([{ url: 'https://a.example/', title: 'A' }, { url: '', title: 'skip' }]);
  assert.deepEqual(closed.closeUrls, ['https://a.example/']);
  const saved = planSaveAndClose({ backups: [] }, liveWindows[0], { kind: 'group', groupId: 'research' }, {
    createId: () => 'row-1',
  });
  assert.equal(saved.message, '备份已保存');
  assert.equal(saved.closeUrls[0], 'https://a.example/1');
  const windowSaved = saveWindow({ backups: [] }, { ...liveWindows[0], left: 10, height: 400 }, {
    name: 'Window A',
    createId: () => 'win-1',
  });
  assert.equal(windowSaved.session.windows[0].height, undefined);
  const settings = updateSettings({ backups: [] }, {
    language: 'en',
    theme: 'midnight',
    autoSaveOnWindowClose: true,
    analytics: true,
    license: 'should-drop',
  });
  assert.equal(settings.settings.theme, 'midnight');
  assert.equal(settings.settings.license, undefined);
  assert.equal(clearSaved({ ...settings, backups: [{ id: 'x', name: 'X', color: null, tabs: [{ url: 'https://a.example/', title: 'A' }], createdAt: 't', updatedAt: 't' }] }).backups.length, 0);
  assert.equal(clearSaved(settings).settings.analytics, true);
});
