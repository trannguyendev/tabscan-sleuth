/**
 * Update detection utility for Tab-Sleuth.
 * Checks GitHub Releases API for newer tags compared to the active extension version.
 */

export const GITHUB_REPO = 'trannguyendev/tabscan-sleuth';
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Parses a semver-like string (e.g. "v1.0.1", "1.2.0") into [major, minor, patch].
 */
export function parseSemver(v) {
  if (typeof v !== 'string') return [0, 0, 0];
  const cleaned = v.trim().replace(/^[vV]/, '');
  const [major = 0, minor = 0, patch = 0] = cleaned
    .split('.')
    .map((num) => parseInt(num, 10) || 0);
  return [major, minor, patch];
}

/**
 * Returns true if remoteTag is strictly greater than localVersion.
 */
export function isNewerVersion(remoteTag, localVersion) {
  const [rMaj, rMin, rPat] = parseSemver(remoteTag);
  const [lMaj, lMin, lPat] = parseSemver(localVersion);

  if (rMaj > lMaj) return true;
  if (rMaj < lMaj) return false;

  if (rMin > lMin) return true;
  if (rMin < lMin) return false;

  return rPat > lPat;
}

/**
 * Queries GitHub Releases API to see if a newer version exists.
 */
export async function checkGitHubRelease(options = {}) {
  const {
    repo = GITHUB_REPO,
    currentVersion = '1.0.1',
    storage = null,
    force = false,
    fetchFn = globalThis.fetch,
  } = options;

  if (!force && storage) {
    try {
      const cached = await storage.get(['tabscan_last_update_check', 'tabscan_update_info']);
      const lastCheck = cached.tabscan_last_update_check || 0;
      const now = Date.now();
      if (now - lastCheck < CHECK_INTERVAL_MS && cached.tabscan_update_info) {
        const remoteTag = cached.tabscan_update_info.latestVersion || '';
        return {
          ...cached.tabscan_update_info,
          hasUpdate: isNewerVersion(remoteTag, currentVersion),
        };
      }
    } catch {
      // Fall through to live check
    }
  }

  try {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await fetchFn(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!res || !res.ok) {
      return { hasUpdate: false, error: `GitHub API error: ${res?.status || 'network'}` };
    }

    const data = await res.json();
    const remoteTag = data.tag_name || '';
    const hasUpdate = isNewerVersion(remoteTag, currentVersion);

    const updateInfo = {
      hasUpdate,
      currentVersion,
      latestVersion: remoteTag,
      releaseName: data.name || remoteTag,
      releaseUrl: data.html_url || `https://github.com/${repo}/releases/latest`,
      releaseBody: data.body || '',
      downloadUrl: `https://github.com/${repo}/releases/latest/download/tab-sleuth.zip`,
      updaterBatUrl: `https://raw.githubusercontent.com/${repo}/main/update.bat`,
      checkedAt: Date.now(),
    };

    if (storage) {
      try {
        await storage.set({
          tabscan_last_update_check: Date.now(),
          tabscan_update_info: updateInfo,
        });
      } catch {
        // Ignore storage errors
      }
    }

    return updateInfo;
  } catch (err) {
    return { hasUpdate: false, error: err.message };
  }
}

/**
 * Initiates download of update.bat via same-origin Blob URL,
 * with graceful fallback to opening the script source in a browser tab.
 * Properly handles Chrome extension side panel cross-origin navigation restrictions.
 *
 * @param {Object} [options]
 * @param {string} [options.url] - URL to fetch the update script from.
 * @param {string} [options.filename='update.bat'] - Target filename for download.
 * @param {Function} [options.fetchFn=globalThis.fetch] - Fetch implementation.
 * @param {Function} [options.createObjectURL] - URL.createObjectURL implementation.
 * @param {Function} [options.revokeObjectURL] - URL.revokeObjectURL implementation.
 * @param {Object} [options.documentObj=globalThis.document] - DOM document implementation.
 * @param {Object} [options.chromeTabs=globalThis.chrome?.tabs] - Chrome tabs API.
 * @param {Object} [options.windowObj=globalThis.window] - Window object for window.open fallback.
 * @returns {Promise<{success: boolean, method: 'blob'|'tab'|'window'|'failed', error?: string, fallbackReason?: string}>}
 */
export async function downloadUpdateScript(options = {}) {
  const {
    url,
    filename = 'update.bat',
    fetchFn = globalThis.fetch,
    createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
    revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
    documentObj = globalThis.document,
    chromeTabs = globalThis.chrome?.tabs,
    windowObj = globalThis.window,
  } = options;

  const defaultUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/update.bat`;
  const resolvedUrl = typeof url === 'string' && url.trim().length > 0 ? url.trim() : defaultUrl;

  // Enforce secure HTTP/HTTPS protocol to prevent execution of javascript: or dangerous schemes
  if (!/^https?:\/\//i.test(resolvedUrl)) {
    return {
      success: false,
      method: 'failed',
      error: 'Invalid update script URL: must be an HTTP or HTTPS URL',
    };
  }

  // Sanitize download filename against path traversal
  const safeFilename = typeof filename === 'string' && filename.trim().length > 0
    ? filename.trim().split(/[/\\]/).pop() || 'update.bat'
    : 'update.bat';

  // Primary method: fetch script text and trigger download via same-origin Blob URL
  try {
    if (typeof fetchFn !== 'function') {
      throw new Error('fetch is not available');
    }
    const res = await fetchFn(resolvedUrl);
    if (!res || !res.ok) {
      throw new Error(`Failed to fetch update script: HTTP ${res?.status || 'unknown'}`);
    }
    const text = await res.text();
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Empty update script received');
    }

    // Normalize Windows batch line endings to CRLF for cmd.exe compatibility
    const normalizedText = text.replace(/\r?\n/g, '\r\n');

    if (typeof createObjectURL === 'function' && documentObj?.createElement) {
      const blob = new Blob([normalizedText], { type: 'application/x-bat;charset=utf-8' });
      const blobUrl = createObjectURL(blob);
      const tempA = documentObj.createElement('a');
      tempA.href = blobUrl;
      tempA.download = safeFilename;
      tempA.style = tempA.style || {};
      tempA.style.display = 'none';

      const targetParent = documentObj.body || documentObj.documentElement;
      if (targetParent?.appendChild) {
        targetParent.appendChild(tempA);
      }
      if (typeof tempA.click === 'function') {
        tempA.click();
      }
      if (typeof tempA.remove === 'function') {
        tempA.remove();
      } else if (targetParent?.removeChild) {
        targetParent.removeChild(tempA);
      }
      if (typeof revokeObjectURL === 'function') {
        setTimeout(() => revokeObjectURL(blobUrl), 15000);
      }
      return { success: true, method: 'blob' };
    }
    throw new Error('Blob URL creation or DOM anchor not supported in this context');
  } catch (directErr) {
    // Automatic graceful fallback without silent failure or cross-origin sidepanel navigation errors:
    // Open the batch script source in a new browser tab via chrome.tabs.create (or window.open)
    try {
      if (chromeTabs && typeof chromeTabs.create === 'function') {
        await chromeTabs.create({ url: resolvedUrl });
        return { success: true, method: 'tab', fallbackReason: directErr.message };
      }
      if (windowObj && typeof windowObj.open === 'function') {
        windowObj.open(resolvedUrl, '_blank', 'noopener,noreferrer');
        return { success: true, method: 'window', fallbackReason: directErr.message };
      }
      return { success: false, method: 'failed', error: directErr.message };
    } catch (fallbackErr) {
      return { success: false, method: 'failed', error: fallbackErr.message };
    }
  }
}

