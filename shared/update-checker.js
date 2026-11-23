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
