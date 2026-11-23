(() => {
  const SCRIPT_VERSION = 4;
  const HIGHLIGHT_NAME = 'tabscan-answer';
  const HIGHLIGHT_CLASS = 'tabscan-ext-answer-highlight';
  const APPLIED_CLASS = 'tabscan-ext-answer-applied';
  const PAIR_CLASSES = [
    'tabscan-ext-pair-0',
    'tabscan-ext-pair-1',
    'tabscan-ext-pair-2',
    'tabscan-ext-pair-3',
    'tabscan-ext-pair-4',
    'tabscan-ext-pair-5',
  ];
  const BADGE_ATTR = 'data-tabscan-badge';
  const MARK_ATTR = 'data-tabscan-mark';
  const SKIP_WALK_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const FORM_CONTROLS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
  const DROPZONE_TEXT_RE =
    /^[^\p{L}\p{N}]*(?:drag\s*(?:an?\s*)?item\s*here|drag\s*(?:and\s*)?drop\s*here|drop\s*(?:item\s*)?here|place\s*(?:item\s*)?here|move\s*here)[^\p{L}\p{N}]*$/iu;
  const DROPZONE_CLASS_RE =
    /\b(drop[-_]?zone|droppable|ui-droppable|drop[-_]?target|drop[-_]?box|drag[-_]?here|cloze[-_]?(blank|gap|slot)|dnd[-_]?(target|drop|zone|box|slot)|target[-_]?box)\b/i;
  const DRAGGABLE_CLASS_RE =
    /\b(ui-draggable|draggable|drag[-_]?item|word[-_]?chip|chip|tile|token|dnd[-_]?(item|chip)|palette[-_]?item|word[-_]?item)\b/i;
  const CARD_STOP_PARENTS = new Set([
    'HTML',
    'BODY',
    'MAIN',
    'SECTION',
    'ARTICLE',
    'FORM',
    'FIELDSET',
    'UL',
    'OL',
    'TABLE',
    'THEAD',
    'TBODY',
    'TFOOT',
    'TR',
  ]);
  const UNSAFE_COMMAND_RE =
    /^\s*(?:submit|send|next|prev|previous|back|finish|complete|save|delete|remove|reset|clear|buy|purchase|checkout|pay|confirm|log\s*in|sign\s*in|sign\s*up)(?:\s+(?:quiz|form|test|exam|page|step|now|all|changes|answers?|(?:and|&)\s+\w+))?\s*[›»→<>]*\s*$/i;

  function normalizeTypographicChars(str) {
    return (str || '')
      .replace(/[\u2018\u2019\u02BC]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014\u2212]/g, '-')
      .replace(/\u00A0/g, ' ');
  }

  function cleanText(str) {
    return normalizeTypographicChars(str).replace(/\s+/g, ' ').trim();
  }

  function normalizeText(str) {
    return cleanText(str).toLowerCase();
  }

  function stripOptionPrefix(str) {
    return normalizeText(str).replace(/^(?:\(?[a-z0-9]{1,2}\)?[.):\-\s]+)+/i, '').trim();
  }

  function stripQuestionPrefix(str) {
    return normalizeText(str)
      .replace(/^(?:question\s*\d+[\s.:)-]*|q\s*\d+[\s.:)-]*|\(?[a-z0-9]{1,2}\)?[.):\-\s]+)+/i, '')
      .trim();
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function hasWordBoundaryMatch(longerStr, shorterStr) {
    if (!shorterStr) return false;
    const pattern = new RegExp(
      `(?:^|[\\s(,.;:!?/\\-])${escapeRegExp(shorterStr)}(?=$|[\\s),.;:!?/\\-])`
    );
    return pattern.test(longerStr);
  }

  function tokenize(str) {
    return normalizeText(str)
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  }

  function truncateLabel(str, maxLen = 18) {
    const cleaned = cleanText(str);
    if (cleaned.length <= maxLen) return cleaned;
    return `${cleaned.slice(0, maxLen - 1).trimEnd()}…`;
  }

  function sleep(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isElementHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return true;
    try {
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const s = window.getComputedStyle(el);
        if (s && (s.display === 'none' || s.visibility === 'hidden')) return true;
      }
    } catch {
      // Ignore computed-style errors.
    }
    return false;
  }

  function getVisibleTextExcludingBadges(el) {
    if (!el) return '';
    const clone = typeof el.cloneNode === 'function' ? el.cloneNode(true) : null;
    if (clone && typeof clone.querySelectorAll === 'function') {
      for (const b of clone.querySelectorAll(`[${BADGE_ATTR}="true"]`)) {
        b.remove?.() ?? b.parentNode?.removeChild?.(b);
      }
      return cleanText(clone.textContent || '');
    }
    return cleanText(el.textContent || '');
  }

  /**
   * Scores how strongly `candidate` matches `target` (0 = no match, 1000 = exact).
   */
  function scoreTextMatch(candidate, target) {
    const cNorm = normalizeText(candidate);
    const tNorm = normalizeText(target);
    if (!cNorm || !tNorm) return 0;
    if (cNorm === tNorm) return 1000;

    const cStripped = stripOptionPrefix(candidate) || cNorm;
    const tStripped = stripOptionPrefix(target) || tNorm;
    if (cStripped && tStripped && cStripped === tStripped) return 900;

    // Explicit short option-letter match (e.g., target "B" matching "B. 429 Too Many Requests")
    if (/^[a-z0-9]{1,2}$/i.test(tNorm)) {
      const explicitPrefixRe = new RegExp(`^(?:option\\s*)?\\(?${escapeRegExp(tNorm)}\\)?[.):\\-\\s]+`, 'i');
      if (explicitPrefixRe.test(cNorm)) return 700;
      return 0;
    }

    // Strict word-boundary containment so "read" does not falsely match "read and write"
    if (tStripped.length >= 4 && cStripped.length >= 4) {
      const shorterStr = tStripped.length <= cStripped.length ? tStripped : cStripped;
      const longerStr = tStripped.length <= cStripped.length ? cStripped : tStripped;
      const ratio = shorterStr.length / longerStr.length;
      if (ratio >= 0.65 && hasWordBoundaryMatch(longerStr, shorterStr)) {
        return Math.round(350 + ratio * 350);
      }
    }

    return 0;
  }

  function getBestTargetScore(candidate, targets) {
    let bestScore = 0;
    let bestIndex = targets.length;
    for (let idx = 0; idx < targets.length; idx++) {
      const score = scoreTextMatch(candidate, targets[idx]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }
    return { score: bestScore, targetIndex: bestIndex };
  }

  function isTextMatch(candidate, target) {
    return scoreTextMatch(candidate, target) > 0;
  }

  function getChoiceTargets(item) {
    const isMulti = item.question_type === 'multi_select';
    const targets = [];
    const seen = new Set();
    const pushTarget = (val) => {
      const cleaned = cleanText(val);
      if (!cleaned) return;
      const key = cleaned.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(cleaned);
      }
    };

    if (Array.isArray(item.selected_options) && item.selected_options.length > 0) {
      const list = isMulti ? item.selected_options : [item.selected_options[0]];
      for (const opt of list) pushTarget(opt);
      return targets;
    }

    if (Array.isArray(item.options) && item.options.length > 0) {
      const answerStr = cleanText(item.answer || '');
      if (isMulti) {
        const answerParts = answerStr
          .split(/\n|;|•|\|/)
          .map((p) => p.trim())
          .filter(Boolean);
        for (const opt of item.options) {
          if (
            scoreTextMatch(opt, answerStr) > 0 ||
            answerParts.some((part) => scoreTextMatch(opt, part) > 0)
          ) {
            pushTarget(opt);
          }
        }
      } else if (answerStr) {
        // Single-choice: choose strictly the ONE highest-scoring option
        let bestOpt = '';
        let bestScore = 0;
        for (const opt of item.options) {
          const score = scoreTextMatch(opt, answerStr);
          if (score > bestScore) {
            bestScore = score;
            bestOpt = opt;
          }
        }
        if (bestOpt) pushTarget(bestOpt);
      }
    }

    if (targets.length === 0) {
      if (item.apply_value) pushTarget(item.apply_value);
      else if (item.answer) pushTarget(item.answer);
    }
    return targets;
  }

  function extractMatchingPairs(item) {
    const rawPairs = [];
    if (Array.isArray(item.matching_pairs) && item.matching_pairs.length > 0) {
      for (const p of item.matching_pairs) {
        const left = cleanText(p?.left);
        const right = cleanText(p?.right);
        if (left && right) rawPairs.push({ left, right });
      }
    }

    if (rawPairs.length === 0 && item.question_type === 'matching' && item.answer) {
      const lines = String(item.answer)
        .split(/\r?\n|;/)
        .map((line) => line.replace(/^\s*(?:[-*•]|\(?\d+\)?[.)])\s*/, '').trim())
        .filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^(.+?)\s*(?:->|→|=>|<->|—|–|=)\s*(.+)$/);
        if (match) {
          const left = cleanText(match[1]);
          const right = cleanText(match[2]);
          if (left && right) rawPairs.push({ left, right });
        }
      }
    }

    return rawPairs;
  }

  function getControlLabelText(ctrl) {
    if (!ctrl) return '';
    const ariaLabel = ctrl.getAttribute?.('aria-label');
    if (ariaLabel && cleanText(ariaLabel)) return cleanText(ariaLabel);

    const labelledBy = ctrl.getAttribute?.('aria-labelledby');
    if (labelledBy && typeof document.getElementById === 'function') {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => getVisibleTextExcludingBadges(document.getElementById(id)))
        .filter(Boolean)
        .join(' ');
      if (joined) return joined;
    }

    if (ctrl.id && typeof document.querySelector === 'function') {
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(ctrl.id) : ctrl.id;
      const explicitLabel = document.querySelector(`label[for="${escaped}"]`);
      if (explicitLabel) return getVisibleTextExcludingBadges(explicitLabel);
    }

    const parentLabel = ctrl.closest?.('label');
    if (parentLabel) return getVisibleTextExcludingBadges(parentLabel);

    const placeholder = ctrl.getAttribute?.('placeholder');
    if (placeholder && cleanText(placeholder)) return cleanText(placeholder);

    const dataVal = ctrl.getAttribute?.('data-value');
    if (dataVal && cleanText(dataVal) && !ctrl.textContent) return cleanText(dataVal);

    if (FORM_CONTROLS.has(ctrl.tagName) && ctrl.parentElement) {
      const parentText = getVisibleTextExcludingBadges(ctrl.parentElement);
      if (parentText && parentText.length <= 240) return parentText;
    }

    return getVisibleTextExcludingBadges(ctrl);
  }

  function getVisualRowTarget(ctrl) {
    if (!ctrl) return null;
    if (!FORM_CONTROLS.has(ctrl.tagName)) return ctrl;
    const label =
      (ctrl.id &&
        typeof document.querySelector === 'function' &&
        document.querySelector(
          `label[for="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(ctrl.id) : ctrl.id}"]`
        )) ||
      ctrl.closest?.('label');
    if (label && !isElementHidden(label)) return label;
    return ctrl;
  }

  function cleanQuestionForTokens(str) {
    return cleanText(str)
      .replace(/\[blank(?::[^\]]*)?\]/gi, ' ')
      .replace(/\b(?:drag\s*(?:an?\s*)?item\s*here|drop\s*(?:item\s*)?here)\b/gi, ' ')
      .replace(/_{3,}|\.{3,}/g, ' ');
  }

  function findQuestionContainer(questionText) {
    const rawQ = cleanText(questionText);
    const qNorm = normalizeText(rawQ);
    const qStripped = stripQuestionPrefix(cleanQuestionForTokens(rawQ) || rawQ);
    const qTokens = tokenize(qStripped || qNorm);
    if (!qNorm || qTokens.length === 0 || !document.body) return null;

    const candidates = document.body.querySelectorAll(
      'fieldset, [role="listitem"], [role="radiogroup"], details, section, article, form, tr, li, p, div'
    );

    let bestEl = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (el === document.body || el === document.documentElement) continue;
      if (isElementHidden(el)) continue;

      const text = getVisibleTextExcludingBadges(el);
      if (!text || text.length < Math.min(8, qNorm.length)) continue;
      if (text.length > 6000) continue;

      const textNorm = normalizeText(cleanQuestionForTokens(text));
      let score = 0;

      if (textNorm.includes(qNorm) || (qStripped.length >= 6 && textNorm.includes(qStripped))) {
        score += textNorm.includes(qNorm) ? 120 : 105;
      } else {
        const textSet = new Set(tokenize(cleanQuestionForTokens(text)));
        let hits = 0;
        for (const tok of qTokens) {
          if (textSet.has(tok)) hits++;
        }
        const coverage = hits / qTokens.length;
        if (coverage < 0.65 || hits < Math.min(2, qTokens.length)) continue;
        score += Math.round(coverage * 85);
      }

      const hasControls = Boolean(
        el.querySelector(
          'input, select, textarea, [role="radio"], [role="checkbox"], [role="option"]'
        )
      );
      const hasBlank = hasDropzoneInside(el);
      if (hasControls || hasBlank) score += 25;
      if (['FIELDSET', 'DETAILS'].includes(el.tagName)) score += 15;
      const role = el.getAttribute?.('role');
      if (role === 'listitem' || role === 'radiogroup') score += 15;

      const lengthPenalty = Math.min(45, Math.floor(text.length / 80));
      score -= lengthPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }

    return bestScore >= 60 ? bestEl : null;
  }

  function findMatchingScope(item, pairs) {
    if (!document.body || pairs.length === 0) return document.body;

    const existing = findQuestionContainer(item.question);
    const countMatchedPairs = (el) => {
      const txt = normalizeText(getVisibleTextExcludingBadges(el));
      if (!txt) return 0;
      let count = 0;
      for (const p of pairs) {
        const hasL = txt.includes(normalizeText(p.left));
        const hasR = txt.includes(normalizeText(p.right));
        if (hasL && hasR) count++;
      }
      return count;
    };

    if (existing && countMatchedPairs(existing) >= Math.min(2, pairs.length)) {
      return existing;
    }

    let bestEl = document.body;
    let bestHits = 0;
    let bestLen = Infinity;

    for (const el of document.body.querySelectorAll('section, article, form, fieldset, table, main, div')) {
      if (el === document.body || el === document.documentElement || isElementHidden(el)) continue;
      const vis = getVisibleTextExcludingBadges(el);
      if (!vis || vis.length > 25000) continue;
      const hits = countMatchedPairs(el);
      if (hits > bestHits || (hits === bestHits && hits > 0 && vis.length < bestLen)) {
        bestHits = hits;
        bestLen = vis.length;
        bestEl = el;
      }
    }

    return bestHits > 0 ? bestEl : existing || document.body;
  }

  function attachBadge(targetEl, labelText, variant = 'highlight', pairSlot = null) {
    if (!targetEl || !document.createElement) return;
    const host = targetEl.parentNode;

    const applyBadgeAttrs = (badge) => {
      badge.textContent = labelText;
      badge.setAttribute('data-variant', variant);
      if (pairSlot !== null && pairSlot !== undefined) {
        badge.setAttribute('data-pair-slot', String(pairSlot));
      } else {
        badge.removeAttribute?.('data-pair-slot');
      }
    };

    const existingInside =
      !FORM_CONTROLS.has(targetEl.tagName) &&
      targetEl.querySelector?.(`[${BADGE_ATTR}="true"]`);
    if (existingInside) {
      applyBadgeAttrs(existingInside);
      return;
    }
    if (
      targetEl.nextSibling?.nodeType === 1 &&
      targetEl.nextSibling.getAttribute?.(BADGE_ATTR) === 'true'
    ) {
      applyBadgeAttrs(targetEl.nextSibling);
      return;
    }

    const badge = document.createElement('span');
    badge.className = 'tabscan-ext-badge';
    badge.setAttribute(BADGE_ATTR, 'true');
    applyBadgeAttrs(badge);

    if (!FORM_CONTROLS.has(targetEl.tagName)) {
      targetEl.appendChild(badge);
    } else if (host) {
      host.insertBefore(badge, targetEl.nextSibling || null);
    }
  }

  function markElement(el, className, badgeText, variant = 'highlight', opts = {}) {
    if (!el) return;
    el.classList?.remove(className === APPLIED_CLASS ? HIGHLIGHT_CLASS : APPLIED_CLASS);
    el.classList?.add(className);
    if (opts.extraClass) {
      for (const pc of PAIR_CLASSES) {
        if (pc !== opts.extraClass) el.classList?.remove(pc);
      }
      el.classList?.add(opts.extraClass);
    }
    attachBadge(el, badgeText, variant, opts.pairSlot ?? null);
  }

  function safeScrollIntoView(el) {
    try {
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (el?.startContainer?.parentElement?.scrollIntoView) {
        el.startContainer.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch {
      // Ignore scroll errors in restricted/mock environments.
    }
  }

  const BLOCK_BOUNDARY_TAGS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'BR',
    'DD',
    'DETAILS',
    'DIALOG',
    'DIV',
    'DL',
    'DT',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HGROUP',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'SUMMARY',
    'TABLE',
    'TD',
    'TH',
    'TR',
    'UL',
  ]);
  const INLINE_TOKEN_CLASS_RE =
    /\b(word|token|phrase|chunk|segment|clickable|selectable|tappable|underline|highlightable)\b/i;

  function mapNormalizedChar(ch) {
    if (ch === '\u2018' || ch === '\u2019' || ch === '\u02BC') return "'";
    if (ch === '\u201C' || ch === '\u201D') return '"';
    if (ch === '\u2013' || ch === '\u2014' || ch === '\u2212') return '-';
    if (/\s|\u00A0/.test(ch)) return ' ';
    return ch.toLowerCase();
  }

  function isSeparateWordTokenElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = el.getAttribute?.('class') || '';
    if (INLINE_TOKEN_CLASS_RE.test(cls) || DRAGGABLE_CLASS_RE.test(cls)) return true;
    const role = el.getAttribute?.('role');
    return role === 'button' || Boolean(el.getAttribute?.('onclick'));
  }

  function buildVirtualTextStream(root) {
    const target = root || document.body;
    const chars = [];
    const map = [];
    if (!target) return { text: '', map };

    const pushSpace = () => {
      if (chars.length > 0 && chars[chars.length - 1] !== ' ') {
        chars.push(' ');
        map.push({ node: null, offset: -1 });
      }
    };

    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const raw = node.textContent || '';
        for (let idx = 0; idx < raw.length; idx++) {
          const mapped = mapNormalizedChar(raw[idx]);
          if (mapped === ' ') {
            pushSpace();
          } else {
            chars.push(mapped);
            map.push({ node, offset: idx });
          }
        }
        return;
      }

      if (node.nodeType !== 1) return;
      if (SKIP_WALK_TAGS.has(node.tagName) || FORM_CONTROLS.has(node.tagName)) return;
      if (
        node.getAttribute?.(BADGE_ATTR) === 'true' ||
        node.classList?.contains?.(HIGHLIGHT_CLASS) ||
        node.classList?.contains?.(APPLIED_CLASS) ||
        isElementHidden(node)
      ) {
        return;
      }

      const isBlock = BLOCK_BOUNDARY_TAGS.has(node.tagName);
      if (isBlock) pushSpace();

      const prevEl = node.previousElementSibling;
      if (!isBlock && prevEl && isSeparateWordTokenElement(node) && isSeparateWordTokenElement(prevEl)) {
        pushSpace();
      }

      for (const child of node.childNodes || []) {
        walk(child);
      }

      if (isBlock) pushSpace();
    };

    walk(target);
    return { text: chars.join(''), map };
  }

  function collectTextNodes(root) {
    const target = root || document.body;
    if (!target) return [];

    if (typeof document.createTreeWalker === 'function' && typeof NodeFilter !== 'undefined') {
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let current = walker.nextNode();
      while (current) {
        const parent = current.parentNode;
        const alreadyMarkedControl = Boolean(
          parent?.closest?.(`.${HIGHLIGHT_CLASS}, .${APPLIED_CLASS}`)
        );
        const skip =
          !parent ||
          SKIP_WALK_TAGS.has(parent.tagName) ||
          parent.getAttribute?.(BADGE_ATTR) === 'true' ||
          alreadyMarkedControl ||
          isElementHidden(parent);
        if (!skip && cleanText(current.textContent)) {
          nodes.push(current);
        }
        current = walker.nextNode();
      }
      return nodes;
    }

    const nodes = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        if (cleanText(node.textContent)) nodes.push(node);
        return;
      }
      if (node.nodeType !== 1) return;
      if (SKIP_WALK_TAGS.has(node.tagName)) return;
      if (
        node.getAttribute?.(BADGE_ATTR) === 'true' ||
        node.classList?.contains?.(HIGHLIGHT_CLASS) ||
        node.classList?.contains?.(APPLIED_CLASS) ||
        isElementHidden(node)
      ) {
        return;
      }
      for (const child of node.childNodes || []) {
        walk(child);
      }
    };
    walk(target);
    return nodes;
  }

  function makeTextRangeObj(textNode, startOffset, endOffset) {
    if (typeof Range === 'function') {
      const range = new Range();
      range.setStart(textNode, startOffset);
      range.setEnd(textNode, endOffset);
      return range;
    }
    return { textNode, startOffset, endOffset };
  }

  function hasVirtualWordBoundary(text, startIdx, endIdx, candidate) {
    if (candidate.length > 14) return true;
    const isWordChar = (ch) => Boolean(ch && /[\p{L}\p{N}]/u.test(ch));
    if (isWordChar(candidate[0]) && isWordChar(text[startIdx - 1])) return false;
    if (isWordChar(candidate[candidate.length - 1]) && isWordChar(text[endIdx])) return false;
    return true;
  }

  function findTextRangesInRoot(root, searchPhrases, maxRanges = Infinity) {
    const ranges = [];
    const cleaned = (searchPhrases || [])
      .map((p) => cleanText(p))
      .filter((p) => p.length >= 2 && p.length <= 240);
    if (cleaned.length === 0) return ranges;

    const virtual = buildVirtualTextStream(root);
    if (!virtual.text) return ranges;

    const minStandaloneLen = root && root !== document.body ? 2 : 3;
    const claimed = [];
    let matchedPhrases = 0;

    for (const phrase of cleaned) {
      if (matchedPhrases >= maxRanges) break;

      const rawNorm = normalizeText(phrase);
      const strippedNorm = rawNorm
        .replace(/^[,;:.!?'"()\[\]\-\s]+|[,;:.!?'"()\[\]\-\s]+$/g, '')
        .trim();
      const candidates = [rawNorm];
      if (strippedNorm && strippedNorm !== rawNorm) {
        candidates.push(strippedNorm);
      }

      let phraseMatched = false;
      for (const candidate of candidates) {
        if (candidate.length < minStandaloneLen) continue;
        let searchFrom = 0;
        while (searchFrom < virtual.text.length) {
          const hitIdx = virtual.text.indexOf(candidate, searchFrom);
          if (hitIdx === -1) break;
          const hitEnd = hitIdx + candidate.length;
          const overlaps = claimed.some(([s, e]) => hitIdx < e && hitEnd > s);
          if (overlaps || !hasVirtualWordBoundary(virtual.text, hitIdx, hitEnd, candidate)) {
            searchFrom = hitIdx + 1;
            continue;
          }

          claimed.push([hitIdx, hitEnd]);
          const segs = [];
          let cur = null;
          for (let k = hitIdx; k < hitEnd; k++) {
            const entry = virtual.map[k];
            if (!entry || !entry.node) continue;
            if (!cur || cur.node !== entry.node) {
              if (cur) segs.push(cur);
              cur = { node: entry.node, start: entry.offset, end: entry.offset + 1 };
            } else {
              cur.end = Math.max(cur.end, entry.offset + 1);
            }
          }
          if (cur) segs.push(cur);

          for (const seg of segs) {
            ranges.push(makeTextRangeObj(seg.node, seg.start, seg.end));
          }
          if (segs.length > 0) {
            phraseMatched = true;
            matchedPhrases++;
          }
          break;
        }
        if (phraseMatched) break;
      }
    }

    return ranges;
  }

  function findTextRangesInNodes(textNodes, searchPhrases, maxRanges = Infinity) {
    const ranges = [];
    const normalizedPhrases = searchPhrases
      .map((p) => cleanText(p))
      .filter((p) => p.length >= 2 && p.length <= 240);
    if (normalizedPhrases.length === 0 || textNodes.length === 0) return ranges;

    let matchedPhrases = 0;
    for (const phrase of normalizedPhrases) {
      if (matchedPhrases >= maxRanges) break;
      const needle = normalizeText(phrase);
      let phraseMatched = false;
      for (const textNode of textNodes) {
        const raw = normalizeTypographicChars(textNode.textContent || '');
        const lower = raw.toLowerCase();
        const startIdx = lower.indexOf(needle);
        if (startIdx === -1) continue;
        ranges.push(makeTextRangeObj(textNode, startIdx, startIdx + needle.length));
        phraseMatched = true;
        matchedPhrases++;
        break;
      }
      if (phraseMatched && maxRanges <= 1) break;
    }
    return ranges;
  }

  function wrapMarkFallback(textNode, startOffset, endOffset) {
    return wrapMarkFallbackSlices(textNode, [{ start: startOffset, end: endOffset }])?.[0] || null;
  }

  function wrapMarkFallbackSlices(textNode, slices) {
    const text = textNode?.textContent || '';
    const parent = textNode?.parentNode;
    if (!parent || typeof document.createElement !== 'function' || !slices?.length) return [];

    const sorted = [...slices]
      .map((s) => ({
        start: Math.max(0, Math.min(text.length, s.start)),
        end: Math.max(0, Math.min(text.length, s.end)),
      }))
      .filter((s) => s.end > s.start)
      .sort((a, b) => a.start - b.start);
    if (sorted.length === 0) return [];

    const merged = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      if (sorted[i].start <= prev.end) {
        prev.end = Math.max(prev.end, sorted[i].end);
      } else {
        merged.push(sorted[i]);
      }
    }

    const parts = [];
    const marks = [];
    let cursor = 0;
    for (const seg of merged) {
      if (seg.start > cursor) {
        parts.push(document.createTextNode(text.slice(cursor, seg.start)));
      }
      const matchText = text.slice(seg.start, seg.end);
      const mark = document.createElement('mark');
      mark.className = 'tabscan-ext-mark';
      mark.setAttribute(MARK_ATTR, 'true');
      mark.textContent = matchText;
      parts.push(mark);
      marks.push(mark);
      cursor = seg.end;
    }
    if (cursor < text.length) {
      parts.push(document.createTextNode(text.slice(cursor)));
    }

    if (typeof textNode.replaceWith === 'function' && typeof document.createDocumentFragment === 'function') {
      const frag = document.createDocumentFragment();
      for (const node of parts) frag.appendChild(node);
      textNode.replaceWith(frag);
    } else if (parent.childNodes) {
      const childList = Array.from(parent.childNodes);
      const idx = childList.indexOf(textNode);
      if (idx !== -1 && typeof parent.childNodes.splice === 'function') {
        for (const n of parts) n.parentNode = parent;
        parent.childNodes.splice(idx, 1, ...parts);
      }
    }
    return marks;
  }

  function wrapMarkFallbackBatch(ranges) {
    const byNode = new Map();
    for (const r of ranges || []) {
      const textNode = r.textNode || (r.startContainer?.nodeType === 3 ? r.startContainer : null);
      if (!textNode) continue;
      const list = byNode.get(textNode) || [];
      list.push({ start: r.startOffset, end: r.endOffset });
      byNode.set(textNode, list);
    }
    for (const [textNode, slices] of byNode.entries()) {
      wrapMarkFallbackSlices(textNode, slices);
    }
  }

  function findMatchedControlsInScope(scopeRoot, targets) {
    const root = scopeRoot || document.body;
    if (!root || targets.length === 0) return [];

    const matched = [];
    const seen = new Set();

    // 1. Native radios & checkboxes
    for (const input of root.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (isElementHidden(input)) continue;
      const labelText = getControlLabelText(input);
      const labelMatch = getBestTargetScore(labelText, targets);
      const valueMatch = getBestTargetScore(input.value || '', targets);
      const best = labelMatch.score >= valueMatch.score ? labelMatch : valueMatch;
      if (best.score > 0 && !seen.has(input)) {
        seen.add(input);
        matched.push({
          kind: input.type,
          control: input,
          labelText,
          score: best.score,
          targetIndex: best.targetIndex,
        });
      }
    }

    // 2. ARIA quiz controls (Google Forms, custom quizzes)
    for (const ariaCtrl of root.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]')) {
      if (isElementHidden(ariaCtrl)) continue;
      // Avoid double-matching an ARIA wrapper around an already-matched native input
      const nestedInput = ariaCtrl.querySelector?.('input[type="radio"], input[type="checkbox"]');
      if (nestedInput && seen.has(nestedInput)) continue;

      const labelText = getControlLabelText(ariaCtrl);
      const best = getBestTargetScore(labelText, targets);
      if (best.score > 0 && !seen.has(ariaCtrl)) {
        seen.add(ariaCtrl);
        matched.push({
          kind: `aria-${ariaCtrl.getAttribute('role')}`,
          control: ariaCtrl,
          labelText,
          score: best.score,
          targetIndex: best.targetIndex,
        });
      }
    }

    // 3. <select> options
    for (const select of root.querySelectorAll('select')) {
      if (isElementHidden(select)) continue;
      const opts = [...select.querySelectorAll('option')];
      let bestOpt = null;
      let bestScore = 0;
      let bestTargetIdx = targets.length;
      for (const opt of opts) {
        const tm = getBestTargetScore(opt.textContent, targets);
        const vm = getBestTargetScore(opt.value || '', targets);
        const best = tm.score >= vm.score ? tm : vm;
        if (best.score > bestScore || (best.score === bestScore && best.targetIndex < bestTargetIdx)) {
          bestScore = best.score;
          bestTargetIdx = best.targetIndex;
          bestOpt = opt;
        }
      }
      if (bestOpt && !seen.has(select)) {
        seen.add(select);
        matched.push({
          kind: 'select',
          control: select,
          option: bestOpt,
          labelText: cleanText(bestOpt.textContent),
          score: bestScore,
          targetIndex: bestTargetIdx,
        });
      }
    }

    // 4. Safe clickable option buttons ONLY inside a confirmed question container
    if (matched.length === 0 && scopeRoot && scopeRoot !== document.body) {
      for (const btn of scopeRoot.querySelectorAll('button, [role="button"]')) {
        if (isElementHidden(btn)) continue;
        const typeAttr = (btn.getAttribute?.('type') || '').toLowerCase();
        if (typeAttr === 'submit' || typeAttr === 'reset') continue;
        const btnText = getVisibleTextExcludingBadges(btn);
        if (!btnText || UNSAFE_COMMAND_RE.test(btnText)) continue;
        const best = getBestTargetScore(btnText, targets);
        if (best.score > 0 && !seen.has(btn)) {
          seen.add(btn);
          matched.push({
            kind: 'button-option',
            control: btn,
            labelText: btnText,
            score: best.score,
            targetIndex: best.targetIndex,
          });
        }
      }
    }

    matched.sort((a, b) => b.score - a.score || a.targetIndex - b.targetIndex);
    return matched;
  }

  function isDomSingleChoiceOnly(controls) {
    return (
      controls.length > 0 &&
      controls.every(
        (c) =>
          c.kind === 'radio' ||
          c.kind === 'aria-radio' ||
          (c.kind === 'select' && !c.control.multiple)
      )
    );
  }

  function selectEffectiveControls(item, controls) {
    if (controls.length === 0) return [];
    const isMulti = item.question_type === 'multi_select' && !isDomSingleChoiceOnly(controls);
    return isMulti ? controls : [controls[0]];
  }

  function climbToCardRoot(el, root, targetText) {
    let cur = el;
    const baseLen = cleanText(getVisibleTextExcludingBadges(el)).length;

    while (
      cur?.parentElement &&
      cur.parentElement !== root &&
      cur.parentElement !== document.body &&
      cur.parentElement !== document.documentElement
    ) {
      const parent = cur.parentElement;
      if (CARD_STOP_PARENTS.has(parent.tagName)) break;
      const parentText = getVisibleTextExcludingBadges(parent);
      if (!parentText) break;
      if (parentText.length > baseLen + 12) break;
      if (scoreTextMatch(parentText, targetText) < 550) break;
      cur = parent;
    }
    return cur;
  }

  function isUnsafeElement(el) {
    if (!el) return true;
    const typeAttr = (el.getAttribute?.('type') || '').toLowerCase();
    if (typeAttr === 'submit' || typeAttr === 'reset') return true;
    const text = getVisibleTextExcludingBadges(el);
    return UNSAFE_COMMAND_RE.test(text);
  }

  function findMatchingCardCandidates(root, targetText) {
    if (!root || !cleanText(targetText)) return [];
    const targetLen = cleanText(targetText).length;
    const nodes = root.querySelectorAll(
      'button, [role="button"], [role="option"], [role="listitem"], li, td, th, a, label, div, span, p, strong, em, [tabindex]'
    );

    const candidateMap = new Map();
    for (const el of nodes) {
      if (el === root || el === document.body || el === document.documentElement) continue;
      if (el.getAttribute?.(BADGE_ATTR) === 'true' || isElementHidden(el)) continue;
      if (isUnsafeElement(el)) continue;

      const vis = getVisibleTextExcludingBadges(el);
      if (!vis || vis.length > targetLen * 1.45 + 14) continue;

      const score = scoreTextMatch(vis, targetText);
      if (score < 600) continue;

      const cardRoot = climbToCardRoot(el, root, targetText);
      if (!cardRoot || isUnsafeElement(cardRoot)) continue;

      const rootScore = scoreTextMatch(getVisibleTextExcludingBadges(cardRoot), targetText);
      const effectiveScore = Math.max(score, rootScore);
      const prev = candidateMap.get(cardRoot);
      if (!prev || effectiveScore > prev.score) {
        candidateMap.set(cardRoot, { el: cardRoot, score: effectiveScore });
      }
    }

    // Filter out inner leaf nodes if an ancestor card is already in candidateMap
    const entries = [...candidateMap.values()];
    return entries.filter(
      (entry) => !entries.some((other) => other.el !== entry.el && other.el.contains?.(entry.el))
    );
  }

  function getRectLeft(el) {
    try {
      const rect = el?.getBoundingClientRect?.();
      if (rect && (rect.width > 0 || rect.height > 0 || rect.left !== 0)) {
        return rect.left;
      }
    } catch {
      // Ignore rect failures.
    }
    return null;
  }

  function resolveMatchingPairElements(root, pairs) {
    const rightCounts = {};
    for (const p of pairs) {
      const rKey = cleanText(p?.right).toLowerCase();
      rightCounts[rKey] = (rightCounts[rKey] || 0) + 1;
    }

    const used = new Set();
    return pairs.map((pair, idx) => {
      const leftCands = findMatchingCardCandidates(root, pair.left);
      const rightCands = findMatchingCardCandidates(root, pair.right);
      const isMultiTarget = rightCounts[cleanText(pair.right).toLowerCase()] > 1;

      let bestPair = null;
      let bestScore = -Infinity;

      for (const lc of leftCands) {
        for (const rc of rightCands) {
          if (lc.el === rc.el) continue;
          let pairScore = lc.score + rc.score;
          if (used.has(lc.el)) pairScore -= 1500;
          if (!isMultiTarget && used.has(rc.el)) pairScore -= 1500;

          const lx = getRectLeft(lc.el);
          const rx = getRectLeft(rc.el);
          if (lx !== null && rx !== null) {
            pairScore += lx < rx ? 250 : -150;
          }

          if (pairScore > bestScore) {
            bestScore = pairScore;
            bestPair = { leftEl: lc.el, rightEl: rc.el };
          }
        }
      }

      if (!bestPair) {
        const leftOnly = leftCands.find((c) => !used.has(c.el)) || leftCands[0] || null;
        const rightOnly =
          rightCands.find((c) => c.el !== leftOnly?.el && (isMultiTarget || !used.has(c.el))) ||
          rightCands.find((c) => c.el !== leftOnly?.el) ||
          null;
        bestPair = {
          leftEl: leftOnly?.el || null,
          rightEl: rightOnly?.el || null,
        };
      }

      if (bestPair.leftEl) used.add(bestPair.leftEl);
      if (!isMultiTarget && bestPair.rightEl) used.add(bestPair.rightEl);

      return {
        index: idx,
        left: pair.left,
        right: pair.right,
        leftEl: bestPair.leftEl,
        rightEl: bestPair.rightEl,
      };
    });
  }

  function hasActiveMarkerClass(el) {
    const cls = (el?.className || '').split(/\s+/).filter(Boolean);
    return cls.some((c) => /^(selected|active|is-selected|matched|paired|connected)$/i.test(c));
  }

  function isCardPendingSelected(el) {
    if (!el) return false;
    return (
      el.getAttribute?.('aria-selected') === 'true' ||
      el.getAttribute?.('aria-pressed') === 'true' ||
      el.getAttribute?.('data-selected') === 'true' ||
      el.getAttribute?.('data-matched') === 'true' ||
      hasActiveMarkerClass(el)
    );
  }

  function isPairAlreadyConnected(leftEl, rightEl) {
    if (!leftEl || !rightEl) return false;
    if (
      leftEl.disabled ||
      rightEl.disabled ||
      leftEl.getAttribute?.('aria-disabled') === 'true' ||
      rightEl.getAttribute?.('aria-disabled') === 'true'
    ) {
      return true;
    }
    return isCardPendingSelected(leftEl) && isCardPendingSelected(rightEl);
  }

  function activateInteractiveElement(el) {
    if (!el) return;
    el.focus?.();

    let cx = 0;
    let cy = 0;
    try {
      const r = el.getBoundingClientRect?.();
      if (r && (r.width || r.height)) {
        cx = Math.round(r.left + r.width / 2);
        cy = Math.round(r.top + r.height / 2);
      }
    } catch {
      // Ignore rect failures.
    }

    const evtOpts = {
      bubbles: true,
      cancelable: true,
      view: typeof window !== 'undefined' ? window : undefined,
      button: 0,
      buttons: 1,
      clientX: cx,
      clientY: cy,
    };

    if (typeof PointerEvent === 'function') {
      el.dispatchEvent?.(
        new PointerEvent('pointerdown', {
          ...evtOpts,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        })
      );
    }
    if (typeof MouseEvent === 'function') {
      el.dispatchEvent?.(new MouseEvent('mousedown', evtOpts));
    }
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent?.(
        new PointerEvent('pointerup', {
          ...evtOpts,
          buttons: 0,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        })
      );
    }
    if (typeof MouseEvent === 'function') {
      el.dispatchEvent?.(new MouseEvent('mouseup', { ...evtOpts, buttons: 0 }));
    }

    if (typeof el.click === 'function') {
      el.click();
    } else if (typeof Event === 'function') {
      el.dispatchEvent?.(new Event('click', { bubbles: true, cancelable: true }));
    }
  }

  function isDropzoneElement(el) {
    if (!el || el.nodeType !== 1 || isElementHidden(el)) return false;
    if (el.getAttribute?.(BADGE_ATTR) === 'true') return false;
    const text = getVisibleTextExcludingBadges(el);
    if (DROPZONE_TEXT_RE.test(text)) return true;
    const cls = el.getAttribute?.('class') || '';
    const ariaDrop = el.getAttribute?.('aria-dropeffect');
    const hasDropAttr =
      (ariaDrop && ariaDrop !== 'none') ||
      Boolean(
        el.getAttribute?.('data-droppable') ||
          el.getAttribute?.('data-dropzone') ||
          el.getAttribute?.('data-blank') ||
          el.getAttribute?.('data-slot')
      );
    if (hasDropAttr || DROPZONE_CLASS_RE.test(cls)) {
      if (
        el.querySelector?.('[draggable="true"], .ui-draggable') &&
        !DROPZONE_CLASS_RE.test(cls) &&
        !hasDropAttr
      ) {
        return false;
      }
      return text.length <= 120 || DROPZONE_CLASS_RE.test(cls);
    }
    return false;
  }

  function resolveEffectiveDropzone(targetEl) {
    if (!targetEl || targetEl.nodeType !== 1) return null;
    if (isDropzoneElement(targetEl)) return targetEl;

    // 1. Direct dropzone descendant inside targetEl
    const directDrop = targetEl.querySelector?.(
      '[aria-dropeffect], [data-droppable], [data-dropzone], .ui-droppable, .dropzone, .drop-target, .drop-area, [class*="droppable"], [class*="dropzone"]'
    );
    if (directDrop && isDropzoneElement(directDrop)) return directDrop;

    const allChildren = targetEl.querySelectorAll?.('div, span, p, section');
    if (allChildren) {
      for (const child of allChildren) {
        if (isDropzoneElement(child)) return child;
      }
    }

    // 2. Sibling elements (e.g. dropzone placed right below column title)
    let sibling = targetEl.nextElementSibling;
    while (sibling) {
      if (isDropzoneElement(sibling)) return sibling;
      const sub = sibling.querySelector?.(
        '[aria-dropeffect], [data-droppable], [data-dropzone], .ui-droppable, .dropzone, .drop-target, .drop-area, [class*="droppable"], [class*="dropzone"]'
      );
      if (sub && isDropzoneElement(sub)) return sub;
      sibling = sibling.nextElementSibling;
    }

    // 3. Ancestor containers (walk up to column / bucket / card container and find descendant dropzone)
    let ancestor = targetEl.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement && depth < 5) {
      const dropInside = ancestor.querySelector?.(
        '[aria-dropeffect], [data-droppable], [data-dropzone], .ui-droppable, .dropzone, .drop-target, .drop-area, [class*="droppable"], [class*="dropzone"]'
      );
      if (dropInside && isDropzoneElement(dropInside) && !dropInside.contains(targetEl)) {
        return dropInside;
      }
      for (const child of ancestor.children || []) {
        if (child !== targetEl && !child.contains(targetEl)) {
          if (isDropzoneElement(child)) return child;
          const subDrop = child.querySelector?.(
            '[aria-dropeffect], [data-droppable], [data-dropzone], .ui-droppable, .dropzone, .drop-target, .drop-area, [class*="droppable"], [class*="dropzone"]'
          );
          if (subDrop && isDropzoneElement(subDrop)) return subDrop;
        }
      }
      ancestor = ancestor.parentElement;
      depth++;
    }

    return targetEl;
  }

  function climbToDropzoneRoot(el, stopRoot) {
    let cur = el;
    const baseLen = getVisibleTextExcludingBadges(el).length;
    while (
      cur?.parentElement &&
      cur.parentElement !== stopRoot &&
      cur.parentElement !== document.body &&
      cur.parentElement !== document.documentElement
    ) {
      const parent = cur.parentElement;
      if (CARD_STOP_PARENTS.has(parent.tagName)) break;
      const parentText = getVisibleTextExcludingBadges(parent);
      if (parentText.length > baseLen + 12) break;
      if (!isDropzoneElement(parent) && parentText !== getVisibleTextExcludingBadges(cur)) break;
      cur = parent;
    }
    return cur;
  }

  function collectDropzonesInRoot(root) {
    const target = root || document.body;
    if (!target) return [];
    const selector =
      '[aria-dropeffect], [data-droppable], [data-dropzone], [data-blank], [data-slot], .dropzone, .drop-zone, .droppable, .ui-droppable, .drop-target, .drop-box, .cloze-blank, .dnd_target, .dnd-target, .dnd_dropzone, .dnd-dropzone, .dnd_box, .dnd-box, [class*="dropzone"], [class*="droppable"], span, div, button, td';
    const raw = [];
    for (const el of target.querySelectorAll(selector)) {
      if (isDropzoneElement(el)) {
        const promoted = climbToDropzoneRoot(el, target);
        if (!raw.includes(promoted)) raw.push(promoted);
      }
    }
    return raw.filter((el) => !raw.some((other) => other !== el && other.contains?.(el)));
  }

  function hasDropzoneInside(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return false;
    return collectDropzonesInRoot(el).length > 0;
  }

  function getDropzoneContextText(dz, scope) {
    if (!dz) return '';
    let anchor = dz;
    const baseLen = getVisibleTextExcludingBadges(dz).length;
    while (
      anchor?.parentNode &&
      anchor.parentNode !== scope &&
      anchor.parentNode !== document.body &&
      getVisibleTextExcludingBadges(anchor.parentNode).length <= baseLen + 10
    ) {
      anchor = anchor.parentNode;
    }
    const parent = anchor?.parentNode;
    if (!parent || !parent.childNodes) return '';
    const childArr = Array.from(parent.childNodes);
    const idx = childArr.indexOf(anchor);
    if (idx === -1) return getVisibleTextExcludingBadges(parent);

    const snippets = [];
    for (let offset = Math.max(0, idx - 3); offset <= Math.min(childArr.length - 1, idx + 3); offset++) {
      if (offset === idx) continue;
      const sib = childArr[offset];
      if (!sib) continue;
      if (sib.nodeType === 3) {
        snippets.push(sib.textContent || '');
      } else if (sib.nodeType === 1 && !isDropzoneElement(sib)) {
        snippets.push(getVisibleTextExcludingBadges(sib));
      }
    }
    return cleanText(snippets.join(' '));
  }

  function findDropzoneForQuestion(scope, item) {
    const root = scope || document.body;
    if (!root) return null;
    const dropzones = collectDropzonesInRoot(root);
    if (dropzones.length === 0) return null;
    if (dropzones.length === 1) return dropzones[0];

    const qTokens = tokenize(stripQuestionPrefix(cleanQuestionForTokens(item.question)));
    if (qTokens.length === 0) return dropzones[0];

    let bestDz = dropzones[0];
    let bestScore = -1;
    for (const dz of dropzones) {
      const ctx = cleanQuestionForTokens(getDropzoneContextText(dz, root));
      const ctxSet = new Set(tokenize(ctx));
      let hits = 0;
      for (const tok of qTokens) {
        if (ctxSet.has(tok)) hits++;
      }
      const isAvailable =
        DROPZONE_TEXT_RE.test(getVisibleTextExcludingBadges(dz)) &&
        !dz.classList?.contains?.(APPLIED_CLASS) &&
        !dz.classList?.contains?.(HIGHLIGHT_CLASS);
      const score = hits / qTokens.length + (isAvailable ? 0.25 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestDz = dz;
      }
    }
    return bestDz;
  }

  function isWordBankChipLike(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = el.getAttribute?.('class') || '';
    if (el.getAttribute?.('draggable') === 'true' || DRAGGABLE_CLASS_RE.test(cls)) return true;
    const parent = el.parentElement;
    if (parent && (parent.children?.length || 0) >= 2) {
      const shortSiblings = [...parent.children].filter((sib) => {
        const t = getVisibleTextExcludingBadges(sib);
        return t.length >= 1 && t.length <= 60 && !DROPZONE_TEXT_RE.test(t);
      });
      if (shortSiblings.length >= 2) return true;
    }
    return false;
  }

  function isDraggableSource(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = el.getAttribute?.('class') || '';
    return el.getAttribute?.('draggable') === 'true' || DRAGGABLE_CLASS_RE.test(cls);
  }

  function findDraggableSourceElement(wordText, questionScope, usedSources = new Set()) {
    if (!document.body || !cleanText(wordText)) return null;
    const cands = findMatchingCardCandidates(document.body, wordText);
    if (cands.length === 0) return null;

    let bestEl = null;
    let bestRank = -Infinity;

    for (const cand of cands) {
      const el = cand.el;
      if (isDropzoneElement(el)) continue;

      let rank = cand.score;
      const cls = el.getAttribute?.('class') || '';
      if (el.getAttribute?.('draggable') === 'true' || DRAGGABLE_CLASS_RE.test(cls)) rank += 350;
      if (['BUTTON', 'A', 'LI', 'SPAN', 'DIV'].includes(el.tagName) && el.getAttribute?.('role') === 'button') {
        rank += 120;
      }
      if (isWordBankChipLike(el)) rank += 250;
      if (questionScope && questionScope !== document.body && questionScope.contains?.(el) && !isWordBankChipLike(el)) {
        rank -= 600;
      }
      if (el.closest?.(`.${APPLIED_CLASS}`) && !isWordBankChipLike(el)) rank -= 800;
      if (!usedSources.has(el)) rank += 150;

      if (rank > bestRank) {
        bestRank = rank;
        bestEl = el;
      }
    }

    return bestEl;
  }

  function isDropzoneFilledWith(dropzoneEl, expectedWord) {
    if (!dropzoneEl) return false;
    const vis = getVisibleTextExcludingBadges(dropzoneEl);
    if (DROPZONE_TEXT_RE.test(vis)) return false;
    if (expectedWord) {
      if (scoreTextMatch(vis, expectedWord) >= 600) return true;
      if (normalizeText(vis).includes(normalizeText(expectedWord))) return true;
      const innerInput = dropzoneEl.querySelector?.('input');
      if (innerInput && scoreTextMatch(innerInput.value || '', expectedWord) >= 600) return true;
    }
    return false;
  }

  function ensureElementVisible(el) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try {
      const r = el.getBoundingClientRect?.();
      const vh = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
      if (!r || !vh || r.top < 0 || r.bottom > vh) {
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    } catch {
      // Ignore scroll failures in minimal DOMs.
    }
  }

  function getElementCenter(el) {
    try {
      const r = el?.getBoundingClientRect?.();
      if (r && (r.width || r.height || r.left || r.top)) {
        return {
          x: Math.round(r.left + (r.width || 20) / 2),
          y: Math.round(r.top + (r.height || 20) / 2),
        };
      }
    } catch {
      // Ignore rect failures.
    }
    return { x: 10, y: 10 };
  }

  async function performDragAndDrop(sourceEl, targetEl, stepDelayMs = 25) {
    if (!sourceEl || !targetEl) return { ok: false, method: 'none' };
    const textHint = getVisibleTextExcludingBadges(sourceEl);

    if (isDropzoneFilledWith(targetEl, textHint)) {
      return { ok: true, method: 'already_filled' };
    }

    ensureElementVisible(targetEl);
    await sleep(stepDelayMs);

    const srcPt = getElementCenter(sourceEl);
    const dstPt = getElementCenter(targetEl);
    const win = typeof window !== 'undefined' ? window : undefined;

    const makeMouseInit = (x, y, extra = {}) => ({
      bubbles: true,
      cancelable: true,
      view: win,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
      which: 1,
      ...extra,
    });

    // 1. Pointer + Mouse drag sequence (handles jQuery UI draggable/droppable, Pointer/Mouse DnD)
    if (typeof PointerEvent === 'function') {
      sourceEl.dispatchEvent?.(
        new PointerEvent('pointerdown', {
          ...makeMouseInit(srcPt.x, srcPt.y),
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        })
      );
    }
    if (typeof MouseEvent === 'function') {
      sourceEl.dispatchEvent?.(new MouseEvent('mousedown', makeMouseInit(srcPt.x, srcPt.y)));
    }

    await sleep(stepDelayMs);

    const nudgeX = srcPt.x + 8;
    const nudgeY = srcPt.y + 8;
    const midX = Math.round((srcPt.x + dstPt.x) / 2);
    const midY = Math.round((srcPt.y + dstPt.y) / 2);

    for (const [el, x, y] of [
      [sourceEl, nudgeX, nudgeY],
      [document, midX, midY],
      [targetEl, dstPt.x, dstPt.y],
    ]) {
      if (!el || typeof el.dispatchEvent !== 'function') continue;
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(
          new PointerEvent('pointermove', {
            ...makeMouseInit(x, y),
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
          })
        );
      }
      if (typeof MouseEvent === 'function') {
        el.dispatchEvent(new MouseEvent('mousemove', makeMouseInit(x, y)));
      }
    }

    await sleep(stepDelayMs);

    // Single mouseup/pointerup on targetEl (bubbles naturally to document without duplicate fire)
    const upInit = makeMouseInit(dstPt.x, dstPt.y, { buttons: 0 });
    if (typeof PointerEvent === 'function') {
      targetEl.dispatchEvent?.(
        new PointerEvent('pointerup', {
          ...upInit,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        })
      );
    }
    if (typeof MouseEvent === 'function') {
      targetEl.dispatchEvent?.(new MouseEvent('mouseup', upInit));
    }

    await sleep(stepDelayMs);
    if (isDropzoneFilledWith(targetEl, textHint)) {
      return { ok: true, method: 'pointer_mouse_drag' };
    }

    // 2. Native HTML5 DragEvent sequence (draggable="true" + DataTransfer)
    if (typeof DragEvent === 'function') {
      const dt = typeof DataTransfer === 'function' ? new DataTransfer() : undefined;
      sourceEl.dispatchEvent?.(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          view: win,
          clientX: srcPt.x,
          clientY: srcPt.y,
          dataTransfer: dt,
        })
      );
      try {
        if (dt && !dt.getData('text/plain') && textHint) {
          dt.setData('text/plain', textHint);
        }
      } catch {
        // Ignore read-only DataTransfer errors.
      }

      for (const type of ['dragenter', 'dragover', 'drop']) {
        targetEl.dispatchEvent?.(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            view: win,
            clientX: dstPt.x,
            clientY: dstPt.y,
            dataTransfer: dt,
          })
        );
      }
      sourceEl.dispatchEvent?.(
        new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          view: win,
          clientX: dstPt.x,
          clientY: dstPt.y,
          dataTransfer: dt,
        })
      );

      await sleep(stepDelayMs);
      if (isDropzoneFilledWith(targetEl, textHint)) {
        return { ok: true, method: 'html5_drag' };
      }
    }

    // 3. Accessible click-chip -> click-dropzone fallback
    activateInteractiveElement(sourceEl);
    await sleep(stepDelayMs);
    activateInteractiveElement(targetEl);
    await sleep(stepDelayMs);

    return {
      ok: isDropzoneFilledWith(targetEl, textHint),
      method: isDropzoneFilledWith(targetEl, textHint) ? 'click_fallback' : 'dispatched',
    };
  }

  function findTextInputInScope(scopeRoot, questionText) {
    const selector =
      'textarea, input:not([type]), input[type="text"], input[type="email"], input[type="number"], input[type="search"], input[type="url"], [contenteditable="true"]';

    if (scopeRoot && scopeRoot !== document.body) {
      const scoped = [...scopeRoot.querySelectorAll(selector)].filter((el) => !isElementHidden(el));
      if (scoped.length > 0) return scoped[0];
    }

    if (document.body) {
      const qTokens = tokenize(questionText);
      if (qTokens.length === 0) return null;
      for (const el of document.body.querySelectorAll(selector)) {
        if (isElementHidden(el)) continue;
        const label = getControlLabelText(el);
        if (scoreTextMatch(label, questionText) > 0) return el;
      }
    }

    return null;
  }

  function setNativeControlValue(control, value) {
    const tag = control.tagName;
    if (control.getAttribute?.('contenteditable') === 'true') {
      control.focus?.();
      control.textContent = value;
      control.dispatchEvent?.(new Event('input', { bubbles: true }));
      control.dispatchEvent?.(new Event('change', { bubbles: true }));
      return;
    }

    const proto =
      tag === 'TEXTAREA' && typeof HTMLTextAreaElement !== 'undefined'
        ? HTMLTextAreaElement.prototype
        : tag === 'INPUT' && typeof HTMLInputElement !== 'undefined'
          ? HTMLInputElement.prototype
          : null;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(control, value);
    } else {
      control.value = value;
    }

    control.focus?.();
    control.dispatchEvent?.(new Event('input', { bubbles: true }));
    control.dispatchEvent?.(new Event('change', { bubbles: true }));
    control.dispatchEvent?.(new Event('blur', { bubbles: true }));
  }

  function dispatchCheckEvents(control) {
    control.dispatchEvent?.(new Event('input', { bubbles: true }));
    control.dispatchEvent?.(new Event('change', { bubbles: true }));
  }

  function clearHighlights() {
    if (typeof CSS !== 'undefined' && CSS.highlights?.delete) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
    }
    if (!document.body) return { ok: true };

    for (const badge of [...document.querySelectorAll(`[${BADGE_ATTR}="true"]`)]) {
      badge.remove?.() ?? badge.parentNode?.removeChild?.(badge);
    }

    const classSelector = [HIGHLIGHT_CLASS, APPLIED_CLASS, ...PAIR_CLASSES]
      .map((c) => `.${c}`)
      .join(', ');
    for (const el of [...document.querySelectorAll(classSelector)]) {
      el.classList?.remove(HIGHLIGHT_CLASS, APPLIED_CLASS, ...PAIR_CLASSES);
    }

    for (const mark of [...document.querySelectorAll(`[${MARK_ATTR}="true"]`)]) {
      const parent = mark.parentNode;
      if (!parent) continue;
      if (typeof mark.replaceWith === 'function' && typeof document.createTextNode === 'function') {
        mark.replaceWith(document.createTextNode(mark.textContent || ''));
        parent.normalize?.();
      } else if (parent.childNodes) {
        const childArr = Array.from(parent.childNodes);
        const idx = childArr.indexOf(mark);
        if (idx !== -1 && typeof parent.childNodes.splice === 'function') {
          const tn = document.createTextNode(mark.textContent || '');
          tn.parentNode = parent;
          parent.childNodes.splice(idx, 1, tn);
        }
      }
    }
    return { ok: true };
  }

  function getVisibleRowOrSelf(el) {
    return getVisualRowTarget(el) || el;
  }

  function splitEllipsisGaps(text) {
    const raw = cleanText(text);
    if (!raw) return [];
    if (/\s*(?:\.{3,}|…)\s*/.test(raw)) {
      return raw
        .split(/\s*(?:\.{3,}|…)\s*/)
        .map((p) => cleanText(p))
        .filter((p) => p.length >= 2);
    }
    return [raw];
  }

  function extractHighlightPhrases(item, singleChoice) {
    const phrases = [];
    const seen = new Set();
    const pushPhrase = (raw) => {
      for (const part of splitEllipsisGaps(raw)) {
        if (part.length < 2 || part.length > 240) continue;
        const key = normalizeText(part);
        if (key && !seen.has(key)) {
          seen.add(key);
          phrases.push(part);
        }
      }
    };

    if (Array.isArray(item.selected_options) && item.selected_options.length > 0) {
      const list = singleChoice ? [item.selected_options[0]] : item.selected_options;
      for (const opt of list) pushPhrase(opt);
    }

    if (item.apply_value && (!singleChoice || phrases.length === 0)) {
      pushPhrase(item.apply_value);
    }

    if (item.answer && (!singleChoice || phrases.length === 0)) {
      const ans = String(item.answer);
      for (const m of ans.matchAll(/"([^"\n]{2,180})"|“([^”\n]{2,180})”/g)) {
        pushPhrase(m[1] || m[2]);
      }
      const parts = ans
        .split(/\r?\n|;|•|\|/)
        .map((p) => cleanText(p).replace(/^\s*(?:\d+[.)]\s*|[-*]\s*)/, ''))
        .filter((p) => p.length >= 2 && p.length <= 180);
      if (parts.length > 1) {
        for (const p of parts) pushPhrase(p);
      } else if (phrases.length === 0 && cleanText(ans).length <= 180) {
        pushPhrase(ans);
      }
    }

    return singleChoice ? phrases.slice(0, 1) : phrases;
  }

  function isSafeInlineClickElement(el) {
    if (!el || el.nodeType !== 1 || isElementHidden(el)) return false;
    if (FORM_CONTROLS.has(el.tagName) || BLOCK_BOUNDARY_TAGS.has(el.tagName)) return false;
    if (el.tagName === 'A') {
      const href = (el.getAttribute?.('href') || '').trim().toLowerCase();
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) return false;
    }
    const text = getVisibleTextExcludingBadges(el);
    if (!text || UNSAFE_COMMAND_RE.test(text)) return false;
    return true;
  }

  function hasInlineTokenAffordance(el, stopRoot) {
    if (!el) return false;
    const cls = el.getAttribute?.('class') || '';
    const role = el.getAttribute?.('role') || '';
    if (
      role === 'button' ||
      el.getAttribute?.('onclick') !== null ||
      el.getAttribute?.('tabindex') !== null ||
      INLINE_TOKEN_CLASS_RE.test(cls) ||
      /\b(choice|option|answer|item)\b/i.test(cls) ||
      el.getAttribute?.('data-word') !== null ||
      el.getAttribute?.('data-token') !== null ||
      el.getAttribute?.('data-clickable') !== null ||
      el.getAttribute?.('data-selectable') !== null ||
      el.getAttribute?.('data-value') !== null ||
      el.getAttribute?.('data-id') !== null
    ) {
      return true;
    }
    if (el.tagName === 'A') {
      const href = (el.getAttribute?.('href') || '').trim().toLowerCase();
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return true;
    }
    if (stopRoot && typeof stopRoot.querySelectorAll === 'function') {
      const siblingTokens = [...stopRoot.querySelectorAll('span, a, u, mark, em, strong')].filter((n) => {
        if (isElementHidden(n)) return false;
        const t = getVisibleTextExcludingBadges(n);
        return t.length >= 1 && t.length <= 50;
      });
      if (siblingTokens.length >= 4) return true;
    }
    return false;
  }

  function findClickableInlinePhraseTargets(scopeRoot, item, singleChoice) {
    if (!scopeRoot || scopeRoot === document.body) return [];
    const phrases = extractHighlightPhrases(item, singleChoice);
    if (item.evidence_quote && (!singleChoice || phrases.length === 0)) {
      const eq = cleanText(item.evidence_quote);
      if (eq && !phrases.some((p) => normalizeText(p) === normalizeText(eq))) {
        phrases.push(eq);
      }
    }
    if (phrases.length === 0) return [];

    const ranges = findTextRangesInRoot(scopeRoot, phrases, singleChoice ? 1 : Infinity);
    if (ranges.length === 0) return [];

    const targets = [];
    const seen = new Set();

    for (const r of ranges) {
      const textNode = r.textNode || (r.startContainer?.nodeType === 3 ? r.startContainer : null);
      if (!textNode) continue;
      const segLen = cleanText((textNode.textContent || '').slice(r.startOffset, r.endOffset)).length;
      if (segLen < 1) continue;

      let chosen = null;
      let cur = textNode.parentElement;
      while (cur && cur !== scopeRoot && cur !== document.body) {
        if (BLOCK_BOUNDARY_TAGS.has(cur.tagName)) break;
        const visLen = getVisibleTextExcludingBadges(cur).length;
        if (visLen > Math.max(segLen * 1.45, segLen + 6)) break;
        if (isSafeInlineClickElement(cur) && hasInlineTokenAffordance(cur, scopeRoot)) {
          chosen = cur;
        }
        cur = cur.parentElement;
      }

      if (chosen && !seen.has(chosen)) {
        seen.add(chosen);
        targets.push(chosen);
      }
    }

    return singleChoice ? targets.slice(0, 1) : targets;
  }

  function highlightAnswers(items = [], options = {}) {
    clearHighlights();
    const allRanges = [];
    const details = [];
    let firstTarget = null;
    let matchedQuestions = 0;
    const usedDragSources = new Set();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const qLabel = `Q${item.index ?? i + 1}`;
      const pairs = extractMatchingPairs(item);

      if (pairs.length > 0) {
        const scope = findMatchingScope(item, pairs);
        const resolved = resolveMatchingPairElements(scope, pairs);
        let pairHits = 0;

        const rightCounts = {};
        for (const p of pairs) {
          const rKey = cleanText(p?.right).toLowerCase();
          rightCounts[rKey] = (rightCounts[rKey] || 0) + 1;
        }
        const isCategoryBucket = Object.values(rightCounts).some((count) => count > 1);

        const categoryMatches = new Map();
        if (isCategoryBucket) {
          for (const r of resolved) {
            if (!r.rightEl) continue;
            const dropzone = resolveEffectiveDropzone(r.rightEl) || r.rightEl;
            if (!categoryMatches.has(dropzone)) {
              categoryMatches.set(dropzone, { name: cleanText(r.right), items: [], headerEl: r.rightEl });
            }
            categoryMatches.get(dropzone).items.push(r.left);
          }
        }

        for (const r of resolved) {
          const slot = r.index % PAIR_CLASSES.length;
          const pairClass = PAIR_CLASSES[slot];
          if (r.leftEl) {
            const chipBadge = isCategoryBucket
              ? `→ ${truncateLabel(r.right, 14)}`
              : `M${r.index + 1}`;
            markElement(r.leftEl, HIGHLIGHT_CLASS, chipBadge, 'highlight', {
              extraClass: pairClass,
              pairSlot: slot,
            });
            if (!firstTarget) firstTarget = r.leftEl;
          }
          if (r.rightEl) {
            if (isCategoryBucket) {
              const dropzone = resolveEffectiveDropzone(r.rightEl) || r.rightEl;
              const catInfo = categoryMatches.get(dropzone);
              const countText = catInfo ? ` (${catInfo.items.length} items)` : '';
              markElement(
                dropzone,
                HIGHLIGHT_CLASS,
                `✓ ${truncateLabel(r.right, 16)}${countText}`,
                'highlight',
                {
                  extraClass: pairClass,
                  pairSlot: slot,
                }
              );
              if (dropzone !== r.rightEl && !r.rightEl.classList?.contains?.(HIGHLIGHT_CLASS)) {
                markElement(
                  r.rightEl,
                  HIGHLIGHT_CLASS,
                  `✓ ${truncateLabel(r.right, 16)}`,
                  'highlight',
                  {
                    extraClass: pairClass,
                    pairSlot: slot,
                  }
                );
              }
              if (!firstTarget) firstTarget = dropzone;
            } else {
              markElement(
                r.rightEl,
                HIGHLIGHT_CLASS,
                `M${r.index + 1}: ${truncateLabel(r.left, 18)}`,
                'highlight',
                {
                  extraClass: pairClass,
                  pairSlot: slot,
                }
              );
              if (!firstTarget) firstTarget = r.rightEl;
            }
          }
          if (r.leftEl && r.rightEl) pairHits++;
        }

        const itemMatched = resolved.some((r) => r.leftEl || r.rightEl);
        if (itemMatched) matchedQuestions++;
        details.push({
          index: item.index ?? i + 1,
          matched: itemMatched,
          matchedPairs: pairHits,
          totalPairs: pairs.length,
        });
        continue;
      }

      const scope = findQuestionContainer(item.question);
      const targets = getChoiceTargets(item);
      const rawControls = findMatchedControlsInScope(scope || document.body, targets);
      const controlsToHighlight = selectEffectiveControls(item, rawControls);
      const isExplicitSingleChoice =
        ['multiple_choice', 'true_false'].includes(item.question_type) ||
        isDomSingleChoiceOnly(rawControls);
      const singleChoice =
        isExplicitSingleChoice || (item.question_type !== 'multi_select' && rawControls.length > 0);

      // Drag-and-drop word bank blank (when item is drag_drop OR question has a dropzone blank)
      if (controlsToHighlight.length === 0) {
        const wordText = cleanText(item.apply_value || item.selected_options?.[0] || item.answer || '');
        const dropzone = findDropzoneForQuestion(scope, item);
        const sourceChip =
          wordText && (item.question_type === 'drag_drop' || dropzone)
            ? findDraggableSourceElement(wordText, scope, usedDragSources)
            : null;
        const alreadyFilled = dropzone && isDropzoneFilledWith(dropzone, wordText);
        if (dropzone && (alreadyFilled || (sourceChip && (item.question_type === 'drag_drop' || isWordBankChipLike(sourceChip))))) {
          if (sourceChip) usedDragSources.add(sourceChip);
          const slot = i % PAIR_CLASSES.length;
          const pairClass = PAIR_CLASSES[slot];
          if (sourceChip) {
            markElement(sourceChip, HIGHLIGHT_CLASS, qLabel, 'highlight', {
              extraClass: pairClass,
              pairSlot: slot,
            });
          }
          markElement(dropzone, HIGHLIGHT_CLASS, `${qLabel}: ${truncateLabel(wordText, 18)}${alreadyFilled ? ' (placed)' : ''}`, 'highlight', {
            extraClass: pairClass,
            pairSlot: slot,
          });
          if (!firstTarget) firstTarget = dropzone;
          matchedQuestions++;
          details.push({
            index: item.index ?? i + 1,
            matched: true,
            controlCount: sourceChip ? 2 : 1,
            rangeCount: 0,
            kind: 'drag_drop',
          });
          continue;
        }
      }

      let itemMatched = false;
      for (const hit of controlsToHighlight) {
        const row = getVisibleRowOrSelf(hit.control);
        if (row) {
          markElement(row, HIGHLIGHT_CLASS, `✓ ${qLabel} Answer`, 'highlight');
          if (!firstTarget) firstTarget = row;
          itemMatched = true;
        }
      }

      // Highlight source evidence quotes ONLY if distinct from already-badged option controls,
      // and never highlight arbitrary choice spans across sibling controls when a control row already matched.
      const searchRoot = scope || document.body;
      const maxRanges = singleChoice ? 1 : Infinity;
      let ranges = [];

      if (controlsToHighlight.length === 0) {
        const phraseCandidates = extractHighlightPhrases(item, singleChoice);
        const eq = cleanText(item.evidence_quote);
        if (eq) {
          if (item.question_type === 'multi_select' && phraseCandidates.length > 0) {
            if (!phraseCandidates.some((p) => normalizeText(p) === normalizeText(eq))) {
              phraseCandidates.push(eq);
            }
          } else if (!phraseCandidates.some((p) => normalizeText(p) === normalizeText(eq))) {
            phraseCandidates.unshift(eq);
          }
        }
        const searchList = singleChoice ? phraseCandidates : phraseCandidates;
        ranges = findTextRangesInRoot(searchRoot, searchList, maxRanges);
        if (ranges.length === 0 && scope && scope !== document.body && document.body) {
          ranges = findTextRangesInRoot(document.body, searchList, maxRanges);
        }
      } else if (item.evidence_quote) {
        const quoteDuplicatesControl = controlsToHighlight.some(
          (c) => scoreTextMatch(c.labelText, item.evidence_quote) >= 850
        );
        if (!quoteDuplicatesControl) {
          ranges = findTextRangesInRoot(searchRoot, [item.evidence_quote], maxRanges);
          if (ranges.length === 0 && scope && scope !== document.body && document.body) {
            ranges = findTextRangesInRoot(document.body, [item.evidence_quote], maxRanges);
          }
        }
      }

      if (ranges.length > 0) {
        allRanges.push(...ranges);
        if (!firstTarget) firstTarget = ranges[0];
        itemMatched = true;
      }

      if (itemMatched) matchedQuestions++;
      details.push({
        index: item.index ?? i + 1,
        matched: itemMatched,
        controlCount: controlsToHighlight.length,
        rangeCount: ranges.length,
      });
    }

    if (allRanges.length > 0) {
      if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
        const highlight = new Highlight(...allRanges);
        CSS.highlights.set(HIGHLIGHT_NAME, highlight);
      } else {
        wrapMarkFallbackBatch(allRanges);
      }
    }

    if (options.scrollToFirst && firstTarget) {
      safeScrollIntoView(firstTarget);
    }

    return {
      ok: true,
      highlightedCount: details.filter((d) => d.matched).length,
      matchedQuestions,
      totalQuestions: items.length,
      details,
    };
  }

  async function applyAnswers(items = [], options = {}) {
    const {
      scrollToFirst = false,
      highlightMatched = true,
      pairDelayMs = 70,
    } = options;
    if (highlightMatched) {
      clearHighlights();
    }

    let firstTarget = null;
    let appliedCount = 0;
    let skippedCount = 0;
    const results = [];
    const usedDragSources = new Set();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const qLabel = `Q${item.index ?? i + 1}`;
      const pairs = extractMatchingPairs(item);

      if (pairs.length > 0) {
        const scope = findMatchingScope(item, pairs);
        const resolved = resolveMatchingPairElements(scope, pairs);
        let pairsConnected = 0;

        const rightCounts = {};
        for (const p of pairs) {
          const rKey = cleanText(p?.right).toLowerCase();
          rightCounts[rKey] = (rightCounts[rKey] || 0) + 1;
        }
        const isCategoryBucket = Object.values(rightCounts).some((count) => count > 1);

        const categoryMatches = new Map();
        if (isCategoryBucket) {
          for (const r of resolved) {
            if (!r.rightEl) continue;
            const dropzone = resolveEffectiveDropzone(r.rightEl) || r.rightEl;
            if (!categoryMatches.has(dropzone)) {
              categoryMatches.set(dropzone, { name: cleanText(r.right), items: [], headerEl: r.rightEl });
            }
            categoryMatches.get(dropzone).items.push(r.left);
          }
        }

        for (const r of resolved) {
          if (!r.leftEl || !r.rightEl) continue;

          let srcEl = r.leftEl;
          let dstEl = r.rightEl;
          if (isDraggableSource(dstEl) && !isDraggableSource(srcEl)) {
            srcEl = r.rightEl;
            dstEl = r.leftEl;
          }

          const dropzone = resolveEffectiveDropzone(dstEl) || dstEl;

          if (isDraggableSource(srcEl) || isDropzoneElement(dropzone) || isCategoryBucket) {
            await performDragAndDrop(srcEl, dropzone, Math.min(35, pairDelayMs));
          } else if (!isPairAlreadyConnected(srcEl, dstEl)) {
            if (!isCardPendingSelected(srcEl)) {
              activateInteractiveElement(srcEl);
              await sleep(pairDelayMs);
            }
            activateInteractiveElement(dstEl);
            await sleep(pairDelayMs);
          }
          pairsConnected++;

          if (highlightMatched) {
            const slot = r.index % PAIR_CLASSES.length;
            const pairClass = PAIR_CLASSES[slot];
            if (isCategoryBucket) {
              const chipBadge = `✓ → ${truncateLabel(r.right, 14)}`;
              markElement(srcEl, APPLIED_CLASS, chipBadge, 'applied', {
                extraClass: pairClass,
                pairSlot: slot,
              });
              const catInfo = categoryMatches.get(dropzone);
              const countText = catInfo ? ` (${catInfo.items.length} items)` : '';
              markElement(
                dropzone,
                APPLIED_CLASS,
                `✓ ${truncateLabel(r.right, 16)}${countText}`,
                'applied',
                {
                  extraClass: pairClass,
                  pairSlot: slot,
                }
              );
              if (dropzone !== dstEl && !dstEl.classList?.contains?.(APPLIED_CLASS)) {
                markElement(
                  dstEl,
                  APPLIED_CLASS,
                  `✓ ${truncateLabel(r.right, 16)}`,
                  'applied',
                  {
                    extraClass: pairClass,
                    pairSlot: slot,
                  }
                );
              }
              if (!firstTarget) firstTarget = srcEl;
            } else {
              markElement(r.leftEl, APPLIED_CLASS, `✓ M${r.index + 1}`, 'applied', {
                extraClass: pairClass,
                pairSlot: slot,
              });
              markElement(
                r.rightEl,
                APPLIED_CLASS,
                `✓ M${r.index + 1}: ${truncateLabel(r.left, 18)}`,
                'applied',
                {
                  extraClass: pairClass,
                  pairSlot: slot,
                }
              );
              if (!firstTarget) firstTarget = r.leftEl;
            }
          }
        }

        if (pairsConnected > 0) {
          appliedCount++;
          results.push({
            index: item.index ?? i + 1,
            status: 'applied',
            controlType: 'matching',
            matchedPairs: pairsConnected,
            totalPairs: pairs.length,
          });
        } else {
          skippedCount++;
          results.push({ index: item.index ?? i + 1, status: 'no_control', controlType: '' });
        }
        continue;
      }

      const scope = findQuestionContainer(item.question);
      const targets = getChoiceTargets(item);
      const rawControls = findMatchedControlsInScope(scope || document.body, targets);
      const toApply = selectEffectiveControls(item, rawControls);
      const isMulti = item.question_type === 'multi_select' && !isDomSingleChoiceOnly(rawControls);

      let appliedHere = false;
      let controlType = '';

      if (toApply.length > 0) {
        // For checkbox multi-select inside a scoped question container, uncheck non-matching ones first
        if (isMulti && scope) {
          const keepSet = new Set(toApply.map((h) => h.control));
          for (const cb of scope.querySelectorAll('input[type="checkbox"]')) {
            if (!keepSet.has(cb) && cb.checked) {
              if (typeof cb.click === 'function') cb.click();
              if (cb.checked) {
                cb.checked = false;
                dispatchCheckEvents(cb);
              }
            }
          }
          for (const ariaCb of scope.querySelectorAll('[role="checkbox"]')) {
            if (!keepSet.has(ariaCb) && ariaCb.getAttribute?.('aria-checked') === 'true') {
              ariaCb.click?.();
            }
          }
        }

        for (const hit of toApply) {
          const ctrl = hit.control;
          controlType = hit.kind;

          if (hit.kind === 'radio' || hit.kind === 'checkbox') {
            if (!ctrl.checked) {
              if (typeof ctrl.click === 'function') ctrl.click();
              if (!ctrl.checked) {
                ctrl.checked = true;
                dispatchCheckEvents(ctrl);
              }
            }
            appliedHere = true;
          } else if (hit.kind.startsWith('aria-')) {
            const isChecked =
              ctrl.getAttribute?.('aria-checked') === 'true' ||
              ctrl.getAttribute?.('aria-selected') === 'true';
            if (!isChecked) {
              ctrl.click?.();
              if (
                ctrl.getAttribute?.('aria-checked') !== 'true' &&
                ctrl.getAttribute?.('aria-selected') !== 'true'
              ) {
                if (hit.kind === 'aria-option') {
                  ctrl.setAttribute?.('aria-selected', 'true');
                } else {
                  ctrl.setAttribute?.('aria-checked', 'true');
                }
                dispatchCheckEvents(ctrl);
              }
            }
            appliedHere = true;
          } else if (hit.kind === 'select' && hit.option) {
            ctrl.value = hit.option.value;
            hit.option.selected = true;
            dispatchCheckEvents(ctrl);
            appliedHere = true;
          } else if (hit.kind === 'button-option') {
            activateInteractiveElement(ctrl);
            appliedHere = true;
          }

          if (highlightMatched) {
            const row = getVisibleRowOrSelf(ctrl);
            markElement(row, APPLIED_CLASS, `✓ ${qLabel} Applied`, 'applied');
            if (!firstTarget) firstTarget = row;
          }
        }
      } else {
        const wordValue = cleanText(item.apply_value || item.selected_options?.[0] || item.answer || '');
        const dropzone = findDropzoneForQuestion(scope, item);
        const sourceChip =
          wordValue && (item.question_type === 'drag_drop' || dropzone)
            ? findDraggableSourceElement(wordValue, scope, usedDragSources)
            : null;

        if (dropzone && isDropzoneFilledWith(dropzone, wordValue)) {
          appliedHere = true;
          controlType = 'drag_drop';
          if (highlightMatched) {
            const slot = i % PAIR_CLASSES.length;
            const pairClass = PAIR_CLASSES[slot];
            markElement(
              dropzone,
              APPLIED_CLASS,
              `✓ ${qLabel}: ${truncateLabel(wordValue, 18)} (already placed)`,
              'applied',
              {
                extraClass: pairClass,
                pairSlot: slot,
              }
            );
            if (!firstTarget) firstTarget = dropzone;
          }
        } else if (dropzone && sourceChip && (item.question_type === 'drag_drop' || isWordBankChipLike(sourceChip))) {
          usedDragSources.add(sourceChip);
          await performDragAndDrop(sourceChip, dropzone, Math.min(35, pairDelayMs));
          appliedHere = true;
          controlType = 'drag_drop';
          if (highlightMatched) {
            const slot = i % PAIR_CLASSES.length;
            const pairClass = PAIR_CLASSES[slot];
            markElement(sourceChip, APPLIED_CLASS, `✓ ${qLabel}`, 'applied', {
              extraClass: pairClass,
              pairSlot: slot,
            });
            markElement(
              dropzone,
              APPLIED_CLASS,
              `✓ ${qLabel}: ${truncateLabel(wordValue, 18)}`,
              'applied',
              {
                extraClass: pairClass,
                pairSlot: slot,
              }
            );
            if (!firstTarget) firstTarget = dropzone;
          }
        } else {
          const textValue = cleanText(item.apply_value || item.answer || '');
          const shouldFillText =
            ['short_answer', 'coding_or_math', 'open_ended'].includes(item.question_type) ||
            scope !== null;
          if (textValue && shouldFillText) {
            const inputEl = findTextInputInScope(scope, item.question);
            if (inputEl) {
              setNativeControlValue(inputEl, textValue);
              appliedHere = true;
              controlType = inputEl.tagName.toLowerCase();
              if (highlightMatched) {
                markElement(inputEl, APPLIED_CLASS, `✓ ${qLabel} Filled`, 'applied');
                if (!firstTarget) firstTarget = inputEl;
              }
            }
          }

          if (!appliedHere && scope) {
            const singleInline = ['multiple_choice', 'true_false'].includes(item.question_type);
            const inlineTokens = findClickableInlinePhraseTargets(scope, item, singleInline);
            if (inlineTokens.length > 0) {
              for (let idx = 0; idx < inlineTokens.length; idx++) {
                const tok = inlineTokens[idx];
                activateInteractiveElement(tok);
                if (highlightMatched) {
                  if (idx === inlineTokens.length - 1) {
                    markElement(tok, APPLIED_CLASS, `✓ ${qLabel} Applied`, 'applied');
                  } else {
                    tok.classList?.add?.(APPLIED_CLASS);
                  }
                  if (!firstTarget) firstTarget = tok;
                }
              }
              appliedHere = true;
              controlType = 'inline-phrase';
            }
          }
        }
      }

      if (appliedHere) {
        appliedCount++;
        results.push({ index: item.index ?? i + 1, status: 'applied', controlType });
      } else {
        skippedCount++;
        results.push({ index: item.index ?? i + 1, status: 'no_control', controlType: '' });
      }
    }

    if (scrollToFirst && firstTarget) {
      safeScrollIntoView(firstTarget);
    }

    return {
      ok: true,
      appliedCount,
      skippedCount,
      totalQuestions: items.length,
      results,
    };
  }

  const api = {
    version: SCRIPT_VERSION,
    highlightAnswers,
    applyAnswers,
    clearHighlights,
    normalizeText,
  };

  globalThis.__tabscanPageActions = api;
  return api;
})();
