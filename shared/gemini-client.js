/**
 * Gemini Interactions API client (REST v1beta).
 * Uses POST https://generativelanguage.googleapis.com/v1beta/interactions
 */

import {
  prunePageText,
  shouldAttachScreenshots,
  estimateTokens,
} from './token-optimizer.js';
import {
  computeQueryCacheKey,
  getQueryCache,
  setQueryCache,
  clearQueryCache,
  QueryCacheManager,
} from './cache-manager.js';

const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_CLAUDE_OUTPUT_TOKENS = 4096;

export function buildClaudeHeaders(apiKey, extraHeaders = {}) {
  return {
    'x-api-key': (apiKey || '').trim(),
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    ...extraHeaders,
  };
}

/**
 * Detects which provider to use based on model name.
 * @param {string} model
 * @returns {'gemini' | 'claude'}
 */
export function detectProvider(model) {
  return typeof model === 'string' && model.startsWith('claude') ? 'claude' : 'gemini';
}

function delayMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extracts wait time from response Retry-After or RateLimit headers.
 * @param {Response} resp
 * @returns {number|null} Milliseconds to wait, or null if unspecified
 */
export function parseRetryAfter(resp) {
  if (!resp || !resp.headers) return null;
  const header = resp.headers.get?.('retry-after') || resp.headers.get?.('Retry-After');
  if (header) {
    const seconds = parseInt(header, 10);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  const resetHeader =
    resp.headers.get?.('x-ratelimit-reset-requests') ||
    resp.headers.get?.('x-ratelimit-reset-tokens');
  if (resetHeader) {
    const s = parseFloat(resetHeader);
    if (!Number.isNaN(s) && s > 0) return Math.min(60000, Math.round(s * 1000));
  }
  return null;
}

/**
 * Fetches with automatic retry on 429 responses, rate limit windows, and 502/503 errors.
 * Provides second-by-second countdown callbacks for UI feedback during token reset waiting.
 * @param {string} url
 * @param {RequestInit & { onRetry?: (info: { attempt: number, maxRetries: number, waitMs: number, status: number, remainingSec: number }) => void }} init
 * @param {typeof fetch} fetchImpl
 * @param {number} maxRetries
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init, fetchImpl = fetch, maxRetries = 2) {
  const RETRY_DELAYS = [1000, 2500, 5000];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      let waitMs = RETRY_DELAYS[attempt - 1] || 2500;
      if (lastErr && lastErr.status === 429) {
        const retryAfter = parseRetryAfter(lastErr);
        if (retryAfter && retryAfter > 0) {
          waitMs = Math.min(60000, retryAfter);
        }
      }

      const signal = init?.signal;
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        if (signal?.aborted) throw new Error('Aborted');
        const remainingMs = Math.max(0, waitMs - (Date.now() - start));
        const remainingSec = Math.ceil(remainingMs / 1000);
        if (typeof init?.onRetry === 'function') {
          init.onRetry({
            attempt,
            maxRetries,
            waitMs,
            status: lastErr?.status || 429,
            remainingSec,
          });
        }
        await delayMs(Math.min(1000, remainingMs || 50));
      }
      if (typeof init?.onRetry === 'function') {
        init.onRetry({
          attempt,
          maxRetries,
          waitMs,
          status: lastErr?.status || 429,
          remainingSec: 0,
        });
      }
    }

    const resp = await fetchImpl(url, init);
    const isRetryable = resp.status === 429 || resp.status === 503 || resp.status === 502 || resp.status === 529;
    if (!isRetryable || attempt === maxRetries) return resp;
    lastErr = resp;
  }
  return lastErr;
}

export class GeminiApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} [code]
   */
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
    this.code = code;
  }
}

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    page_type: {
      type: 'string',
      enum: ['quiz_or_form', 'qa_forum', 'article_or_docs', 'problem_or_exercise', 'other'],
    },
    page_summary: {
      type: 'string',
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          question_type: {
            type: 'string',
            enum: [
              'multiple_choice',
              'multi_select',
              'true_false',
              'matching',
              'drag_drop',
              'short_answer',
              'coding_or_math',
              'open_ended',
            ],
          },
          options: {
            type: 'array',
            items: { type: 'string' },
          },
          selected_options: {
            type: 'array',
            items: { type: 'string' },
          },
          matching_pairs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                left: { type: 'string' },
                right: { type: 'string' },
              },
              required: ['left', 'right'],
            },
          },
          answer: { type: 'string' },
          apply_value: { type: 'string' },
          explanation: { type: 'string' },
          evidence_quote: { type: 'string' },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
        },
        required: ['question', 'question_type', 'answer', 'explanation', 'confidence'],
      },
    },
    suggested_questions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['page_type', 'page_summary', 'questions', 'suggested_questions'],
};

/**
 * Normalizes a captured tab screenshot or image payload for the Gemini Interactions API.
 * @param {object | string | null | undefined} screenshot
 * @returns {{ data: string, mime_type: string, label?: string, resolution?: string } | null}
 */
export function parseScreenshotInput(screenshot) {
  if (!screenshot) return null;

  const rawDataUrl =
    typeof screenshot === 'string'
      ? screenshot
      : typeof screenshot.dataUrl === 'string'
        ? screenshot.dataUrl
        : '';

  let parsed = null;
  if (rawDataUrl) {
    const match = rawDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (match) {
      parsed = {
        mime_type: match[1].toLowerCase(),
        data: match[2].trim(),
      };
    }
  } else {
    const base64 = screenshot.data || screenshot.base64;
    if (typeof base64 === 'string' && base64.trim()) {
      parsed = {
        mime_type: (screenshot.mime_type || screenshot.mimeType || 'image/jpeg').toLowerCase(),
        data: base64.trim(),
      };
    }
  }

  if (!parsed) return null;
  if (typeof screenshot === 'object') {
    if (typeof screenshot.label === 'string' && screenshot.label.trim()) {
      parsed.label = screenshot.label.trim();
    }
    if (['low', 'medium', 'high', 'ultra_high'].includes(screenshot.resolution)) {
      parsed.resolution = screenshot.resolution;
    }
  }
  return parsed;
}

