# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-05

First public release.

### Added

- `aihub` LLM route: user-created models, each served by an ordered list of
  OpenAI-compatible or Anthropic-compatible suppliers.
- Automatic failover for connection errors, timeouts, non-2xx responses and an
  in-band `error` event — but only before the first content chunk is emitted.
- 30-second cooldown that demotes a supplier which just failed to the end of the
  chain, cleared as soon as the settings document is saved.
- Streaming translation for text, reasoning blocks, tool calls, usage/cached
  tokens and images (vision models only; missing images degrade to text).
- Dedicated **AI Hub** settings page with a local draft, inline validation,
  masked API keys, supplier reordering and per-supplier enable flags.
- Failover diagnostics that name the supplier label, real model id and status
  code, and never print a credential.
- Offline test suite: 69 host tests plus 26 client self-checks.
