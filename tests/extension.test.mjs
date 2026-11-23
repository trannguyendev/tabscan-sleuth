import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_MODELS,
  DEFAULT_SETTINGS,
  GEMINI_MODELS,
  PROVIDERS,
  STORAGE_KEYS,
  formatHost,
  getUrlRestrictionReason,
  isScannableUrl,
  resolveActiveModel,
} from '../shared/constants.js';
import {
  GeminiApiError,
  analyzePageQuestions,
  buildPageContextPrompt,
  collectSnapshotImageParts,
  detectProvider,
  extractTextFromInteraction,
  fetchAvailableModels,
  parseScreenshotInput,
  parseSseStream,
  streamCustomQuestion,
  testApiKey,
  fetchWithRetry,
  parseRetryAfter,
} from '../shared/gemini-client.js';
import { computeScrollPositions, mergeFrameActionResults, mergeFrameSnapshots } from '../shared/frame-helpers.js';
import { renderMarkdown } from '../shared/markdown.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Minimal zero-dependency DOM harness for testing page-scanner.js, page-actions.js & markdown.js
// ---------------------------------------------------------------------------

function createMiniDom({
  url = 'https://example.com/quiz',
  title = 'Sample Page',
  lang = 'en',
  contentType = 'text/html',
  selection = '',
  enableCssHighlights = false,
} = {}) {
  class MiniDataTransfer {
    constructor() {
      this._store = new Map();
    }
    get types() {
      return [...this._store.keys()];
    }
    setData(type, val) {
      this._store.set(String(type), String(val));
    }
    getData(type) {
      return this._store.get(String(type)) || '';
    }
  }

  class MiniEvent {
    constructor(type, init = {}) {
      this.type = String(type);
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.clientX = init.clientX ?? 0;
      this.clientY = init.clientY ?? 0;
      this.button = init.button ?? 0;
      this.buttons = init.buttons ?? 0;
      this.which = init.which ?? 0;
      this.dataTransfer = init.dataTransfer;
      this.target = null;
      this.defaultPrevented = false;
      this.cancelBubble = false;
    }

    preventDefault() {
      this.defaultPrevented = true;
    }

    stopPropagation() {
      this.cancelBubble = true;
    }
  }

  class MiniNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.childNodes = [];
    }

    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }

    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx !== -1 && idx + 1 < this.parentNode.childNodes.length
        ? this.parentNode.childNodes[idx + 1]
        : null;
    }

    get previousSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
    }

    appendChild(child) {
      if (child.nodeType === 11) {
        for (const grand of [...child.childNodes]) {
          this.appendChild(grand);
        }
        child.childNodes = [];
        return child;
      }
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }

    insertBefore(newNode, refNode = null) {
      if (!refNode) return this.appendChild(newNode);
      const idx = this.childNodes.indexOf(refNode);
      if (idx === -1) return this.appendChild(newNode);
      if (newNode.nodeType === 11) {
        const moved = [...newNode.childNodes];
        newNode.childNodes = [];
        for (const grand of moved) {
          grand.parentNode = this;
        }
        this.childNodes.splice(idx, 0, ...moved);
        return newNode;
      }
      if (newNode.parentNode) {
        newNode.parentNode.removeChild(newNode);
      }
      newNode.parentNode = this;
      const insertAt = this.childNodes.indexOf(refNode);
      this.childNodes.splice(insertAt === -1 ? this.childNodes.length : insertAt, 0, newNode);
      return newNode;
    }

    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) {
        this.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    }

    replaceWith(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      const expanded = [];
      for (const node of nodes) {
        if (node && node.nodeType === 11) {
          for (const grand of [...node.childNodes]) {
            grand.parentNode = parent;
            expanded.push(grand);
          }
          node.childNodes = [];
        } else if (node) {
          if (node.parentNode) node.parentNode.removeChild(node);
          node.parentNode = parent;
          expanded.push(node);
        }
      }
      const idx = parent.childNodes.indexOf(this);
      if (idx !== -1) {
        this.parentNode = null;
        parent.childNodes.splice(idx, 1, ...expanded);
      }
    }

    normalize() {
      const merged = [];
      for (const child of this.childNodes) {
        if (child.nodeType === 3 && merged.length > 0 && merged[merged.length - 1].nodeType === 3) {
          merged[merged.length - 1].textContent += child.textContent;
        } else {
          merged.push(child);
        }
      }
      this.childNodes = merged;
    }

    replaceChildren(...nodes) {
      for (const old of this.childNodes) {
        old.parentNode = null;
      }
      this.childNodes = [];
      for (const n of nodes) {
        this.appendChild(n);
      }
    }
  }

  class MiniText extends MiniNode {
    constructor(text) {
      super(3);
      this._text = String(text);
    }

    get textContent() {
      return this._text;
    }

    set textContent(v) {
      this._text = String(v);
    }

    cloneNode() {
      return new MiniText(this._text);
    }
  }

  class MiniFragment extends MiniNode {
    constructor() {
      super(11);
    }
  }

  class MiniElement extends MiniNode {
    constructor(tagName, attrs = {}, doc = null) {
      super(1);
      this.tagName = tagName.toUpperCase();
      this.attrs = { ...attrs };
      this.hidden = Boolean(attrs.hidden);
      this._checked = Boolean(attrs.checked);
      this._selected = Boolean(attrs.selected);
      this._value = attrs.value !== undefined ? String(attrs.value) : '';
      this.styleDisplay = '';
      this.styleVisibility = '';
      this.listeners = new Map();
      this.dispatchedEvents = [];
      this.focused = false;
      this.scrolled = false;
      this.mockRect = null;
      this.ownerDocument = doc;
      this.tabIndex = 0;
    }

    get previousElementSibling() {
      if (!this.parentNode) return null;
      const elems = this.parentNode.children || [];
      const idx = elems.indexOf(this);
      return idx > 0 ? elems[idx - 1] : null;
    }

    getBoundingClientRect() {
      return this.mockRect || { left: 0, top: 0, width: 0, height: 0 };
    }

    get id() {
      return this.attrs.id || '';
    }

    get type() {
      return this.attrs.type || '';
    }

    set type(val) {
      this.attrs.type = String(val);
    }

    get className() {
      return this.attrs.class || '';
    }

    set className(val) {
      this.attrs.class = String(val);
    }

    get classList() {
      const el = this;
      const getTokens = () => (el.attrs.class || '').split(/\s+/).filter(Boolean);
      const setTokens = (tokens) => {
        if (tokens.length === 0) {
          delete el.attrs.class;
        } else {
          el.attrs.class = tokens.join(' ');
        }
      };
      return {
        add(...names) {
          const tokens = getTokens();
          for (const n of names) {
            if (n && !tokens.includes(n)) tokens.push(n);
          }
          setTokens(tokens);
        },
        remove(...names) {
          const removeSet = new Set(names);
          setTokens(getTokens().filter((t) => !removeSet.has(t)));
        },
        contains(name) {
          return getTokens().includes(name);
        },
      };
    }

    get checked() {
      return this._checked;
    }

    set checked(val) {
      this._checked = Boolean(val);
      if (this._checked && this.tagName === 'INPUT' && this.type === 'radio' && this.attrs.name && this.ownerDocument) {
        for (const other of this.ownerDocument.querySelectorAll(`input[type="radio"]`)) {
          if (other !== this && other.attrs.name === this.attrs.name) {
            other._checked = false;
          }
        }
      }
    }

    get selected() {
      return this._selected;
    }

    set selected(val) {
      this._selected = Boolean(val);
    }

    get value() {
      if (this.tagName === 'OPTION' && !Object.prototype.hasOwnProperty.call(this.attrs, 'value') && !this._value) {
        return this.textContent;
      }
      return this._value;
    }

    set value(val) {
      this._value = String(val);
    }

    get href() {
      return this.attrs.href || '';
    }

    set href(val) {
      this.attrs.href = String(val);
    }

    get target() {
      return this.attrs.target || '';
    }

    set target(val) {
      this.attrs.target = String(val);
    }

    get rel() {
      return this.attrs.rel || '';
    }

    set rel(val) {
      this.attrs.rel = String(val);
    }

    get children() {
      return this.childNodes.filter((n) => n.nodeType === 1);
    }

    get textContent() {
      return this.childNodes.map((n) => n.textContent).join('');
    }

    set textContent(val) {
      this.childNodes = [new MiniText(val)];
    }

    cloneNode(deep = false) {
      const copy = new MiniElement(this.tagName.toLowerCase(), { ...this.attrs }, this.ownerDocument);
      copy.hidden = this.hidden;
      copy._checked = this._checked;
      copy._selected = this._selected;
      copy._value = this._value;
      copy.styleDisplay = this.styleDisplay;
      copy.styleVisibility = this.styleVisibility;
      if (deep) {
        for (const child of this.childNodes) {
          copy.appendChild(child.cloneNode(true));
        }
      }
      return copy;
    }

    getAttribute(name) {
      if (name === 'class' && this.attrs.class !== undefined) return this.attrs.class;
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
    }

    setAttribute(name, val) {
      this.attrs[name] = String(val);
    }

    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }

    dispatchEvent(evt) {
      const eventObj = typeof evt === 'string' ? new MiniEvent(evt) : evt;
      const type = eventObj.type;
      if (!eventObj.target) eventObj.target = this;
      this.dispatchedEvents.push(type);
      for (const fn of this.listeners.get(type) || []) {
        fn(eventObj);
      }
      if (eventObj.bubbles) {
        if (this.parentNode && typeof this.parentNode.dispatchEvent === 'function') {
          this.parentNode.dispatchEvent(eventObj);
        } else if (this.ownerDocument && typeof this.ownerDocument.dispatchEvent === 'function') {
          this.ownerDocument.dispatchEvent(eventObj);
        }
      }
      return true;
    }

    focus() {
      this.focused = true;
    }

    scrollIntoView() {
      this.scrolled = true;
    }

    click() {
      this.dispatchedEvents.push('click');
      for (const fn of this.listeners.get('click') || []) {
        fn({ target: this, type: 'click' });
      }
    }

    contains(other) {
      if (this === other) return true;
      for (const child of this.children) {
        if (child.contains(other)) return true;
      }
      return false;
    }

    matches(selector) {
      const trimmed = selector.trim();
      if (trimmed.includes(',')) {
        return trimmed.split(',').some((part) => this.matches(part));
      }
      if (trimmed.includes('>')) {
        const [parentSel, childSel] = trimmed.split('>').map((s) => s.trim());
        return Boolean(this.parentNode?.nodeType === 1 && this.matches(childSel) && this.parentNode.matches(parentSel));
      }

      const tagMatch = trimmed.match(/^([a-zA-Z0-9]+)/);
      let rest = trimmed;
      if (tagMatch) {
        if (this.tagName !== tagMatch[1].toUpperCase()) return false;
        rest = trimmed.slice(tagMatch[1].length);
      }

      const notMatches = [...rest.matchAll(/:not\(([^)]+)\)/g)];
      for (const nm of notMatches) {
        if (this.matches(nm[1])) return false;
      }
      rest = rest.replace(/:not\([^)]+\)/g, '');

      const classMatches = [...rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
      const clsTokens = (this.attrs.class || '').split(/\s+/).filter(Boolean);
      for (const m of classMatches) {
        if (!clsTokens.includes(m[1])) return false;
      }

      const attrMatches = [...rest.matchAll(/\[([^\]=*^$]+)(?:([*^$]?=)"([^"]*)")?\]/g)];
      for (const m of attrMatches) {
        const attrName = m[1].trim();
        const op = m[2];
        const attrVal = m[3];
        const actual = this.getAttribute(attrName);
        if (actual === null) return false;
        if (op === '=') {
          if (actual !== attrVal) return false;
        } else if (op === '*=') {
          if (!actual.includes(attrVal)) return false;
        } else if (op === '^=') {
          if (!actual.startsWith(attrVal)) return false;
        } else if (op === '$=') {
          if (!actual.endsWith(attrVal)) return false;
        }
      }

      return true;
    }

    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }

    querySelectorAll(selector) {
      const results = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) results.push(child);
          walk(child);
        }
      };
      walk(this);
      return results;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  class MiniRange {
    constructor() {
      this.startContainer = null;
      this.startOffset = 0;
      this.endContainer = null;
      this.endOffset = 0;
    }

    setStart(node, offset) {
      this.startContainer = node;
      this.startOffset = offset;
    }

    setEnd(node, offset) {
      this.endContainer = node;
      this.endOffset = offset;
    }
  }

  class MiniHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  }

  const docListeners = new Map();
  const doc = {
    title,
    contentType,
    documentElement: null,
    head: null,
    body: null,
    addEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
    dispatchEvent(evt) {
      const eventObj = typeof evt === 'string' ? new MiniEvent(evt) : evt;
      for (const fn of docListeners.get(eventObj.type) || []) {
        fn(eventObj);
      }
      return true;
    },
    createElement(tag, attrs = {}, children = []) {
      const node = new MiniElement(tag, attrs, doc);
      for (const child of children) {
        if (typeof child === 'string') {
          node.appendChild(new MiniText(child));
        } else {
          node.appendChild(child);
        }
      }
      return node;
    },
    createTextNode(text) {
      return new MiniText(text);
    },
    createDocumentFragment() {
      return new MiniFragment();
    },
    getElementById(id) {
      return doc.documentElement.querySelector(`[id="${id}"]`);
    },
    querySelector(sel) {
      return doc.documentElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      return doc.documentElement.querySelectorAll(sel);
    },
  };

  if (enableCssHighlights) {
    doc.createTreeWalker = (root, whatToShow) => {
      const list = [];
      const walk = (n) => {
        if (n.nodeType === 3 && (whatToShow & 4)) list.push(n);
        for (const c of n.childNodes || []) walk(c);
      };
      walk(root);
      let idx = -1;
      return {
        nextNode() {
          idx += 1;
          return idx < list.length ? list[idx] : null;
        },
      };
    };
  }

  doc.documentElement = doc.createElement('html', { lang });
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  const win = {
    innerHeight: 900,
    getComputedStyle(el) {
      return {
        display: el.styleDisplay || 'block',
        visibility: el.styleVisibility || 'visible',
      };
    },
    getSelection() {
      return {
        toString() {
          return selection;
        },
      };
    },
  };

  const cssGlobal = {
    escape: (s) => s,
  };
  if (enableCssHighlights) {
    cssGlobal.highlights = new Map();
  }

  const globals = {
    document: doc,
    window: win,
    location: { href: url },
    CSS: cssGlobal,
    Event: MiniEvent,
    MouseEvent: MiniEvent,
    PointerEvent: MiniEvent,
    DragEvent: MiniEvent,
    DataTransfer: MiniDataTransfer,
    NodeFilter: { SHOW_TEXT: 4 },
  };
  if (enableCssHighlights) {
    globals.Range = MiniRange;
    globals.Highlight = MiniHighlight;
  }
  return globals;
}

function makeSseStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Manifest, icons, and MV3 static hygiene
// ---------------------------------------------------------------------------

test('manifest.json conforms to MV3 side-panel architecture and valid PNG icons', async () => {
  const raw = await fs.readFile(path.join(ROOT_DIR, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(
    manifest.permissions.slice().sort(),
    ['contextMenus', 'scripting', 'sidePanel', 'storage', 'tabs']
  );
  assert.ok(manifest.host_permissions.includes('<all_urls>'));
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.side_panel.default_path, 'sidepanel/sidepanel.html');
  assert.equal(manifest.action.default_popup, undefined);

  for (const size of [16, 32, 48, 128]) {
    const iconRel = manifest.icons[String(size)];
    assert.ok(iconRel, `Missing icon entry for ${size}`);
    const buf = await fs.readFile(path.join(ROOT_DIR, iconRel));
    // Check PNG signature & IHDR width/height bytes
    assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, size);
    assert.equal(height, size);
  }
});

test('sidepanel.html contains no inline scripts or inline event handlers', async () => {
  const html = await fs.readFile(path.join(ROOT_DIR, 'sidepanel', 'sidepanel.html'), 'utf8');
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(inlineScripts.length > 0, 'Expected module script tag');
  for (const [, attrs, body] of inlineScripts) {
    assert.match(attrs, /\bsrc="/i);
    assert.equal(body.trim(), '', 'MV3 extension pages must not have inline script bodies');
  }
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'No inline on* handlers allowed');
});

// ---------------------------------------------------------------------------
// 2. Shared constants & URL rules
// ---------------------------------------------------------------------------

test('URL restriction checks and model resolution work as expected', () => {
  assert.equal(isScannableUrl('https://developer.mozilla.org/en-US/'), true);
  assert.equal(isScannableUrl('http://localhost:3000/quiz'), true);
  assert.equal(isScannableUrl('file:///C:/notes/questions.html'), true);

  assert.equal(isScannableUrl('chrome://settings'), false);
  assert.equal(isScannableUrl('chrome-extension://abcdef/sidepanel.html'), false);
  assert.equal(isScannableUrl('about:blank'), false);
  assert.equal(isScannableUrl('https://chromewebstore.google.com/detail/xyz'), false);
  assert.match(getUrlRestrictionReason('chrome://extensions') || '', /cannot be scanned/i);
  assert.match(getUrlRestrictionReason('') || '', /no readable URL/i);

  assert.equal(formatHost('https://www.khanacademy.org/math'), 'khanacademy.org');
  assert.equal(formatHost('file:///tmp/test.html'), 'Local file');
  assert.equal(formatHost('not a url'), '');

  assert.equal(resolveActiveModel({ model: 'gemini-3.8-flash' }), 'gemini-3.8-flash');
  assert.equal(
    resolveActiveModel({ model: 'custom', customModel: 'gemini-4-argon-custom' }),
    'gemini-4-argon-custom'
  );
  assert.equal(resolveActiveModel({}), DEFAULT_SETTINGS.model);
  assert.equal(DEFAULT_SETTINGS.scanScreen, true);
  assert.equal(DEFAULT_SETTINGS.autoHighlight, true);
  assert.equal(DEFAULT_SETTINGS.autoApply, false);
  assert.ok(GEMINI_MODELS.some((m) => m.id === 'gemini-3.8-flash'));
  assert.ok(STORAGE_KEYS.SETTINGS);
});

// ---------------------------------------------------------------------------
// 3. Page scanner script (vm sandbox execution)
// ---------------------------------------------------------------------------

test('page-scanner.js extracts quiz fieldsets, ARIA choices, FAQs, questions, and skips hidden nodes', async () => {
  const scannerCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-scanner.js'), 'utf8');
  const dom = createMiniDom({
    url: 'https://quiz.example.com/module-1',
    title: 'HTTP & Security Quiz',
    selection: 'Why does SameSite=Lax protect cookies?',
  });
  const { document: doc } = dom;

  const meta = doc.createElement('meta', {
    name: 'description',
    content: 'Practice quiz covering HTTP and Web security.',
  });
  doc.head.appendChild(meta);

  const main = doc.createElement('main', {}, [
    doc.createElement('h1', {}, ['Module 1 Assessment']),
    doc.createElement('p', {}, [
      'Review the questions below carefully. Every question has either a single best answer, multiple answers, or an explanation.',
    ]),
    doc.createElement('fieldset', {}, [
      doc.createElement('legend', {}, ['1. Which HTTP status code indicates rate limiting?']),
      doc.createElement('label', {}, [
        doc.createElement('input', { type: 'radio', name: 'q1' }),
        ' 403 Forbidden',
      ]),
      doc.createElement('label', {}, [
        doc.createElement('input', { type: 'radio', name: 'q1' }),
        ' 429 Too Many Requests',
      ]),
    ]),
    doc.createElement('div', { role: 'radiogroup', 'aria-label': 'Which protocol encrypts HTTPS?' }, [
      doc.createElement('div', { role: 'radio' }, ['TLS']),
      doc.createElement('div', { role: 'radio' }, ['FTP']),
    ]),
    doc.createElement('details', {}, [
      doc.createElement('summary', {}, ['How is CORS enforced by browsers?']),
      doc.createElement('p', {}, ['Browsers inspect Access-Control-Allow-Origin headers before exposing responses.']),
    ]),
    doc.createElement('p', {}, ['What does idempotency mean in REST APIs?']),
    doc.createElement('pre', {}, ['GET /items/42 HTTP/1.1']),
  ]);

  const hiddenSecret = doc.createElement('div', { hidden: true }, [
    'Hidden modal text that must never appear in scan output.',
  ]);
  const hiddenCss = doc.createElement('p', {}, ['Display none secret question?']);
  hiddenCss.styleDisplay = 'none';

  doc.body.appendChild(main);
  doc.body.appendChild(hiddenSecret);
  doc.body.appendChild(hiddenCss);

  const result = vm.runInNewContext(scannerCode, dom);

  assert.equal(result.kind, 'ready');
  assert.equal(result.title, 'HTTP & Security Quiz');
  assert.equal(result.description, 'Practice quiz covering HTTP and Web security.');
  assert.equal(result.selection, 'Why does SameSite=Lax protect cookies?');
  assert.equal(result.truncated, false);
  assert.match(result.contentHash, /^[0-9a-f]{8}$/);

  assert.match(result.text, /# Module 1 Assessment/);
  assert.match(result.text, /GET \/items\/42 HTTP\/1\.1/);
  assert.equal(result.text.includes('Hidden modal text'), false);
  assert.equal(result.text.includes('Display none secret'), false);

  const prompts = result.questionCandidates.map((c) => c.prompt);
  assert.ok(prompts.some((p) => p.includes('Which HTTP status code indicates rate limiting?')));
  assert.ok(prompts.some((p) => p.includes('Which protocol encrypts HTTPS?')));
  assert.ok(prompts.some((p) => p.includes('How is CORS enforced by browsers?')));
  assert.ok(prompts.some((p) => p.includes('What does idempotency mean in REST APIs?')));

  const mc = result.questionCandidates.find((c) => c.prompt.includes('status code'));
  assert.equal(mc.type, 'single-choice');
  assert.deepEqual([...mc.options], ['403 Forbidden', '429 Too Many Requests']);
});

test('page-scanner.js marks application/pdf and image/* tabs as visual_only for screen scanning', async () => {
  const scannerCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-scanner.js'), 'utf8');

  const pdfDom = createMiniDom({
    url: 'https://example.com/spec.pdf',
    title: 'Spec PDF',
    contentType: 'application/pdf',
  });
  const pdfResult = vm.runInNewContext(scannerCode, pdfDom);
  assert.equal(pdfResult.kind, 'visual_only');
  assert.equal(pdfResult.reason, 'pdf');
  assert.equal(pdfResult.mediaSummary.hasVisualContent, true);

  const imgDom = createMiniDom({
    url: 'https://example.com/diagram.png',
    title: 'Diagram PNG',
    contentType: 'image/png',
  });
  const imgResult = vm.runInNewContext(scannerCode, imgDom);
  assert.equal(imgResult.kind, 'visual_only');
  assert.equal(imgResult.reason, 'image');
  assert.equal(imgResult.mediaSummary.hasVisualContent, true);
});

test('page-scanner.js detects visual DOM elements (img/canvas) and ignores injected TabScan badges', async () => {
  const scannerCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-scanner.js'), 'utf8');
  const dom = createMiniDom({
    url: 'https://example.com/image-quiz',
    title: 'Diagram Quiz',
  });
  const { document: doc } = dom;
  const img = doc.createElement('img', {
    src: 'https://example.com/q1.png',
    alt: 'Circuit schematic question 1',
    width: '640',
    height: '360',
  });
  img.naturalWidth = 640;
  img.naturalHeight = 360;
  const canvas = doc.createElement('canvas', {
    'aria-label': 'Interactive graph problem',
    width: '500',
    height: '300',
  });
  const badge = doc.createElement('span', { 'data-tabscan-badge': 'true' }, ['✓ Q1 Answer']);
  doc.body.appendChild(img);
  doc.body.appendChild(canvas);
  doc.body.appendChild(badge);

  const result = vm.runInNewContext(scannerCode, dom);
  assert.equal(result.kind, 'visual_only');
  assert.equal(result.reason, 'visual-dom');
  assert.equal(result.mediaSummary.imageCount, 1);
  assert.equal(result.mediaSummary.canvasCount, 1);
  assert.equal(result.mediaSummary.hasVisualContent, true);
  assert.ok(result.mediaSummary.visualHints.some((h) => h.includes('Circuit schematic question 1')));
  assert.equal(result.text.includes('Q1 Answer'), false);
});

// ---------------------------------------------------------------------------
// 4. Gemini client (REST Interactions API + SSE streaming)
// ---------------------------------------------------------------------------

test('buildPageContextPrompt and extractTextFromInteraction format payloads correctly', () => {
  const prompt = buildPageContextPrompt(
    {
      title: 'Test Page',
      url: 'https://example.com',
      selection: 'Selected snippet',
      questionCandidates: [{ type: 'single-choice', prompt: '2+2?', options: ['3', '4'] }],
      text: 'A'.repeat(50),
    },
    20
  );
  assert.match(prompt, /Page Title: Test Page/);
  assert.match(prompt, /Selected snippet/);
  assert.match(prompt, /Options: \(1\) 3 \| \(2\) 4/);
  assert.match(prompt, /truncated at the configured character limit/i);

  const extracted = extractTextFromInteraction({
    steps: [
      { type: 'thought', content: [{ type: 'thought', summary: 'thinking...' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
    ],
  });
  assert.equal(extracted, 'Hello world');
});

test('analyzePageQuestions sends Interactions API v1beta payload and parses JSON schema response', async () => {
  let capturedRequest = null;
  const mockFetch = async (url, init) => {
    capturedRequest = { url, init, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        steps: [
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  page_type: 'quiz_or_form',
                  page_summary: 'A short networking quiz.',
                  questions: [
                    {
                      question: 'Which HTTP status code indicates rate limiting?',
                      question_type: 'multiple_choice',
                      options: ['403 Forbidden', '429 Too Many Requests'],
                      answer: '429 Too Many Requests',
                      explanation: 'RFC 6585 defines 429 for Too Many Requests.',
                      confidence: 'high',
                    },
                  ],
                  suggested_questions: ['How does Retry-After work?'],
                }),
              },
            ],
          },
        ],
        usage: { total_tokens: 142 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const result = await analyzePageQuestions({
    apiKey: 'AIza-test-key',
    model: 'gemini-3.8-flash',
    pageSnapshot: { title: 'Quiz', url: 'https://example.com/quiz', text: 'Question 1...' },
    thinkingLevel: 'medium',
    fetchImpl: mockFetch,
  });

  assert.equal(capturedRequest.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(capturedRequest.init.headers['x-goog-api-key'], 'AIza-test-key');
  assert.equal(capturedRequest.body.model, 'gemini-3.8-flash');
  assert.equal(capturedRequest.body.store, false);
  assert.equal(capturedRequest.body.response_format.type, 'text');
  assert.equal(capturedRequest.body.response_format.mime_type, 'application/json');
  assert.equal(capturedRequest.body.generation_config.thinking_level, 'medium');

  assert.equal(result.analysis.page_type, 'quiz_or_form');
  assert.equal(result.analysis.questions.length, 1);
  assert.equal(result.analysis.questions[0].answer, '429 Too Many Requests');
  assert.deepEqual(result.usage, { total_tokens: 142 });
});

test('analyzePageQuestions surfaces helpful GeminiApiError on missing key, 401, and 429', async () => {
  await assert.rejects(
    () => analyzePageQuestions({ apiKey: '', pageSnapshot: { text: 'hello' } }),
    (err) => err instanceof GeminiApiError && err.code === 'missing_api_key'
  );

  await assert.rejects(
    () =>
      analyzePageQuestions({
        apiKey: 'bad',
        pageSnapshot: { text: 'hello' },
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'API key not valid', status: 'UNAUTHENTICATED' } }), {
            status: 401,
          }),
      }),
    (err) => err instanceof GeminiApiError && err.status === 401 && /API key rejected/i.test(err.message)
  );

  await assert.rejects(
    () =>
      analyzePageQuestions({
        apiKey: 'ok',
        pageSnapshot: { text: 'hello' },
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }), {
            status: 429,
          }),
      }),
    (err) => err instanceof GeminiApiError && err.status === 429 && /Rate limit/i.test(err.message)
  );
});

