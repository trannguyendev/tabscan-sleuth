# 🕵️‍♂️ Tab-Sleuth

> **Your AI study buddy and quiz assistant — right inside Google Chrome's side panel.**

[![Chrome Extension MV3](https://img.shields.io/badge/Chrome-Extension%20MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/reference/manifest)
[![Version](https://img.shields.io/badge/version-v1.0.1-blue.svg?style=flat-square)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Tests Passing](https://img.shields.io/badge/tests-158%20passing-brightgreen.svg?style=flat-square)](#-developer--technical-guide)
[![Status](https://img.shields.io/badge/status-active%20release-success.svg?style=flat-square)](https://github.com/trannguyendev/tabscan-sleuth/releases)
[![Dependencies](https://img.shields.io/badge/dependencies-0%20(Pure%20Vanilla)-blueviolet.svg?style=flat-square)](#-developer--technical-guide)

---

## 🌟 What is Tab-Sleuth?

Have you ever worked on an online quiz, practice exam, homework assignment, or reading comprehension test and wished you had an intelligent helper right beside your page?

**Tab-Sleuth** is a smart, friendly Chrome extension that sits neatly in your browser's **Side Panel**. With a single click, it scans your current webpage, spots questions or exercises, and gives you clear, step-by-step explanations powered by Google Gemini or Anthropic Claude — **without ever leaving your tab or switching windows!**

### ✨ Why You'll Love It:

- 🔍 **One-Click Page Scanner**: Instantly discovers multiple-choice questions, fill-in-the-blanks, matching exercises, and reading comprehension passages.
- 💡 **Side-by-Side Explanations**: Answers and helpful reasoning stream live in a sidebar right next to your work.
- 🎯 **Visual Highlights**: Highlights key evidence and correct answers directly on the webpage so you can follow along easily.
- ✍️ **Safe In-Page Selection**: Can fill in multiple-choice choices or blanks for you. **Safety Guarantee**: Tab-Sleuth *never* clicks "Submit" or finishes exams for you — you stay in 100% control!
- ⚡ **Lightning Fast (0ms Replay)**: Automatically remembers questions you have already asked. Re-asking gives an instant answer with zero waiting and zero wasted AI quota.
- ⏳ **Smart Rate-Limit Auto-Wait**: If you ever hit a free API rate limit, Tab-Sleuth displays a live countdown timer and automatically resumes your answer when the countdown hits zero!
- 🔒 **100% Private & Direct**: There are no tracking servers or third-party databases. All requests go directly from your browser to Google or Anthropic using your own free API key.

---

## 🚀 3-Step Quick Install Guide

Installing Tab-Sleuth takes less than 60 seconds on any Windows PC. No coding or developer tools required!

### Step 1: Download the 1-Click Installer
Click below to download the official installer helper:

👉 **[📥 Download Install-TabSleuth.bat](https://github.com/trannguyendev/tabscan-sleuth/releases/latest/download/Install-TabSleuth.bat)**

*(Or download it from the [Latest GitHub Release](https://github.com/trannguyendev/tabscan-sleuth/releases/latest)).*

---

### Step 2: Double-Click `Install-TabSleuth.bat`
1. Open your Downloads folder and double-click **`Install-TabSleuth.bat`**.
2. *Windows SmartScreen Note*: If Windows shows a blue popup saying *"Windows protected your PC"*, simply click **"More info"** and then **"Run anyway"**.
3. **What happens automatically**:
   - Tab-Sleuth downloads and unpacks safely into your personal app folder (`%LOCALAPPDATA%\TabSleuth`).
   - The exact folder path is **automatically copied to your clipboard**.
   - An **"Update Tab-Sleuth"** shortcut is placed on your Desktop for easy 1-click updates.
   - Google Chrome opens automatically to your extensions page (`chrome://extensions`).

---

### Step 3: Load into Chrome (Takes 10 Seconds)
In the Chrome tab that just opened:
1. Turn **ON** the switch called **"Developer mode"** in the top-right corner.
2. Click the **"Load unpacked"** button in the top-left toolbar.
3. In the folder selection window, click inside the folder path box, press **`Ctrl + V`** (to paste the path that was copied for you), and press **Enter** (or click **"Select Folder"**).

🎉 **You're all set!** Click the puzzle piece icon (🧩) next to your browser's address bar and click the pin icon next to **Tab-Sleuth** to keep it handy!

---

### 🔑 1-Minute Setup: Add Your Free AI Key

Tab-Sleuth uses Google's official Gemini AI, which is completely free for personal use:

1. Click the **Tab-Sleuth** icon in your Chrome toolbar to open the Side Panel.
2. Click the **⚙️ Settings** gear icon in the top header.
3. Get a 100% free API key from **[Google AI Studio](https://aistudio.google.com/)** *(click "Create API key" — no credit card needed)*.
4. Paste your key into Tab-Sleuth, click **Test key** to confirm it works, and click **Save settings**.
*(Prefer Claude? You can enter your Anthropic Claude API key in settings as well!)*

---

### 🔄 How to Update in the Future

Whenever an update is available:
1. An **"Update available"** badge will light up inside the extension.
2. Double-click the **"Update Tab-Sleuth"** shortcut on your Desktop.
3. Click the reload (🔄) button next to Tab-Sleuth in `chrome://extensions` (or restart Chrome). Done!

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><b>Is Tab-Sleuth completely free?</b></summary>
<br>
Yes! Tab-Sleuth is 100% free and open-source software released under the MIT license. Google Gemini also provides a generous free tier for personal API usage that costs $0.
</details>

<details>
<summary><b>Does Tab-Sleuth send my browsing data or passwords anywhere?</b></summary>
<br>
<b>No.</b> Tab-Sleuth operates entirely within your browser. There is no middleman backend server, tracking script, or telemetry database. When you click scan or ask a question, the request is sent directly from your Chrome browser to Google (or Anthropic) over an encrypted HTTPS connection using your private API key.
</details>

<details>
<summary><b>What browser permissions does Tab-Sleuth need and why?</b></summary>
<br>
Tab-Sleuth requests only the minimal permissions required to function:
- <b>Side Panel</b>: To display the question helper in Chrome's native sidebar.
- <b>Active Tab & Scripting</b>: To detect questions on the page when you ask it to scan, and to highlight relevant answers. It only inspects a page when you initiate an action.
- <b>Storage</b>: To remember your settings and store recent question answers locally on your computer so it doesn't waste your AI quota answering identical questions twice.
</details>

<details>
<summary><b>Will Tab-Sleuth automatically submit my quiz or exam?</b></summary>
<br>
<b>No, never.</b> Tab-Sleuth contains a hardcoded safety lock in its page automation script that strictly blocks clicks on submit buttons or form submission triggers. You remain entirely in control of reviewing and submitting your own work.
</details>

<details>
<summary><b>What happens if I hit the AI rate limit?</b></summary>
<br>
Free API keys have brief hourly or per-minute rate limits. If you ever hit one, Tab-Sleuth automatically detects the rate-limit reset time, shows a friendly live countdown timer in the sidebar, and resumes your streaming answer the moment the limit clears!
</details>

<details>
<summary><b>Can I use Anthropic Claude instead of Google Gemini?</b></summary>
<br>
Yes! In the Settings panel, choose any supported Claude model (such as <code>claude-3-5-sonnet</code>), enter your Anthropic API key, and Tab-Sleuth will seamlessly route all requests through Claude's streaming API.
</details>

<details>
<summary><b>Why do I need to turn on "Developer mode" in Chrome?</b></summary>
<br>
Because Tab-Sleuth is distributed directly from its open-source GitHub repository rather than the Chrome Web Store. Turning on Developer mode simply allows Chrome to load extensions directly from a local folder on your computer.
</details>

<details>
<summary><b>How do I uninstall Tab-Sleuth?</b></summary>
<br>
Go to <code>chrome://extensions</code>, find Tab-Sleuth, and click <b>Remove</b>. You can also delete the <code>%LOCALAPPDATA%\TabSleuth</code> folder and the Desktop shortcut at any time.
</details>

---

## 🛠️ Developer & Technical Guide

<details>
<summary><b>Click to expand architecture, packaging pipeline, and test suite details</b></summary>
<br>

### Architecture Overview

Tab-Sleuth is engineered strictly around Chrome's modern Manifest V3 side panel architecture (`chrome.sidePanel`, Chrome 116+) with zero runtime dependencies.

```text
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
│        - DOM extraction, question detection               │ Apply /         │
│        - Visible / iframe content inventory               │ Highlight       │
└──────────────────┬────────────────────────────────────────┼─ Actions ───────┘
                   │ Extracted DOM / Text                   │
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
│  │ - Rate-Limit Auto-Wait & Countdown Resume (429 / 529 retry-after)     │  │
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

### Core Technical Innovations

1. **Zero External Dependencies**: Implemented in 100% pure vanilla modern JavaScript (ES2022+) and CSS3 without frameworks, bundlers, or third-party npm libraries.
2. **Strict Manifest V3 Security**: Zero `eval()`, zero remote script loading, zero `new Function()`, and strictly zero `innerHTML`. All DOM construction uses safe APIs (`createElement`, `textContent`, `setAttribute`).
3. **Smart Token Pruning**: Strips boilerplate elements (`nav`, `footer`, ads, cookie banners) while strictly preserving inputs, quizzes, and forms; truncates at paragraph/sentence boundaries.
4. **Two-Tier Query Cache**: High-speed Tier 1 In-Memory Map (0ms replay) backed by Tier 2 `chrome.storage.local` with deterministic SHA-256 keys and LRU eviction.
5. **Rate-Limit Auto-Wait & Resume**: Parses `retry-after` and `x-ratelimit-reset-*` headers, mounts a real-time countdown banner in the UI, and automatically resubmits pending queries once the limit clears.

### Project Layout

| File / Path | Responsibility |
|---|---|
| `manifest.json` | Manifest V3 declaration, permissions, side panel entry point, public key, and update URL |
| `service-worker.js` | Background service worker managing side panel activation and context menu triggers |
| `sidepanel/sidepanel.html` | Side panel UI structure (CSP compliant, no inline scripts) |
| `sidepanel/sidepanel.css` | UI design system, container queries (320px–800px), rate-limit countdown banner |
| `sidepanel/sidepanel.js` | Side panel controller, event delegation, streaming lifecycle, settings |
| `scripts/page-scanner.js` | In-tab DOM question extractor, exercise classifier, and visual inventory collector |
| `scripts/page-actions.js` | In-tab answer highlighting, form filling, DnD cloze, category sorting, matching cards |
| `scripts/page-highlight.css`| Injected styles for highlights and accessibility markers |
| `shared/token-optimizer.js` | Boilerplate pruning, whitespace collapsing, selective screenshot decision logic |
| `shared/cache-manager.js` | Two-tier query cache (in-memory + storage), LRU cap, 0ms replay |
| `shared/gemini-client.js` | Streaming client for Gemini Interactions and Claude Messages APIs with auto-retry |
| `shared/markdown.js` | Safe DOM-only Markdown renderer (zero `innerHTML`), code block syntax formatting |
| `shared/constants.js` | Provider definitions, default models, and restricted URL matchers |
| `shared/frame-helpers.js` | Cross-frame messaging and exercise aggregation for multi-`<iframe>` pages |
| `scripts/package-release.mjs`| Zero-dependency CRX3 packaging script and Omaha v2.0 update manifest generator |
| `docs/SELF_HOSTED_UPDATES.md`| Complete self-hosted Omaha v2.0 release manual and enterprise GPO deployment guide |
| `tests/extension.test.mjs` | 40 unit tests covering manifest, DOM actions, DnD, routing, and retry logic |
| `tests/e2e-suite.test.mjs` | 118 E2E tests across 4 testing tiers (Coverage, Boundaries, Pairwise, Scenarios) |
| `dist/` | Production distribution artifacts (`tab-sleuth.crx`, `tab-sleuth.zip`, `updates.xml`) |

### Packaging & Release Pipeline

To produce signed production releases:

```bash
node scripts/package-release.mjs --key=key.pem --version=1.0.1
```

Generates:
- `dist/tab-sleuth.crx`: Cryptographically signed Chromium CRX3 package (RSA-SHA256).
- `dist/tab-sleuth.zip`: Clean zip package for distribution.
- `dist/updates.xml`: Omaha v2.0 update manifest specifying App ID and version.
- `dist/release-metadata.json`: Cryptographic verification hashes and byte sizes.

For enterprise silent rollout via Windows Group Policy (GPO) or Registry, see [docs/SELF_HOSTED_UPDATES.md](docs/SELF_HOSTED_UPDATES.md).

### Automated Test Suite

Tab-Sleuth includes **158 automated tests** executed using Node.js's native test runner (`node:test`) with zero external test dependencies:

```bash
# Run unit tests (40 tests)
node --test tests/extension.test.mjs

# Run E2E test suite (118 tests across 4 tiers)
node --test tests/e2e-suite.test.mjs

# Run all 158 tests
node --test tests/extension.test.mjs tests/e2e-suite.test.mjs
```

</details>

---

## 📄 License

MIT License. Designed and engineered for high-performance, private, and accessible browser extension workflows.
