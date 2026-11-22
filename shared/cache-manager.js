/**
 * TabScan Q&A - Query Cache Manager
 * Two-tier cache (Tier 1: in-memory Map, Tier 2: chrome.storage.local) with deterministic
 * key hashing, LRU eviction (max 150 entries / 4MB quota), and 24-hour TTL expiration.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 150;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const STORAGE_PREFIX = 'tabscan_qc_';
const STORAGE_INDEX_KEY = 'tabscan_qc__index';

const globalMemoryCache = new Map();

/**
 * Computes a deterministic 32-character hex hash key for a query and context.
 *
 * @param {object} params
 * @param {string} [params.contentHash]
 * @param {string} [params.query]
 * @param {string} [params.model]
 * @param {string} [params.answerStyle='normal']
 * @returns {string} 32-character hexadecimal digest
 */
export function computeQueryCacheKey({
  contentHash = '',
  query = '',
  model = '',
  answerStyle = 'normal',
} = {}) {
  const normHash = (contentHash || '').trim();
  const normQuery = (query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const normModel = (model || '').trim().toLowerCase();
  const normStyle = (answerStyle || 'normal').trim().toLowerCase();
  const seed = `${normHash}::${normModel}::${normStyle}::${normQuery}`;

  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  const prime1 = 0x100000001b3n;
  const prime2 = 0x100000001b5n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < seed.length; i++) {
    const code = BigInt(seed.charCodeAt(i));
    h1 = ((h1 ^ code) * prime1) & mask;
    h2 = ((h2 ^ (code + 7n)) * prime2) & mask;
  }

  return `${h1.toString(16).padStart(16, '0')}${h2.toString(16).padStart(16, '0')}`;
}

function getFromStorage(storageArea, keys) {
  if (!storageArea || typeof storageArea.get !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const res = storageArea.get(keys, (items) => {
        resolve(items || null);
      });
      if (res && typeof res.then === 'function') {
        res.then(resolve, () => resolve(null));
      }
    } catch {
      resolve(null);
    }
  });
}

function setToStorage(storageArea, items) {
  if (!storageArea || typeof storageArea.set !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const res = storageArea.set(items, () => {
        resolve();
      });
      if (res && typeof res.then === 'function') {
        res.then(resolve, () => resolve());
      }
    } catch {
      resolve();
    }
  });
}

function removeFromStorage(storageArea, keys) {
  if (!storageArea || typeof storageArea.remove !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const res = storageArea.remove(keys, () => {
        resolve();
      });
      if (res && typeof res.then === 'function') {
        res.then(resolve, () => resolve());
      }
    } catch {
      resolve();
    }
  });
}

/**
 * Retrieves a cached query response from Tier 1 (memory) or Tier 2 (storageArea).
 *
 * @param {string} key
 * @param {object} [storageArea]
 * @returns {Promise<{ answer: string, cachedAt: number, tokensSaved?: number, model?: string } | null>}
 */
export async function getQueryCache(key, storageArea = globalThis.chrome?.storage?.local) {
  if (!key) return null;
  const now = Date.now();

  // 1. Tier 1: In-memory Map
  if (globalMemoryCache.has(key)) {
    const entry = globalMemoryCache.get(key);
    if (now - entry.cachedAt > DEFAULT_TTL_MS) {
      globalMemoryCache.delete(key);
      const storageKey = STORAGE_PREFIX + key;
      await removeFromStorage(storageArea, [storageKey]);
      return null;
    }
    entry.lastAccessed = now;
    return {
      answer: entry.answer,
      cachedAt: entry.cachedAt,
      tokensSaved: entry.tokensSaved,
      model: entry.model,
    };
  }

  // 2. Tier 2: Storage area
  const storageKey = STORAGE_PREFIX + key;
  const items = await getFromStorage(storageArea, [storageKey]);
  const entry = items?.[storageKey];
  if (!entry) return null;

  if (now - entry.cachedAt > DEFAULT_TTL_MS) {
    await removeFromStorage(storageArea, [storageKey]);
    return null;
  }

  entry.lastAccessed = now;
  globalMemoryCache.set(key, entry);

  return {
    answer: entry.answer,
    cachedAt: entry.cachedAt,
    tokensSaved: entry.tokensSaved,
    model: entry.model,
  };
}

/**
 * Saves a query response to Tier 1 and Tier 2 cache with LRU eviction and quota enforcement.
 *
 * @param {string} key
 * @param {object} data
 * @param {object} [storageArea]
 * @param {number} [maxEntries=150]
 * @returns {Promise<void>}
 */
