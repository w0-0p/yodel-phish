# Privacy

Effective date: 2026-08-09

This document describes version 0.1.0 of the Yodel Phish browser extension.

## Summary

Yodel Phish analyzes pages locally in the browser. The installed extension
does not include telemetry, advertising, analytics, or a runtime endpoint that
uploads screenshots, browsing history, OCR text, model inputs, or clipboard
content. Build-time model downloads are not performed by the installed
extension.

## Data processed for protection

Depending on the enabled feature, the extension can process page URLs,
hostnames, tab and navigation state, a screenshot of the visible active-tab
viewport, login-field and control geometry, OCR text and word geometry,
detected logo regions and crops, embeddings, comparison scores, copied command
text and its source URL, and device-code navigation relationships.

OCR, OpenCV and ONNX inference run in the extension's local offscreen
document. **Full screenshots are not retained in persistent storage.**

## Persistent local storage

Chrome extension storage can contain protection settings, policy overrides,
custom device-flow endpoints, trusted or muted domains, trusted-reference
source URLs and visit dates, logo crops, OCR labels or words, model features
and embeddings, and comparison scores. This information stays in
browser-managed extension storage unless the user exports or shares it.

## Advanced Settings diagnostics

When the application's Advanced Settings and analysis history are enabled, the
extension retains at most the 25 most recent diagnostic records. A record can
include the analysed page's hostname and a timestamp, extension and policy
state, verdicts, scores and timing data, matched trusted-reference information,
the brand words matched or rejected by OCR, logo-crop OCR text, and the
compared-logo crop image.

A record does not retain the page's own OCR text, nor its address beyond the
hostname. A scanned local file is identified by a digest of its address rather
than by the path itself.

Settings provides controls to export this history as JSON and to clear it.
Exports can contain sensitive browsing information and should be reviewed
before sharing. The extension explicitly does not append analysis-history
records while operating in incognito mode.

## Temporary session storage

- ClickFix warning state can retain copied text and its source URL for up to
  five minutes.
- Device-flow navigation relationships and source origins can be retained for
  up to 15 minutes.
- Same-tab device-flow source state can be retained for up to one minute.

These records use session storage and expire automatically.

## Clipboard access

The extension uses an offscreen document to write requested text to the
clipboard after applying the configured ClickFix policy. **It does not
continuously read the clipboard.**

## Retention and deletion

Trusted or muted entries can be removed from Settings. Analysis history has a
dedicated clear action. Resetting protection settings does not necessarily
delete every trusted entry or diagnostic record; use the corresponding
clear/remove controls. Removing the extension causes Chrome to remove its
extension-managed storage. Exported JSON files must be deleted separately.

## External services

The installed extension has no first-party telemetry or model-download
service. Following the support link to GitHub is an explicit user action and
is governed by GitHub's privacy terms.

For non-sensitive questions, use
https://github.com/w0-0p/yodel-phish/issues. Security reports should follow
[SECURITY.md](SECURITY.md).
