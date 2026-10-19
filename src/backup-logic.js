export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const COLOR_SET = new Set(GROUP_COLORS);
const THEMES = new Set(['light', 'dark', 'midnight', 'contrast']);
const RESTRICTED_PREFIXES = [
  'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:',
  'edge:', 'about:', 'devtools:', 'view-source:',
];

function text(value) {
  return String(value ?? '').trim();
}

function cloneBackup(backup) {
  return {
    id: backup.id,
    name: backup.name,
    color: backup.color ?? null,
    tabs: (backup.tabs || []).map(copyTab),
    createdAt: backup.createdAt,
    updatedAt: backup.updatedAt,
  };
}

function copyTab(tab) {
  const item = { url: tab.url, title: String(tab?.title ?? '') };
  if (tab?.pinned) item.pinned = true;
  return item;
}

function cloneSession(session) {
  return {
    id: session.id,
    name: session.name,
    pinned: Boolean(session.pinned),
    windows: (session.windows || []).map(cloneCapturedWindow),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function cloneCapturedWindow(win) {
  return {
    id: win.id,
    name: win.name || '',
    groups: (win.groups || []).map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color ?? null,
      tabs: (group.tabs || []).map(copyTab),
    })),
    ungrouped: (win.ungrouped || []).map(copyTab),
  };
}

export function usableTabs(tabs) {
  const saved = [];
  for (const tab of tabs || []) {
    const url = text(tab?.url);
    if (!url) continue;
    saved.push(copyTab({ url, title: tab?.title, pinned: tab?.pinned }));
  }
  return saved;
}

export function restrictionReason(url) {
  const value = text(url).toLowerCase();
  if (!value) return '没有页面地址';
  if (RESTRICTED_PREFIXES.some((prefix) => value.startsWith(prefix))) return '受限网址，未打开';
  return '';
}

export function splitTabs(tabs) {
  const open = [];
  const skipped = [];
  for (const tab of usableTabs(tabs)) {
    const reason = restrictionReason(tab.url);
    if (reason) skipped.push({ url: tab.url, title: tab.title, reason });
    else open.push(tab);
  }
  return { open, skipped };
}

function skippedMessage(skipped) {
  if (!skipped.length) return '';
  const lines = skipped.map((item) => `${item.url}（${item.reason}）`);
  return `这些页面没有打开：${lines.join('、')}`;
}

function defaultSettings() {
  return {
    language: 'zh-CN',
    theme: 'light',
    autoSaveOnWindowClose: false,
    analytics: false,
    tourSeen: false,
    tourStep: 0,
  };
}

export function normalizeStore(store) {
  const current = store && typeof store === 'object' ? store : {};
  const settings = { ...defaultSettings(), ...(current.settings || {}) };
  if (!THEMES.has(settings.theme)) settings.theme = 'light';
  if (settings.language !== 'en') settings.language = 'zh-CN';
  const backups = Array.isArray(current.backups) ? current.backups.map(cloneBackup) : [];
  return {
    backups,
    sessions: Array.isArray(current.sessions) ? current.sessions.map(cloneSession) : [],
    linkLists: Array.isArray(current.linkLists)
      ? current.linkLists.map((list) => ({
        id: list.id,
        name: list.name,
        links: (list.links || []).map((link) => ({ title: String(link.title ?? ''), url: link.url })),
        createdAt: list.createdAt,
      }))
      : [],
    settings,
    drive: {
      connected: Boolean(current.drive?.connected),
      accountLabel: text(current.drive?.accountLabel),
      history: Array.isArray(current.drive?.history)
        ? current.drive.history.map((item) => ({ id: item.id, at: item.at, name: item.name || '库备份' }))
        : [],
      lastSyncAt: current.drive?.lastSyncAt || null,
    },
    undo: current.undo ? {
      at: current.undo.at,
      entries: (current.undo.entries || []).map((entry) => ({
        id: entry.id,
        updatedAt: entry.updatedAt,
        previous: cloneBackup(entry.previous),
      })),
    } : null,
    sort: {
      active: current.sort?.active || 'browser',
      saved: current.sort?.saved || 'recent',
    },
    groupLinks: normalizeGroupLinks(current.groupLinks, new Set(backups.map((backup) => backup.id))),
  };
}

function normalizeGroupLinks(value, backupIds) {
  const links = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return links;
  for (const [groupId, backupId] of Object.entries(value)) {
    const key = text(groupId);
    const id = text(backupId);
    if (!key || !id) continue;
    if (backupIds && !backupIds.has(id)) continue;
    links[key] = id;
  }
  return links;
}

function fail(store, code, message) {
  return { ok: false, code, store: normalizeStore(store), message };
}

function withBackups(store, backups, extra = {}) {
  return { ...normalizeStore(store), ...extra, backups: backups.map(cloneBackup) };
}

function selectedRow(windowSnapshot, selection) {
  if (selection?.kind === 'ungrouped') {
    return {
      named: false,
      color: null,
      tabs: windowSnapshot?.ungrouped || [],
    };
  }
  if (selection?.kind !== 'group') return null;
  const group = (windowSnapshot?.groups || []).find(
    (item) => String(item.id) === String(selection.groupId),
  );
  if (!group) return null;
  const title = text(group.title || group.name);
  return {
    named: title.length > 0,
    name: title,
    color: text(group.color) || null,
    tabs: group.tabs || [],
  };
}

