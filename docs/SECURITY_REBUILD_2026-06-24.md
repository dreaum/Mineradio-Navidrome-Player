# Security and Release Boundary

This repository is the `0.1.0` Navidrome source branch. Historical Mineradio
release and incident notes under `docs/archive/` are reference material only.

Before publishing source or a Windows build:

- Build only from tracked files. Never publish `userdata/`, `.diag-userdata-*`,
  caches, diagnostics, `dist/`, or local installers.
- Run tests, JavaScript syntax checks, `git diff --check`, and a secret scan over
  both the working tree and complete Git history.
- Navidrome passwords and provider cookies stay in Electron's encrypted per-user
  data directory. They must never appear in renderer state, logs, docs, commits,
  or release assets.
- A local build is not a GitHub Release. Publish installers only after malware
  scanning and checksum generation.
