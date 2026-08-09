# Changelog

## 0.1.0 — beta

- Initial public beta source release.
- Local login-page impersonation detection using OCR, OpenCV, YOLO and DINOv2.
- ClickFix clipboard protection.
- OAuth device-code navigation protection.
- Advanced Developer Mode, diagnostics history, policy overrides and custom
  endpoints retained for beta testing.
- Analysis history (schema 2) records only what its menu explains a verdict
  with: full diagnostics for the winning reference, a comparison-table row per
  remaining candidate, and no transcription of the analysed page's text. Cards
  omit absent fields and empty sections; failed analyses render their context
  and failure code instead of an empty completed-analysis grid.
- Diagnostic records identify the analysed page by hostname only. Its full
  address is no longer stored or displayed — a URL can carry session tokens,
  reset codes or personal data that say nothing about a verdict — and records
  written by earlier versions are stripped on startup.

