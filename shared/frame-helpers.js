/**
 * Pure helpers for merging multi-frame scan snapshots, full-page scroll tile math,
 * and DOM action results across frames.
 */

const MAX_MERGED_CANDIDATES = 25;
const MAX_MERGED_VISUAL_IMAGES = 6;

/**
 * Computes overlapping vertical scroll offsets covering a scrollable page or container.
 * @param {number} scrollHeight
 * @param {number} clientHeight
 * @param {number} [maxTiles=6]
 * @returns {number[]}
 */
export function computeScrollPositions(scrollHeight, clientHeight, maxTiles = 6) {
  const totalH = Math.max(0, Math.round(scrollHeight || 0));
  const viewH = Math.max(1, Math.round(clientHeight || 0));
  const maxScroll = Math.max(0, totalH - viewH);
  if (maxScroll <= 80 || maxTiles <= 1) {
    return [0];
  }

  // Overlap ~14% per step so text/diagrams at viewport edges appear cleanly in both slices
  const minStep = Math.max(180, Math.round(viewH * 0.86));
  const naturalCount = Math.ceil(maxScroll / minStep) + 1;
  const tileCount = Math.min(maxTiles, Math.max(2, naturalCount));

  if (tileCount === 2) {
    return [0, maxScroll];
  }

  const positions = [];
  const evenStep = maxScroll / (tileCount - 1);
  for (let i = 0; i < tileCount; i++) {
    const y = i === tileCount - 1 ? maxScroll : Math.round(i * evenStep);
    if (positions.length === 0 || y > positions[positions.length - 1] + 24) {
      positions.push(y);
    }
  }
  return positions;
}

function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getFramePriority(entry) {
  const res = entry?.result;
  if (!res) return -1;
  const hasSelection = (res.selection || '').trim().length > 0 ? 1000 : 0;
  const candidateScore = (res.questionCandidates?.length || 0) * 150;
  const textScore = Math.min((res.text || '').trim().length, 6000);
  const topBonus = entry.frameId === 0 ? 50 : 0;
  return hasSelection + candidateScore + textScore + topBonus;
}

/**
 * Merges `chrome.scripting.executeScript({ allFrames: true })` scanner results into one page snapshot.
 * @param {Array<{frameId?: number, result?: any}>} frameResults
 * @param {number} [maxMergedChars=28000]
 * @returns {any|null}
 */