test('streamCustomQuestion merges step.start initial text, split SSE deltas, and completion usage', async () => {
  const sseChunks = [
    ': keepalive\n\n',
    'event: interaction.created\ndata: {"event_type":"interaction.created"}\n\n',
    'event: step.start\ndata: {"event_type":"step.start","step":{"type":"model_output","content":[{"type":"text","text":"Use "}]}}\n\n',
    'event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"TLS 1.3"}}\n\n',
    'event: step.delta\ndata: {"event_type":"step.delta","delta":{"t',
    'ype":"text","text":" for encryption."}}\n\n',
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"usage":{"total_output_tokens":12}}}\n\n',
  ];

  const deltas = [];
  const res = await streamCustomQuestion({
    apiKey: 'AIza-stream',
    model: 'gemini-3.8-flash',
    pageSnapshot: { title: 'Docs', url: 'https://example.com', text: 'TLS 1.3 info' },
    history: [
      { role: 'user', text: 'Summarize TLS.' },
      { role: 'model', text: 'TLS secures transport.' },
    ],
    question: 'Which version should I use?',
    onChunk: (delta) => deltas.push(delta),
    fetchImpl: async () =>
      new Response(makeSseStream(sseChunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  });

  assert.equal(res.text, 'Use TLS 1.3 for encryption.');
  assert.deepEqual(deltas, ['Use ', 'TLS 1.3', ' for encryption.']);
  assert.deepEqual(res.usage, { total_output_tokens: 12 });
});

test('parseSseStream ignores [DONE] sentinel and handles error events in streamCustomQuestion', async () => {
  const events = [];
  const stream = makeSseStream([
    'data: {"event_type":"step.delta","delta":{"type":"text","text":"hi"}}\n\n',
    'data: [DONE]\n\n',
  ]);
  for await (const evt of parseSseStream(stream)) {
    events.push(evt);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].delta.text, 'hi');

  await assert.rejects(
    () =>
      streamCustomQuestion({
        apiKey: 'AIza-err',
        pageSnapshot: { title: 'T', url: 'https://example.com', text: 'Body' },
        question: 'Fail?',
        fetchImpl: async () =>
          new Response(
            makeSseStream([
              'data: {"event_type":"error","error":{"message":"Model overloaded","code":"unavailable"}}\n\n',
            ]),
            { status: 200 }
          ),
      }),
    (err) => err instanceof GeminiApiError && err.code === 'unavailable' && /Model overloaded/.test(err.message)
  );
});

test('testApiKey validates key with compact Interactions request', async () => {
  const result = await testApiKey({
    apiKey: 'AIza-valid',
    model: 'gemini-3.5-flash-lite',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: 'gemini-3.5-flash-lite',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'OK.' }] }],
        }),
        { status: 200 }
      ),
  });
  assert.deepEqual(result, { ok: true, model: 'gemini-3.5-flash-lite', reply: 'OK.' });
});

// ---------------------------------------------------------------------------
// 5. Safe DOM Markdown renderer
// ---------------------------------------------------------------------------

test('renderMarkdown builds safe DOM nodes, blocks javascript: links, and wires code copy handler', () => {
  const dom = createMiniDom();
  const container = dom.document.createElement('div');
  let copiedCode = '';

  renderMarkdown(
    container,
    [
      '## Answer Summary',
      '',
      'Use **TLS 1.3** and `fetch()` cleanly. Check [MDN](https://developer.mozilla.org/) or [bad](javascript:alert(1)).',
      '',
      '- First point',
      '- Second point',
      '',
      '```js',
      'const ok = true;',
      '```',
    ].join('\n'),
    {
      onCopyCode(code) {
        copiedCode = code;
      },
    }
  );

  const heading = container.querySelector('.md-heading-2');
  assert.equal(heading.textContent, 'Answer Summary');

  const strong = container.querySelector('strong');
  assert.equal(strong.textContent, 'TLS 1.3');

  const anchors = container.querySelectorAll('a');
  assert.equal(anchors.length, 1, 'Unsafe javascript: URL must not render as an <a> link');
  assert.equal(anchors[0].href, 'https://developer.mozilla.org/');
  assert.equal(anchors[0].rel, 'noopener noreferrer');

  const items = container.querySelectorAll('li');
  assert.equal(items.length, 2);

  const pre = container.querySelector('pre');
  assert.equal(pre.getAttribute('role'), 'region');
  assert.equal(pre.tabIndex, 0);
  assert.equal(pre.textContent, 'const ok = true;');

  const copyBtn = container.querySelector('button');
  copyBtn.click();
  assert.equal(copiedCode, 'const ok = true;');
});

test('parseScreenshotInput and multimodal Gemini requests attach inline image parts', async () => {
  assert.deepEqual(
    parseScreenshotInput({ dataUrl: 'data:image/jpeg;base64,AQIDBA==' }),
    { data: 'AQIDBA==', mime_type: 'image/jpeg' }
  );
  assert.deepEqual(
    parseScreenshotInput({ data: 'AQID', mimeType: 'image/png' }),
    { data: 'AQID', mime_type: 'image/png' }
  );
  assert.equal(parseScreenshotInput(null), null);

  const visualPrompt = buildPageContextPrompt({
    title: 'Diagram Quiz',
    url: 'https://example.com/diagram',
    text: '',
    screenshot: { dataUrl: 'data:image/jpeg;base64,AQIDBA==' },
    mediaSummary: {
      imageCount: 2,
      canvasCount: 1,
      svgCount: 0,
      hasVisualContent: true,
      visualHints: ['Question 1 Venn diagram'],
    },
  });
  assert.match(visualPrompt, /Visual Context: 2 image\(s\), 1 canvas element\(s\), attached viewport screenshot/);
  assert.match(visualPrompt, /Question 1 Venn diagram/);
  assert.match(visualPrompt, /inspect the attached viewport screenshot image carefully/i);

  let analyzeBody = null;
  await analyzePageQuestions({
    apiKey: 'AIza-mm',
    pageSnapshot: {
      title: 'Image Quiz',
      url: 'https://example.com/img-quiz',
      text: '',
      screenshot: { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' },
    },
    fetchImpl: async (_url, init) => {
      analyzeBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    page_type: 'quiz_or_form',
                    page_summary: 'Visual diagram quiz.',
                    questions: [],
                    suggested_questions: [],
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200 }
      );
    },
  });

  assert.ok(Array.isArray(analyzeBody.input));
  assert.equal(analyzeBody.input[0].type, 'text');
  assert.deepEqual(analyzeBody.input[1], {
    type: 'image',
    data: '/9j/4AAQ',
    mime_type: 'image/jpeg',
  });

  let streamBody = null;
  await streamCustomQuestion({
    apiKey: 'AIza-mm-stream',
    pageSnapshot: {
      title: 'PDF Problem',
      url: 'https://example.com/math.pdf',
      kind: 'visual_only',
      reason: 'pdf',
      text: '',
      screenshot: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    },
    question: 'Solve question 2 from the screenshot.',
    fetchImpl: async (_url, init) => {
      streamBody = JSON.parse(init.body);
      return new Response(
        makeSseStream([
          'data: {"event_type":"step.start","step":{"type":"model_output","content":[{"type":"text","text":"42"}]}}\n\n',
        ]),
        { status: 200 }
      );
    },
  });

  assert.equal(streamBody.input[0].type, 'user_input');
  assert.ok(Array.isArray(streamBody.input[0].content));
  assert.deepEqual(streamBody.input[0].content[1], {
    type: 'image',
    data: 'iVBORw0KGgo=',
    mime_type: 'image/png',
  });
});

// ---------------------------------------------------------------------------
// 6. In-page highlight & auto-apply actions (scripts/page-actions.js)
// ---------------------------------------------------------------------------

test('page-actions.js highlights controls and evidence quotes via <mark> fallback and clears cleanly', async () => {
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom();
  const { document: doc } = dom;

  const q1Fieldset = doc.createElement('fieldset', {}, [
    doc.createElement('legend', {}, ['1. Which status code means rate limit exceeded?']),
    doc.createElement('label', {}, [
      doc.createElement('input', { type: 'radio', name: 'q1', value: '403' }),
      ' 403 Forbidden',
    ]),
    doc.createElement('label', {}, [
      doc.createElement('input', { type: 'radio', name: 'q1', value: '429' }),
      ' 429 Too Many Requests',
    ]),
  ]);
  const quoteP = doc.createElement('p', {}, [
    'According to RFC 6585, the 429 status indicates the user has sent too many requests.',
  ]);
  doc.body.appendChild(q1Fieldset);
  doc.body.appendChild(quoteP);

  const api = vm.runInNewContext(actionsCode, dom);
  const res = api.highlightAnswers(
    [
      {
        index: 1,
        question: 'Which status code means rate limit exceeded?',
        question_type: 'multiple_choice',
        options: ['403 Forbidden', '429 Too Many Requests'],
        selected_options: ['429 Too Many Requests'],
        answer: '429 Too Many Requests',
        evidence_quote: '429 status indicates the user has sent too many requests',
      },
    ],
    { scrollToFirst: true }
  );

  assert.equal(res.ok, true);
  assert.equal(res.highlightedCount, 1);
  assert.equal(res.matchedQuestions, 1);

  const labels = q1Fieldset.querySelectorAll('label');
  assert.equal(labels[1].classList.contains('tabscan-ext-answer-highlight'), true);
  assert.equal(labels[1].scrolled, true);
  assert.ok(labels[1].querySelector('[data-tabscan-badge="true"]'));

  const marks = doc.querySelectorAll('mark[data-tabscan-mark="true"]');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].textContent, '429 status indicates the user has sent too many requests');

  api.clearHighlights();
  assert.equal(labels[1].classList.contains('tabscan-ext-answer-highlight'), false);
  assert.equal(doc.querySelectorAll('[data-tabscan-badge="true"]').length, 0);
  assert.equal(doc.querySelectorAll('mark[data-tabscan-mark="true"]').length, 0);
  assert.match(quoteP.textContent, /429 status indicates the user has sent too many requests/);
});

test('page-actions.js registers CSS.highlights when Highlight and Range APIs are available', async () => {
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom({ enableCssHighlights: true });
  const { document: doc, CSS } = dom;

  doc.body.appendChild(
    doc.createElement('section', {}, [
      doc.createElement('h2', {}, ['What encrypts HTTPS traffic?']),
      doc.createElement('p', {}, ['Modern HTTPS uses TLS 1.3 to encrypt transport payloads.']),
    ])
  );

  const api = vm.runInNewContext(actionsCode, dom);
  const res = api.highlightAnswers([
    {
      index: 1,
      question: 'What encrypts HTTPS traffic?',
      answer: 'TLS 1.3',
      evidence_quote: 'TLS 1.3 to encrypt transport payloads',
    },
  ]);

  assert.equal(res.matchedQuestions, 1);
  const entry = CSS.highlights.get('tabscan-answer');
  assert.ok(entry, 'Expected tabscan-answer Highlight registered in CSS.highlights');
  assert.equal(entry.ranges.length, 1);
  assert.equal(doc.querySelectorAll('mark[data-tabscan-mark="true"]').length, 0);

  api.clearHighlights();
  assert.equal(CSS.highlights.has('tabscan-answer'), false);
});

