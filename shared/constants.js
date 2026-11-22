/**
 * Shared constants, default settings, model metadata, and URL helpers.
 */

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'tabscan_settings',
  PENDING_ACTION: 'tabscan_pending_action',
  TAB_CACHE_PREFIX: 'tabscan_cache_',
});

export const PROVIDERS = Object.freeze([
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Fast multimodal reasoning via Google AI Studio',
    defaultModel: 'gemini-3.8-flash',
    getKeyUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'AIzaSy…',
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    description: 'Advanced comprehension via Anthropic Console',
    defaultModel: 'claude-sonnet-4-5',
    getKeyUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-api03-…',
  },
]);

export const CLAUDE_MODELS = Object.freeze([
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (Balanced)',
  },
  {
    id: 'claude-opus-4-5',
    label: 'Claude Opus 4.5 (Most capable)',
  },
  {
    id: 'claude-haiku-3-5',
    label: 'Claude Haiku 3.5 (Fastest Claude)',
  },
]);

export const GEMINI_MODELS = Object.freeze([
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash (Recommended — Fast & smart)',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite (Fastest & lowest cost)',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite (Lightweight & high-speed)',
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon (Flagship deep reasoning)',
  },
]);

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'gemini',
  apiKey: '',
  claudeApiKey: '',
  model: 'gemini-3.8-flash',
  customModel: '',
  autoScan: true,
  scanScreen: true,
  fullPageScan: true,
  autoAnswer: false,
  autoHighlight: true,
  autoApply: false,
  thinkingLevel: 'low',
  answerStyle: 'concise',
  maxPageChars: 36000,
});

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'chrome-search://',
  'https://chromewebstore.google.com',
  'https://chrome.google.com/webstore',
];

/**
 * Checks whether a tab URL can be scanned via chrome.scripting.executeScript.
 * @param {string | undefined | null} url
 * @returns {boolean}
 */
export function isScannableUrl(url) {
  return getUrlRestrictionReason(url) === null;
}

/**
 * Returns a human-readable restriction reason if a URL cannot be scanned, or null if scannable.
 * @param {string | undefined | null} url
 * @returns {string | null}
 */
export function getUrlRestrictionReason(url) {
  if (!url || typeof url !== 'string') {
    return 'This tab has no readable URL yet.';
  }
  const normalized = url.trim().toLowerCase();
  for (const prefix of RESTRICTED_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return 'Browser internal pages and the Chrome Web Store cannot be scanned for security reasons.';
    }
  }
  if (
    !normalized.startsWith('http://') &&
    !normalized.startsWith('https://') &&
    !normalized.startsWith('file://')
  ) {
    return 'Only standard web pages (http, https, or enabled file URLs) can be scanned.';
  }
  return null;
}

/**
 * Extracts a clean hostname or origin label from a URL for display.
 * @param {string | undefined | null} url
 * @returns {string}
 */
export function formatHost(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return 'Local file';
    return parsed.hostname.replace(/^www\./, '') || parsed.origin;
  } catch {
    return '';
  }
}

/**
 * Resolves the effective model ID from saved settings.
 * @param {Partial<typeof DEFAULT_SETTINGS>} settings
 * @returns {string}
 */
export function resolveActiveModel(settings) {
  if (settings?.model === 'custom' && settings?.customModel?.trim()) {
    return settings.customModel.trim();
  }
  if (settings?.model?.trim()) {
    return settings.model.trim();
  }
  return settings?.provider === 'claude' ? 'claude-sonnet-4-5' : DEFAULT_SETTINGS.model;
}