export function mergeFrameSnapshots(frameResults = [], maxMergedChars = 28000) {
  const valid = (Array.isArray(frameResults) ? frameResults : []).filter(
    (entry) => entry && entry.result && typeof entry.result === 'object'
  );
  if (valid.length === 0) return null;

  const topEntry = valid.find((entry) => entry.frameId === 0) || valid[0];
  const readyFrames = valid.filter((entry) => {
    const r = entry.result;
    return (
      r.kind === 'ready' &&
      ((r.text || '').trim().length > 0 ||
        (r.questionCandidates?.length || 0) > 0 ||
        (r.selection || '').trim().length > 0)
    );
  });

  if (readyFrames.length === 0) {
    const visualEntry = valid.find((entry) => entry.result.kind === 'visual_only');
    return visualEntry ? { ...visualEntry.result } : { ...topEntry.result };
  }

  if (readyFrames.length === 1) {
    const single = readyFrames[0];
    const singleMedia = single.result.mediaSummary || {
      imageCount: 0,
      canvasCount: 0,
      svgCount: 0,
      visualHints: [],
      visualImages: [],
      hasVisualContent: false,
    };
    const mergedVisuals = [...(singleMedia.visualImages || [])];
    const seenVisualKeys = new Set(mergedVisuals.map((v) => v.src || v.dataUrl).filter(Boolean));
    for (const entry of valid) {
      if (entry === single) continue;
      const ms = entry.result.mediaSummary;
      for (const vi of ms?.visualImages || []) {
        const key = vi.src || vi.dataUrl;
        if (!key || seenVisualKeys.has(key) || mergedVisuals.length >= MAX_MERGED_VISUAL_IMAGES) continue;
        seenVisualKeys.add(key);
        mergedVisuals.push(vi);
      }
      if (entry.result.kind === 'visual_only' && entry.result.reason === 'image' && entry.result.url) {
        const key = entry.result.url;
        if (!seenVisualKeys.has(key) && mergedVisuals.length < MAX_MERGED_VISUAL_IMAGES) {
          seenVisualKeys.add(key);
          mergedVisuals.push({
            kind: 'img',
            src: entry.result.url,
            alt: entry.result.title || 'Embedded image',
            width: 800,
            height: 600,
          });
        }
      }
    }
    const snap = {
      ...single.result,
      mediaSummary: {
        ...singleMedia,
        visualImages: mergedVisuals,
        hasVisualContent:
          Boolean(singleMedia.hasVisualContent) || mergedVisuals.length > 0,
      },
      frameIds: [single.frameId ?? 0],
    };
    if (!snap.title && topEntry.result.title) {
      snap.title = topEntry.result.title;
    }
    return snap;
  }

  const ordered = [...readyFrames].sort((a, b) => getFramePriority(b) - getFramePriority(a));

  const sections = [];
  let rawTotalChars = 0;
  let anyTruncated = false;

  for (const entry of ordered) {
    const r = entry.result;
    rawTotalChars += r.totalChars || (r.text || '').length;
    if (r.truncated) anyTruncated = true;
    const chunk = (r.text || '').trim();
    if (!chunk) continue;
    if (entry.frameId !== 0 && (r.title || r.url)) {
      sections.push(`[Embedded frame: ${r.title || r.url}]\n${chunk}`);
    } else {
      sections.push(chunk);
    }
  }

  const joined = sections.join('\n\n');
  const truncated = anyTruncated || joined.length > maxMergedChars;
  const text = joined.length > maxMergedChars ? joined.slice(0, maxMergedChars) : joined;

  const mergedCandidates = [];
  const seenPrompts = new Set();
  for (const entry of ordered) {
    for (const cand of entry.result.questionCandidates || []) {
      const key = (cand.prompt || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!key || seenPrompts.has(key)) continue;
      seenPrompts.add(key);
      mergedCandidates.push(cand);
      if (mergedCandidates.length >= MAX_MERGED_CANDIDATES) break;
    }
    if (mergedCandidates.length >= MAX_MERGED_CANDIDATES) break;
  }

  const visualHints = [];
  const seenHints = new Set();
  const visualImages = [];
  const seenVisuals = new Set();
  let imageCount = 0;
  let canvasCount = 0;
  let svgCount = 0;
  for (const entry of valid) {
    const ms = entry.result.mediaSummary;
    if (ms) {
      imageCount += ms.imageCount || 0;
      canvasCount += ms.canvasCount || 0;
      svgCount += ms.svgCount || 0;
      for (const h of ms.visualHints || []) {
        const key = h.toLowerCase();
        if (!seenHints.has(key) && visualHints.length < 10) {
          seenHints.add(key);
          visualHints.push(h);
        }
      }
      for (const vi of ms.visualImages || []) {
        const key = vi?.src || vi?.dataUrl;
        if (!key || seenVisuals.has(key) || visualImages.length >= MAX_MERGED_VISUAL_IMAGES) continue;
        seenVisuals.add(key);
        visualImages.push(vi);
      }
    }
    if (entry.result.kind === 'visual_only' && entry.result.reason === 'image' && entry.result.url) {
      const key = entry.result.url;
      if (!seenVisuals.has(key) && visualImages.length < MAX_MERGED_VISUAL_IMAGES) {
        seenVisuals.add(key);
        visualImages.push({
          kind: 'img',
          src: entry.result.url,
          alt: entry.result.title || 'Embedded image',
          width: 800,
          height: 600,
        });
      }
    }
  }

  const selection =
    ordered.map((e) => (e.result.selection || '').trim()).find(Boolean) || '';
  const description =
    topEntry.result.description ||
    ordered.map((e) => (e.result.description || '').trim()).find(Boolean) ||
    '';

  const hashSeed = ordered
    .map((e) => `${e.frameId ?? 0}:${e.result.contentHash || ''}`)
    .join('|');

  return {
    kind: 'ready',
    url: topEntry.result.url || ordered[0].result.url || '',
    title: topEntry.result.title || ordered[0].result.title || '',
    lang: topEntry.result.lang || ordered[0].result.lang || '',
    description,
    selection,
    text,
    totalChars: rawTotalChars,
    truncated,
    questionCandidates: mergedCandidates,
    mediaSummary: {
      imageCount,
      canvasCount,
      svgCount,
      visualHints,
      visualImages,
      hasVisualContent: imageCount > 0 || canvasCount > 0 || svgCount > 0 || visualImages.length > 0,
    },
    contentHash: fnv1aHex(hashSeed),
    scannedAt: Date.now(),
    frameIds: ordered.map((e) => e.frameId ?? 0),
  };
}