/**
 * Collects and deduplicates all image captures attached to a page snapshot
 * (full-page scroll tiles + extracted page content images + primary screenshot).
 * @param {object | null | undefined} snapshot
 * @param {number} [maxImages=8]
 * @returns {Array<{ data: string, mime_type: string, label?: string, resolution?: string }>}
 */
export function collectSnapshotImageParts(snapshot, maxImages = 8) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const rawList = [];
  if (Array.isArray(snapshot.screenshots)) {
    rawList.push(...snapshot.screenshots);
  }
  if (snapshot.screenshot) {
    rawList.push(snapshot.screenshot);
  }

  const results = [];
  const seen = new Set();
  for (const entry of rawList) {
    const part = parseScreenshotInput(entry);
    if (!part) continue;
    const fingerprint = `${part.mime_type}|${part.data.length}|${part.data.slice(0, 64)}|${part.data.slice(-64)}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    results.push(part);
    if (results.length >= maxImages) break;
  }
  return results;
}

function toInteractionImageContent(part) {
  return {
    type: 'image',
    data: part.data,
    mime_type: part.mime_type,
    ...(part.resolution ? { resolution: part.resolution } : {}),
  };
}

/**
 * Formats an active tab snapshot into clean structured prompt context.
 * @param {object} snapshot
 * @param {number} [maxChars]
 * @returns {string}
 */
export function buildPageContextPrompt(snapshot, maxChars = 36000) {
  const parts = [];
  parts.push(`Page Title: ${snapshot.title || '(untitled)'}`);
  parts.push(`Page URL: ${snapshot.url || '(unknown)'}`);
  if (snapshot.description) {
    parts.push(`Meta Description: ${snapshot.description}`);
  }
  const imageParts = collectSnapshotImageParts(snapshot);
  if (snapshot.mediaSummary?.hasVisualContent || imageParts.length > 0) {
    const counts = [];
    if (snapshot.mediaSummary?.imageCount) counts.push(`${snapshot.mediaSummary.imageCount} image(s)`);
    if (snapshot.mediaSummary?.canvasCount) counts.push(`${snapshot.mediaSummary.canvasCount} canvas element(s)`);
    if (snapshot.mediaSummary?.svgCount) counts.push(`${snapshot.mediaSummary.svgCount} diagram(s)`);
    if (imageParts.length === 1 && !imageParts[0].label) {
      counts.push('attached viewport screenshot');
    } else if (imageParts.length > 0) {
      counts.push(`${imageParts.length} attached full-page / content image(s)`);
    }
    parts.push(`Visual Context: ${counts.join(', ')}`);
    const labeledImages = imageParts
      .map((img, idx) => (img.label ? `Image ${idx + 1}: ${img.label}` : ''))
      .filter(Boolean);
    if (labeledImages.length > 0) {
      parts.push(`Attached Images Order: ${labeledImages.join(' | ')}`);
    }
    if (Array.isArray(snapshot.mediaSummary?.visualHints) && snapshot.mediaSummary.visualHints.length > 0) {
      parts.push(`Visible Image Labels/Captions: ${snapshot.mediaSummary.visualHints.join(' | ')}`);
    }
  }
  if (snapshot.selection) {
    parts.push(`\nUser Highlighted Selection:\n"""\n${snapshot.selection}\n"""`);
  }
  if (Array.isArray(snapshot.questionCandidates) && snapshot.questionCandidates.length > 0) {
    const formattedCandidates = snapshot.questionCandidates
      .map((c, idx) => {
        const opts =
          Array.isArray(c.options) && c.options.length > 0
            ? `\n   Options: ${c.options.map((o, i) => `(${i + 1}) ${o}`).join(' | ')}`
            : '';
        return `${idx + 1}. [${c.type}] ${c.prompt}${opts}`;
      })
      .join('\n');
    parts.push(`\nDetected Candidate Question Blocks:\n${formattedCandidates}`);
  }

  const pruned = prunePageText(snapshot.text || '', { maxChars });
  const pageText = pruned.text;
  if (pageText) {
    parts.push(`\nScanned Page Content:\n"""\n${pageText}\n"""`);
  } else if (imageParts.length > 0) {
    parts.push(
      '\nScanned Page Content: (No extractable DOM text; inspect the attached viewport screenshot image carefully.)'
    );
  }
  if (
    snapshot.truncated ||
    (snapshot.text || '').length > maxChars ||
    pruned.originalChars > maxChars
  ) {
    parts.push('(Note: page text was truncated at the configured character limit.)');
  }

  return parts.join('\n');
}

/**
 * Extracts all trailing model_output text from an Interaction JSON response.
 * @param {object} interaction
 * @returns {string}
 */
export function extractTextFromInteraction(interaction) {
  if (!interaction) return '';
  if (typeof interaction.output_text === 'string') {
    return interaction.output_text;
  }
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  const texts = [];
  for (const step of steps) {
    if (step?.type === 'model_output' && Array.isArray(step.content)) {
      for (const block of step.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
    }
  }
  return texts.join('');
}

/**
 * Normalizes HTTP error responses from the Gemini API into friendly GeminiApiError instances.
 * @param {Response} response
 * @returns {Promise<GeminiApiError>}
 */
async function parseErrorResponse(response) {
  let rawMessage = response.statusText || `HTTP ${response.status}`;
  let code = '';
  try {
    const payload = await response.json();
    if (payload?.error?.message) {
      rawMessage = payload.error.message;
      code = payload.error.status || payload.error.code || '';
    } else if (typeof payload?.message === 'string') {
      rawMessage = payload.message;
    }
  } catch {
    // Response wasn't JSON; keep statusText.
  }

  if (response.status === 401 || response.status === 403) {
    return new GeminiApiError(
      `API key rejected (${response.status}): ${rawMessage}. Check your Gemini API key in Settings.`,
      response.status,
      code
    );
  }
  if (response.status === 429) {
    return new GeminiApiError(
      `Rate limit or quota reached (429): ${rawMessage}. Wait a moment or switch models in Settings.`,
      response.status,
      code
    );
  }
  if (response.status === 503 || response.status === 502) {
    return new GeminiApiError(
      `Model capacity reached (${response.status}): ${rawMessage}. Google's servers for this model are under heavy demand. Try switching to 'gemini-2.5-flash' in Settings or wait a moment.`,
      response.status,
      code
    );
  }
  return new GeminiApiError(`Gemini API error (${response.status}): ${rawMessage}`, response.status, code);
}