function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function urlKey(tabs) {
  return usableTabs(tabs).map((tab) => tab.url).sort().join('\n');
}

function nextId(options, prefix, count) {
  return options.createId ? options.createId() : `${prefix}-${count + 1}`;
}

export function saveActiveRow(store, windowSnapshot, selection, options = {}) {
  const current = normalizeStore(store);
  const row = selectedRow(windowSnapshot, selection);
  if (!row) return fail(current, 'missing-row', '当前窗口没有这一行。');

  const tabs = usableTabs(row.tabs);
  if (tabs.length === 0) return fail(current, 'empty', '这一行没有可保存的页面地址。');

  const name = row.named ? row.name : text(options.enteredName);
  if (!name) return fail(current, 'name-required', '请输入名称');

  const mode = options.mode || 'new';
  const now = options.now || new Date().toISOString();
  const color = row.color;

  if (mode === 'update') {
    const index = current.backups.findIndex((backup) => backup.id === options.existingId);
    if (index < 0) return fail(current, 'not-found', '找不到这份备份。');
    const previous = current.backups[index];
    const backups = current.backups.map(cloneBackup);
    backups[index] = {
      id: previous.id,
      name,
      color,
      tabs,
      createdAt: previous.createdAt,
      updatedAt: now,
    };
    return {
      ok: true,
      store: withBackups(current, backups, { groupLinks: rememberRowLink(current, selection, previous.id) }),
      backup: cloneBackup(backups[index]),
      message: '备份已保存',
    };
  }

  const backup = {
    id: nextId(options, 'gb', current.backups.length),
    name,
    color,
    tabs,
    createdAt: now,
    updatedAt: now,
  };
  return {
    ok: true,
    store: withBackups(current, [...current.backups, backup], { groupLinks: rememberRowLink(current, selection, backup.id) }),
    backup: cloneBackup(backup),
    message: '备份已保存',
  };
}

function rememberRowLink(store, selection, backupId) {
  const links = { ...(store.groupLinks || {}) };
  if (selection?.kind !== 'group') return links;
  const groupId = text(selection.groupId);
  if (!groupId) return links;
  links[groupId] = backupId;
  return links;
}

export function restoreGroupBackup(store, id) {
  const current = normalizeStore(store);
  const backup = current.backups.find((item) => item.id === id);
  if (!backup) return fail(current, 'not-found', '找不到这份备份。');
  const { open, skipped } = splitTabs(backup.tabs);
  return {
    ok: true,
    store: current,
    backup,
    open: {
      name: backup.name,
      color: backup.color ?? null,
      urls: open.map((tab) => tab.url),
      tabs: open,
      skipped,
    },
    message: skippedMessage(skipped),
  };
}

function groupName(group) {
  return text(group?.title || group?.name);
}

function contentMatch(backups, tabs) {
  const key = urlKey(tabs);
  if (!key) return null;
  return backups.find((backup) => urlKey(backup.tabs) === key) || null;
}

export function saveAllGroups(store, windows, options = {}) {
  const current = normalizeStore(store);
  const mode = options.mode === 'new' ? 'new' : 'update';
  const now = options.now || new Date().toISOString();
  const backups = current.backups.map(cloneBackup);
  const saved = [];
  const updated = [];
  const failed = [];
  const undoEntries = [];
  const trackGroups = options.linkGroups !== false;
  const groupLinks = { ...(current.groupLinks || {}) };

  function rememberGroup(group, backupId, overwrite) {
    if (!trackGroups) return;
    const groupId = text(group?.id);
    if (!groupId) return;
    if (!overwrite && groupLinks[groupId]) return;
    groupLinks[groupId] = backupId;
  }

  function linkedBackup(group) {
    if (!trackGroups) return null;
    const backupId = group.backupId || groupLinks[text(group?.id)];
    if (!backupId) return null;
    return backups.find((backup) => backup.id === backupId) || null;
  }

  for (const win of windows || []) {
    for (const group of win?.groups || []) {
      const name = groupName(group);
      const tabs = usableTabs(group?.tabs);
      if (!name) {
        failed.push({ name: '未命名组', reason: '请输入名称' });
        continue;
      }
      if (tabs.length === 0) {
        failed.push({ name, reason: '这一行没有可保存的页面地址。' });
        continue;
      }
      const match = mode === 'update' ? (linkedBackup(group) || contentMatch(backups, tabs)) : null;
      if (match) {
        const index = backups.findIndex((backup) => backup.id === match.id);
        undoEntries.push({ id: match.id, updatedAt: now, previous: cloneBackup(backups[index]) });
        const next = {
          id: match.id,
          name,
          color: text(group.color) || null,
          tabs,
          createdAt: match.createdAt,
          updatedAt: now,
        };
        backups[index] = next;
        updated.push(cloneBackup(next));
        rememberGroup(group, match.id, true);
      } else {
        const created = {
          id: nextId(options, 'gb', backups.length + saved.length),
          name,
          color: text(group.color) || null,
          tabs,
          createdAt: now,
          updatedAt: now,
        };
        backups.push(created);
        saved.push(cloneBackup(created));
        rememberGroup(group, created.id, mode === 'update');
      }
    }
  }

  const undo = undoEntries.length ? { at: now, entries: undoEntries } : current.undo;
  return {
    ok: true,
    store: withBackups(current, backups, { undo, groupLinks }),
    saved,
    updated,
    failed,
    message: `已保存 ${saved.length}，已更新 ${updated.length}，未能保存 ${failed.length}`,
  };
}

