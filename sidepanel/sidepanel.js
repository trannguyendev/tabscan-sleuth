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
  collectSnapshotImageParts,
  detectProvider,
  fetchAvailableModels,
  streamCustomQuestion,
  testApiKey,
} from '../shared/gemini-client.js';
import {
  computeScrollPositions,
  mergeFrameActionResults,
  mergeFrameSnapshots,
} from '../shared/frame-helpers.js';
import { renderMarkdown } from '../shared/markdown.js';
import {
  computeQueryCacheKey,
  getQueryCache,
  setQueryCache,
} from '../shared/cache-manager.js';
import { checkGitHubRelease, isNewerVersion, downloadUpdateScript } from '../shared/update-checker.js';

const el = {
  autoScanToggle: document.getElementById('auto-scan-toggle'),
  autoScanLabel: document.getElementById('auto-scan-label'),
  screenScanToggle: document.getElementById('screen-scan-toggle'),
  screenScanLabel: document.getElementById('screen-scan-label'),
  rescanBtn: document.getElementById('rescan-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  tabFavicon: document.getElementById('tab-favicon'),
  tabTitle: document.getElementById('tab-title'),
  tabHost: document.getElementById('tab-host'),
  scanStatus: document.getElementById('scan-status'),
  scanStatusIcon: document.getElementById('scan-status-icon'),
  scanStatusText: document.getElementById('scan-status-text'),
  previewDetails: document.getElementById('preview-details'),
  previewStats: document.getElementById('preview-stats'),
  previewScreenshot: document.getElementById('preview-screenshot'),
  previewScreenshotStrip: document.getElementById('preview-screenshot-strip'),
  previewText: document.getElementById('preview-text'),
  mainContent: document.getElementById('main-content'),
  setupBanner: document.getElementById('setup-banner'),
  openSetupBtn: document.getElementById('open-setup-btn'),
  selectionBanner: document.getElementById('selection-banner'),
  selectionSnippet: document.getElementById('selection-snippet'),
  askSelectionBtn: document.getElementById('ask-selection-btn'),
  analyzeBtn: document.getElementById('analyze-btn'),
  pageActionsToolbar: document.getElementById('page-actions-toolbar'),
  highlightAllBtn: document.getElementById('highlight-all-btn'),
  applyAllBtn: document.getElementById('apply-all-btn'),
  clearHighlightsBtn: document.getElementById('clear-highlights-btn'),
  pageActionStatus: document.getElementById('page-action-status'),
  analysisProgress: document.getElementById('analysis-progress'),
  analysisProgressLabel: document.getElementById('analysis-progress-label'),
  analysisError: document.getElementById('analysis-error'),
  analysisErrorText: document.getElementById('analysis-error-text'),
  retryAnalysisBtn: document.getElementById('retry-analysis-btn'),
  errorSettingsBtn: document.getElementById('error-settings-btn'),
  analysisOutput: document.getElementById('analysis-output'),
  clearChatBtn: document.getElementById('clear-chat-btn'),
  quickChips: document.getElementById('quick-chips'),
  chatThread: document.getElementById('chat-thread'),
  qaForm: document.getElementById('qa-form'),
  questionInput: document.getElementById('question-input'),
  modelPill: document.getElementById('model-pill'),
  sendBtn: document.getElementById('send-btn'),
  stopBtn: document.getElementById('stop-btn'),
  settingsDialog: document.getElementById('settings-dialog'),
  closeSettingsBtn: document.getElementById('close-settings-btn'),
  cancelSettingsBtn: document.getElementById('cancel-settings-btn'),
  settingsForm: document.getElementById('settings-form'),
  providerSegmentedControl: document.getElementById('provider-segmented-control'),
  providerBtnGemini: document.getElementById('provider-btn-gemini'),
  providerBtnClaude: document.getElementById('provider-btn-claude'),
  apiKeyLabel: document.getElementById('api-key-label'),
  getKeyLink: document.getElementById('get-key-link'),
  apiKeyHint: document.getElementById('api-key-hint'),
  apiKeyInput: document.getElementById('api-key-input'),
  toggleKeyBtn: document.getElementById('toggle-key-btn'),
  fetchModelsBtn: document.getElementById('fetch-models-btn'),
  fetchModelsBtnText: document.getElementById('fetch-models-btn-text'),
  fetchModelsStatus: document.getElementById('fetch-models-status'),
  testKeyBtn: document.getElementById('test-key-btn'),
  testKeyStatus: document.getElementById('test-key-status'),
  modelsCountBadge: document.getElementById('models-count-badge'),
  modelSelect: document.getElementById('model-select'),
  customModelField: document.getElementById('custom-model-field'),
  customModelInput: document.getElementById('custom-model-input'),
  thinkingSelect: document.getElementById('thinking-select'),
  styleConcise: document.getElementById('style-concise'),
  styleDetailed: document.getElementById('style-detailed'),
  autoScanCheckbox: document.getElementById('auto-scan-checkbox'),
  scanScreenCheckbox: document.getElementById('scan-screen-checkbox'),
  fullPageScanCheckbox: document.getElementById('full-page-scan-checkbox'),
  autoAnswerCheckbox: document.getElementById('auto-answer-checkbox'),
  autoHighlightCheckbox: document.getElementById('auto-highlight-checkbox'),
  autoApplyCheckbox: document.getElementById('auto-apply-checkbox'),
  srAnnouncer: document.getElementById('sr-announcer'),
  updateBanner: document.getElementById('update-banner'),
  updateBannerText: document.getElementById('update-banner-text'),
  updateBannerBtn: document.getElementById('update-banner-btn'),
  updateBannerDismiss: document.getElementById('update-banner-dismiss'),
  updateModal: document.getElementById('update-modal'),
  updateModalClose: document.getElementById('update-modal-close'),
  updateVersionLabel: document.getElementById('update-version-label'),
  downloadUpdaterLink: document.getElementById('download-updater-link'),
  downloadUpdaterText: document.getElementById('download-updater-text'),
  downloadProgressBar: document.getElementById('download-progress-bar'),
  downloadProgressMeta: document.getElementById('download-progress-meta'),
  downloadIconSlot: document.getElementById('download-icon-slot'),
  viewReleaseLink: document.getElementById('view-release-link'),
  openExtensionsLink: document.getElementById('open-extensions-link'),
  activeVersionIndicator: document.getElementById('active-version-indicator'),
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  selectedProvider: 'gemini',
  fetchedModels: { gemini: [], claude: [] },
  windowId: null,
  currentTab: null,
  snapshot: null,
  analysis: null,
  chatHistory: [],
  scanGeneration: 0,
  analysisAbort: null,
  chatAbort: null,
  updateTimer: null,
  announceTimer: null,
  lastSettingsTrigger: null,
  lastAnalysisAt: 0,
};

function announce(message) {
  clearTimeout(state.announceTimer);
  el.srAnnouncer.textContent = '';
  state.announceTimer = setTimeout(() => {
    el.srAnnouncer.textContent = message;
  }, 150);
}

function setStatusBadge(badgeState, icon, text) {
  el.scanStatus.dataset.state = badgeState;
  el.scanStatusIcon.textContent = icon;
  el.scanStatusText.textContent = text;
}

function updateHeaderControls() {
  const activeModel = resolveActiveModel(state.settings);
  el.modelPill.textContent = activeModel;

  const autoOn = Boolean(state.settings.autoScan);
  el.autoScanToggle.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
  el.autoScanLabel.textContent = autoOn ? 'Auto-scan: On' : 'Auto-scan: Off';

  const screenOn = Boolean(state.settings.scanScreen);
  el.screenScanToggle.setAttribute('aria-pressed', screenOn ? 'true' : 'false');
  el.screenScanLabel.textContent = screenOn ? 'Screen: On' : 'Screen: Off';

  const isClaude = detectProvider(activeModel) === 'claude';
  const hasKey = isClaude
    ? Boolean(state.settings.claudeApiKey?.trim() || state.settings.apiKey?.trim())
    : Boolean(state.settings.apiKey?.trim());
  el.setupBanner.hidden = hasKey;
}

function fnv1aShort(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function setPageActionStatus(message = '', statusState = '') {
  el.pageActionStatus.textContent = message;
  if (statusState) {
    el.pageActionStatus.dataset.state = statusState;
  } else {
    el.pageActionStatus.removeAttribute('data-state');
  }
}

async function ensurePageActionsReady(tabId) {
  let probe = null;
  let useAllFrames = true;
  try {
    probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__tabscanPageActions?.version === 4,
    });
  } catch {
    useAllFrames = false;
    probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__tabscanPageActions?.version === 4,
    });
  }

  if (Array.isArray(probe) && probe.length > 0 && probe.every((entry) => entry?.result === true)) {
    return useAllFrames;
  }

  const missingFrameIds = Array.isArray(probe)
    ? probe
        .filter((entry) => entry && entry.result !== true && typeof entry.frameId === 'number')
        .map((entry) => entry.frameId)
    : [];

  const injectTarget =
    useAllFrames && missingFrameIds.length > 0
      ? { tabId, frameIds: missingFrameIds }
      : { tabId };

  try {
    await chrome.scripting.insertCSS({
      target: injectTarget,
      files: ['scripts/page-highlight.css'],
    });
    await chrome.scripting.executeScript({
      target: injectTarget,
      files: ['scripts/page-actions.js'],
    });
  } catch {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['scripts/page-highlight.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['scripts/page-actions.js'],
    });
    return false;
  }
  return useAllFrames;
}

async function runPageAction(command, items = [], options = {}) {
  const tab = state.currentTab;
  if (!tab?.id || !isScannableUrl(tab.url)) {
    throw new Error('Active tab cannot be modified.');
  }
  if (state.snapshot?.visualOnly) {
    throw new Error('This PDF/image viewer tab does not expose editable page DOM controls.');
  }
  const useAllFrames = await ensurePageActionsReady(tab.id);
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: useAllFrames ? { tabId: tab.id, allFrames: true } : { tabId: tab.id },
      func: (cmd, payload, opts) => globalThis.__tabscanPageActions?.[cmd]?.(payload, opts),
      args: [command, items, options],
    });
  } catch {
    res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (cmd, payload, opts) => globalThis.__tabscanPageActions?.[cmd]?.(payload, opts),
      args: [command, items, options],
    });
  }
  return mergeFrameActionResults(command, res, items);
}

function toPageActionItems(questions = []) {
  return questions.map((q, idx) => ({
    index: q.index ?? idx + 1,
    question: q.question || '',
    question_type: q.question_type || 'open_ended',
    options: Array.isArray(q.options) ? q.options : [],
    selected_options: Array.isArray(q.selected_options) ? q.selected_options : [],
    matching_pairs: Array.isArray(q.matching_pairs) ? q.matching_pairs : [],
    answer: q.answer || '',
    apply_value: q.apply_value || '',
    evidence_quote: q.evidence_quote || '',
  }));
}

async function handleHighlightAnswers(items, { scrollToFirst = false, feedbackEl = null } = {}) {
  if (!items || items.length === 0) return;
  try {
    const res = await runPageAction('highlightAnswers', toPageActionItems(items), { scrollToFirst });
    const count = res.matchedQuestions || 0;
    const msg =
      count > 0
        ? `Highlighted ${count} of ${items.length} answer${items.length === 1 ? '' : 's'} on the page.`
        : 'Could not locate matching text or choices for this answer on the current view.';
    if (feedbackEl) {
      feedbackEl.textContent = count > 0 ? '✓ Highlighted' : 'No DOM match found';
      feedbackEl.dataset.state = count > 0 ? 'ok' : 'warn';
    } else {
      setPageActionStatus(msg, count > 0 ? 'ok' : 'warn');
      announce(msg);
    }
  } catch (err) {
    const errMsg = err.message || 'Unable to highlight on this page.';
    if (feedbackEl) {
      feedbackEl.textContent = errMsg;
      feedbackEl.dataset.state = 'warn';
    } else {
      setPageActionStatus(errMsg, 'error');
    }
  }
}

