#!/usr/bin/env node
/**
 * Tab-Sleuth - Zero-Dependency CRX3 Packaging & Auto-Update Pipeline
 *
 * Packages extension files into a cryptographically signed Chromium CRX3 package,
 * generates an Omaha v2.0 update manifest XML, and produces distribution metadata.
 * Uses ONLY Node.js built-in modules (crypto, fs, path, zlib, url).
 *
 * @license Apache-2.0 / MIT
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 1. CRC32 Calculation (Built-in with fallback table)
// ---------------------------------------------------------------------------

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/**
 * Calculates standard IEEE 802.3 CRC32 checksum for a buffer.
 * Uses `node:zlib.crc32` if available (Node 22.2+), else falls back to table lookup.
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {number} unsigned 32-bit integer
 */
export function calculateCrc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  const table = getCrcTable();
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// 2. Protobuf Varint Encoding & Decoding
// ---------------------------------------------------------------------------

/**
 * Encodes a numeric value as a Protobuf varint byte buffer.
 * Supports numbers and BigInts.
 *
 * @param {number | bigint} val
 * @returns {Buffer}
 */
export function encodeVarint(val) {
  let v = typeof val === 'bigint' ? val : BigInt(Math.floor(val));
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v & 0x7fn));
  return Buffer.from(bytes);
}

/**
 * Decodes a Protobuf varint from a buffer at a given byte offset.
 *
 * @param {Buffer | Uint8Array} buf
 * @param {number} [offset=0]
 * @returns {{ value: number, bytesRead: number }}
 */
export function decodeVarint(buf, offset = 0) {
  let res = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buf.length) {
    const b = buf[cursor++];
    res |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value: res, bytesRead: cursor - offset };
}

// ---------------------------------------------------------------------------
// 3. Chromium Extension App ID Calculation
// ---------------------------------------------------------------------------

/**
 * Derives the unique 32-character Chromium Extension App ID from the
 * SubjectPublicKeyInfo (SPKI) DER public key.
 *
 * Follows Chromium's canonical `id_util.cc::GenerateIdFromHash`:
 * 1. Takes the SHA-256 digest of the SPKI DER public key.
 * 2. Uses the first 16 bytes (128 bits).
 * 3. Maps each 4-bit nibble (0-15) to characters 'a' through 'p' (`'a'.charCodeAt(0) + nibble`).
 *
 * @param {Buffer | Uint8Array} publicKeyDer
 * @returns {string} 32-character string composed of 'a'-'p'
 */