export function undoUpdates(store) {
  const current = normalizeStore(store);
  if (!current.undo?.entries?.length) return fail(current, 'nothing-to-undo', '没有可撤销的更新。');
  const backups = current.backups.map(cloneBackup);
  for (const entry of current.undo.entries) {
    const index = backups.findIndex((backup) => backup.id === entry.id);
    if (index < 0) continue;
    if (backups[index].updatedAt !== entry.updatedAt) continue;
    backups[index] = cloneBackup(entry.previous);
  }
  return {
    ok: true,
    store: withBackups(current, backups, { undo: null }),
    message: '已撤销更新',
  };
}

function captureWindow(win, name) {
  return {
    id: win.windowId ?? win.id,
    name: name || win.name || '',
    groups: (win.groups || []).map((group) => ({
      id: String(group.id),
      name: groupName(group),
      color: text(group.color) || null,
      tabs: usableTabs(group.tabs),
    })),
    ungrouped: usableTabs(win.ungrouped),
  };
}

export function saveSession(store, windows, options = {}) {
  const current = normalizeStore(store);
  const name = text(options.name);
  if (!name) return fail(current, 'name-required', '请输入名称');
  const captured = (windows || []).map((win, index) => captureWindow(win, win.name || `窗口 ${index + 1}`));
  if (captured.length === 0) return fail(current, 'empty', '没有可保存的窗口。');
  const now = options.now || new Date().toISOString();
  const session = {
    id: nextId(options, 'ss', current.sessions.length),
    name,
    pinned: false,
    windows: captured,
    createdAt: now,
    updatedAt: now,
  };
  return {
    ok: true,
    store: { ...current, sessions: [...current.sessions, cloneSession(session)] },
    session: cloneSession(session),
    message: '会话已保存',
  };
}

export function saveWindow(store, windowSnapshot, options = {}) {
  const named = { ...windowSnapshot, name: text(options.name) };
  return saveSession(store, [named], options);
}

function sessionById(store, sessionId) {
  return store.sessions.find((session) => session.id === sessionId) || null;
}

export function planSessionRestore(store, sessionId, options = {}) {
  const current = normalizeStore(store);
  const session = sessionById(current, sessionId);
  if (!session) return fail(current, 'not-found', '找不到这份会话。');
  let windows = session.windows;
  if (options.windowId != null) {
    windows = windows.filter((win) => String(win.id) === String(options.windowId));
    if (windows.length === 0) return fail(current, 'not-found', '找不到这个窗口。');
  }
  const skipped = [];
  const openWindows = windows.map((win) => ({
    groups: win.groups.map((group) => {
      const parts = splitTabs(group.tabs);
      skipped.push(...parts.skipped);
      return { id: group.id, name: group.name, color: group.color ?? null, tabs: parts.open };
    }),
    ungrouped: (() => {
      const parts = splitTabs(win.ungrouped);
      skipped.push(...parts.skipped);
      return parts.open;
    })(),
  }));
  return {
    ok: true,
    store: current,
    session,
    openWindows,
    skipped,
    message: skippedMessage(skipped),
  };
}

export function deleteBackup(store, id) {
  const current = normalizeStore(store);
  if (!current.backups.some((backup) => backup.id === id)) return fail(current, 'not-found', '找不到这份备份。');
  const backups = current.backups.filter((backup) => backup.id !== id);
  const groupLinks = Object.fromEntries(Object.entries(current.groupLinks).filter(([, backupId]) => backupId !== id));
  return {
    ok: true,
    store: withBackups(current, backups, { groupLinks }),
    message: '已删除',
  };
}

export function deleteSession(store, id) {
  const current = normalizeStore(store);
  if (!sessionById(current, id)) return fail(current, 'not-found', '找不到这份会话。');
  return {
    ok: true,
    store: { ...current, sessions: current.sessions.filter((session) => session.id !== id) },
    message: '已删除',
  };
}

export function editGroupBackup(store, id, patch = {}, options = {}) {
  const current = normalizeStore(store);
  const index = current.backups.findIndex((backup) => backup.id === id);
  if (index < 0) return fail(current, 'not-found', '找不到这份备份。');
  const name = text(patch.name);
  if (!name) return fail(current, 'name-required', '请输入名称');
  const tabs = usableTabs(patch.tabs || []);
  if (tabs.length === 0) return fail(current, 'empty', '这一行没有可保存的页面地址。');
  const previous = current.backups[index];
  const backups = current.backups.map(cloneBackup);
  backups[index] = {
    id: previous.id,
    name,
    color: text(patch.color) || null,
    tabs,
    createdAt: previous.createdAt,
    updatedAt: options.now || new Date().toISOString(),
  };
  return {
    ok: true,
    store: withBackups(current, backups),
    backup: cloneBackup(backups[index]),
    message: '备份已保存',
  };
}