async function handleApplyAnswers(items, { scrollToFirst = false, feedbackEl = null } = {}) {
  if (!items || items.length === 0) return;
  try {
    const res = await runPageAction('applyAnswers', toPageActionItems(items), {
      scrollToFirst,
      highlightMatched: true,
    });
    const applied = res.appliedCount || 0;
    if (applied === 0) {
      // Fallback: highlight the answer on the page if no editable form control matched
      const hl = await runPageAction('highlightAnswers', toPageActionItems(items), { scrollToFirst });
      const hlCount = hl.matchedQuestions || 0;
      const msg =
        hlCount > 0
          ? 'No editable quiz/form inputs matched; highlighted the answer text instead.'
          : 'No matching form inputs or text found to apply on this view.';
      if (feedbackEl) {
        feedbackEl.textContent = hlCount > 0 ? '✓ Highlighted (no input)' : 'No matching input';
        feedbackEl.dataset.state = 'warn';
      } else {
        setPageActionStatus(msg, 'warn');
        announce(msg);
      }
      return;
    }

    const msg = `Applied ${applied} of ${items.length} answer${items.length === 1 ? '' : 's'} on the page.`;
    if (feedbackEl) {
      const firstResult = res.results?.[0];
      if (firstResult?.controlType === 'matching' && firstResult.totalPairs) {
        feedbackEl.textContent = `✓ Matched ${firstResult.matchedPairs}/${firstResult.totalPairs} pairs`;
      } else if (firstResult?.controlType === 'drag_drop') {
        feedbackEl.textContent = '✓ Dragged into blank';
      } else if (firstResult?.controlType === 'inline-phrase') {
        feedbackEl.textContent = '✓ Clicked phrase(s)';
      } else {
        const kind = firstResult?.controlType;
        feedbackEl.textContent = kind ? `✓ Applied (${kind})` : '✓ Applied';
      }
      feedbackEl.dataset.state = 'ok';
    } else {
      setPageActionStatus(msg, 'ok');
      announce(msg);
    }
  } catch (err) {
    const errMsg = err.message || 'Unable to apply answer on this page.';
    if (feedbackEl) {
      feedbackEl.textContent = errMsg;
      feedbackEl.dataset.state = 'warn';
    } else {
      setPageActionStatus(errMsg, 'error');
    }
  }
}

async function handleClearHighlights() {
  try {
    await runPageAction('clearHighlights', [], {});
    setPageActionStatus('Cleared highlights on the page.');
    for (const node of el.analysisOutput.querySelectorAll('.qa-action-feedback')) {
      node.textContent = '';
      node.removeAttribute('data-state');
    }
    announce('Cleared page highlights.');
  } catch (err) {
    setPageActionStatus(err.message || 'Could not clear highlights.', 'warn');
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.SETTINGS] || {}),
  };
  state.selectedProvider = state.settings.provider || (detectProvider(state.settings.model) === 'claude' ? 'claude' : 'gemini');
  if (state.settings.fetchedModels) {
    state.fetchedModels = {
      gemini: Array.isArray(state.settings.fetchedModels.gemini) ? state.settings.fetchedModels.gemini : [],
      claude: Array.isArray(state.settings.fetchedModels.claude) ? state.settings.fetchedModels.claude : [],
    };
  }
  updateHeaderControls();
}

async function saveSettings(nextSettings) {
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...nextSettings,
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: state.settings,
  });
  updateHeaderControls();
}