export function computeAppId(publicKeyDer) {
  const buf = Buffer.isBuffer(publicKeyDer) ? publicKeyDer : Buffer.from(publicKeyDer);
  const hash = crypto.createHash('sha256').update(buf).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const byte = hash[i];
    id += String.fromCharCode(97 + ((byte >> 4) & 0x0f));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

// Alias for compatibility
export const calculateAppId = computeAppId;

// ---------------------------------------------------------------------------
// 4. Pure Node.js ZIP Archive Construction
// ---------------------------------------------------------------------------

/**
 * Formats a JS Date into MS-DOS format date and time numbers for ZIP headers.
 *
 * @param {Date} [date=new Date()]
 * @returns {{ dosTime: number, dosDate: number }}
 */
function toDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Builds a valid, unencrypted ZIP file buffer entirely in memory from entry objects.
 * Uses DeflateRaw compression (`zlib.deflateRawSync`) with automatic fallback to Store.
 *
 * @param {Array<{ name: string, data: Buffer | string, date?: Date }>} entries
 * @returns {Buffer} complete ZIP archive buffer
 */
export function createZipBuffer(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  const now = new Date();

  for (const entry of entries) {
    const rawName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(rawName, 'utf8');
    const uncompressed = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, 'utf8');

    // Attempt DEFLATE compression
    const compressed = zlib.deflateRawSync(uncompressed, { level: 9 });
    const useDeflate = compressed.length < uncompressed.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? compressed : uncompressed;
    const crc = calculateCrc32(uncompressed);
    const { dosTime, dosDate } = toDosDateTime(entry.date || now);

    // 1. Local File Header (30 bytes + filename)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // Local file header signature
    lh.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
    lh.writeUInt16LE(0x0800, 6);     // General purpose bit flag (UTF-8 filename)
    lh.writeUInt16LE(method, 8);     // Compression method
    lh.writeUInt16LE(dosTime, 10);   // Last mod file time
    lh.writeUInt16LE(dosDate, 12);   // Last mod file date
    lh.writeUInt32LE(crc, 14);       // CRC-32
    lh.writeUInt32LE(body.length, 18);         // Compressed size
    lh.writeUInt32LE(uncompressed.length, 22); // Uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);      // File name length
    lh.writeUInt16LE(0, 28);                   // Extra field length
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, body);

    // 2. Central Directory File Header (46 bytes + filename)
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // Central file header signature
    ch.writeUInt16LE(20, 4);         // Version made by (2.0)
    ch.writeUInt16LE(20, 6);         // Version needed to extract (2.0)
    ch.writeUInt16LE(0x0800, 8);     // General purpose bit flag (UTF-8)
    ch.writeUInt16LE(method, 10);    // Compression method
    ch.writeUInt16LE(dosTime, 12);   // Last mod file time
    ch.writeUInt16LE(dosDate, 14);   // Last mod file date
    ch.writeUInt32LE(crc, 16);       // CRC-32
    ch.writeUInt32LE(body.length, 20);         // Compressed size
    ch.writeUInt32LE(uncompressed.length, 24); // Uncompressed size
    ch.writeUInt16LE(nameBuf.length, 28);      // File name length
    ch.writeUInt16LE(0, 30);                   // Extra field length
    ch.writeUInt16LE(0, 32);                   // File comment length
    ch.writeUInt16LE(0, 34);                   // Disk number start
    ch.writeUInt16LE(0, 36);                   // Internal file attributes
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);      // External file attributes (standard rw-r--r--)
    ch.writeUInt32LE(offset, 42);              // Relative offset of local header
    nameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + body.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((sum, b) => sum + b.length, 0);

  // 3. End of Central Directory Record (EOCD, 22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // Number of this disk
  eocd.writeUInt16LE(0, 6);          // Disk with start of central directory
  eocd.writeUInt16LE(entries.length, 8);  // Total entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirSize, 12); // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);          // ZIP comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/**
 * Recursively scans directory and collects extension files for packaging.
 * Filters out tests, dist, keys, git, documentation, and agent folders.
 *
 * @param {string} rootDir
 * @param {object} [options={}]
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function collectExtensionFiles(rootDir, options = {}) {
  const includedDirs = options.includedDirs || ['icons', 'scripts', 'shared', 'sidepanel'];
  const includedRootFiles = options.includedRootFiles || ['manifest.json', 'service-worker.js', 'update.bat'];
  const excludePatterns = options.excludePatterns || [
    /^[._]/,
    /\.pem$/i,
    /\.git/i,
    /\.agents/i,
    /^tests[\/\\]/i,
    /^dist[\/\\]/i,
    /^docs[\/\\]/i,
    /^README(\.md)?$/i,
    /\.DS_Store$/i,
  ];

  const entries = [];

  function shouldExclude(relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    return excludePatterns.some((pattern) => pattern.test(normalized));
  }

  // 1. Root files
  for (const file of includedRootFiles) {
    const fullPath = path.join(rootDir, file);
    if (fs.existsSync(fullPath) && !shouldExclude(file)) {
      entries.push({
        name: file,
        data: fs.readFileSync(fullPath),
      });
    }
  }

  // 2. Directories
  function walkDir(dirRel) {
    const dirFull = path.join(rootDir, dirRel);
    if (!fs.existsSync(dirFull)) return;
    const items = fs.readdirSync(dirFull, { withFileTypes: true });

    for (const item of items) {
      const relPath = path.join(dirRel, item.name);
      if (shouldExclude(relPath)) continue;

      if (item.isDirectory()) {
        walkDir(relPath);
      } else if (item.isFile()) {
        entries.push({
          name: relPath.replace(/\\/g, '/'),
          data: fs.readFileSync(path.join(rootDir, relPath)),
        });
      }
    }
  }

  for (const dir of includedDirs) {
    walkDir(dir);
  }

  // Sort entries alphabetically for deterministic builds
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ---------------------------------------------------------------------------
// 5. CRX3 Packaging & Signing
// ---------------------------------------------------------------------------

/**
 * Packages a ZIP buffer into a signed Chromium CRX3 binary.
 *
 * Specifications from Chromium `components/crx_file/crx3.proto` & `crx_verifier.cc`:
 * - 4 bytes: Magic ASCII 'Cr24' (0x43, 0x72, 0x32, 0x34)
 * - 4 bytes: Format version (uint32 LE = 3)
 * - 4 bytes: Header protobuf length (uint32 LE)
 * - Protobuf `CrxFileHeader`:
 *   - Field 2 (`sha256_with_rsa`): `AsymmetricKeyProof` containing SPKI DER public key and RSA-SHA256 signature
 *   - Field 10000 (`signed_header_data`): `SignedData` containing 16-byte raw `crx_id`
 * - Standard ZIP archive payload
 *
 * @param {{ zipBuffer: Buffer, privateKeyPem: string | Buffer }} options
 * @returns {{ crx: Buffer, appId: string, publicKeyDer: Buffer, publicKeyBase64: string }}
 */
export function generateCrx3({ zipBuffer, privateKeyPem }) {
  if (!zipBuffer || !Buffer.isBuffer(zipBuffer)) {
    throw new Error('zipBuffer must be a Buffer');
  }
  if (!privateKeyPem) {
    throw new Error('privateKeyPem must be provided');
  }

  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKeyDer = crypto
    .createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' });
  const rawId = crypto
    .createHash('sha256')
    .update(publicKeyDer)
    .digest()
    .subarray(0, 16);
  const appId = computeAppId(publicKeyDer);
  const publicKeyBase64 = publicKeyDer.toString('base64');

  // SignedData protobuf:
  // message SignedData { optional bytes crx_id = 1; }
  // Tag 1 wire type 2 = 0x0a, length 16 = 0x10
  const signedHeaderData = Buffer.concat([
    Buffer.from([0x0a, 0x10]),
    rawId,
  ]);

  // Data to sign: "CRX3 SignedData\x00" + uint32LE(signedHeaderData.length) + signedHeaderData + zipBuffer
  const prefix = Buffer.from('CRX3 SignedData\x00', 'utf8');
  const signedDataLength = Buffer.alloc(4);
  signedDataLength.writeUInt32LE(signedHeaderData.length, 0);

  const signer = crypto.createSign('sha256');
  signer.update(prefix);
  signer.update(signedDataLength);
  signer.update(signedHeaderData);
  signer.update(zipBuffer);
  const signature = signer.sign(privateKey);

  // AsymmetricKeyProof protobuf:
  // message AsymmetricKeyProof {
  //   optional bytes public_key = 1;
  //   optional bytes signature = 2;
  // }
  const proof = Buffer.concat([
    Buffer.from([0x0a]),
    encodeVarint(publicKeyDer.length),
    publicKeyDer,
    Buffer.from([0x12]),
    encodeVarint(signature.length),
    signature,
  ]);

  // CrxFileHeader protobuf:
  // message CrxFileHeader {
  //   repeated AsymmetricKeyProof sha256_with_rsa = 2;
  //   repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
  //   optional bytes signed_header_data = 10000;
  // }
  // Tag 10000 wire type 2: (10000 << 3) | 2 = 80002 -> [0x82, 0xf1, 0x04]
  const tag10000 = encodeVarint((10000 << 3) | 2);
  const headerProtobuf = Buffer.concat([
    Buffer.from([0x12]),
    encodeVarint(proof.length),
    proof,
    tag10000,
    encodeVarint(signedHeaderData.length),
    signedHeaderData,
  ]);

  // Binary CRX3 layout
  const crxHeader = Buffer.alloc(12);
  crxHeader.write('Cr24', 0, 4, 'ascii');
  crxHeader.writeUInt32LE(3, 4);
  crxHeader.writeUInt32LE(headerProtobuf.length, 8);

  const crx = Buffer.concat([crxHeader, headerProtobuf, zipBuffer]);
  return { crx, appId, publicKeyDer, publicKeyBase64 };
}

// Alias for compatibility
export const packageCrx3 = generateCrx3;

// ---------------------------------------------------------------------------
// 6. CRX3 Binary Header & Signature Parser / Verifier
// ---------------------------------------------------------------------------

/**
 * Parses and cryptographically validates a CRX3 binary header and RSA-SHA256 signature.
 *
 * @param {Buffer | Uint8Array} crxBuffer
 * @returns {{
 *   magic: string,
 *   version: number,
 *   headerLength: number,
 *   appId: string,
 *   publicKeyBase64: string,
 *   archiveBuffer: Buffer,
 *   isValidSignature: boolean
 * }}
 */
export function parseCrx3Header(crxBuffer) {
  if (!crxBuffer || (!Buffer.isBuffer(crxBuffer) && !(crxBuffer instanceof Uint8Array))) {
    throw new Error('crxBuffer must be a Buffer or Uint8Array');
  }
  const buf = Buffer.isBuffer(crxBuffer) ? crxBuffer : Buffer.from(crxBuffer);

  if (buf.length < 12) {
    throw new Error('Buffer too small for CRX header (minimum 12 bytes required)');
  }

  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'Cr24') {
    throw new Error(`Invalid CRX magic bytes: expected 'Cr24', got '${magic}'`);
  }

  const version = buf.readUInt32LE(4);
  if (version !== 3) {
    throw new Error(`Unsupported CRX version: ${version} (expected version 3)`);
  }

  const headerLength = buf.readUInt32LE(8);
  if (buf.length < 12 + headerLength) {
    throw new Error(
      `Truncated CRX: headerLength is ${headerLength}, but total buffer is only ${buf.length}`
    );
  }

  const headerBuf = buf.subarray(12, 12 + headerLength);
  const archiveBuffer = buf.subarray(12 + headerLength);

  let cursor = 0;
  let proof = null;
  let signedHeaderData = null;

  while (cursor < headerBuf.length) {
    const tagInfo = decodeVarint(headerBuf, cursor);
    cursor += tagInfo.bytesRead;
    const fieldNum = tagInfo.value >> 3;
    const wireType = tagInfo.value & 0x07;

    if (wireType === 2) {
      const lenInfo = decodeVarint(headerBuf, cursor);
      cursor += lenInfo.bytesRead;
      const fieldData = headerBuf.subarray(cursor, cursor + lenInfo.value);
      cursor += lenInfo.value;

      if (fieldNum === 2) {
        // AsymmetricKeyProof (sha256_with_rsa)
        let pCursor = 0;
        let pubKey = null;
        let sig = null;
        while (pCursor < fieldData.length) {
          const pTag = decodeVarint(fieldData, pCursor);
          pCursor += pTag.bytesRead;
          const pNum = pTag.value >> 3;
          const pWire = pTag.value & 0x07;

          if (pWire === 2) {
            const pLen = decodeVarint(fieldData, pCursor);
            pCursor += pLen.bytesRead;
            const pVal = fieldData.subarray(pCursor, pCursor + pLen.value);
            pCursor += pLen.value;
            if (pNum === 1) pubKey = pVal;
            else if (pNum === 2) sig = pVal;
          } else if (pWire === 0) {
            const skipVar = decodeVarint(fieldData, pCursor);
            pCursor += skipVar.bytesRead;
          } else {
            break;
          }
        }
        proof = { publicKey: pubKey, signature: sig };
      } else if (fieldNum === 10000) {
        signedHeaderData = fieldData;
      }
    } else if (wireType === 0) {
      const vInfo = decodeVarint(headerBuf, cursor);
      cursor += vInfo.bytesRead;
    } else if (wireType === 1) {
      cursor += 8;
    } else if (wireType === 5) {
      cursor += 4;
    } else {
      throw new Error(`Unsupported wire type: ${wireType}`);
    }
  }

  if (!proof || !proof.publicKey || !proof.signature) {
    throw new Error('CRX3 header missing required sha256_with_rsa proof');
  }
  if (!signedHeaderData) {
    throw new Error('CRX3 header missing signed_header_data');
  }

  // Parse SignedData protobuf to extract crx_id
  let cCursor = 0;
  let crxId = null;
  while (cCursor < signedHeaderData.length) {
    const cTag = decodeVarint(signedHeaderData, cCursor);
    cCursor += cTag.bytesRead;
    const cNum = cTag.value >> 3;
    const cWire = cTag.value & 0x07;

    if (cWire === 2) {
      const cLen = decodeVarint(signedHeaderData, cCursor);
      cCursor += cLen.bytesRead;
      const cVal = signedHeaderData.subarray(cCursor, cCursor + cLen.value);
      cCursor += cLen.value;
      if (cNum === 1) crxId = cVal;
    } else if (cWire === 0) {
      const cSkip = decodeVarint(signedHeaderData, cCursor);
      cCursor += cSkip.bytesRead;
    } else {
      break;
    }
  }

  const expectedCrxId = crypto
    .createHash('sha256')
    .update(proof.publicKey)
    .digest()
    .subarray(0, 16);
  const crxIdMatches = Boolean(crxId && crxId.equals(expectedCrxId));

  // Cryptographic signature verification
  const prefix = Buffer.from('CRX3 SignedData\x00', 'utf8');
  const signedDataLength = Buffer.alloc(4);
  signedDataLength.writeUInt32LE(signedHeaderData.length, 0);

  const verifier = crypto.createVerify('sha256');
  verifier.update(prefix);
  verifier.update(signedDataLength);
  verifier.update(signedHeaderData);
  verifier.update(archiveBuffer);

  let isSignatureValid = false;
  try {
    const pubKeyObj = crypto.createPublicKey({
      key: proof.publicKey,
      format: 'der',
      type: 'spki',
    });
    isSignatureValid = verifier.verify(pubKeyObj, proof.signature);
  } catch (_err) {
    isSignatureValid = false;
  }
  const isValidSignature = crxIdMatches && isSignatureValid;
  const appId = computeAppId(proof.publicKey);

  return {
    magic,
    version,
    headerLength,
    appId,
    publicKeyBase64: proof.publicKey.toString('base64'),
    archiveBuffer,
    isValidSignature,
  };
}

