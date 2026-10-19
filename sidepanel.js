import {
  GROUP_COLORS,
  addBackupToSession,
  applyAutoGroupPreview,
  applyImport,
  clearSaved,
  connectDrive,
  countWindowTabs,
  deleteBackup,
  deleteSession,
  disconnectDrive,
  editGroupBackup,
  editSessionGroup,
  editSuggestion,
  sessionGroupFormTabs,
  exportBackup,
  exportLibrary,
  exportSession,
  findOpenTab,
  listDriveHistory,
  moveSessionGroup,
  normalizeStore,
  pinSession,
  planLiveGroupEdit,
  planNewGroup,
  planSaveAndClose,
  planSelectiveRestore,
  planSiteSortMoves,
  planSessionRestore,
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
} from './src/backup-logic.js';

const STORAGE_KEY = 'groupBackups';
const TOKEN_KEY = 'driveAccessToken';
const ACCOUNT_KEY = 'driveAccountLabel';
const COLOR_SET = new Set(GROUP_COLORS);

const state = {
  view: 'active',
  store: normalizeStore(null),
  windows: [],
  currentWindowId: null,
  openWindows: new Set(),
  openRows: new Set(),
  openBackups: new Set(),
  openSessions: new Set(),
  naming: null,
  message: '',
  searchQuery: '',
  searchScope: 'all',
  openMenu: '',
  dialog: null,
  autoPreview: null,
  autoUndo: null,
  driveToken: '',
};

