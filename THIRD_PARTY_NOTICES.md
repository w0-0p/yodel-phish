# Third-party notices

Yodel Phish is distributed under `AGPL-3.0-only`, the GNU Affero General
Public License version 3 only.
The extension also incorporates or packages the following third-party
components and data. Their licenses remain applicable to those components.

## Models

- **DINOv2 ViT-S/14** — Copyright Meta Platforms, Inc. and affiliates;
  Apache License 2.0. The browser ONNX export is derived from the official
  DINOv2 source revision
  `7764ea0f912e53c92e82eb78a2a1631e92725fc8`. See
  `Models/dinov2_vits14_export_metadata.json` and
  `third_party_licenses/DINOv2-Apache-2.0.txt`.
- **Ultralytics YOLOv8n / Yodel logo detector** — the distributed ONNX file
  identifies Ultralytics 8.4.60 and the AGPL-3.0 license. See
  `Models/yolo-logo_provenance.json` and
  `third_party_licenses/Ultralytics-AGPL-3.0.txt`.

## Training dataset

- **Phishing Website Dataset**, version 1 — by I Kadek Agus Ariesta Putra;
  Zenodo DOI
  [10.5281/zenodo.8041387](https://doi.org/10.5281/zenodo.8041387),
  licensed under
  [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
  Yodel Phish used a selected subset of 500 screenshots, added logo
  bounding-box annotations, created a 400/100 training/validation split, and
  fine-tuned and exported the Yodel logo detector. The original dataset is
  not redistributed with the source repository or extension. No endorsement
  by the dataset creator is implied. See
  `third_party_licenses/Phishing-Website-Dataset-CC-BY-4.0.txt`.

## Runtime libraries and language data

- **ONNX Runtime Web 1.26.0** — Copyright Microsoft Corporation; MIT License.
- **OpenCV.js 4.12.0** via `@techstark/opencv-js` 4.12.0-release.1 —
  Apache License 2.0. The build applies a local Content Security Policy
  compatibility transformation to the packaged JavaScript.
- **Tesseract.js 5.1.1 and tesseract.js-core 5.1.1** — Apache License 2.0.
  The copied Tesseract worker also embeds `buffer` (MIT), `ieee754`
  (BSD-3-Clause), `regenerator-runtime` (MIT), and `zlib.js` (MIT). Their
  upstream generated notices are packaged beside the worker as
  `tesseract/worker.min.js.LICENSE.txt`.
- **English Tesseract language data** from
  `@tesseract.js-data/eng` 1.0.0 — Apache License 2.0.
- **tldts and tldts-core 6.1.86** — MIT License.

Corresponding license texts and attribution notices are under
`third_party_licenses/`. Minified bundles may additionally contain generated
`.LICENSE.txt` notice files.

This inventory covers dependencies deliberately packaged into the extension.
Build-only packages remain governed by the license metadata in their npm
packages and lockfile.