// Alias for compatibility
export const verifyCrx3 = parseCrx3Header;

// ---------------------------------------------------------------------------
// 7. Omaha Protocol v2.0 XML Manifest Generation
// ---------------------------------------------------------------------------

/**
 * Escapes characters with special meaning in XML attribute values according to W3C XML 1.0.
 *
 * @param {string | number} str
 * @returns {string} XML attribute-safe escaped string
 */
export function escapeXmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/**
 * Generates an Omaha v2.0 XML update manifest string adhering to Chromium update specifications.
 *
 * @param {{
 *   appId: string,
 *   codebase: string,
 *   version: string,
 *   prodversionmin?: string
 * }} options
 * @returns {string} XML formatted string
 */
export function generateUpdateXml({ appId, codebase, version, prodversionmin = '116.0.0.0' }) {
  if (!appId || typeof appId !== 'string') {
    throw new Error('appId must be a non-empty string');
  }
  if (!/^[a-p]{32}$/.test(appId)) {
    throw new Error(`Invalid extension App ID: must be 32 characters in [a-p] (got: "${appId}")`);
  }
  if (!codebase || typeof codebase !== 'string') {
    throw new Error('codebase must be a non-empty string');
  }
  if (!version || typeof version !== 'string') {
    throw new Error('version must be a non-empty string');
  }

  const safeAppId = escapeXmlAttr(appId);
  const safeCodebase = escapeXmlAttr(codebase);
  const safeVersion = escapeXmlAttr(version);
  const prodAttr = prodversionmin ? ` prodversionmin='${escapeXmlAttr(prodversionmin)}'` : '';

  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${safeAppId}'>
    <updatecheck codebase='${safeCodebase}' version='${safeVersion}'${prodAttr} />
  </app>
</gupdate>
`;
}

// ---------------------------------------------------------------------------
// 8. Key Management & Release Orchestration
// ---------------------------------------------------------------------------

/**
 * Loads or generates an RSA 2048-bit private key.
 *
 * @param {string} keyPath
 * @returns {{ privateKeyPem: string, isNewlyGenerated: boolean }}
 */
export function ensurePrivateKey(keyPath) {
  if (fs.existsSync(keyPath)) {
    return {
      privateKeyPem: fs.readFileSync(keyPath, 'utf8'),
      isNewlyGenerated: false,
    };
  }

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const dir = path.dirname(keyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  return {
    privateKeyPem: privateKey,
    isNewlyGenerated: true,
  };
}

/**
 * End-to-end packaging function generating CRX, ZIP, updates.xml, and release metadata.
 *
 * @param {object} options
 * @param {string} [options.rootDir] Project directory containing manifest.json
 * @param {string} [options.keyPath] Path to private key PEM
 * @param {string} [options.outDir] Destination directory for artifacts
 * @param {string} [options.updateUrl] Hosted updates.xml URL
 * @param {string} [options.codebaseUrl] Hosted CRX codebase download URL
 * @param {string} [options.version] Extension version override
 * @param {string} [options.prodversionmin] Minimum Chrome version
 * @returns {object} Summary of generated release artifacts
 */
export function packageRelease(options = {}) {
  const rootDir = path.resolve(
    options.rootDir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  );
  const keyPath = path.resolve(options.keyPath || path.join(rootDir, 'key.pem'));
  const outDir = path.resolve(options.outDir || path.join(rootDir, 'dist'));
  const updateUrl =
    options.updateUrl ||
    'https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/dist/updates.xml';
  const codebaseUrl =
    options.codebaseUrl ||
    'https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/dist/tab-sleuth.crx';
  const prodversionmin = options.prodversionmin || '116.0.0.0';

  // 1. Read manifest.json
  const manifestPath = path.join(rootDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in rootDir: ${rootDir}`);
  }
  const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const version = options.version || manifest.version || '1.0.0';

  // 2. Ensure RSA private key & derive App ID
  const { privateKeyPem, isNewlyGenerated } = ensurePrivateKey(keyPath);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKeyDer = crypto
    .createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' });
  const publicKeyBase64 = publicKeyDer.toString('base64');
  const appId = computeAppId(publicKeyDer);

  // 3. Synchronize manifest.json key and update_url if needed
  let manifestUpdated = false;
  if (manifest.key !== publicKeyBase64) {
    manifest.key = publicKeyBase64;
    manifestUpdated = true;
  }
  if (!manifest.update_url) {
    manifest.update_url = updateUrl;
    manifestUpdated = true;
  }
  if (manifestUpdated) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  // 4. Collect extension files & build ZIP archive
  const entries = collectExtensionFiles(rootDir);
  const zipBuffer = createZipBuffer(entries);

  // 5. Generate and sign CRX3 package
  const { crx } = generateCrx3({ zipBuffer, privateKeyPem });

  // 6. Verify generated CRX3 binary
  const verified = parseCrx3Header(crx);
  if (!verified.isValidSignature) {
    throw new Error('Self-verification failed: generated CRX3 signature is invalid');
  }

  // 7. Generate Omaha v2.0 XML
  const updateXml = generateUpdateXml({
    appId,
    codebase: codebaseUrl,
    version,
    prodversionmin,
  });

  // 8. Generate release metadata
  const sha256 = crypto.createHash('sha256').update(crx).digest('hex');
  const metadata = {
    version,
    appId,
    sha256,
    crxSize: crx.length,
    zipSize: zipBuffer.length,
    generatedAt: new Date().toISOString(),
    updateUrl,
    codebase: codebaseUrl,
    filesPackaged: entries.map((e) => e.name),
  };

  // 9. Write artifacts to output directory
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const crxFile = path.join(outDir, 'tab-sleuth.crx');
  const zipFile = path.join(outDir, 'tab-sleuth.zip');
  const xmlFile = path.join(outDir, 'updates.xml');
  const metaFile = path.join(outDir, 'release-metadata.json');

  fs.writeFileSync(crxFile, crx);
  fs.writeFileSync(zipFile, zipBuffer);
  fs.writeFileSync(xmlFile, updateXml, 'utf8');
  fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  return {
    rootDir,
    keyPath,
    outDir,
    appId,
    version,
    sha256,
    isNewlyGeneratedKey: isNewlyGenerated,
    files: {
      crx: crxFile,
      zip: zipFile,
      xml: xmlFile,
      metadata: metaFile,
    },
    metadata,
    verified,
  };
}