const panel = document.querySelector('#panel');
const activeView = document.querySelector('#active-view');
const savedView = document.querySelector('#saved-view');
const settingsView = document.querySelector('#settings-view');
const sessionList = document.querySelector('#session-list');
const backupList = document.querySelector('#backup-list');
const backupQuota = document.querySelector('#backup-quota');
const banner = document.querySelector('#banner');
const slotCount = document.querySelector('#slot-count');
const activeButton = document.querySelector('#view-active');
const savedButton = document.querySelector('#view-saved');
const toolbar = document.querySelector('#toolbar');
const dock = document.querySelector('#dock');
const searchResults = document.querySelector('#search-results');
const overlay = document.querySelector('#overlay');
const settingsButton = document.querySelector('#open-settings');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function chromeApi() {
  return globalThis.chrome;
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readStore() {
  const storage = chromeApi()?.storage?.local;
  if (!storage) return;
  const data = await storage.get([STORAGE_KEY, TOKEN_KEY, ACCOUNT_KEY]);
  state.store = normalizeStore(data?.[STORAGE_KEY]);
  state.driveToken = textOf(data?.[TOKEN_KEY]);
  if (!state.store.drive.accountLabel && data?.[ACCOUNT_KEY]) {
    state.store = { ...state.store, drive: { ...state.store.drive, accountLabel: textOf(data[ACCOUNT_KEY]) } };
  }
}

function textOf(value) {
  return String(value ?? '').trim();
}

async function writeStore(store) {
  state.store = normalizeStore(store);
  const storage = chromeApi()?.storage?.local;
  if (storage) await storage.set({ [STORAGE_KEY]: state.store });
}

async function writeDriveConfig(accountLabel, accessToken) {
  state.driveToken = accessToken;
  const storage = chromeApi()?.storage?.local;
  if (storage) await storage.set({ [ACCOUNT_KEY]: accountLabel, [TOKEN_KEY]: accessToken });
}

function tabAddress(tab) {
  return {
    tabId: tab.id,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    pinned: Boolean(tab.pinned),
    index: tab.index,
  };
}

async function loadWindows() {
  const api = chromeApi();
  if (!api?.windows?.getAll || !api?.tabs?.query) {
    state.windows = [];
    return;
  }
  const [windows, tabs, current] = await Promise.all([
    api.windows.getAll({ windowTypes: ['normal'] }),
    api.tabs.query({}),
    api.windows.getCurrent(),
  ]);
  const groups = api.tabGroups?.query ? await api.tabGroups.query({}) : [];
  const groupMeta = new Map(groups.map((group) => [group.id, group]));
  state.currentWindowId = current?.id ?? null;
  state.windows = windows.map((win) => {
    const winTabs = tabs.filter((tab) => tab.windowId === win.id).sort((a, b) => a.index - b.index);
    const grouped = new Map();
    const ungrouped = [];
    for (const tab of winTabs) {
      const item = tabAddress(tab);
      if (tab.groupId == null || tab.groupId === -1) ungrouped.push(item);
      else {
        if (!grouped.has(tab.groupId)) grouped.set(tab.groupId, []);
        grouped.get(tab.groupId).push(item);
      }
    }
    return {
      id: win.id,
      groups: [...grouped.entries()].map(([id, groupTabs]) => {
        const meta = groupMeta.get(id) || {};
        return { id, title: meta.title || '', color: meta.color || '', tabs: groupTabs };
      }),
      ungrouped,
    };
  });
  if (state.openWindows.size === 0) {
    for (const win of state.windows) state.openWindows.add(win.id);
  }
}

function snapshotOf(win) {
  return {
    windowId: win.id,
    groups: win.groups.map((group) => ({
      id: group.id,
      title: group.title,
      color: group.color,
      tabs: group.tabs.map((tab) => ({ url: tab.url, title: tab.title, pinned: tab.pinned, tabId: tab.tabId })),
    })),
    ungrouped: win.ungrouped.map((tab) => ({ url: tab.url, title: tab.title, pinned: tab.pinned, tabId: tab.tabId })),
  };
}

function snapshots() {
  return windowOrder().list.map(snapshotOf);
}

function windowOrder() {
  const current = state.windows.find((win) => win.id === state.currentWindowId);
  const others = state.windows.filter((win) => win.id !== state.currentWindowId).sort((a, b) => Number(a.id) - Number(b.id));
  const labels = new Map();
  if (current) labels.set(current.id, '当前窗口');
  others.forEach((win, index) => labels.set(win.id, `窗口 ${index + 2}`));
  return { list: current ? [current, ...others] : others, labels };
}

function tabCount(tabs) {
  return `${tabs.length} 个标签`;
}

function chevron(open) {
  const d = open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6';
  return `<svg class="chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

function barClass(color) {
  return COLOR_SET.has(color) ? `bar color-${color}` : 'bar';
}

function searchIcon() {
  return '<svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5" stroke-linecap="round"/></svg>';
}

const COLOR_LABELS = {
  grey: '灰色', blue: '蓝色', red: '红色', yellow: '黄色', green: '绿色',
  pink: '粉色', purple: '紫色', cyan: '青色', orange: '橙色',
};
const THEME_LABELS = { light: '浅色', dark: '深色', midnight: '午夜', contrast: '高对比' };

function colorOptions(selected) {
  return GROUP_COLORS.map((color) => `<option value="${color}" ${color === selected ? 'selected' : ''}>${COLOR_LABELS[color]}</option>`).join('');
}

function renderBanner() {
  const count = state.store.backups.length + state.store.sessions.length;
  slotCount.textContent = String(count);
  banner.hidden = !state.message;
  banner.textContent = state.message;
  activeButton.classList.toggle('is-selected', state.view === 'active');
  savedButton.classList.toggle('is-selected', state.view === 'saved');
  settingsButton.classList.toggle('is-selected', state.view === 'settings');
  document.body.dataset.theme = state.store.settings.theme || 'light';
  document.documentElement.lang = state.store.settings.language === 'en' ? 'en' : 'zh-CN';
}

function renderToolbar() {
  if (state.view === 'settings') {
    toolbar.hidden = true;
    return;
  }
  toolbar.hidden = false;
  const signature = `${state.view}:${state.store.settings.language}`;
  if (toolbar.dataset.signature === signature) return;
  toolbar.dataset.signature = signature;
  const savedSort = state.view === 'saved';
  const options = savedSort
    ? [['recent', '最近'], ['name', '名称'], ['count', '标签数']]
    : [['browser', '浏览器顺序'], ['name', '名称'], ['count', '标签数']];
  const current = savedSort ? state.store.sort.saved : state.store.sort.active;
  const savedTools = state.view === 'saved'
    ? '<span class="spacer"></span><button type="button" class="quiet" data-action="pick-import">导入</button><button type="button" class="quiet" data-action="export-library">导出</button>'
    : '';
  toolbar.innerHTML = `
    <div class="search">
      ${searchIcon()}
      <input id="search-input" aria-label="搜索" placeholder="搜索标签、分组或备份" value="${esc(state.searchQuery)}">
      <button type="button" id="clear-search" class="clear" data-action="clear-search" aria-label="清除"${state.searchQuery ? '' : ' hidden'}>×</button>
      <select id="search-scope" aria-label="搜索范围">
        <option value="all">全部</option>
        <option value="open">打开中</option>
        <option value="saved">已保存</option>
      </select>
    </div>
    <div class="meta">
      <select id="sort-mode" class="quiet-select" aria-label="排序">
        ${options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
      </select>
      ${savedTools}
    </div>
  `;
  const scope = toolbar.querySelector('#search-scope');
  const sort = toolbar.querySelector('#sort-mode');
  if (scope) scope.value = state.searchScope;
  if (sort) sort.value = current;
}

function renderDock() {
  if (state.view !== 'active') {
    dock.hidden = true;
    return;
  }
  dock.hidden = false;
  const undo = state.store.undo ? '<button type="button" data-action="undo">撤销更新</button>' : '';
  dock.innerHTML = `
    <details class="foot-menu">
      <summary>整理</summary>
      <div class="pop">
        <button type="button" data-action="auto-group">自动分组</button>
        <button type="button" data-action="new-group">新建分组</button>
      </div>
    </details>
    <details class="foot-menu primary">
      <summary>批量保存</summary>
      <div class="pop">
        <button type="button" data-action="save-session">保存会话</button>
        <button type="button" data-action="save-all" data-mode="update">更新现有备份</button>
        <button type="button" data-action="save-all" data-mode="new">另存新备份</button>
        ${undo}
      </div>
    </details>
  `;
}

function renderSearchResults() {
  const query = state.searchQuery.trim();
  if (!query || state.view === 'settings') {
    searchResults.innerHTML = '';
    return;
  }
  const found = searchLibrary(state.store, snapshots(), query, {
    scope: state.searchScope,
    collapsedSessionIds: [...state.store.sessions.map((session) => session.id)],
  });
  const rows = found.results.map((item) => {
    const focus = item.tabId != null
      ? `<button type="button" data-action="focus-tab" data-tab="${esc(item.tabId)}" data-window="${esc(item.windowId)}">切换到该标签</button>`
      : '';
    const restore = item.kind === 'open-tab' || item.kind === 'open-group'
      ? ''
      : `<button type="button" data-action="ask-restore" data-target="${esc(encodeURIComponent(JSON.stringify(item)))}">恢复</button>`;
    return `<div class="result"><span><span class="name">${esc(item.label)}</span><span class="path">${esc(item.path)}</span></span><span>${focus}${restore}</span></div>`;
  }).join('');
  searchResults.innerHTML = `<div class="search-results">${rows || '<p class="empty">没有匹配的结果。</p>'}</div>`;
}

function renderActive() {
  const { list, labels } = windowOrder();
  if (list.length === 0) {
    activeView.innerHTML = '<p class="empty">没有打开的窗口。</p>';
    return;
  }
  activeView.innerHTML = list.map((win) => {
    const open = state.openWindows.has(win.id);
    const groups = sortActiveGroups(win.groups, state.store.sort.active);
    const rows = groups.map((group) => rowMarkup(win, {
      kind: 'group',
      groupId: group.id,
      title: group.title.trim() || '未命名组',
      color: group.color,
      tabs: group.tabs,
      needsName: group.title.trim().length === 0,
    }));
    if (win.ungrouped.length > 0) {
      rows.push(rowMarkup(win, {
        kind: 'ungrouped',
        groupId: '',
        title: '未分组标签',
        color: '',
        tabs: win.ungrouped,
        needsName: true,
      }));
    }
    return `<section class="window">
      <div class="window-head">
        <button type="button" class="win-name" data-window-toggle="${esc(win.id)}">
          ${chevron(open)}
          <span class="name">${esc(labels.get(win.id))}</span>
        </button>
        <span class="count">${esc(countWindowTabs(win))}</span>
        <button type="button" class="link" data-action="save-window" data-window="${esc(win.id)}">保存窗口</button>
      </div>
      ${open ? rows.join('') : ''}
    </section>`;
  }).join('');
}

function rowMarkup(win, row) {
  const key = `${win.id}:${row.kind}:${row.groupId}`;
  const open = state.openRows.has(key);
  const naming = state.naming
    && state.naming.windowId === win.id
    && state.naming.kind === row.kind
    && String(state.naming.groupId) === String(row.groupId);
  const groupActions = row.kind === 'group' ? `
    <button type="button" data-action="edit-live" data-window="${esc(win.id)}" data-group="${esc(row.groupId)}">编辑分组</button>
    <button type="button" data-action="sort-tabs" data-window="${esc(win.id)}" data-group="${esc(row.groupId)}">排序标签</button>
  ` : '';
  const menu = state.openMenu === key ? `<div class="menu">
    ${groupActions}
    <button type="button" data-action="export-row" data-window="${esc(win.id)}" data-kind="${esc(row.kind)}" data-group="${esc(row.groupId)}">导出</button>
    <button type="button" data-action="save-close" data-window="${esc(win.id)}" data-kind="${esc(row.kind)}" data-group="${esc(row.groupId)}">保存并关闭</button>
    <button type="button" data-action="close-tabs" data-window="${esc(win.id)}" data-kind="${esc(row.kind)}" data-group="${esc(row.groupId)}">关闭标签</button>
  </div>` : '';
  return `<article class="card">
    <div class="row">
      <button type="button" class="chevron" data-row-toggle="${esc(key)}">${chevron(open)}</button>
      <span class="${barClass(row.color)}"></span>
      <span class="row-copy">
        <span class="name">${esc(row.title)}</span>
        <span class="sub">${esc(tabCount(row.tabs))}</span>
      </span>
      <button type="button" class="more" aria-label="更多" data-action="toggle-menu" data-menu="${esc(key)}">···</button>
      <button type="button" class="save" aria-label="保存" data-save-window="${esc(win.id)}" data-save-kind="${esc(row.kind)}" data-save-group="${esc(row.groupId)}" data-needs-name="${row.needsName ? 'yes' : 'no'}">保存</button>
    </div>
    ${menu}
    ${open ? `<div class="tabs">${row.tabs.map((tab) => `<div class="tab"><span class="name">${esc(tab.title || tab.url)}</span></div>`).join('')}</div>` : ''}
    ${naming ? `<form class="name-form" data-name-form="yes">
      <input name="backupName" aria-label="备份名称" placeholder="填写备份名称" required>
      <button type="submit">确定</button>
    </form>` : ''}
  </article>`;
}

function renderSaved() {
  const ordered = sortSavedItems(state.store, state.store.sort.saved);
  sessionList.innerHTML = `<h2 class="section">会话</h2>${ordered.sessions.map((session) => {
    const open = state.openSessions.has(session.id);
    const menu = state.openMenu === `session:${session.id}` ? `<div class="menu">
      <button type="button" data-action="edit-session" data-id="${esc(session.id)}">编辑会话</button>
      <button type="button" data-action="restore-session" data-id="${esc(session.id)}">恢复</button>
      <button type="button" data-action="export-one-session" data-id="${esc(session.id)}">导出</button>
      <button type="button" data-action="pin-session" data-id="${esc(session.id)}">置顶会话</button>
      <button type="button" data-action="delete-session" data-id="${esc(session.id)}">删除</button>
    </div>` : '';
    const windows = open ? `<div class="tabs">${session.windows.map((win) => `<div class="tab">
      <span class="name">${esc(win.name || '窗口')}</span>
      <button type="button" data-action="restore-session-window" data-id="${esc(session.id)}" data-window="${esc(win.id)}">恢复此窗口</button>
    </div>`).join('')}</div>` : '';
    const pinned = session.pinned ? '<span class="sub">已置顶</span>' : '';
    return `<article class="backup">
      <div class="row">
        <button type="button" class="chevron" data-session-toggle="${esc(session.id)}">${chevron(open)}</button>
        <span class="row-copy"><span class="name">${esc(session.name)}</span>${pinned}</span>
        <button type="button" class="more" aria-label="更多" data-action="toggle-menu" data-menu="session:${esc(session.id)}">···</button>
      </div>
      ${menu}${windows}
    </article>`;
  }).join('') || '<p class="empty">还没有会话。</p>'}`;

  backupQuota.textContent = String(ordered.backups.length);
  const cards = ordered.backups.map((backup) => {
    const open = state.openBackups.has(backup.id);
    const menu = state.openMenu === `backup:${backup.id}` ? `<div class="menu">
      <button type="button" data-action="edit-backup" data-id="${esc(backup.id)}">编辑</button>
      <button type="button" data-action="export-one-backup" data-id="${esc(backup.id)}">导出</button>
      <button type="button" data-action="delete-backup" data-id="${esc(backup.id)}">删除</button>
    </div>` : '';
    return `<article class="backup">
      <div class="row">
        <button type="button" class="chevron" data-backup-toggle="${esc(backup.id)}">${chevron(open)}</button>
        <span class="${barClass(backup.color)}"></span>
        <span class="row-copy">
          <span class="name">${esc(backup.name)}</span>
          <span class="sub">${esc(tabCount(backup.tabs))}</span>
        </span>
        <button type="button" class="more" aria-label="更多" data-action="toggle-menu" data-menu="backup:${esc(backup.id)}">···</button>
        <button type="button" class="restore" aria-label="恢复" data-restore="${esc(backup.id)}">恢复</button>
      </div>
      ${menu}
      ${open ? `<div class="tabs">${backup.tabs.map((tab) => `<div class="tab"><span class="name">${esc(tab.title)}</span><span class="url">${esc(tab.url)}</span></div>`).join('')}</div>` : ''}
    </article>`;
  }).join('');
  backupList.innerHTML = cards || '<p class="empty">还没有组备份。</p>';
}

function renderSettings() {
  const settings = state.store.settings;
  const drive = state.store.drive;
  settingsView.innerHTML = `<div class="settings">
    <h2>外观</h2>
    <label>语言 <select id="language" aria-label="语言">
      <option value="zh-CN" ${settings.language === 'zh-CN' ? 'selected' : ''}>中文</option>
      <option value="en" ${settings.language === 'en' ? 'selected' : ''}>English</option>
    </select></label>
    <label>主题 <select id="theme" aria-label="主题">
      ${['light', 'dark', 'midnight', 'contrast'].map((theme) => `<option value="${theme}" ${settings.theme === theme ? 'selected' : ''}>${THEME_LABELS[theme]}</option>`).join('')}
    </select></label>
    <h2>行为</h2>
    <label><input id="auto-save" type="checkbox" ${settings.autoSaveOnWindowClose ? 'checked' : ''}> 关闭窗口时自动保存分组</label>
    <label><input id="analytics" type="checkbox" ${settings.analytics ? 'checked' : ''}> 统计偏好</label>
    <div class="actions">
      <button type="button" data-action="shortcuts">快捷键</button>
      <button type="button" data-action="cleanup">清理已保存内容</button>
      <button type="button" data-action="tour">导览</button>
    </div>
    <p>导出 JSON 可以在另一台电脑按原结构恢复。Markdown 和 CSV 只是链接清单。</p>
    <h2>Google Drive</h2>
    <input id="drive-account" aria-label="连接账号" placeholder="账号" value="${esc(drive.accountLabel)}">
    <input id="drive-token" aria-label="连接配置" type="password" placeholder="连接配置" autocomplete="off">
    <div class="actions">
      <button type="button" data-action="connect-drive">连接</button>
      <button type="button" data-action="sync-drive">立即同步</button>
      <button type="button" data-action="reconnect-drive">重新连接</button>
      <button type="button" data-action="disconnect-drive">断开</button>
      <button type="button" data-action="show-history">备份历史</button>
    </div>
    <p>${drive.connected ? '已连接' : '未连接'} ${esc(drive.accountLabel)}</p>
  </div>`;
}

function renderOverlay() {
  const dialog = state.dialog;
  const preview = state.autoPreview;
  let html = '';
  if (preview) {
    html += `<div class="dialog" data-auto="yes">
      <strong>自动分组</strong>
      ${preview.windows.map((win) => `<section>
        <button type="button" data-action="collapse-preview" data-window="${esc(win.windowId)}">${win.collapsed ? '展开' : '收起'}</button>
        ${win.unchanged ? '<p>暂时没有足够可靠的分组建议</p>' : ''}
        ${win.collapsed ? '' : win.suggestions.map((item) => `<label class="suggestion">
          <input type="checkbox" data-action="toggle-suggestion" data-window="${esc(win.windowId)}" data-suggestion="${esc(item.id)}" ${item.selected ? 'checked' : ''}>
          <input data-suggestion-name="${esc(item.id)}" data-window="${esc(win.windowId)}" value="${esc(item.name)}" aria-label="分组名称">
          <select data-suggestion-color="${esc(item.id)}" data-window="${esc(win.windowId)}">${colorOptions(item.color)}</select>
        </label>`).join('')}
      </section>`).join('')}
      <button type="button" data-action="apply-auto">应用</button>
      ${state.autoUndo ? '<button type="button" data-action="undo-auto">撤销</button>' : ''}
      <button type="button" data-action="close-auto">关闭</button>
    </div>`;
  }
  if (dialog?.type === 'name') {
    html += `<form class="dialog" data-dialog-form="name">
      <input name="title" aria-label="名称" placeholder="填写名称" required>
      <button type="submit">确定</button>
    </form>`;
  }
  if (dialog?.type === 'new-group' || dialog?.type === 'live-edit') {
    html += `<form class="dialog" data-dialog-form="${dialog.type}">
      <input name="title" aria-label="分组名称" placeholder="分组名称" value="${esc(dialog.name || '')}" required>
      <select name="color" aria-label="颜色">${colorOptions(dialog.color || 'grey')}</select>
      <button type="submit">确定</button>
    </form>`;
  }
  if (dialog?.type === 'export') {
    html += `<div class="dialog">
      <button type="button" data-action="download" data-format="json">JSON</button>
      <button type="button" data-action="download" data-format="markdown">Markdown</button>
      <button type="button" data-action="download" data-format="csv">CSV</button>
    </div>`;
  }
  if (dialog?.type === 'import') {
    html += `<div class="dialog">
      <p>${esc(dialog.preview.message)}</p>
      <p>${dialog.preview.restorable ? `分组 ${dialog.preview.backups.length}，会话 ${dialog.preview.sessions.length}` : `链接 ${dialog.preview.links.length}`}</p>
      <button type="button" data-action="apply-import">确认导入</button>
    </div>`;
  }
  if (dialog?.type === 'confirm') {
    html += `<div class="dialog"><p>${esc(dialog.message)}</p>
      <button type="button" data-action="confirm-yes">确定恢复</button>
      <button type="button" data-action="close-dialog">取消</button>
    </div>`;
  }
  if (dialog?.type === 'backup-edit') {
    const backup = state.store.backups.find((item) => item.id === dialog.id);
    if (backup) {
      html += `<form class="dialog" data-dialog-form="backup-edit">
        <input name="title" value="${esc(backup.name)}" aria-label="备份名称" required>
        <select name="color">${colorOptions(backup.color || 'grey')}</select>
        ${(backup.tabs || []).map((tab, index) => `<input name="tab-${index}" value="${esc(tab.url)}" aria-label="网址">`).join('')}
        <input name="extra" placeholder="添加网址" aria-label="添加网址">
        <button type="submit">确定</button>
      </form>`;
    }
  }
  if (dialog?.type === 'session-edit') {
    const session = state.store.sessions.find((item) => item.id === dialog.id);
    if (session) {
      html += `<div class="dialog">
        <form data-dialog-form="rename-session"><input name="title" value="${esc(session.name)}" aria-label="会话名称"><button type="submit">重命名会话</button></form>
        ${session.windows.map((win, index) => `<div>
          <span>${esc(win.name || '窗口')}</span>
          <button type="button" data-action="window-up" data-id="${esc(session.id)}" data-index="${index}">上移窗口</button>
          <button type="button" data-action="window-down" data-id="${esc(session.id)}" data-index="${index}">下移窗口</button>
          ${win.groups.map((group, groupIndex) => `<div>
            <span>${esc(group.name)}</span>
            <button type="button" data-action="group-up" data-id="${esc(session.id)}" data-window="${esc(win.id)}" data-index="${groupIndex}">上移分组</button>
            <button type="button" data-action="group-down" data-id="${esc(session.id)}" data-window="${esc(win.id)}" data-index="${groupIndex}">下移分组</button>
            <select data-action="move-group" data-id="${esc(session.id)}" data-group="${esc(group.id)}">
              ${session.windows.map((target) => `<option value="${esc(target.id)}">移到 ${esc(target.name || target.id)}</option>`).join('')}
            </select>
            <form data-dialog-form="session-group" data-id="${esc(session.id)}" data-group="${esc(group.id)}">
              <input name="title" value="${esc(group.name)}" aria-label="分组名称" required>
              ${(group.tabs || []).map((tab, tabIndex) => `<div>
                <input name="tab-title-${tabIndex}" value="${esc(tab.title)}" aria-label="标签标题">
                <input name="tab-url-${tabIndex}" value="${esc(tab.url)}" aria-label="网址">
                <button type="button" data-action="session-tab-up" data-id="${esc(session.id)}" data-group="${esc(group.id)}" data-index="${tabIndex}">上移标签</button>
                <button type="button" data-action="session-tab-down" data-id="${esc(session.id)}" data-group="${esc(group.id)}" data-index="${tabIndex}">下移标签</button>
                <button type="button" data-action="session-tab-delete" data-id="${esc(session.id)}" data-group="${esc(group.id)}" data-index="${tabIndex}">删除标签</button>
              </div>`).join('')}
              <input name="extra-title" placeholder="标签标题" aria-label="新标签标题">
              <input name="extra-url" placeholder="添加网址" aria-label="添加网址">
              <button type="submit">保存这一组</button>
            </form>
          </div>`).join('')}
        </div>`).join('')}
        <select id="add-backup">${state.store.backups.map((backup) => `<option value="${esc(backup.id)}">${esc(backup.name)}</option>`).join('')}</select>
        <button type="button" data-action="add-backup" data-id="${esc(session.id)}">加入已有分组备份</button>
      </div>`;
    }
  }
  if (dialog?.type === 'history') {
    const history = listDriveHistory(state.store);
    html += `<div class="history">${history.map((item) => `<p>${esc(item.at)} ${esc(item.name)}</p>`).join('') || '<p>还没有备份历史。</p>'}</div>`;
  }
  if (state.tour) {
    const steps = [
      '在当前里展开窗口，然后保存一行。',
      '在已保存里恢复。备份还会留在列表中。',
      '可以搜索，或只恢复选中的一项。',
    ];
    html += `<div class="tour"><p>${esc(steps[state.store.settings.tourStep] || steps[0])}</p>
      <button type="button" data-action="tour-next">下一步</button></div>`;
  }
  overlay.innerHTML = html;
}

function render() {
  renderBanner();
  renderToolbar();
  renderDock();
  renderSearchResults();
  activeView.hidden = state.view !== 'active';
  savedView.hidden = state.view !== 'saved';
  settingsView.hidden = state.view !== 'settings';
  if (state.view === 'saved') renderSaved();
  else if (state.view === 'settings') renderSettings();
  else renderActive();
  renderOverlay();
}

function findWindow(id) {
  return state.windows.find((win) => String(win.id) === String(id));
}

function selectionFrom(button) {
  return button.dataset.kind === 'ungrouped' || button.dataset.saveKind === 'ungrouped'
    ? { kind: 'ungrouped' }
    : { kind: 'group', groupId: button.dataset.group || button.dataset.saveGroup };
}

async function commitSave(win, selection, enteredName, mode = 'new') {
  const result = saveActiveRow(state.store, snapshotOf(win), selection, {
    mode,
    enteredName,
    createId: () => createId('gb'),
  });
  if (!result.ok) {
    state.message = result.message || '无法保存';
    render();
    return result;
  }
  await writeStore(result.store);
  state.naming = null;
  state.message = result.message;
  state.view = 'saved';
  state.openBackups.add(result.backup.id);
  render();
  return result;
}

async function onSaveClick(button) {
  const win = findWindow(button.dataset.saveWindow);
  if (!win) return;
  const kind = button.dataset.saveKind;
  const selection = kind === 'ungrouped'
    ? { kind: 'ungrouped' }
    : { kind: 'group', groupId: button.dataset.saveGroup };
  if (button.dataset.needsName === 'yes') {
    state.naming = { windowId: win.id, kind, groupId: button.dataset.saveGroup };
    state.message = '';
    render();
    panel.querySelector('input[name="backupName"]')?.focus();
    return;
  }
  await commitSave(win, selection);
}

async function onConfirm(form) {
  const button = form.closest('.card')?.querySelector('[data-save-window]');
  const name = new FormData(form).get('backupName');
  if (!button || textOf(name) === '') return;
  const win = findWindow(button.dataset.saveWindow);
  if (!win) return;
  const closeAfter = Boolean(state.naming?.closeAfter);
  const selection = button.dataset.saveKind === 'ungrouped'
    ? { kind: 'ungrouped' }
    : { kind: 'group', groupId: button.dataset.saveGroup };
  const tabs = rowTabs(win, selection);
  const saved = await commitSave(win, selection, String(name));
  if (closeAfter && saved?.ok) {
    await closeLiveTabs(tabs);
    await loadWindows();
    render();
  }
}

async function openPlanned(openWindows) {
  const api = chromeApi();
  if (!api?.windows?.create) return;
  for (const planned of openWindows || []) {
    const ordered = [];
    for (const group of planned.groups || []) {
      for (const tab of group.tabs || []) ordered.push({ tab, group });
    }
    for (const tab of planned.ungrouped || []) ordered.push({ tab, group: null });
    if (!ordered.length) continue;
    const created = await api.windows.create({ url: ordered[0].tab.url, focused: false });
    const made = [{ id: created.tabs?.[0]?.id, group: ordered[0].group, pinned: ordered[0].tab.pinned }];
    for (const item of ordered.slice(1)) {
      const tab = await api.tabs.create({ windowId: created.id, url: item.tab.url, active: false });
      made.push({ id: tab?.id, group: item.group, pinned: item.tab.pinned });
    }
    for (const item of made) {
      if (item.pinned && item.id != null) await api.tabs.update(item.id, { pinned: true });
    }
    const groups = new Map();
    for (const item of made) {
      if (!item.group || item.id == null) continue;
      const key = item.group.id != null ? `id:${item.group.id}` : `${item.group.name}:${item.group.color || ''}`;
      if (!groups.has(key)) groups.set(key, { ...item.group, ids: [] });
      groups.get(key).ids.push(item.id);
    }
    for (const group of groups.values()) {
      if (!api.tabs.group) continue;
      const groupId = await api.tabs.group({ createProperties: { windowId: created.id }, tabIds: group.ids });
      const update = { title: group.name };
      if (COLOR_SET.has(group.color)) update.color = group.color;
      if (api.tabGroups?.update) await api.tabGroups.update(groupId, update);
    }
  }
}

async function openGroupTabs(open) {
  const api = chromeApi();
  if (!api?.tabs?.create) return;
  const tabs = open.tabs || open.urls.map((url) => ({ url }));
  const tabIds = [];
  for (const tab of tabs) {
    const created = await api.tabs.create({ url: tab.url, active: false });
    if (created?.id == null) continue;
    tabIds.push(created.id);
    if (tab.pinned) await api.tabs.update(created.id, { pinned: true });
  }
  if (tabIds.length && api.tabs.group) {
    const groupId = await api.tabs.group({ tabIds });
    const update = { title: open.name };
    if (COLOR_SET.has(open.color)) update.color = open.color;
    if (api.tabGroups?.update) await api.tabGroups.update(groupId, update);
  }
}

async function onRestore(id) {
  const result = restoreGroupBackup(state.store, id);
  if (!result.ok) {
    state.message = result.message || '无法恢复';
    render();
    return;
  }
  await openGroupTabs(result.open);
  state.message = result.message || '';
  render();
}

function rowTabs(win, selection) {
  if (!win) return [];
  if (selection?.kind === 'ungrouped') return win.ungrouped || [];
  return win.groups.find((item) => String(item.id) === String(selection?.groupId))?.tabs || [];
}

async function closeLiveTabs(tabs) {
  const api = chromeApi();
  const ids = (tabs || []).map((tab) => tab.tabId).filter((id) => id != null);
  if (ids.length && api?.tabs?.remove) await api.tabs.remove(ids);
}

function download(filename, contents, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function driveConfigFromForm() {
  const accountLabel = textOf(document.querySelector('#drive-account')?.value);
  const typed = textOf(document.querySelector('#drive-token')?.value);
  return { accountLabel: accountLabel || state.store.drive.accountLabel, accessToken: typed || state.driveToken };
}

async function applyDialog(form) {
  const kind = form.dataset.dialogForm;
  const data = new FormData(form);
  if (kind === 'name' && state.dialog?.purpose === 'session') {
    const result = saveSession(state.store, snapshots(), { name: data.get('title'), createId: () => createId('ss') });
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
  }
  if (kind === 'name' && state.dialog?.purpose === 'window') {
    const win = findWindow(state.dialog.windowId);
    const result = saveWindow(state.store, win ? snapshotOf(win) : {}, { name: data.get('title'), createId: () => createId('ss') });
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
  }
  if (kind === 'new-group') {
    const plan = planNewGroup({ name: data.get('title'), color: data.get('color') });
    state.message = plan.ok ? '已新建分组' : plan.message;
    const api = chromeApi();
    if (plan.ok && api?.tabs?.create && api.tabs.group) {
      const tab = await api.tabs.create({ active: true });
      const groupId = await api.tabs.group({ tabIds: [tab.id] });
      if (api.tabGroups?.update) await api.tabGroups.update(groupId, { title: plan.name, color: plan.color });
      await loadWindows();
    }
  }
  if (kind === 'live-edit') {
    const plan = planLiveGroupEdit({ name: data.get('title'), color: data.get('color') });
    const api = chromeApi();
    if (plan.ok && api?.tabGroups?.update) {
      await api.tabGroups.update(Number(state.dialog.groupId), plan.update);
      await loadWindows();
      state.message = '已更新分组';
    } else state.message = plan.message || '无法更新分组';
  }
  if (kind === 'backup-edit') {
    const backup = state.store.backups.find((item) => item.id === state.dialog.id);
    const tabs = (backup?.tabs || []).map((tab, index) => ({ url: data.get(`tab-${index}`), title: tab.title }));
    const extra = textOf(data.get('extra'));
    if (extra) tabs.push({ url: extra, title: '' });
    const result = editGroupBackup(state.store, state.dialog.id, {
      name: data.get('title'),
      color: data.get('color'),
      tabs,
    });
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
  }
  if (kind === 'rename-session') {
    const result = renameSession(state.store, state.dialog.id, data.get('title'));
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
    state.dialog = { type: 'session-edit', id: state.dialog.id };
    render();
    return;
  }
  if (kind === 'session-group') {
    const session = state.store.sessions.find((item) => item.id === form.dataset.id);
    const group = session?.windows.flatMap((win) => win.groups).find((item) => String(item.id) === form.dataset.group);
    const fields = [];
    let index = 0;
    while (data.has(`tab-url-${index}`)) {
      fields.push({ url: data.get(`tab-url-${index}`), title: data.get(`tab-title-${index}`) });
      index += 1;
    }
    const extraUrl = textOf(data.get('extra-url'));
    const tabs = sessionGroupFormTabs(group?.tabs, fields, extraUrl ? { url: extraUrl, title: data.get('extra-title') } : null);
    const result = editSessionGroup(state.store, form.dataset.id, form.dataset.group, {
      name: data.get('title'),
      tabs,
    });
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
    state.dialog = { type: 'session-edit', id: form.dataset.id };
    render();
    return;
  }
  state.dialog = null;
  render();
}

async function onAction(button) {
  const action = button.dataset.action;
  if (action === 'toggle-menu') {
    state.openMenu = state.openMenu === button.dataset.menu ? '' : button.dataset.menu;
    render();
    return;
  }
  if (action === 'clear-search') {
    state.searchQuery = '';
    const input = document.querySelector('#search-input');
    if (input) input.value = '';
    const clear = document.querySelector('#clear-search');
    if (clear) clear.hidden = true;
    renderSearchResults();
    return;
  }
  if (action === 'new-group') {
    state.dialog = { type: 'new-group' };
    render();
    return;
  }
  if (action === 'auto-group') {
    state.autoPreview = previewAutoGroups(snapshots());
    render();
    return;
  }
  if (action === 'close-auto') {
    state.autoPreview = null;
    render();
    return;
  }
  if (action === 'collapse-preview') {
    const win = state.autoPreview.windows.find((item) => String(item.windowId) === button.dataset.window);
    state.autoPreview = setPreviewCollapsed(state.autoPreview, button.dataset.window, !win?.collapsed);
    render();
    return;
  }
  if (action === 'toggle-suggestion') {
    state.autoPreview = editSuggestion(state.autoPreview, button.dataset.window, button.dataset.suggestion, { selected: button.checked });
    return;
  }
  if (action === 'apply-auto') {
    const applied = applyAutoGroupPreview(state.autoPreview);
    const api = chromeApi();
    for (const move of applied.moves) {
      const ids = move.tabs.map((tab) => tab.tabId).filter((id) => id != null);
      if (ids.length < 2 || !api?.tabs?.group) continue;
      const groupId = await api.tabs.group({ tabIds: ids, createProperties: { windowId: Number(move.windowId) } });
      if (api.tabGroups?.update) await api.tabGroups.update(groupId, { title: move.name, color: move.color });
    }
    state.autoUndo = applied.undo;
    state.message = applied.moves.length ? '已应用自动分组' : '没有要应用的分组';
    await loadWindows();
    state.autoPreview = previewAutoGroups(snapshots());
    render();
    return;
  }
  if (action === 'undo-auto') {
    const api = chromeApi();
    for (const item of state.autoUndo || []) {
      if (item.tabIds?.length && api?.tabs?.ungroup) await api.tabs.ungroup(item.tabIds);
    }
    state.autoUndo = null;
    state.message = '已撤销';
    await loadWindows();
    render();
    return;
  }
  if (action === 'save-all') {
    const result = saveAllGroups(state.store, snapshots(), { mode: button.dataset.mode, createId: () => createId('gb') });
    await writeStore(result.store);
    state.message = result.message;
    state.view = 'saved';
    render();
    return;
  }
  if (action === 'undo') {
    const result = undoUpdates(state.store);
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
    render();
    return;
  }
  if (action === 'save-session') {
    state.dialog = { type: 'name', purpose: 'session' };
    render();
    return;
  }
  if (action === 'save-window') {
    state.dialog = { type: 'name', purpose: 'window', windowId: button.dataset.window };
    render();
    return;
  }
  if (action === 'edit-live') {
    const win = findWindow(button.dataset.window);
    const group = win?.groups.find((item) => String(item.id) === button.dataset.group);
    state.dialog = { type: 'live-edit', groupId: button.dataset.group, name: group?.title || '', color: group?.color || 'grey' };
    render();
    return;
  }
  if (action === 'export-row') {
    const win = findWindow(button.dataset.window);
    state.dialog = { type: 'export', role: 'row', windowId: win?.id, kind: button.dataset.kind, groupId: button.dataset.group };
    render();
    return;
  }
  if (action === 'sort-tabs') {
    const win = findWindow(button.dataset.window);
    const group = win?.groups.find((item) => String(item.id) === button.dataset.group);
    const ordered = planSiteSortMoves(group?.tabs || []);
    const api = chromeApi();
    if (api?.tabs?.move) {
      for (const move of ordered) {
        if (move.tabId != null) await api.tabs.move(move.tabId, { index: move.index });
      }
    }
    state.message = '已按网站排列打开中的标签';
    await loadWindows();
    render();
    return;
  }
  if (action === 'save-close' || action === 'close-tabs') {
    const win = findWindow(button.dataset.window);
    if (!win) return;
    const selection = selectionFrom(button);
    if (action === 'save-close') {
      const result = planSaveAndClose(state.store, snapshotOf(win), selection, { createId: () => createId('gb') });
      if (!result.ok && result.code === 'name-required') {
        state.naming = {
          windowId: win.id,
          kind: selection.kind,
          groupId: button.dataset.group || '',
          closeAfter: true,
        };
        state.openMenu = '';
        state.message = '';
        render();
        panel.querySelector('input[name="backupName"]')?.focus();
        return;
      }
      if (!result.ok) {
        state.message = result.message;
        render();
        return;
      }
      await writeStore(result.store);
      await closeLiveTabs(rowTabs(win, selection));
      state.message = result.message;
    } else {
      await closeLiveTabs(rowTabs(win, selection));
      state.message = '已关闭标签';
    }
    await loadWindows();
    render();
    return;
  }
  if (action === 'export-library') {
    state.dialog = { type: 'export', role: 'library' };
    render();
    return;
  }
  if (action === 'export-one-backup') {
    state.dialog = { type: 'export', role: 'backup', id: button.dataset.id };
    render();
    return;
  }
  if (action === 'export-one-session') {
    state.dialog = { type: 'export', role: 'session', id: button.dataset.id };
    render();
    return;
  }
  if (action === 'download') {
    const format = button.dataset.format;
    let contents = '';
    if (state.dialog?.role === 'backup') {
      const backup = state.store.backups.find((item) => item.id === state.dialog.id);
      contents = exportBackup(backup, format);
    } else if (state.dialog?.role === 'session') {
      const session = state.store.sessions.find((item) => item.id === state.dialog.id);
      contents = exportSession(session, format);
    } else if (state.dialog?.role === 'row') {
      const win = findWindow(state.dialog.windowId);
      const selection = state.dialog.kind === 'ungrouped'
        ? { kind: 'ungrouped' }
        : { kind: 'group', groupId: state.dialog.groupId };
      const saved = saveActiveRow({ backups: [] }, snapshotOf(win), selection, { enteredName: '导出', createId: () => 'export' });
      contents = saved.ok ? exportBackup(saved.backup, format) : '';
    } else contents = exportLibrary(state.store, format);
    download(`group-backup.${format === 'markdown' ? 'md' : format}`, contents, 'text/plain');
    state.dialog = null;
    render();
    return;
  }
  if (action === 'pick-import') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.md,.markdown,.csv,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const raw = await file.text();
      const format = file.name.endsWith('.csv') ? 'csv' : file.name.endsWith('.json') ? 'json' : 'markdown';
      const preview = previewImport(raw, format);
      state.dialog = { type: 'import', preview };
      state.message = preview.message || '';
      render();
    });
    input.click();
    return;
  }
  if (action === 'apply-import') {
    const result = applyImport(state.store, state.dialog.preview, { createId: () => createId('im') });
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
    state.dialog = null;
    render();
    return;
  }
  if (action === 'ask-restore') {
    const target = JSON.parse(decodeURIComponent(button.dataset.target));
    state.dialog = { type: 'confirm', message: `恢复「${target.label}」？`, target };
    render();
    return;
  }
  if (action === 'confirm-yes') {
    const planned = planSelectiveRestore(state.store, state.dialog.target);
    if (!planned.ok) state.message = planned.message;
    else {
      const kind = state.dialog.target.kind;
      const plannedWindow = planned.openWindows[0];
      const hasGroupTabs = (plannedWindow?.groups || []).some((group) => (group.tabs || []).length);
      if (kind === 'session' || kind === 'session-window' || !hasGroupTabs) await openPlanned(planned.openWindows);
      else await openGroupTabs({
        name: planned.openWindows[0]?.groups[0]?.name,
        color: planned.openWindows[0]?.groups[0]?.color,
        tabs: [
          ...(planned.openWindows[0]?.groups || []).flatMap((group) => group.tabs),
          ...(planned.openWindows[0]?.ungrouped || []),
        ],
      });
      state.message = planned.message || '已恢复';
    }
    state.dialog = null;
    render();
    return;
  }
  if (action === 'close-dialog') {
    state.dialog = null;
    render();
    return;
  }
  if (action === 'focus-tab') {
    const found = findOpenTab(snapshots(), { tabId: Number(button.dataset.tab) });
    const api = chromeApi();
    if (found.ok && api?.tabs?.update) {
      await api.tabs.update(found.tabId, { active: true });
      if (api.windows?.update) await api.windows.update(found.windowId, { focused: true });
    } else state.message = found.message || '这个标签没有打开。';
    render();
    return;
  }
  if (action === 'restore-session') {
    const planned = planSessionRestore(state.store, button.dataset.id);
    state.message = planned.message || '';
    if (planned.ok) await openPlanned(planned.openWindows);
    render();
    return;
  }
  if (action === 'restore-session-window') {
    const planned = planSessionRestore(state.store, button.dataset.id, { windowId: button.dataset.window });
    state.message = planned.message || '';
    if (planned.ok) await openPlanned(planned.openWindows);
    render();
    return;
  }
  if (action === 'delete-backup' || action === 'delete-session') {
    const result = action === 'delete-backup' ? deleteBackup(state.store, button.dataset.id) : deleteSession(state.store, button.dataset.id);
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
    render();
    return;
  }
  if (action === 'edit-backup') {
    state.dialog = { type: 'backup-edit', id: button.dataset.id };
    render();
    return;
  }
  if (action === 'edit-session') {
    state.dialog = { type: 'session-edit', id: button.dataset.id };
    render();
    return;
  }
  if (action === 'pin-session') {
    const result = pinSession(state.store, button.dataset.id);
    if (result.ok) await writeStore(result.store);
    state.message = result.message;
    render();
    return;
  }
  if (action === 'window-up' || action === 'window-down') {
    const session = state.store.sessions.find((item) => item.id === button.dataset.id);
    const ids = session.windows.map((win) => win.id);
    const index = Number(button.dataset.index);
    const next = index + (action === 'window-up' ? -1 : 1);
    if (next >= 0 && next < ids.length) {
      const [id] = ids.splice(index, 1);
      ids.splice(next, 0, id);
      const result = reorderSessionWindows(state.store, session.id, ids);
      await writeStore(result.store);
    }
    render();
    return;
  }
  if (action === 'session-tab-up' || action === 'session-tab-down' || action === 'session-tab-delete') {
    const session = state.store.sessions.find((item) => item.id === button.dataset.id);
    const group = session?.windows.flatMap((win) => win.groups).find((item) => String(item.id) === button.dataset.group);
    if (!group) return;
    const tabs = group.tabs.map((tab) => ({ url: tab.url, title: tab.title, pinned: tab.pinned }));
    const index = Number(button.dataset.index);
    if (action === 'session-tab-delete') {
      tabs.splice(index, 1);
    } else {
      const next = index + (action === 'session-tab-up' ? -1 : 1);
      if (next < 0 || next >= tabs.length) return;
      const [tab] = tabs.splice(index, 1);
      tabs.splice(next, 0, tab);
    }
    const result = editSessionGroup(state.store, session.id, group.id, { tabs });
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
    state.dialog = { type: 'session-edit', id: session.id };
    render();
    return;
  }
  if (action === 'group-up' || action === 'group-down') {
    const session = state.store.sessions.find((item) => item.id === button.dataset.id);
    const win = session.windows.find((item) => String(item.id) === button.dataset.window);
    const ids = win.groups.map((group) => group.id);
    const index = Number(button.dataset.index);
    const next = index + (action === 'group-up' ? -1 : 1);
    if (next >= 0 && next < ids.length) {
      const [id] = ids.splice(index, 1);
      ids.splice(next, 0, id);
      const result = reorderSessionGroups(state.store, session.id, win.id, ids);
      await writeStore(result.store);
    }
    render();
    return;
  }
  if (action === 'add-backup') {
    const session = state.store.sessions.find((item) => item.id === button.dataset.id);
    const backupId = document.querySelector('#add-backup')?.value;
    const result = addBackupToSession(state.store, session.id, session.windows[0]?.id, backupId, { createId: () => createId('sg') });
    state.message = result.message;
    if (result.ok) await writeStore(result.store);
    render();
    return;
  }
  if (action === 'shortcuts') {
    await chromeApi()?.tabs?.create({ url: 'chrome://extensions/shortcuts' });
    return;
  }
  if (action === 'cleanup') {
    await writeStore(clearSaved(state.store));
    state.message = '已清理已保存内容';
    render();
    return;
  }
  if (action === 'tour' || action === 'tour-next') {
    const step = action === 'tour' ? 0 : state.store.settings.tourStep + 1;
    const done = step > 2;
    await writeStore(updateSettings(state.store, { tourStep: done ? 0 : step, tourSeen: done }));
    state.tour = !done;
    render();
    return;
  }
  if (action === 'show-history') {
    state.dialog = { type: 'history' };
    render();
    return;
  }
  if (action === 'connect-drive' || action === 'reconnect-drive' || action === 'sync-drive' || action === 'disconnect-drive') {
    const config = driveConfigFromForm();
    if (action === 'disconnect-drive') {
      const result = disconnectDrive(state.store);
      await writeStore(result.store);
      state.message = result.message;
    } else if (action === 'sync-drive') {
      const result = await syncDrive(state.store, { accessToken: config.accessToken, fetchImpl: globalThis.fetch });
      state.message = result.message;
      if (result.ok) await writeStore(result.store);
    } else {
      const result = action === 'reconnect-drive' ? reconnectDrive(state.store, config) : connectDrive(state.store, config);
      state.message = result.message;
      if (result.ok) {
        await writeDriveConfig(config.accountLabel, config.accessToken);
        await writeStore(result.store);
      }
    }
    render();
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.windowToggle != null) {
    const id = target.dataset.windowToggle;
    const numeric = Number(id);
    const key = Number.isNaN(numeric) ? id : numeric;
    if (state.openWindows.has(key) || state.openWindows.has(id)) {
      state.openWindows.delete(key);
      state.openWindows.delete(id);
    } else state.openWindows.add(key);
    render();
    return;
  }
  if (target.dataset.rowToggle != null) {
    const key = target.dataset.rowToggle;
    if (state.openRows.has(key)) state.openRows.delete(key);
    else state.openRows.add(key);
    render();
    return;
  }
  if (target.dataset.backupToggle != null) {
    const key = target.dataset.backupToggle;
    if (state.openBackups.has(key)) state.openBackups.delete(key);
    else state.openBackups.add(key);
    render();
    return;
  }
  if (target.dataset.sessionToggle != null) {
    const key = target.dataset.sessionToggle;
    if (state.openSessions.has(key)) state.openSessions.delete(key);
    else state.openSessions.add(key);
    render();
    return;
  }
  if (target.dataset.saveWindow != null && target.dataset.action == null) {
    onSaveClick(target);
    return;
  }
  if (target.dataset.restore != null) {
    onRestore(target.dataset.restore).catch((error) => console.error(error));
    return;
  }
  if (target.dataset.action) onAction(target).catch((error) => console.error(error));
});

document.addEventListener('submit', (event) => {
  const nameForm = event.target.closest('[data-name-form]');
  if (nameForm) {
    event.preventDefault();
    onConfirm(nameForm);
    return;
  }
  const dialogForm = event.target.closest('[data-dialog-form]');
  if (!dialogForm) return;
  event.preventDefault();
  applyDialog(dialogForm).catch((error) => console.error(error));
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'search-scope') {
    state.searchScope = target.value;
    renderSearchResults();
    return;
  }
  if (target.id === 'sort-mode') {
    const view = state.view === 'saved' ? 'saved' : 'active';
    state.store = rememberSort(state.store, view, target.value);
    writeStore(state.store);
    render();
    return;
  }
  if (target.id === 'language' || target.id === 'theme') {
    const patch = target.id === 'language' ? { language: target.value } : { theme: target.value };
    writeStore(updateSettings(state.store, patch));
    toolbar.dataset.signature = '';
    render();
    return;
  }
  if (target.id === 'auto-save' || target.id === 'analytics') {
    const patch = target.id === 'auto-save'
      ? { autoSaveOnWindowClose: target.checked }
      : { analytics: target.checked };
    writeStore(updateSettings(state.store, patch));
    return;
  }
  if (target.dataset.suggestionName != null) {
    state.autoPreview = editSuggestion(state.autoPreview, target.dataset.window, target.dataset.suggestionName, { name: target.value });
  }
  if (target.dataset.suggestionColor != null) {
    state.autoPreview = editSuggestion(state.autoPreview, target.dataset.window, target.dataset.suggestionColor, { color: target.value });
  }
  if (target.dataset.action === 'move-group') {
    const result = moveSessionGroup(state.store, target.dataset.id, target.dataset.group, target.value);
    if (result.ok) writeStore(result.store).then(render);
  }
  if (target.dataset.action === 'toggle-suggestion') {
    onAction(target);
  }
});

toolbar.addEventListener('input', (event) => {
  if (event.target.id !== 'search-input') return;
  state.searchQuery = event.target.value;
  const clear = document.querySelector('#clear-search');
  if (clear) clear.hidden = state.searchQuery.length === 0;
  renderSearchResults();
});

activeButton.addEventListener('click', () => {
  state.view = 'active';
  toolbar.dataset.signature = '';
  render();
});

savedButton.addEventListener('click', () => {
  state.view = 'saved';
  toolbar.dataset.signature = '';
  render();
});

settingsButton.addEventListener('click', () => {
  state.view = state.view === 'settings' ? 'active' : 'settings';
  render();
});

async function start() {
  try {
    await readStore();
    await loadWindows();
  } catch (error) {
    console.error(error);
  }
  render();
}

start();