async function getTabCache(tabId) {
  if (!tabId) return null;
  const key = `${STORAGE_KEYS.TAB_CACHE_PREFIX}${tabId}`;
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function setTabCache(tabId, value) {
  if (!tabId) return;
  const key = `${STORAGE_KEYS.TAB_CACHE_PREFIX}${tabId}`;
  await chrome.storage.session.set({ [key]: value });
}

function abortInFlightRequests() {
  if (state.analysisAbort) {
    state.analysisAbort.abort();
    state.analysisAbort = null;
  }
  if (state.chatAbort) {
    state.chatAbort.abort();
    state.chatAbort = null;
  }
  el.stopBtn.hidden = true;
  el.sendBtn.disabled = false;
}

function updateTabMetaUI(tab) {
  el.tabTitle.textContent = tab?.title || 'Untitled tab';
  el.tabHost.textContent = formatHost(tab?.url) || tab?.url || '';

  if (tab?.favIconUrl && tab.favIconUrl.startsWith('http')) {
    el.tabFavicon.src = tab.favIconUrl;
    el.tabFavicon.hidden = false;
  } else {
    el.tabFavicon.hidden = true;
    el.tabFavicon.removeAttribute('src');
  }
}

function renderPreviewUI(snapshot) {
  if (!snapshot || snapshot.kind !== 'ready') {
    el.previewDetails.hidden = true;
    el.selectionBanner.hidden = true;
    el.previewScreenshot.hidden = true;
    el.previewScreenshot.removeAttribute('src');
    el.previewScreenshotStrip.hidden = true;
    el.previewScreenshotStrip.replaceChildren();
    return;
  }

  const candidateCount = snapshot.questionCandidates?.length || 0;
  const statsParts = [];
  if (snapshot.totalChars > 0) {
    statsParts.push(`${snapshot.totalChars.toLocaleString()} chars${snapshot.truncated ? ' (trimmed)' : ''}`);
  } else if (snapshot.visualOnly) {
    statsParts.push('Visual / image view');
  }
  statsParts.push(`${candidateCount} question candidate${candidateCount === 1 ? '' : 's'}`);
  if (snapshot.mediaSummary?.imageCount) {
    statsParts.push(`${snapshot.mediaSummary.imageCount} img`);
  }
  const allShots = Array.isArray(snapshot.screenshots) && snapshot.screenshots.length > 0
    ? snapshot.screenshots
    : snapshot.screenshot?.dataUrl
      ? [snapshot.screenshot]
      : [];
  if (allShots.length > 1) {
    statsParts.push(`📷 ${allShots.length} captures`);
  } else if (allShots.length === 1) {
    statsParts.push('📷 Screen captured');
  }

  el.previewStats.textContent = statsParts.join(' · ');

  if (allShots.length > 0) {
    el.previewScreenshot.src = allShots[0].dataUrl;
    el.previewScreenshot.alt = allShots[0].label || 'Captured active tab viewport';
    el.previewScreenshot.hidden = false;
  } else {
    el.previewScreenshot.hidden = true;
    el.previewScreenshot.removeAttribute('src');
  }

  el.previewScreenshotStrip.replaceChildren();
  if (allShots.length > 1) {
    for (const shot of allShots) {
      const thumb = document.createElement('img');
      thumb.className = 'preview-thumb';
      thumb.src = shot.dataUrl;
      thumb.alt = shot.label || 'Page capture thumbnail';
      thumb.title = shot.label || 'Click to preview';
      thumb.addEventListener('click', () => {
        el.previewScreenshot.src = shot.dataUrl;
        el.previewScreenshot.alt = shot.label || 'Captured page section';
      });
      el.previewScreenshotStrip.appendChild(thumb);
    }
    el.previewScreenshotStrip.hidden = false;
  } else {
    el.previewScreenshotStrip.hidden = true;
  }

  el.previewText.textContent = snapshot.text
    ? snapshot.text.slice(0, 2000) + (snapshot.text.length > 2000 ? '\n…' : '')
    : '(No DOM text extracted; screen image will be inspected by Gemini.)';
  el.previewDetails.hidden = false;

  if (snapshot.selection) {
    el.selectionSnippet.textContent = snapshot.selection;
    el.selectionBanner.hidden = false;
  } else {
    el.selectionBanner.hidden = true;
  }
}

function renderCandidatePreview(snapshot) {
  el.pageActionsToolbar.hidden = true;
  setPageActionStatus('');

  const candidates = snapshot?.questionCandidates || [];
  if (candidates.length === 0) {
    el.analysisOutput.replaceChildren();
    const p = document.createElement('p');
    p.className = 'muted-placeholder';
    p.textContent = state.settings.apiKey
      ? 'Click Analyze to inspect this page and its screen image for questions and insights.'
      : 'Page scanned. Add your Gemini API key above to generate answers automatically.';
    el.analysisOutput.appendChild(p);
    return;
  }

  const fragment = document.createDocumentFragment();
  const info = document.createElement('p');
  info.className = 'muted-placeholder';
  info.textContent = state.settings.apiKey
    ? `Detected ${candidates.length} question candidate(s) on the page. Click Analyze to answer them.`
    : `Detected ${candidates.length} question candidate(s) on this page. Add a Gemini API key to answer them automatically:`;
  fragment.appendChild(info);

  for (const cand of candidates.slice(0, 6)) {
    const card = document.createElement('article');
    card.className = 'qa-card';
    const title = document.createElement('h3');
    title.className = 'qa-question-title';
    title.textContent = cand.prompt;
    card.appendChild(title);

    if (cand.options?.length) {
      const ul = document.createElement('ul');
      ul.className = 'options-list';
      for (const opt of cand.options) {
        const li = document.createElement('li');
        li.className = 'option-item';
        li.textContent = opt;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }
    fragment.appendChild(card);
  }

  el.analysisOutput.replaceChildren(fragment);
}

function normalizeText(str) {
  return (str || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripChoicePrefix(str) {
  return normalizeText(str).replace(/^(?:\(?[a-z0-9]{1,2}\)?[.):\-\s]+)+/i, '').trim();
}

function scoreSidepanelOption(optionText, targetText) {
  const optNorm = normalizeText(optionText);
  const tgtNorm = normalizeText(targetText);
  if (!optNorm || !tgtNorm) return 0;
  if (optNorm === tgtNorm) return 1000;

  const optStripped = stripChoicePrefix(optionText) || optNorm;
  const tgtStripped = stripChoicePrefix(targetText) || tgtNorm;
  if (optStripped && tgtStripped && optStripped === tgtStripped) return 900;

  if (optStripped.length >= 4 && tgtStripped.length >= 4) {
    const shorter = optStripped.length <= tgtStripped.length ? optStripped : tgtStripped;
    const longer = optStripped.length <= tgtStripped.length ? tgtStripped : optStripped;
    const ratio = shorter.length / longer.length;
    if (ratio >= 0.65 && longer.includes(shorter)) {
      return Math.round(350 + ratio * 350);
    }
  }
  return 0;
}

function getMatchedOptionSet(item) {
  const matched = new Set();
  const options = Array.isArray(item?.options) ? item.options : [];
  if (options.length === 0) return matched;

  const isMulti = item.question_type === 'multi_select';
  const selected = Array.isArray(item.selected_options) ? item.selected_options.filter(Boolean) : [];
  const targets =
    selected.length > 0
      ? isMulti
        ? selected
        : [selected[0]]
      : item.answer
        ? [item.answer]
        : [];

  if (targets.length === 0) return matched;

  if (isMulti) {
    for (const opt of options) {
      if (targets.some((t) => scoreSidepanelOption(opt, t) > 0)) {
        matched.add(opt);
      }
    }
    return matched;
  }

  let bestOpt = null;
  let bestScore = 0;
  for (const opt of options) {
    const score = scoreSidepanelOption(opt, targets[0]);
    if (score > bestScore) {
      bestScore = score;
      bestOpt = opt;
    }
  }
  if (bestOpt) matched.add(bestOpt);
  return matched;
}

function formatQuestionType(type) {
  const labels = {
    multiple_choice: 'Multiple Choice',
    multi_select: 'Multi-Select',
    true_false: 'True / False',
    matching: 'Matching Pairs',
    drag_drop: 'Drag & Drop',
    short_answer: 'Short Answer',
    coding_or_math: 'Code & Math',
    open_ended: 'Open Exploration',
  };
  return labels[type] || 'Question';
}

function formatConfidence(confidence) {
  if (confidence === 'high') return { icon: '★', label: 'High match' };
  if (confidence === 'medium') return { icon: '●', label: 'Medium match' };
  return { icon: '○', label: 'Low match' };
}

function copyTextWithFeedback(text, button, defaultLabel = 'Copy') {
  if (!navigator.clipboard?.writeText) return;
  navigator.clipboard
    .writeText(text)
    .then(() => {
      button.textContent = 'Copied';
      button.classList.add('copied-highlight');
      setTimeout(() => {
        button.textContent = defaultLabel;
        button.classList.remove('copied-highlight');
      }, 2000);
    })
    .catch(() => {
      // Graceful fallback if clipboard access rejected
    });
}

function renderAnalysisOutput(analysis) {
  if (!analysis) {
    el.pageActionsToolbar.hidden = true;
    setPageActionStatus('');
    el.analysisOutput.replaceChildren();
    return;
  }

  const questions = Array.isArray(analysis.questions) ? analysis.questions : [];
  const canManipulateDom = questions.length > 0 && isScannableUrl(state.currentTab?.url) && !state.snapshot?.visualOnly;
  el.pageActionsToolbar.hidden = !canManipulateDom;
  if (!canManipulateDom) {
    setPageActionStatus('');
  }

  const fragment = document.createDocumentFragment();

  if (analysis.page_summary) {
    const summaryCard = document.createElement('article');
    summaryCard.className = 'summary-card';

    const header = document.createElement('div');
    header.className = 'summary-header';
    const badge = document.createElement('span');
    badge.className = 'badge badge-primary';
    badge.textContent = questions.length
      ? `${questions.length} Question${questions.length === 1 ? '' : 's'} Answered`
      : 'Page Summary';
    header.appendChild(badge);
    summaryCard.appendChild(header);

    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    renderMarkdown(body, analysis.page_summary);
    summaryCard.appendChild(body);

    fragment.appendChild(summaryCard);
  }

  if (questions.length > 0) {
    questions.forEach((item, index) => {
      const card = document.createElement('article');
      card.className = 'qa-card';

      const header = document.createElement('div');
      header.className = 'qa-card-header';

      const tags = document.createElement('div');
      tags.className = 'tag-row';

      const numBadge = document.createElement('span');
      numBadge.className = 'badge badge-primary';
      numBadge.textContent = `Q${index + 1}`;
      tags.appendChild(numBadge);

      const typeBadge = document.createElement('span');
      typeBadge.className = 'badge';
      typeBadge.textContent = formatQuestionType(item.question_type);
      tags.appendChild(typeBadge);

      const conf = formatConfidence(item.confidence);
      const confBadge = document.createElement('span');
      confBadge.className = `badge badge-confidence-${item.confidence || 'medium'}`;
      confBadge.textContent = `${conf.icon} ${conf.label}`;
      tags.appendChild(confBadge);

      header.appendChild(tags);
      card.appendChild(header);

      const qTitle = document.createElement('h3');
      qTitle.className = 'qa-question-title';
      qTitle.textContent = item.question;
      card.appendChild(qTitle);

      if (Array.isArray(item.options) && item.options.length > 0) {
        const matchedOptions = getMatchedOptionSet(item);
        const ul = document.createElement('ul');
        ul.className = 'options-list';
        for (const opt of item.options) {
          const li = document.createElement('li');
          const matched = matchedOptions.has(opt);
          li.className = matched ? 'option-item option-item-match' : 'option-item';
          const marker = document.createElement('span');
          marker.setAttribute('aria-hidden', 'true');
          marker.textContent = matched ? '✓' : '○';
          const labelSpan = document.createElement('span');
          labelSpan.textContent = opt;
          li.append(marker, labelSpan);
          ul.appendChild(li);
        }
        card.appendChild(ul);
      }

      if (Array.isArray(item.matching_pairs) && item.matching_pairs.length > 0) {
        const pairList = document.createElement('ul');
        pairList.className = 'matching-pairs-list';
        item.matching_pairs.forEach((pair, pIdx) => {
          const li = document.createElement('li');
          li.className = 'matching-pair-item';

          const idxTag = document.createElement('span');
          idxTag.className = 'matching-pair-tag';
          idxTag.textContent = `M${pIdx + 1}`;

          const leftSpan = document.createElement('span');
          leftSpan.className = 'matching-pair-left';
          leftSpan.textContent = pair.left || '';

          const arrowSpan = document.createElement('span');
          arrowSpan.setAttribute('aria-hidden', 'true');
          arrowSpan.textContent = '→';

          const rightSpan = document.createElement('span');
          rightSpan.className = 'matching-pair-right';
          rightSpan.textContent = pair.right || '';

          li.append(idxTag, leftSpan, arrowSpan, rightSpan);
          pairList.appendChild(li);
        });
        card.appendChild(pairList);
      }

      const fallbackAnswer =
        !item.answer && Array.isArray(item.matching_pairs) && item.matching_pairs.length > 0
          ? item.matching_pairs.map((p, i) => `${i + 1}. ${p.left} → ${p.right}`).join('\n')
          : item.answer || '';

      const answerBox = document.createElement('div');
      answerBox.className = 'answer-box';

      const answerHeader = document.createElement('div');
      answerHeader.className = 'answer-box-header';
      const answerLabel = document.createElement('span');
      answerLabel.className = 'answer-label';
      answerLabel.textContent = 'Answer';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn-ghost btn-xs';
      copyBtn.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', `Copy answer for question ${index + 1}`);
      copyBtn.addEventListener('click', () => copyTextWithFeedback(fallbackAnswer, copyBtn));
      answerHeader.append(answerLabel, copyBtn);
      answerBox.appendChild(answerHeader);

      const answerBody = document.createElement('div');
      answerBody.className = 'chat-msg-body';
      renderMarkdown(answerBody, fallbackAnswer);
      answerBox.appendChild(answerBody);
      card.appendChild(answerBox);

      if (canManipulateDom) {
        const actionRow = document.createElement('div');
        actionRow.className = 'qa-card-actions';

        const btnRow = document.createElement('div');
        btnRow.className = 'qa-card-btn-row';

        const cardFeedback = document.createElement('span');
        cardFeedback.className = 'qa-action-feedback';
        cardFeedback.setAttribute('aria-live', 'polite');

        const hlBtn = document.createElement('button');
        hlBtn.type = 'button';
        hlBtn.className = 'btn-ghost btn-xs';
        hlBtn.textContent = 'Highlight';
        hlBtn.setAttribute('aria-label', `Highlight answer for question ${index + 1} on the page`);
        hlBtn.addEventListener('click', () => {
          handleHighlightAnswers([{ ...item, index: index + 1 }], {
            scrollToFirst: true,
            feedbackEl: cardFeedback,
          });
        });

        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'btn-secondary btn-xs';
        applyBtn.textContent = 'Apply';
        applyBtn.setAttribute('aria-label', `Apply answer for question ${index + 1} on the page`);
        applyBtn.addEventListener('click', () => {
          handleApplyAnswers([{ ...item, index: index + 1 }], {
            scrollToFirst: true,
            feedbackEl: cardFeedback,
          });
        });

        btnRow.append(hlBtn, applyBtn);
        actionRow.append(btnRow, cardFeedback);
        card.appendChild(actionRow);
      }

      if (item.explanation || item.evidence_quote) {
        const details = document.createElement('details');
        details.className = 'qa-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Explanation & source evidence';
        details.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'qa-details-body';

        if (item.explanation) {
          const expDiv = document.createElement('div');
          expDiv.className = 'chat-msg-body';
          renderMarkdown(expDiv, item.explanation);
          body.appendChild(expDiv);
        }
        if (item.evidence_quote) {
          const quote = document.createElement('blockquote');
          quote.className = 'evidence-quote';
          quote.textContent = item.evidence_quote;
          body.appendChild(quote);
        }
        details.appendChild(body);
        card.appendChild(details);
      }

      fragment.appendChild(card);
    });
  }

  if (Array.isArray(analysis.suggested_questions) && analysis.suggested_questions.length > 0) {
    const sugCard = document.createElement('div');
    sugCard.className = 'summary-card';

    const sugLabel = document.createElement('p');
    sugLabel.className = 'answer-label';
    sugLabel.textContent = questions.length ? 'Follow-up questions' : 'Suggested questions to ask';
    sugCard.appendChild(sugLabel);

    const list = document.createElement('div');
    list.className = 'suggested-list';
    for (const qText of analysis.suggested_questions) {
      if (!qText || typeof qText !== 'string' || !qText.trim()) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn';
      chip.textContent = qText.trim();
      chip.addEventListener('click', () => {
        el.questionInput.value = qText.trim();
        submitCustomQuestion(qText.trim());
      });
      list.appendChild(chip);
    }
    sugCard.appendChild(list);
    fragment.appendChild(sugCard);
  }

  el.analysisOutput.replaceChildren(fragment);
}

function createChatMessageElement(role, text, usage = null, isCached = false) {
  const article = document.createElement('article');
  article.className = `chat-msg ${role === 'user' ? 'chat-msg-user' : 'chat-msg-model'}`;

  const header = document.createElement('div');
  header.className = 'chat-msg-header';

  const roleSpan = document.createElement('span');
  const activeModel = resolveActiveModel(state.settings);
  const providerLabel = detectProvider(activeModel) === 'claude' ? 'Claude' : 'Gemini';
  roleSpan.textContent = role === 'user' ? 'You' : providerLabel;
  header.appendChild(roleSpan);

  if (role === 'model') {
    const rightGroup = document.createElement('div');
    rightGroup.className = 'tag-row';

    if (isCached) {
      const cachedBadge = document.createElement('span');
      cachedBadge.className = 'badge badge-cached';
      cachedBadge.textContent = '⚡ Cached (0ms)';
      rightGroup.appendChild(cachedBadge);
    } else if (usage?.total_tokens) {
      const tokSpan = document.createElement('span');
      tokSpan.className = 'badge';
      tokSpan.textContent = `${usage.total_tokens.toLocaleString()} tok`;
      rightGroup.appendChild(tokSpan);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-ghost btn-xs';
    copyBtn.textContent = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy response');
    copyBtn.addEventListener('click', () => {
      copyTextWithFeedback(article.dataset.rawText || text || '', copyBtn);
    });
    rightGroup.appendChild(copyBtn);
    header.appendChild(rightGroup);
  }

  article.appendChild(header);

  const body = document.createElement('div');
  body.className = 'chat-msg-body';
  article.dataset.rawText = text || '';
  if (role === 'user') {
    const p = document.createElement('p');
    p.textContent = text;
    body.appendChild(p);
  } else {
    renderMarkdown(body, text || '');
  }
  article.appendChild(body);

  return { article, body, header };
}

function renderChatHistory() {
  el.chatThread.replaceChildren();
  if (state.chatHistory.length === 0) {
    el.clearChatBtn.hidden = true;
    const p = document.createElement('p');
    p.className = 'muted-placeholder';
    p.textContent = 'Curious about this page? Ask anything from big ideas to tiny details!';
    el.chatThread.appendChild(p);
    return;
  }

  el.clearChatBtn.hidden = false;
  const fragment = document.createDocumentFragment();
  for (const turn of state.chatHistory) {
    const { article } = createChatMessageElement(
      turn.role,
      turn.text,
      turn.usage || null,
      Boolean(turn.isCached)
    );
    fragment.appendChild(article);
  }
  el.chatThread.replaceChildren(fragment);
}

async function persistCurrentTabCache() {
  if (!state.currentTab?.id || !state.snapshot) return;
  await setTabCache(state.currentTab.id, {
    url: state.snapshot.url,
    contentHash: state.snapshot.contentHash,
    analysis: state.analysis,
    chatHistory: state.chatHistory,
    updatedAt: Date.now(),
  });
}

const MAX_FULLPAGE_TILES = 6;
const MAX_EMBEDDED_IMAGES = 3;
const MAX_TOTAL_ATTACHED_IMAGES = 8;
const CAPTURE_MIN_INTERVAL_MS = 560;

const recentCaptureCache = {
  tabId: null,
  url: '',
  fullPage: false,
  screenshots: [],
  capturedAt: 0,
};

let lastCaptureTabCallAt = 0;

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

async function normalizeImageBlob(blob, fallbackDataUrl = '', { maxDim = 1520, quality = 0.85 } = {}) {
  try {
    if (typeof createImageBitmap !== 'function') {
      return fallbackDataUrl ? { dataUrl: fallbackDataUrl, mimeType: blob?.type || 'image/jpeg' } : null;
    }
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width || 0;
    const h = bitmap.height || 0;
    if (w < 48 || h < 48) {
      bitmap.close?.();
      return null;
    }

    const scale = Math.min(1, maxDim / Math.max(w, h));
    const targetW = Math.max(1, Math.round(w * scale));
    const targetH = Math.max(1, Math.round(h * scale));

    const needsResize = scale < 1;
    const needsReencode = needsResize || blob.size > 380 * 1024 || blob.type === 'image/png';
    if (!needsReencode && fallbackDataUrl) {
      bitmap.close?.();
      return { dataUrl: fallbackDataUrl, mimeType: blob.type || 'image/jpeg' };
    }

    let outBlob = null;
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(targetW, targetH);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      }
    } else if (typeof document?.createElement === 'function') {
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        bitmap.close?.();
        return { dataUrl, mimeType: 'image/jpeg' };
      }
    }

    bitmap.close?.();
    if (outBlob) {
      const dataUrl = await blobToDataUrl(outBlob);
      return { dataUrl, mimeType: 'image/jpeg' };
    }
  } catch {
    // Fall back to original image bytes when canvas decoding fails.
  }
  return fallbackDataUrl ? { dataUrl: fallbackDataUrl, mimeType: blob?.type || 'image/jpeg' } : null;
}

async function normalizeImageDataUrl(rawDataUrl, mimeType = 'image/jpeg', opts = {}) {
  if (!rawDataUrl || !rawDataUrl.startsWith('data:image/')) return null;
  try {
    const res = await fetch(rawDataUrl);
    const blob = await res.blob();
    return await normalizeImageBlob(blob, rawDataUrl, opts);
  } catch {
    return { dataUrl: rawDataUrl, mimeType };
  }
}

async function captureVisibleViewportRaw(windowId) {
  if (!windowId) return null;
  const elapsed = Date.now() - lastCaptureTabCallAt;
  if (elapsed < CAPTURE_MIN_INTERVAL_MS) {
    await delayMs(CAPTURE_MIN_INTERVAL_MS - elapsed);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lastCaptureTabCallAt = Date.now();
      let dataUrl;
      let mimeType = 'image/jpeg';
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 84 });
      } catch (err) {
        if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(String(err?.message || ''))) {
          throw err;
        }
        mimeType = 'image/png';
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      }
      if (!dataUrl) return null;
      return (await normalizeImageDataUrl(dataUrl, mimeType, { maxDim: 1520, quality: 0.84 })) || {
        dataUrl,
        mimeType,
      };
    } catch (err) {
      if (attempt === 0 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(String(err?.message || ''))) {
        await delayMs(650);
        continue;
      }
      console.warn('captureVisibleTab skipped:', err?.message || err);
      return null;
    }
  }
  return null;
}

