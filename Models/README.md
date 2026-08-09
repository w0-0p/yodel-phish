# Model assets

Large binary assets are deliberately not tracked in Git. Their exact URLs,
sizes, compression formats, destinations, and SHA-256 digests are pinned in
`models.lock.json`.

From `Extension/`:

```sh
npm run models:download
npm run models:verify
```

Downloads are build-time only. The installed extension loads packaged assets
through `chrome.runtime.getURL()` and does not download models at runtime.

The DINOv2 and Yodel YOLO files are expected under the production repository's
`models-v0.1.0` GitHub release. Those two release assets must be published
before a fresh clone can download them. The English Tesseract data comes from a
version-pinned upstream package. Every file is written through a temporary file
and installed only after its size and digest match the lock.