test('page-actions.js applies radio, multi-select checkbox, ARIA, select, safe button, and text inputs without clicking Submit', async () => {
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom();
  const { document: doc } = dom;

  let submitClicks = 0;

  // Q1: Radio button
  const q1 = doc.createElement('fieldset', {}, [
    doc.createElement('legend', {}, ['1. Which protocol encrypts HTTPS?']),
    doc.createElement('label', {}, [doc.createElement('input', { type: 'radio', name: 'q1', value: 'FTP' }), ' FTP']),
    doc.createElement('label', {}, [doc.createElement('input', { type: 'radio', name: 'q1', value: 'TLS' }), ' TLS']),
  ]);

  // Q2: Multi-select checkboxes (pre-checked wrong option must be unchecked)
  const wrongCb = doc.createElement('input', { type: 'checkbox', name: 'q2', checked: true });
  const rightCbA = doc.createElement('input', { type: 'checkbox', name: 'q2' });
  const rightCbB = doc.createElement('input', { type: 'checkbox', name: 'q2' });
  const q2 = doc.createElement('fieldset', {}, [
    doc.createElement('legend', {}, ['2. Select all safe HTTP methods:']),
    doc.createElement('label', {}, [wrongCb, ' POST']),
    doc.createElement('label', {}, [rightCbA, ' GET']),
    doc.createElement('label', {}, [rightCbB, ' HEAD']),
  ]);

  // Q3: ARIA radiogroup + Submit button that must NEVER be clicked as an option
  const ariaFtp = doc.createElement('div', { role: 'radio', 'aria-checked': 'false' }, ['XML']);
  const ariaJson = doc.createElement('div', { role: 'radio', 'aria-checked': 'false' }, ['JSON']);
  const q3 = doc.createElement('div', { role: 'radiogroup' }, [
    doc.createElement('p', {}, ['3. Which format is lighter for REST payloads?']),
    ariaFtp,
    ariaJson,
  ]);

  // Q4: <select> dropdown
  const selectEl = doc.createElement('select', {}, [
    doc.createElement('option', { value: '200' }, ['200 OK']),
    doc.createElement('option', { value: '429' }, ['429 Too Many Requests']),
  ]);
  const q4 = doc.createElement('section', {}, [
    doc.createElement('p', {}, ['4. Pick the rate-limit HTTP code:']),
    selectEl,
  ]);

  // Q5: Safe option button vs dangerous Submit button
  const choiceBtn = doc.createElement('button', { type: 'button' }, ['Idempotent']);
  const submitBtn = doc.createElement('button', { type: 'button' }, ['Submit']);
  submitBtn.addEventListener('click', () => {
    submitClicks++;
  });
  const q5 = doc.createElement('article', {}, [
    doc.createElement('p', {}, ['5. Which term describes repeated identical PUT requests?']),
    choiceBtn,
    submitBtn,
  ]);

  // Q6: Short-answer textarea
  const shortArea = doc.createElement('textarea', { name: 'q6' });
  const q6 = doc.createElement('div', { role: 'listitem' }, [
    doc.createElement('p', {}, ['6. Briefly name the TLS handshake extension for hostname routing:']),
    shortArea,
  ]);

  doc.body.appendChild(q1);
  doc.body.appendChild(q2);
  doc.body.appendChild(q3);
  doc.body.appendChild(q4);
  doc.body.appendChild(q5);
  doc.body.appendChild(q6);

  const api = vm.runInNewContext(actionsCode, dom);
  const applyRes = await api.applyAnswers(
    [
      {
        index: 1,
        question: 'Which protocol encrypts HTTPS?',
        question_type: 'multiple_choice',
        options: ['FTP', 'TLS'],
        selected_options: ['TLS'],
        answer: 'TLS',
      },
      {
        index: 2,
        question: 'Select all safe HTTP methods:',
        question_type: 'multi_select',
        options: ['POST', 'GET', 'HEAD'],
        selected_options: ['GET', 'HEAD'],
        answer: 'GET; HEAD',
      },
      {
        index: 3,
        question: 'Which format is lighter for REST payloads?',
        question_type: 'multiple_choice',
        selected_options: ['JSON'],
        answer: 'JSON',
      },
      {
        index: 4,
        question: 'Pick the rate-limit HTTP code:',
        question_type: 'multiple_choice',
        selected_options: ['429 Too Many Requests'],
        answer: '429 Too Many Requests',
      },
      {
        index: 5,
        question: 'Which term describes repeated identical PUT requests?',
        question_type: 'multiple_choice',
        selected_options: ['Idempotent'],
        answer: 'Idempotent',
      },
      {
        index: 6,
        question: 'Briefly name the TLS handshake extension for hostname routing:',
        question_type: 'short_answer',
        apply_value: 'Server Name Indication (SNI)',
        answer: 'Server Name Indication (SNI)',
      },
    ],
    { pairDelayMs: 0 }
  );

  assert.equal(applyRes.appliedCount, 6);
  assert.equal(applyRes.skippedCount, 0);

  const q1Radios = q1.querySelectorAll('input[type="radio"]');
  assert.equal(q1Radios[0].checked, false);
  assert.equal(q1Radios[1].checked, true);

  assert.equal(wrongCb.checked, false);
  assert.equal(rightCbA.checked, true);
  assert.equal(rightCbB.checked, true);

  assert.equal(ariaFtp.getAttribute('aria-checked'), 'false');
  assert.equal(ariaJson.getAttribute('aria-checked'), 'true');

  assert.equal(selectEl.value, '429');
  assert.equal(selectEl.querySelectorAll('option')[1].selected, true);

  assert.ok(choiceBtn.dispatchedEvents.includes('click'));
  assert.equal(submitClicks, 0);

  assert.equal(shortArea.value, 'Server Name Indication (SNI)');
  assert.equal(shortArea.focused, true);
  assert.ok(shortArea.dispatchedEvents.includes('input'));
  assert.ok(shortArea.dispatchedEvents.includes('change'));
  assert.ok(shortArea.dispatchedEvents.includes('blur'));
});

test('page-actions.js never highlights more than one radio option even with overlapping labels or extra selected_options', async () => {
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom();
  const { document: doc } = dom;

  const fsQuiz = doc.createElement('fieldset', {}, [
    doc.createElement('legend', {}, ['1. What permission does a read-write token grant?']),
    doc.createElement('label', {}, [
      doc.createElement('input', { type: 'radio', name: 'perm', value: 'read' }),
      ' Allows read access',
    ]),
    doc.createElement('label', {}, [
      doc.createElement('input', { type: 'radio', name: 'perm', value: 'rw' }),
      ' Allows read and write access',
    ]),
  ]);
  doc.body.appendChild(fsQuiz);

  const api = vm.runInNewContext(actionsCode, dom);
  // Even if Gemini erroneously returned multi_select or 2 selected_options for a radio group,
  // DOM single-choice exclusivity must cap highlighting to strictly 1 radio option.
  const hlRes = api.highlightAnswers([
    {
      index: 1,
      question: 'What permission does a read-write token grant?',
      question_type: 'multi_select',
      options: ['Allows read access', 'Allows read and write access'],
      selected_options: ['Allows read and write access', 'Allows read access'],
      answer: 'Allows read and write access',
      evidence_quote: 'Allows read and write access',
    },
  ]);

  assert.equal(hlRes.matchedQuestions, 1);
  const highlightedLabels = fsQuiz.querySelectorAll('.tabscan-ext-answer-highlight');
  assert.equal(highlightedLabels.length, 1);
  assert.match(highlightedLabels[0].textContent, /Allows read and write access/);
  assert.equal(doc.querySelectorAll('[data-tabscan-badge="true"]').length, 1);
  assert.equal(doc.querySelectorAll('mark[data-tabscan-mark="true"]').length, 0);
});

test('page-scanner.js and page-actions.js highlight paired matching cards and click left then right sequentially', async () => {
  const scannerCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-scanner.js'), 'utf8');
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom({
    url: 'https://example.com/vocab-match',
    title: 'Vocabulary Matching',
  });
  const { document: doc } = dom;

  const clickLog = [];
  const makeCard = (text, x, attrs = {}) => {
    const inner = doc.createElement('span', {}, [text]);
    const card = doc.createElement('div', { class: 'match-card', tabindex: '0', ...attrs }, [inner]);
    card.mockRect = { left: x, top: 100, width: 200, height: 40 };
    card.addEventListener('click', () => {
      clickLog.push(text);
    });
    return card;
  };

  // Mimic screenshot layout: already-matched pair 1 ("exploit" + its definition) vs remaining pairs
  const leftItems = ['exploit', 'rebound', 'go awry', 'pin hopes on', 'coupled with', 'set off'].map(
    (word, i) => makeCard(word, 40, i === 0 ? { class: 'match-card selected' } : {})
  );
  const rightItems = [
    'to get better; to come back to a good position after bad times',
    'to start; to put in motion',
    'to see something as a potential solution to a problem',
    "to use something to one's advantage",
    'to turn out worse than was planned',
    'together with',
  ].map((meaning, i) => makeCard(meaning, 380, i === 3 ? { class: 'match-card selected' } : {}));

  const leftCol = doc.createElement('div', { class: 'left-column' }, leftItems);
  const rightCol = doc.createElement('div', { class: 'right-column' }, rightItems);
  const heading = doc.createElement('p', {}, ['Match each word on the left with its meaning on the right.']);
  const wrapper = doc.createElement('section', { class: 'matching-exercise' }, [leftCol, rightCol]);

  doc.body.appendChild(heading);
  doc.body.appendChild(wrapper);

  const scanRes = vm.runInNewContext(scannerCode, dom);
  assert.equal(scanRes.kind, 'ready');
  assert.ok(
    scanRes.questionCandidates.some((c) => c.type === 'matching'),
    'Expected page-scanner.js to detect matching exercise candidate'
  );

  const api = vm.runInNewContext(actionsCode, dom);
  const matchingItem = {
    index: 1,
    question: 'Match each word on the left with its meaning on the right.',
    question_type: 'matching',
    matching_pairs: [
      { left: 'exploit', right: "to use something to one's advantage" },
      { left: 'rebound', right: 'to get better; to come back to a good position after bad times' },
      { left: 'go awry', right: 'to turn out worse than was planned' },
      { left: 'pin hopes on', right: 'to see something as a potential solution to a problem' },
      { left: 'coupled with', right: 'together with' },
      { left: 'set off', right: 'to start; to put in motion' },
    ],
    answer: '1. exploit -> ...',
  };

  // 1. Highlight shows distinct pair slots + M# badges without blanket <mark> highlights
  const hlRes = api.highlightAnswers([matchingItem]);
  assert.equal(hlRes.matchedQuestions, 1);
  assert.equal(hlRes.details[0].matchedPairs, 6);
  assert.equal(doc.querySelectorAll('mark[data-tabscan-mark="true"]').length, 0);
  assert.equal(leftItems[1].classList.contains('tabscan-ext-pair-1'), true);
  assert.equal(rightItems[0].classList.contains('tabscan-ext-pair-1'), true);
  assert.equal(rightItems[0].querySelector('[data-tabscan-badge="true"]').textContent, 'M2: rebound');

  // 2. Apply clicks unmatched left -> right pairs in order, skipping already-connected pair 1
  const applyRes = await api.applyAnswers([matchingItem], { pairDelayMs: 0 });
  assert.equal(applyRes.appliedCount, 1);
  assert.equal(applyRes.results[0].controlType, 'matching');
  assert.equal(applyRes.results[0].matchedPairs, 6);

  assert.deepEqual(clickLog, [
    'rebound',
    'to get better; to come back to a good position after bad times',
    'go awry',
    'to turn out worse than was planned',
    'pin hopes on',
    'to see something as a potential solution to a problem',
    'coupled with',
    'together with',
    'set off',
    'to start; to put in motion',
  ]);
});

