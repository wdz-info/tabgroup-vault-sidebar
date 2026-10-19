import { autoSaveClosedWindow, normalizeStore } from './src/backup-logic.js';

const STORAGE_KEY = 'groupBackups';
const cache = new Map();

function enablePanel() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error(error);
  }
}

function tabItem(tab) {
  return {
    tabId: tab.id,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    pinned: Boolean(tab.pinned),
  };
}

async function refreshCache() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const tabs = await chrome.tabs.query({});
  const groups = chrome.tabGroups?.query ? await chrome.tabGroups.query({}) : [];
  const meta = new Map(groups.map((group) => [group.id, group]));
  for (const win of windows) {
    const winTabs = tabs.filter((tab) => tab.windowId === win.id).sort((a, b) => a.index - b.index);
    const grouped = new Map();
    const ungrouped = [];
    for (const tab of winTabs) {
      const item = tabItem(tab);
      if (tab.groupId == null || tab.groupId === -1) ungrouped.push(item);
      else {
        if (!grouped.has(tab.groupId)) grouped.set(tab.groupId, []);
        grouped.get(tab.groupId).push(item);
      }
    }
    cache.set(win.id, {
      windowId: win.id,
      groups: [...grouped.entries()].map(([id, groupTabs]) => ({
        id,
        title: meta.get(id)?.title || '',
        color: meta.get(id)?.color || '',
        tabs: groupTabs,
      })),
      ungrouped,
    });
  }
}

async function onWindowRemoved(windowId) {
  const snapshot = cache.get(windowId);
  cache.delete(windowId);
  if (!snapshot) return;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const store = normalizeStore(stored[STORAGE_KEY]);
  if (!store.settings.autoSaveOnWindowClose) return;
  const result = autoSaveClosedWindow(store, snapshot, {
    enabled: true,
    createId: () => `gb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  await chrome.storage.local.set({ [STORAGE_KEY]: result.store });
}

enablePanel();
chrome.runtime.onInstalled.addListener(enablePanel);
chrome.runtime.onStartup.addListener(enablePanel);
chrome.tabs.onUpdated.addListener(() => { refreshCache().catch((error) => console.error(error)); });
chrome.tabs.onCreated.addListener(() => { refreshCache().catch((error) => console.error(error)); });
chrome.tabs.onRemoved.addListener((_tabId, info) => {
  if (info.isWindowClosing) return;
  refreshCache().catch((error) => console.error(error));
});
chrome.windows.onCreated.addListener(() => { refreshCache().catch((error) => console.error(error)); });
chrome.windows.onRemoved.addListener((windowId) => {
  onWindowRemoved(windowId).catch((error) => console.error(error));
});
refreshCache().catch((error) => console.error(error));
