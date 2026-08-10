# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository.
If it is unavailable, open a non-sensitive issue asking the
maintainers to establish a private channel. Do not place exploit details,
credentials, private browsing data, victim screenshots, or malicious payloads
in a public issue.

Useful reports identify the affected version, browser version, reproduction environment
(for example, operating system, screen resolution, display scaling, hardware, and relevant extension settings),
impact, and a minimal synthetic proof of concept. There is no guaranteed response-time SLA during beta.

The downloader accepts only HTTPS resources recorded in
`Models/models.lock.json`, verifies exact byte counts and SHA-256 digests,
and installs files atomically. The installed extension never downloads those
model assets at runtime.