function replaceSession(store, session) {
  return {
    ...store,
    sessions: store.sessions.map((item) => (item.id === session.id ? cloneSession(session) : cloneSession(item))),
  };
}

export function renameSession(store, sessionId, name, options = {}) {
  const current = normalizeStore(store);
  const session = sessionById(current, sessionId);
  if (!session) return fail(current, 'not-found', '找不到这份会话。');
  const title = text(name);
  if (!title) return fail(current, 'name-required', '请输入名称');
  session.name = title;
  session.updatedAt = options.now || session.updatedAt;
  return { ok: true, store: replaceSession(current, session), session: cloneSession(session), message: '会话已保存' };
}

export function pinSession(store, sessionId) {
  const current = normalizeStore(store);
  const session = sessionById(current, sessionId);
  if (!session) return fail(current, 'not-found', '找不到这份会话。');
  session.pinned = !session.pinned;
  return { ok: true, store: replaceSession(current, session), session: cloneSession(session), message: session.pinned ? '已置顶' : '已取消置顶' };
}

export function reorderSessionWindows(store, sessionId, orderedIds) {
  const current = normalizeStore(store);
  const session = sessionById(current, sessionId);
  if (!session) return fail(current, 'not-found', '找不到这份会话。');
  const map = new Map(session.windows.map((win) => [String(win.id), win]));
  const next = [];
  for (const id of orderedIds || []) {
    const win = map.get(String(id));
    if (win) {
      next.push(win);
      map.delete(String(id));
    }
  }
  session.windows = [...next, ...map.values()];
  return { ok: true, store: replaceSession(current, session), session: cloneSession(session) };
}

export function reorderSessionGroups(store, sessionId, windowId, orderedIds) {
  const current = normalizeStore(store);
  const session = sessionById(current, sessionId);
  if (!session) return fail(current, 'not-found', '找不到这份会话。');
  const win = session.windows.find((item) => String(item.id) === String(windowId));
  if (!win) return fail(current, 'not-found', '找不到这个窗口。');
  const map = new Map(win.groups.map((group) => [String(group.id), group]));
  const next = [];
  for (const id of orderedIds || []) {
    const group = map.get(String(id));
    if (group) {
      next.push(group);
      map.delete(String(id));
    }
  }
  win.groups = [...next, ...map.values()];
  return { ok: true, store: replaceSession(current, session), session: cloneSession(session) };
}

export function moveSessionGroup(store, sessionId, groupId, toWindowId) {
  const current = normalizeStore(store);
  const session = sessionById(current, sessionId);
  if (!session) return fail(current, 'not-found', '找不到这份会话。');
  const target = session.windows.find((win) => String(win.id) === String(toWindowId));
  let source = null;
  let index = -1;
  for (const win of session.windows) {
    index = win.groups.findIndex((group) => String(group.id) === String(groupId));
    if (index >= 0) {
      source = win;
      break;
    }
  }
  if (!source || !target) return fail(current, 'not-found', '找不到这个分组。');
  const [moved] = source.groups.splice(index, 1);
  target.groups.push(moved);
  return { ok: true, store: replaceSession(current, session), session: cloneSession(session) };
}

export function sessionGroupFormTabs(existingTabs, fields, extra) {
  const tabs = (fields || []).map((field, index) => {
    const tab = { url: field?.url, title: field?.title };
    if (existingTabs?.[index]?.pinned) tab.pinned = true;
    return tab;
  });
  const extraUrl = text(extra?.url);
  if (extraUrl) tabs.push({ url: extraUrl, title: extra?.title ?? '' });
  return tabs;
}

export function editSessionGroup(store, sessionId, groupId, patch = {}, options = {}) {
  const current = normalizeStore(store);
  const session = sessionById(current, sessionId);
  if (!session) return fail(current, 'not-found', '找不到这份会话。');
  let group = null;
  for (const win of session.windows) {
    group = win.groups.find((item) => String(item.id) === String(groupId)) || null;
    if (group) break;
  }
  if (!group) return fail(current, 'not-found', '找不到这个分组。');
  if (patch.name != null) {
    const name = text(patch.name);
    if (!name) return fail(current, 'name-required', '请输入名称');
    group.name = name;
  }
  if (patch.tabs != null) group.tabs = usableTabs(patch.tabs);
  session.updatedAt = options.now || new Date().toISOString();
  const saved = cloneSession(session);
  const savedGroup = saved.windows.flatMap((win) => win.groups).find((item) => String(item.id) === String(groupId));
  return {
    ok: true,
    store: replaceSession(current, session),
    session: saved,
    group: savedGroup,
    message: '已更新分组',
  };
}

export function addBackupToSession(store, sessionId, windowId, backupId, options = {}) {
  const current = normalizeStore(store);
  const session = sessionById(current, sessionId);
  const backup = current.backups.find((item) => item.id === backupId);
  const win = session?.windows.find((item) => String(item.id) === String(windowId));
  if (!session || !backup || !win) return fail(current, 'not-found', '找不到要加入的备份。');
  win.groups.push({
    id: nextId(options, 'sg', win.groups.length),
    name: backup.name,
    color: backup.color ?? null,
    tabs: backup.tabs.map(copyTab),
  });
  return {
    ok: true,
    store: replaceSession(current, session),
    session: cloneSession(session),
    message: '已加入会话',
  };
}