async function tryCaptureVisibleTab(windowId, tab) {
  if (!windowId) return null;
  const now = Date.now();
  if (
    recentCaptureCache.tabId === tab?.id &&
    recentCaptureCache.url === (tab?.url || '') &&
    recentCaptureCache.screenshots.length > 0 &&
    now - recentCaptureCache.capturedAt < 1800
  ) {
    return { ...recentCaptureCache.screenshots[0] };
  }

  const captured = await captureVisibleViewportRaw(windowId);
  if (!captured) return null;

  recentCaptureCache.tabId = tab?.id ?? null;
  recentCaptureCache.url = tab?.url || '';
  recentCaptureCache.fullPage = false;
  recentCaptureCache.screenshots = [
    { ...captured, label: 'Visible screen', resolution: 'high', role: 'viewport' },
  ];
  recentCaptureCache.capturedAt = Date.now();
  return captured;
}

async function detectPrimaryScrollTarget(tabId) {
  const probeFunc = () => {
    for (const stale of document.querySelectorAll('[data-tabscan-scroller="1"]')) {
      stale.removeAttribute('data-tabscan-scroller');
    }
    const root = document.scrollingElement || document.documentElement || document.body;
    const docViewH = window.innerHeight || root?.clientHeight || 0;
    const docScrollH = root?.scrollHeight || 0;
    if (root && docScrollH > docViewH + 80 && docViewH >= 200) {
      return {
        mode: 'window',
        scrollHeight: docScrollH,
        clientHeight: docViewH,
        originalScrollY: window.scrollY ?? root.scrollTop ?? 0,
        overflow: docScrollH - docViewH,
      };
    }

    let best = null;
    for (const el of document.querySelectorAll('main, [role="main"], section, article, div')) {
      const style = window.getComputedStyle(el);
      if (!style || !/(auto|scroll|overlay)/.test(style.overflowY)) continue;
      const ch = el.clientHeight || 0;
      const sh = el.scrollHeight || 0;
      if (ch >= 220 && sh > ch + 80) {
        const overflow = sh - ch;
        if (!best || overflow > best.overflow) {
          best = { el, overflow, scrollHeight: sh, clientHeight: ch };
        }
      }
    }
    if (best) {
      best.el.setAttribute('data-tabscan-scroller', '1');
      return {
        mode: 'element',
        scrollHeight: best.scrollHeight,
        clientHeight: best.clientHeight,
        originalScrollY: best.el.scrollTop || 0,
        overflow: best.overflow,
      };
    }
    return null;
  };

  let results = null;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: probeFunc,
    });
  } catch {
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId },
        func: probeFunc,
      });
    } catch {
      return null;
    }
  }

  const valid = (results || []).filter((r) => r?.result && typeof r.result.overflow === 'number');
  if (valid.length === 0) return null;

  // Prefer top frame if it actually scrolls, otherwise pick frame with largest scrollable overflow
  const top = valid.find((r) => r.frameId === 0);
  if (top && top.result.overflow > 80) {
    return { frameId: top.frameId ?? 0, ...top.result };
  }
  valid.sort((a, b) => b.result.overflow - a.result.overflow);
  const winner = valid[0];
  return { frameId: winner.frameId ?? 0, ...winner.result };
}

async function setFrameScrollPosition(tabId, frameId, mode, y, cleanup = false) {
  const scrollTarget = typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : { tabId };
  await chrome.scripting.executeScript({
    target: scrollTarget,
    func: (m, topY, cleanAttr) => {
      if (m === 'window') {
        window.scrollTo({ top: topY, behavior: 'instant' });
      } else {
        const el = document.querySelector('[data-tabscan-scroller="1"]');
        if (el) {
          el.scrollTop = topY;
          if (cleanAttr) el.removeAttribute('data-tabscan-scroller');
        }
      }
    },
    args: [mode, y, cleanup],
  });
}

async function captureFullPageScreenshots(
  tab,
  windowId,
  { fullPage = true, generation = state.scanGeneration, bypassCache = false } = {}
) {
  if (!windowId) return [];
  const now = Date.now();
  if (
    !bypassCache &&
    recentCaptureCache.tabId === tab?.id &&
    recentCaptureCache.url === (tab?.url || '') &&
    recentCaptureCache.fullPage === Boolean(fullPage) &&
    recentCaptureCache.screenshots.length > 0 &&
    now - recentCaptureCache.capturedAt < 3500
  ) {
    return recentCaptureCache.screenshots.map((s) => ({ ...s }));
  }

  let scrollInfo = null;
  if (fullPage && tab?.id && isScannableUrl(tab.url)) {
    scrollInfo = await detectPrimaryScrollTarget(tab.id);
  }

  const positions = scrollInfo
    ? computeScrollPositions(scrollInfo.scrollHeight, scrollInfo.clientHeight, MAX_FULLPAGE_TILES)
    : [0];

  if (positions.length <= 1) {
    const single = await captureVisibleViewportRaw(windowId);
    const list = single
      ? [{ ...single, label: 'Visible screen', resolution: 'high', role: 'viewport' }]
      : [];
    if (list.length > 0) {
      recentCaptureCache.tabId = tab?.id ?? null;
      recentCaptureCache.url = tab?.url || '';
      recentCaptureCache.fullPage = Boolean(fullPage);
      recentCaptureCache.screenshots = list.map((s) => ({ ...s }));
      recentCaptureCache.capturedAt = Date.now();
    }
    return list;
  }

  const captured = [];
  const seenFingerprints = new Set();

  try {
    for (let i = 0; i < positions.length; i++) {
      if (generation !== state.scanGeneration) break;
      setStatusBadge('scanning', '↻', `Screen ${i + 1}/${positions.length}`);
      await setFrameScrollPosition(tab.id, scrollInfo.frameId, scrollInfo.mode, positions[i], false);
      await delayMs(95);
      if (generation !== state.scanGeneration) break;

      const shot = await captureVisibleViewportRaw(windowId);
      if (!shot?.dataUrl) continue;
      const fp = `${shot.dataUrl.length}:${fnv1aShort(shot.dataUrl.slice(0, 4096))}`;
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);

      captured.push({
        ...shot,
        label: `Full-page section ${captured.length + 1} of ${positions.length}`,
        resolution: 'high',
        role: 'fullpage_tile',
      });
    }
  } finally {
    try {
      await setFrameScrollPosition(
        tab.id,
        scrollInfo.frameId,
        scrollInfo.mode,
        scrollInfo.originalScrollY,
        true
      );
    } catch {
      // Tab may have navigated away or closed.
    }
  }

  if (captured.length > 0 && generation === state.scanGeneration) {
    recentCaptureCache.tabId = tab?.id ?? null;
    recentCaptureCache.url = tab?.url || '';
    recentCaptureCache.fullPage = Boolean(fullPage);
    recentCaptureCache.screenshots = captured.map((s) => ({ ...s }));
    recentCaptureCache.capturedAt = Date.now();
  }
  return captured;
}

async function fetchImageViaPageFrame(tabId, srcUrl) {
  if (!tabId || !srcUrl) return '';
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async (url) => {
        try {
          const imgs = [...document.querySelectorAll('img')];
          const match = imgs.find((i) => (i.currentSrc || i.src) === url);
          if (!match) return '';
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) return '';
          const blob = await r.blob();
          return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
          });
        } catch {
          return '';
        }
      },
      args: [srcUrl],
    });
    return res?.find((r) => typeof r?.result === 'string' && r.result.startsWith('data:image/'))?.result || '';
  } catch {
    return '';
  }
}

async function collectEmbeddedVisualImages(tab, snapshot, generation) {
  const candidates = snapshot?.mediaSummary?.visualImages;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  // Prioritize larger reading/diagram images over smaller chrome
  const ordered = [...candidates].sort(
    (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
  );

  const extracted = [];
  for (const item of ordered) {
    if (generation !== state.scanGeneration || extracted.length >= MAX_EMBEDDED_IMAGES) break;
    let normalized = null;

    if (item.dataUrl) {
      normalized = await normalizeImageDataUrl(item.dataUrl, 'image/png', {
        maxDim: 1600,
        quality: 0.86,
      });
    } else if (item.src?.startsWith('data:image/')) {
      normalized = await normalizeImageDataUrl(item.src, 'image/jpeg', {
        maxDim: 1600,
        quality: 0.86,
      });
    } else if (item.src?.startsWith('http://') || item.src?.startsWith('https://')) {
      try {
        const res = await fetch(item.src, { credentials: 'include' });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.type.startsWith('image/') && !blob.type.includes('svg')) {
            const rawDataUrl = await blobToDataUrl(blob);
            normalized = await normalizeImageBlob(blob, rawDataUrl, {
              maxDim: 1600,
              quality: 0.86,
            });
          }
        }
      } catch {
        // Ignore network/CORS errors in sidepanel context; retry inside frame below.
      }
      if (!normalized && tab?.id) {
        const frameDataUrl = await fetchImageViaPageFrame(tab.id, item.src);
        if (frameDataUrl) {
          normalized = await normalizeImageDataUrl(frameDataUrl, 'image/jpeg', {
            maxDim: 1600,
            quality: 0.86,
          });
        }
      }
    } else if (item.src?.startsWith('blob:') && tab?.id) {
      const frameDataUrl = await fetchImageViaPageFrame(tab.id, item.src);
      if (frameDataUrl) {
        normalized = await normalizeImageDataUrl(frameDataUrl, 'image/jpeg', {
          maxDim: 1600,
          quality: 0.86,
        });
      }
    }

    if (normalized?.dataUrl) {
      extracted.push({
        ...normalized,
        label: item.alt ? `Embedded image: ${item.alt}` : `Embedded page image ${extracted.length + 1}`,
        resolution: 'high',
        role: 'embedded_image',
      });
    }
  }
  return extracted;
}

