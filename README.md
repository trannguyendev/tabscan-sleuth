# TabScan Q&A — Chrome Manifest V3 Side Panel Extension

[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3%20Side%20Panel-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/reference/manifest)
[![Automated Tests](https://img.shields.io/badge/Tests-157%20Passing%20(0%20Failures)-success)](#testing--quality-assurance)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Vanilla%20%2B%20Node%20Native)-blueviolet)](#project-overview--architecture)
[![CRX3 Packaging](https://img.shields.io/badge/Packaging-Signed%20CRX3%20%2B%20Omaha%20v2.0-blue)](#distribution--packaging-pipeline)
[![Dual AI Provider](https://img.shields.io/badge/AI%20Providers-Gemini%20Interactions%20%2B%20Claude-orange)](#dual-ai-provider-support)

**TabScan Q&A** is a production-grade Google Chrome Manifest V3 Side Panel extension that automatically scans the active browser tab, extracts and structures questions (quizzes, exercises, forms, FAQs, coding challenges), streams grounded AI answers using the **Google Gemini Interactions API** or **Anthropic Claude Messages API**, and interacts directly with page elements (highlighting answers, auto-filling inputs, solving drag-and-drop exercises, and matching cards).

Built with **zero third-party dependencies**, TabScan Q&A combines extreme runtime efficiency with an intelligent multi-tier cache (0ms replay), DOM token optimization, seamless container-query responsiveness (320px–800px), out-of-token rate limit auto-wait, and a cryptographically signed self-hosted CRX3 release pipeline.

---

## Table of Contents

1. [Project Overview & Architecture](#project-overview--architecture)
2. [Key Features](#key-features)
   - [Smart Context Pruning & Token Optimization](#smart-context-pruning--token-optimization)
   - [Multi-Tier Intelligent Query Caching](#multi-tier-intelligent-query-caching)
   - [Progressive Response Streaming & Pulsing Cursor](#progressive-response-streaming--pulsing-cursor)
   - [Dual AI Provider Support (Gemini & Claude)](#dual-ai-provider-support)
   - [Rate-Limit Auto-Wait & Countdown Resume (F15)](#rate-limit-auto-wait--countdown-resume-f15)
   - [Advanced In-Page Exercise Interactions](#advanced-in-page-exercise-interactions)
   - [Modern Responsive UI/UX with Container Queries](#modern-responsive-uiux-with-container-queries)
3. [Project File Layout](#project-file-layout)
4. [Installation & Getting Started](#installation--getting-started)
   - [Option A: Load as Unpacked Extension](#option-a-load-as-unpacked-extension-developer-mode)
   - [Option B: Install Packaged CRX3 File](#option-b-install-packaged-crx3-file)
   - [Configuration & API Keys](#configuration--api-keys)
5. [Distribution & Packaging Pipeline](#distribution--packaging-pipeline)
   - [Zero-Dependency CRX3 Packaging Script](#zero-dependency-crx3-packaging-script)
   - [Distribution Artifacts](#distribution-artifacts)
   - [Self-Hosted & Enterprise Auto-Updates](#self-hosted--enterprise-auto-updates)
6. [Testing & Quality Assurance](#testing--quality-assurance)
   - [157 Automated Tests](#157-automated-tests)
   - [Test Tier Architecture](#test-tier-architecture)
   - [Running the Test Suites](#running-the-test-suites)
7. [Security & Compliance](#security--compliance)

---

## Project Overview & Architecture

TabScan Q&A is designed around Chrome's modern Manifest V3 side panel paradigm (`chrome.sidePanel`, Chrome 116+), ensuring persistent, non-intrusive access alongside any browsing session.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            ACTIVE BROWSER TAB                               │
│  ┌───────────────────────────────┐  ┌────────────────────────────────────┐  │
│  │ Questions / Quizzes / Forms   │  │   scripts/page-actions.js          │  │
│  │ (Radio, DnD Cloze, Sort, FAQ) │  │   - CSS.highlights / <mark>        │  │
│  └───────────────┬───────────────┘  │   - Safe Form Apply (No Submit)    │  │
│                  │                  │   - Pointer / Mouse DnD Dispatch   │  │
│       chrome.scripting.executeScript│   └─────────────────▲──────────────┘  │
│                  ▼                                        │                 │
│        scripts/page-scanner.js ───────────────────────────┤                 │
│        - DOM extraction, question detection               │                 │
│        - Visible / iframe content inventory               │ Apply /         │
└──────────────────┬────────────────────────────────────────┼─ Highlight ─────┘
                   │ Extracted DOM / Text                   │ Actions
                   ▼                                        │
┌───────────────────────────────────────────────────────────┴─────────────────┐
│                     CHROME MV3 SIDE PANEL (sidepanel/)                      │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ shared/token-optimizer.js                                             │  │
│  │ - Strip boilerplate (nav, footer, ads, banners)                       │  │
│  │ - Collapse redundant whitespace                                       │  │
│  │ - Smart semantic boundary truncation (paragraph & sentence)           │  │
│  │ - Selective screenshot attachment logic                               │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ shared/cache-manager.js (Two-Tier Query Cache)                        │  │
│  │ - Deterministic SHA-256 hash (content + query + model + settings)     │  │
│  │ - Tier 1: In-Memory Map (0ms Instant Replay)                          │  │
│  │ - Tier 2: chrome.storage.local (LRU 150 items / 4MB, 24h TTL)         │  │
│  └───────────────────┬───────────────────────────────▲───────────────────┘  │
│             Cache    │                               │ Persist Response     │
│             Miss     ▼                               │                      │
│  ┌───────────────────────────────────────────────────┴───────────────────┐  │
│  │ shared/gemini-client.js (Streaming AI Client)                         │  │
│  │ - Gemini Interactions API (v1beta/interactions)                       │  │
│  │ - Anthropic Claude Messages API (v1/messages)                         │  │
│  │ - F15 Rate-Limit Auto-Wait & Countdown Resume (429 / 529 retry-after) │  │
│  └───────────────────┬───────────────────────────────────────────────────┘  │
│                      ▼ Server-Sent Events (SSE) Stream                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ sidepanel/sidepanel.js + sidepanel.css                                │  │
│  │ - Safe DOM Markdown Renderer (shared/markdown.js - 0 innerHTML)       │  │
│  │ - Animated Pulsing Cursor (.streaming-cursor) + Reduced-Motion support│  │
│  │ - Container Queries (320px–800px) & Single Delegated Chip Listeners   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Architectural Principles

1. **Zero External Dependencies**: Implemented entirely in vanilla modern JavaScript (ES2022+) and CSS3 without frameworks, bundlers, or third-party npm runtime libraries.
2. **Strict Manifest V3 Security**: No `eval()`, no remote script execution, no `new Function()`, and strictly zero `innerHTML` usage. All dynamic HTML is constructed via DOM APIs (`createElement`, `textContent`, `setAttribute`).
3. **Deterministic App Identity**: The extension's 32-character Chromium App ID (`jjoepgfpagdecpcbabppbbnblaeklpic`) is mathematically bound to its RSA-2048 public key pinned directly in `manifest.json`.

---

## Key Features

### Smart Context Pruning & Token Optimization
*Location: `shared/token-optimizer.js`*

Web pages contain massive amounts of noisy navigation chrome, footers, tracking scripts, and cookie banners that inflate LLM prompt tokens and trigger quota limits. TabScan Q&A introduces an intelligent multi-stage token optimizer:
- **Boilerplate Selector Stripping**: Safely removes `nav`, `footer`, `aside`, `.ad`, `[role="banner"]`, `[role="contentinfo"]`, and `.cookie-banner` elements while strictly preserving inputs, quizzes, and forms.
- **Whitespace Collapsing**: Eliminates repetitive indentation, tabs, and excess newlines while preserving markdown-friendly structural spacing.
- **Semantic Boundary Truncation**: When page text exceeds token thresholds, truncation cuts cleanly at the nearest paragraph boundary (`\n\n`), falling back gracefully to sentence boundaries (`. `, `! `, `? `). Context is never cut mid-word or mid-sentence.
- **Selective Screenshot Attachment**: Text-only Q&A queries bypass costly multi-tile full-page screenshots, saving up to 80% of multimodal tokens. Viewport screenshots are attached only when visual diagrams, canvas, or explicit image elements are present.

### Multi-Tier Intelligent Query Caching
*Location: `shared/cache-manager.js`*

TabScan Q&A features an intelligent two-tier caching engine that eliminates redundant API calls:
- **Deterministic Cache Keys**: Computes a 32-character SHA-256 digest of `(contentHash + query + model + answerStyle)`.
- **Tier 1 (In-Memory Map)**: High-speed volatile cache that answers identical queries within the same session in **0ms** without touching disk storage.
- **Tier 2 (Chrome Local Storage)**: Persistent storage using `chrome.storage.local` with automatic promotion to Tier 1 on cache read.
- **LRU Eviction & Budgeting**: Strict limit of 150 cached entries or 4 MB of storage, automatically purging the least recently used entries.
- **Visual Feedback**: Cached answers are instantly badged in the UI with a subtle emerald `⚡ Cached (0ms)` indicator.

### Progressive Response Streaming & Pulsing Cursor
*Location: `shared/gemini-client.js`, `sidepanel/sidepanel.js`, `sidepanel/sidepanel.css`*

- **Low-Latency SSE Streaming**: Parses Server-Sent Events in real time, rendering incremental text tokens into the side panel as they arrive from the model.
- **Animated Pulsing Streaming Cursor**: An animated cursor (`.streaming-cursor`) pulses alongside streaming markdown output to provide clear visual progress.
- **WCAG Accessibility Compliance**: Fully respects `prefers-reduced-motion: reduce` by replacing animations with a steady high-contrast cursor.
- **Safe Markdown Rendering**: Employs `shared/markdown.js` to render headings, bold/italic text, lists, and syntax-highlighted code blocks with copy-to-clipboard buttons without touching `innerHTML`.

### Dual AI Provider Support
*Location: `shared/gemini-client.js`, `shared/constants.js`*

Choose your preferred AI intelligence engine:
- **Google Gemini**: Uses the modern `v1beta/interactions` REST & SSE API with full support for:
  - `gemini-3.8-flash` (default, high-speed & cost-effective)
  - `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`
  - `gemini-4-argon` and custom Gemini model IDs
  - Multimodal inline image attachments (data URLs)
- **Anthropic Claude**: Full compatibility with the Claude Messages API (`v1/messages`):
  - `claude-3-5-sonnet-20241022`
  - `claude-3-5-haiku-20241022`
  - Automatic SSE chunk mapping (`content_block_delta` -> streaming text)
- **Dynamic Provider Routing**: Automatic detection based on model name prefix, with isolated API key management and connection testing for both providers.

### Rate-Limit Auto-Wait & Countdown Resume (F15)
*Location: `shared/gemini-client.js`, `sidepanel/sidepanel.js`*

When working with free-tier API quotas, hitting rate limits (HTTP 429 / 529 / `RESOURCE_EXHAUSTED`) is a common frustration. TabScan Q&A handles this autonomously:
- **Header Inspection**: Accurately parses `retry-after` (seconds or HTTP date) or rate-limit reset headers (`x-ratelimit-reset-*`).
- **Exponential Backoff Fallback**: Employs randomized exponential backoff with jitter if headers are absent.
- **Side-Panel Countdown Card**: Mounts a live countdown banner (`.rate-limit-card`) informing the user of the exact seconds remaining before retry.
- **Automatic Resume**: When the countdown completes, the pending query automatically retries and resumes streaming without requiring the user to re-type or click anything.

### Advanced In-Page Exercise Interactions
*Location: `scripts/page-actions.js`, `scripts/page-scanner.js`*

TabScan Q&A does not merely answer questions; it can interact with the page to solve them:
- **Highlighter**: Uses the modern `CSS.highlights` API (with a seamless `<mark>` fallback) to visually highlight answers and quotes in the host page.
- **Safe Form Apply**: Fills radio buttons, multi-select checkboxes, ARIA radio groups, `<select>` dropdowns, and text fields (`<input>`, `<textarea>`, `contenteditable`). **Strict safety guarantee**: It never clicks submit buttons or triggers unauthorized form posts.
- **Drag-and-Drop Cloze Exercises**: Solves word-bank fill-in-the-blank exercises by generating authentic Mouse/Pointer events (and HTML5 DragEvent/DataTransfer fallbacks) across multiple blanks inside shared sentences.
- **Category Column Sorting**: Resolves multi-column categorization exercises (e.g., sorting philosophical claims between Plato and Epicurus) by dragging items into designated dropzones.
- **Matching Cards**: Solves memory and definition matching exercises by clicking left-to-right paired cards in sequence.
- **Multi-Frame Support**: Seamlessly traverses and aggregates exercises across child `<iframe>` elements.

### Modern Responsive UI/UX with Container Queries
*Location: `sidepanel/sidepanel.css`, `sidepanel/sidepanel.html`*

- **CSS Container Queries (`@container (min-width: 480px)`)**: Adapts cleanly from compact narrow panels (320px) to expanded desktop widths (800px).
- **Elevated Slate/Zinc Theme**: Clean neutral color palette with elevated cards, readable typography, and smooth micro-interactions.
- **Quick-Prompt Chips**: Delegated single-event listener pattern ensures instant chip execution without memory leaks or duplicate triggers.
- **Roving Keyboard Tabindex**: Complete keyboard navigation support across all controls.

---

## Project File Layout

| File / Path | Purpose & Responsibility |
|---|---|
| `manifest.json` | Manifest V3 declaration, permissions, `side_panel`, public `key`, and `update_url`. |
| `service-worker.js` | Background service worker handling side panel activation and context menus. |
| `sidepanel/sidepanel.html` | Side panel interface markup (100% CSP compliant, no inline scripts or handlers). |
| `sidepanel/sidepanel.css` | Design system, container queries (320px–800px), pulsing cursor, rate-limit countdown. |
| `sidepanel/sidepanel.js` | Side panel UI controller, event delegation, streaming lifecycle, and settings management. |
| `scripts/page-scanner.js` | In-tab DOM scanner, question extractor, and visual element inventory collector. |
| `scripts/page-actions.js` | In-tab answer highlighting, form filling, DnD cloze, category sorting, matching cards. |
| `scripts/page-highlight.css`| Injected host-page styles for highlights, applied badges, and accessibility markers. |
| `shared/token-optimizer.js` | DOM context pruning, boilerplate stripping, whitespace collapsing, selective screenshots. |
| `shared/cache-manager.js` | Two-tier query caching (in-memory + `chrome.storage.local`), LRU eviction, 0ms replay. |
| `shared/gemini-client.js` | Dual provider streaming client (Gemini Interactions + Claude), F15 auto-wait retry logic. |
| `shared/markdown.js` | Safe DOM-only Markdown renderer (zero `innerHTML`), code block syntax formatting. |
| `shared/constants.js` | Configuration constants, provider definitions, model defaults, and URL restriction checks. |
| `shared/frame-helpers.js` | Cross-frame messaging and exercise aggregation helpers for `<iframe>` elements. |
| `scripts/package-release.mjs`| Zero-dependency CRX3 packaging script and Omaha v2.0 update manifest generator. |
| `docs/SELF_HOSTED_UPDATES.md`| Comprehensive self-hosted distribution and enterprise GPO deployment manual. |
| `tests/extension.test.mjs` | 39 unit tests covering manifest, DOM actions, DnD, Gemini/Claude routing, and F15 retry. |
| `tests/e2e-suite.test.mjs` | 118 E2E tests across 4 Tiers (Feature Coverage, Boundaries, Pairwise, Scenarios). |
| `tests/fixtures/` | Synthetic fixtures, DOM mocks, and SSE stream generators for automated testing. |
| `dist/` | Production distribution artifacts (`.crx`, `.zip`, `updates.xml`, `release-metadata.json`). |

---

## Installation & Getting Started

### Option A: Load as Unpacked Extension (Developer Mode)

1. Clone or download this repository to your local machine.
2. Open Google Chrome (or Microsoft Edge / Brave) and navigate to `chrome://extensions`.
3. In the upper-right corner, toggle **Developer mode** to **ON**.
4. Click the **Load unpacked** button in the top-left toolbar.
5. In the file picker, select the project directory (`tab-qa-extension`).
6. Click the extension puzzle piece icon in the browser toolbar and pin **TabScan Q&A**.
7. Click the **TabScan Q&A** toolbar icon to open the Side Panel.

### Option B: Install Packaged CRX3 File (With Automatic Updates)

> [!IMPORTANT]
> **Windows Chrome Users (Free Web Store Bypass & Silent Auto-Updates)**:  
> Google Chrome restricts third-party `.crx` files unless they are published to the Chrome Web Store ($5 fee) or whitelisted in Chrome's enterprise policy. To install the `.crx` and enable **automatic silent background updates** from GitHub for free:
> 
> 1. Run the one-time allowlist setup:
>    - Double-click [`enable-tabscan-updates.bat`](enable-tabscan-updates.bat) (or merge [`enable-tabscan-updates.reg`](enable-tabscan-updates.reg))
>    - *Or run this single PowerShell command:*
>      ```powershell
>      reg add "HKCU\Software\Policies\Google\Chrome\ExtensionInstallAllowlist" /v 1 /t REG_SZ /d "jjoepgfpagdecpcbabppbbnblaeklpic" /f
>      ```
> 2. Open Google Chrome (or Brave / Edge) and go to `chrome://extensions`.
> 3. In the top-right corner, toggle **Developer mode** to **ON**.
> 4. Drag and drop `tab-scan-qa.crx` (from the latest release or `dist/`) directly onto the `chrome://extensions` tab.
> 5. When prompted with *"Add TabScan Q&A?"*, click **Add extension**.
> 
> ✨ **Auto-Update Enabled**: Once installed, Chrome will automatically poll `dist/updates.xml` on GitHub and silently update TabScan Q&A in the background whenever you publish a new version. No manual updates needed!

### Configuration & API Keys

1. In the TabScan Q&A Side Panel header, click the **Settings** gear icon.
2. Choose your **Default Model** (e.g., `gemini-3.8-flash` or `claude-3-5-sonnet-20241022`).
3. Enter your API Key:
   - For Gemini: Obtain a free API key from [Google AI Studio](https://aistudio.google.com/).
   - For Claude: Obtain an API key from the [Anthropic Console](https://console.anthropic.com/).
4. Click **Test key** to verify connection, then click **Save settings**.

---

## Distribution & Packaging Pipeline

TabScan Q&A includes a fully automated, standalone release packaging pipeline built with native Node.js APIs (`node:crypto`, `node:zlib`, `node:fs`).

### Zero-Dependency CRX3 Packaging Script

To produce signed production releases, run:

```bash
node scripts/package-release.mjs
```

#### CLI Options
```text
Options:
  --key=<path>          Path to RSA private key PEM (default: key.pem, auto-generated if missing)
  --out=<dir>           Output directory for release artifacts (default: dist/)
  --update-url=<url>    URL for remote updates.xml manifest
  --codebase-url=<url>  Download URL for remote .crx binary
  --version=<ver>       Version string override (default: manifest.json version)
  -h, --help            Show help instructions
```

### Distribution Artifacts

The packaging script outputs four verified production artifacts in `dist/`:

| Artifact | Format | Description |
|---|---|---|
| `dist/tab-scan-qa.crx` | CRX3 Binary | Signed Chromium extension with `Cr24` magic header, version 3, and RSA-SHA256 signature. |
| `dist/tab-scan-qa.zip` | ZIP Archive | Clean source bundle excluding developer secrets (`key.pem`), test fixtures, and documentation. |
| `dist/updates.xml` | Omaha v2.0 XML | Google Update Protocol v2.0 manifest specifying App ID, version, and CRX download URL. |
| `dist/release-metadata.json` | JSON | Release audit ledger containing SHA-256 hash, byte sizes, and packaged file inventory. |

### Self-Hosted & Enterprise Auto-Updates

Because the extension embeds an `update_url` pointing to `updates.xml`, Chromium browsers automatically poll for updates in the background every 4–5 hours. When a newer version is detected, Chromium silently downloads and installs the updated `.crx` package without requiring the Chrome Web Store.

For detailed enterprise deployment instructions via **Windows Group Policy (GPO / Registry)**, **macOS Configuration Profiles (.plist)**, and **Linux JSON policies**, refer to the full deployment guide:

👉 **[Self-Hosted Auto-Update Pipeline & CRX3 Deployment Guide](docs/SELF_HOSTED_UPDATES.md)**

---

## Testing & Quality Assurance

TabScan Q&A is backed by an automated test suite comprising **157 tests** executed with Node.js's built-in test runner (`node:test`). The test suite requires strictly zero third-party testing frameworks.

### 157 Automated Tests

```
================================================================================
  TEST SUITE SUMMARY
================================================================================
  ✔ Extension Unit Tests (tests/extension.test.mjs)       :  39 passed (0 failed)
  ✔ 4-Tier E2E Test Suite (tests/e2e-suite.test.mjs)      : 118 passed (0 failed)
--------------------------------------------------------------------------------
  TOTAL AUTOMATED TEST COVERAGE                           : 157 passed (0 failed)
================================================================================
```

### Test Tier Architecture

The test coverage is organized into four rigorous testing tiers adhering to the Category-Partition method, Boundary Value Analysis, and Pairwise interaction testing:

#### Unit Test Suite (`tests/extension.test.mjs` — 39 Tests)
- MV3 manifest schema validation & PNG icon integrity.
- Page scanner candidate detection & hidden node suppression.
- Prompt formatting & multimodal image attachment payload assembly.
- Safe DOM Markdown rendering & link pseudo-protocol sanitization (`javascript:` blocked).
- In-page answer highlighting (`CSS.highlights` and `<mark>` fallback).
- Safe form control auto-filling (radio, checkbox, ARIA controls, select, text).
- Pointer and HTML5 Drag-and-Drop cloze exercise resolution.
- Category column sorting and matching card click sequences.
- Claude & Gemini provider detection, routing, and SSE event streaming.
- JS syntax balance across all codebase files.
- **F15 Rate-Limit Auto-Wait**: Verification of `retry-after` header parsing, countdown triggering, and automatic resumption upon quota reset.

#### Tier 1: Feature Coverage (`tests/e2e-suite.test.mjs` — 48 Tests)
Isolated positive and functional tests across all core capabilities (6 tests each):
- `1.1 DOM Context Pruning & Compression` (6 tests)
- `1.2 Multi-Tier Intelligent Query Caching` (6 tests)
- `1.3 Progressive Response Streaming` (6 tests)
- `1.4 Manifest Auto-Update & Key Binding` (6 tests)
- `1.5 Zero-Dependency CRX3 Packaging` (6 tests)
- `1.6 Omaha v2.0 Update XML Manifest` (6 tests)
- `1.7 Side-Panel UI States & Responsiveness` (6 tests)
- `1.8 Micro-Interactions & Visual Feedback` (6 tests)

#### Tier 2: Boundary & Corner Cases (`tests/e2e-suite.test.mjs` — 48 Tests)
Extreme inputs, edge cases, and fault injection (6 tests each):
- `2.1 Token Pruner Boundaries` (empty DOM, massive text, zero matches).
- `2.2 Cache Storage Boundaries` (LRU 150-entry cap, 4MB quota limit, corrupted storage).
- `2.3 Streaming Boundaries` (malformed SSE, mid-stream abort signals, 0-byte chunks).
- `2.4 Key Derivation Boundaries` (corrupted PEM keys, short keys, invalid SPKI).
- `2.5 CRX3 Packaging Boundaries` (corrupted buffers, truncated CRX files).
- `2.6 Omaha XML Boundaries` (XML entity escaping for `&`, `<`, `>`, `"`, `'`).
- `2.7 UI State Boundaries` (whitespace queries, 320px narrow container, rapid submissions).
- `2.8 Micro-Interaction Boundaries` (clipboard rejection, roving tabindex wrap-around).

#### Tier 3: Cross-Feature Combinations (`tests/e2e-suite.test.mjs` — 16 Tests)
Pairwise combinatorial interactions between subsystems:
- Pruned DOM + Multi-tier caching consistency.
- Progressive streaming + storage persistence + 0ms instant cache replay.
- CRX3 packaging + App ID derivation + `manifest.json` key alignment.
- Streaming abort + cache invalidation safety.
- Container query resizing + clipboard copy interactions.
- Release metadata SHA-256 cryptographic verification.

#### Tier 4: Real-World Scenarios (`tests/e2e-suite.test.mjs` — 6 Tests)
Comprehensive end-to-end user workflows:
1. **Wikipedia Article Q&A**: Large article context pruning, progressive streaming, and instant 0ms cached replay.
2. **Dynamic SPA**: Modern web app with sticky navigation, cookie banners, and dynamic chrome pruning.
3. **Full Packaging Pipeline**: End-to-end build producing signed CRX3, Omaha XML, and cryptographic verification.
4. **Narrow Container Responsiveness**: Verifying side panel layout and interactions at 320px width.
5. **Network Interruption Recovery**: Simulating network failure during streaming with graceful retry recovery.
6. **Multimodal Diagram Query**: Verifying selective screenshot attachment for diagram and canvas queries.

### Running the Test Suites

To execute the test suites on any machine with Node.js (v18+ recommended):

```bash
# 1. Run unit test suite (39 tests)
node --test tests/extension.test.mjs

# 2. Run E2E test suite across all 4 tiers (118 tests)
node --test tests/e2e-suite.test.mjs

# 3. Run the complete test suite (all 157 tests)
node --test tests/extension.test.mjs tests/e2e-suite.test.mjs
```

---

## Security & Compliance

- **No Remote Code Execution**: Strictly adheres to Chrome Manifest V3 Content Security Policy (CSP). Contains no `eval()`, `Function()`, or external CDN script tags.
- **XSS-Safe Markdown**: `shared/markdown.js` explicitly blocks `javascript:`, `vbscript:`, and `data:` pseudo-protocols on links, and creates DOM nodes without `innerHTML`.
- **Form Safety Guarantee**: `scripts/page-actions.js` is programmed to never click `type="submit"` buttons or trigger `.submit()` on forms.
- **Protected Cryptographic Key**: The private signing key (`key.pem`) is excluded from `.gitignore`, packaged ZIP archives, and git commits.
- **Restricted URL Protection**: Automatically detects and gracefully disables scanning on restricted browser pages (`chrome://`, `edge://`, `about:`, and the Chrome Web Store). Local `file://` scanning requires user-granted permission in extension details.

---

## License

MIT License. Designed and engineered for high-performance browser extension workflows.