function includesQuery(values, query) {
  return values.some((value) => text(value).toLowerCase().includes(query));
}

export function searchLibrary(store, openWindows, query, options = {}) {
  const current = normalizeStore(store);
  const needle = text(query).toLowerCase();
  const scope = options.scope || 'all';
  const results = [];
  if (!needle) return { results, store: current };
  if (scope !== 'saved') {
    for (const win of openWindows || []) {
      for (const group of win.groups || []) {
        if (includesQuery([group.title, group.name], needle)) {
          results.push({
            kind: 'open-group', windowId: win.windowId ?? win.id, groupId: group.id,
            label: groupName(group), path: '打开中',
          });
        }
        for (const tab of group.tabs || []) {
          if (includesQuery([tab.title, tab.url], needle)) {
            results.push({
              kind: 'open-tab', windowId: win.windowId ?? win.id, groupId: group.id, tabId: tab.tabId, url: tab.url,
              label: tab.title || tab.url, path: `打开中 / ${groupName(group) || '未分组标签'}`,
            });
          }
        }
      }
      for (const tab of win.ungrouped || []) {
        if (includesQuery([tab.title, tab.url], needle)) {
          results.push({
            kind: 'open-tab', windowId: win.windowId ?? win.id, tabId: tab.tabId, url: tab.url,
            label: tab.title || tab.url, path: '打开中 / 未分组标签',
          });
        }
      }
    }
  }
  if (scope !== 'open') {
    for (const session of current.sessions) {
      if (includesQuery([session.name], needle)) {
        results.push({ kind: 'session', sessionId: session.id, label: session.name, path: '已保存 / 会话' });
      }
      for (const win of session.windows) {
        if (includesQuery([win.name], needle)) {
          results.push({
            kind: 'session-window', sessionId: session.id, windowId: win.id,
            label: win.name || session.name, path: `已保存 / ${session.name}`,
          });
        }
        for (const group of win.groups) {
          if (includesQuery([group.name], needle)) {
            results.push({
              kind: 'session-group', sessionId: session.id, windowId: win.id, groupId: group.id,
              label: group.name, path: `已保存 / ${session.name}`,
            });
          }
          for (const tab of group.tabs) {
            if (includesQuery([tab.title, tab.url], needle)) {
              results.push({
                kind: 'session-tab', sessionId: session.id, windowId: win.id, groupId: group.id, url: tab.url,
                label: tab.title || tab.url, path: `已保存 / ${session.name} / ${group.name}`,
              });
            }
          }
        }
        for (const tab of win.ungrouped || []) {
          if (includesQuery([tab.title, tab.url], needle)) {
            results.push({
              kind: 'session-tab', sessionId: session.id, windowId: win.id, url: tab.url,
              label: tab.title || tab.url, path: `已保存 / ${session.name} / 未分组标签`,
            });
          }
        }
      }
    }
    for (const backup of current.backups) {
      if (includesQuery([backup.name], needle)) {
        results.push({ kind: 'backup', backupId: backup.id, label: backup.name, path: '已保存 / 组备份' });
      }
      for (const tab of backup.tabs) {
        if (includesQuery([tab.title, tab.url], needle)) {
          results.push({
            kind: 'backup-tab', backupId: backup.id, url: tab.url,
            label: tab.title || tab.url, path: `已保存 / ${backup.name}`,
          });
        }
      }
    }
  }
  return { results, store: current };
}

export function findOpenTab(openWindows, target = {}) {
  for (const win of openWindows || []) {
    const tabs = [
      ...(win.groups || []).flatMap((group) => group.tabs || []),
      ...(win.ungrouped || []),
    ];
    const found = tabs.find((tab) => (
      target.tabId != null && tab.tabId === target.tabId
    ) || (target.url && tab.url === target.url && target.tabId == null));
    if (found?.tabId != null) {
      return { ok: true, tabId: found.tabId, windowId: win.windowId ?? win.id };
    }
  }
  return { ok: false, message: '这个标签没有打开。' };
}

