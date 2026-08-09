# Contributing

Yodel Phish is beta software. Keep pull requests focused and explain security
or privacy effects explicitly.

```sh
cd Extension
npm ci
npm run models:download
npm run typecheck
npm test
npm run build
npm run package:verify
npm run scan
```

Browser integration tests additionally require Playwright Chromium:

```sh
npx playwright install chromium
npm run test:integration
```

Do not commit model binaries, generated output, extension packages, datasets,
real browsing captures, exported diagnostics, credentials, or local tool
configuration. Model changes require updated provenance, immutable
release-asset names, sizes and SHA-256 values in `Models/models.lock.json`.

