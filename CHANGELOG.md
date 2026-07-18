# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-07-18

### Changed

- Refresh cadence aligned with `pi-grok-usage` model, on a **10-minute** success cooldown
- Idle `setInterval` tick (~9m45s) so the meter updates even without turns
- Also refreshes on `agent_start` (prompt-time) and `turn_end` when cooldown elapsed
- Failures no longer burn the full cooldown (30s error retry; 429 still honors `Retry-After`)

## [1.0.1] - 2026-07-18

### Fixed

- Footer no longer shows `auth?` for every first-fetch failure
- Rate limits render as `Tavily:ratelimit`; other failures map to `auth?` / `timeout` / `network` / HTTP status / `err`

### Docs

- Troubleshooting note for `Tavily:ratelimit` and duplicate usage footers

## [1.0.0] - 2026-07-17

### Added

- Initial public release
- Footer status showing Tavily plan usage percent
- Always one-decimal percent (e.g. `67.8%`)
- Color thresholds: warning at 80%, error at 95%
- Auth via `TAVILY_API_KEY` or `~/.pi/agent/auth.json` (`tavily` credential)
- Billing fetch from `https://api.tavily.com/usage`
- 10s request timeout
- Sanitized error messages (no raw upstream bodies)
- 429 rate-limit backoff via `Retry-After`
- 120s cache + in-flight request coalescing
- Force refresh generation guard
- Auto-refresh on session start and turn end
- `/tavily-usage` command for forced refresh + detailed breakdown
- `/tavily-usage clear` to hide the footer

### Footer format

```text
Tavily:67.8%
```

[1.0.2]: https://github.com/apoapostolov/pi-tavily-usage/releases/tag/v1.0.2
[1.0.1]: https://github.com/apoapostolov/pi-tavily-usage/releases/tag/v1.0.1
[1.0.0]: https://github.com/apoapostolov/pi-tavily-usage/releases/tag/v1.0.0
