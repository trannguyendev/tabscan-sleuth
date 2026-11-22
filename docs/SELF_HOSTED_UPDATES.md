# Self-Hosted Auto-Update Pipeline & CRX3 Deployment Guide

This guide details the architecture, packaging pipeline, distribution workflow, and enterprise deployment strategies for self-hosting the **TabScan Q&A** Chrome Manifest V3 extension. By using Google's native Omaha v2.0 protocol and cryptographically signed CRX3 packages, updates are delivered automatically and silently to existing installs without dependency on the Chrome Web Store or paying developer registration fees.

---

## 1. Architecture & Protocol Overview

### 1.1 The Omaha v2.0 Update Protocol

Chromium-based browsers (Google Chrome, Microsoft Edge, Brave, Opera) check for extension updates periodically in the background (typically every 4 to 5 hours and upon browser startup). The update check mechanism utilizes Google's Omaha v2.0 XML protocol:

1. **Update Manifest Registration**:
   `manifest.json` specifies the remote update endpoint:
   ```json
   "update_url": "https://raw.githubusercontent.com/username/tabscan-qa/main/dist/updates.xml"
   ```

2. **Polling Mechanism**:
   The browser sends an HTTP GET request to `update_url` appending query parameters detailing the installed extension ID, installed version, and browser version:
   ```
   GET /updates.xml?x=id%3D<EXTENSION_ID>%26v%3D<VERSION>%26uc HTTP/1.1
   Host: raw.githubusercontent.com
   User-Agent: Mozilla/5.0 ... Chrome/...
   ```
   *Note*: Static hosting platforms (such as GitHub Pages, GitHub Releases, Amazon S3, and Cloudflare R2) ignore query parameters and return the static XML manifest directly with HTTP 200 OK.

3. **Omaha XML Schema**:
   The response returns an XML document conforming to the Omaha v2.0 schema:
   ```xml
   <?xml version='1.0' encoding='UTF-8'?>
   <gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
     <app appid='jjoepgfpagdecpcbabppbbnblaeklpic'>
       <updatecheck
         codebase='https://raw.githubusercontent.com/username/tabscan-qa/main/dist/tab-scan-qa.crx'
         version='1.0.1'
         prodversionmin='116.0.0.0' />
     </app>
   </gupdate>
   ```

4. **Version Evaluation & Download**:
   - Chromium compares the local version against the XML `version` attribute using semantic version precedence.
   - If `remote_version > local_version` and the running browser satisfies `prodversionmin` (e.g., Chrome 116+ required for MV3 SidePanel API), the browser downloads the `.crx` file from `codebase`.
   - Chromium cryptographically validates the downloaded CRX3 against the pinned public key, unpacks the archive, and schedules the update.
   - The update applies immediately on the next extension reload or browser restart.

---

### 1.2 Deterministic Extension App ID & Key Binding

Chromium derives an extension's unique 32-character ID strictly from the SubjectPublicKeyInfo (SPKI) DER representation of its RSA public key:

$$\text{App ID} = \text{HexEncode}(\text{SHA256}(\text{SPKI\_DER})[0..15]) \xrightarrow{0 \to \text{'a'}, \dots, 15 \to \text{'p'}} [a\text{-}p]^{32}$$

To ensure the extension App ID remains **100% stable** across developer unpacked installations, packaged CRX installations, and enterprise deployments, the public key is pinned directly in `manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "TabScan Q&A",
  "version": "1.0.0",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...",
  "update_url": "https://raw.githubusercontent.com/username/tabscan-qa/main/dist/updates.xml"
}
```

---

### 1.3 CRX3 Binary Format Specification

CRX3 is Chromium's third-generation extension package format (`components/crx_file/crx3.proto`). It encapsulates an embedded ZIP archive preceded by a cryptographic signature header:

```
+-----------------------------------------------------------------------+
| Magic Bytes: 'Cr24' (4 bytes: 0x43, 0x72, 0x32, 0x34)                 |
+-----------------------------------------------------------------------+
| Version: uint32 LE = 3 (4 bytes: 0x03, 0x00, 0x00, 0x00)              |
+-----------------------------------------------------------------------+
| Header Length: uint32 LE (4 bytes: length N of CrxFileHeader Protobuf) |
+-----------------------------------------------------------------------+
| CrxFileHeader Protobuf Payload (N bytes)                              |
|   - Field 2 (sha256_with_rsa): AsymmetricKeyProof                    |
|       - Field 1 (public_key): SPKI DER bytes                          |
|       - Field 2 (signature): 256-byte RSA-SHA256 signature           |
|   - Field 10000 (signed_header_data): SignedData                     |
|       - Field 1 (crx_id): 16-byte raw SHA-256 slice of SPKI DER       |
+-----------------------------------------------------------------------+
| Embedded ZIP Archive (Deflated extension payload)                     |
+-----------------------------------------------------------------------+
```

