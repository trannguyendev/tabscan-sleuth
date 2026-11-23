/**
 * Synthetic Test Fixtures & Harness Utilities for TabScan Q&A E2E Test Suite
 * Zero external dependencies: pure Node.js built-ins.
 */

export class MockStorageArea {
  constructor(initial = {}) {
    this._store = new Map(Object.entries(initial));
    this.callLog = {
      get: [],
      set: [],
      remove: [],
      clear: 0,
    };
  }

  async get(keys) {
    this.callLog.get.push(keys);
    if (!keys) {
      return Object.fromEntries(this._store.entries());
    }
    if (typeof keys === 'string') {
      return { [keys]: this._store.get(keys) };
    }
    if (Array.isArray(keys)) {
      const res = {};
      for (const k of keys) {
        if (this._store.has(k)) res[k] = this._store.get(k);
      }
      return res;
    }
    if (typeof keys === 'object') {
      const res = { ...keys };
      for (const k of Object.keys(keys)) {
        if (this._store.has(k)) res[k] = this._store.get(k);
      }
      return res;
    }
    return Object.fromEntries(this._store.entries());
  }

  async set(items) {
    this.callLog.set.push(items);
    for (const [k, v] of Object.entries(items)) {
      this._store.set(k, v);
    }
  }

  async remove(keys) {
    this.callLog.remove.push(keys);
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this._store.delete(k);
    }
  }

  async clear() {
    this.callLog.clear++;
    this._store.clear();
  }
}

export function makeSseStream(chunks) {
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

export function makeGeminiSseChunks(textChunks = []) {
  const lines = [
    ': keepalive\n\n',
    'event: interaction.created\ndata: {"event_type":"interaction.created"}\n\n',
  ];
  for (const text of textChunks) {
    lines.push(`event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":${JSON.stringify(text)}}}\n\n`);
  }
  lines.push('event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"usage":{"total_output_tokens":42}}}\n\n');
  return lines;
}

// ---------------------------------------------------------------------------
// Zero-Dependency MiniDom for UI States & Interaction Testing
// ---------------------------------------------------------------------------

export class MiniEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.cancelBubble = false;
    this.key = init.key || '';
    this.shiftKey = Boolean(init.shiftKey);
    this.keyCode = init.keyCode || 0;
    this.isComposing = Boolean(init.isComposing);
    this.target = null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.cancelBubble = true;
  }
}

export class MiniNode {
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
    this.childNodes.splice(idx, 0, newNode);
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

  replaceChildren(...nodes) {
    for (const old of [...this.childNodes]) {
      old.parentNode = null;
    }
    this.childNodes = [];
    for (const n of nodes) {
      this.appendChild(n);
    }
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
}

export class MiniText extends MiniNode {
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

export class MiniFragment extends MiniNode {
  constructor() {
    super(11);
  }
}

export class MiniElement extends MiniNode {
  constructor(tagName, attrs = {}, doc = null) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.hidden = Boolean(attrs.hidden);
    this._value = attrs.value !== undefined ? String(attrs.value) : '';
    this.listeners = new Map();
    this.focused = false;
    this.ownerDocument = doc;
    this.tabIndex = 0;
    this.style = {};
    this.open = false; // for <dialog> and <details>

    // dataset proxy
    const self = this;
    this.dataset = new Proxy({}, {
      get(_target, prop) {
        const attrName = 'data-' + String(prop).replace(/([A-Z])/g, '-$1').toLowerCase();
        return self.attrs[attrName];
      },
      set(_target, prop, val) {
        const attrName = 'data-' + String(prop).replace(/([A-Z])/g, '-$1').toLowerCase();
        self.attrs[attrName] = String(val);
        return true;
      },
    });
  }

  get id() {
    return this.attrs.id || '';
  }

  set id(val) {
    this.attrs.id = String(val);
  }

  get type() {
    return this.attrs.type || '';
  }

  set type(val) {
    this.attrs.type = String(val);
  }

  get href() {
    return this.attrs.href || this._href || '';
  }

  set href(val) {
    this._href = String(val);
    this.attrs.href = String(val);
  }

  get download() {
    return this.attrs.download || this._download || '';
  }

  set download(val) {
    this._download = String(val);
    this.attrs.download = String(val);
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
      if (tokens.length === 0) delete el.attrs.class;
      else el.attrs.class = tokens.join(' ');
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
      toggle(name, force) {
        const tokens = getTokens();
        const has = tokens.includes(name);
        const shouldAdd = force !== undefined ? Boolean(force) : !has;
        if (shouldAdd && !has) {
          tokens.push(name);
          setTokens(tokens);
          return true;
        } else if (!shouldAdd && has) {
          setTokens(tokens.filter((t) => t !== name));
          return false;
        }
        return has;
      },
    };
  }

  get value() {
    return this._value;
  }