async function captureActiveSnapshot(
  tab,
  { captureScreen = true, fullPage = true, generation = state.scanGeneration, bypassCaptureCache = false } = {}
) {
  let snapshot = null;
  let scriptError = null;

  try {
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['scripts/page-scanner.js'],
      });
    } catch {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['scripts/page-scanner.js'],
      });
    }
    snapshot = mergeFrameSnapshots(results);
  } catch (err) {
    scriptError = err;
  }

  const looksLikePdf = /\.pdf(?:$|[?#])/i.test(tab?.url || '');
  if (!snapshot && looksLikePdf) {
    snapshot = {
      kind: 'visual_only',
      reason: 'pdf',
      url: tab.url || '',
      title: tab.title || 'PDF Document',
      lang: '',
      description: '',
      selection: '',
      text: '',
      totalChars: 0,
      truncated: false,
      questionCandidates: [],
      mediaSummary: {
        imageCount: 0,
        canvasCount: 0,
        svgCount: 0,
        visualHints: [],
        visualImages: [],
        hasVisualContent: true,
      },
      contentHash: fnv1aShort(`pdf|${tab.url || ''}|${tab.title || ''}`),
      scannedAt: Date.now(),
    };
  }

  let viewportShots = [];
  let embeddedShots = [];
  if (captureScreen) {
    if (snapshot && snapshot.kind === 'visual_only' && snapshot.reason === 'pdf') {
      const single = await tryCaptureVisibleTab(state.windowId, tab);
      if (single) {
        viewportShots = [{ ...single, label: 'Visible PDF page', resolution: 'high', role: 'viewport' }];
      }
    } else {
      viewportShots = await captureFullPageScreenshots(tab, state.windowId, {
        fullPage,
        generation,
        bypassCache: bypassCaptureCache,
      });
    }

    if (snapshot && (!snapshot.visualOnly || snapshot.mediaSummary?.visualImages?.length)) {
      embeddedShots = await collectEmbeddedVisualImages(tab, snapshot, generation);
    }
  }

  const combinedShots = [...viewportShots, ...embeddedShots].slice(0, MAX_TOTAL_ATTACHED_IMAGES);

  if (!snapshot && combinedShots.length > 0) {
    const primary = combinedShots[0];
    snapshot = {
      kind: 'ready',
      visualOnly: true,
      url: tab.url || '',
      title: tab.title || tab.url || 'Active Tab',
      lang: '',
      description: '',
      selection: '',
      text: '',
      totalChars: 0,
      truncated: false,
      questionCandidates: [],
      mediaSummary: {
        imageCount: combinedShots.length,
        canvasCount: 0,
        svgCount: 0,
        visualHints: [],
        visualImages: [],
        hasVisualContent: true,
      },
      screenshot: primary,
      screenshots: combinedShots,
      contentHash: fnv1aShort(
        `${tab.url || ''}|${combinedShots.map((s) => `${s.dataUrl.length}:${s.dataUrl.slice(0, 1024)}`).join('|')}`
      ),
      scannedAt: Date.now(),
    };
    return snapshot;
  }

  if (!snapshot) {
    throw scriptError || new Error('No content was returned from the page scanner.');
  }

  if (combinedShots.length > 0) {
    snapshot.screenshots = combinedShots;
    snapshot.screenshot = combinedShots[0];
    const parts = collectSnapshotImageParts(snapshot);
    const screenFingerprint = parts
      .map((p) => `${p.data.length}:${fnv1aShort(p.data.slice(0, 4096))}`)
      .join('|');
    snapshot.contentHash = fnv1aShort(`${snapshot.contentHash}|${screenFingerprint}`);
    if (snapshot.kind === 'visual_only' || snapshot.kind === 'empty') {
      snapshot.kind = 'ready';
      snapshot.visualOnly = true;
    }
  }

  return snapshot;
}

function updateScanStatusBadge(snapshot) {
  const candCount = snapshot.questionCandidates?.length || 0;
  const shotCount = collectSnapshotImageParts(snapshot).length;
  const hasScreen = shotCount > 0;
  const shortChars =
    snapshot.totalChars >= 1000
      ? `${(snapshot.totalChars / 1000).toFixed(1)}k`
      : snapshot.totalChars > 0
        ? `${snapshot.totalChars}`
        : hasScreen
          ? 'Screen'
          : '0';

  const parts = [shortChars];
  if (candCount > 0) parts.push(`${candCount}Q`);
  if (hasScreen && snapshot.totalChars > 0) {
    parts.push(shotCount > 1 ? `📷${shotCount}` : '📷');
  }
  setStatusBadge('ready', '✓', parts.join(' · '));
}

async function applyPostAnalysisAutomation(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return;
  if (!isScannableUrl(state.currentTab?.url) || state.snapshot?.visualOnly) return;

  if (state.settings.autoApply) {
    await handleApplyAnswers(questions, { scrollToFirst: false });
  } else if (state.settings.autoHighlight) {
    await handleHighlightAnswers(questions, { scrollToFirst: false });
  }
}

async function runPageAnalysis({ force = false } = {}) {
  if (!state.snapshot || state.snapshot.kind !== 'ready') return;

  const activeModel = resolveActiveModel(state.settings);
  const isClaude = detectProvider(activeModel) === 'claude';
  const effectiveKey = isClaude
    ? (state.settings.claudeApiKey || state.settings.apiKey)
    : state.settings.apiKey;

  if (!effectiveKey?.trim()) {
    el.setupBanner.hidden = false;
    renderCandidatePreview(state.snapshot);
    return;
  }

  // Rate-limit throttle: avoid spamming consecutive analysis calls within 4s unless forced
  if (!force && Date.now() - (state.lastAnalysisAt || 0) < 4000) {
    return;
  }

  if (!force && state.analysis && state.analysis._hash === state.snapshot.contentHash) {
    renderAnalysisOutput(state.analysis);
    await applyPostAnalysisAutomation(state.analysis.questions);
    return;
  }

  if (state.analysisAbort) {
    state.analysisAbort.abort();
  }
  const abortController = new AbortController();
  state.analysisAbort = abortController;
  const generation = state.scanGeneration;

  el.analysisError.hidden = true;
  el.analysisProgress.hidden = false;
  el.analysisProgressLabel.textContent = `Scanning with ${activeModel}…`;
  el.analyzeBtn.hidden = false;
  el.analyzeBtn.disabled = true;

  try {
    const result = await analyzePageQuestions({
      apiKey: state.settings.apiKey,
      claudeApiKey: state.settings.claudeApiKey,
      model: activeModel,
      pageSnapshot: state.snapshot,
      answerStyle: state.settings.answerStyle,
      thinkingLevel: state.settings.thinkingLevel,
      maxPageChars: state.settings.maxPageChars,
      signal: abortController.signal,
      onRetry: ({ remainingSec, attempt, maxRetries }) => {
        if (generation !== state.scanGeneration) return;
        if (remainingSec > 0) {
          el.analysisProgressLabel.textContent = `Rate limit reached. Waiting for reset... Auto-continuing in ${remainingSec}s (${attempt}/${maxRetries})`;
          updateStatus('scanning', `Waiting for token reset (${remainingSec}s)...`);
        } else {
          el.analysisProgressLabel.textContent = `Resuming scan with ${activeModel}…`;
          updateStatus('scanning', `Analyzing with ${activeModel}…`);
        }
      },
    });

    if (generation !== state.scanGeneration) return;

    const analysis = result.analysis;
    const usage = result.usage;
    analysis._hash = state.snapshot.contentHash;
    analysis._usage = usage;
    state.analysis = analysis;
    state.lastAnalysisAt = Date.now();

    renderAnalysisOutput(analysis);
    await persistCurrentTabCache();

    if (result.fallbackFrom) {
      announce(`Note: Answered using ${result.model} because ${result.fallbackFrom} was busy.`);
    }

    const count = analysis.questions?.length || 0;
    announce(
      count > 0
        ? `Found and answered ${count} question${count === 1 ? '' : 's'} on this page.`
        : 'Page summary and suggested questions ready.'
    );

    await applyPostAnalysisAutomation(analysis.questions);
  } catch (err) {
    if (err.name === 'AbortError' || generation !== state.scanGeneration) return;
    el.analysisErrorText.textContent = err.message || `Failed to analyze this page with ${isClaude ? 'Claude' : 'Gemini'}.`;
    el.analysisError.hidden = false;
    renderCandidatePreview(state.snapshot);
  } finally {
    if (generation === state.scanGeneration) {
      el.analysisProgress.hidden = true;
      el.analyzeBtn.disabled = false;
      el.analyzeBtn.textContent = state.analysis ? 'Re-analyze' : 'Analyze';
    }
    if (state.analysisAbort === abortController) {
      state.analysisAbort = null;
    }
  }
}

async function scanActiveTab({ forceAnalyze = false } = {}) {
  const generation = ++state.scanGeneration;
  abortInFlightRequests();

  el.analysisError.hidden = true;
  el.analysisProgress.hidden = true;
  setPageActionStatus('');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (generation !== state.scanGeneration) return;

  if (!tab) {
    state.currentTab = null;
    state.snapshot = null;
    el.pageActionsToolbar.hidden = true;
    setStatusBadge('restricted', '⚠', 'No tab');
    el.tabTitle.textContent = 'No active tab found';
    el.tabHost.textContent = '';
    return;
  }

  state.currentTab = tab;
  updateTabMetaUI(tab);

  const restriction = getUrlRestrictionReason(tab.url);
  if (restriction) {
    state.snapshot = null;
    state.analysis = null;
    state.chatHistory = [];
    setStatusBadge('restricted', '⚠', 'Restricted');
    renderPreviewUI(null);
    el.analyzeBtn.hidden = true;
    el.pageActionsToolbar.hidden = true;
    const msg = document.createElement('p');
    msg.className = 'muted-placeholder';
    msg.textContent = restriction;
    el.analysisOutput.replaceChildren(msg);
    renderChatHistory();
    return;
  }

  setStatusBadge('scanning', '↻', 'Scanning');

  try {
    const snapshot = await captureActiveSnapshot(tab, {
      captureScreen: Boolean(state.settings.scanScreen),
      fullPage: state.settings.fullPageScan !== false,
      generation,
      bypassCaptureCache: Boolean(forceAnalyze),
    });
    if (generation !== state.scanGeneration) return;

    state.snapshot = snapshot;

    if (snapshot.kind === 'visual_only') {
      state.analysis = null;
      state.chatHistory = [];
      setStatusBadge('restricted', '📷', snapshot.reason === 'pdf' ? 'PDF' : 'Visual');
      renderPreviewUI(null);
      el.analyzeBtn.hidden = true;
      el.pageActionsToolbar.hidden = true;
      const msg = document.createElement('p');
      msg.className = 'muted-placeholder';
      msg.textContent =
        snapshot.reason === 'pdf'
          ? 'PDF viewer detected. Turn on Screen capture (📷) in the header and click Rescan to scan PDF pages with Gemini Vision.'
          : 'This tab contains visual/image content. Turn on Screen capture (📷) in the header and click Rescan so Gemini can read the screen.';
      el.analysisOutput.replaceChildren(msg);
      renderChatHistory();
      return;
    }

    if (snapshot.kind === 'empty') {
      state.analysis = null;
      state.chatHistory = [];
      setStatusBadge('restricted', '○', 'Empty');
      renderPreviewUI(null);
      el.analyzeBtn.hidden = true;
      el.pageActionsToolbar.hidden = true;
      const msg = document.createElement('p');
      msg.className = 'muted-placeholder';
      msg.textContent = 'No readable text or visual screen content was detected on this page yet.';
      el.analysisOutput.replaceChildren(msg);
      renderChatHistory();
      return;
    }

    updateScanStatusBadge(snapshot);
    renderPreviewUI(snapshot);

    // Check session cache for this tab
    const cached = await getTabCache(tab.id);
    if (generation !== state.scanGeneration) return;

    if (cached && cached.url === snapshot.url) {
      state.chatHistory = Array.isArray(cached.chatHistory) ? cached.chatHistory : [];
    } else {
      state.chatHistory = [];
    }
    renderChatHistory();

    if (!forceAnalyze && cached && cached.contentHash === snapshot.contentHash && cached.analysis) {
      state.analysis = cached.analysis;
      renderAnalysisOutput(state.analysis);
      el.analyzeBtn.hidden = false;
      el.analyzeBtn.textContent = 'Re-analyze';
      await applyPostAnalysisAutomation(state.analysis.questions);
      return;
    }

    state.analysis = null;
    el.analyzeBtn.hidden = false;
    el.analyzeBtn.textContent = 'Analyze';

    const activeModel = resolveActiveModel(state.settings);
    const isClaude = detectProvider(activeModel) === 'claude';
    const effectiveKey = isClaude
      ? (state.settings.claudeApiKey || state.settings.apiKey)
      : state.settings.apiKey;

    if (!effectiveKey?.trim()) {
      renderCandidatePreview(snapshot);
      return;
    }

    if (state.settings.autoAnswer || forceAnalyze) {
      await runPageAnalysis({ force: forceAnalyze });
    } else {
      renderCandidatePreview(snapshot);
    }
  } catch (err) {
    if (generation !== state.scanGeneration) return;
    state.snapshot = null;
    el.pageActionsToolbar.hidden = true;
    setStatusBadge('error', '⚠', 'Scan error');
    renderPreviewUI(null);
    el.analyzeBtn.hidden = true;
    const msg = document.createElement('p');
    msg.className = 'muted-placeholder';
    msg.textContent = `Could not scan this tab (${err.message || 'script blocked'}). Try reloading the tab or switching to a standard webpage.`;
    el.analysisOutput.replaceChildren(msg);
  }
}

async function submitCustomQuestion(rawQuestion) {
  const question = (rawQuestion || '').trim();
  if (!question) return;

  const activeModel = resolveActiveModel(state.settings);
  const isClaude = detectProvider(activeModel) === 'claude';
  const effectiveKey = isClaude
    ? (state.settings.claudeApiKey || state.settings.apiKey)
    : state.settings.apiKey;

  if (!effectiveKey?.trim()) {
    openSettingsDialog(el.sendBtn);
    announce(`Please add your ${isClaude ? 'Claude' : 'Gemini'} API key in Settings first.`);
    return;
  }

  // Refresh active tab scan if there is no snapshot or existing snapshot is older than 8s
  const snapshotAge = Date.now() - (state.snapshot?.scannedAt || 0);
  if (!state.snapshot || snapshotAge > 8000) {
    const [liveTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (liveTab && isScannableUrl(liveTab.url)) {
      state.currentTab = liveTab;
      updateTabMetaUI(liveTab);
      try {
        const freshSnapshot = await captureActiveSnapshot(liveTab, {
          captureScreen: Boolean(state.settings.scanScreen),
          fullPage: state.settings.fullPageScan !== false,
          generation: state.scanGeneration,
        });
        if (freshSnapshot && freshSnapshot.kind === 'ready') {
          state.snapshot = freshSnapshot;
          updateScanStatusBadge(freshSnapshot);
          renderPreviewUI(freshSnapshot);
        }
      } catch {
        // Keep existing snapshot fallback if transient capture fails.
      }
    }
  }

  const snapshot = state.snapshot || {
    url: state.currentTab?.url || '',
    title: state.currentTab?.title || '',
    text: '',
    selection: '',
    questionCandidates: [],
    contentHash: '',
  };

  // 1. Check Query Cache
  const cacheKey = computeQueryCacheKey({
    contentHash: state.snapshot?.contentHash || '',
    query: question,
    model: activeModel,
    answerStyle: state.settings.answerStyle,
  });

  const cachedEntry = await getQueryCache(cacheKey);
  if (cachedEntry?.answer) {
    if (state.chatHistory.length === 0) {
      el.chatThread.replaceChildren();
    }
    state.chatHistory.push({ role: 'user', text: question });
    const userMsg = createChatMessageElement('user', question);
    el.chatThread.appendChild(userMsg.article);
    el.clearChatBtn.hidden = false;

    const assistantMsg = createChatMessageElement('model', cachedEntry.answer, null, true);
    el.chatThread.appendChild(assistantMsg.article);
    state.chatHistory.push({ role: 'model', text: cachedEntry.answer, isCached: true });
    await persistCurrentTabCache();

    el.mainContent.scrollTop = el.mainContent.scrollHeight;
    announce('Answer received.');
    return;
  }

  // 2. Cache MISS: Proceed with streaming
  if (state.chatAbort) {
    state.chatAbort.abort();
  }
  const abortController = new AbortController();
  state.chatAbort = abortController;
  const generation = state.scanGeneration;

  // Remove empty placeholder if this is the first chat message
  if (state.chatHistory.length === 0) {
    el.chatThread.replaceChildren();
  }

  const priorHistory = [...state.chatHistory];
  state.chatHistory.push({ role: 'user', text: question });
  const userMsg = createChatMessageElement('user', question);
  el.chatThread.appendChild(userMsg.article);
  el.clearChatBtn.hidden = false;

  const assistantMsg = createChatMessageElement('model', 'Thinking…');
  el.chatThread.appendChild(assistantMsg.article);
  el.mainContent.scrollTop = el.mainContent.scrollHeight;

  el.sendBtn.disabled = true;
  el.stopBtn.hidden = false;

  let pendingFrame = null;
  let latestText = '';

  const scheduleRender = (text) => {
    latestText = text;
    assistantMsg.article.dataset.rawText = text;
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      renderMarkdown(assistantMsg.body, latestText);
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      assistantMsg.body.appendChild(cursor);
      el.mainContent.scrollTop = el.mainContent.scrollHeight;
    });
  };

  try {
    const { text, usage } = await streamCustomQuestion({
      apiKey: state.settings.apiKey,
      claudeApiKey: state.settings.claudeApiKey,
      model: resolveActiveModel(state.settings),
      pageSnapshot: snapshot,
      history: priorHistory,
      question,
      answerStyle: state.settings.answerStyle,
      thinkingLevel: state.settings.thinkingLevel,
      maxPageChars: state.settings.maxPageChars,
      signal: abortController.signal,
      onChunk: (_delta, full) => {
        if (generation !== state.scanGeneration) return;
        scheduleRender(full);
      },
      onRetry: ({ remainingSec, attempt, maxRetries }) => {
        if (generation !== state.scanGeneration) return;
        if (remainingSec > 0) {
          updateStatus('ready', `Rate limit reached. Auto-resuming in ${remainingSec}s (${attempt}/${maxRetries})`);
          if (!latestText) {
            assistantMsg.body.innerHTML = `
              <div class="rate-limit-card" role="status">
                <span class="rate-limit-icon"><svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" style="vertical-align: middle;"><path fill="currentColor" d="M3 2h10v2l-3.5 3.5L13 11v2H3v-2l3.5-3.5L3 4V2zm2 1.5v.7l3 3 3-3v-.7H5zm3 4.8l-3 3v.7h6v-.7l-3-3z"/></svg></span>
                <div class="rate-limit-content">
                  <div class="rate-limit-title">Pacing ourselves for a moment</div>
                  <div class="rate-limit-desc">Catching our breath! Resuming your answer automatically in <strong>${remainingSec}s</strong> (attempt ${attempt}/${maxRetries})…</div>
                </div>
              </div>
            `;
            el.mainContent.scrollTop = el.mainContent.scrollHeight;
          }
        } else {
          updateStatus('ready', 'Resuming stream...');
          if (!latestText) {
            assistantMsg.body.innerHTML = `<span class="streaming-cursor" aria-hidden="true"></span>`;
          }
        }
      },
    });

    if (generation !== state.scanGeneration) return;
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }

    const finalText = text || latestText || '(No response generated.)';
    assistantMsg.article.dataset.rawText = finalText;
    renderMarkdown(assistantMsg.body, finalText);

    const cursor = assistantMsg.body.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();

    if (usage?.total_tokens) {
      const tokSpan = document.createElement('span');
      tokSpan.className = 'badge';
      tokSpan.textContent = `${usage.total_tokens.toLocaleString()} tok`;
      const rightGroup = assistantMsg.header.querySelector('.tag-row');
      if (rightGroup) rightGroup.prepend(tokSpan);
    }

    state.chatHistory.push({ role: 'model', text: finalText, usage: usage || null });
    await persistCurrentTabCache();

    // Cache completed result
    await setQueryCache(cacheKey, {
      answer: finalText,
      cachedAt: Date.now(),
      query: question,
      model: resolveActiveModel(state.settings),
    });

    el.mainContent.scrollTop = el.mainContent.scrollHeight;
    announce('Answer received.');
  } catch (err) {
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    const cursor = assistantMsg.body.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();

    if (err.name === 'AbortError') {
      const partial = latestText ? `${latestText}\n\n*(Stopped)*` : '*(Stopped)*';
      assistantMsg.article.dataset.rawText = partial;
      renderMarkdown(assistantMsg.body, partial);
      state.chatHistory.push({ role: 'model', text: partial });
      await persistCurrentTabCache();
    } else if (generation === state.scanGeneration) {
      const errText = `**Error:** ${err.message || 'Could not reach Gemini API.'}`;
      assistantMsg.article.dataset.rawText = errText;
      renderMarkdown(assistantMsg.body, errText);
    }
  } finally {
    if (state.chatAbort === abortController) {
      state.chatAbort = null;
    }
    const cursor = assistantMsg.body.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
    el.stopBtn.hidden = true;
    el.sendBtn.disabled = false;
  }
}

