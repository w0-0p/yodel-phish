# Security policy

## Supported versions

The current 0.1.x beta line receives security fixes. Pre-beta development
snapshots are not supported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository when it is
available. If it is unavailable, open a non-sensitive issue asking the
maintainers to establish a private channel. Do not place exploit details,
credentials, private browsing data, victim screenshots, or malicious payloads
in a public issue.

Useful reports identify the affected version, browser version, reproduction
conditions, impact, and a minimal synthetic proof of concept. There is no
guaranteed response-time SLA during beta.

Relevant areas include extension permissions, messaging boundaries, policy
bypasses, local-storage exposure, build/package integrity, dependency or model
substitution, and the checksum-verifying model downloader.

The downloader accepts only HTTPS resources recorded in
`Models/models.lock.json`, verifies exact byte counts and SHA-256 digests,
and installs files atomically. The installed extension never downloads those
model assets at runtime.

Please test in an isolated browser profile and use synthetic data.