export async function setQueryCache(
  key,
  data,
  storageArea = globalThis.chrome?.storage?.local,
  maxEntries = DEFAULT_MAX_ENTRIES
) {
  if (!key || !data) return;
  const now = Date.now();

  const entry = {
    answer: typeof data === 'string' ? data : data.answer || '',
    cachedAt: data.cachedAt || now,
    tokensSaved: data.tokensSaved ?? 0,
    query: data.query || '',
    model: data.model || '',
    lastAccessed: now,
  };

  // Tier 1 memory map LRU
  if (globalMemoryCache.size >= maxEntries && !globalMemoryCache.has(key)) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of globalMemoryCache.entries()) {
      if ((v.lastAccessed || v.cachedAt) < oldestTime) {
        oldestTime = v.lastAccessed || v.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      globalMemoryCache.delete(oldestKey);
    }
  }
  globalMemoryCache.set(key, entry);

  // Tier 2 storageArea LRU
  if (storageArea && typeof storageArea.set === 'function') {
    const storageKey = STORAGE_PREFIX + key;
    const indexData = await getFromStorage(storageArea, [STORAGE_INDEX_KEY]);
    let index = Array.isArray(indexData?.[STORAGE_INDEX_KEY]) ? indexData[STORAGE_INDEX_KEY] : [];

    const approxEntryBytes = JSON.stringify(entry).length;
    index = index.filter((item) => item.key !== key);
    index.push({
      key,
      storageKey,
      cachedAt: entry.cachedAt,
      lastAccessed: now,
      bytes: approxEntryBytes,
    });

    const keysToRemove = [];

    // Enforce maxEntries
    while (index.length > maxEntries) {
      index.sort((a, b) => a.lastAccessed - b.lastAccessed);
      const evicted = index.shift();
      if (evicted) keysToRemove.push(evicted.storageKey);
    }

    // Enforce 4MB byte quota
    let totalBytes = index.reduce((sum, item) => sum + (item.bytes || 0), 0);
    while (totalBytes > MAX_CACHE_BYTES && index.length > 1) {
      index.sort((a, b) => a.lastAccessed - b.lastAccessed);
      const evicted = index.shift();
      if (evicted) {
        keysToRemove.push(evicted.storageKey);
        totalBytes -= (evicted.bytes || 0);
      }
    }

    if (keysToRemove.length > 0) {
      await removeFromStorage(storageArea, keysToRemove);
    }

    await setToStorage(storageArea, {
      [storageKey]: entry,
      [STORAGE_INDEX_KEY]: index,
    });
  }
}

/**
 * Clears all query cache entries from Tier 1 and Tier 2.
 *
 * @param {object} [storageArea]
 * @returns {Promise<void>}
 */
export async function clearQueryCache(storageArea = globalThis.chrome?.storage?.local) {
  globalMemoryCache.clear();
  if (storageArea && typeof storageArea.remove === 'function') {
    const indexData = await getFromStorage(storageArea, [STORAGE_INDEX_KEY]);
    const index = Array.isArray(indexData?.[STORAGE_INDEX_KEY]) ? indexData[STORAGE_INDEX_KEY] : [];
    const keysToRemove = index.map((i) => i.storageKey).concat(STORAGE_INDEX_KEY);
    await removeFromStorage(storageArea, keysToRemove);
  }
}

/**
 * Two-tier Query Cache Manager with metrics tracking, bypass flags, and custom storage bindings.
 */
export class QueryCacheManager {
  constructor(options = {}) {
    this.storageArea = options.storageArea || globalThis.chrome?.storage?.local || null;
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.memoryMap = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      tokensSavedTotal: 0,
    };
    this.forceRefresh = Boolean(options.forceRefresh);
  }

  computeKey(params) {
    return computeQueryCacheKey(params);
  }

  setForceRefresh(flag) {
    this.forceRefresh = Boolean(flag);
  }

  getStats() {
    return { ...this.stats };
  }

  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      tokensSavedTotal: 0,
    };
  }

  async get(paramsOrKey, storageArea = this.storageArea) {
    if (this.forceRefresh) {
      this.stats.misses++;
      return null;
    }

    const key = typeof paramsOrKey === 'string' ? paramsOrKey : computeQueryCacheKey(paramsOrKey);
    const now = Date.now();

    // Check instance memoryMap
    if (this.memoryMap.has(key)) {
      const entry = this.memoryMap.get(key);
      if (now - entry.cachedAt > this.ttlMs) {
        this.memoryMap.delete(key);
        await removeFromStorage(storageArea, [STORAGE_PREFIX + key]);
        this.stats.misses++;
        return null;
      }
      entry.lastAccessed = now;
      this.stats.hits++;
      this.stats.tokensSavedTotal += (entry.tokensSaved || 0);
      return {
        answer: entry.answer,
        cachedAt: entry.cachedAt,
        tokensSaved: entry.tokensSaved,
        model: entry.model,
      };
    }

    // Check global memory cache / storageArea
    const cached = await getQueryCache(key, storageArea);
    if (cached) {
      this.memoryMap.set(key, { ...cached, lastAccessed: now });
      this.stats.hits++;
      this.stats.tokensSavedTotal += (cached.tokensSaved || 0);
      return cached;
    }

    this.stats.misses++;
    return null;
  }

  async set(paramsOrKey, data, storageArea = this.storageArea, maxEntries = this.maxEntries) {
    const key = typeof paramsOrKey === 'string' ? paramsOrKey : computeQueryCacheKey(paramsOrKey);
    const now = Date.now();
    const entry = {
      answer: typeof data === 'string' ? data : data.answer || '',
      cachedAt: data.cachedAt || now,
      tokensSaved: data.tokensSaved ?? 0,
      query: data.query || '',
      model: data.model || '',
      lastAccessed: now,
    };

    if (this.memoryMap.size >= maxEntries && !this.memoryMap.has(key)) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.memoryMap.entries()) {
        if ((v.lastAccessed || v.cachedAt) < oldestTime) {
          oldestTime = v.lastAccessed || v.cachedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.memoryMap.delete(oldestKey);
    }
    this.memoryMap.set(key, entry);

    return setQueryCache(key, entry, storageArea, maxEntries);
  }

  async clear(storageArea = this.storageArea) {
    this.memoryMap.clear();
    return clearQueryCache(storageArea);
  }
}