/**
 * Builds generation_config when optional thinking_level or max_output_tokens are specified.
 * @param {{ thinkingLevel?: string, maxOutputTokens?: number }} opts
 * @returns {object | undefined}
 */
function buildGenerationConfig({ thinkingLevel, maxOutputTokens } = {}) {
  const cfg = {};
  if (thinkingLevel && ['low', 'medium', 'high'].includes(thinkingLevel)) {
    cfg.thinking_level = thinkingLevel;
  }
  if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
    cfg.max_output_tokens = maxOutputTokens;
  }
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/**
 * Automatically scans page content for questions (quizzes, forms, FAQs, coding/math problems,
 * or highlighted selections) and returns structured answers plus suggested follow-up questions.
 *
 * @param {object} params
 * @returns {Promise<{ analysis: object, usage: object | null }>}
 */
export async function analyzePageQuestions({
  apiKey,
  claudeApiKey,
  model = 'gemini-3.8-flash',
  pageSnapshot,
  answerStyle = 'concise',
  thinkingLevel = 'low',
  maxPageChars = 36000,
  signal,
  endpoint = INTERACTIONS_ENDPOINT,
  fetchImpl = fetch,
  cacheManager,
  forceRefresh = false,
  onRetry,
}) {
  if (detectProvider(model) === 'claude') {
    return analyzePageQuestionsWithClaude({
      apiKey: claudeApiKey || apiKey,
      model,
      pageSnapshot,
      answerStyle,
      maxPageChars,
      signal,
      fetchImpl,
      cacheManager,
      forceRefresh,
      onRetry,
    });
  }
  if (!apiKey?.trim()) {
    throw new GeminiApiError('No Gemini API key configured.', 0, 'missing_api_key');
  }

  if (cacheManager && !forceRefresh) {
    try {
      const cacheKeyParams = {
        contentHash: pageSnapshot?.contentHash,
        query: '__analysis__',
        model,
        answerStyle,
      };
      let cached = null;
      if (typeof cacheManager.get === 'function') {
        cached = await cacheManager.get(cacheKeyParams);
      } else {
        const key = computeQueryCacheKey(cacheKeyParams);
        cached = await getQueryCache(key, cacheManager.storageArea);
      }
      if (cached?.answer) {
        const parsedCached = JSON.parse(cached.answer);
        return {
          ...parsedCached,
          cached: true,
          tokensSaved: cached.tokensSaved || 0,
        };
      }
    } catch {
      // Non-fatal cache lookup error; proceed to live request
    }
  }

  const styleInstruction =
    answerStyle === 'detailed'
      ? 'Provide thorough, well-reasoned explanations with step-by-step clarity.'
      : 'Keep each answer direct, crisp, and focused (1-3 sentences for explanation).';

  const systemInstruction = [
    'You are Tab-Sleuth, an accurate webpage analysis and question-answering assistant.',
    'Analyze the scanned active browser tab content (ALL extracted DOM text together with ALL attached full-page scroll captures and embedded page images) and return valid JSON matching the schema.',
    '1. Identify real questions, prompts, writing/editing tasks, or problems across BOTH page text and embedded passage/chart/summary/diagram images or PDFs.',
    '2. Ignore generic navigation links, cookie banners, or rhetorical marketing taglines.',
    '3. Choice questions: Put all visible choice labels in "options". For radio buttons, true/false, single dropdowns, or single-answer questions, use "multiple_choice" or "true_false" and put STRICTLY ONE exact verbatim choice label in "selected_options". Use "multi_select" ONLY when checkboxes or instructions explicitly allow picking multiple choices, and put each selected verbatim choice in "selected_options". Never include explanations or non-selected choices in "selected_options".',
    '4. Matching exercises (connecting left items/words to right descriptions/meanings by clicking left -> clicking right, dragging, or drawing lines): Emit ONE question of type "matching" covering all pairs (do not split one matching exercise into N unrelated questions), list every pair with exact verbatim DOM text in "matching_pairs": [{ "left": "...", "right": "..." }], leave "selected_options" empty, and format "answer" as numbered "left -> right" lines.',
    '5. Category Sorting / Column Bucketing Drag-and-Drop (a bank of words/items to drag into 2 or more named category columns or boxes, e.g. "Plato" vs "Epicurus" with "DRAG ITEM HERE" dropzones): Emit ONE question of type "matching", put the available word-bank items in "options", list every single item from the word bank in "matching_pairs" connecting the word chip as "left" and the target category/column name as "right" (e.g. [{ "left": "Academy", "right": "Plato" }, { "left": "Garden", "right": "Epicurus" }, { "left": "rationality", "right": "Plato" }]). ALL draggable items must be classified into their respective column/category! Format "answer" as a clean breakdown of each category with its assigned items.',
    '6. Sentence Fill-in-the-blank Cloze Drag-and-Drop (a bar of draggable chips above/beside numbered sentences containing blanks like "DRAG ITEM HERE" or "[BLANK]"): Emit one question per blank/sentence with question_type "drag_drop", put all available word-bank chips in "options", copy the exact sentence text around that blank in "question" (preserving sentence numbers and surrounding words), put the exact verbatim word-bank chip to drag into "apply_value" and "selected_options" (strictly 1 item), and set "answer" to that exact chip text. When instructions state "Read the passage, which contains the vocabulary items from the box below. Then drag the items to complete the sentences...", DO NOT refuse or ask for the passage even if the reading text is on another tab/screen: solve each sentence using its grammatical structure, collocation, and vocabulary definitions. If some sentences are already filled as examples (e.g. items 1 and 2), solve all remaining unfilled sentences using the remaining vocabulary chips in the box.',
    '7. Click-the-words / click-the-phrases / identify-parts exercises inside existing sentences (e.g., clicking unnecessary words, modifiers, or errors directly within a sentence): Emit one question per item (skip already-solved Example rows), use question_type "multi_select" when multiple words/phrases in the sentence can be selected, copy the full verbatim sentence in "question", put EVERY exact verbatim word/phrase from the sentence to click or highlight as separate items in "selected_options" (no commentary or "..." ellipsis gaps joining separate phrases), put the key phrase verbatim in "evidence_quote" and "apply_value", and give a crisp "answer".',
    '8. For short-answer, fill-in-the-blank text boxes, or coding/math inputs (without a drag-and-drop word bank), put the clean value to type into the input inside "apply_value" (no extra conversational filler), while keeping "answer" helpful and clear.',
    '9. For "evidence_quote", quote a concise exact phrase verbatim from the page or passage (avoid repeating multiple non-winning options in "evidence_quote").',
    '10. Ground every answer in the page/image content when present, or apply verified domain reasoning for standalone quiz/problem prompts. Use "confidence" honestly ("high", "medium", "low").',
    '11. If no explicit questions appear on the page (e.g., an article or documentation), set "questions" to an empty array, write a crisp 1-2 sentence "page_summary", and provide 3 helpful "suggested_questions" the user might ask about this page.',
    styleInstruction,
  ].join('\n');

  const promptText = buildPageContextPrompt(pageSnapshot, maxPageChars);
  const imageParts = collectSnapshotImageParts(pageSnapshot);
  const input =
    imageParts.length > 0
      ? [{ type: 'text', text: promptText }, ...imageParts.map(toInteractionImageContent)]
      : promptText;

  const body = {
    model,
    input,
    system_instruction: systemInstruction,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: ANALYSIS_RESPONSE_SCHEMA,
    },
    store: false,
  };

  const genConfig = buildGenerationConfig({ thinkingLevel });
  if (genConfig) {
    body.generation_config = genConfig;
  }

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey.trim(),
    },
    body: JSON.stringify(body),
    signal,
    onRetry,
  }, fetchImpl);

  if (!response.ok) {
    if (response.status === 503 && model !== 'gemini-3.5-flash-lite' && model !== 'gemini-3.1-flash-lite') {
      const fallbackCandidates = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
      for (const fallbackModel of fallbackCandidates) {
        if (fallbackModel === model) continue;
        try {
          const fallbackBody = { ...body, model: fallbackModel };
          const fbResp = await fetchWithRetry(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey.trim(),
            },
            body: JSON.stringify(fallbackBody),
            signal,
            onRetry,
          }, fetchImpl);
          if (fbResp.ok) {
            const fbData = await fbResp.json();
            const fbRaw = extractTextFromInteraction(fbData);
            if (fbRaw) {
              const fbParsed = JSON.parse(fbRaw);
              return {
                analysis: {
                  page_type: fbParsed.page_type || 'other',
                  page_summary: fbParsed.page_summary || '',
                  questions: Array.isArray(fbParsed.questions) ? fbParsed.questions : [],
                  notes: fbParsed.notes || '',
                },
                suggested_questions: Array.isArray(fbParsed.suggested_questions) ? fbParsed.suggested_questions : [],
                model: fallbackModel,
                fallbackFrom: model,
                usage: fbData.usage || null,
              };
            }
          }
        } catch {
          // Continue to next fallback candidate
        }
      }
    }
    throw await parseErrorResponse(response);
  }

  const data = await response.json();
  const rawText = extractTextFromInteraction(data);
  if (!rawText) {
    throw new GeminiApiError('Gemini returned an empty response.', 0, 'empty_response');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new GeminiApiError('Gemini returned malformed JSON analysis.', 0, 'invalid_json');
  }

  const result = {
    analysis: {
      page_type: parsed.page_type || 'other',
      page_summary: parsed.page_summary || '',
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      suggested_questions: Array.isArray(parsed.suggested_questions) ? parsed.suggested_questions : [],
    },
    usage: data.usage || null,
  };

  if (cacheManager) {
    try {
      const tokensSavedEst = estimateTokens(promptText);
      const cacheData = {
        answer: JSON.stringify(result),
        cachedAt: Date.now(),
        tokensSaved: tokensSavedEst,
        query: '__analysis__',
        model,
      };
      const cacheKeyParams = {
        contentHash: pageSnapshot?.contentHash,
        query: '__analysis__',
        model,
        answerStyle,
      };
      if (typeof cacheManager.set === 'function') {
        await cacheManager.set(cacheKeyParams, cacheData);
      } else {
        const key = computeQueryCacheKey(cacheKeyParams);
        await setQueryCache(key, cacheData, cacheManager.storageArea);
      }
    } catch {
      // Non-fatal cache store error
    }
  }

  return result;
}