test('page-scanner + page-actions handle word-bank drag-and-drop cloze exercises via pointer/mouse DnD', async () => {
  const scannerCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-scanner.js'), 'utf8');
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom({
    url: 'https://example.com/drag-cloze',
    title: 'Word Bank Drag and Drop',
  });
  const { document: doc } = dom;

  const bankWords = [
    'Not bad',
    'stands above the crowd',
    'savvy',
    'fruitful',
    'calculus',
    'better suited',
    'incur',
    'postulates',
  ];

  let activeDraggedWord = null;
  let movedDuringDrag = false;
  let documentMouseupCount = 0;

  const bankChips = bankWords.map((word, idx) => {
    const chip = doc.createElement('div', { class: 'word-chip ui-draggable', draggable: 'true' }, [word]);
    chip.mockRect = { left: 40 + idx * 95, top: 40, width: 88, height: 32 };
    chip.addEventListener('mousedown', (evt) => {
      assert.equal(evt.which, 1);
      assert.equal(evt.buttons, 1);
      activeDraggedWord = word;
      movedDuringDrag = false;
    });
    return chip;
  });

  doc.addEventListener('mousemove', (evt) => {
    if (activeDraggedWord) {
      assert.equal(evt.which, 1);
      assert.equal(evt.buttons, 1);
      movedDuringDrag = true;
    }
  });

  let trackDocMouseup = false;
  doc.addEventListener('mouseup', () => {
    if (trackDocMouseup) {
      documentMouseupCount += 1;
    }
  });

  const sentences = [
    {
      num: '1',
      before: " I'm renting a car. I am allowed to drive 150 miles per day with no extra charge, but for every mile beyond that I ",
      after: ' a cost of 10 cents.',
      answer: 'incur',
    },
    {
      num: '2',
      before: ' Our orchestra has a lot of good violinists, but none is as good as Eric. He really ',
      after: ' because he plays with a fantastic feel for the music.',
      answer: 'stands above the crowd',
    },
    {
      num: '3',
      before: ' The system of selling stocks in the stock market is not like most buying and selling. Your broker is willing to let you sell at any time, because the brokerage company ',
      after: ' that there is always a buyer available.',
      answer: 'postulates',
    },
    {
      num: '4',
      before: ' Any accurate ',
      after: ' of the cost of travel has to include small expenses such as snacks at airports and tips for taxi drivers.',
      answer: 'calculus',
    },
    {
      num: '5',
      before: " People are often willing to buy popcorn or cookies from a child who comes to their door selling them, even though the people wouldn't buy them online. Selling in person is very ",
      after: ' for any young person hoping to earn money for a club.',
      answer: 'fruitful',
    },
    {
      num: '6',
      before: ' I heard that the hotel is willing to cut the price to $65 per night. ',
      after: ', but I bet we can convince them to cut it even more.',
      answer: 'Not bad',
    },
    {
      num: '7',
      before: " I'm not good at creating web pages, but Carl is a very ",
      after: ' designer.',
      answer: 'savvy',
    },
    {
      num: '8',
      before: ' The job of giving the introductory speech at the conference should go to you, not me. You are confident and articulate, and you are much ',
      after: ' to that kind of thing.',
      answer: 'better suited',
    },
  ];

  const dropzones = [];
  const sentenceNodes = sentences.map((s, idx) => {
    const placeholder = doc.createElement('span', { class: 'drop-placeholder' }, ['DRAG ITEM HERE']);
    const dropzone = doc.createElement('div', { class: 'drop-slot ui-droppable' }, [placeholder]);
    dropzone.mockRect = { left: 260, top: 140 + idx * 60, width: 140, height: 32 };
    dropzone.addEventListener('mouseup', () => {
      if (activeDraggedWord && movedDuringDrag) {
        dropzone.replaceChildren(doc.createTextNode(activeDraggedWord));
        dropzone.classList.add('filled');
        activeDraggedWord = null;
        movedDuringDrag = false;
      }
    });
    dropzones.push(dropzone);

    const numStrong = doc.createElement('strong', {}, [s.num]);
    return doc.createElement('div', { class: 'cloze-item' }, [numStrong, s.before, dropzone, s.after]);
  });

  const bankContainer = doc.createElement('div', { class: 'word-bank-bar' }, bankChips);
  doc.body.appendChild(bankContainer);
  for (const row of sentenceNodes) {
    doc.body.appendChild(row);
  }

  const scanRes = vm.runInNewContext(scannerCode, dom);
  assert.equal(scanRes.kind, 'ready');
  assert.ok(scanRes.text.includes('[BLANK: DRAG ITEM HERE]'));
  const dragCandidates = scanRes.questionCandidates.filter((c) => c.type === 'drag_drop');
  assert.equal(dragCandidates.length, 8);
  assert.ok(dragCandidates[0].prompt.includes('I incur') === false);
  assert.ok(dragCandidates[0].prompt.includes('[BLANK: DRAG ITEM HERE]'));

  const api = vm.runInNewContext(actionsCode, dom);
  const items = sentences.map((s, idx) => ({
    index: idx + 1,
    question: `${s.num}${s.before}[BLANK: DRAG ITEM HERE]${s.after}`,
    question_type: 'drag_drop',
    options: bankWords,
    selected_options: [s.answer],
    apply_value: s.answer,
    answer: s.answer,
  }));

  const hlRes = api.highlightAnswers(items);
  assert.equal(hlRes.matchedQuestions, 8);
  assert.equal(hlRes.details[0].kind, 'drag_drop');
  assert.equal(hlRes.details[0].controlCount, 2);
  assert.equal(bankChips[6].querySelector('[data-tabscan-badge="true"]').textContent, 'Q1');
  assert.equal(dropzones[0].querySelector('[data-tabscan-badge="true"]').textContent, 'Q1: incur');
  assert.equal(dropzones[7].querySelector('[data-tabscan-badge="true"]').textContent, 'Q8: better suited');

  trackDocMouseup = true;
  const applyRes = await api.applyAnswers(items, { pairDelayMs: 0 });
  trackDocMouseup = false;
  assert.equal(applyRes.appliedCount, 8);
  assert.equal(applyRes.skippedCount, 0);
  // Bubbling once per drop ensures document-level DnD handlers fire once, never twice
  assert.equal(documentMouseupCount, 8);

  for (let i = 0; i < sentences.length; i += 1) {
    assert.equal(applyRes.results[i].status, 'applied');
    assert.equal(applyRes.results[i].controlType, 'drag_drop');
    assert.equal(dropzones[i].childNodes[0].textContent, sentences[i].answer);
  }
});

test('page-actions falls back to HTML5 DragEvent/DataTransfer and resolves multiple blanks inside one shared container', async () => {
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom({
    url: 'https://example.com/html5-drag-shared',
    title: 'HTML5 Drag Drop Shared Container',
  });
  const { document: doc } = dom;

  const bankWords = ['Not bad', 'savvy', 'incur'];
  const chips = bankWords.map((word, idx) => {
    const chip = doc.createElement('span', { class: 'chip', draggable: 'true', 'data-word': word }, [word]);
    chip.mockRect = { left: 40 + idx * 100, top: 30, width: 80, height: 28 };
    chip.addEventListener('dragstart', (evt) => {
      evt.dataTransfer.setData('text/plain', word);
    });
    return chip;
  });

  const makeBlank = (topY) => {
    const dz = doc.createElement('span', { class: 'drop-target' }, ['Drag item here']);
    dz.mockRect = { left: 220, top: topY, width: 120, height: 26 };
    dz.addEventListener('dragover', (evt) => {
      evt.preventDefault();
    });
    dz.addEventListener('drop', (evt) => {
      const dropped = evt.dataTransfer.getData('text/plain');
      if (dropped) {
        dz.replaceChildren(doc.createTextNode(dropped));
      }
    });
    return dz;
  };

  const dz1 = makeBlank(120);
  const dz2 = makeBlank(160);
  const dz3 = makeBlank(200);

  // One shared <div class="exercise-body"> with <br> line breaks and no individual per-question wrapper
  const sharedBody = doc.createElement('div', { class: 'exercise-body' }, [
    '1 For every mile beyond 150 I ',
    dz1,
    ' a cost of 10 cents.',
    doc.createElement('br'),
    '2 Cutting the hotel price to $65 per night. ',
    dz2,
    ', maybe we can lower it more.',
    doc.createElement('br'),
    '3 Carl is a very ',
    dz3,
    ' web designer.',
  ]);

  doc.body.appendChild(doc.createElement('div', { class: 'word-bank' }, chips));
  doc.body.appendChild(sharedBody);

  const api = vm.runInNewContext(actionsCode, dom);
  const items = [
    {
      index: 1,
      question: '1 For every mile beyond 150 I [BLANK: Drag item here] a cost of 10 cents.',
      question_type: 'drag_drop',
      options: bankWords,
      selected_options: ['incur'],
      apply_value: 'incur',
      answer: 'incur',
    },
    {
      index: 2,
      question: '2 Cutting the hotel price to $65 per night. [BLANK: Drag item here], maybe we can lower it more.',
      question_type: 'drag_drop',
      options: bankWords,
      selected_options: ['Not bad'],
      apply_value: 'Not bad',
      answer: 'Not bad',
    },
    {
      index: 3,
      question: '3 Carl is a very [BLANK: Drag item here] web designer.',
      question_type: 'drag_drop',
      options: bankWords,
      selected_options: ['savvy'],
      apply_value: 'savvy',
      answer: 'savvy',
    },
  ];

  const applyRes = await api.applyAnswers(items, { pairDelayMs: 0 });
  assert.equal(applyRes.appliedCount, 3);
  api.clearHighlights();
  assert.equal(dz1.textContent, 'incur');
  assert.equal(dz2.textContent, 'Not bad');
  assert.equal(dz3.textContent, 'savvy');
});

test('page-scanner + page-actions handle category column sorting drag-and-drop into "drag item here" dropzones (Plato vs Epicurus)', async () => {
  const scannerCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-scanner.js'), 'utf8');
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom({
    url: 'https://example.com/sorting-columns',
    title: 'Category Sorting Exercise',
  });
  const { document: doc } = dom;

  const chipsData = [
    'Garden',
    'senses',
    'hedonism',
    'taught slaves and women',
    'only citizens could be students',
    'mind must apprehend reality',
    'rationality',
    'political training',
    'senses can apprehend reality',
    'younger',
    'older',
    'Academy',
  ];

  let activeDraggedChip = null;
  const chipEls = chipsData.map((word, idx) => {
    const chip = doc.createElement('div', { class: 'word-chip ui-draggable', draggable: 'true' }, [word]);
    chip.mockRect = { left: 30 + (idx % 4) * 110, top: 40 + Math.floor(idx / 4) * 45, width: 100, height: 35 };
    chip.addEventListener('mousedown', () => {
      activeDraggedChip = word;
    });
    chip.addEventListener('dragstart', (evt) => {
      activeDraggedChip = word;
      evt.dataTransfer?.setData('text/plain', word);
    });
    return chip;
  });

  const wordBank = doc.createElement('div', { class: 'word-bank-container' }, chipEls);

  const platoDrops = [];
  const epicurusDrops = [];

  const makeCol = (name, dropList, xPos) => {
    const headerTitle = doc.createElement('h3', { class: 'column-title' }, [name]);
    const header = doc.createElement('div', { class: 'column-header' }, [headerTitle]);
    header.mockRect = { left: xPos, top: 200, width: 220, height: 40 };

    const dropText = doc.createElement('span', { class: 'placeholder' }, ['⬇ DRAG ITEM HERE']);
    const dropzone = doc.createElement('div', { class: 'drop-area ui-droppable', 'data-droppable': 'true' }, [dropText]);
    dropzone.mockRect = { left: xPos, top: 250, width: 220, height: 120 };

    const handleDrop = (item) => {
      if (item) {
        dropList.push(item);
        dropzone.appendChild(doc.createElement('div', { class: 'dropped-item' }, [item]));
      }
    };

    dropzone.addEventListener('mouseup', () => {
      if (activeDraggedChip) {
        handleDrop(activeDraggedChip);
        activeDraggedChip = null;
      }
    });
    dropzone.addEventListener('drop', (evt) => {
      const text = evt.dataTransfer?.getData('text/plain') || activeDraggedChip;
      if (text) {
        handleDrop(text);
        activeDraggedChip = null;
      }
    });

    const col = doc.createElement('div', { class: 'category-column' }, [header, dropzone]);
    col.mockRect = { left: xPos, top: 200, width: 220, height: 180 };
    return { col, dropzone, headerTitle };
  };

  const platoCol = makeCol('Plato', platoDrops, 50);
  const epicurusCol = makeCol('Epicurus', epicurusDrops, 320);

  const exerciseContainer = doc.createElement('div', { class: 'sorting-wrapper' }, [
    wordBank,
    platoCol.col,
    epicurusCol.col,
  ]);
  doc.body.appendChild(exerciseContainer);

  // 1. Scanner recognizes category columns and full word bank
  const scanRes = vm.runInNewContext(scannerCode, dom);
  assert.equal(scanRes.kind, 'ready');
  const catCandidate = scanRes.questionCandidates.find((c) =>
    c.prompt.includes('Category Sorting Drag-and-Drop')
  );
  assert.ok(catCandidate, 'Category Sorting Drag-and-Drop candidate should be detected');
  assert.ok(catCandidate.prompt.includes('Plato'));
  assert.ok(catCandidate.prompt.includes('Epicurus'));
  assert.equal(catCandidate.options.length, 12);

  // 2. Highlighting assigns chips direction badges (→ Plato, → Epicurus) and badges dropzones with item counts
  const api = vm.runInNewContext(actionsCode, dom);
  const matchingItem = {
    index: 1,
    question: 'Classify word bank into columns: Plato, Epicurus',
    question_type: 'matching',
    matching_pairs: [
      { left: 'only citizens could be students', right: 'Plato' },
      { left: 'mind must apprehend reality', right: 'Plato' },
      { left: 'rationality', right: 'Plato' },
      { left: 'political training', right: 'Plato' },
      { left: 'older', right: 'Plato' },
      { left: 'Academy', right: 'Plato' },
      { left: 'Garden', right: 'Epicurus' },
      { left: 'senses', right: 'Epicurus' },
      { left: 'hedonism', right: 'Epicurus' },
      { left: 'taught slaves and women', right: 'Epicurus' },
      { left: 'senses can apprehend reality', right: 'Epicurus' },
      { left: 'younger', right: 'Epicurus' },
    ],
  };

  const hlRes = api.highlightAnswers([matchingItem]);
  assert.equal(hlRes.matchedQuestions, 1);
  assert.equal(hlRes.details[0].matchedPairs, 12);

  // Word chips should have informative directional badges instead of generic M#
  assert.equal(chipEls[11].querySelector('[data-tabscan-badge="true"]').textContent, '→ Plato');
  assert.equal(chipEls[0].querySelector('[data-tabscan-badge="true"]').textContent, '→ Epicurus');

  // The dropzone itself (⬇ DRAG ITEM HERE) should receive the accumulated badge with item count
  const platoBadge = platoCol.dropzone.querySelector('[data-tabscan-badge="true"]');
  assert.ok(platoBadge, 'Plato dropzone should have a badge attached');
  assert.equal(platoBadge.textContent, '✓ Plato (6 items)');

  const epicurusBadge = epicurusCol.dropzone.querySelector('[data-tabscan-badge="true"]');
  assert.ok(epicurusBadge, 'Epicurus dropzone should have a badge attached');
  assert.equal(epicurusBadge.textContent, '✓ Epicurus (6 items)');

  // 3. Applying simulates DnD directly into the dropzone
  const applyRes = await api.applyAnswers([matchingItem], { pairDelayMs: 0 });
  assert.equal(applyRes.appliedCount, 1);
  assert.equal(applyRes.results[0].controlType, 'matching');
  assert.equal(applyRes.results[0].matchedPairs, 12);

  assert.equal(platoDrops.length, 6);
  assert.equal(epicurusDrops.length, 6);
  assert.ok(platoDrops.includes('Academy'));
  assert.ok(platoDrops.includes('rationality'));
  assert.ok(epicurusDrops.includes('Garden'));
  assert.ok(epicurusDrops.includes('hedonism'));
});

