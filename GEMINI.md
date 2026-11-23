# Tab-Sleuth Project Guidelines

## Release & Deployment Rule
- **Always commit and update release**:
  Whenever any feature, UI improvement, or bug fix is implemented and verified:
  1. Verify the test suite passes: `node --test tests/extension.test.mjs tests/e2e-suite.test.mjs`.
  2. Bump the patch version in `manifest.json`.
  3. Package the release:
     `node scripts/package-release.mjs --key=key.pem --version=<VERSION> --update-url="https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/dist/updates.xml" --codebase-url="https://github.com/trannguyendev/tabscan-sleuth/releases/download/v<VERSION>/tab-sleuth.crx"`
  4. Commit all changes to git and push to `origin main`.
  5. Publish the GitHub release using `gh release create v<VERSION>` with all 4 assets (`Install-TabSleuth.bat`, `update.bat`, `dist/tab-sleuth.zip`, `dist/tab-sleuth.crx`).