async function handlePendingAction() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.PENDING_ACTION);
  const action = stored[STORAGE_KEYS.PENDING_ACTION];
  if (!action) return;

  // Discard stale actions older than 30 seconds
  await chrome.storage.session.remove(STORAGE_KEYS.PENDING_ACTION);
  if (Date.now() - (action.timestamp || 0) > 30000) return;

  await scanActiveTab({ forceAnalyze: action.menuItemId === 'tabscan-scan-page' });

  if (action.selectionText) {
    const prompt = `Explain or answer this selected text from the page:\n\n"${action.selectionText}"`;
    if (state.settings.apiKey?.trim()) {
      await submitCustomQuestion(prompt);
    } else {
      el.questionInput.value = prompt;
      el.questionInput.focus();
    }
  }
}

// --- Settings Dialog & Consistent ARIA Validation ---

const flaggedFields = new WeakSet();
const announcedFields = new WeakSet();
let lastFieldAnnounced = null;

function linkFieldError(field, shown) {
  const errorId = field.dataset.error;
  if (!errorId) return;
  const ids = (field.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (shown) ids.push(errorId);
  if (ids.length) field.setAttribute('aria-describedby', ids.join(' '));
  else field.removeAttribute('aria-describedby');
}

function syncFieldAria(field, shouldAnnounce = false) {
  if (!field.matches?.('input, select, textarea')) return;
  const invalid = field.matches(':user-invalid') || field.classList.contains('user-invalid-fallback');
  if (invalid) {
    if (shouldAnnounce && !announcedFields.has(field)) {
      const errNode = document.getElementById(field.dataset.error);
      if (errNode) {
        lastFieldAnnounced = field;
        announce(errNode.textContent.replace(/\s+/g, ' ').trim());
      }
      announcedFields.add(field);
    }
    field.setAttribute('aria-invalid', 'true');
    linkFieldError(field, true);
    flaggedFields.add(field);
  } else if (flaggedFields.has(field) || field.getAttribute('aria-invalid') !== 'true') {
    field.setAttribute('aria-invalid', 'false');
    linkFieldError(field, false);
    flaggedFields.delete(field);
    announcedFields.delete(field);
    if (lastFieldAnnounced === field) {
      clearTimeout(state.announceTimer);
      el.srAnnouncer.textContent = '';
    }
  }
}

function renderModelOptions(provider, models = [], selectedModelId = '') {
  el.modelSelect.replaceChildren();

  const isClaude = provider === 'claude';
  const fallbackList = isClaude ? CLAUDE_MODELS : GEMINI_MODELS;
  const listToRender = Array.isArray(models) && models.length > 0 ? models : fallbackList;

  const groups = new Map();
  for (const m of listToRender) {
    const cat = m.category || (isClaude ? 'flagship' : 'recommended');
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(m);
  }

  const categoryLabels = isClaude
    ? {
        flagship: 'Flagship & Balanced',
        fast: 'Fast & Lightweight',
        reasoning: 'Deep Reasoning',
        other: 'Other Models',
      }
    : {
        recommended: 'Fast & Recommended',
        lite: 'Lightweight & Low Cost',
        reasoning: 'Deep Reasoning',
        other: 'Other Models',
      };

  for (const [cat, groupModels] of groups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = categoryLabels[cat] || 'Available Models';
    for (const m of groupModels) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      optgroup.appendChild(opt);
    }
    el.modelSelect.appendChild(optgroup);
  }

  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'Custom model ID…';
  el.modelSelect.appendChild(customOpt);

  if (selectedModelId) {
    const exists = listToRender.some((m) => m.id === selectedModelId);
    el.modelSelect.value = exists ? selectedModelId : 'custom';
  } else {
    el.modelSelect.value = listToRender[0]?.id || (isClaude ? 'claude-sonnet-4-5' : 'gemini-3.8-flash');
  }

  if (el.modelsCountBadge) {
    if (Array.isArray(models) && models.length > 0) {
      el.modelsCountBadge.textContent = `${models.length} available`;
      el.modelsCountBadge.hidden = false;
    } else {
      el.modelsCountBadge.hidden = true;
    }
  }

  syncCustomModelVisibility();
}