export function planSelectiveRestore(store, target = {}) {
  const current = normalizeStore(store);
  if (target.kind === 'backup' || target.kind === 'backup-tab') {
    const restored = restoreGroupBackup(current, target.backupId);
    if (!restored.ok) return restored;
    if (target.kind === 'backup-tab') {
      const tab = (restored.backup.tabs || []).find((item) => item.url === target.url);
      const reason = tab ? restrictionReason(tab.url) : '没有页面地址';
      if (!tab || reason) {
        return {
          ok: true,
          store: current,
          openWindows: [],
          skipped: [{ url: target.url || '', title: '', reason: reason || '没有页面地址' }],
          message: skippedMessage([{ url: target.url || '', reason: reason || '没有页面地址' }]),
        };
      }
      return {
        ok: true,
        store: current,
        openWindows: [{ groups: [{ name: restored.backup.name, color: restored.backup.color, tabs: [copyTab(tab)] }], ungrouped: [] }],
        skipped: [],
        message: '',
      };
    }
    return {
      ok: true,
      store: current,
      openWindows: [{
        groups: [{ name: restored.open.name, color: restored.open.color, tabs: restored.open.tabs }],
        ungrouped: [],
      }],
      skipped: restored.open.skipped,
      message: restored.message,
    };
  }
  if (target.kind === 'session') return planSessionRestore(current, target.sessionId);
  if (target.kind === 'session-window') {
    return planSessionRestore(current, target.sessionId, { windowId: target.windowId });
  }
  if (target.kind === 'session-group' || target.kind === 'session-tab') {
    const planned = planSessionRestore(current, target.sessionId, { windowId: target.windowId });
    if (!planned.ok) return planned;
    const session = sessionById(current, target.sessionId);
    const win = session.windows.find((item) => String(item.id) === String(target.windowId));
    if (target.kind === 'session-tab' && (target.groupId == null || target.groupId === '')) {
      const tabs = (win?.ungrouped || []).filter((tab) => tab.url === target.url);
      const parts = splitTabs(tabs);
      return {
        ok: true,
        store: current,
        openWindows: [{ groups: [], ungrouped: parts.open }],
        skipped: parts.skipped,
        message: skippedMessage(parts.skipped),
      };
    }
    const group = win?.groups.find((item) => String(item.id) === String(target.groupId));
    if (!group) return fail(current, 'not-found', '找不到这个分组。');
    let tabs = group.tabs;
    if (target.kind === 'session-tab') tabs = tabs.filter((tab) => tab.url === target.url);
    const parts = splitTabs(tabs);
    return {
      ok: true,
      store: current,
      openWindows: [{ groups: [{ name: group.name, color: group.color ?? null, tabs: parts.open }], ungrouped: [] }],
      skipped: parts.skipped,
      message: skippedMessage(parts.skipped),
    };
  }
  return fail(current, 'not-found', '找不到要恢复的内容。');
}

export function sortActiveGroups(groups, mode) {
  const copy = (groups || []).map((group, index) => ({ group, index }));
  if (mode === 'name') {
    copy.sort((a, b) => groupName(a.group).localeCompare(groupName(b.group), 'zh') || a.index - b.index);
  } else if (mode === 'count') {
    copy.sort((a, b) => (b.group.tabs || []).length - (a.group.tabs || []).length || a.index - b.index);
  } else {
    copy.sort((a, b) => a.index - b.index);
  }
  return copy.map((item) => item.group);
}

export function sortTabsBySite(tabs) {
  return (tabs || [])
    .map((tab, index) => ({ tab, index }))
    .sort((a, b) => hostname(a.tab.url).localeCompare(hostname(b.tab.url)) || a.index - b.index)
    .map((item) => item.tab);
}

export function planSiteSortMoves(tabs) {
  const ordered = sortTabsBySite(tabs);
  const indexes = (tabs || []).map((tab) => tab.index).filter((index) => Number.isInteger(index));
  const start = indexes.length ? Math.min(...indexes) : 0;
  return ordered.map((tab, offset) => ({ tabId: tab.tabId, index: start + offset }));
}

export function sortSavedItems(store, mode) {
  const current = normalizeStore(store);
  const sessions = [...current.sessions];
  const backups = [...current.backups];
  const byName = (a, b) => text(a.name).localeCompare(text(b.name), 'zh');
  const byRecent = (a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt));
  const byCount = (a, b) => countTabs(b) - countTabs(a);
  const cmp = mode === 'name' ? byName : mode === 'count' ? byCount : byRecent;
  sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || cmp(a, b));
  backups.sort(cmp);
  return { sessions, backups };
}

function countTabs(item) {
  if (Array.isArray(item.tabs)) return item.tabs.length;
  return (item.windows || []).reduce((sum, win) => (
    sum + (win.ungrouped || []).length + (win.groups || []).reduce((inner, group) => inner + (group.tabs || []).length, 0)
  ), 0);
}

export function rememberSort(store, view, mode) {
  const current = normalizeStore(store);
  const sort = { ...current.sort };
  if (view === 'active') sort.active = mode;
  if (view === 'saved') sort.saved = mode;
  return { ...current, sort };
}

export function countWindowTabs(windowSnapshot) {
  const groups = (windowSnapshot?.groups || []).reduce((sum, group) => sum + (group.tabs || []).length, 0);
  return groups + (windowSnapshot?.ungrouped || []).length;
}

export function planNewGroup({ name, color } = {}) {
  const title = text(name);
  if (!title) return { ok: false, code: 'name-required', message: '请输入名称' };
  return { ok: true, name: title, color: COLOR_SET.has(color) ? color : 'grey' };
}

export function planLiveGroupEdit({ name, color } = {}) {
  const title = text(name);
  if (!title) return { ok: false, code: 'name-required', message: '请输入名称' };
  const update = { title };
  if (COLOR_SET.has(color)) update.color = color;
  return { ok: true, update };
}

export function planSaveAndClose(store, windowSnapshot, selection, options = {}) {
  const saved = saveActiveRow(store, windowSnapshot, selection, options);
  if (!saved.ok) return saved;
  const row = selectedRow(windowSnapshot, selection);
  return { ...saved, closeUrls: usableTabs(row?.tabs).map((tab) => tab.url) };
}