/**
 * Parses an SSE stream from the Gemini Interactions API (`stream: true`).
 * Yields parsed JSON event objects as they arrive.
 *
 * @param {ReadableStream<Uint8Array>} readableStream
 * @returns {AsyncGenerator<object>}
 */
export async function* parseSseStream(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let dataLines = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      currentEvent = '';
      return null;
    }
    const rawData = dataLines.join('\n').trim();
    const fallbackType = currentEvent;
    currentEvent = '';
    dataLines = [];
    if (!rawData || rawData === '[DONE]') return null;
    try {
      const parsed = JSON.parse(rawData);
      if (!parsed.event_type && fallbackType) {
        parsed.event_type = fallbackType;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          const evt = flushEvent();
          if (evt) yield evt;
        } else if (line.startsWith(':')) {
          // SSE comment / keepalive
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    if (buffer.trim()) {
      const trailing = buffer.trim();
      if (trailing.startsWith('data:')) {
        dataLines.push(trailing.slice(5).trimStart());
      }
    }
    const finalEvt = flushEvent();
    if (finalEvt) yield finalEvt;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams an answer to a user-submitted question grounded in the active tab snapshot.
 *
 * @param {object} params
 * @returns {Promise<{ text: string, usage: object | null }>}
 */
export async function streamCustomQuestion({
  apiKey,
  claudeApiKey,
  model = 'gemini-3.8-flash',
  pageSnapshot,
  history = [],
  question,
  answerStyle = 'concise',
  thinkingLevel = 'low',
  maxPageChars = 36000,
  onChunk,
  signal,
  endpoint = INTERACTIONS_ENDPOINT,
  fetchImpl = fetch,
  cacheManager,
  forceRefresh = false,
  onRetry,
}) {
  if (detectProvider(model) === 'claude') {
    return streamCustomQuestionWithClaude({
      apiKey: claudeApiKey || apiKey,
      model,
      pageSnapshot,
      history,
      question,
      answerStyle,
      maxPageChars,
      onChunk,
      signal,
      fetchImpl,
      cacheManager,
      forceRefresh,
      onRetry,
    });
  }
  if (!apiKey?.trim()) {
    throw new GeminiApiError('No Gemini API key configured.', 0, 'missing_api_key');
  }

  // Check query cache
  if (cacheManager && !forceRefresh) {
    try {
      const cacheKeyParams = {
        contentHash: pageSnapshot?.contentHash,
        query: question,
        model,
        answerStyle,
      };
      let cached = null;
      if (typeof cacheManager.get === 'function') {
        cached = await cacheManager.get(cacheKeyParams);
      } else {
        const key = computeQueryCacheKey(cacheKeyParams);
        cached = await getQueryCache(key, cacheManager.storageArea);
      }
      if (cached?.answer) {
        if (typeof onChunk === 'function') {
          onChunk(cached.answer, cached.answer);
        }
        return {
          text: cached.answer,
          usage: null,
          cached: true,
          tokensSaved: cached.tokensSaved || estimateTokens(cached.answer),
        };
      }
    } catch {
      // Non-fatal cache lookup error; proceed to live network request
    }
  }

  const pageContext = buildPageContextPrompt(pageSnapshot, maxPageChars);
  const styleRule =
    answerStyle === 'detailed'
      ? 'Provide a thorough, clearly structured explanation with supporting details from the page.'
      : 'Be direct, concise, and practical. Lead with the exact answer, then briefly explain why.';

  const systemInstruction = [
    'You are Tab-Sleuth, an assistant answering questions about the user\'s active browser tab.',
    styleRule,
    'Inspect BOTH the scanned DOM text and ALL attached full-page screenshots and embedded passage/chart/diagram images together (or PDFs).',
    'When the answer relies on facts from the page or screen, cite or quote the relevant part concisely.',
    'If the page does not contain enough information to be certain, state clearly what is missing instead of fabricating (for cloze vocabulary exercises where an external passage is mentioned, deduce the answers from sentence context).',
    '\n--- ACTIVE TAB CONTEXT ---\n' + pageContext,
  ].join('\n');

  const inputSteps = [];
  for (const turn of history.slice(-8)) {
    if (!turn?.text) continue;
    inputSteps.push({
      type: turn.role === 'model' ? 'model_output' : 'user_input',
      content: [{ type: 'text', text: turn.text }],
    });
  }

  const userContent = [{ type: 'text', text: question }];
  const attachImages = shouldAttachScreenshots(pageSnapshot, question);
  const imageParts = attachImages ? collectSnapshotImageParts(pageSnapshot) : [];
  for (const part of imageParts) {
    userContent.push(toInteractionImageContent(part));
  }

  inputSteps.push({
    type: 'user_input',
    content: userContent,
  });

  const body = {
    model,
    input: inputSteps,
    system_instruction: systemInstruction,
    stream: true,
    store: false,
  };

  const genConfig = buildGenerationConfig({ thinkingLevel });
  if (genConfig) {
    body.generation_config = genConfig;
  }

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-goog-api-key': apiKey.trim(),
    },
    body: JSON.stringify(body),
    signal,
    onRetry,
  }, fetchImpl);

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  if (!response.body) {
    // Fallback if fetch mock or environment returns non-streaming JSON body
    const data = await response.json();
    const text = extractTextFromInteraction(data);
    if (text && onChunk) onChunk(text, text);
    if (cacheManager && text) {
      try {
        const tokensSavedEst = estimateTokens(systemInstruction + question + text);
        const cacheData = {
          answer: text,
          cachedAt: Date.now(),
          tokensSaved: tokensSavedEst,
          query: question,
          model,
        };
        const cacheKeyParams = {
          contentHash: pageSnapshot?.contentHash,
          query: question,
          model,
          answerStyle,
        };
        if (typeof cacheManager.set === 'function') {
          await cacheManager.set(cacheKeyParams, cacheData);
        } else {
          const key = computeQueryCacheKey(cacheKeyParams);
          await setQueryCache(key, cacheData, cacheManager.storageArea);
        }
      } catch {
        // Non-fatal cache store error
      }
    }
    return { text, usage: data.usage || null };
  }

  let fullText = '';
  let finalUsage = null;

  for await (const evt of parseSseStream(response.body)) {
    if (evt.event_type === 'error') {
      throw new GeminiApiError(
        evt.error?.message || 'Streaming error from Gemini API.',
        0,
        evt.error?.code || 'stream_error'
      );
    }

    if (evt.event_type === 'step.start' && evt.step?.type === 'model_output') {
      const initialBlocks = Array.isArray(evt.step.content) ? evt.step.content : [];
      for (const block of initialBlocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          fullText += block.text;
          if (onChunk) onChunk(block.text, fullText);
        }
      }
    } else if (evt.event_type === 'step.delta' && evt.delta?.type === 'text') {
      const deltaText = evt.delta.text || '';
      if (deltaText) {
        fullText += deltaText;
        if (onChunk) onChunk(deltaText, fullText);
      }
    } else if (evt.event_type === 'interaction.completed') {
      finalUsage = evt.interaction?.usage || null;
    }
  }

  if (cacheManager && fullText) {
    try {
      const tokensSavedEst = estimateTokens(systemInstruction + question + fullText);
      const cacheData = {
        answer: fullText,
        cachedAt: Date.now(),
        tokensSaved: tokensSavedEst,
        query: question,
        model,
      };
      const cacheKeyParams = {
        contentHash: pageSnapshot?.contentHash,
        query: question,
        model,
        answerStyle,
      };
      if (typeof cacheManager.set === 'function') {
        await cacheManager.set(cacheKeyParams, cacheData);
      } else {
        const key = computeQueryCacheKey(cacheKeyParams);
        await setQueryCache(key, cacheData, cacheManager.storageArea);
      }
    } catch {
      // Non-fatal cache store error
    }
  }

  return { text: fullText, usage: finalUsage };
}

