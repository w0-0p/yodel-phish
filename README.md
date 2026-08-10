# Yodel Phish

Yodel Phish is a Chromium browser extension that helps detect login-page
impersonation, ClickFix-style clipboard attacks, and suspicious OAuth
device-code navigation. Detection runs locally with OCR, OpenCV, YOLO, and
DINOv2.

> **Beta software:** version 0.1.0 is intended for testing.

## Privacy

The installed extension performs screenshot, OCR, and model inference locally.
It has no telemetry or runtime upload endpoint. Some protection and
trusted-site data is stored in Chrome extension storage. Developer Mode can
also retain up to 25 hostname-only diagnostic records, logo-crop OCR evidence,
and a compared-logo crop; those records can be exported or cleared from
Settings.

See [PRIVACY.md](PRIVACY.md) for the complete data and retention description.

## Requirements

- Chrome or another compatible Chromium browser, version 116 or later
- Node.js 24 (the exact development version is in `.nvmrc`)
- npm
- `zip` for producing the release archive

## Build from a fresh clone

```sh
git clone https://github.com/w0-0p/yodel-phish.git
cd yodel-phish/Extension
npm ci
npm run models:download
npm run typecheck
npm test
npm run build
```

The build is written to `build/extension/`
Exact filenames, sizes, and hashes are recorded in [Models/models.lock.json](Models/models.lock.json).

## Test and package

```sh
cd Extension
npm test
npm run typecheck

# Optional browser integration tests:
npx playwright install chromium
npm run test:integration

# Clean build, validation, and ZIP creation:
npm run package
```

The ZIP is written as `build/yodel-phish-0.1.0.zip`. Packaging uses an
explicit allowlist, verifies model hashes again, and places `manifest.json`
at the archive root. It also writes
`build/yodel-phish-0.1.0.zip.SOURCE.txt`, which identifies the corresponding
source for that exact version and must be distributed beside the ZIP.

## Release distribution

Every GitHub release and browser-store listing that distributes version
`0.1.0` must place this statement beside its download or install action:

> Source code for Yodel Phish 0.1.0 (AGPL-3.0-only):
> https://github.com/w0-0p/yodel-phish/tree/v0.1.0

The version in the URL must match the distributed package. Create and publish
the matching immutable Git tag before making the ZIP or store listing public.
See [RELEASING.md](RELEASING.md) for the release checklist and reusable text.

To test the unpacked extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode** in Chrome.
3. Select **Load unpacked**.
4. Choose `build/extension/`.

## Advanced settings

Advanced settings let users switch between strict and warn modes for ClickFix and device-flow endpoint controls, and activate diagnostic history.


## Permissions

| Permission | Purpose |
| --- | --- |
| `<all_urls>` | Run phishing, ClickFix, and login detection on arbitrary pages, and capture the visible page for automatic analysis. |
| `webNavigation` | Observe navigation and coordinate warnings, interruptions, and device-code protection. |
| `storage`, `unlimitedStorage` | Store settings, trusted references and local diagnostics. |
| `scripting` | Collect page geometry and run the trusted-logo selector. |
| `offscreen` | Host local OCR, OpenCV, ONNX inference, and clipboard mediation. |
| `clipboardWrite` | Write text after the configured ClickFix policy is applied. |
| `alarms` | Expire short-lived warning and device-flow state. |

## Repository layout

```text
Extension/             extension pages, scripts, tests and build configuration
src/detection/         production detection pipeline and browser adapters
Models/                tracked model metadata and checksum/download lock
scripts/               model, build, package and public-tree verification
tests/integration/     browser integration tests and test-only fixture
third_party_licenses/  license texts for packaged dependencies and models
build/                 generated locally; ignored by Git
```

## Model integrity and provenance

| Artifact | SHA-256 |
| --- | --- |
| DINOv2 ViT-S/14 ONNX | `5f3f1192ec107a89e4add77eaf88635a5fe1bd044f7c085b2999c1ab4608601b` |
| Yodel YOLO logo detector ONNX | `2fab9d367a0d740730e54e72e14b4a507b3aad89b98a9252fa2413cdb216bf8b` |
| English Tesseract data | `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747` |

See [Models/README.md](Models/README.md), the model metadata, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The Yodel YOLO logo detector used a selected 500-screenshot subset of
*Phishing Website Dataset*, version 1, by I Kadek Agus Ariesta Putra,
[Zenodo DOI 10.5281/zenodo.8041387](https://doi.org/10.5281/zenodo.8041387),
licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Yodel Phish added
logo bounding-box annotations, created a 400/100 training/validation split,
and fine-tuned and exported the detector. The original dataset is not
redistributed by this repository. No endorsement is implied.

## Security, contributing and support

- Report vulnerabilities according to [SECURITY.md](SECURITY.md).
- See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes.
- Use [GitHub Issues](https://github.com/w0-0p/yodel-phish/issues) for
  non-sensitive bugs and beta feedback.

## License

Yodel Phish is licensed under `AGPL-3.0-only`, the GNU Affero General Public
License version 3 only.
Third-party components retain their respective licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