export function planCloseTabs(tabs) {
  return { ok: true, closeUrls: usableTabs(tabs).map((tab) => tab.url) };
}

const PALETTE = GROUP_COLORS;

export function previewAutoGroups(windows) {
  return {
    windows: (windows || []).map((win) => {
      const named = (win.groups || []).filter((group) => groupName(group));
      const eligible = (win.ungrouped || []).filter((tab) => /^https?:\/\//i.test(text(tab.url)) && !restrictionReason(tab.url));
      const byHost = new Map();
      for (const tab of eligible) {
        const host = hostname(tab.url);
        if (!host) continue;
        if (!byHost.has(host)) byHost.set(host, []);
        byHost.get(host).push(tab);
      }
      const suggestions = [];
      let colorIndex = 0;
      for (const [host, tabs] of byHost) {
        if (tabs.length < 2) continue;
        suggestions.push({
          id: `${win.windowId ?? win.id}:${host}`,
          name: host,
          color: PALETTE[colorIndex % PALETTE.length],
          selected: true,
          tabs: tabs.map((tab) => ({ ...tab })),
        });
        colorIndex += 1;
      }
      return {
        windowId: win.windowId ?? win.id,
        collapsed: false,
        suggestions,
        unchanged: suggestions.length === 0,
        namedGroupIds: named.map((group) => group.id),
      };
    }),
  };
}

export function setPreviewCollapsed(preview, windowId, collapsed) {
  return {
    windows: (preview?.windows || []).map((win) => (
      String(win.windowId) === String(windowId)
        ? { ...win, collapsed: Boolean(collapsed), suggestions: win.suggestions.map((item) => ({ ...item, tabs: item.tabs.map((tab) => ({ ...tab })) })) }
        : win
    )),
  };
}

export function editSuggestion(preview, windowId, suggestionId, patch = {}) {
  return {
    windows: (preview?.windows || []).map((win) => {
      if (String(win.windowId) !== String(windowId)) return win;
      return {
        ...win,
        suggestions: win.suggestions.map((item) => {
          if (item.id !== suggestionId) return item;
          const next = { ...item, tabs: item.tabs.map((tab) => ({ ...tab })) };
          if (patch.name != null) next.name = text(patch.name) || item.name;
          if (patch.color != null && COLOR_SET.has(patch.color)) next.color = patch.color;
          if (patch.selected != null) next.selected = Boolean(patch.selected);
          return next;
        }),
      };
    }),
  };
}

export function applyAutoGroupPreview(preview) {
  const moves = [];
  for (const win of preview?.windows || []) {
    for (const suggestion of win.suggestions || []) {
      if (!suggestion.selected || suggestion.tabs.length < 2) continue;
      moves.push({
        windowId: win.windowId,
        name: suggestion.name,
        color: suggestion.color,
        tabs: suggestion.tabs.map((tab) => ({ ...tab })),
      });
    }
  }
  return {
    moves,
    undo: moves.map((move) => ({
      windowId: move.windowId,
      urls: move.tabs.map((tab) => tab.url),
      tabIds: move.tabs.map((tab) => tab.tabId).filter((id) => id != null),
    })),
  };
}

function markdownLinks(value) {
  const links = [];
  const pattern = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let match = pattern.exec(value);
  while (match) {
    links.push({ title: match[1], url: match[2] });
    match = pattern.exec(value);
  }
  return links;
}

function csvLinks(value) {
  const links = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^title\s*,/i.test(trimmed)) continue;
    const comma = trimmed.lastIndexOf(',');
    if (comma < 0) continue;
    const url = trimmed.slice(comma + 1).trim();
    const title = trimmed.slice(0, comma).trim().replace(/^"|"$/g, '');
    if (/^https?:\/\//i.test(url)) links.push({ title, url });
  }
  return links;
}

function libraryPayload(store) {
  const current = normalizeStore(store);
  return {
    kind: 'tabgroup-vault-library',
    backups: current.backups,
    sessions: current.sessions,
  };
}

export function exportLibrary(store, format) {
  const payload = libraryPayload(store);
  if (format === 'json') return JSON.stringify(payload);
  const links = [
    ...payload.backups.flatMap((backup) => backup.tabs.map((tab) => ({ title: tab.title || backup.name, url: tab.url }))),
    ...payload.sessions.flatMap((session) => session.windows.flatMap((win) => [
      ...win.groups.flatMap((group) => group.tabs.map((tab) => ({ title: tab.title || group.name, url: tab.url }))),
      ...win.ungrouped.map((tab) => ({ title: tab.title || session.name, url: tab.url })),
    ])),
  ];
  if (format === 'csv') {
    return ['title,url', ...links.map((link) => `${link.title},${link.url}`)].join('\n');
  }
  return links.map((link) => `- [${link.title}](${link.url})`).join('\n');
}

export function exportBackup(backup, format) {
  return exportLibrary({ backups: [backup], sessions: [] }, format);
}

export function exportSession(session, format) {
  return exportLibrary({ backups: [], sessions: [session] }, format);
}