/**
 * Verifies that the provided API key and model accept requests.
 * @param {object} params
 * @returns {Promise<{ ok: boolean, model: string, reply: string }>}
 */
export async function testApiKey({
  apiKey,
  claudeApiKey,
  model = 'gemini-3.8-flash',
  signal,
  endpoint = INTERACTIONS_ENDPOINT,
  fetchImpl = fetch,
}) {
  if (detectProvider(model) === 'claude') {
    const keyToUse = (claudeApiKey || apiKey || '').trim();
    if (!keyToUse) {
      throw new GeminiApiError('Please enter a Claude API key first.', 0, 'missing_api_key');
    }
    const response = await fetchWithRetry(CLAUDE_ENDPOINT, {
      method: 'POST',
      headers: buildClaudeHeaders(keyToUse, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
      }),
      signal,
    }, fetchImpl);
    if (!response.ok) {
      throw await parseClaudeErrorResponse(response);
    }
    const data = await response.json();
    const reply = (data.content?.[0]?.text || '').trim();
    return { ok: true, model: data.model || model, reply };
  }

  if (!apiKey?.trim()) {
    throw new GeminiApiError('Please enter a Gemini API key first.', 0, 'missing_api_key');
  }

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey.trim(),
    },
    body: JSON.stringify({
      model,
      input: 'Reply with OK.',
      generation_config: {
        max_output_tokens: 16,
      },
      store: false,
    }),
    signal,
  }, fetchImpl);

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  const data = await response.json();
  return {
    ok: true,
    model: data.model || model,
    reply: extractTextFromInteraction(data).trim(),
  };
}