**Digital Signature Formulation**:
The RSA signature is computed using PKCS#1 v1.5 with SHA-256 over:
$$\text{Signature} = \text{Sign}_{\text{RSA}}\Big(\text{"CRX3 SignedData\x00"} \;\|\; \text{LE32}(\text{len}(\text{SignedData})) \;\|\; \text{SignedData} \;\|\; \text{ZIP Archive}\Big)$$

---

## 2. Release Packaging Pipeline

The repository provides a standalone, zero-dependency Node.js packaging script at `scripts/package-release.mjs` using only built-in Node.js modules (`node:crypto`, `node:fs`, `node:path`, `node:zlib`).

### 2.1 CLI Usage

Run the release script from the repository root:

```bash
node scripts/package-release.mjs
```

#### CLI Options
| Option | Description | Default |
|---|---|---|
| `--key=<path>` | Path to RSA 2048 private key PEM | `key.pem` (auto-generated if missing) |
| `--out=<dir>` | Output directory for release artifacts | `dist/` |
| `--update-url=<url>` | URL to remote `updates.xml` | `https://raw.githubusercontent.com/username/tabscan-qa/main/dist/updates.xml` |
| `--codebase-url=<url>` | Download URL to remote `.crx` file | `https://raw.githubusercontent.com/username/tabscan-qa/main/dist/tab-scan-qa.crx` |
| `--version=<ver>` | Version string override | Reads `"version"` from `manifest.json` |
| `-h, --help` | Display usage instructions | — |

#### Example Invocation with Custom Hosting
```bash
node scripts/package-release.mjs \
  --key=secrets/tabscan-release.pem \
  --out=dist \
  --update-url=https://cdn.example.com/tabscan/updates.xml \
  --codebase-url=https://cdn.example.com/tabscan/tab-scan-qa-1.0.0.crx
```

### 2.2 Generated Artifacts

Executing the script creates four production artifacts in `dist/`:

1. **`dist/tab-scan-qa.crx`**: Cryptographically signed CRX3 package ready for download and browser installation.
2. **`dist/tab-scan-qa.zip`**: Clean ZIP archive containing all extension assets, excluding development artifacts (tests, docs, keys).
3. **`dist/updates.xml`**: Omaha v2.0 update manifest referencing the generated App ID, version, and codebase URL.
4. **`dist/release-metadata.json`**: Audit ledger with version, App ID, SHA-256 hash, byte counts, and packaged file list.

---

### 2.3 Programmatic API Reference

`scripts/package-release.mjs` exports reusable functions for CI/CD scripting and testing:

```javascript
import {
  computeAppId,
  generateCrx3,
  generateUpdateXml,
  escapeXmlAttr,
  parseCrx3Header,
  createZipBuffer,
  packageRelease,
} from './scripts/package-release.mjs';

// 1. Calculate App ID from SPKI DER public key
const appId = computeAppId(publicKeyDer);

// 2. Package and sign CRX3 from an in-memory ZIP buffer
const { crx, publicKeyBase64 } = generateCrx3({
  zipBuffer,
  privateKeyPem,
});

// 3. Generate Omaha v2.0 update manifest XML (with automatic XML attribute entity escaping)
const xml = generateUpdateXml({
  appId: 'jjoepgfpagdecpcbabppbbnblaeklpic',
  codebase: 'https://cdn.example.com/tabscan.crx?token=123&expiry=456',
  version: '1.0.0',
  prodversionmin: '116.0.0.0',
});

// 4. Validate and verify any CRX3 file (defensive error handling for malformed keys)
const verification = parseCrx3Header(crxBuffer);
console.log(verification.isValidSignature); // true
console.log(verification.appId);            // 'jjoepgfpagdecpcbabppbbnblaeklpic'
```

---

## 3. End-User Installation Guide

For individual users installing outside the Chrome Web Store without domain enterprise policies, Chrome allows off-store CRX installation via Developer Mode.

### Step-by-Step Installation

1. **Download the CRX Package**:
   Download `tab-scan-qa.crx` from the project's release page.

2. **Open Extension Management**:
   Navigate to `chrome://extensions` (or `edge://extensions` on Microsoft Edge) in the browser address bar.

3. **Enable Developer Mode**:
   Toggle the **Developer mode** switch in the top-right corner to **ON**.

4. **Drag and Drop**:
   Drag the downloaded `tab-scan-qa.crx` file directly from your file manager onto the `chrome://extensions` window.

5. **Confirm Installation**:
   When prompted with *"Add TabScan Q&A? It can read and change your data on all websites"*, click **Add extension**.

6. **Automatic Background Updates**:
   Once installed via drag-and-drop, Chrome registers the extension with its embedded `update_url`. The browser will automatically check `updates.xml`, download newer versions, and apply them in the background without requiring future manual drag-and-drop actions.

---

## 4. Enterprise Deployment & Silent Auto-Update

Enterprise administrators can silently deploy TabScan Q&A to managed machines and force automated background updates with zero user interaction.