export function previewImport(raw, format) {
  if (format === 'json') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.kind !== 'tabgroup-vault-library') {
        return { ok: false, restorable: false, message: '这个 JSON 不能按原结构恢复。' };
      }
      return {
        ok: true,
        restorable: true,
        backups: Array.isArray(parsed.backups) ? parsed.backups.map(cloneBackup) : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(cloneSession) : [],
        links: [],
        message: '可以按原结构恢复。请先查看下面的结果。',
      };
    } catch {
      return { ok: false, restorable: false, message: '这个 JSON 不能按原结构恢复。' };
    }
  }
  const links = format === 'csv' ? csvLinks(raw) : markdownLinks(raw);
  return {
    ok: true,
    restorable: false,
    backups: [],
    sessions: [],
    links,
    message: '这是链接清单，不能按分组和会话原结构恢复。',
  };
}

export function applyImport(store, preview, options = {}) {
  const current = normalizeStore(store);
  if (!preview?.ok) return fail(current, 'import', preview?.message || '无法导入');
  const now = options.now || new Date().toISOString();
  if (preview.restorable) {
    const backups = [...current.backups];
    const sessions = [...current.sessions];
    for (const backup of preview.backups || []) {
      backups.push({ ...cloneBackup(backup), id: nextId(options, 'gb', backups.length), createdAt: now, updatedAt: now });
    }
    for (const session of preview.sessions || []) {
      sessions.push({ ...cloneSession(session), id: nextId(options, 'ss', sessions.length), createdAt: now, updatedAt: now });
    }
    return {
      ok: true,
      store: { ...current, backups, sessions },
      message: '已导入',
    };
  }
  const list = {
    id: nextId(options, 'll', current.linkLists.length),
    name: '链接清单',
    links: (preview.links || []).map((link) => ({ title: String(link.title ?? ''), url: link.url })),
    createdAt: now,
  };
  return {
    ok: true,
    store: { ...current, linkLists: [...current.linkLists, list] },
    message: '已导入链接清单',
  };
}

export function updateSettings(store, patch = {}) {
  const current = normalizeStore(store);
  const settings = { ...current.settings };
  if (patch.language != null) settings.language = patch.language === 'en' ? 'en' : 'zh-CN';
  if (patch.theme != null && THEMES.has(patch.theme)) settings.theme = patch.theme;
  if (patch.autoSaveOnWindowClose != null) settings.autoSaveOnWindowClose = Boolean(patch.autoSaveOnWindowClose);
  if (patch.analytics != null) settings.analytics = Boolean(patch.analytics);
  if (patch.tourSeen != null) settings.tourSeen = Boolean(patch.tourSeen);
  if (patch.tourStep != null) settings.tourStep = Number(patch.tourStep) || 0;
  return { ...current, settings };
}

export function clearSaved(store) {
  const current = normalizeStore(store);
  return { ...current, backups: [], sessions: [], linkLists: [], undo: null, groupLinks: {} };
}

export function autoSaveClosedWindow(store, snapshot, options = {}) {
  const current = normalizeStore(store);
  if (!options.enabled) {
    return { ok: true, store: current, saved: [], updated: [], failed: [], skipped: true };
  }
  return { ...saveAllGroups(current, [snapshot], { ...options, mode: 'update', linkGroups: false }), skipped: false };
}

export function connectDrive(store, config = {}) {
  const current = normalizeStore(store);
  const accountLabel = text(config.accountLabel);
  const accessToken = text(config.accessToken);
  if (!accountLabel || !accessToken) return fail(current, 'drive-config', '请填写连接配置');
  return {
    ok: true,
    store: {
      ...current,
      drive: { ...current.drive, connected: true, accountLabel },
    },
    message: '已连接',
  };
}

export function reconnectDrive(store, config = {}) {
  const history = normalizeStore(store).drive.history;
  const connected = connectDrive(store, config);
  if (!connected.ok) return connected;
  connected.store.drive.history = history;
  connected.message = '已重新连接';
  return connected;
}

export function disconnectDrive(store) {
  const current = normalizeStore(store);
  return {
    ok: true,
    store: { ...current, drive: { ...current.drive, connected: false } },
    message: '已断开',
  };
}

export function listDriveHistory(store) {
  return normalizeStore(store).drive.history;
}

export async function syncDrive(store, options = {}) {
  const current = normalizeStore(store);
  if (!current.drive.connected) return fail(current, 'drive-offline', '请先连接');
  const accessToken = text(options.accessToken);
  if (!accessToken || !options.fetchImpl) return fail(current, 'drive-config', '请填写连接配置');
  const body = exportLibrary(current, 'json');
  let response;
  try {
    response = await options.fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=media', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  } catch {
    return fail(current, 'drive-failed', '同步没有完成');
  }
  if (!response?.ok) return fail(current, 'drive-failed', '同步没有完成');
  const now = options.now || new Date().toISOString();
  const entry = { id: nextId(options, 'dh', current.drive.history.length), at: now, name: '库备份' };
  return {
    ok: true,
    store: {
      ...current,
      drive: { ...current.drive, lastSyncAt: now, history: [...current.drive.history, entry] },
    },
    message: '已同步',
  };
}