  set value(val) {
    this._value = String(val);
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(val) {
    this.childNodes = [new MiniText(val)];
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
  }

  setAttribute(name, val) {
    this.attrs[name] = String(val);
  }

  removeAttribute(name) {
    delete this.attrs[name];
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(evt) {
    const eventObj = typeof evt === 'string' ? new MiniEvent(evt) : evt;
    if (!eventObj.target) eventObj.target = this;
    for (const fn of this.listeners.get(eventObj.type) || []) {
      fn(eventObj);
    }
    if (eventObj.bubbles && !eventObj.cancelBubble && this.parentNode?.dispatchEvent) {
      this.parentNode.dispatchEvent(eventObj);
    }
    return !eventObj.defaultPrevented;
  }

  focus() {
    this.focused = true;
  }

  click() {
    const evt = new MiniEvent('click', { bubbles: true });
    this.dispatchEvent(evt);
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  requestSubmit() {
    const evt = new MiniEvent('submit', { bubbles: true, cancelable: true });
    this.dispatchEvent(evt);
  }

  matches(selector) {
    const trimmed = selector.trim();
    if (trimmed.includes(',')) {
      return trimmed.split(',').some((part) => this.matches(part));
    }
    const tagMatch = trimmed.match(/^([a-zA-Z0-9]+)/);
    let rest = trimmed;
    if (tagMatch) {
      if (this.tagName !== tagMatch[1].toUpperCase()) return false;
      rest = trimmed.slice(tagMatch[1].length);
    }
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
      if (op === '=' && actual !== attrVal) return false;
      if (op === '*=' && !actual.includes(attrVal)) return false;
    }
    return true;
  }

  querySelectorAll(selector) {
    const matched = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matched.push(child);
        walk(child);
      }
    };
    walk(this);
    return matched;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

export function createSyntheticDom() {
  const doc = {
    createElement(tagName, attrs = {}) {
      return new MiniElement(tagName, attrs, doc);
    },
    createDocumentFragment() {
      return new MiniFragment();
    },
    createTextNode(text) {
      return new MiniText(text);
    },
    getElementById(id) {
      return doc.body.querySelector(`#${id}`) || null;
    },
    querySelector(selector) {
      return doc.body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return doc.body.querySelectorAll(selector);
    },
  };

  doc.body = new MiniElement('body', {}, doc);
  doc.documentElement = new MiniElement('html', {}, doc);
  doc.documentElement.appendChild(doc.body);

  let clipboardData = '';
  const navigator = {
    clipboard: {
      writeText: async (t) => { clipboardData = String(t); },
      readText: async () => clipboardData,
    },
  };

  return {
    document: doc,
    navigator,
    getClipboard: () => clipboardData,
  };
}

// ---------------------------------------------------------------------------
// Realistic Corpus & Article Fixtures
// ---------------------------------------------------------------------------

export const WIKIPEDIA_PHOTOSYNTHESIS_TEXT = `
Photosynthesis is a biological process used by plants, algae, and certain bacteria to convert light energy into chemical energy.
This chemical energy is stored in carbohydrate molecules, such as sugars and starches, which are synthesized from carbon dioxide and water.

Light-dependent reactions:
In the light-dependent reactions, one molecule of the pigment chlorophyll absorbs one photon and loses one electron.
This electron is passed to a modified form of chlorophyll called pheophytin, which passes the electron to a quinone molecule,
allowing the start of a flow of electrons down an electron transport chain.

Light-independent reactions (Calvin cycle):
In the light-independent (or "dark") reactions, the enzyme RuBisCO captures CO2 from the atmosphere and attaches it to ribulose 1,5-bisphosphate.
Through a series of enzymatic reactions, triose phosphate molecules are synthesized, which can then form glucose.

Overall chemical reaction:
6 CO2 + 6 H2O + light energy -> C6H12O6 + 6 O2.
`;

export const SPA_PAGE_HTML = `
<header role="banner" class="top-nav">
  <nav>
    <a href="/home">Home</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
  </nav>
</header>
<aside class="cookie-banner" id="cookie-consent-bar">
  <p>We use cookies to analyze web traffic. Accept to continue.</p>
  <button type="button" id="accept-cookies">Accept All</button>
</aside>
<main>
  <article>
    <h1>Biology Midterm Examination</h1>
    <fieldset>
      <legend>Question 1: What is the primary role of chlorophyll in photosynthesis?</legend>
      <label><input type="radio" name="q1" value="a"> Absorbing photons and transferring electrons</label>
      <label><input type="radio" name="q1" value="b"> Generating carbon dioxide gas</label>
      <label><input type="radio" name="q1" value="c"> Breaking down starch molecules</label>
    </fieldset>
    <fieldset>
      <legend>Question 2: Which enzyme catalyzes carbon dioxide fixation?</legend>
      <label><input type="radio" name="q2" value="a"> RuBisCO</label>
      <label><input type="radio" name="q2" value="b"> DNA polymerase</label>
      <label><input type="radio" name="q2" value="c"> Amylase</label>
    </fieldset>
  </article>
</main>
<aside class="ad advertisement">
  <p>Buy organic fertilizer now! 20% discount.</p>
</aside>
<footer role="contentinfo">
  <p>Copyright 2026 Academic Testing Systems Inc.</p>
</footer>
`;
