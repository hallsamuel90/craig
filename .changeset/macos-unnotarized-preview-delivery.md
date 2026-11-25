---
"craig-cli": patch
---

Prepare an explicitly unnotarized macOS ARM64 standalone preview with policy-gated CI release archives/checksums, reviewed manual attachment support and a versioned Homebrew recipe. Automatic release attachment requires the repository policy CRAIG_BINARY_RELEASE_POLICY=unnotarized-preview. Standalone updates remain manual; npm publishing and updates retain their existing contract.
