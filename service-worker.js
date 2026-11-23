import { DEFAULT_SETTINGS, STORAGE_KEYS } from './shared/constants.js';
import { checkGitHubRelease } from './shared/update-checker.js';

const MENU_ASK_SELECTION = 'tabscan-ask-selection';
const MENU_SCAN_PAGE = 'tabscan-scan-page';

// Open the side panel automatically whenever the user clicks the toolbar icon.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('Failed to set sidePanel behavior:', err));

/**
 * Registers context menu items idempotently.
 */
function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.warn('contextMenus.removeAll warning:', chrome.runtime.lastError.message);
    }

    chrome.contextMenus.create({
      id: MENU_ASK_SELECTION,
      title: 'Ask Tab-Sleuth about "%s"',
      contexts: ['selection'],
    });

    chrome.contextMenus.create({
      id: MENU_SCAN_PAGE,
      title: 'Scan & answer this tab with Tab-Sleuth',
      contexts: ['page'],
    });
  });
}

/**
 * Checks for extension updates on Chrome startup (strictly once per browser session).
 */
export async function checkStartupUpdate() {
  try {
    const sessionData = await chrome.storage.session.get('checked_startup_update');
    if (sessionData?.checked_startup_update) {
      return; // Already checked during this Chrome startup session
    }
    await chrome.storage.session.set({ checked_startup_update: true });

    const manifest = chrome.runtime?.getManifest ? chrome.runtime.getManifest() : { version: '1.0.1' };
    const currentVersion = manifest?.version || '1.0.1';

    const result = await checkGitHubRelease({
      currentVersion,
      force: true, // Force live check on browser start
    });

    if (result?.hasUpdate) {
      await chrome.storage.local.set({
        tabscan_update_info: result,
        tabscan_last_update_check: Date.now(),
      });
      if (chrome.action?.setBadgeText) {
        await chrome.action.setBadgeText({ text: 'NEW' });
        await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      }
    } else {
      if (chrome.action?.setBadgeText) {
        await chrome.action.setBadgeText({ text: '' });
      }
    }
  } catch (err) {
    console.debug('Startup update check skipped or failed:', err);
  }
}

// Trigger once per Chrome startup session
chrome.runtime.onStartup.addListener(() => {
  checkStartupUpdate();
});

chrome.runtime.onInstalled.addListener(async () => {
  registerContextMenus();
  checkStartupUpdate();

  try {
    const existing = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    if (!existing[STORAGE_KEYS.SETTINGS]) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS },
      });
    }
  } catch (err) {
    console.error('Failed to initialize default settings:', err);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.windowId) return;

  // Call sidePanel.open synchronously before any await to preserve the user gesture.
  const openPromise = chrome.sidePanel.open({ windowId: tab.windowId });

  (async () => {
    try {
      await openPromise;
      await chrome.storage.session.set({
        [STORAGE_KEYS.PENDING_ACTION]: {
          menuItemId: info.menuItemId,
          tabId: tab.id ?? null,
          selectionText: info.selectionText?.trim() || '',
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.error('Failed to handle context menu click:', err);
    }
  })();
});