/**
 * Fetches available models from Google Gemini or Anthropic Claude API using the provided key.
 * @param {{ provider?: 'gemini' | 'claude', apiKey: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<Array<{ id: string, label: string, category?: string }>>}
 */
export async function fetchAvailableModels({
  provider = 'gemini',
  apiKey,
  signal,
  fetchImpl = fetch,
}) {
  const cleanKey = (apiKey || '').trim();
  const effectiveProvider = provider === 'claude' || cleanKey.startsWith('sk-ant-') ? 'claude' : 'gemini';

  if (!cleanKey) {
    throw new GeminiApiError(
      `Please enter a ${effectiveProvider === 'claude' ? 'Claude' : 'Gemini'} API key first.`,
      0,
      'missing_api_key'
    );
  }

  if (effectiveProvider === 'claude') {
    try {
      const response = await fetchWithRetry(
        'https://api.anthropic.com/v1/models',
        {
          method: 'GET',
          headers: buildClaudeHeaders(cleanKey),
          signal,
        },
        fetchImpl
      );

      if (!response.ok) {
        throw await parseClaudeErrorResponse(response);
      }

      const data = await response.json();
      const rawList = Array.isArray(data?.data) ? data.data : [];
      const models = rawList
        .filter((m) => m && typeof m.id === 'string' && m.id.startsWith('claude'))
        .map((m) => {
          const id = m.id;
          const name = m.display_name || id;
          const isHaiku = id.includes('haiku');
          const isOpus = id.includes('opus');
          const isSonnet = id.includes('sonnet');
          const tag = isHaiku ? 'Fast' : isOpus ? 'Deep Reasoning' : isSonnet ? 'Balanced' : '';
          return {
            id,
            label: tag ? `${name} (${tag})` : name,
            category: isHaiku ? 'fast' : isOpus ? 'reasoning' : 'flagship',
          };
        });

      if (models.length > 0) {
        return models;
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) throw err;
    }

    return [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Balanced)', category: 'flagship' },
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5 (Most capable)', category: 'reasoning' },
      { id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5 (Fastest Claude)', category: 'fast' },
      { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet (Hybrid reasoning)', category: 'flagship' },
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Coding & reasoning)', category: 'flagship' },
    ];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`;
  const response = await fetchWithRetry(
    url,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal,
    },
    fetchImpl
  );

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  const data = await response.json();
  const rawList = Array.isArray(data?.models) ? data.models : [];

  const validModels = rawList
    .filter((m) => {
      const name = (m.name || '').replace(/^models\//, '');
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      const isGenerative = methods.includes('generateContent') || methods.includes('createInteraction');
      const isAux = /embedding|aqa|imagen|whisper|tts|learnlm/i.test(name);
      return isGenerative && !isAux && /gemini/i.test(name);
    })
    .map((m) => {
      const id = (m.name || '').replace(/^models\//, '');
      const displayName = m.displayName || id;
      const isFlash = /flash/i.test(id);
      const isLite = /lite/i.test(id);
      const isProOrArgon = /pro|argon|ultra/i.test(id);
      const tag = isLite ? 'Fast & Low Cost' : isFlash ? 'Fast & Smart' : isProOrArgon ? 'Deep Reasoning' : '';
      return {
        id,
        label: tag ? `${displayName} (${tag})` : displayName,
        category: isLite ? 'lite' : isFlash ? 'recommended' : isProOrArgon ? 'reasoning' : 'other',
      };
    });

  if (validModels.length > 0) {
    const order = { recommended: 0, lite: 1, reasoning: 2, other: 3 };
    validModels.sort((a, b) => (order[a.category] ?? 4) - (order[b.category] ?? 4));
    return validModels;
  }

  return [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Recommended — Fast & smart)', category: 'recommended' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (Fastest & lowest cost)', category: 'lite' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (Lightweight & high-speed)', category: 'lite' },
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon (Flagship deep reasoning)', category: 'reasoning' },
  ];
}

// ---------------------------------------------------------------------------
// Claude API helpers
// ---------------------------------------------------------------------------

/**
 * Parses Claude API error responses into GeminiApiError instances.
 * @param {Response} response
 * @returns {Promise<GeminiApiError>}
 */
async function parseClaudeErrorResponse(response) {
  let rawMessage = response.statusText || `HTTP ${response.status}`;
  let code = '';
  try {
    const payload = await response.json();
    if (payload?.error?.message) {
      rawMessage = payload.error.message;
      code = payload.error.type || '';
    }
  } catch {
    // keep statusText
  }
  if (response.status === 401 || response.status === 403) {
    return new GeminiApiError(
      `API key rejected (${response.status}): ${rawMessage}. Check your Claude API key in Settings.`,
      response.status,
      code
    );
  }
  if (response.status === 429) {
    return new GeminiApiError(
      `Rate limit or quota reached (429): ${rawMessage}. Wait a moment or switch to a different model.`,
      response.status,
      code
    );
  }
  if (response.status === 529 || response.status === 503) {
    return new GeminiApiError(
      `Claude API is currently overloaded (${response.status}): ${rawMessage}. Please retry in a moment.`,
      response.status,
      code
    );
  }
  return new GeminiApiError(`Claude API error (${response.status}): ${rawMessage}`, response.status, code);
}

/**
 * Builds the Claude user content array from a page snapshot (text + images).
 * @param {string} promptText
 * @param {Array} imageParts
 * @returns {Array}
 */
function buildClaudeUserContent(promptText, imageParts) {
  const content = [{ type: 'text', text: promptText }];
  for (const part of imageParts) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.mime_type,
        data: part.data,
      },
    });
  }
  return content;
}

/**
 * Strips markdown code fences from Claude JSON responses, then parses.
 * @param {string} text
 * @returns {object}
 */
function parseClaudeJson(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new GeminiApiError('Claude returned malformed JSON analysis.', 0, 'invalid_json');
  }
}

/**
 * Analyzes page questions using the Claude Messages API (non-streaming).
 * @param {object} params
 * @returns {Promise<{ analysis: object, usage: object | null }>}
 */
async function analyzePageQuestionsWithClaude({
  apiKey,
  model,
  pageSnapshot,
  answerStyle = 'concise',
  maxPageChars = 36000,
  signal,
  fetchImpl = fetch,
  cacheManager,
  forceRefresh,
  onRetry,
}) {
  if (!apiKey?.trim()) {
    throw new GeminiApiError('No Claude API key configured.', 0, 'missing_api_key');
  }

  const styleInstruction =
    answerStyle === 'detailed'
      ? 'Provide thorough, well-reasoned explanations with step-by-step clarity.'
      : 'Keep each answer direct, crisp, and focused (1-3 sentences for explanation).';

  const systemPrompt = [
    'You are Tab-Sleuth, an accurate webpage analysis and question-answering assistant.',
    'Analyze the scanned active browser tab content (ALL extracted DOM text together with ALL attached full-page scroll captures and embedded page images) and return valid JSON matching the schema.',
    '1. Identify real questions, prompts, writing/editing tasks, or problems across BOTH page text and embedded passage/chart/summary/diagram images or PDFs.',
    '2. Ignore generic navigation links, cookie banners, or rhetorical marketing taglines.',
    '3. Choice questions: Put all visible choice labels in "options". For radio buttons, true/false, single dropdowns, or single-answer questions, use "multiple_choice" or "true_false" and put STRICTLY ONE exact verbatim choice label in "selected_options". Use "multi_select" ONLY when checkboxes or instructions explicitly allow picking multiple choices, and put each selected verbatim choice in "selected_options". Never include explanations or non-selected choices in "selected_options".',
    '4. Matching exercises: Emit ONE question of type "matching" covering all pairs, list every pair in "matching_pairs": [{ "left": "...", "right": "..." }], leave "selected_options" empty.',
    '5. Category Sorting / Column Bucketing Drag-and-Drop (sorting a word bank into 2+ columns/boxes): Emit ONE question of type "matching", list every single item in "matching_pairs" connecting the word chip as "left" and the category name as "right" (e.g. [{ "left": "Academy", "right": "Plato" }, { "left": "Garden", "right": "Epicurus" }]). Classify all items into their respective column.',
    '6. Drag-and-drop word bank (sentence cloze blanks): Emit one question per blank/sentence with question_type "drag_drop", put the exact verbatim word-bank chip to drag into "apply_value" and "selected_options" (strictly 1 item). When instructions mention an external passage or reading, DO NOT refuse or ask for the passage; use each sentence\'s context and grammar to match the correct word-bank item. If some sentences are already filled, prioritize completing all remaining unfilled blanks.',
    '7. Click-the-words exercises: Emit one question per item, use question_type "multi_select", copy the full verbatim sentence in "question", put EVERY word/phrase to click as separate items in "selected_options".',
    '8. For short-answer or coding/math inputs, put the clean value in "apply_value".',
    '9. For "evidence_quote", quote a concise exact phrase verbatim from the page or passage.',
    '10. Ground every answer in the page/image content. Use "confidence" honestly ("high", "medium", "low").',
    '11. If no explicit questions appear, set "questions" to an empty array and provide 3 helpful "suggested_questions".',
    styleInstruction,
    '\n\nIMPORTANT: Respond with ONLY valid JSON matching this exact schema, no markdown, no commentary before or after.',
    'Required JSON schema: { "page_type": "quiz_or_form"|"qa_forum"|"article_or_docs"|"problem_or_exercise"|"other", "page_summary": string, "questions": [ { "question": string, "question_type": "multiple_choice"|"multi_select"|"true_false"|"matching"|"drag_drop"|"short_answer"|"coding_or_math"|"open_ended", "options": string[], "selected_options": string[], "matching_pairs": [{"left":string,"right":string}], "answer": string, "apply_value": string, "explanation": string, "evidence_quote": string, "confidence": "high"|"medium"|"low" } ], "suggested_questions": string[] }',
  ].join('\n');

  const promptText = buildPageContextPrompt(pageSnapshot, maxPageChars);
  const imageParts = collectSnapshotImageParts(pageSnapshot);
  const userContent = buildClaudeUserContent(promptText, imageParts);

  const response = await fetchWithRetry(CLAUDE_ENDPOINT, {
    method: 'POST',
    headers: buildClaudeHeaders(apiKey, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({
      model,
      max_tokens: MAX_CLAUDE_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
    signal,
    onRetry,
  }, fetchImpl);

  if (!response.ok) {
    throw await parseClaudeErrorResponse(response);
  }

  const data = await response.json();
  const rawText = (data.content?.[0]?.text || '').trim();
  if (!rawText) {
    throw new GeminiApiError('Claude returned an empty response.', 0, 'empty_response');
  }

  const parsed = parseClaudeJson(rawText);

  return {
    analysis: {
      page_type: parsed.page_type || 'other',
      page_summary: parsed.page_summary || '',
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      suggested_questions: Array.isArray(parsed.suggested_questions) ? parsed.suggested_questions : [],
    },
    usage: data.usage
      ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
      : null,
  };
}

/**
 * Streams an answer using the Claude Messages API (streaming SSE).
 * @param {object} params
 * @returns {Promise<{ text: string, usage: object | null }>}
 */
async function streamCustomQuestionWithClaude({
  apiKey,
  model,
  pageSnapshot,
  history = [],
  question,
  answerStyle = 'concise',
  maxPageChars = 36000,
  onChunk,
  signal,
  fetchImpl = fetch,
  cacheManager,
  forceRefresh = false,
  onRetry,
}) {
  if (!apiKey?.trim()) {
    throw new GeminiApiError('No Claude API key configured.', 0, 'missing_api_key');
  }

  // Check query cache
  if (cacheManager && !forceRefresh) {
    try {
      const cacheKeyParams = {
        contentHash: pageSnapshot?.contentHash,
        query: question,
        model,
        answerStyle,
      };
      let cached = null;
      if (typeof cacheManager.get === 'function') {
        cached = await cacheManager.get(cacheKeyParams);
      } else {
        const key = computeQueryCacheKey(cacheKeyParams);
        cached = await getQueryCache(key, cacheManager.storageArea);
      }
      if (cached?.answer) {
        if (typeof onChunk === 'function') {
          onChunk(cached.answer, cached.answer);
        }
        return {
          text: cached.answer,
          usage: null,
          cached: true,
          tokensSaved: cached.tokensSaved || estimateTokens(cached.answer),
        };
      }
    } catch {
      // Non-fatal cache lookup error
    }
  }

  const pageContext = buildPageContextPrompt(pageSnapshot, maxPageChars);
  const styleRule =
    answerStyle === 'detailed'
      ? 'Provide a thorough, clearly structured explanation with supporting details from the page.'
      : 'Be direct, concise, and practical. Lead with the exact answer, then briefly explain why.';

  const systemPrompt = [
    "You are Tab-Sleuth, an assistant answering questions about the user's active browser tab.",
    styleRule,
    'Inspect BOTH the scanned DOM text and ALL attached full-page screenshots and embedded passage/chart/diagram images together (or PDFs).',
    'When the answer relies on facts from the page or screen, cite or quote the relevant part concisely.',
    'If the page does not contain enough information to be certain, state clearly what is missing instead of fabricating (for cloze vocabulary exercises where an external passage is mentioned, deduce the answers from sentence context).',
    '\n--- ACTIVE TAB CONTEXT ---\n' + pageContext,
  ].join('\n');

  // Build Claude messages from history
  const messages = [];
  for (const turn of history.slice(-8)) {
    if (!turn?.text) continue;
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: [{ type: 'text', text: turn.text }],
    });
  }

  const attachImages = shouldAttachScreenshots(pageSnapshot, question);
  const imageParts = attachImages ? collectSnapshotImageParts(pageSnapshot) : [];
  const userContent = buildClaudeUserContent(question, imageParts);
  messages.push({ role: 'user', content: userContent });

  const response = await fetchWithRetry(CLAUDE_ENDPOINT, {
    method: 'POST',
    headers: buildClaudeHeaders(apiKey, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({
      model,
      max_tokens: MAX_CLAUDE_OUTPUT_TOKENS,
      system: systemPrompt,
      messages,
      stream: true,
    }),
    signal,
    onRetry,
  }, fetchImpl);

  if (!response.ok) {
    throw await parseClaudeErrorResponse(response);
  }

  if (!response.body) {
    const data = await response.json();
    const text = (data.content?.[0]?.text || '').trim();
    if (text && onChunk) onChunk(text, text);
    if (cacheManager && text) {
      try {
        const tokensSavedEst = estimateTokens(systemPrompt + question + text);
        const cacheData = {
          answer: text,
          cachedAt: Date.now(),
          tokensSaved: tokensSavedEst,
          query: question,
          model,
        };
        const cacheKeyParams = {
          contentHash: pageSnapshot?.contentHash,
          query: question,
          model,
          answerStyle,
        };
        if (typeof cacheManager.set === 'function') {
          await cacheManager.set(cacheKeyParams, cacheData);
        } else {
          const key = computeQueryCacheKey(cacheKeyParams);
          await setQueryCache(key, cacheData, cacheManager.storageArea);
        }
      } catch {
        // Non-fatal cache store error
      }
    }
    return {
      text,
      usage: data.usage
        ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
        : null,
    };
  }

  let fullText = '';
  let finalUsage = null;

  // Parse Claude SSE format
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      let currentEvent = '';
      for (const line of lines) {
        if (line === '') {
          currentEvent = '';
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const rawData = line.slice(5).trimStart();
          if (!rawData || rawData === '[DONE]') continue;
          try {
            const evt = JSON.parse(rawData);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              const chunk = evt.delta.text || '';
              if (chunk) {
                fullText += chunk;
                if (onChunk) onChunk(chunk, fullText);
              }
            } else if (evt.type === 'message_delta' && evt.usage) {
              finalUsage = { output_tokens: evt.usage.output_tokens };
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (cacheManager && fullText) {
    try {
      const tokensSavedEst = estimateTokens(systemPrompt + question + fullText);
      const cacheData = {
        answer: fullText,
        cachedAt: Date.now(),
        tokensSaved: tokensSavedEst,
        query: question,
        model,
      };
      const cacheKeyParams = {
        contentHash: pageSnapshot?.contentHash,
        query: question,
        model,
        answerStyle,
      };
      if (typeof cacheManager.set === 'function') {
        await cacheManager.set(cacheKeyParams, cacheData);
      } else {
        const key = computeQueryCacheKey(cacheKeyParams);
        await setQueryCache(key, cacheData, cacheManager.storageArea);
      }
    } catch {
      // Non-fatal cache store error
    }
  }

  return { text: fullText, usage: finalUsage };
}

export {
  prunePageText,
  shouldAttachScreenshots,
  estimateTokens,
} from './token-optimizer.js';
export {
  computeQueryCacheKey,
  getQueryCache,
  setQueryCache,
  clearQueryCache,
  QueryCacheManager,
} from './cache-manager.js';