function switchProvider(nextProvider, { autoSelectModel = false } = {}) {
  state.selectedProvider = nextProvider;
  const isClaude = nextProvider === 'claude';

  if (el.providerBtnGemini) {
    el.providerBtnGemini.classList.toggle('active', !isClaude);
    el.providerBtnGemini.setAttribute('aria-checked', (!isClaude).toString());
  }
  if (el.providerBtnClaude) {
    el.providerBtnClaude.classList.toggle('active', isClaude);
    el.providerBtnClaude.setAttribute('aria-checked', isClaude.toString());
  }

  if (el.apiKeyLabel) {
    el.apiKeyLabel.textContent = isClaude ? 'Claude API Key' : 'Gemini API Key';
    const req = document.createElement('span');
    req.setAttribute('aria-hidden', 'true');
    req.textContent = ' *';
    el.apiKeyLabel.appendChild(req);
  }

  if (el.getKeyLink) {
    el.getKeyLink.href = isClaude
      ? 'https://console.anthropic.com/settings/keys'
      : 'https://aistudio.google.com/app/apikey';
    el.getKeyLink.textContent = isClaude ? 'Get Claude key ↗' : 'Get Gemini key ↗';
  }

  if (el.apiKeyHint) {
    el.apiKeyHint.textContent = isClaude
      ? 'Stored locally in Chrome extension storage. Get a key from console.anthropic.com.'
      : 'Stored locally in Chrome extension storage. Get a key from Google AI Studio.';
  }

  if (el.apiKeyInput) {
    el.apiKeyInput.placeholder = isClaude ? 'sk-ant-api03-…' : 'AIzaSy…';
    el.apiKeyInput.value = isClaude ? (state.settings.claudeApiKey || '') : (state.settings.apiKey || '');
  }

  if (el.fetchModelsStatus) {
    el.fetchModelsStatus.textContent = '';
    el.fetchModelsStatus.removeAttribute('data-state');
  }

  const cachedModels = state.fetchedModels[nextProvider];
  const targetModel = autoSelectModel
    ? (isClaude ? 'claude-sonnet-4-5' : 'gemini-3.8-flash')
    : (state.settings.model || (isClaude ? 'claude-sonnet-4-5' : 'gemini-3.8-flash'));

  renderModelOptions(nextProvider, cachedModels, targetModel);
}

async function handleFetchModels() {
  const key = el.apiKeyInput?.value.trim();
  if (!key) {
    if (el.fetchModelsStatus) {
      el.fetchModelsStatus.textContent = `Please enter your ${state.selectedProvider === 'claude' ? 'Claude' : 'Gemini'} API key above first.`;
      el.fetchModelsStatus.dataset.state = 'error';
    }
    el.apiKeyInput?.focus();
    return;
  }

  if (el.fetchModelsBtn) {
    el.fetchModelsBtn.classList.add('is-loading');
    el.fetchModelsBtn.disabled = true;
  }
  if (el.fetchModelsBtnText) {
    el.fetchModelsBtnText.textContent = 'Fetching…';
  }
  if (el.fetchModelsStatus) {
    el.fetchModelsStatus.textContent = 'Contacting provider API…';
    el.fetchModelsStatus.removeAttribute('data-state');
  }

  try {
    const models = await fetchAvailableModels({
      provider: state.selectedProvider,
      apiKey: key,
    });

    state.fetchedModels[state.selectedProvider] = models;
    if (state.selectedProvider === 'claude') {
      state.settings.claudeApiKey = key;
    } else {
      state.settings.apiKey = key;
    }
    state.settings.fetchedModels = state.fetchedModels;

    renderModelOptions(state.selectedProvider, models, el.modelSelect.value);

    if (el.fetchModelsStatus) {
      el.fetchModelsStatus.textContent = `✓ ${models.length} models loaded`;
      el.fetchModelsStatus.dataset.state = 'ok';
    }
    announce(`${models.length} models fetched successfully for ${state.selectedProvider === 'claude' ? 'Claude' : 'Gemini'}.`);
  } catch (err) {
    if (el.fetchModelsStatus) {
      el.fetchModelsStatus.textContent = err.message || 'Failed to fetch models';
      el.fetchModelsStatus.dataset.state = 'error';
    }
  } finally {
    if (el.fetchModelsBtn) {
      el.fetchModelsBtn.classList.remove('is-loading');
      el.fetchModelsBtn.disabled = false;
    }
    if (el.fetchModelsBtnText) {
      el.fetchModelsBtnText.textContent = 'Fetch Models';
    }
  }
}

function syncCustomModelVisibility() {
  const isCustom = el.modelSelect.value === 'custom';
  if (el.customModelField) {
    el.customModelField.hidden = !isCustom;
  }
  if (el.customModelInput) {
    el.customModelInput.required = isCustom;
    if (!isCustom) {
      el.customModelInput.setCustomValidity('');
      el.customModelInput.classList.remove('user-invalid-fallback');
      syncFieldAria(el.customModelInput);
    }
  }
}

function openSettingsDialog(triggerEl = el.settingsBtn) {
  state.lastSettingsTrigger = triggerEl;
  el.settingsForm.reset();
  el.apiKeyInput.type = 'password';
  el.toggleKeyBtn.setAttribute('aria-pressed', 'false');
  el.toggleKeyBtn.setAttribute('aria-label', 'Show API key');
  el.toggleKeyBtn.textContent = 'Show';

  const initialProvider = state.settings.provider || (detectProvider(state.settings.model) === 'claude' ? 'claude' : 'gemini');
  switchProvider(initialProvider);

  if (state.settings.model === 'custom' || !el.modelSelect.querySelector(`option[value="${state.settings.model}"]`)) {
    el.modelSelect.value = 'custom';
    el.customModelInput.value = state.settings.customModel || state.settings.model || '';
  } else {
    el.modelSelect.value = state.settings.model;
    el.customModelInput.value = state.settings.customModel || '';
  }
  syncCustomModelVisibility();

  el.thinkingSelect.value = state.settings.thinkingLevel || 'low';
  el.styleConcise.checked = state.settings.answerStyle !== 'detailed';
  el.styleDetailed.checked = state.settings.answerStyle === 'detailed';
  el.autoScanCheckbox.checked = Boolean(state.settings.autoScan);
  el.scanScreenCheckbox.checked = Boolean(state.settings.scanScreen);
  el.fullPageScanCheckbox.checked = state.settings.fullPageScan !== false;
  el.autoAnswerCheckbox.checked = Boolean(state.settings.autoAnswer);
  el.autoHighlightCheckbox.checked = Boolean(state.settings.autoHighlight);
  el.autoApplyCheckbox.checked = Boolean(state.settings.autoApply);

  if (el.fetchModelsStatus) {
    el.fetchModelsStatus.textContent = '';
    el.fetchModelsStatus.removeAttribute('data-state');
  }
  if (el.testKeyStatus) {
    el.testKeyStatus.textContent = '';
    el.testKeyStatus.removeAttribute('data-state');
  }

  [el.apiKeyInput, el.customModelInput].forEach((input) => {
    if (input) {
      input.classList.remove('user-invalid-fallback', 'user-valid-fallback');
      syncFieldAria(input);
    }
  });

  el.settingsDialog.showModal();
  el.apiKeyInput.focus();
}

function closeSettingsDialog() {
  if (el.settingsDialog.open) {
    el.settingsDialog.close();
  }
  if (state.lastSettingsTrigger && typeof state.lastSettingsTrigger.focus === 'function') {
    state.lastSettingsTrigger.focus();
  }
}

function wireToolbarKeyboard(bar) {
  if (!bar || 'focusGroup' in HTMLElement.prototype) return;
  const items = [...bar.querySelectorAll('button')];
  if (items.length === 0) return;

  items.forEach((btn, i) => {
    btn.tabIndex = i === 0 ? 0 : -1;
  });

  bar.addEventListener('focusin', ({ target }) => {
    if (items.includes(target)) {
      items.forEach((btn) => {
        btn.tabIndex = btn === target ? 0 : -1;
      });
    }
  });

  bar.addEventListener('keydown', (event) => {
    const activeIdx = items.indexOf(document.activeElement);
    if (activeIdx === -1) return;

    const rtl = getComputedStyle(bar).direction === 'rtl';
    let nextIdx = -1;
    if (event.key === 'ArrowRight') {
      nextIdx = (activeIdx + (rtl ? -1 : 1) + items.length) % items.length;
    } else if (event.key === 'ArrowLeft') {
      nextIdx = (activeIdx + (rtl ? 1 : -1) + items.length) % items.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = items.length - 1;
    }

    if (nextIdx !== -1) {
      event.preventDefault();
      items[nextIdx].focus();
    }
  });
}

