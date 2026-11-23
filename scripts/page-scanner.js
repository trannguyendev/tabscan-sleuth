(() => {
  const MAX_TEXT_CHARS = 42000;
  const MAX_CANDIDATES = 25;
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'CANVAS',
    'IFRAME',
    'OBJECT',
    'EMBED',
  ]);
  const BLOCK_TAGS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
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
    'TR',
    'UL',
  ]);

  const DROPZONE_TEXT_RE =
    /^[^\p{L}\p{N}]*(?:drag\s*(?:an?\s*)?item\s*here|drag\s*(?:and\s*)?drop\s*here|drop\s*(?:item\s*)?here|place\s*(?:item\s*)?here|move\s*here)[^\p{L}\p{N}]*$/iu;
  const DROPZONE_CLASS_RE =
    /\b(drop[-_]?zone|droppable|ui-droppable|drop[-_]?target|drop[-_]?box|drag[-_]?here|cloze[-_]?(blank|gap|slot)|dnd[-_]?(target|drop|zone|box|slot)|target[-_]?box)\b/i;
  const DRAGGABLE_CLASS_RE =
    /\b(ui-draggable|draggable|word-chip|drag-item|chip|tile|token|dnd[-_]?(item|chip)|palette[-_]?item|word[-_]?item)\b/i;

  function isDropzonePlaceholderNode(el) {
    if (!el || el.nodeType !== 1) return false;
    const text = cleanInlineText(el.textContent);
    if (text.length <= 40 && DROPZONE_TEXT_RE.test(text)) return true;
    const cls = el.getAttribute?.('class') || '';
    const hasDropAttr =
      Boolean(el.getAttribute?.('aria-dropeffect') && el.getAttribute('aria-dropeffect') !== 'none') ||
      Boolean(el.getAttribute?.('data-droppable') || el.getAttribute?.('data-dropzone'));
    if ((hasDropAttr || DROPZONE_CLASS_RE.test(cls)) && text.length <= 40 && !el.querySelector?.('[draggable="true"], .ui-draggable')) {
      return true;
    }
    return false;
  }

  function isRenderNodeHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    try {
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) {
          return true;
        }
      }
    } catch {
      // Ignore computed-style errors on detached or restricted nodes.
    }
    return false;
  }

  const BOILERPLATE_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE']);
  const BOILERPLATE_ROLES = new Set(['banner', 'contentinfo']);
  const BOILERPLATE_CLASS_RE =
    /\b(ad|advertisement|cookie[-_]?(banner|consent|notice)|sponsor|sponsored|popup[-_]?banner)\b/i;

  function hasInteractiveQuestionOrSelection(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (
      tag === 'FIELDSET' ||
      tag === 'LEGEND' ||
      tag === 'FORM' ||
      tag === 'MAIN' ||
      tag === 'INPUT' ||
      tag === 'SELECT' ||
      tag === 'TEXTAREA' ||
      tag === 'BUTTON'
    ) {
      return true;
    }
    const role = (el.getAttribute?.('role') || '').toLowerCase();
    if (
      role === 'radiogroup' ||
      role === 'radio' ||
      role === 'listitem' ||
      role === 'main' ||
      role === 'button'
    ) {
      return true;
    }
    if (
      el.getAttribute?.('draggable') === 'true' ||
      el.getAttribute?.('data-tabscan-badge') === 'true'
    ) {
      return true;
    }
    if (
      el.querySelector?.(
        'fieldset, legend, input, select, textarea, button, form, [role="radiogroup"], [role="radio"], [role="listitem"], [draggable="true"], .ui-draggable, [data-droppable], [data-dropzone], [aria-dropeffect], mark'
      )
    ) {
      return true;
    }
    const sel =
      typeof window !== 'undefined' &&
      typeof window.getSelection === 'function' &&
      window.getSelection()?.toString()?.trim();
    if (sel && sel.length >= 3 && (el.innerText ?? el.textContent ?? '').includes(sel.slice(0, 30))) {
      return true;
    }
    return false;
  }

  function isBoilerplateNode(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    const role = (el.getAttribute?.('role') || '').toLowerCase();
    const cls = el.getAttribute?.('class') || '';
    const id = el.getAttribute?.('id') || '';

    const isCandidate =
      BOILERPLATE_TAGS.has(tag) ||
      BOILERPLATE_ROLES.has(role) ||
      BOILERPLATE_CLASS_RE.test(cls) ||
      BOILERPLATE_CLASS_RE.test(id);

    if (!isCandidate) return false;
    if (hasInteractiveQuestionOrSelection(el)) return false;

    return true;
  }

  function isElementHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute?.('data-tabscan-badge') === 'true') return true;
    if (isBoilerplateNode(el)) return true;
    return isRenderNodeHidden(el);
  }

  function cleanInlineText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function getDirectOrLabelText(el) {
    if (!el) return '';
    const ariaLabel = el.getAttribute?.('aria-label');
    if (ariaLabel && ariaLabel.trim()) return cleanInlineText(ariaLabel);
    const labelledBy = el.getAttribute?.('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .filter(Boolean);
      if (parts.length) return cleanInlineText(parts.join(' '));
    }
    return cleanInlineText(el.innerText ?? el.textContent ?? '');
  }

  function extractLabelForInput(input) {
    if (!input) return '';
    if (input.id) {
      const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(input.id) : input.id;
      const explicit = document.querySelector(`label[for="${escapedId}"]`);
      if (explicit) return cleanInlineText(explicit.textContent);
    }
    const parentLabel = input.closest?.('label');
    if (parentLabel) return cleanInlineText(parentLabel.textContent);
    return getDirectOrLabelText(input);
  }

  function extractQuestionCandidates(root) {
    const candidates = [];
    const seen = new Set();

    function addCandidate(prompt, type, options = []) {
      const normalizedPrompt = cleanInlineText(prompt);
      if (!normalizedPrompt || normalizedPrompt.length < 4 || normalizedPrompt.length > 800) {
        return;
      }
      const key = normalizedPrompt.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      const cleanOptions = [];
      const seenOpts = new Set();
      for (const opt of options) {
        const o = cleanInlineText(opt);
        if (o && !seenOpts.has(o.toLowerCase())) {
          seenOpts.add(o.toLowerCase());
          cleanOptions.push(o.slice(0, 240));
        }
      }

      candidates.push({
        prompt: normalizedPrompt,
        type,
        options: cleanOptions.slice(0, 12),
      });
    }

    // 1. Fieldsets with legends & radio/checkbox options
    const fieldsets = root.querySelectorAll('fieldset');
    for (const fs of fieldsets) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (isElementHidden(fs)) continue;
      const legend = fs.querySelector('legend');
      const prompt = legend ? cleanInlineText(legend.textContent) : '';
      const inputs = [...fs.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
      const options = inputs.map((inp) => extractLabelForInput(inp)).filter(Boolean);
      const hasCheckbox = inputs.some((inp) => inp.type === 'checkbox');
      if (prompt) {
        addCandidate(prompt, hasCheckbox ? 'multi-choice' : 'single-choice', options);
      }
    }

    // 2. ARIA quiz / Google Forms style listitems & radiogroups
    const ariaGroups = root.querySelectorAll('[role="listitem"], [role="radiogroup"]');
    for (const group of ariaGroups) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (isElementHidden(group)) continue;
      const optionEls = group.querySelectorAll('[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]');
      if (optionEls.length < 2) continue;

      const headingEl = group.querySelector('[role="heading"], h1, h2, h3, h4, legend, .question, [data-params]');
      let prompt = headingEl ? cleanInlineText(headingEl.textContent) : '';
      if (!prompt) {
        const labelledBy = group.getAttribute('aria-labelledby');
        if (labelledBy) {
          prompt = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' ');
        } else if (group.getAttribute('aria-label')) {
          prompt = group.getAttribute('aria-label');
        }
      }

      const options = [...optionEls]
        .map((el) => (el.tagName === 'INPUT' ? extractLabelForInput(el) : getDirectOrLabelText(el)))
        .filter(Boolean);

      const isMulti = [...optionEls].some(
        (el) => el.getAttribute?.('role') === 'checkbox' || el.type === 'checkbox'
      );
      if (prompt) {
        addCandidate(prompt, isMulti ? 'multi-choice' : 'single-choice', options);
      }
    }

    // 3. Two-column matching exercises (left column items + right column definitions)
    const containers = root.querySelectorAll('section, article, form, fieldset, div, main');
    for (const container of containers) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (isElementHidden(container)) continue;
      const children = [...(container.children || [])].filter((c) => !isElementHidden(c));
      if (children.length < 2 || children.length > 4) continue;

      const listBlocks = children.filter((c) => {
        const itemCount = c.children?.length || 0;
        return itemCount >= 3 && itemCount <= 12;
      });
      if (listBlocks.length === 2) {
        const leftTexts = [...listBlocks[0].children]
          .filter((el) => !isElementHidden(el))
          .map((el) => cleanInlineText(el.textContent))
          .filter((t) => t.length >= 1 && t.length <= 160);
        const rightTexts = [...listBlocks[1].children]
          .filter((el) => !isElementHidden(el))
          .map((el) => cleanInlineText(el.textContent))
          .filter((t) => t.length >= 1 && t.length <= 240);

        if (leftTexts.length >= 3 && rightTexts.length >= 3 && Math.abs(leftTexts.length - rightTexts.length) <= 2) {
          const prevText = cleanInlineText(container.previousElementSibling?.textContent || '');
          const headingChild = container.querySelector('h1, h2, h3, h4, legend, p');
          const promptCandidate =
            (headingChild && !listBlocks[0].contains(headingChild) && !listBlocks[1].contains(headingChild)
              ? cleanInlineText(headingChild.textContent)
              : '') ||
            (prevText && prevText.length <= 240 ? prevText : '') ||
            `Match left items (${leftTexts.slice(0, 3).join(', ')}) to right items`;
          addCandidate(promptCandidate, 'matching', [...leftTexts, ...rightTexts].slice(0, 12));
        }
      }
    }

    // 4. Collect drag-and-drop word bank + leaf dropzones
    const bankChips = [
      ...root.querySelectorAll(
        '[draggable="true"], .ui-draggable, [class*="drag-item"], [class*="word-chip"], [class*="chip"], [class*="tile"], [class*="token"], [class*="dnd_item"], [class*="dnd-item"], [class*="palette_item"], [class*="palette-item"], .word-bank > *, .wordbank > *, .bank > *, .pool > *, [class*="palette"] > *, [class*="word-pool"] > *'
      ),
    ]
      .filter((el) => !isElementHidden(el))
      .map((el) => cleanInlineText(el.textContent))
      .filter((t) => t.length >= 1 && t.length <= 80 && !DROPZONE_TEXT_RE.test(t));
    const uniqueBank = [...new Set(bankChips)].slice(0, 32);

    const rawDropEls = [...root.querySelectorAll('span, div, button, p, [aria-dropeffect], [data-droppable], [data-dropzone]')]
      .filter((el) => !isElementHidden(el) && isDropzonePlaceholderNode(el));
    // Collapse nested placeholder spans inside outer droppable wrappers to one logical blank each
    const dropEls = rawDropEls.filter((el) => !rawDropEls.some((other) => other !== el && other.contains(el)));

    // Detect category sorting columns/boxes (e.g. columns labeled "Plato", "Epicurus" with "drag item here" dropzones)
    const categoryColumns = [];
    for (const drop of dropEls) {
      const colContainer = drop.closest?.(
        '.column, .bucket, .category, .card, [class*="column"], [class*="bucket"], [class*="category"], [class*="card"], fieldset, section, td, th'
      );
      if (colContainer && colContainer !== root && colContainer !== document.body) {
        const headingEl = colContainer.querySelector?.(
          'h1, h2, h3, h4, h5, h6, strong, [class*="header"], [class*="title"], [class*="name"]'
        );
        let headingText = headingEl ? cleanInlineText(headingEl.textContent) : '';
        if (!headingText && drop.previousElementSibling) {
          headingText = cleanInlineText(drop.previousElementSibling.textContent);
        }
        if (headingText && headingText.length >= 2 && headingText.length <= 50 && !DROPZONE_TEXT_RE.test(headingText)) {
          categoryColumns.push(headingText);
        }
      }
    }
    const uniqueCategories = [...new Set(categoryColumns)];
    if (uniqueCategories.length >= 2 && uniqueBank.length >= 2) {
      addCandidate(
        `Category Sorting Drag-and-Drop: Classify word bank into columns: ${uniqueCategories.join(', ')}`,
        'drag_drop',
        uniqueBank
      );
    }

    // 5. FAQ disclosures (<details><summary>)
    const summaries = root.querySelectorAll('details > summary');
    for (const summary of summaries) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (isElementHidden(summary)) continue;
      addCandidate(summary.textContent, 'faq');
    }

    // 6. Headings, strong lines, or explicit question paragraphs ending in '?' or Q-prefixes
    const questionSelectors = 'h1, h2, h3, h4, p, div, li, dt, label, [itemprop="name"]';
    const textEls = root.querySelectorAll(questionSelectors);
    const qPrefixRe = /^(?:q(?:uestion)?\s*\d+[\s.:)-]|problem\s*\d+[\s.:)-]|task\s*\d+[\s.:)-]|\d+[.)]\s+|\d+\s+(?=[A-Z]))/i;

    for (const el of textEls) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (isElementHidden(el)) continue;
      if (el.tagName === 'DIV') {
        const blockChildren = [...(el.children || [])].filter((c) => BLOCK_TAGS.has(c.tagName));
        if (blockChildren.length > 2) continue;
      }
      if (dropEls.includes(el)) continue;
      const containedDrops = dropEls.filter((d) => el.contains(d));
      // Preserve explicit [BLANK: ...] placeholders inside candidate prompts for cloze questions
      const raw = cleanInlineText(containedDrops.length ? extractStructuredText(el) : el.textContent);
      if (raw.length < 6 || raw.length > 420) continue;
      const nonBlankText = cleanInlineText(raw.replace(/\[BLANK(?::[^\]]*)?\]/g, ''));
      const endsWithQuestion = raw.endsWith('?') || raw.endsWith('？');
      const hasQuestionPrefix = qPrefixRe.test(raw);
      if (containedDrops.length >= 1 && containedDrops.length <= 2 && nonBlankText.length >= 8) {
        if (hasQuestionPrefix || endsWithQuestion || raw.length < 280) {
          addCandidate(raw, 'drag_drop', uniqueBank);
        }
      } else if (endsWithQuestion || (hasQuestionPrefix && (el.tagName.startsWith('H') || raw.length < 280))) {
        addCandidate(raw, 'question-text');
      }
    }

    // Fallback when dropzones live inside one shared block (e.g. <br>-delimited prose)
    if (dropEls.length > 0 && uniqueBank.length > 0 && !candidates.some((c) => c.type === 'drag_drop')) {
      addCandidate(`Drag-and-drop word bank exercise (${dropEls.length} blank(s))`, 'drag_drop', uniqueBank);
    }

    return candidates;
  }

  function serializeNode(node, chunks, state) {
    if (!node || state.length >= MAX_TEXT_CHARS + 2000) return;

    if (node.nodeType === 3) {
      const text = node.textContent?.replace(/\s+/g, ' ');
      if (text && text.trim()) {
        chunks.push(text);
        state.length += text.length;
      }
      return;
    }

    if (node.nodeType !== 1) return;
    const el = node;
    if (isElementHidden(el)) return;

    const tag = el.tagName;

    if (isDropzonePlaceholderNode(el)) {
      const placeholder = cleanInlineText(el.textContent);
      const token = placeholder ? ` [BLANK: ${placeholder}] ` : ' [BLANK] ';
      chunks.push(token);
      state.length += token.length;
      return;
    }

    if (tag === 'PRE') {
      const code = (el.innerText ?? el.textContent ?? '').trim();
      if (code) {
        const block = `\n\`\`\`\n${code}\n\`\`\`\n`;
        chunks.push(block);
        state.length += block.length;
      }
      return;
    }

    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || type === 'password') return;
      if (tag === 'SELECT') {
        const opts = [...el.querySelectorAll('option')].map((o) => cleanInlineText(o.textContent)).filter(Boolean);
        if (opts.length) {
          const line = ` [Options: ${opts.slice(0, 12).join(' | ')}] `;
          chunks.push(line);
          state.length += line.length;
        }
      } else if (tag === 'TEXTAREA' || ['text', 'email', 'number', 'search', 'url', ''].includes(type)) {
        const hint = cleanInlineText(
          el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
        );
        const line = hint ? ` [Input: ${hint}] ` : ' [Input field] ';
        chunks.push(line);
        state.length += line.length;
      }
      return;
    }

    if (tag === 'TR') {
      const cells = [...el.children]
        .filter((c) => c.tagName === 'TH' || c.tagName === 'TD')
        .map((c) => cleanInlineText(c.innerText ?? c.textContent))
        .filter(Boolean);
      if (cells.length) {
        const row = `\n| ${cells.join(' | ')} |`;
        chunks.push(row);
        state.length += row.length;
      }
      return;
    }

    const isHeading = /^H[1-6]$/.test(tag);
    if (isHeading) {
      const level = Number(tag[1]);
      const headingText = cleanInlineText(el.innerText ?? el.textContent);
      if (headingText) {
        const line = `\n${'#'.repeat(level)} ${headingText}\n`;
        chunks.push(line);
        state.length += line.length;
      }
      return;
    }

    if (tag === 'LI') {
      chunks.push('\n- ');
      state.length += 3;
      for (const child of el.childNodes) {
        serializeNode(child, chunks, state);
      }
      chunks.push('\n');
      state.length += 1;
      return;
    }

    const role = el.getAttribute?.('role');
    const isBlock =
      BLOCK_TAGS.has(tag) ||
      tag === 'BUTTON' ||
      role === 'button' ||
      role === 'option' ||
      role === 'listitem';
    const isChip =
      el.getAttribute?.('draggable') === 'true' ||
      DRAGGABLE_CLASS_RE.test(el.getAttribute?.('class') || '');
    if (isBlock) {
      chunks.push('\n');
      state.length += 1;
    } else if (isChip) {
      chunks.push(' [');
      state.length += 2;
    }

    for (const child of el.childNodes) {
      serializeNode(child, chunks, state);
    }

    if (isBlock) {
      chunks.push('\n');
      state.length += 1;
    } else if (isChip) {
      chunks.push('] ');
      state.length += 2;
    }
  }

  function extractStructuredText(root) {
    const chunks = [];
    const state = { length: 0 };
    serializeNode(root, chunks, state);
    const raw = chunks
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return raw;
  }

  function getNodeBoxSize(el) {
    try {
      if (typeof el.getBoundingClientRect === 'function') {
        const rect = el.getBoundingClientRect();
        if (rect && (rect.width > 0 || rect.height > 0)) {
          return { width: rect.width, height: rect.height };
        }
      }
    } catch {
      // Ignore layout measurement errors.
    }
    const width = Number(el.getAttribute?.('width') || el.naturalWidth || el.width || 0);
    const height = Number(el.getAttribute?.('height') || el.naturalHeight || el.height || 0);
    return { width, height };
  }

  function isDecorativeImageCandidate(img, box) {
    const w = box.width || Number(img.naturalWidth || 0);
    const h = box.height || Number(img.naturalHeight || 0);
    if (w > 0 && h > 0 && (w < 140 || h < 80)) return true;
    const hintStr = [
      img.getAttribute?.('class') || '',
      img.getAttribute?.('alt') || '',
      img.getAttribute?.('src') || '',
    ].join(' ');
    if (/\b(?:logo|avatar|spinner|favicon|icon|emoji|badge)\b/i.test(hintStr) && w < 260 && h < 140) {
      return true;
    }
    return false;
  }

  function collectVisualInventory(root) {
    if (!root) {
      return {
        imageCount: 0,
        canvasCount: 0,
        svgCount: 0,
        visualHints: [],
        visualImages: [],
        hasVisualContent: false,
      };
    }

    const visualHints = [];
    const visualImages = [];
    const seenHints = new Set();
    const seenVisualSources = new Set();
    let imageCount = 0;

    for (const img of root.querySelectorAll('img')) {
      if (isElementHidden(img)) continue;
      const box = getNodeBoxSize(img);
      const explicitTiny = box.width > 0 && box.height > 0 && (box.width < 48 || box.height < 48);
      if (explicitTiny) continue;
      imageCount++;

      const figureCaption = img.closest?.('figure')?.querySelector?.('figcaption')?.textContent || '';
      const rawHint =
        img.getAttribute?.('alt') ||
        img.getAttribute?.('aria-label') ||
        figureCaption ||
        img.getAttribute?.('title') ||
        '';
      const cleaned = cleanInlineText(rawHint);
      if (cleaned && !seenHints.has(cleaned.toLowerCase()) && visualHints.length < 10) {
        seenHints.add(cleaned.toLowerCase());
        visualHints.push(cleaned.slice(0, 200));
      }

      const rawSrc = img.currentSrc || img.src || img.getAttribute?.('src') || '';
      if (
        rawSrc &&
        !isDecorativeImageCandidate(img, box) &&
        !seenVisualSources.has(rawSrc) &&
        visualImages.length < 6
      ) {
        seenVisualSources.add(rawSrc);
        visualImages.push({
          kind: 'img',
          src: rawSrc,
          alt: cleaned.slice(0, 140),
          width: Math.round(box.width || Number(img.naturalWidth || 0)),
          height: Math.round(box.height || Number(img.naturalHeight || 0)),
        });
      }
    }

    let canvasCount = 0;
    for (const canvas of root.querySelectorAll('canvas')) {
      if (isRenderNodeHidden(canvas)) continue;
      const box = getNodeBoxSize(canvas);
      if (box.width === 0 || (box.width >= 60 && box.height >= 40)) {
        canvasCount++;
        const canvasHint = cleanInlineText(canvas.getAttribute?.('aria-label') || canvas.getAttribute?.('title') || '');
        if (canvasHint && !seenHints.has(canvasHint.toLowerCase()) && visualHints.length < 10) {
          seenHints.add(canvasHint.toLowerCase());
          visualHints.push(canvasHint.slice(0, 200));
        }
        if ((box.width >= 160 && box.height >= 100) && visualImages.length < 6) {
          try {
            if (typeof canvas.toDataURL === 'function') {
              const dataUrl = canvas.toDataURL('image/png');
              if (dataUrl && dataUrl.startsWith('data:image/') && !seenVisualSources.has(dataUrl)) {
                seenVisualSources.add(dataUrl);
                visualImages.push({
                  kind: 'canvas',
                  dataUrl,
                  alt: canvasHint.slice(0, 140),
                  width: Math.round(box.width),
                  height: Math.round(box.height),
                });
              }
            }
          } catch {
            // Tainted canvas cannot be exported directly; viewport capture covers it.
          }
        }
      }
    }

    let svgCount = 0;
    for (const svg of root.querySelectorAll('svg')) {
      if (isRenderNodeHidden(svg)) continue;
      const box = getNodeBoxSize(svg);
      if (box.width >= 80 && box.height >= 60) {
        svgCount++;
      }
    }

    const hasVisualContent = imageCount > 0 || canvasCount > 0 || svgCount > 0;
    return { imageCount, canvasCount, svgCount, visualHints, visualImages, hasVisualContent };
  }

  function fnv1aHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function scanActiveDocument() {
    const url = location.href || '';
    const title = (document.title || '').trim();
    const lang = document.documentElement?.lang || '';
    const contentType = (document.contentType || 'text/html').toLowerCase();

    if (contentType === 'application/pdf') {
      return {
        kind: 'visual_only',
        reason: 'pdf',
        url,
        title: title || 'PDF Document',
        lang,
        text: '',
        totalChars: 0,
        truncated: false,
        selection: '',
        description: '',
        questionCandidates: [],
        mediaSummary: { imageCount: 0, canvasCount: 0, svgCount: 0, visualHints: [], hasVisualContent: true },
        contentHash: fnv1aHash('pdf|' + url + '|' + title),
        scannedAt: Date.now(),
      };
    }

    if (contentType.startsWith('image/')) {
      return {
        kind: 'visual_only',
        reason: 'image',
        url,
        title: title || 'Image Document',
        lang,
        text: '',
        totalChars: 0,
        truncated: false,
        selection: '',
        description: '',
        questionCandidates: [],
        mediaSummary: { imageCount: 1, canvasCount: 0, svgCount: 0, visualHints: [], hasVisualContent: true },
        contentHash: fnv1aHash('image|' + url + '|' + title),
        scannedAt: Date.now(),
      };
    }

    const body = document.body;
    if (!body) {
      return {
        kind: 'empty',
        url,
        title,
        lang,
        text: '',
        totalChars: 0,
        truncated: false,
        selection: '',
        description: '',
        questionCandidates: [],
        mediaSummary: { imageCount: 0, canvasCount: 0, svgCount: 0, visualHints: [], hasVisualContent: false },
        contentHash: fnv1aHash(url + '|' + title),
        scannedAt: Date.now(),
      };
    }

    const description =
      document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
    const selection = (window.getSelection?.()?.toString() || '').trim().slice(0, 4000);

    // Prefer <main> / [role="main"] if substantial, else full body
    const mainEl = document.querySelector('main, [role="main"]');
    let fullText = '';
    if (mainEl && !isElementHidden(mainEl)) {
      const mainText = extractStructuredText(mainEl);
      if (mainText.length >= 250) {
        fullText = mainText;
        // Also capture any forms outside mainEl (e.g., side quizzes)
        const outsideForms = [...document.querySelectorAll('form')].filter(
          (form) => !mainEl.contains(form) && !isElementHidden(form)
        );
        if (outsideForms.length) {
          const formTexts = outsideForms.map((f) => extractStructuredText(f)).filter(Boolean);
          if (formTexts.length) {
            fullText += '\n\n' + formTexts.join('\n\n');
          }
        }
      }
    }

    if (!fullText) {
      fullText = extractStructuredText(body);
    }

    const totalChars = fullText.length;
    const truncated = totalChars > MAX_TEXT_CHARS;
    const text = truncated ? fullText.slice(0, MAX_TEXT_CHARS) : fullText;

    const questionCandidates = extractQuestionCandidates(body);
    const mediaSummary = collectVisualInventory(mainEl || body);

    const hashSeed = [
      url,
      title,
      selection,
      text.slice(0, 12000),
      questionCandidates.map((c) => c.prompt).join('|'),
      `${mediaSummary.imageCount}:${mediaSummary.canvasCount}:${mediaSummary.svgCount}`,
    ].join('\n');

    let kind = 'empty';
    let reason;
    if (text.length > 0 || questionCandidates.length > 0 || selection.length > 0) {
      kind = 'ready';
    } else if (mediaSummary.hasVisualContent) {
      kind = 'visual_only';
      reason = 'visual-dom';
    }

    return {
      kind,
      ...(reason ? { reason } : {}),
      url,
      title: title || url,
      lang,
      description,
      selection,
      text,
      totalChars,
      truncated,
      questionCandidates,
      mediaSummary,
      contentHash: fnv1aHash(hashSeed),
      scannedAt: Date.now(),
    };
  }

  return scanActiveDocument();
})();