### 4.1 Windows Deployment (Group Policy & Registry)

Chromium checks `ExtensionInstallForcelist` in the Windows Registry to automatically download, install, and update extensions.

#### Registry Key Location
- **Google Chrome**: `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist` (Machine-wide) or `HKCU\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist` (Current User)
- **Microsoft Edge**: `HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist`

#### Value Format
Each entry is a string (`REG_SZ`) where the value data has the format:
```
<APP_ID>;<UPDATE_URL>
```

#### PowerShell Deployment Example
Open PowerShell as Administrator:

```powershell
$AppId = "jjoepgfpagdecpcbabppbbnblaeklpic"
$UpdateUrl = "https://raw.githubusercontent.com/username/tabscan-qa/main/dist/updates.xml"
$RegPath = "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"

if (!(Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
}

# The registry value name is an incremental integer (1, 2, 3...)
Set-ItemProperty -Path $RegPath -Name "1" -Value "$AppId;$UpdateUrl"
Write-Host "TabScan Q&A force-install policy registered successfully."
```

#### Immediate Policy Verification
1. Navigate to `chrome://policy`.
2. Click **Reload policies**.
3. Confirm `ExtensionInstallForcelist` appears with Status **OK**.
4. Navigate to `chrome://extensions`. TabScan Q&A is installed and managed by policy.

---

### 4.2 macOS Deployment (Configuration Profiles & Plist)

On macOS, managed policies are configured via MDM (Jamf, Kandji, Intune) or via managed preference plists.

#### Plist Configuration
Create or update `/Library/Managed Preferences/com.google.Chrome.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ExtensionInstallForcelist</key>
  <array>
    <string>jjoepgfpagdecpcbabppbbnblaeklpic;https://raw.githubusercontent.com/username/tabscan-qa/main/dist/updates.xml</string>
  </array>
</dict>
</plist>
```

---

### 4.3 Linux Deployment (JSON Policy Files)

On Linux distributions (Debian, Ubuntu, Fedora, RHEL), managed policies are stored in JSON configuration files.

#### Configuration Path
Create `/etc/opt/chrome/policies/managed/tabscan.json`:

```json
{
  "ExtensionInstallForcelist": [
    "jjoepgfpagdecpcbabppbbnblaeklpic;https://raw.githubusercontent.com/username/tabscan-qa/main/dist/updates.xml"
  ]
}
```

Set file permissions:
```bash
sudo chmod 644 /etc/opt/chrome/policies/managed/tabscan.json
```

---

## 5. Hosting Releases on GitHub

GitHub Pages and GitHub Releases provide reliable, high-availability, zero-cost HTTPS hosting for self-hosted Chrome extension updates.

### Workflow: Publishing a New Release

1. **Bump Version**:
   Update `"version"` in `manifest.json` (e.g. from `1.0.0` to `1.0.1`).

2. **Package Release**:
   ```bash
   node scripts/package-release.mjs
   ```

3. **Push Artifacts**:
   Commit the generated `dist/` artifacts (`tab-scan-qa.crx` and `updates.xml`) and push to your GitHub repository:
   ```bash
   git add manifest.json dist/
   git commit -m "chore(release): package TabScan Q&A v1.0.1"
   git push origin main
   ```

4. **GitHub Releases Hosting (Alternative)**:
   If hosting files as GitHub Release assets:
   - Tag the release: `git tag v1.0.1 && git push origin v1.0.1`
   - Create a GitHub Release and upload `dist/tab-scan-qa.crx`.
   - Update `updates.xml` codebase URL to point to the GitHub Release download URL:
     `https://github.com/username/tabscan-qa/releases/download/v1.0.1/tab-scan-qa.crx`

---

## 6. Security & Key Management

### 6.1 Private Key Secrecy
The RSA private key (`key.pem`) is the cryptographic root of trust for your extension:
- **Never commit `key.pem` to a public repository**. Verify that `.gitignore` includes `key.pem` and `*.pem`.
- **Key Loss**: If `key.pem` is lost, you cannot issue updates for existing installations. The extension App ID will permanently change, requiring every user to reinstall.
- **CI/CD Integration**: In continuous deployment pipelines (e.g., GitHub Actions), store the private key PEM string as a repository secret (e.g., `TABSCAN_RELEASE_KEY`) and write it to disk during the packaging step:
  ```yaml
  - name: Setup Signing Key
    run: echo "${{ secrets.TABSCAN_RELEASE_KEY }}" > key.pem
  - name: Build and Package Release
    run: node scripts/package-release.mjs
  ```

### 6.2 Strict HTTPS Requirements
Chromium mandates HTTPS for all `update_url` endpoints and `codebase` download URLs. Plain HTTP endpoints are rejected for off-store extension updates. Both GitHub Raw (`https://raw.githubusercontent.com/...`) and GitHub Pages (`https://<username>.github.io/...`) provide trusted TLS certificates meeting this requirement.
