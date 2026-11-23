# Tab-Sleuth

Tab-Sleuth is a Chrome side panel extension that reads the active tab, detects questions and exercises, and provides grounded explanations alongside your webpage using Google Gemini or Anthropic Claude.

---

## Highlights

- **Side Panel Interface**: Stays open alongside your page without covering content or requiring window switching.
- **Exercise Detection**: Recognizes multiple-choice questions, fill-in-the-blank items, matching pairs, and reading comprehension passages.
- **Evidence Highlighting**: Highlights supporting text directly on the page so you can verify the reasoning.
- **Optional Form Selection**: Can fill in matching radio buttons or input fields on request. Never submits forms or finishes exams automatically.
- **Two-Tier Cache**: Previously answered questions resolve instantly from a local cache without consuming API quota.
- **Automatic Rate-Limit Handling**: If your free API tier hits a momentary rate limit, a live countdown timer displays the reset interval and resumes the stream automatically.
- **Direct & Private**: No tracking servers, intermediaries, or account sign-ups. Requests travel directly from your browser to the AI provider using your own API key.

---

## Installation

Setting up Tab-Sleuth on Windows takes about a minute. No coding tools or build steps required.

### 1. Download the Installer
Download the installer helper:

> **[Download Install-TabSleuth.bat](https://github.com/trannguyendev/tabscan-sleuth/releases/latest/download/Install-TabSleuth.bat)**  
> *(Also available under [Releases](https://github.com/trannguyendev/tabscan-sleuth/releases/latest))*

### 2. Run the Script
Double-click `Install-TabSleuth.bat`.

The script will automatically:
1. Extract the extension to `%LOCALAPPDATA%\TabSleuth`.
2. Copy the installation path to your clipboard.
3. Place an **Update Tab-Sleuth** shortcut on your Desktop.
4. Open Chrome to `chrome://extensions`.

*(If Windows SmartScreen shows a prompt, click **More info** &rarr; **Run anyway**).*

### 3. Load into Chrome
In the Chrome window that opens:
1. Turn on **Developer mode** in the top-right corner.
2. Click **Load unpacked** in the top-left toolbar.
3. Paste the path (`Ctrl + V`) into the folder path box and press **Enter** (or click **Select Folder**).
4. Pin **Tab-Sleuth** from the extension puzzle piece icon in your Chrome toolbar.

---

## Configuration

Tab-Sleuth requires an API key to communicate with an AI model:

1. Click the **Tab-Sleuth** icon in your Chrome toolbar to open the side panel.
2. Click the **Settings** gear icon in the header.
3. Choose your provider:
   - **Google Gemini** *(Free)*: Get a free key at [Google AI Studio](https://aistudio.google.com/) (click *Create API key* &mdash; no credit card required).
   - **Anthropic Claude**: Enter your key from the [Anthropic Console](https://console.anthropic.com/).
4. Click **Test key** to confirm the connection, then click **Save Settings**.

---

## Updating

When a new version is released:
1. A notification bar appears inside the side panel with an **Upgrade** button.
2. Double-click the **Update Tab-Sleuth** shortcut on your Desktop.
3. Click the reload (&#x21bb;) icon next to Tab-Sleuth on `chrome://extensions` (or restart Chrome).

---

## Frequently Asked Questions

### Is Tab-Sleuth free to use?
Yes. The extension is open source under the MIT license. Google Gemini provides a generous free tier for personal API keys with no charge.

### Does Tab-Sleuth collect or send my browsing data?
No. There are no tracking scripts, analytics, or remote logging servers. Page text is only sent to your chosen AI provider (Google or Anthropic) when you initiate a scan or ask a question.

### Will it automatically submit my quiz or test?
No. Tab-Sleuth contains an intentional hardcoded safety lock that prevents it from clicking submit buttons or submitting forms. You always review answers and submit them yourself.

### Why does Chrome require "Developer mode"?
Because Tab-Sleuth is distributed directly through GitHub rather than the Chrome Web Store. Developer mode allows Chrome to run extensions loaded from a local folder on your computer.

### How do I uninstall?
Go to `chrome://extensions`, locate Tab-Sleuth, and click **Remove**. You can also delete the `%LOCALAPPDATA%\TabSleuth` folder and the Desktop shortcut at any time.

---

## Developer Guide

<details>
<summary>Architecture, packaging, and test suite reference</summary>
<br>

### Architecture Overview

Tab-Sleuth is built on Chrome's Manifest V3 side panel API (`chrome.sidePanel`, Chrome 116+) with zero third-party runtime dependencies.

```text
Active Browser Tab
  ├── scripts/page-scanner.js     (DOM extraction, question inventory)
  └── scripts/page-actions.js     (CSS.highlights, form fill, DnD cloze, sorting)
          │
          ▼ chrome.scripting
Chrome MV3 Side Panel
  ├── sidepanel/sidepanel.js      (UI controller, streaming, event delegation)
  ├── shared/token-optimizer.js   (Boilerplate stripping, semantic truncation)
  ├── shared/cache-manager.js     (Two-tier LRU cache: memory + storage.local)
  ├── shared/gemini-client.js     (Streaming client for Gemini and Claude with auto-retry)
  └── shared/markdown.js          (Safe DOM-only Markdown renderer, zero innerHTML)
```

### Technical Features

1. **Zero Runtime Dependencies**: Written in modern vanilla JavaScript (ES2022+) and standard CSS without bundlers or frameworks.
2. **Strict Manifest V3 Security**: No `eval()`, no remote script loading, no `innerHTML`. All DOM construction uses safe browser primitives (`createElement`, `textContent`).
3. **Intelligent Pruning**: Strips boilerplate elements (`nav`, `footer`, ads, cookie banners) while strictly preserving form inputs and question structures.
4. **Two-Tier Cache**: In-memory cache for instant replays backed by `chrome.storage.local` with deterministic SHA-256 keys and LRU eviction.
5. **Retry Handling**: Intercepts `retry-after` rate limits and resumes streaming automatically.

### Packaging

To produce signed production releases:

```bash
node scripts/package-release.mjs --key=key.pem --version=1.0.1
```

Generates:
- `dist/tab-sleuth.crx`: Cryptographically signed Chromium CRX3 package (RSA-SHA256).
- `dist/tab-sleuth.zip`: Distribution zip archive.
- `dist/updates.xml`: Omaha v2.0 update manifest.
- `dist/release-metadata.json`: Release integrity hashes.

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

## License

MIT License.