function wireEventListeners() {
  el.tabFavicon.addEventListener('error', () => {
    el.tabFavicon.hidden = true;
  });

  // Header controls
  el.autoScanToggle.addEventListener('click', async () => {
    await saveSettings({ ...state.settings, autoScan: !state.settings.autoScan });
    if (state.settings.autoScan) {
      await scanActiveTab();
    }
  });

  el.screenScanToggle.addEventListener('click', async () => {
    await saveSettings({ ...state.settings, scanScreen: !state.settings.scanScreen });
    await scanActiveTab({ forceAnalyze: Boolean(state.settings.scanScreen && state.settings.autoAnswer) });
  });

  el.rescanBtn.addEventListener('click', () => {
    scanActiveTab({ forceAnalyze: Boolean(state.settings.apiKey?.trim()) });
  });

  // Page answer action toolbar
  wireToolbarKeyboard(el.pageActionsToolbar);

  el.highlightAllBtn.addEventListener('click', () => {
    if (!state.analysis?.questions?.length) return;
    handleHighlightAnswers(state.analysis.questions, { scrollToFirst: true });
  });

  el.applyAllBtn.addEventListener('click', () => {
    if (!state.analysis?.questions?.length) return;
    handleApplyAnswers(state.analysis.questions, { scrollToFirst: true });
  });

  el.clearHighlightsBtn.addEventListener('click', () => {
    handleClearHighlights();
  });

  el.settingsBtn.addEventListener('click', () => openSettingsDialog(el.settingsBtn));
  el.openSetupBtn.addEventListener('click', () => openSettingsDialog(el.openSetupBtn));
  el.errorSettingsBtn.addEventListener('click', () => openSettingsDialog(el.errorSettingsBtn));

  el.analyzeBtn.addEventListener('click', () => {
    runPageAnalysis({ force: true });
  });

  el.retryAnalysisBtn.addEventListener('click', () => {
    runPageAnalysis({ force: true });
  });

  el.askSelectionBtn.addEventListener('click', () => {
    if (!state.snapshot?.selection) return;
    submitCustomQuestion(
      `Explain or answer this highlighted text from the page:\n\n"${state.snapshot.selection}"`
    );
  });

  el.clearChatBtn.addEventListener('click', async () => {
    state.chatHistory = [];
    renderChatHistory();
    await persistCurrentTabCache();
  });

  // IME-safe Enter-to-submit on question textarea
  el.questionInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      el.qaForm.requestSubmit();
    }
  });

  el.qaForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = el.questionInput.value.trim();
    if (!text) return;
    el.questionInput.value = '';
    await submitCustomQuestion(text);
  });

  el.stopBtn.addEventListener('click', () => {
    if (state.chatAbort) {
      state.chatAbort.abort();
    }
  });

  // Quick prompt chips (delegated click handler)
  if (el.quickChips) {
    el.quickChips.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip-btn');
      if (!chip) return;
      const text = (chip.dataset.prompt || chip.textContent || '').trim();
      if (!text) return;
      el.questionInput.value = text;
      submitCustomQuestion(text);
    });
  }

  // Settings dialog controls
  el.closeSettingsBtn.addEventListener('click', closeSettingsDialog);
  el.cancelSettingsBtn.addEventListener('click', closeSettingsDialog);

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    el.settingsDialog.addEventListener('click', (event) => {
      if (event.target === el.settingsDialog) {
        closeSettingsDialog();
      }
    });
  }

  el.toggleKeyBtn.addEventListener('click', () => {
    const show = el.apiKeyInput.type === 'password';
    el.apiKeyInput.type = show ? 'text' : 'password';
    el.toggleKeyBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
    el.toggleKeyBtn.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
    el.toggleKeyBtn.textContent = show ? 'Hide' : 'Show';
  });

  if (el.providerBtnGemini) {
    el.providerBtnGemini.addEventListener('click', () => switchProvider('gemini', { autoSelectModel: true }));
  }
  if (el.providerBtnClaude) {
    el.providerBtnClaude.addEventListener('click', () => switchProvider('claude', { autoSelectModel: true }));
  }

  if (el.fetchModelsBtn) {
    el.fetchModelsBtn.addEventListener('click', handleFetchModels);
  }
  if (el.testKeyBtn) {
    el.testKeyBtn.addEventListener('click', handleFetchModels);
  }

  el.modelSelect.addEventListener('change', syncCustomModelVisibility);
  el.customModelInput.addEventListener('input', () => {
    syncFieldAria(el.customModelInput);
  });

  el.settingsForm.addEventListener(
    'blur',
    (e) => syncFieldAria(e.target, true),
    true
  );
  el.settingsForm.addEventListener('input', (e) => {
    if (e.target.hasAttribute('aria-invalid')) {
      e.target.classList.remove('user-invalid-fallback');
      syncFieldAria(e.target);
    }
  });
  el.settingsForm.addEventListener(
    'invalid',
    (e) => {
      announcedFields.add(e.target);
      e.target.classList.add('user-invalid-fallback');
      syncFieldAria(e.target);
    },
    true
  );

  el.settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!el.settingsForm.checkValidity()) {
      const firstInvalid = el.settingsForm.querySelector(':invalid');
      if (firstInvalid) {
        firstInvalid.classList.add('user-invalid-fallback');
        syncFieldAria(firstInvalid, true);
        firstInvalid.focus();
      }
      return;
    }

    const enteredKey = el.apiKeyInput.value.trim();
    const isClaude = state.selectedProvider === 'claude';
    const hadKey = Boolean(state.settings.apiKey?.trim() || state.settings.claudeApiKey?.trim());
    const hadScreen = Boolean(state.settings.scanScreen);
    const hadFullPage = state.settings.fullPageScan !== false;
    const nextSettings = {
      provider: state.selectedProvider,
      apiKey: isClaude ? (state.settings.apiKey || '') : enteredKey,
      claudeApiKey: isClaude ? enteredKey : (state.settings.claudeApiKey || ''),
      model: el.modelSelect.value,
      customModel: el.customModelInput.value.trim(),
      fetchedModels: state.fetchedModels,
      thinkingLevel: el.thinkingSelect.value,
      answerStyle: el.styleDetailed.checked ? 'detailed' : 'concise',
      autoScan: el.autoScanCheckbox.checked,
      scanScreen: el.scanScreenCheckbox.checked,
      fullPageScan: el.fullPageScanCheckbox.checked,
      autoAnswer: el.autoAnswerCheckbox.checked,
      autoHighlight: el.autoHighlightCheckbox.checked,
      autoApply: el.autoApplyCheckbox.checked,
    };

    await saveSettings(nextSettings);
    closeSettingsDialog();
    announce('Settings saved.');

    if (
      (!hadScreen && nextSettings.scanScreen) ||
      (nextSettings.scanScreen && !hadFullPage && nextSettings.fullPageScan)
    ) {
      await scanActiveTab({ forceAnalyze: Boolean(nextSettings.autoAnswer) });
    } else if (state.snapshot?.kind === 'ready' && (!hadKey || !state.analysis) && state.settings.autoAnswer) {
      await runPageAnalysis({ force: true });
    } else if (state.analysis?.questions?.length) {
      await applyPostAnalysisAutomation(state.analysis.questions);
    }
  });

  // Tab auto-scan listeners
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (activeInfo.windowId !== state.windowId) return;
    if (!state.settings.autoScan) return;
    await scanActiveTab();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab?.active || tab.windowId !== state.windowId) return;
    if (!state.settings.autoScan) return;
    if (changeInfo.status !== 'complete' && !changeInfo.url) return;

    clearTimeout(state.updateTimer);
    state.updateTimer = setTimeout(() => {
      scanActiveTab();
    }, 1500);
  });

  // React to context menu actions dispatched via session storage
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && changes[STORAGE_KEYS.PENDING_ACTION]?.newValue) {
      handlePendingAction();
    }
  });

  // Wire Update banner and modal controls
  if (el.updateBannerBtn) {
    el.updateBannerBtn.addEventListener('click', () => {
      if (typeof el.updateModal?.showModal === 'function') {
        el.updateModal.showModal();
        if (el.downloadUpdaterLink && typeof el.downloadUpdaterLink.focus === 'function') {
          el.downloadUpdaterLink.focus();
        }
      }
    });
  }

  if (el.updateBannerDismiss) {
    el.updateBannerDismiss.addEventListener('click', () => {
      if (el.updateBanner) el.updateBanner.hidden = true;
    });
  }

  if (el.updateModalClose) {
    el.updateModalClose.addEventListener('click', () => {
      if (typeof el.updateModal?.close === 'function') {
        el.updateModal.close();
      }
    });
  }

  if (!('closedBy' in HTMLDialogElement.prototype) && el.updateModal) {
    el.updateModal.addEventListener('click', (event) => {
      if (event.target === el.updateModal && typeof el.updateModal.close === 'function') {
        el.updateModal.close();
      }
    });
  }

  if (el.downloadUpdaterLink) {
    el.downloadUpdaterLink.addEventListener('click', handleDownloadUpdater);
  }

  if (el.openExtensionsLink) {
    el.openExtensionsLink.addEventListener('click', (e) => {
      e?.preventDefault?.();
      if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
        chrome.tabs.create({ url: 'chrome://extensions' });
      } else if (typeof window !== 'undefined' && window.open) {
        window.open('chrome://extensions', '_blank');
      }
    });
  }
}

async function handleDownloadUpdater(event) {
  if (event) {
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
  }

  const link = el.downloadUpdaterLink;
  if (!link || link.dataset.downloading === 'true') {
    return;
  }

  link.dataset.downloading = 'true';
  link.setAttribute('aria-busy', 'true');
  link.dataset.state = 'loading';

  const textEl = el.downloadUpdaterText || document.getElementById('download-updater-text') || link;
  const barEl = el.downloadProgressBar || document.getElementById('download-progress-bar');
  const metaEl = el.downloadProgressMeta || document.getElementById('download-progress-meta');
  const originalText = textEl ? textEl.textContent : 'Download update.bat';

  if (barEl) barEl.style.width = '15%';
  if (textEl) textEl.textContent = 'Downloading… 15%';
  if (metaEl) metaEl.textContent = '~0.8s left';

  const targetUrl = link.href || link.getAttribute('href') || 'https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/update.bat';

  // Animate progress smoothly towards 92% during the download
  const startTime = Date.now();
  const estimatedTotalMs = 850;
  let progressInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(92, Math.round(15 + (77 * (1 - Math.exp(-elapsed / 320)))));
    if (barEl) barEl.style.width = `${progress}%`;
    if (textEl) textEl.textContent = `Downloading… ${progress}%`;
    const remainingMs = Math.max(100, estimatedTotalMs - elapsed);
    const remainingSec = (remainingMs / 1000).toFixed(1);
    if (metaEl) metaEl.textContent = `~${remainingSec}s left`;
  }, 50);

  try {
    const downloadPromise = downloadUpdateScript({
      url: targetUrl,
      filename: 'update.bat',
      chromeTabs: typeof chrome !== 'undefined' ? chrome.tabs : undefined,
    });

    // Ensure at least a brief perceptible animation cycle so user sees progress and time remaining
    const [result] = await Promise.all([
      downloadPromise,
      new Promise((resolve) => setTimeout(resolve, 650)),
    ]);

    clearInterval(progressInterval);
    progressInterval = null;

    if (result.success) {
      if (barEl) barEl.style.width = '100%';
      link.dataset.state = 'success';
      if (result.method === 'blob') {
        if (textEl) textEl.textContent = 'Downloaded! ✓';
        if (metaEl) metaEl.textContent = 'update.bat';
        announce('update.bat downloaded. Run it from your Downloads folder to update.');
      } else {
        if (textEl) textEl.textContent = 'Opened in tab ↗';
        if (metaEl) metaEl.textContent = 'browser tab';
        announce('Update script opened in a new tab.');
      }
    } else {
      console.debug('Updater download unsuccessful:', result.error);
      link.dataset.state = 'error';
      if (barEl) barEl.style.width = '0%';
      if (textEl) textEl.textContent = 'Download failed';
      if (metaEl) metaEl.textContent = '';
      announce('Could not download update script. Please check your internet connection.');
    }
  } catch (err) {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    console.debug('Updater download encountered an error:', err);
    link.dataset.state = 'error';
    if (barEl) barEl.style.width = '0%';
    if (textEl) textEl.textContent = 'Download failed';
    if (metaEl) metaEl.textContent = '';
    announce('Could not download update script.');
  } finally {
    if (progressInterval) {
      clearInterval(progressInterval);
    }
    setTimeout(() => {
      if (barEl) {
        barEl.style.width = '0%';
      }
      if (textEl && originalText) {
        textEl.textContent = originalText;
      }
      if (metaEl) {
        metaEl.textContent = '';
      }
      delete link.dataset.downloading;
      delete link.dataset.state;
      link.removeAttribute('aria-busy');
    }, 3200);
  }
}

function renderUpdateBanner(info) {
  if (!el.updateBanner) return;
  el.updateBannerText.textContent = `New version available (${info.latestVersion})!`;
  el.updateBanner.hidden = false;

  if (el.updateVersionLabel) {
    el.updateVersionLabel.textContent = `${info.latestVersion} Ready`;
  }
  if (el.viewReleaseLink && info.releaseUrl) {
    el.viewReleaseLink.href = info.releaseUrl;
  }
  if (el.downloadUpdaterLink && info.updaterBatUrl) {
    el.downloadUpdaterLink.href = info.updaterBatUrl;
  }

  // Clear badge now that user has opened the side panel
  if (chrome.action?.setBadgeText) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

function initVersionIndicator() {
  const version = chrome.runtime?.getManifest?.()?.version || '1.0.3';
  if (el.activeVersionIndicator) {
    el.activeVersionIndicator.textContent = `v${version.replace(/^v/, '')}`;
    el.activeVersionIndicator.title = `Tab-Sleuth v${version.replace(/^v/, '')}`;
    el.activeVersionIndicator.dataset.version = version;
  }
}

async function checkExtensionUpdates() {
  try {
    const manifest = chrome.runtime?.getManifest ? chrome.runtime.getManifest() : { version: '1.0.3' };
    const currentVersion = manifest?.version || '1.0.3';
    const storage = chrome.storage?.local ? {
      get: (keys) => chrome.storage.local.get(keys),
      set: (obj) => chrome.storage.local.set(obj),
    } : null;

    if (storage) {
      const cached = await storage.get(['tabscan_update_info']);
      const info = cached?.tabscan_update_info;
      if (info?.latestVersion && isNewerVersion(info.latestVersion, currentVersion)) {
        renderUpdateBanner(info);
      }
    }

    const result = await checkGitHubRelease({
      currentVersion,
      storage,
    });

    if (result?.hasUpdate) {
      renderUpdateBanner(result);
    }
  } catch (err) {
    console.debug('Update check skipped:', err);
  }
}

async function init() {
  initVersionIndicator();
  const currentWindow = await chrome.windows.getCurrent();
  state.windowId = currentWindow.id;

  await loadSettings();
  wireEventListeners();

  // Non-blocking update check
  checkExtensionUpdates();

  // Check if opened via context menu first; otherwise auto-scan the active tab
  const pending = await chrome.storage.session.get(STORAGE_KEYS.PENDING_ACTION);
  if (pending[STORAGE_KEYS.PENDING_ACTION]) {
    await handlePendingAction();
  } else {
    await scanActiveTab();
  }
}

init().catch((err) => {
  console.error('Failed to initialize Tab-Sleuth side panel:', err);
  setStatusBadge('error', '⚠', 'Init error');
});