test('frame-helpers merge iframe exercise content and aggregate highlight/apply results across frames', () => {
  const frameResults = [
    {
      frameId: 0,
      result: {
        kind: 'ready',
        url: 'https://mel.example.com/course/player',
        title: 'MyEnglishLab - Reading',
        lang: 'en',
        description: '',
        selection: '',
        text: 'Home | Help | Sign out\nReading Writing Connection: Summarizing Attempt 1',
        totalChars: 78,
        truncated: false,
        questionCandidates: [],
        mediaSummary: { imageCount: 1, canvasCount: 0, svgCount: 0, visualHints: ['Logo'], hasVisualContent: true },
        contentHash: 'top00001',
      },
    },
    {
      frameId: 7,
      result: {
        kind: 'ready',
        url: 'https://content.example.com/activity/ex4',
        title: 'Exercise 4 More Practice',
        lang: 'en',
        description: '',
        selection: '',
        text: 'Exercise 4 More Practice\n2 People looking for jobs do not, as a rule, hire consultants.',
        totalChars: 86,
        truncated: false,
        questionCandidates: [
          {
            prompt: '2 People looking for jobs do not, as a rule, hire consultants.',
            type: 'question-text',
            options: [],
          },
        ],
        mediaSummary: { imageCount: 0, canvasCount: 0, svgCount: 0, visualHints: [], hasVisualContent: false },
        contentHash: 'sub00007',
      },
    },
    {
      frameId: 9,
      result: {
        kind: 'empty',
        text: '',
        totalChars: 0,
        questionCandidates: [],
        contentHash: 'empty009',
      },
    },
  ];

  const merged = mergeFrameSnapshots(frameResults);
  assert.equal(merged.kind, 'ready');
  assert.ok(!merged.visualOnly);
  assert.equal(merged.title, 'MyEnglishLab - Reading');
  assert.ok(merged.text.includes('[Embedded frame: Exercise 4 More Practice]'));
  assert.equal(merged.questionCandidates.length, 1);
  assert.deepEqual(merged.frameIds, [7, 0]);

  const hlMerged = mergeFrameActionResults(
    'highlightAnswers',
    [
      {
        frameId: 0,
        result: {
          ok: true,
          highlightedCount: 0,
          matchedQuestions: 0,
          totalQuestions: 2,
          details: [
            { index: 1, matched: false, controlCount: 0, rangeCount: 0 },
            { index: 2, matched: false, controlCount: 0, rangeCount: 0 },
          ],
        },
      },
      {
        frameId: 7,
        result: {
          ok: true,
          highlightedCount: 2,
          matchedQuestions: 2,
          totalQuestions: 2,
          details: [
            { index: 1, matched: true, controlCount: 0, rangeCount: 3 },
            { index: 2, matched: true, controlCount: 0, rangeCount: 2 },
          ],
        },
      },
    ],
    [{ index: 1 }, { index: 2 }]
  );

  assert.equal(hlMerged.matchedQuestions, 2);
  assert.equal(hlMerged.highlightedCount, 2);
  assert.deepEqual(hlMerged.matchedFrameIds, [7]);

  const applyMerged = mergeFrameActionResults(
    'applyAnswers',
    [
      {
        frameId: 0,
        result: {
          ok: true,
          appliedCount: 0,
          skippedCount: 2,
          totalQuestions: 2,
          results: [
            { index: 1, status: 'no_control', controlType: '' },
            { index: 2, status: 'no_control', controlType: '' },
          ],
        },
      },
      {
        frameId: 7,
        result: {
          ok: true,
          appliedCount: 2,
          skippedCount: 0,
          totalQuestions: 2,
          results: [
            { index: 1, status: 'applied', controlType: 'inline-phrase' },
            { index: 2, status: 'applied', controlType: 'inline-phrase' },
          ],
        },
      },
    ],
    [{ index: 1 }, { index: 2 }]
  );

  assert.equal(applyMerged.appliedCount, 2);
  assert.equal(applyMerged.skippedCount, 0);
  assert.deepEqual(applyMerged.matchedFrameIds, [7]);
});

test('page-scanner + page-actions highlight and click multi-phrase / tokenized-word sentences (MyEnglishLab Exercise 4)', async () => {
  const scannerCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-scanner.js'), 'utf8');
  const actionsCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-actions.js'), 'utf8');
  const dom = createMiniDom({
    url: 'https://content.example.com/ex4',
    title: 'Exercise 4 More Practice',
  });
  const { document: doc } = dom;

  const clickedTokens = [];
  const makeWordSpan = (word) => {
    const sp = doc.createElement('span', { class: 'word' }, [word]);
    sp.addEventListener('click', () => clickedTokens.push(word));
    return sp;
  };

  // Tokenized sentence 2 where each word is a separate <span>
  const q2Tokens = ['People', 'looking', 'for', 'jobs', 'do', 'not,', 'as', 'a', 'rule,', 'hire', 'consultants', 'to', 'help', 'them', 'look.'].map(
    makeWordSpan
  );
  const q2Children = [doc.createElement('strong', {}, ['2']), ' '];
  for (const tok of q2Tokens) {
    q2Children.push(tok, ' ');
  }
  const q2Div = doc.createElement('div', { class: 'sentence-item' }, q2Children);

  // Sentence 4 with multiline HTML whitespace, curly apostrophe, and TWO separate unnecessary phrases in one TextNode
  const q4P = doc.createElement('p', { class: 'sentence-item' }, [
    doc.createElement('strong', {}, ['4']),
    ' If you take a close look,\n    you\u2019ll probably be surprised that the North American Free Trade Agreement, also called NAFTA, involves only three countries.',
  ]);

  // Action bar buttons that must NEVER be clicked during Auto-Apply
  const exitBtn = doc.createElement('button', { type: 'button' }, ['Exit']);
  const saveBtn = doc.createElement('button', { type: 'button' }, ['Save']);
  const submitBtn = doc.createElement('button', { type: 'button' }, ['Submit']);
  exitBtn.addEventListener('click', () => clickedTokens.push('BUTTON:Exit'));
  saveBtn.addEventListener('click', () => clickedTokens.push('BUTTON:Save'));
  submitBtn.addEventListener('click', () => clickedTokens.push('BUTTON:Submit'));

  doc.body.appendChild(doc.createElement('h2', {}, ['Exercise 4 More Practice']));
  doc.body.appendChild(q2Div);
  doc.body.appendChild(q4P);
  doc.body.appendChild(doc.createElement('div', { class: 'controls' }, [exitBtn, saveBtn, submitBtn]));

  const scanRes = vm.runInNewContext(scannerCode, dom);
  assert.equal(scanRes.kind, 'ready');
  assert.ok(
    scanRes.questionCandidates.some((c) => c.prompt.includes('People looking for jobs do not, as a rule')),
    'Expected page-scanner to keep sentence div containing >4 inline word <span> elements'
  );

  const api = vm.runInNewContext(actionsCode, dom);
  const items = [
    {
      index: 1,
      question: '2 People looking for jobs do not, as a rule, hire consultants to help them look.',
      question_type: 'multi_select',
      selected_options: ['as a rule'],
      apply_value: 'as a rule',
      answer: 'as a rule',
      evidence_quote: 'as a rule',
    },
    {
      index: 2,
      question:
        "4 If you take a close look, you'll probably be surprised that the North American Free Trade Agreement, also called NAFTA, involves only three countries.",
      question_type: 'open_ended',
      selected_options: [],
      apply_value: '',
      answer: 'Remove "If you take a close look, you\'ll probably be surprised that" and "also called NAFTA".',
      evidence_quote: '',
    },
  ];

  // 1. Highlight finds cross-node <span> phrase ("as a rule") AND BOTH multi-phrase slices in the same TextNode
  const hlRes = api.highlightAnswers(items);
  assert.equal(hlRes.matchedQuestions, 2);
  assert.equal(hlRes.details[0].matched, true);
  assert.equal(hlRes.details[1].matched, true);
  const markTexts = doc.querySelectorAll('mark[data-tabscan-mark="true"]').map((m) => m.textContent);
  assert.ok(markTexts.includes('as'));
  assert.ok(markTexts.includes('a'));
  assert.ok(markTexts.includes('rule'));
  assert.ok(markTexts.some((t) => t.includes("you\u2019ll probably be surprised that")));
  assert.ok(markTexts.includes('also called NAFTA'));

  // 2. Auto-Apply clicks ONLY interactive word tokens inside tokenized sentence 2, leaves static prose q4 & Save/Submit untouched
  const applyRes = await api.applyAnswers(items, { pairDelayMs: 0 });
  assert.equal(applyRes.appliedCount, 1);
  assert.equal(applyRes.skippedCount, 1);
  assert.equal(applyRes.results[0].controlType, 'inline-phrase');
  assert.equal(applyRes.results[1].status, 'no_control');
  assert.deepEqual(clickedTokens, ['as', 'a', 'rule,']);
});

// ---------------------------------------------------------------------------
// 9. Full-page vertical capture math, embedded image extraction & multi-image Gemini requests
// ---------------------------------------------------------------------------

test('computeScrollPositions computes overlapping vertical tiles bounded by maxTiles', () => {
  assert.deepEqual(computeScrollPositions(800, 800), [0]);
  assert.deepEqual(computeScrollPositions(850, 800), [0]);

  const medium = computeScrollPositions(2500, 800);
  assert.equal(medium[0], 0);
  assert.equal(medium[medium.length - 1], 1700);
  assert.ok(medium.length >= 3 && medium.length <= 6);
  for (let i = 1; i < medium.length; i++) {
    assert.ok(medium[i] > medium[i - 1]);
    assert.ok(medium[i] - medium[i - 1] < 800, 'consecutive viewport tiles must overlap');
  }

  const veryTall = computeScrollPositions(6000, 800, 6);
  assert.equal(veryTall.length, 6);
  assert.equal(veryTall[0], 0);
  assert.equal(veryTall[veryTall.length - 1], 5200);
  for (let i = 1; i < veryTall.length; i++) {
    assert.ok(veryTall[i] > veryTall[i - 1]);
  }
});

test('page-scanner.js extracts large content visualImages across frames while preserving visual_only image pages', async () => {
  const scannerCode = await fs.readFile(path.join(ROOT_DIR, 'scripts', 'page-scanner.js'), 'utf8');

  // 1. Page with instructions + embedded passage/chart images + small decorative icon/logo
  const dom = createMiniDom({ title: 'Comparative Advantage Task' });
  const { document: doc } = dom;
  const logoImg = doc.createElement('img', {
    src: 'https://example.com/site-logo.png',
    alt: 'University Logo',
    class: 'site-logo',
    width: '180',
    height: '60',
  });
  const iconImg = doc.createElement('img', {
    src: 'https://example.com/icon-help.png',
    alt: 'Help',
    width: '24',
    height: '24',
  });
  const passageImg = doc.createElement('img', {
    src: 'https://example.com/passage-comparative-advantage.png',
    alt: 'Comparative Advantage and Job-Hunting passage',
    width: '640',
    height: '520',
  });
  const chartImg = doc.createElement('img', {
    src: 'https://example.com/hours-labor-chart.png',
    alt: 'Hours of labor per year chart',
    width: '520',
    height: '360',
  });
  doc.body.appendChild(doc.createElement('header', {}, [logoImg, iconImg]));
  doc.body.appendChild(
    doc.createElement('main', {}, [
      doc.createElement('p', {}, ['Read the passage and examine the chart, then rewrite the summary below.']),
      passageImg,
      chartImg,
    ])
  );

  const mainSnapshot = vm.runInNewContext(scannerCode, dom);
  assert.equal(mainSnapshot.kind, 'ready');
  assert.equal(mainSnapshot.mediaSummary.visualImages.length, 2);
  assert.deepEqual(
    Array.from(mainSnapshot.mediaSummary.visualImages, (v) => v.src),
    [
      'https://example.com/passage-comparative-advantage.png',
      'https://example.com/hours-labor-chart.png',
    ]
  );

  // Child iframe with another content image plus a duplicate of passageImg
  const merged = mergeFrameSnapshots([
    { frameId: 0, result: mainSnapshot },
    {
      frameId: 4,
      result: {
        kind: 'visual_only',
        reason: 'visual_dom',
        url: 'https://cdn.example.com/summary-frame',
        title: 'Summary Frame',
        text: '',
        totalChars: 0,
        questionCandidates: [],
        mediaSummary: {
          imageCount: 2,
          canvasCount: 0,
          svgCount: 0,
          visualHints: ['Summary passage'],
          visualImages: [
            {
              kind: 'img',
              src: 'https://example.com/passage-comparative-advantage.png',
              alt: 'Duplicate',
              width: 640,
              height: 520,
            },
            {
              kind: 'img',
              src: 'https://example.com/summary-excerpt.png',
              alt: 'A Summary of Comparative Advantage',
              width: 600,
              height: 400,
            },
          ],
          hasVisualContent: true,
        },
        contentHash: 'iframe-visual',
      },
    },
  ]);

  assert.equal(merged.mediaSummary.visualImages.length, 3);
  assert.deepEqual(
    merged.mediaSummary.visualImages.map((v) => v.src),
    [
      'https://example.com/passage-comparative-advantage.png',
      'https://example.com/hours-labor-chart.png',
      'https://example.com/summary-excerpt.png',
    ]
  );

  // 2. Pure image page without text still classifies as visual_only (text remains empty) while exposing visualImages
  const pureDom = createMiniDom({ title: 'Image Only Sheet' });
  pureDom.document.body.appendChild(
    pureDom.document.createElement('img', {
      src: 'https://example.com/scanned-worksheet.jpg',
      alt: 'Worksheet page 1',
      width: '800',
      height: '1100',
    })
  );
  const pureSnapshot = vm.runInNewContext(scannerCode, pureDom);
  assert.equal(pureSnapshot.kind, 'visual_only');
  assert.equal(pureSnapshot.text, '');
  assert.equal(pureSnapshot.mediaSummary.visualImages.length, 1);
  assert.equal(pureSnapshot.mediaSummary.visualImages[0].src, 'https://example.com/scanned-worksheet.jpg');
});

