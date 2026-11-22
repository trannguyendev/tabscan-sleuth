/**
 * TabScan Q&A - Token Optimizer & DOM Pruner
 * Utilities for pruning DOM context, semantic text truncation, token estimation,
 * and selective screenshot attachment.
 */

const BOILERPLATE_SELECTORS = [
  'nav',
  'footer',
  'aside',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.ad',
  '.advertisement',
  '[class*="advertisement"]',
  '.cookie-banner',
  '[id*="cookie-banner"]',
  '[id*="cookie-consent"]',
  '[class*="cookie-consent"]',
].join(', ');

const VISUAL_QUERY_RE = /\b(image|diagram|chart|figure|visual|picture|color|screenshot|layout|graph|photo|illustration|drawing|icon|logo)s?\b/i;
const VISUAL_HINT_RE = /\b(look|see|display|shown|below|above|where|diagram|image|canvas|chart|ui|element|view)s?\b/i;

/**
 * Estimates token count for raw text (~4 characters per token).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const str = typeof text === 'string' ? text : String(text || '');
  return Math.ceil(str.length / 4);
}

/**
 * Collapses redundant whitespace and performs smart semantic truncation
 * at paragraph or sentence boundaries.
 *
 * @param {string} rawText
 * @param {object} [options]
 * @param {number} [options.maxChars=36000]
 * @param {boolean} [options.collapseWhitespace=true]
 * @param {boolean} [options.preserveLineBreaks=true]
 * @returns {{ text: string, originalChars: number, prunedChars: number, tokensSavedEst: number }}
 */
export function prunePageText(rawText, options = {}) {
  const {
    maxChars = 36000,
    collapseWhitespace = true,
    preserveLineBreaks = true,
  } = options;

  const originalStr = typeof rawText === 'string' ? rawText : String(rawText || '');
  const originalChars = originalStr.length;
  if (!originalChars) {
    return {
      text: '',
      originalChars: 0,
      prunedChars: 0,
      tokensSavedEst: 0,
    };
  }

  let text = originalStr;

  if (collapseWhitespace) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (preserveLineBreaks) {
      text = text.replace(/[ \t]+\n/g, '\n');
      text = text.replace(/\n[ \t]+/g, '\n');
      text = text.replace(/[ \t]+/g, ' ');
      text = text.replace(/\n{3,}/g, '\n\n');
    } else {
      text = text.replace(/\s+/g, ' ');
    }
    text = text.trim();
  }

  if (text.length > maxChars) {
    const minRetain = Math.floor(maxChars * 0.85);
    let cutIndex = -1;

    // 1. Try paragraph boundary
    const pIdx = text.lastIndexOf('\n\n', maxChars);
    if (pIdx >= minRetain) {
      cutIndex = pIdx;
    } else {
      // 2. Try single newline boundary
      const nIdx = text.lastIndexOf('\n', maxChars);
      if (nIdx >= minRetain) {
        cutIndex = nIdx;
      } else {
        // 3. Try sentence boundary (. , ? , ! )
        const slice = text.slice(0, maxChars);
        const match = slice.match(/.*[.?!]["']?(?=\s|$)/s);
        if (match && match[0].length >= minRetain) {
          cutIndex = match[0].length;
        } else {
          cutIndex = maxChars;
        }
      }
    }

    text = text.slice(0, cutIndex).trim();
  }

  const prunedChars = text.length;
  const tokensSavedEst = Math.max(0, Math.ceil((originalChars - prunedChars) / 4));

  return {
    text,
    originalChars,
    prunedChars,
    tokensSavedEst,
  };
}

/**
 * Checks if a DOM element contains protected interactive quiz content,
 * form inputs, ARIA choices, drag-and-drop elements, or user selection.
 * @param {Element} el
 * @returns {boolean}
 */
function isProtectedElement(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName ? el.tagName.toUpperCase() : '';

  if (
    tag === 'FIELDSET' ||
    tag === 'LEGEND' ||
    tag === 'INPUT' ||
    tag === 'SELECT' ||
    tag === 'TEXTAREA' ||
    tag === 'BUTTON' ||
    tag === 'FORM' ||
    tag === 'MAIN'
  ) {
    return true;
  }

  const role = (el.getAttribute?.('role') || '').toLowerCase();
  if (
    role === 'radiogroup' ||
    role === 'radio' ||
    role === 'listitem' ||
    role === 'main'
  ) {
    return true;
  }

  if (
    el.getAttribute?.('draggable') === 'true' ||
    el.getAttribute?.('data-tabscan-badge') === 'true'
  ) {
    return true;
  }

  const hasProtectedChild = el.querySelector?.(
    'fieldset, legend, input, select, textarea, button, form, [role="radiogroup"], [role="radio"], [role="listitem"], [draggable="true"], .ui-draggable, [data-droppable], [data-dropzone], [aria-dropeffect], mark'
  );
  if (hasProtectedChild) return true;

  // Protect active user selection
  const activeSel =
    typeof window !== 'undefined' &&
    typeof window.getSelection === 'function' &&
    window.getSelection()?.toString()?.trim();
  if (
    activeSel &&
    activeSel.length >= 3 &&
    (el.innerText ?? el.textContent ?? '').includes(activeSel.slice(0, 30))
  ) {
    return true;
  }

  return false;
}

/**
 * Traverses elements in rootElement and removes boilerplate tags (nav, footer, .ad, cookie banners)
 * while strictly protecting fieldsets, quiz questions, forms, inputs, ARIA radiogroups, and selection.
 *
 * @param {Element} rootElement
 * @returns {number} Count of stripped boilerplate elements
 */
export function stripBoilerplateSelectors(rootElement) {
  if (!rootElement || typeof rootElement.querySelectorAll !== 'function') {
    return 0;
  }

  let strippedCount = 0;
  const candidates = rootElement.querySelectorAll(BOILERPLATE_SELECTORS) || [];

  for (const candidate of candidates) {
    if (!isProtectedElement(candidate)) {
      if (typeof candidate.remove === 'function') {
        candidate.remove();
        strippedCount++;
      } else if (candidate.parentNode && typeof candidate.parentNode.removeChild === 'function') {
        candidate.parentNode.removeChild(candidate);
        strippedCount++;
      }
    }
  }

  return strippedCount;
}

/**
 * Determines whether screenshots should be attached for an active tab query.
 * Standard text Q&A with rich text avoids attaching 4-6 full-page scroll screenshot tiles.
 *
 * @param {object} snapshot
 * @param {string} [query='']
 * @returns {boolean}
 */
export function shouldAttachScreenshots(snapshot, query = '') {
  if (!snapshot) return false;
  if (snapshot.kind === 'visual_only') return true;

  const text = (snapshot.text || '').trim();
  if (text.length < 150) return true;

  const q = typeof query === 'string' ? query : '';
  if (VISUAL_QUERY_RE.test(q)) return true;
  if (snapshot.mediaSummary?.hasVisualContent && VISUAL_HINT_RE.test(q)) return true;

  return false;
}