// ---------------------------------------------------------------------------
// 9. CLI Invocations
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--key=')) {
      options.keyPath = arg.slice(6);
    } else if (arg === '--key' && i + 1 < args.length) {
      options.keyPath = args[++i];
    } else if (arg.startsWith('--out=')) {
      options.outDir = arg.slice(6);
    } else if (arg === '--out' && i + 1 < args.length) {
      options.outDir = args[++i];
    } else if (arg.startsWith('--update-url=')) {
      options.updateUrl = arg.slice(13);
    } else if (arg === '--update-url' && i + 1 < args.length) {
      options.updateUrl = args[++i];
    } else if (arg.startsWith('--codebase-url=')) {
      options.codebaseUrl = arg.slice(15);
    } else if (arg === '--codebase-url' && i + 1 < args.length) {
      options.codebaseUrl = args[++i];
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice(10);
    } else if (arg === '--version' && i + 1 < args.length) {
      options.version = args[++i];
    }
  }
  return options;
}

function printHelp() {
  console.log(`
Tab-Sleuth - CRX3 Release Packager & Auto-Update Pipeline

USAGE:
  node scripts/package-release.mjs [options]

OPTIONS:
  --key=<path>           Path to RSA private key PEM (default: key.pem)
  --out=<dir>            Output directory for release artifacts (default: dist/)
  --update-url=<url>     URL to hosted updates.xml
  --codebase-url=<url>   Download URL to hosted tab-sleuth.crx
  --version=<ver>        Override extension version
  -h, --help             Show this help message

GENERATED ARTIFACTS:
  <out>/tab-sleuth.crx         Signed Chromium CRX3 binary
  <out>/tab-sleuth.zip         Standard ZIP archive for distribution
  <out>/updates.xml             Omaha v2.0 update manifest
  <out>/release-metadata.json   Release checksums, App ID, and metadata
`);
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  try {
    console.log('📦 Packaging Tab-Sleuth extension release...');
    const result = packageRelease(cliArgs);

    console.log('\n✅ Packaging complete!');
    console.log(`  Extension App ID : ${result.appId}`);
    console.log(`  Version          : ${result.version}`);
    console.log(`  CRX Package      : ${result.files.crx} (${result.metadata.crxSize} bytes)`);
    console.log(`  CRX SHA-256      : ${result.sha256}`);
    console.log(`  ZIP Archive      : ${result.files.zip} (${result.metadata.zipSize} bytes)`);
    console.log(`  Update Manifest  : ${result.files.xml}`);
    console.log(`  Release Metadata : ${result.files.metadata}`);
    console.log(`  Signature Status : ${result.verified.isValidSignature ? 'VALID ✔' : 'INVALID ❌'}`);
    console.log(`  Files Packaged   : ${result.metadata.filesPackaged.length} files`);
  } catch (err) {
    console.error('\n❌ Packaging failed:', err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
}