test('collectSnapshotImageParts, analyzePageQuestions, and streamCustomQuestion attach labeled multi-image full-page & embedded captures', async () => {
  const tile1 = {
    dataUrl: 'data:image/jpeg;base64,dGlsZTE=',
    label: 'Full-page section 1 of 2',
    resolution: 'high',
  };
  const tile2 = {
    dataUrl: 'data:image/png;base64,dGlsZTI=',
    label: 'Full-page section 2 of 2',
    resolution: 'high',
  };
  const embedded = {
    dataUrl: 'data:image/webp;base64,Y2hhcnQx',
    label: 'Embedded image: Hours of labor chart',
    resolution: 'high',
  };

  const snapshot = {
    title: 'Long Reading Activity',
    url: 'https://example.com/activity',
    text: '1. Summarize the excerpt above.',
    mediaSummary: {
      imageCount: 1,
      canvasCount: 0,
      svgCount: 0,
      visualHints: ['Hours of labor chart'],
      hasVisualContent: true,
    },
    screenshot: tile1, // duplicate of first item in screenshots
    screenshots: [
      tile1,
      { dataUrl: tile1.dataUrl, label: 'Duplicate tile 1', resolution: 'high' },
      tile2,
      embedded,
    ],
  };

  const parts = collectSnapshotImageParts(snapshot);
  assert.equal(parts.length, 3);
  assert.deepEqual(
    parts.map((p) => p.label),
    [
      'Full-page section 1 of 2',
      'Full-page section 2 of 2',
      'Embedded image: Hours of labor chart',
    ]
  );

  const contextText = buildPageContextPrompt(snapshot);
  assert.match(contextText, /3 attached full-page \/ content image\(s\)/);
  assert.match(
    contextText,
    /Attached Images Order: Image 1: Full-page section 1 of 2 \| Image 2: Full-page section 2 of 2 \| Image 3: Embedded image: Hours of labor chart/
  );

  let analyzeBody = null;
  await analyzePageQuestions({
    apiKey: 'AIza-multi-img',
    pageSnapshot: snapshot,
    fetchImpl: async (_url, init) => {
      analyzeBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    page_type: 'quiz_or_form',
                    page_summary: 'Reading with chart.',
                    questions: [],
                    suggested_questions: [],
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200 }
      );
    },
  });

  assert.equal(analyzeBody.input.length, 4);
  assert.equal(analyzeBody.input[0].type, 'text');
  assert.deepEqual(analyzeBody.input.slice(1), [
    { type: 'image', data: 'dGlsZTE=', mime_type: 'image/jpeg', resolution: 'high' },
    { type: 'image', data: 'dGlsZTI=', mime_type: 'image/png', resolution: 'high' },
    { type: 'image', data: 'Y2hhcnQx', mime_type: 'image/webp', resolution: 'high' },
  ]);

  let streamBody = null;
  await streamCustomQuestion({
    apiKey: 'AIza-multi-stream',
    pageSnapshot: snapshot,
    question: 'Compare Portugal and England hours in the chart.',
    fetchImpl: async (_url, init) => {
      streamBody = JSON.parse(init.body);
      return new Response(
        makeSseStream([
          'data: {"event_type":"step.start","step":{"type":"model_output","content":[{"type":"text","text":"Portugal uses fewer hours."}]}}\n\n',
        ]),
        { status: 200 }
      );
    },
  });

  assert.equal(streamBody.input[0].type, 'user_input');
  assert.equal(streamBody.input[0].content.length, 4);
  assert.deepEqual(streamBody.input[0].content.slice(1), [
    { type: 'image', data: 'dGlsZTE=', mime_type: 'image/jpeg', resolution: 'high' },
    { type: 'image', data: 'dGlsZTI=', mime_type: 'image/png', resolution: 'high' },
    { type: 'image', data: 'Y2hhcnQx', mime_type: 'image/webp', resolution: 'high' },
  ]);
});

// ---------------------------------------------------------------------------
// 10. Claude model compatibility & rate limiting optimization
// ---------------------------------------------------------------------------

test('detectProvider identifies gemini and claude models accurately', () => {
  assert.equal(detectProvider('gemini-3.8-flash'), 'gemini');
  assert.equal(detectProvider('gemini-3.5-flash-lite'), 'gemini');
  assert.equal(detectProvider('claude-sonnet-4-5'), 'claude');
  assert.equal(detectProvider('claude-opus-4-5'), 'claude');
  assert.equal(detectProvider('claude-haiku-3-5'), 'claude');
  assert.equal(detectProvider('claude-3-7-sonnet-20250219'), 'claude');
  assert.equal(detectProvider('custom-model'), 'gemini');
});

test('DEFAULT_SETTINGS has safe rate-limiting defaults and claudeApiKey field', () => {
  assert.equal(DEFAULT_SETTINGS.autoAnswer, false, 'autoAnswer should default to false to prevent spam');
  assert.equal(DEFAULT_SETTINGS.claudeApiKey, '');
  assert.ok(Array.isArray(CLAUDE_MODELS));
  assert.ok(CLAUDE_MODELS.length >= 3);
  assert.ok(CLAUDE_MODELS.some((m) => m.id === 'claude-sonnet-4-5'));
});

test('analyzePageQuestions routes to Claude Messages API, formats payload, and parses JSON', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};
  let capturedBody = null;

  const mockResponse = {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [
      {
        type: 'text',
        text: '```json\n{\n  "page_type": "quiz_or_form",\n  "page_summary": "Economics quiz.",\n  "questions": [\n    {\n      "question": "What is opportunity cost?",\n      "question_type": "multiple_choice",\n      "options": ["The next best alternative forgone", "Total monetary cost"],\n      "selected_options": ["The next best alternative forgone"],\n      "answer": "The next best alternative forgone",\n      "explanation": "Opportunity cost is defined as value of next best alternative.",\n      "confidence": "high"\n    }\n  ],\n  "suggested_questions": ["What is comparative advantage?"]\n}\n```',
      },
    ],
    usage: { input_tokens: 120, output_tokens: 80 },
  };

  const { analysis, usage } = await analyzePageQuestions({
    apiKey: '',
    claudeApiKey: 'sk-ant-testkey123',
    model: 'claude-sonnet-4-5',
    pageSnapshot: {
      title: 'Econ Quiz',
      url: 'https://example.com/econ',
      text: '1. What is opportunity cost?',
      screenshot: { dataUrl: 'data:image/jpeg;base64,dGlsZTE=' },
    },
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    },
  });

  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-testkey123');
  assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
  assert.equal(capturedHeaders['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(capturedBody.model, 'claude-sonnet-4-5');
  assert.ok(Array.isArray(capturedBody.messages));
  assert.equal(capturedBody.messages[0].role, 'user');

  // Verify Claude image format
  const content = capturedBody.messages[0].content;
  assert.ok(content.some((c) => c.type === 'text'));
  const imageItem = content.find((c) => c.type === 'image');
  assert.ok(imageItem);
  assert.deepEqual(imageItem.source, {
    type: 'base64',
    media_type: 'image/jpeg',
    data: 'dGlsZTE=',
  });

  // Verify parsed analysis
  assert.equal(analysis.page_type, 'quiz_or_form');
  assert.equal(analysis.questions.length, 1);
  assert.equal(analysis.questions[0].answer, 'The next best alternative forgone');
  assert.equal(usage.input_tokens, 120);
  assert.equal(usage.output_tokens, 80);
});

test('streamCustomQuestion routes to Claude streaming API and handles content_block_delta', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};
  const chunksReceived = [];

  const sseEvents = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The answer is "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"comparative advantage."}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  const result = await streamCustomQuestion({
    claudeApiKey: 'sk-ant-stream-key',
    model: 'claude-haiku-3-5',
    pageSnapshot: {
      title: 'Study Guide',
      url: 'https://example.com/guide',
      text: 'David Ricardo introduced comparative advantage.',
    },
    question: 'Who introduced comparative advantage?',
    onChunk: (chunk) => {
      chunksReceived.push(chunk);
    },
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return new Response(makeSseStream(sseEvents), { status: 200 });
    },
  });

  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-stream-key');
  assert.equal(capturedHeaders['anthropic-dangerous-direct-browser-access'], 'true');
  assert.deepEqual(chunksReceived, ['The answer is ', 'comparative advantage.']);
  assert.equal(result.text, 'The answer is comparative advantage.');
  assert.equal(result.usage?.output_tokens, 25);
});

test('testApiKey tests Claude connection when a Claude model is chosen', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const res = await testApiKey({
    claudeApiKey: 'sk-ant-test-ping',
    model: 'claude-sonnet-4-5',
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return new Response(
        JSON.stringify({
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'OK' }],
        }),
        { status: 200 }
      );
    },
  });

  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-test-ping');
  assert.equal(capturedHeaders['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(res.ok, true);
  assert.equal(res.model, 'claude-sonnet-4-5');
  assert.equal(res.reply, 'OK');
});

test('PROVIDERS contains Google Gemini and Anthropic Claude configurations', () => {
  assert.equal(PROVIDERS.length, 2);
  assert.equal(PROVIDERS[0].id, 'gemini');
  assert.equal(PROVIDERS[1].id, 'claude');
  assert.ok(PROVIDERS[0].getKeyUrl.includes('aistudio'));
  assert.ok(PROVIDERS[1].getKeyUrl.includes('anthropic'));
});

test('fetchAvailableModels fetches and formats Gemini models, filtering out embeddings', async () => {
  let capturedUrl = '';

  const mockGeminiResponse = {
    models: [
      {
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/text-embedding-004',
        displayName: 'Text Embedding 004',
        supportedGenerationMethods: ['embedContent'],
      },
    ],
  };

  const models = await fetchAvailableModels({
    provider: 'gemini',
    apiKey: 'AIza-test-gemini-key',
    fetchImpl: async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify(mockGeminiResponse), { status: 200 });
    },
  });

  assert.ok(capturedUrl.includes('generativelanguage.googleapis.com'));
  assert.ok(capturedUrl.includes('AIza-test-gemini-key'));
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'gemini-2.5-flash');
  assert.ok(models[0].label.includes('Fast & Smart'));
  assert.equal(models[1].id, 'gemini-2.5-pro');
});

test('fetchAvailableModels fetches and formats Claude models from Anthropic API', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const mockClaudeResponse = {
    data: [
      {
        id: 'claude-3-7-sonnet-20250219',
        display_name: 'Claude 3.7 Sonnet',
        type: 'model',
      },
      {
        id: 'claude-3-5-haiku-20241022',
        display_name: 'Claude 3.5 Haiku',
        type: 'model',
      },
    ],
  };

  const models = await fetchAvailableModels({
    provider: 'claude',
    apiKey: 'sk-ant-test-fetch',
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return new Response(JSON.stringify(mockClaudeResponse), { status: 200 });
    },
  });

  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/models');
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-test-fetch');
  assert.equal(capturedHeaders['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'claude-3-7-sonnet-20250219');
  assert.equal(models[1].id, 'claude-3-5-haiku-20241022');
  assert.equal(models[1].category, 'fast');
});

test('fetchAvailableModels throws when API key is missing', async () => {
  await assert.rejects(
    async () => {
      await fetchAvailableModels({ provider: 'gemini', apiKey: '' });
    },
    (err) => {
      assert.ok(err instanceof GeminiApiError);
      assert.equal(err.code, 'missing_api_key');
      return true;
    }
  );
});

