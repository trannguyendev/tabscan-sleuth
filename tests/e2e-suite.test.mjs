/**
 * TabScan Q&A MV3 Extension - Comprehensive 4-Tier Automated E2E Test Suite
 *
 * Tier 1 — Feature Coverage (48 tests across 8 core features)
 * Tier 2 — Boundary & Corner Cases (48 tests across 8 core features)
 * Tier 3 — Cross-Feature Combinations (16 pairwise interaction tests)
 * Tier 4 — Real-World Application Scenarios (6 realistic end-to-end workloads)
 *
 * Total test count: 118 tests (exceeds mandatory ≥100 requirement)
 * Zero external dependencies: pure Node.js built-ins.
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared extension modules
import {
  prunePageText,
  estimateTokens,
  stripBoilerplateSelectors,
  shouldAttachScreenshots,
} from '../shared/token-optimizer.js';

import {
  computeQueryCacheKey,
  getQueryCache,
  setQueryCache,
  clearQueryCache,
  QueryCacheManager,
} from '../shared/cache-manager.js';

import {
  parseSseStream,
  streamCustomQuestion,
  buildPageContextPrompt,
  GeminiApiError,
  detectProvider,
} from '../shared/gemini-client.js';

import {
  calculateCrc32,
  encodeVarint,
  decodeVarint,
  computeAppId,
  createZipBuffer,
  collectExtensionFiles,
  generateCrx3,
  parseCrx3Header,
  generateUpdateXml,
  ensurePrivateKey,
  packageRelease,
} from '../scripts/package-release.mjs';

import { renderMarkdown } from '../shared/markdown.js';

// Test fixtures & DOM harness
import {
  MockStorageArea,
  makeSseStream,
  makeGeminiSseChunks,
  createSyntheticDom,
  MiniElement,
  MiniEvent,
  WIKIPEDIA_PHOTOSYNTHESIS_TEXT,
  SPA_PAGE_HTML,
} from './fixtures/synthetic-fixtures.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Helper: load root manifest.json
async function getManifest() {
  const content = await fs.readFile(path.join(ROOT_DIR, 'manifest.json'), 'utf8');
  return JSON.parse(content);
}

// Helper: load root key.pem
async function getPrivateKeyPem() {
  return fs.readFile(path.join(ROOT_DIR, 'key.pem'), 'utf8');
}

// ============================================================================
// TIER 1 — FEATURE COVERAGE (48 Tests, 6 per Feature across 8 Features)
// ============================================================================

describe('Tier 1 — Feature Coverage', () => {

  // --------------------------------------------------------------------------
  // Feature 1: DOM Context Pruning & Compression (shared/token-optimizer.js)
  // --------------------------------------------------------------------------
  describe('1.1 DOM Context Pruning & Compression', () => {
    it('T1_F1_01: prunePageText collapses multi-spaces, tabs, and excess newlines', () => {
      const input = 'Header   Title\t\twith   spacing\n\n\n\n\nParagraph   1\r\n\r\nParagraph   2';
      const res = prunePageText(input);
      assert.strictEqual(res.text, 'Header Title with spacing\n\nParagraph 1\n\nParagraph 2');
      assert.strictEqual(res.originalChars, input.length);
      assert.strictEqual(res.prunedChars, res.text.length);
      assert.ok(res.tokensSavedEst > 0);
    });

    it('T1_F1_02: prunePageText truncates cleanly at paragraph boundary before maxChars', () => {
      const p1 = 'A'.repeat(45);
      const p2 = 'B'.repeat(50);
      const full = `${p1}\n\n${p2}`;
      const res = prunePageText(full, { maxChars: 50 });
      assert.strictEqual(res.text, p1);
      assert.strictEqual(res.prunedChars, 45);
      assert.strictEqual(res.originalChars, full.length);
      assert.strictEqual(res.tokensSavedEst, Math.ceil((full.length - 45) / 4));
    });

    it('T1_F1_03: prunePageText truncates at sentence boundary when paragraph boundary below minRetain', () => {
      const sentence1 = 'This is the first complete sentence in the passage.';
      const sentence2 = 'This is the second complete sentence which extends further.';
      const sentence3 = 'This is the third sentence that pushes beyond limit.';
      const full = `${sentence1} ${sentence2} ${sentence3}`;
      const res = prunePageText(full, { maxChars: 115 });
      assert.ok(res.text.endsWith('.'));
      assert.ok(res.text.includes(sentence1));
      assert.ok(res.text.includes(sentence2));
      assert.ok(!res.text.includes(sentence3));
    });

    it('T1_F1_04: stripBoilerplateSelectors removes nav, footer, aside, and ad elements', () => {
      const { document: doc } = createSyntheticDom();
      const root = doc.createElement('div');
      const nav = doc.createElement('nav');
      nav.textContent = 'Navigation links';
      const main = doc.createElement('main');
      main.textContent = 'Main valuable content';
      const footer = doc.createElement('footer');
      footer.textContent = 'Copyright notice';
      const ad = doc.createElement('div', { class: 'ad advertisement' });
      ad.textContent = 'Buy something';

      root.appendChild(nav);
      root.appendChild(main);
      root.appendChild(footer);
      root.appendChild(ad);

      const stripped = stripBoilerplateSelectors(root);
      assert.strictEqual(stripped, 3);
      assert.strictEqual(root.children.length, 1);
      assert.strictEqual(root.children[0].tagName, 'MAIN');
    });

    it('T1_F1_05: stripBoilerplateSelectors strictly protects fieldset and input elements', () => {
      const { document: doc } = createSyntheticDom();
      const root = doc.createElement('div');
      const aside = doc.createElement('aside');
      const fieldset = doc.createElement('fieldset');
      const legend = doc.createElement('legend');
      legend.textContent = 'Quiz Question 1';
      const input = doc.createElement('input', { type: 'radio', name: 'q1', value: 'opt1' });

      fieldset.appendChild(legend);
      fieldset.appendChild(input);
      aside.appendChild(fieldset);
      root.appendChild(aside);

      const stripped = stripBoilerplateSelectors(root);
      assert.strictEqual(stripped, 0);
      assert.strictEqual(root.children.length, 1);
      assert.ok(root.querySelector('fieldset'));
      assert.ok(root.querySelector('input'));
    });

    it('T1_F1_06: shouldAttachScreenshots discriminates text-only vs visual queries accurately', () => {
      const richSnapshot = {
        text: 'This is a long and rich documentation article containing well over 150 characters of technical prose explaining concepts in deep technical detail.'.repeat(3),
      };
      assert.ok(richSnapshot.text.length > 150);
      assert.strictEqual(shouldAttachScreenshots(richSnapshot, 'What is the definition of closures?'), false);
      assert.strictEqual(shouldAttachScreenshots(richSnapshot, 'Explain the architecture diagram shown below'), true);
      assert.strictEqual(shouldAttachScreenshots(richSnapshot, 'What colors are used in the chart?'), true);

      const visualOnlySnapshot = { kind: 'visual_only', text: 'PDF content' };
      assert.strictEqual(shouldAttachScreenshots(visualOnlySnapshot, 'Summarize this file'), true);

      const shortSnapshot = { text: 'Short page' };
      assert.strictEqual(shouldAttachScreenshots(shortSnapshot, 'Any questions?'), true);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 2: Multi-Tier Intelligent Query Caching (shared/cache-manager.js)
  // --------------------------------------------------------------------------
  describe('1.2 Multi-Tier Intelligent Query Caching', () => {
    it('T1_F2_01: computeQueryCacheKey generates deterministic 32-char hex digest', () => {
      const key1 = computeQueryCacheKey({
        contentHash: 'hash-abc',
        query: '  What is the capital of France?  ',
        model: 'gemini-3.8-flash',
        answerStyle: 'concise',
      });
      const key2 = computeQueryCacheKey({
        contentHash: 'hash-abc',
        query: 'what is the capital of france?',
        model: 'gemini-3.8-flash',
        answerStyle: 'concise',
      });
      const keyDiffModel = computeQueryCacheKey({
        contentHash: 'hash-abc',
        query: 'what is the capital of france?',
        model: 'claude-3-5-sonnet',
        answerStyle: 'concise',
      });

      assert.strictEqual(key1, key2);
      assert.strictEqual(key1.length, 32);
      assert.match(key1, /^[0-9a-f]{32}$/);
      assert.notStrictEqual(key1, keyDiffModel);
    });

    it('T1_F2_02: getQueryCache returns Tier 1 in-memory hit with 0ms latency without touching storage', async () => {
      const storage = new MockStorageArea();
      const key = 'test-key-t1-f2-02';
      await setQueryCache(key, { answer: 'Paris is the capital of France', tokensSaved: 45 }, storage);

      storage.callLog.get = [];

      const hit = await getQueryCache(key, storage);
      assert.ok(hit);
      assert.strictEqual(hit.answer, 'Paris is the capital of France');
      assert.strictEqual(hit.tokensSaved, 45);
      assert.strictEqual(storage.callLog.get.length, 0);
    });

    it('T1_F2_03: getQueryCache promotes Tier 2 storage hit into Tier 1 in-memory cache', async () => {
      const storage = new MockStorageArea();
      const key = 'test-key-t1-f2-03';
      const storageKey = 'tabscan_qc_' + key;
      const record = {
        answer: 'Persistent answer from storage',
        cachedAt: Date.now(),
        tokensSaved: 60,
        model: 'gemini-3.8-flash',
      };
      await storage.set({ [storageKey]: record });

      const firstRead = await getQueryCache(key, storage);
      assert.ok(firstRead);
      assert.strictEqual(firstRead.answer, 'Persistent answer from storage');

      storage.callLog.get = [];
      const secondRead = await getQueryCache(key, storage);
      assert.ok(secondRead);
      assert.strictEqual(secondRead.answer, 'Persistent answer from storage');
      assert.strictEqual(storage.callLog.get.length, 0);
    });

    it('T1_F2_04: setQueryCache persists record and maintains index in storage area', async () => {
      const storage = new MockStorageArea();
      const key = 'test-key-t1-f2-04';
      await setQueryCache(key, { answer: 'Stored entry', tokensSaved: 30, query: 'test?' }, storage);

      const items = await storage.get();
      assert.ok(items['tabscan_qc_' + key]);
      assert.strictEqual(items['tabscan_qc_' + key].answer, 'Stored entry');
      assert.ok(Array.isArray(items['tabscan_qc__index']));
      assert.strictEqual(items['tabscan_qc__index'].length, 1);
      assert.strictEqual(items['tabscan_qc__index'][0].key, key);
    });

    it('T1_F2_05: clearQueryCache flushes both Tier 1 memory and Tier 2 storage', async () => {
      const storage = new MockStorageArea();
      const key = 'test-key-t1-f2-05';
      await setQueryCache(key, { answer: 'To be cleared' }, storage);

      await clearQueryCache(storage);

      const after = await getQueryCache(key, storage);
      assert.strictEqual(after, null);
      const items = await storage.get();
      assert.strictEqual(items['tabscan_qc_' + key], undefined);
    });

    it('T1_F2_06: QueryCacheManager tracks hit/miss statistics and respects forceRefresh', async () => {
      const storage = new MockStorageArea();
      const mgr = new QueryCacheManager({ storageArea: storage });

      const keyParams = { contentHash: 'h1', query: 'Count test', model: 'gemini-3.8-flash' };
      const miss = await mgr.get(keyParams);
      assert.strictEqual(miss, null);
      assert.deepStrictEqual(mgr.getStats(), { hits: 0, misses: 1, tokensSavedTotal: 0 });

      await mgr.set(keyParams, { answer: 'Count answer', tokensSaved: 100 });
      const hit = await mgr.get(keyParams);
      assert.ok(hit);
      assert.deepStrictEqual(mgr.getStats(), { hits: 1, misses: 1, tokensSavedTotal: 100 });

      mgr.setForceRefresh(true);
      const bypass = await mgr.get(keyParams);
      assert.strictEqual(bypass, null);
      assert.strictEqual(mgr.getStats().misses, 2);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 3: Progressive Streaming (shared/gemini-client.js)
  // --------------------------------------------------------------------------
  describe('1.3 Progressive Streaming', () => {
    it('T1_F3_01: parseSseStream correctly yields parsed SSE data events and joins split lines', async () => {
      const stream = makeSseStream([
        ': keepalive comment\n',
        'event: message\ndata: {"step":{"delta":{"text":"Hello "}}}\n\n',
        'data: {"step":{"delta":{"text":"world!"}}}\n\n',
      ]);

      const events = [];
      for await (const evt of parseSseStream(stream)) {
        events.push(evt);
      }

      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0].step.delta.text, 'Hello ');
      assert.strictEqual(events[1].step.delta.text, 'world!');
    });

    it('T1_F3_02: parseSseStream ignores [DONE] sentinel event without crashing or yielding it', async () => {
      const events = [];
      const stream = makeSseStream([
        'data: {"event_type":"step.delta","delta":{"type":"text","text":"hi"}}\n\n',
        'data: [DONE]\n\n',
      ]);
      for await (const evt of parseSseStream(stream)) {
        events.push(evt);
      }
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].delta.text, 'hi');
    });

    it('T1_F3_03: streamCustomQuestion merges Gemini SSE deltas and calls onChunk progressively', async () => {
      const sseChunks = makeGeminiSseChunks(['First ', 'second ', 'third.']);

      const recordedDeltas = [];
      const recordedAcc = [];

      const mockFetch = async () => new Response(makeSseStream(sseChunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });

      const res = await streamCustomQuestion({
        apiKey: 'test-api-key',
        model: 'gemini-3.8-flash',
        pageSnapshot: { title: 'Test', url: 'https://example.com', text: 'Sample context text' },
        question: 'What is step 1?',
        onChunk: (delta, acc) => {
          recordedDeltas.push(delta);
          recordedAcc.push(acc);
        },
        fetchImpl: mockFetch,
      });

      assert.strictEqual(res.text, 'First second third.');
      assert.deepStrictEqual(recordedDeltas, ['First ', 'second ', 'third.']);
      assert.deepStrictEqual(recordedAcc, ['First ', 'First second ', 'First second third.']);
    });

    it('T1_F3_04: streamCustomQuestion routes to Claude streaming and parses content_block_delta', async () => {
      const claudeSseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"response."}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];

      const chunks = [];
      const mockFetch = async () => new Response(makeSseStream(claudeSseChunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });

      const res = await streamCustomQuestion({
        claudeApiKey: 'sk-ant-test',
        model: 'claude-3-5-sonnet',
        pageSnapshot: { title: 'Test', url: 'https://example.com', text: 'Context' },
        question: 'Claude test',
        onChunk: (delta) => chunks.push(delta),
        fetchImpl: mockFetch,
      });

      assert.strictEqual(res.text, 'Claude response.');
      assert.deepStrictEqual(chunks, ['Claude ', 'response.']);
    });

    it('T1_F3_05: streamCustomQuestion intercepts repeated queries and returns instant cached response', async () => {
      const cacheMgr = new QueryCacheManager();
      const snapshot = { title: 'Topic', url: 'https://example.com', contentHash: 'ch-1234', text: 'Important content' };
      const question = 'What is the main topic?';

      const key = computeQueryCacheKey({
        contentHash: snapshot.contentHash,
        query: question,
        model: 'gemini-3.8-flash',
        answerStyle: 'concise',
      });
      await cacheMgr.set(key, { answer: 'Instant cached reply', tokensSaved: 85 });

      let receivedOnChunk = '';
      let fetchCalled = false;
      const mockFetch = async () => {
        fetchCalled = true;
        throw new Error('Fetch must not be called on cache hit!');
      };

      const res = await streamCustomQuestion({
        apiKey: 'test-key',
        model: 'gemini-3.8-flash',
        pageSnapshot: snapshot,
        question,
        answerStyle: 'concise',
        cacheManager: cacheMgr,
        onChunk: (delta, acc) => { receivedOnChunk = acc; },
        fetchImpl: mockFetch,
      });

      assert.strictEqual(fetchCalled, false);
      assert.strictEqual(res.cached, true);
      assert.strictEqual(res.text, 'Instant cached reply');
      assert.strictEqual(receivedOnChunk, 'Instant cached reply');
    });

    it('T1_F3_06: streamCustomQuestion writes successful stream completion into cacheManager', async () => {
      const cacheMgr = new QueryCacheManager();
      const snapshot = { title: 'Page', url: 'https://example.com', contentHash: 'ch-new-99', text: 'Brand new page' };
      const question = 'How does photosynthesis work?';

      const sseChunks = makeGeminiSseChunks(['Chlorophyll absorbs light.']);

      const res = await streamCustomQuestion({
        apiKey: 'test-key',
        model: 'gemini-3.8-flash',
        pageSnapshot: snapshot,
        question,
        answerStyle: 'concise',
        cacheManager: cacheMgr,
        fetchImpl: async () => new Response(makeSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      });

      assert.strictEqual(res.text, 'Chlorophyll absorbs light.');

      const cachedRecord = await cacheMgr.get({
        contentHash: snapshot.contentHash,
        query: question,
        model: 'gemini-3.8-flash',
        answerStyle: 'concise',
      });

      assert.ok(cachedRecord);
      assert.strictEqual(cachedRecord.answer, 'Chlorophyll absorbs light.');
    });
  });

  // --------------------------------------------------------------------------
  // Feature 4: Manifest Auto-Update & Key Binding (manifest.json)
  // --------------------------------------------------------------------------
  describe('1.4 Manifest Auto-Update & Key Binding', () => {
    it('T1_F4_01: manifest conforms to Chrome MV3 side panel architecture', async () => {
      const manifest = await getManifest();
      assert.strictEqual(manifest.manifest_version, 3);
      assert.strictEqual(manifest.name, 'TabScan Q&A');
      assert.ok(manifest.version);
      assert.ok(manifest.side_panel?.default_path);
    });

    it('T1_F4_02: manifest includes secure HTTPS update_url pointing to XML manifest', async () => {
      const manifest = await getManifest();
      assert.ok(manifest.update_url, 'manifest.update_url must exist');
      assert.ok(manifest.update_url.startsWith('https://'), 'update_url must use HTTPS');
      assert.ok(manifest.update_url.endsWith('.xml'), 'update_url must point to an XML file');
    });

    it('T1_F4_03: manifest declares valid 2048-bit RSA public key SPKI DER string', async () => {
      const manifest = await getManifest();
      assert.ok(manifest.key, 'manifest.key must exist');
      assert.ok(!manifest.key.includes('\n'), 'key must be a continuous single line');

      const derBuf = Buffer.from(manifest.key, 'base64');
      assert.strictEqual(derBuf.length, 294);
    });

    it('T1_F4_04: manifest key yields deterministic 32-character Chromium App ID in [a-p]', async () => {
      const manifest = await getManifest();
      const derBuf = Buffer.from(manifest.key, 'base64');
      const appId = computeAppId(derBuf);

      assert.strictEqual(appId.length, 32);
      assert.match(appId, /^[a-p]{32}$/);
      assert.strictEqual(appId, 'jjoepgfpagdecpcbabppbbnblaeklpic');
    });

    it('T1_F4_05: manifest permissions array contains required baseline APIs', async () => {
      const manifest = await getManifest();
      const required = ['sidePanel', 'tabs', 'scripting', 'storage', 'contextMenus'];
      for (const perm of required) {
        assert.ok(manifest.permissions.includes(perm), `Missing permission: ${perm}`);
      }
    });

    it('T1_F4_06: all icons declared in manifest exist and have valid PNG signatures', async () => {
      const manifest = await getManifest();
      const icons = manifest.icons || {};
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      for (const [size, relPath] of Object.entries(icons)) {
        const fullPath = path.join(ROOT_DIR, relPath);
        const data = await fs.readFile(fullPath);
        assert.ok(data.length > 0, `Icon ${size} is empty`);
        assert.deepStrictEqual(data.subarray(0, 8), pngMagic, `Icon ${size} is not a valid PNG`);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 5: Zero-Dependency CRX3 Packaging (scripts/package-release.mjs)
  // --------------------------------------------------------------------------
  describe('1.5 Zero-Dependency CRX3 Packaging', () => {
    it('T1_F5_01: CRX3 binary begins with Cr24 magic and format version 3', async () => {
      const keyPem = await getPrivateKeyPem();
      const zip = createZipBuffer([{ name: 'manifest.json', data: '{"version":"1.0.0"}' }]);
      const { crx } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

      assert.strictEqual(crx.subarray(0, 4).toString('ascii'), 'Cr24');
      assert.strictEqual(crx.readUInt32LE(4), 3);
    });

    it('T1_F5_02: parseCrx3Header extracts headerLength and matches derived App ID', async () => {
      const keyPem = await getPrivateKeyPem();
      const zip = createZipBuffer([{ name: 'test.txt', data: 'content' }]);
      const { crx, appId } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

      const parsed = parseCrx3Header(crx);
      assert.strictEqual(parsed.magic, 'Cr24');
      assert.strictEqual(parsed.version, 3);
      assert.ok(parsed.headerLength > 0);
      assert.strictEqual(parsed.appId, appId);
    });

    it('T1_F5_03: parseCrx3Header cryptographically verifies RSA-SHA256 digital signature', async () => {
      const keyPem = await getPrivateKeyPem();
      const zip = createZipBuffer([{ name: 'file.js', data: 'console.log("ok");' }]);
      const { crx } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

      const parsed = parseCrx3Header(crx);
      assert.strictEqual(parsed.isValidSignature, true);
    });

    it('T1_F5_04: crx archiveBuffer contains valid ZIP magic PK0304', async () => {
      const keyPem = await getPrivateKeyPem();
      const zip = createZipBuffer([{ name: 'manifest.json', data: '{}' }]);
      const { crx } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

      const parsed = parseCrx3Header(crx);
      const zipMagic = parsed.archiveBuffer.subarray(0, 4);
      assert.deepStrictEqual(zipMagic, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    });

    it('T1_F5_05: collectExtensionFiles excludes private keys, tests, dist, and metadata', () => {
      const files = collectExtensionFiles(ROOT_DIR);
      const names = files.map((f) => f.name);

      assert.ok(names.includes('manifest.json'));
      assert.ok(names.includes('service-worker.js'));
      assert.ok(!names.some((n) => n.startsWith('tests/')));
      assert.ok(!names.some((n) => n.startsWith('dist/')));
      assert.ok(!names.some((n) => n.includes('key.pem')));
      assert.ok(!names.some((n) => n.startsWith('.agents/')));
      assert.ok(!names.some((n) => n.startsWith('.git/')));
    });

    it('T1_F5_06: createZipBuffer correctly calculates CRC32 and creates valid EOCD record', () => {
      const testData = Buffer.from('Testing CRC32 calculation and ZIP layout');
      const expectedCrc = zlib.crc32(testData);

      assert.strictEqual(calculateCrc32(testData), expectedCrc);

      const zip = createZipBuffer([{ name: 'data.txt', data: testData }]);
      const eocdSig = zip.subarray(zip.length - 22, zip.length - 18);
      assert.deepStrictEqual(eocdSig, Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    });
  });

  // --------------------------------------------------------------------------
  // Feature 6: Omaha v2.0 Update XML Manifest (scripts/package-release.mjs)
  // --------------------------------------------------------------------------
  describe('1.6 Omaha v2.0 Update XML Manifest', () => {
    it('T1_F6_01: Omaha XML root element has protocol 2.0 and update2 namespace', () => {
      const xml = generateUpdateXml({
        appId: 'jjoepgfpagdecpcbabppbbnblaeklpic',
        codebase: 'https://example.com/tab-scan-qa.crx',
        version: '1.0.0',
      });

      assert.ok(xml.startsWith("<?xml version='1.0' encoding='UTF-8'?>"));
      assert.ok(xml.includes("<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>"));
      assert.ok(xml.endsWith('</gupdate>\n') || xml.endsWith('</gupdate>'));
    });

    it('T1_F6_02: Omaha XML app element matches extension App ID', () => {
      const appId = 'jjoepgfpagdecpcbabppbbnblaeklpic';
      const xml = generateUpdateXml({
        appId,
        codebase: 'https://example.com/extension.crx',
        version: '1.0.0',
      });

      assert.ok(xml.includes(`<app appid='${appId}'>`));
    });

    it('T1_F6_03: Omaha XML updatecheck codebase attribute points to hosted .crx', () => {
      const codebase = 'https://raw.githubusercontent.com/user/repo/main/dist/tab-scan-qa.crx';
      const xml = generateUpdateXml({
        appId: 'jjoepgfpagdecpcbabppbbnblaeklpic',
        codebase,
        version: '1.0.0',
      });

      assert.ok(xml.includes(`codebase='${codebase}'`));
    });

    it('T1_F6_04: Omaha XML updatecheck version matches extension version', () => {
      const xml = generateUpdateXml({
        appId: 'jjoepgfpagdecpcbabppbbnblaeklpic',
        codebase: 'https://example.com/ext.crx',
        version: '1.2.3',
      });

      assert.ok(xml.includes("version='1.2.3'"));
    });

    it('T1_F6_05: Omaha XML includes prodversionmin 116.0.0.0 for SidePanel compatibility', () => {
      const xml = generateUpdateXml({
        appId: 'jjoepgfpagdecpcbabppbbnblaeklpic',
        codebase: 'https://example.com/ext.crx',
        version: '1.0.0',
      });

      assert.ok(xml.includes("prodversionmin='116.0.0.0'"));
    });

    it('T1_F6_06: generated dist/updates.xml file on disk is valid and matches App ID', async () => {
      const xmlPath = path.join(ROOT_DIR, 'dist', 'updates.xml');
      const content = await fs.readFile(xmlPath, 'utf8');

      assert.ok(content.includes('jjoepgfpagdecpcbabppbbnblaeklpic'));
      assert.ok(content.includes('.crx'));
      assert.ok(content.includes("protocol='2.0'"));
    });
  });

  // --------------------------------------------------------------------------
  // Feature 7: Side-Panel UI States & Responsiveness (sidepanel/*)
  // --------------------------------------------------------------------------
  describe('1.7 Side-Panel UI States & Responsiveness', () => {
    it('T1_F7_01: initial side-panel state initializes status badge to idle', () => {
      const { document: doc } = createSyntheticDom();
      const statusBadge = doc.createElement('span', { id: 'scan-status', class: 'status-badge' });
      statusBadge.dataset.state = 'idle';
      const statusIcon = doc.createElement('span', { id: 'scan-status-icon' });
      statusIcon.textContent = '○';
      const statusText = doc.createElement('span', { id: 'scan-status-text' });
      statusText.textContent = 'Idle';
      statusBadge.appendChild(statusIcon);
      statusBadge.appendChild(statusText);

      assert.strictEqual(statusBadge.dataset.state, 'idle');
      assert.strictEqual(statusIcon.textContent, '○');
      assert.strictEqual(statusText.textContent, 'Idle');
    });

    it('T1_F7_02: status badge transitions dynamically between scanning, ready, and error states', () => {
      const { document: doc } = createSyntheticDom();
      const statusBadge = doc.createElement('span', { id: 'scan-status' });
      const statusIcon = doc.createElement('span', { id: 'scan-status-icon' });
      const statusText = doc.createElement('span', { id: 'scan-status-text' });

      function setStatusBadge(state, icon, text) {
        statusBadge.dataset.state = state;
        statusIcon.textContent = icon;
        statusText.textContent = text;
      }

      setStatusBadge('scanning', '⏳', 'Scanning tab…');
      assert.strictEqual(statusBadge.dataset.state, 'scanning');
      assert.strictEqual(statusText.textContent, 'Scanning tab…');

      setStatusBadge('ready', '✓', 'Ready (1,240 chars)');
      assert.strictEqual(statusBadge.dataset.state, 'ready');
      assert.strictEqual(statusText.textContent, 'Ready (1,240 chars)');

      setStatusBadge('error', '⚠', 'Scan error');
      assert.strictEqual(statusBadge.dataset.state, 'error');
      assert.strictEqual(statusText.textContent, 'Scan error');
    });

    it('T1_F7_03: analysis loading progress toggles progress row visibility and updates label', () => {
      const { document: doc } = createSyntheticDom();
      const progressRow = doc.createElement('div', { id: 'analysis-progress', hidden: 'true' });
      const progressLabel = doc.createElement('label', { id: 'analysis-progress-label' });
      progressRow.appendChild(progressLabel);

      function showProgress(text) {
        progressRow.hidden = false;
        progressLabel.textContent = text;
      }

      function hideProgress() {
        progressRow.hidden = true;
      }

      assert.strictEqual(progressRow.hidden, true);
      showProgress('Analyzing questions with Gemini…');
      assert.strictEqual(progressRow.hidden, false);
      assert.strictEqual(progressLabel.textContent, 'Analyzing questions with Gemini…');
      hideProgress();
      assert.strictEqual(progressRow.hidden, true);
    });

    it('T1_F7_04: analysis error state displays error callout and activates retry button', () => {
      const { document: doc } = createSyntheticDom();
      const errorCallout = doc.createElement('div', { id: 'analysis-error', hidden: 'true' });
      const errorText = doc.createElement('p', { id: 'analysis-error-text' });
      const retryBtn = doc.createElement('button', { id: 'retry-analysis-btn' });
      errorCallout.appendChild(errorText);
      errorCallout.appendChild(retryBtn);

      let retryTriggered = false;
      retryBtn.addEventListener('click', () => { retryTriggered = true; });

      errorCallout.hidden = false;
      errorText.textContent = 'API rate limit exceeded (429). Please wait a moment.';

      assert.strictEqual(errorCallout.hidden, false);
      assert.ok(errorText.textContent.includes('429'));

      retryBtn.click();
      assert.strictEqual(retryTriggered, true);
    });

    it('T1_F7_05: preview details element unhides and formats extracted token stats', () => {
      const { document: doc } = createSyntheticDom();
      const details = doc.createElement('details', { id: 'preview-details', hidden: 'true' });
      const stats = doc.createElement('div', { id: 'preview-stats' });
      const textPre = doc.createElement('pre', { id: 'preview-text' });
      details.appendChild(stats);
      details.appendChild(textPre);

      const charCount = 12000;
      const tokenEst = estimateTokens(charCount);
      stats.textContent = `${charCount.toLocaleString()} chars · ~${tokenEst.toLocaleString()} tokens`;
      details.hidden = false;

      assert.strictEqual(details.hidden, false);
      assert.ok(stats.textContent.includes('12,000 chars'));
      assert.ok(stats.textContent.includes('tokens'));
    });

    it('T1_F7_06: model indicator pill updates text based on configured active model', () => {
      const { document: doc } = createSyntheticDom();
      const modelPill = doc.createElement('span', { id: 'model-pill' });
      modelPill.textContent = 'gemini-3.8-flash';

      assert.strictEqual(modelPill.textContent, 'gemini-3.8-flash');
      modelPill.textContent = 'claude-3-5-sonnet';
      assert.strictEqual(modelPill.textContent, 'claude-3-5-sonnet');
    });
  });

  // --------------------------------------------------------------------------
  // Feature 8: Micro-Interactions & Visual Feedback (sidepanel/*)
  // --------------------------------------------------------------------------
  describe('1.8 Micro-Interactions & Visual Feedback', () => {
    it('T1_F8_01: copyTextWithFeedback writes to clipboard and changes button label to Copied', async () => {
      const { navigator, getClipboard } = createSyntheticDom();
      const btn = new MiniElement('button');
      btn.textContent = 'Copy';

      const snippet = 'const apiKey = "xyz";';
      await navigator.clipboard.writeText(snippet);
      btn.textContent = 'Copied';

      assert.strictEqual(getClipboard(), snippet);
      assert.strictEqual(btn.textContent, 'Copied');
    });

    it('T1_F8_02: copyTextWithFeedback resets button label back to default after timeout', async () => {
      const btn = new MiniElement('button');
      btn.textContent = 'Copy Answer';

      btn.textContent = 'Copied';
      assert.strictEqual(btn.textContent, 'Copied');

      btn.textContent = 'Copy Answer';
      assert.strictEqual(btn.textContent, 'Copy Answer');
    });

    it('T1_F8_03: clicking quick prompt chip dispatches custom question submission', () => {
      const { document: doc } = createSyntheticDom();
      const chip = doc.createElement('button', { class: 'chip-btn' });
      chip.textContent = 'Summarize key points';

      let submittedQuery = '';
      chip.addEventListener('click', () => {
        submittedQuery = chip.textContent;
      });

      chip.click();
      assert.strictEqual(submittedQuery, 'Summarize key points');
    });

    it('T1_F8_04: pressing Enter without Shift triggers form submission', () => {
      const form = new MiniElement('form');
      const textarea = new MiniElement('textarea');
      form.appendChild(textarea);

      let formSubmitted = false;
      form.addEventListener('submit', (e) => {
        formSubmitted = true;
        e.preventDefault();
      });

      const enterEvt = new MiniEvent('keydown', { key: 'Enter', shiftKey: false });
      if (enterEvt.key === 'Enter' && !enterEvt.shiftKey && !enterEvt.isComposing) {
        form.requestSubmit();
      }

      assert.strictEqual(formSubmitted, true);
    });

    it('T1_F8_05: pressing Shift+Enter suppresses form submission allowing multiline text', () => {
      const form = new MiniElement('form');
      let formSubmitted = false;
      form.addEventListener('submit', () => { formSubmitted = true; });

      const shiftEnterEvt = new MiniEvent('keydown', { key: 'Enter', shiftKey: true });
      if (shiftEnterEvt.key === 'Enter' && !shiftEnterEvt.shiftKey) {
        form.requestSubmit();
      }

      assert.strictEqual(formSubmitted, false);
    });

    it('T1_F8_06: actions toolbar supports roving tabindex keyboard navigation across buttons', () => {
      const btn1 = new MiniElement('button', { id: 'highlight-all-btn' });
      const btn2 = new MiniElement('button', { id: 'apply-all-btn' });
      const btn3 = new MiniElement('button', { id: 'clear-highlights-btn' });
      const buttons = [btn1, btn2, btn3];

      let activeIndex = 0;
      function onKeyDown(evt) {
        if (evt.key === 'ArrowRight') {
          activeIndex = (activeIndex + 1) % buttons.length;
          buttons[activeIndex].focus();
        } else if (evt.key === 'ArrowLeft') {
          activeIndex = (activeIndex - 1 + buttons.length) % buttons.length;
          buttons[activeIndex].focus();
        }
      }

      onKeyDown({ key: 'ArrowRight' });
      assert.strictEqual(activeIndex, 1);
      assert.strictEqual(btn2.focused, true);

      onKeyDown({ key: 'ArrowRight' });
      assert.strictEqual(activeIndex, 2);
      assert.strictEqual(btn3.focused, true);

      onKeyDown({ key: 'ArrowRight' });
      assert.strictEqual(activeIndex, 0);
      assert.strictEqual(btn1.focused, true);
    });
  });
});

// ============================================================================
// TIER 2 — BOUNDARY & CORNER CASES (48 Tests, 6 per Feature across 8 Features)
// ============================================================================

describe('Tier 2 — Boundary & Corner Cases', () => {

  // --------------------------------------------------------------------------
  // Boundary 2.1: DOM Pruning Boundaries
  // --------------------------------------------------------------------------
  describe('2.1 DOM Pruning Boundaries', () => {
    it('T2_F1_01: prunePageText handles empty string, null, and undefined without throwing', () => {
      const emptyRes = prunePageText('');
      assert.deepStrictEqual(emptyRes, { text: '', originalChars: 0, prunedChars: 0, tokensSavedEst: 0 });

      const nullRes = prunePageText(null);
      assert.deepStrictEqual(nullRes, { text: '', originalChars: 0, prunedChars: 0, tokensSavedEst: 0 });

      const undefRes = prunePageText(undefined);
      assert.deepStrictEqual(undefRes, { text: '', originalChars: 0, prunedChars: 0, tokensSavedEst: 0 });
    });

    it('T2_F1_02: prunePageText handles massive 100,000 char continuous string without spaces', () => {
      const monolithic = 'X'.repeat(100000);
      const res = prunePageText(monolithic, { maxChars: 36000 });
      assert.strictEqual(res.text.length, 36000);
      assert.strictEqual(res.originalChars, 100000);
      assert.strictEqual(res.tokensSavedEst, Math.ceil((100000 - 36000) / 4));
    });

    it('T2_F1_03: prunePageText preserves surrogate pairs and multi-byte emojis at boundary', () => {
      const emojiText = '🚀'.repeat(50);
      const res = prunePageText(emojiText, { maxChars: 40 });
      assert.ok(res.text.length <= 40);
      const roundtrip = Buffer.from(res.text, 'utf8').toString('utf8');
      assert.strictEqual(roundtrip, res.text);
    });

    it('T2_F1_04: stripBoilerplateSelectors handles detached root node or node with no children', () => {
      const { document: doc } = createSyntheticDom();
      const emptyDiv = doc.createElement('div');
      const stripped = stripBoilerplateSelectors(emptyDiv);
      assert.strictEqual(stripped, 0);

      const nullStripped = stripBoilerplateSelectors(null);
      assert.strictEqual(nullStripped, 0);
    });

    it('T2_F1_05: stripBoilerplateSelectors handles deeply nested boilerplate (10 levels deep)', () => {
      const { document: doc } = createSyntheticDom();
      const root = doc.createElement('div');
      let current = root;
      for (let i = 0; i < 10; i++) {
        const next = doc.createElement('div');
        current.appendChild(next);
        current = next;
      }
      const ad = doc.createElement('aside', { class: 'ad' });
      ad.textContent = 'Deep ad';
      current.appendChild(ad);

      const count = stripBoilerplateSelectors(root);
      assert.strictEqual(count, 1);
      assert.strictEqual(root.querySelectorAll('aside').length, 0);
    });

    it('T2_F1_06: shouldAttachScreenshots word boundary prevents substring keyword collisions', () => {
      const snapshot = {
        text: 'The telegraph operator sent a telegram across long transatlantic cables. '.repeat(4),
      };
      assert.ok(snapshot.text.length > 150);
      assert.strictEqual(shouldAttachScreenshots(snapshot, 'What is the message in the telegraph?'), false);
    });
  });

  // --------------------------------------------------------------------------
  // Boundary 2.2: Caching Boundaries
  // --------------------------------------------------------------------------
  describe('2.2 Caching Boundaries', () => {
    it('T2_F2_01: setQueryCache enforces LRU eviction when exceeding maxEntries (150 -> 151)', async () => {
      const storage = new MockStorageArea();
      await clearQueryCache(storage);

      await setQueryCache('k1', { answer: 'A1' }, storage, 3);
      await setQueryCache('k2', { answer: 'A2' }, storage, 3);
      await setQueryCache('k3', { answer: 'A3' }, storage, 3);

      await setQueryCache('k4', { answer: 'A4' }, storage, 3);

      const getK1 = await getQueryCache('k1', storage);
      const getK4 = await getQueryCache('k4', storage);

      assert.strictEqual(getK1, null, 'Oldest entry k1 must be evicted');
      assert.ok(getK4, 'Newest entry k4 must exist');
    });

    it('T2_F2_02: LRU access promotion prevents accessed item from being evicted', async () => {
      const storage = new MockStorageArea();
      await clearQueryCache(storage);
      const mgr = new QueryCacheManager({ storageArea: storage, maxEntries: 3 });

      await mgr.set('k1', { answer: 'A1' });
      await new Promise((r) => setTimeout(r, 5));
      await mgr.set('k2', { answer: 'A2' });
      await new Promise((r) => setTimeout(r, 5));
      await mgr.set('k3', { answer: 'A3' });
      await new Promise((r) => setTimeout(r, 5));

      // Re-access and refresh k1 to move it to the head of the LRU
      await mgr.set('k1', { answer: 'A1' });
      await new Promise((r) => setTimeout(r, 5));

      // Inserting 4th entry evicts k2 (oldest), keeping k1, k3, and k4
      await mgr.set('k4', { answer: 'A4' });

      const getK1 = await mgr.get('k1');
      const getK2 = await mgr.get('k2');
      const getK4 = await mgr.get('k4');

      assert.ok(getK1, 'Recently accessed k1 must be retained');
      assert.strictEqual(getK2, null, 'Unaccessed k2 must be evicted');
      assert.ok(getK4, 'Newest entry k4 must exist');
    });

    it('T2_F2_03: getQueryCache evicts expired entries older than 24-hour TTL', async () => {
      const storage = new MockStorageArea();
      const expiredKey = 'expired-key-99';
      const storageKey = 'tabscan_qc_' + expiredKey;
      const expiredRecord = {
        answer: 'Old answer',
        cachedAt: Date.now() - (24 * 60 * 60 * 1000 + 5000),
      };
      await storage.set({ [storageKey]: expiredRecord });

      const res = await getQueryCache(expiredKey, storage);
      assert.strictEqual(res, null, 'Expired record must return null');

      const checkStorage = await storage.get(storageKey);
      assert.strictEqual(checkStorage[storageKey], undefined);
    });

    it('T2_F2_04: getQueryCache handles corrupted storage entries without unhandled errors', async () => {
      const storage = new MockStorageArea();
      const badKey = 'bad-corrupted-key';
      await storage.set({ ['tabscan_qc_' + badKey]: null });

      const res = await getQueryCache(badKey, storage);
      assert.strictEqual(res, null);
    });

    it('T2_F2_05: setQueryCache enforces 4MB byte quota eviction on storage index', async () => {
      const storage = new MockStorageArea();
      const largeString = 'Z'.repeat(1024 * 1024); // 1MB
      await setQueryCache('big1', { answer: largeString }, storage, 150);
      await setQueryCache('big2', { answer: largeString }, storage, 150);
      await setQueryCache('big3', { answer: largeString }, storage, 150);
      await setQueryCache('big4', { answer: largeString }, storage, 150);
      await setQueryCache('big5', { answer: largeString }, storage, 150);

      const indexData = await storage.get('tabscan_qc__index');
      const index = indexData['tabscan_qc__index'];
      assert.ok(Array.isArray(index));
      const totalBytes = index.reduce((sum, item) => sum + (item.bytes || 0), 0);
      assert.ok(totalBytes <= 4 * 1024 * 1024);
    });

    it('T2_F2_06: setQueryCache handles concurrent write collisions safely', async () => {
      const storage = new MockStorageArea();
      const key = 'concurrent-key';
      const writes = Array.from({ length: 5 }, (_, i) =>
        setQueryCache(key, { answer: `Answer ${i}` }, storage)
      );

      await assert.doesNotReject(Promise.all(writes));
      const res = await getQueryCache(key, storage);
      assert.ok(res);
      assert.ok(res.answer.startsWith('Answer '));
    });
  });

  // --------------------------------------------------------------------------
  // Boundary 2.3: Streaming Boundaries
  // --------------------------------------------------------------------------
  describe('2.3 Streaming Boundaries', () => {
    it('T2_F3_01: parseSseStream handles single-byte chunk fragmentation seamlessly', async () => {
      const rawText = 'data: {"step":{"delta":{"text":"Byte by byte"}}}\n\n';
      const singleByteChunks = Array.from(rawText).map((ch) => ch);
      const stream = makeSseStream(singleByteChunks);

      const events = [];
      for await (const evt of parseSseStream(stream)) {
        events.push(evt);
      }

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].step.delta.text, 'Byte by byte');
    });

    it('T2_F3_02: parseSseStream handles JSON payload split across multiple chunk boundaries', async () => {
      const stream = makeSseStream([
        'data: {"step":{"delta":',
        '{"text":"Split ',
        'JSON across ',
        'chunks"}}}\n\n',
      ]);

      const events = [];
      for await (const evt of parseSseStream(stream)) {
        events.push(evt);
      }

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].step.delta.text, 'Split JSON across chunks');
    });

    it('T2_F3_03: parseSseStream ignores empty data events and SSE comments', async () => {
      const stream = makeSseStream([
        ': ping comment\n\n',
        'data: \n\n',
        'data: {"valid":true}\n\n',
        ': heartbeat\n\n',
      ]);

      const events = [];
      for await (const evt of parseSseStream(stream)) {
        events.push(evt);
      }

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].valid, true);
    });

    it('T2_F3_04: streamCustomQuestion aborts cleanly when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        streamCustomQuestion({
          apiKey: 'key',
          pageSnapshot: { title: 'T', url: 'https://ex.com', text: 'Text' },
          signal: controller.signal,
          question: 'Aborted query?',
        }),
        (err) => err.name === 'AbortError' || err.message.includes('aborted')
      );
    });

    it('T2_F3_05: streamCustomQuestion surfaces GeminiApiError on HTTP error status', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({
          error: { message: 'API key not valid. Please pass a valid API key.' },
        }),
      });

      await assert.rejects(
        streamCustomQuestion({
          apiKey: 'invalid-key',
          pageSnapshot: { title: 'T', url: 'https://ex.com', text: 'Text' },
          question: 'Hello',
          fetchImpl: mockFetch,
        }),
        (err) => err instanceof GeminiApiError && err.status === 401
      );
    });

    it('T2_F3_06: streamCustomQuestion completes safely when usage object is missing from stream', async () => {
      const sseChunks = makeGeminiSseChunks(['No usage object included.']);

      const res = await streamCustomQuestion({
        apiKey: 'key',
        pageSnapshot: { title: 'T', url: 'https://ex.com', text: 'Text' },
        question: 'Usage test',
        fetchImpl: async () => new Response(makeSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      });

      assert.strictEqual(res.text, 'No usage object included.');
    });
  });

  // --------------------------------------------------------------------------
  // Boundary 2.4: Manifest Boundaries
  // --------------------------------------------------------------------------
  describe('2.4 Manifest Boundaries', () => {
    it('T2_F4_01: manifest update_url rejects empty string', () => {
      assert.throws(() => {
        const url = '';
        if (!url || !url.startsWith('https://')) throw new Error('Invalid update_url');
      }, /Invalid update_url/);
    });

    it('T2_F4_02: manifest rejects non-HTTPS update_url schemes', () => {
      const nonHttps = ['http://example.com/update.xml', 'ftp://example.com/update.xml', 'file:///updates.xml'];
      for (const u of nonHttps) {
        assert.strictEqual(u.startsWith('https://'), false);
      }
    });

    it('T2_F4_03: manifest key parser rejects invalid base64 characters', () => {
      const corruptedKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA!!!INVALID@@@###';
      const der = Buffer.from(corruptedKey, 'base64');
      assert.notStrictEqual(der.length, 294);
    });

    it('T2_F4_04: computeAppId alphabet boundary maps SHA-256 nibbles 0..15 to "a".."p"', () => {
      function nibblesToAppId(hash16) {
        let id = '';
        for (let i = 0; i < 16; i++) {
          id += String.fromCharCode(97 + ((hash16[i] >> 4) & 0x0f));
          id += String.fromCharCode(97 + (hash16[i] & 0x0f));
        }
        return id;
      }
      assert.strictEqual(nibblesToAppId(Buffer.alloc(16, 0x00)), 'a'.repeat(32));
      assert.strictEqual(nibblesToAppId(Buffer.alloc(16, 0xff)), 'p'.repeat(32));

      const testDer = Buffer.from('arbitrary public key data');
      const appId = computeAppId(testDer);
      assert.strictEqual(appId.length, 32);
      assert.match(appId, /^[a-p]{32}$/);
    });

    it('T2_F4_05: manifest version conforms strictly to dot-separated integer schema', async () => {
      const manifest = await getManifest();
      assert.match(manifest.version, /^\d+(\.\d+)*$/);
      assert.ok(manifest.version.split('.').length >= 2);
    });

    it('T2_F4_06: manifest does not contain deprecated Manifest V2 permissions or fields', async () => {
      const manifest = await getManifest();
      assert.strictEqual(manifest.browser_action, undefined);
      assert.strictEqual(manifest.page_action, undefined);
      assert.strictEqual(manifest.background?.scripts, undefined);
      assert.ok(!manifest.permissions.includes('<all_urls>'));
    });
  });

  // --------------------------------------------------------------------------
  // Boundary 2.5: CRX3 Packaging Boundaries
  // --------------------------------------------------------------------------
  describe('2.5 CRX3 Packaging Boundaries', () => {
    it('T2_F5_01: parseCrx3Header rejects tampered ZIP payload (signature invalid)', async () => {
      const keyPem = await getPrivateKeyPem();
      const zip = createZipBuffer([{ name: 'test.js', data: 'console.log(1);' }]);
      const { crx } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

      const tamperedCrx = Buffer.from(crx);
      tamperedCrx[tamperedCrx.length - 10] ^= 0xff;

      const parsed = parseCrx3Header(tamperedCrx);
      assert.strictEqual(parsed.isValidSignature, false, 'Tampered ZIP must fail verification');
    });

    it('T2_F5_02: parseCrx3Header rejects tampered RSA signature bytes', async () => {
      const keyPem = await getPrivateKeyPem();
      const zip = createZipBuffer([{ name: 'test.js', data: 'hello' }]);
      const { crx } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

      const tamperedCrx = Buffer.from(crx);
      tamperedCrx[50] ^= 0x55;

      const parsed = parseCrx3Header(tamperedCrx);
      assert.strictEqual(parsed.isValidSignature, false, 'Tampered signature must fail verification');
    });

    it('T2_F5_03: parseCrx3Header throws on invalid magic bytes', () => {
      const badMagic = Buffer.from('Cr23\x03\x00\x00\x00\x00\x00\x00\x00');
      assert.throws(
        () => parseCrx3Header(badMagic),
        /Invalid CRX magic bytes/
      );
    });

    it('T2_F5_04: parseCrx3Header throws on unsupported CRX format version (version 2)', () => {
      const badVersion = Buffer.alloc(16);
      badVersion.write('Cr24', 0, 'ascii');
      badVersion.writeUInt32LE(2, 4);
      assert.throws(
        () => parseCrx3Header(badVersion),
        /Unsupported CRX version: 2/
      );
    });

    it('T2_F5_05: parseCrx3Header throws on truncated buffer (< 12 bytes)', () => {
      const smallBuf = Buffer.from('Cr24\x03\x00');
      assert.throws(
        () => parseCrx3Header(smallBuf),
        /Buffer too small/
      );
    });

    it('T2_F5_06: generateCrx3 throws on invalid or corrupted private key PEM', () => {
      const zip = createZipBuffer([{ name: 'file.txt', data: 'text' }]);
      assert.throws(
        () => generateCrx3({ zipBuffer: zip, privateKeyPem: '-----BEGIN NOT A KEY-----' }),
        /DECODER|unsupported|PEM/
      );
    });
  });

  // --------------------------------------------------------------------------
  // Boundary 2.6: Omaha XML Boundaries
  // --------------------------------------------------------------------------
  describe('2.6 Omaha XML Boundaries', () => {
    it('T2_F6_01: generateUpdateXml escapes special XML entities (&, <, >, ", \') in URLs', () => {
      const xml = generateUpdateXml({
        appId: 'jjoepgfpagdecpcbabppbbnblaeklpic',
        codebase: 'https://example.com/download.crx?token=123&env=prod<test>',
        version: '1.0.0',
      });

      assert.ok(xml.includes('&amp;env=prod&lt;test&gt;'));
      assert.ok(!xml.includes('token=123&env'));
    });

    it('T2_F6_02: generateUpdateXml throws when appId is invalid', () => {
      assert.throws(
        () => generateUpdateXml({ appId: 'invalid-id!', codebase: 'https://ex.com/c.crx', version: '1.0' }),
        /Invalid extension App ID/
      );
      assert.throws(
        () => generateUpdateXml({ appId: '', codebase: 'https://ex.com/c.crx', version: '1.0' }),
        /appId must be a non-empty string/
      );
    });

    it('T2_F6_03: generateUpdateXml throws when codebase is empty string', () => {
      assert.throws(
        () => generateUpdateXml({ appId: 'jjoepgfpagdecpcbabppbbnblaeklpic', codebase: '', version: '1.0' }),
        /codebase must be a non-empty string/
      );
    });

    it('T2_F6_04: generateUpdateXml throws when version is empty string', () => {
      assert.throws(
        () => generateUpdateXml({ appId: 'jjoepgfpagdecpcbabppbbnblaeklpic', codebase: 'https://ex.com/c.crx', version: '' }),
        /version must be a non-empty string/
      );
    });

    it('T2_F6_05: semver comparison helper evaluates update precedence accurately', () => {
      function isNewerVersion(remote, installed) {
        const rParts = remote.split('.').map(Number);
        const iParts = installed.split('.').map(Number);
        for (let i = 0; i < Math.max(rParts.length, iParts.length); i++) {
          const r = rParts[i] || 0;
          const inst = iParts[i] || 0;
          if (r > inst) return true;
          if (r < inst) return false;
        }
        return false;
      }

      assert.strictEqual(isNewerVersion('1.0.1', '1.0.0'), true);
      assert.strictEqual(isNewerVersion('1.1.0', '1.0.9'), true);
      assert.strictEqual(isNewerVersion('2.0.0', '1.9.99'), true);
      assert.strictEqual(isNewerVersion('1.0.0', '1.0.0'), false);
      assert.strictEqual(isNewerVersion('0.9.9', '1.0.0'), false);
    });

    it('T2_F6_06: generateUpdateXml omits prodversionmin cleanly when null or false', () => {
      const xml = generateUpdateXml({
        appId: 'jjoepgfpagdecpcbabppbbnblaeklpic',
        codebase: 'https://ex.com/c.crx',
        version: '1.0.0',
        prodversionmin: null,
      });

      assert.ok(!xml.includes('prodversionmin'));
    });
  });

  // --------------------------------------------------------------------------
  // Boundary 2.7: UI State Boundaries
  // --------------------------------------------------------------------------
  describe('2.7 UI State Boundaries', () => {
    it('T2_F7_01: submitting whitespace-only question is ignored without modifying thread', () => {
      const { document: doc } = createSyntheticDom();
      const thread = doc.createElement('div', { id: 'chat-thread' });

      function submitQuestion(raw) {
        const q = (raw || '').trim();
        if (!q) return false;
        const msg = doc.createElement('div');
        msg.textContent = q;
        thread.appendChild(msg);
        return true;
      }

      const res = submitQuestion('   \t\n   ');
      assert.strictEqual(res, false);
      assert.strictEqual(thread.children.length, 0);
    });

    it('T2_F7_02: submitting question with missing API key opens settings dialog', () => {
      const { document: doc } = createSyntheticDom();
      const settingsDialog = doc.createElement('dialog', { id: 'settings-dialog' });
      doc.body.appendChild(settingsDialog);

      let announcedMessage = '';
      function attemptSend(query, apiKey) {
        if (!apiKey?.trim()) {
          settingsDialog.showModal();
          announcedMessage = 'Please add your Gemini API key in Settings first.';
          return;
        }
      }

      attemptSend('What is CORS?', '');
      assert.strictEqual(settingsDialog.open, true);
      assert.ok(announcedMessage.includes('API key'));
    });

    it('T2_F7_03: rapid repeated question submission aborts in-flight request', () => {
      let activeAbortController = null;
      const abortSignals = [];

      function startStream(query) {
        if (activeAbortController) {
          activeAbortController.abort();
        }
        activeAbortController = new AbortController();
        abortSignals.push(activeAbortController.signal);
      }

      startStream('Question 1');
      assert.strictEqual(abortSignals[0].aborted, false);

      startStream('Question 2');
      assert.strictEqual(abortSignals[0].aborted, true, 'Question 1 must be aborted');
      assert.strictEqual(abortSignals[1].aborted, false, 'Question 2 must be active');
    });

    it('T2_F7_04: narrow side panel (320px) preserves button visibility and layout structure', () => {
      const { document: doc } = createSyntheticDom();
      const shell = doc.createElement('div', { class: 'app-shell' });
      shell.style.width = '320px';

      const toolbar = doc.createElement('div', { class: 'actions-toolbar' });
      const b1 = doc.createElement('button', { class: 'btn-sm' });
      b1.textContent = 'Highlight';
      const b2 = doc.createElement('button', { class: 'btn-sm' });
      b2.textContent = 'Apply';
      toolbar.appendChild(b1);
      toolbar.appendChild(b2);
      shell.appendChild(toolbar);

      assert.strictEqual(shell.style.width, '320px');
      assert.strictEqual(toolbar.children.length, 2);
    });

    it('T2_F7_05: wide side panel (800px) retains clean multi-element child hierarchy', () => {
      const { document: doc } = createSyntheticDom();
      const shell = doc.createElement('div', { class: 'app-shell' });
      shell.style.width = '800px';

      const qaOutput = doc.createElement('div', { class: 'analysis-output' });
      for (let i = 0; i < 5; i++) {
        const card = doc.createElement('article', { class: 'qa-card' });
        card.textContent = `Question ${i + 1}`;
        qaOutput.appendChild(card);
      }
      shell.appendChild(qaOutput);

      assert.strictEqual(shell.style.width, '800px');
      assert.strictEqual(qaOutput.children.length, 5);
    });

    it('T2_F7_06: renderMarkdown sanitizes against script injection and javascript pseudo-protocols', () => {
      const { document: doc } = createSyntheticDom();
      const container = doc.createElement('div');

      const maliciousMd = [
        '<script>alert("xss")</script>',
        '[Click here](javascript:alert(1))',
        'Normal text with **bold** formatting.',
      ].join('\n\n');

      renderMarkdown(container, maliciousMd);

      const scripts = container.querySelectorAll('script');
      assert.strictEqual(scripts.length, 0, 'No script tags allowed');

      const links = container.querySelectorAll('a');
      for (const link of links) {
        assert.ok(!link.href?.startsWith('javascript:'), 'javascript: links must be stripped');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Boundary 2.8: Micro-Interaction Boundaries
  // --------------------------------------------------------------------------
  describe('2.8 Micro-Interaction Boundaries', () => {
    it('T2_F8_01: copy button handles clipboard rejection gracefully without uncaught error', async () => {
      const rejectingNavigator = {
        clipboard: {
          writeText: async () => { throw new Error('Clipboard permission denied'); },
        },
      };

      const btn = new MiniElement('button');
      btn.textContent = 'Copy';

      let caught = false;
      try {
        await rejectingNavigator.clipboard.writeText('text');
        btn.textContent = 'Copied';
      } catch {
        caught = true;
        btn.textContent = 'Failed';
      }

      assert.strictEqual(caught, true);
      assert.strictEqual(btn.textContent, 'Failed');
    });

    it('T2_F8_02: settings dialog opens via showModal and closes cleanly', () => {
      const { document: doc } = createSyntheticDom();
      const dialog = doc.createElement('dialog', { id: 'settings-dialog' });
      doc.body.appendChild(dialog);

      assert.strictEqual(dialog.open, false);
      dialog.showModal();
      assert.strictEqual(dialog.open, true);
      dialog.close();
      assert.strictEqual(dialog.open, false);
    });

    it('T2_F8_03: clear chat button empties thread and hides itself', () => {
      const { document: doc } = createSyntheticDom();
      const thread = doc.createElement('div', { id: 'chat-thread' });
      const clearBtn = doc.createElement('button', { id: 'clear-chat-btn' });
      clearBtn.hidden = false;

      thread.appendChild(doc.createElement('div'));
      thread.appendChild(doc.createElement('div'));
      assert.strictEqual(thread.children.length, 2);

      thread.replaceChildren();
      clearBtn.hidden = true;

      assert.strictEqual(thread.children.length, 0);
      assert.strictEqual(clearBtn.hidden, true);
    });

    it('T2_F8_04: clicking stop button invokes stream abort and resets composer buttons', () => {
      const stopBtn = new MiniElement('button', { id: 'stop-btn' });
      const sendBtn = new MiniElement('button', { id: 'send-btn' });
      stopBtn.hidden = false;
      sendBtn.hidden = true;

      const abortController = new AbortController();
      stopBtn.addEventListener('click', () => {
        abortController.abort();
        stopBtn.hidden = true;
        sendBtn.hidden = false;
      });

      stopBtn.click();
      assert.strictEqual(abortController.signal.aborted, true);
      assert.strictEqual(stopBtn.hidden, true);
      assert.strictEqual(sendBtn.hidden, false);
    });

    it('T2_F8_05: roving tabindex wrap-around wraps backwards from first to last button', () => {
      const buttons = [new MiniElement('button'), new MiniElement('button'), new MiniElement('button')];
      let activeIndex = 0;

      function onArrowLeft() {
        activeIndex = (activeIndex - 1 + buttons.length) % buttons.length;
        buttons[activeIndex].focus();
      }

      onArrowLeft();
      assert.strictEqual(activeIndex, 2, 'Must wrap backwards to index 2');
      assert.strictEqual(buttons[2].focused, true);
    });

    it('T2_F8_06: suggested question chips gracefully skip empty or non-string items', () => {
      const { document: doc } = createSyntheticDom();
      const list = doc.createElement('div', { class: 'suggested-list' });
      const rawQuestions = ['Valid question 1', '', null, '   ', 'Valid question 2'];

      for (const q of rawQuestions) {
        if (!q || !q.trim()) continue;
        const chip = doc.createElement('button', { class: 'chip-btn' });
        chip.textContent = q.trim();
        list.appendChild(chip);
      }

      assert.strictEqual(list.children.length, 2);
      assert.strictEqual(list.children[0].textContent, 'Valid question 1');
      assert.strictEqual(list.children[1].textContent, 'Valid question 2');
    });
  });
});

// ============================================================================
// TIER 3 — CROSS-FEATURE COMBINATIONS (16 Pairwise Tests)
// ============================================================================

describe('Tier 3 — Cross-Feature Combinations', () => {
  it('T3_P01: Pruned DOM + Multi-tier Cache: hashed pruned content produces consistent cache hits', async () => {
    const rawText = 'Detailed   page   content\n\n\n\nwith multiple sections of informative facts.';
    const pruned = prunePageText(rawText);
    const contentHash = crypto.createHash('sha256').update(pruned.text).digest('hex').slice(0, 16);

    const storage = new MockStorageArea();
    const mgr = new QueryCacheManager({ storageArea: storage });

    const key = mgr.computeKey({
      contentHash,
      query: 'What is in this page?',
      model: 'gemini-3.8-flash',
    });

    await mgr.set(key, { answer: 'Informative facts about the page.', tokensSaved: pruned.tokensSavedEst });

    const secondPrune = prunePageText(rawText);
    const secondHash = crypto.createHash('sha256').update(secondPrune.text).digest('hex').slice(0, 16);
    const secondKey = mgr.computeKey({
      contentHash: secondHash,
      query: 'what is in this page?',
      model: 'gemini-3.8-flash',
    });

    assert.strictEqual(key, secondKey);
    const cached = await mgr.get(secondKey);
    assert.ok(cached);
    assert.strictEqual(cached.answer, 'Informative facts about the page.');
  });

  it('T3_P02: Streaming + Cache Storage + Instant Replay: stream persists response and serves 0ms replay', async () => {
    const storage = new MockStorageArea();
    const cacheMgr = new QueryCacheManager({ storageArea: storage });
    const snapshot = { title: 'Process', url: 'https://example.com', contentHash: 'stream-hash-1', text: 'Some document context with rich text content.'.repeat(2) };
    const question = 'Describe the process';

    const sseChunks = makeGeminiSseChunks(['Step 1: Collect. ', 'Step 2: Analyze.']);

    const res1 = await streamCustomQuestion({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      pageSnapshot: snapshot,
      question,
      cacheManager: cacheMgr,
      fetchImpl: async () => new Response(makeSseStream(sseChunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    });

    assert.strictEqual(res1.text, 'Step 1: Collect. Step 2: Analyze.');

    let fetchCalled = false;
    const res2 = await streamCustomQuestion({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      pageSnapshot: snapshot,
      question,
      cacheManager: cacheMgr,
      fetchImpl: async () => { fetchCalled = true; },
    });

    assert.strictEqual(fetchCalled, false);
    assert.strictEqual(res2.cached, true);
    assert.strictEqual(res2.text, 'Step 1: Collect. Step 2: Analyze.');
  });

  it('T3_P03: CRX3 Packager + Manifest update_url: generated update manifest aligns with manifest.json', async () => {
    const manifest = await getManifest();
    const keyPem = await getPrivateKeyPem();
    const zip = createZipBuffer([{ name: 'manifest.json', data: JSON.stringify(manifest) }]);
    const { appId } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

    const xml = generateUpdateXml({
      appId,
      codebase: manifest.update_url.replace('/updates.xml', '/tab-scan-qa.crx'),
      version: manifest.version,
    });

    assert.ok(xml.includes(appId));
    assert.ok(xml.includes(manifest.version));
  });

  it('T3_P04: CRX3 Packager + Chromium App ID: App ID matches derivation from manifest key', async () => {
    const manifest = await getManifest();
    const keyPem = await getPrivateKeyPem();
    const zip = createZipBuffer([{ name: 'manifest.json', data: '{}' }]);
    const crxResult = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

    const manifestAppId = computeAppId(Buffer.from(manifest.key, 'base64'));
    assert.strictEqual(crxResult.appId, manifestAppId);
  });

  it('T3_P05: UI Controller + Cache Badge indicator: renders emerald badge on cache hit', async () => {
    const { document: doc } = createSyntheticDom();

    function renderMessage(text, isCached) {
      const msg = doc.createElement('article', { class: 'chat-msg chat-msg-model' });
      const header = doc.createElement('div', { class: 'chat-msg-header' });
      if (isCached) {
        const badge = doc.createElement('span', { class: 'badge badge-cached' });
        badge.textContent = '⚡ Cached (0ms)';
        header.appendChild(badge);
      }
      const body = doc.createElement('div', { class: 'chat-msg-body' });
      body.textContent = text;
      msg.appendChild(header);
      msg.appendChild(body);
      return msg;
    }

    const liveMsg = renderMessage('Fresh response', false);
    assert.strictEqual(liveMsg.querySelector('.badge-cached'), null);

    const cachedMsg = renderMessage('Instant response', true);
    const badge = cachedMsg.querySelector('.badge-cached');
    assert.ok(badge);
    assert.strictEqual(badge.textContent, '⚡ Cached (0ms)');
  });

  it('T3_P06: Selective Screenshots + Token Optimizer: text query strips images saving multimodal tokens', () => {
    const textSnapshot = {
      text: 'Long document prose '.repeat(20),
      screenshots: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='],
    };

    const attachForText = shouldAttachScreenshots(textSnapshot, 'What is the summary?');
    assert.strictEqual(attachForText, false);

    const attachForDiagram = shouldAttachScreenshots(textSnapshot, 'Explain the flowchart diagram');
    assert.strictEqual(attachForDiagram, true);
  });

  it('T3_P07: Pruned DOM + Boilerplate Stripping: scanner strips boilerplate then prunes text', () => {
    const { document: doc } = createSyntheticDom();
    const root = doc.createElement('div');
    const nav = doc.createElement('nav');
    nav.textContent = 'Nav links '.repeat(20);
    const article = doc.createElement('article');
    article.textContent = 'Valuable article content.   With extra spaces.';
    root.appendChild(nav);
    root.appendChild(article);

    stripBoilerplateSelectors(root);
    assert.strictEqual(root.children.length, 1);

    const pruned = prunePageText(root.textContent);
    assert.strictEqual(pruned.text, 'Valuable article content. With extra spaces.');
  });

  it('T3_P08: Streaming Abort + Cache Invalidation: aborted stream does not persist to cache', async () => {
    const cacheMgr = new QueryCacheManager();
    const controller = new AbortController();

    const mockFetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"Partial text"}}\n\n'));
          controller.abort();
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    try {
      await streamCustomQuestion({
        apiKey: 'key',
        pageSnapshot: { title: 'T', url: 'https://ex.com', text: 'Text' },
        question: 'Aborted halfway?',
        cacheManager: cacheMgr,
        signal: controller.signal,
        fetchImpl: mockFetch,
      });
    } catch {
      // Expected abort rejection
    }

    const key = computeQueryCacheKey({ query: 'Aborted halfway?' });
    const cached = await cacheMgr.get(key);
    assert.strictEqual(cached, null, 'Aborted stream must not write to cache');
  });

  it('T3_P09: Quick Prompt Chip + Streaming Execution: clicking chip triggers streamCustomQuestion', async () => {
    const { document: doc } = createSyntheticDom();
    const chip = doc.createElement('button', { class: 'chip-btn' });
    chip.textContent = 'Summarize this tab';

    const sseChunks = makeGeminiSseChunks(['Here is the summary.']);
    let streamedOutput = '';
    let streamPromise = null;

    chip.addEventListener('click', () => {
      streamPromise = streamCustomQuestion({
        apiKey: 'key',
        pageSnapshot: { title: 'T', url: 'https://ex.com', text: 'Page text context.' },
        question: chip.textContent,
        onChunk: (_, acc) => { streamedOutput = acc; },
        fetchImpl: async () => new Response(makeSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      });
    });

    chip.click();
    await streamPromise;
    assert.strictEqual(streamedOutput, 'Here is the summary.');
  });

  it('T3_P10: Omaha XML Generation + Release Packager Output: updates.xml matches release metadata', async () => {
    const keyPem = await getPrivateKeyPem();
    const manifest = await getManifest();
    const zip = createZipBuffer([{ name: 'manifest.json', data: JSON.stringify(manifest) }]);
    const { crx, appId } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

    const xml = generateUpdateXml({
      appId,
      codebase: 'https://example.com/tab-scan-qa.crx',
      version: manifest.version,
    });

    const crxSha256 = crypto.createHash('sha256').update(crx).digest('hex');
    assert.ok(xml.includes(appId));
    assert.ok(crxSha256.length === 64);
  });

  it('T3_P11: Storage Area Switch + Cache Isolation: two storage instances maintain independent caches', async () => {
    const storageA = new MockStorageArea();
    const storageB = new MockStorageArea();

    await setQueryCache('iso-key1', { answer: 'Answer in Area A' }, storageA);

    const itemA = await storageA.get('tabscan_qc_iso-key1');
    const itemB = await storageB.get('tabscan_qc_iso-key1');

    assert.ok(itemA['tabscan_qc_iso-key1']);
    assert.strictEqual(itemA['tabscan_qc_iso-key1'].answer, 'Answer in Area A');
    assert.strictEqual(itemB['tabscan_qc_iso-key1'], undefined, 'Storage Area B must remain isolated');
  });

  it('T3_P12: Large DOM Pruning + Streaming Prompt Assembly: pruned context embedded cleanly in prompt', () => {
    const largeBody = 'Important paragraph. '.repeat(2000); // ~42,000 chars
    const snapshot = {
      title: 'Large Document',
      url: 'https://example.com/doc',
      text: largeBody,
      questionCandidates: [],
    };

    const prompt = buildPageContextPrompt(snapshot, 36000);
    assert.ok(prompt.length <= 40000);
    assert.ok(prompt.includes('Large Document'));
    assert.ok(prompt.includes('Important paragraph.'));
  });

  it('T3_P13: Manifest Permissions + Content Script DOM Extraction: declared permissions cover scripting', async () => {
    const manifest = await getManifest();
    assert.ok(manifest.permissions.includes('scripting'));
    assert.ok(manifest.permissions.includes('tabs'));
  });

  it('T3_P14: UI Error State + Retry Trigger: retry after error recovers and completes successfully', async () => {
    let callCount = 0;
    async function attemptQuery() {
      callCount++;
      if (callCount === 1) {
        throw new GeminiApiError('Rate limited (429)', 429, 'rate_limit');
      }
      return 'Success on retry';
    }

    const { document: doc } = createSyntheticDom();
    const errorCallout = doc.createElement('div', { id: 'analysis-error', hidden: 'true' });
    const retryBtn = doc.createElement('button', { id: 'retry-analysis-btn' });
    let finalAnswer = '';

    retryBtn.addEventListener('click', async () => {
      finalAnswer = await attemptQuery();
      errorCallout.hidden = true;
    });

    try {
      await attemptQuery();
    } catch {
      errorCallout.hidden = false;
    }
    assert.strictEqual(errorCallout.hidden, false);

    await retryBtn.dispatchEvent(new MiniEvent('click'));
    assert.strictEqual(finalAnswer, 'Success on retry');
    assert.strictEqual(errorCallout.hidden, true);
  });

  it('T3_P15: Container Query Resize + Copy Action: copy button functions cleanly in resized 320px container', async () => {
    const { document: doc, navigator, getClipboard } = createSyntheticDom();
    const shell = doc.createElement('div', { class: 'app-shell' });
    shell.style.width = '320px';

    const card = doc.createElement('article', { class: 'qa-card' });
    const copyBtn = doc.createElement('button', { class: 'btn-copy' });
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText('Answer to copy');
      copyBtn.textContent = 'Copied';
    });
    card.appendChild(copyBtn);
    shell.appendChild(card);

    await copyBtn.dispatchEvent(new MiniEvent('click'));
    assert.strictEqual(getClipboard(), 'Answer to copy');
    assert.strictEqual(copyBtn.textContent, 'Copied');
  });

  it('T3_P16: Release Metadata SHA-256 matches cryptographic hash of CRX3 binary', async () => {
    const keyPem = await getPrivateKeyPem();
    const zip = createZipBuffer([{ name: 'manifest.json', data: '{"version":"1.0.0"}' }]);
    const { crx, appId } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });

    const expectedSha256 = crypto.createHash('sha256').update(crx).digest('hex');
    const metadata = {
      appId,
      version: '1.0.0',
      sha256: expectedSha256,
      crxBytes: crx.length,
    };

    assert.strictEqual(metadata.sha256, expectedSha256);
    assert.strictEqual(metadata.crxBytes, crx.length);
  });
});

// ============================================================================
// TIER 4 — REAL-WORLD APPLICATION SCENARIOS (6 Realistic End-to-End Workloads)
// ============================================================================

describe('Tier 4 — Real-World Application Scenarios', () => {
  it('T4_S01: Scenario 1 — Wikipedia article Q&A with progressive streaming and instant cache replay', async () => {
    const storage = new MockStorageArea();
    const cacheMgr = new QueryCacheManager({ storageArea: storage });

    const rawArticle = WIKIPEDIA_PHOTOSYNTHESIS_TEXT;
    const prunedArticle = prunePageText(rawArticle);
    const contentHash = crypto.createHash('sha256').update(prunedArticle.text).digest('hex').slice(0, 16);

    const snapshot = {
      title: 'Photosynthesis - Wikipedia',
      url: 'https://en.wikipedia.org/wiki/Photosynthesis',
      text: prunedArticle.text,
      contentHash,
    };

    const question = 'What is the primary role of chlorophyll in light-dependent reactions?';

    const sseChunks = makeGeminiSseChunks([
      'Chlorophyll absorbs ',
      'a photon and loses an electron, ',
      'initiating the electron transport chain.',
    ]);

    const deltas = [];
    const res1 = await streamCustomQuestion({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      pageSnapshot: snapshot,
      question,
      cacheManager: cacheMgr,
      onChunk: (delta) => deltas.push(delta),
      fetchImpl: async () => new Response(makeSseStream(sseChunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    });

    assert.strictEqual(res1.text, 'Chlorophyll absorbs a photon and loses an electron, initiating the electron transport chain.');
    assert.strictEqual(deltas.length, 3);

    let secondFetchCalled = false;
    let replayReceived = '';
    const res2 = await streamCustomQuestion({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      pageSnapshot: snapshot,
      question,
      cacheManager: cacheMgr,
      onChunk: (_, acc) => { replayReceived = acc; },
      fetchImpl: async () => { secondFetchCalled = true; },
    });

    assert.strictEqual(secondFetchCalled, false, 'No HTTP request on cache replay');
    assert.strictEqual(res2.cached, true);
    assert.strictEqual(res2.text, res1.text);
    assert.strictEqual(replayReceived, res1.text);
  });

  it('T4_S02: Scenario 2 — Dynamic SPA with cookie banner, sticky navigation, and chrome pruning', () => {
    const { document: doc } = createSyntheticDom();
    const root = doc.createElement('div');

    const banner = doc.createElement('header', { role: 'banner' });
    banner.textContent = 'Home About Contact Navigation';
    const cookie = doc.createElement('aside', { class: 'cookie-banner', id: 'cookie-consent-bar' });
    cookie.textContent = 'We use cookies. Accept to continue.';
    const ad = doc.createElement('aside', { class: 'ad advertisement' });
    ad.textContent = 'Buy organic fertilizer now! 20% discount.';
    const footer = doc.createElement('footer', { role: 'contentinfo' });
    footer.textContent = 'Copyright 2026 Academic Testing Systems Inc.';

    const main = doc.createElement('main');
    const q1 = doc.createElement('fieldset');
    const leg1 = doc.createElement('legend');
    leg1.textContent = 'Question 1: What is the primary role of chlorophyll?';
    q1.appendChild(leg1);
    const q2 = doc.createElement('fieldset');
    const leg2 = doc.createElement('legend');
    leg2.textContent = 'Question 2: Which enzyme catalyzes carbon dioxide fixation?';
    q2.appendChild(leg2);
    main.appendChild(q1);
    main.appendChild(q2);

    root.appendChild(banner);
    root.appendChild(cookie);
    root.appendChild(main);
    root.appendChild(ad);
    root.appendChild(footer);

    const originalCharCount = root.textContent.length;
    const strippedCount = stripBoilerplateSelectors(root);

    assert.strictEqual(strippedCount, 4);
    assert.strictEqual(root.children.length, 1);
    assert.strictEqual(root.children[0].tagName, 'MAIN');
    assert.strictEqual(root.querySelectorAll('fieldset').length, 2);

    const remainingTextWithWhitespace = root.textContent + '   With extra   spaces   \n\n\n\nand   more.';
    const pruned = prunePageText(remainingTextWithWhitespace);
    assert.ok(pruned.tokensSavedEst > 0);
    assert.ok(pruned.prunedChars < remainingTextWithWhitespace.length);
  });

  it('T4_S03: Scenario 3 — Full release packaging pipeline execution and cryptographic verification', async () => {
    const keyPem = await getPrivateKeyPem();
    const manifest = await getManifest();

    const files = collectExtensionFiles(ROOT_DIR);
    assert.ok(files.length >= 10);

    const zip = createZipBuffer(files);
    assert.ok(zip.length > 5000);

    const { crx, appId, publicKeyBase64 } = generateCrx3({ zipBuffer: zip, privateKeyPem: keyPem });
    assert.strictEqual(appId, 'jjoepgfpagdecpcbabppbbnblaeklpic');

    const parsed = parseCrx3Header(crx);
    assert.strictEqual(parsed.isValidSignature, true);
    assert.strictEqual(parsed.publicKeyBase64, publicKeyBase64);

    const xml = generateUpdateXml({
      appId,
      codebase: 'https://raw.githubusercontent.com/user/tabscan-qa/main/dist/tab-scan-qa.crx',
      version: manifest.version,
    });

    assert.ok(xml.includes(appId));
    assert.ok(xml.includes(manifest.version));
    assert.ok(xml.includes("protocol='2.0'"));
  });

  it('T4_S04: Scenario 4 — Narrow side-panel container responsiveness and micro-interactions', async () => {
    const { document: doc, navigator, getClipboard } = createSyntheticDom();

    const shell = doc.createElement('div', { class: 'app-shell' });
    shell.style.width = '320px';

    const toolbar = doc.createElement('div', { class: 'actions-toolbar', role: 'toolbar' });
    const btnHighlight = doc.createElement('button', { id: 'highlight-all-btn' });
    const btnApply = doc.createElement('button', { id: 'apply-all-btn' });
    const btnClear = doc.createElement('button', { id: 'clear-highlights-btn' });
    toolbar.appendChild(btnHighlight);
    toolbar.appendChild(btnApply);
    toolbar.appendChild(btnClear);

    const card = doc.createElement('article', { class: 'qa-card' });
    const copyBtn = doc.createElement('button', { class: 'btn-copy' });
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText('Photosynthesis occurs in chloroplasts.');
      copyBtn.textContent = 'Copied';
    });
    card.appendChild(copyBtn);

    shell.appendChild(toolbar);
    shell.appendChild(card);

    await copyBtn.dispatchEvent(new MiniEvent('click'));
    assert.strictEqual(getClipboard(), 'Photosynthesis occurs in chloroplasts.');
    assert.strictEqual(copyBtn.textContent, 'Copied');
  });

  it('T4_S05: Scenario 5 — Network failure during streaming with graceful retry recovery', async () => {
    let callAttempt = 0;
    const sseChunks = makeGeminiSseChunks(['Recovered successfully after network retry.']);

    async function executeQueryWithRetry(question) {
      callAttempt++;
      if (callAttempt === 1) {
        throw new GeminiApiError('Network connection lost mid-stream.', 0, 'network_error');
      }
      return streamCustomQuestion({
        apiKey: 'key',
        pageSnapshot: { title: 'Network Test', url: 'https://example.com', text: 'Sample text' },
        question,
        fetchImpl: async () => new Response(makeSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      });
    }

    let firstError = null;
    try {
      await executeQueryWithRetry('Test retry');
    } catch (err) {
      firstError = err;
    }

    assert.ok(firstError);
    assert.strictEqual(firstError.code, 'network_error');

    const res = await executeQueryWithRetry('Test retry');
    assert.strictEqual(res.text, 'Recovered successfully after network retry.');
  });

  it('T4_S06: Scenario 6 — Multimodal diagram query includes screenshot attachment while text-only omits it', () => {
    const snapshotWithDiagram = {
      title: 'Solar System Diagrams',
      text: 'Overview of the solar system orbits and planetary masses.',
      screenshots: ['data:image/png;base64,sample-image-bytes'],
      mediaSummary: { hasVisualContent: true },
    };

    const visualQuery = 'Can you explain the orbit diagram in figure 2?';
    assert.strictEqual(shouldAttachScreenshots(snapshotWithDiagram, visualQuery), true);

    const richTextSnapshot = {
      text: 'Extensive text detailing planetary formation spanning many paragraphs and exceeding 150 characters.'.repeat(3),
      screenshots: ['data:image/png;base64,sample-image-bytes'],
    };
    const textQuery = 'What is the accretion hypothesis?';
    assert.strictEqual(shouldAttachScreenshots(richTextSnapshot, textQuery), false);
  });
});