/**
 * Merges `highlightAnswers` / `applyAnswers` / `clearHighlights` results across frames.
 * @param {string} command
 * @param {Array<{frameId?: number, result?: any}>} frameResults
 * @param {Array<any>} [items=[]]
 * @returns {any}
 */
export function mergeFrameActionResults(command, frameResults = [], items = []) {
  const valid = (Array.isArray(frameResults) ? frameResults : []).filter(
    (entry) => entry && entry.result && typeof entry.result === 'object'
  );
  if (valid.length === 0) return { ok: false };
  if (valid.length === 1) {
    return {
      ...valid[0].result,
      matchedFrameIds: [valid[0].frameId ?? 0],
    };
  }

  if (command === 'clearHighlights') {
    return { ok: valid.some((e) => e.result.ok !== false) };
  }

  if (command === 'highlightAnswers') {
    const byIndex = new Map();
    const matchedFrameIds = [];

    for (const entry of valid) {
      if ((entry.result.matchedQuestions || 0) > 0) {
        matchedFrameIds.push(entry.frameId ?? 0);
      }
      for (const detail of entry.result.details || []) {
        const key = detail.index;
        const prev = byIndex.get(key);
        if (!prev || (!prev.matched && detail.matched)) {
          byIndex.set(key, { ...detail });
        }
      }
    }

    const expectedIndices = items.length
      ? items.map((item, idx) => item.index ?? idx + 1)
      : [...byIndex.keys()];
    const details = expectedIndices.map(
      (idx) => byIndex.get(idx) || { index: idx, matched: false, controlCount: 0, rangeCount: 0 }
    );
    const matchedQuestions = details.filter((d) => d.matched).length;

    return {
      ok: valid.some((e) => e.result.ok !== false),
      highlightedCount: matchedQuestions,
      matchedQuestions,
      totalQuestions: expectedIndices.length || details.length,
      details,
      matchedFrameIds,
    };
  }

  if (command === 'applyAnswers') {
    const byIndex = new Map();
    const matchedFrameIds = [];

    for (const entry of valid) {
      if ((entry.result.appliedCount || 0) > 0) {
        matchedFrameIds.push(entry.frameId ?? 0);
      }
      for (const r of entry.result.results || []) {
        const key = r.index;
        const prev = byIndex.get(key);
        if (!prev || (prev.status !== 'applied' && r.status === 'applied')) {
          byIndex.set(key, { ...r });
        }
      }
    }

    const expectedIndices = items.length
      ? items.map((item, idx) => item.index ?? idx + 1)
      : [...byIndex.keys()];
    const results = expectedIndices.map(
      (idx) => byIndex.get(idx) || { index: idx, status: 'skipped' }
    );
    const appliedCount = results.filter((r) => r.status === 'applied').length;

    return {
      ok: valid.some((e) => e.result.ok !== false),
      appliedCount,
      skippedCount: results.length - appliedCount,
      totalQuestions: results.length,
      results,
      matchedFrameIds,
    };
  }

  return valid[0].result;
}