test('all extension JS files have balanced braces and parse without syntax errors', async () => {
  const files = [
    'service-worker.js',
    'scripts/page-actions.js',
    'scripts/page-scanner.js',
    'shared/constants.js',
    'shared/frame-helpers.js',
    'shared/gemini-client.js',
    'shared/markdown.js',
    'sidepanel/sidepanel.js',
  ];

  for (const relPath of files) {
    const fullPath = path.join(ROOT_DIR, relPath);
    const code = await fs.readFile(fullPath, 'utf8');

    // Test syntax parsing via node --check
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--check', fullPath], { encoding: 'utf8' });
    }, `Syntax error in ${relPath}`);

    // Verify balanced curly braces
    let depth = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') {
        depth--;
        assert.ok(depth >= 0, `Unmatched closing brace in ${relPath} around index ${i}`);
      }
    }
    assert.equal(depth, 0, `Unbalanced braces in ${relPath} (final depth ${depth})`);
  }
});

test('fetchWithRetry and parseRetryAfter parse retry-after header and call onRetry countdown', async () => {
  // Test parseRetryAfter
  const headerResp = new Response('{}', { status: 429, headers: { 'retry-after': '3' } });
  assert.equal(parseRetryAfter(headerResp), 3000);

  const resetTokenResp = new Response('{}', { status: 429, headers: { 'x-ratelimit-reset-tokens': '2.5' } });
  assert.equal(parseRetryAfter(resetTokenResp), 2500);

  const emptyResp = new Response('{}', { status: 200 });
  assert.equal(parseRetryAfter(emptyResp), null);

  // Test retry with countdown callback
  let callCount = 0;
  const retryEvents = [];
  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: 'quota exceeded' }), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    }
    return new Response(JSON.stringify({ text: 'resumed success' }), { status: 200 });
  };

  const resp = await fetchWithRetry(
    'https://example.com/api',
    {
      onRetry: (info) => {
        retryEvents.push(info);
      },
    },
    mockFetch,
    2
  );

  assert.equal(resp.status, 200);
  assert.equal(callCount, 2);
  assert.ok(retryEvents.length >= 1, 'Expected at least one retry countdown event');
  assert.equal(retryEvents[0].status, 429);
  assert.equal(retryEvents[0].attempt, 1);
});

test('streamCustomQuestion passes onRetry callback during rate limit pause and resumes upon reset', async () => {
  let callCount = 0;
  const retryEvents = [];
  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: { message: 'Quota exhausted', status: 'RESOURCE_EXHAUSTED' } }), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    }
    return new Response(
      makeSseStream([
        'data: {"event_type":"step.start","step":{"type":"model_output","content":[{"type":"text","text":"Final answer after reset"}]}}\n\n',
        'data: [DONE]\n\n',
      ]),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }
    );
  };

  const chunks = [];
  const result = await streamCustomQuestion({
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    question: 'What is token reset?',
    pageSnapshot: { text: 'Some page context' },
    fetchImpl: mockFetch,
    onChunk: (delta) => chunks.push(delta),
    onRetry: (info) => retryEvents.push(info),
  });

  assert.equal(callCount, 2);
  assert.ok(retryEvents.length >= 1);
  assert.equal(retryEvents[0].status, 429);
  assert.equal(result.text, 'Final answer after reset');
});

test('update-checker parses semver and detects newer versions correctly', async () => {
  const { parseSemver, isNewerVersion, checkGitHubRelease } = await import('../shared/update-checker.js');

  assert.deepEqual(parseSemver('1.0.1'), [1, 0, 1]);
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('v2.0'), [2, 0, 0]);

  assert.equal(isNewerVersion('v1.0.2', '1.0.1'), true);
  assert.equal(isNewerVersion('v1.1.0', '1.0.9'), true);
  assert.equal(isNewerVersion('v2.0.0', '1.9.9'), true);
  assert.equal(isNewerVersion('v1.0.1', '1.0.1'), false);
  assert.equal(isNewerVersion('v1.0.0', '1.0.1'), false);

  // Mock GitHub API release check
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      tag_name: 'v1.0.2',
      name: 'Release 1.0.2',
      html_url: 'https://github.com/trannguyendev/tabscan-sleuth/releases/tag/v1.0.2',
    }),
  });

  const result = await checkGitHubRelease({
    currentVersion: '1.0.1',
    fetchFn: mockFetch,
    force: true,
  });

  assert.equal(result.hasUpdate, true);
  assert.equal(result.latestVersion, 'v1.0.2');
  assert.ok(result.downloadUrl.includes('tab-sleuth.zip'));
  assert.ok(result.updaterBatUrl.includes('update.bat'));
});

test('downloadUpdateScript initiates blob download with same-origin URL and triggers anchor click', async () => {
  const { downloadUpdateScript } = await import('../shared/update-checker.js');

  const batScriptContent = '@echo off\r\necho Updating Tab-Sleuth...\r\n';
  const mockFetch = async () => ({
    ok: true,
    text: async () => batScriptContent,
  });

  let createdUrl = '';
  const mockCreateObjectURL = (blob) => {
    createdUrl = 'blob:chrome-extension://dummy-id/12345';
    return createdUrl;
  };
  const mockRevokeObjectURL = () => {};

  let clicked = false;
  let appendedChild = null;
  const mockAnchor = {
    href: '',
    download: '',
    style: {},
    click() {
      clicked = true;
    },
    remove() {},
  };

  const mockDoc = {
    createElement(tag) {
      if (tag === 'a') return mockAnchor;
      return {};
    },
    body: {
      appendChild(node) {
        appendedChild = node;
      },
      removeChild() {},
    },
  };

  const result = await downloadUpdateScript({
    url: 'https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/update.bat',
    filename: 'update.bat',
    fetchFn: mockFetch,
    createObjectURL: mockCreateObjectURL,
    revokeObjectURL: mockRevokeObjectURL,
    documentObj: mockDoc,
  });

  assert.equal(result.success, true);
  assert.equal(result.method, 'blob');
  assert.equal(mockAnchor.download, 'update.bat');
  assert.equal(mockAnchor.href, createdUrl);
  assert.equal(clicked, true);
  assert.equal(appendedChild, mockAnchor);
});

test('downloadUpdateScript gracefully falls back to chrome.tabs.create when fetch fails', async () => {
  const { downloadUpdateScript } = await import('../shared/update-checker.js');

  const failingFetch = async () => ({
    ok: false,
    status: 404,
  });

  let openedUrl = '';
  const mockChromeTabs = {
    create: async ({ url }) => {
      openedUrl = url;
      return { id: 99 };
    },
  };

  const targetUrl = 'https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/update.bat';
  const result = await downloadUpdateScript({
    url: targetUrl,
    filename: 'update.bat',
    fetchFn: failingFetch,
    chromeTabs: mockChromeTabs,
  });

  assert.equal(result.success, true);
  assert.equal(result.method, 'tab');
  assert.equal(openedUrl, targetUrl);
  assert.ok(result.fallbackReason.includes('404'));
});

test('downloadUpdateScript falls back to window.open when chrome.tabs is unavailable and fetch fails', async () => {
  const { downloadUpdateScript } = await import('../shared/update-checker.js');

  const throwingFetch = async () => {
    throw new Error('Network offline');
  };

  let openedTarget = '';
  let openedWindowUrl = '';
  const mockWindow = {
    open: (url, target) => {
      openedWindowUrl = url;
      openedTarget = target;
    },
  };

  const targetUrl = 'https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/update.bat';
  const result = await downloadUpdateScript({
    url: targetUrl,
    filename: 'update.bat',
    fetchFn: throwingFetch,
    chromeTabs: null,
    windowObj: mockWindow,
  });

  assert.equal(result.success, true);
  assert.equal(result.method, 'window');
  assert.equal(openedWindowUrl, targetUrl);
  assert.equal(openedTarget, '_blank');
});

test('downloadUpdateScript rejects unsafe URL schemes without making network requests or opening tabs', async () => {
  const { downloadUpdateScript } = await import('../shared/update-checker.js');

  let fetchCalled = false;
  let tabCreated = false;

  const result = await downloadUpdateScript({
    url: 'javascript:alert(document.cookie)',
    fetchFn: async () => {
      fetchCalled = true;
      return { ok: true, text: async () => 'echo evil' };
    },
    chromeTabs: {
      create: async () => {
        tabCreated = true;
      },
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.method, 'failed');
  assert.match(result.error, /must be an HTTP or HTTPS URL/i);
  assert.equal(fetchCalled, false);
  assert.equal(tabCreated, false);
});

test('downloadUpdateScript normalizes batch script line endings to CRLF and sanitizes filename', async () => {
  const { downloadUpdateScript } = await import('../shared/update-checker.js');

  let passedBlob = null;
  const mockCreateObjectURL = (blob) => {
    passedBlob = blob;
    return 'blob:chrome-extension://test/blob-id';
  };

  const mockAnchor = {
    href: '',
    download: '',
    style: {},
    click() {},
    remove() {},
  };

  const mockDoc = {
    createElement(tag) {
      if (tag === 'a') return mockAnchor;
      return {};
    },
    body: {
      appendChild() {},
      removeChild() {},
    },
  };

  const lfScript = '@echo off\necho Line 1\necho Line 2\n';
  const result = await downloadUpdateScript({
    url: 'https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/update.bat',
    filename: '../../malicious/update.bat',
    fetchFn: async () => ({
      ok: true,
      text: async () => lfScript,
    }),
    createObjectURL: mockCreateObjectURL,
    revokeObjectURL: () => {},
    documentObj: mockDoc,
  });

  assert.equal(result.success, true);
  assert.equal(result.method, 'blob');
  assert.equal(mockAnchor.download, 'update.bat', 'Filename path traversal must be stripped to basename');

  // Verify blob content has CRLF line endings
  assert.ok(passedBlob instanceof Blob);
  const blobText = await passedBlob.text();
  assert.ok(blobText.includes('\r\necho Line 1\r\necho Line 2\r\n'));
  assert.ok(!blobText.includes('Line 1\n'));
});

test('downloadUpdateScript falls back to default URL when empty or whitespace URL is provided', async () => {
  const { downloadUpdateScript } = await import('../shared/update-checker.js');

  let fetchedUrl = '';
  const result = await downloadUpdateScript({
    url: '   ',
    fetchFn: async (reqUrl) => {
      fetchedUrl = reqUrl;
      return {
        ok: true,
        text: async () => '@echo off\r\n',
      };
    },
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
    documentObj: {
      createElement: () => ({ style: {}, click() {}, remove() {} }),
      body: { appendChild() {}, removeChild() {} },
    },
  });

  assert.equal(result.success, true);
  assert.ok(fetchedUrl.startsWith('https://raw.githubusercontent.com/'));
  assert.ok(fetchedUrl.endsWith('/update.bat'));
});

test('sidepanel.html update modal markup conforms to accessible MV3 and download safety standards', async () => {
  const html = await fs.readFile(path.join(ROOT_DIR, 'sidepanel', 'sidepanel.html'), 'utf8');

  // Verify download link attributes prevent top-frame navigation
  assert.match(html, /id="download-updater-link"[^>]*target="_blank"/i);
  assert.match(html, /id="download-updater-link"[^>]*rel="noopener noreferrer"/i);
  assert.match(html, /id="download-updater-link"[^>]*download="update\.bat"/i);

  // Verify update modal dialog accessibility
  assert.match(html, /id="update-modal"[^>]*aria-labelledby="update-modal-title"/i);
  assert.match(html, /id="update-modal-title"/i);
  assert.match(html, /id="update-modal-close"[^>]*aria-label="Close update dialog"/i);
  assert.match(html, /id="update-version-label"/i);
  assert.match(html, /id="open-extensions-link"/i);
  assert.match(html, /id="view-release-link"/i);
});

test('sidepanel.js guards screenshot captures on restricted URLs and suppresses policy permission warnings', async () => {
  const code = await fs.readFile(path.join(ROOT_DIR, 'sidepanel', 'sidepanel.js'), 'utf8');

  // Verify pre-checks prevent captureVisibleTab on unscannable URLs
  assert.match(code, /if\s*\(activeTab\?\.url\s*&&\s*!isScannableUrl\(activeTab\.url\)\)\s*\{\s*return null;\s*\}/);
  assert.match(code, /async function tryCaptureVisibleTab\(windowId,\s*tab\)\s*\{\s*if\s*\(!windowId\s*\|\|\s*\(tab\?\.url\s*&&\s*!isScannableUrl\(tab\.url\)\)\)/);
  assert.match(code, /async function captureFullPageScreenshots\([\s\S]*?if\s*\(!windowId\s*\|\|\s*\(tab\?\.url\s*&&\s*!isScannableUrl\(tab\.url\)\)\)/);

  // Verify policy restriction errors log as debug rather than console.warn
  assert.match(code, /console\.debug\('captureVisibleTab restricted by browser policy:', errMsg\)/);
});

test('updateStatus helper is defined in sidepanel.js and wires status badge with fallback icons', async () => {
  const code = await fs.readFile(path.join(ROOT_DIR, 'sidepanel', 'sidepanel.js'), 'utf8');

  // Verify function updateStatus is declared
  assert.match(code, /function updateStatus\(badgeState,\s*text,\s*icon\)/);
  // Verify it calls setStatusBadge
  assert.match(code, /setStatusBadge\(badgeState,\s*icon\s*\|\|\s*defaultIcons\[badgeState\]/);
});





