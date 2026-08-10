# Model assets

Model binaries are pinned in models.lock.json and downloaded during setup.

From `Extension/`:

```sh
npm run models:download
npm run models:verify
```

The extension uses the packaged model files at runtime; no models are downloaded after installation.

The required DINOv2 and Yodel YOLO assets are published with the corresponding Yodel Phish release.
Tesseract language data is sourced from a version-pinned upstream package.
