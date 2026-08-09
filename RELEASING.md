# Releasing Yodel Phish

Every distributed extension package must have corresponding source available
for the exact same version under `AGPL-3.0-only`.

For version `0.1.0`:

1. Create the immutable Git tag `v0.1.0` from the exact source commit used to
   build the extension.
2. Run `npm run package` from `Extension/`.
3. Distribute `build/yodel-phish-0.1.0.zip.SOURCE.txt` beside
   `build/yodel-phish-0.1.0.zip` and do not rename or omit the source notice.
4. Put the following text in the GitHub release body, immediately beside the
   ZIP asset description:

   > Source code for Yodel Phish 0.1.0 (AGPL-3.0-only):
   > https://github.com/w0-0p/yodel-phish/tree/v0.1.0

5. Put the same statement in the browser-store listing or its version-specific
   release notes, close to the install/download information.
6. Confirm that the tag URL works without authentication before publishing.

For later releases, replace every occurrence of `0.1.0` with the extension
version. The source tag and package version must match exactly.
