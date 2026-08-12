# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-12

### Added

- Multi-key pool storage/rotation copied from the Hermes TUI widget (`07-tavily-usage.mjs`)
- Auth order now matches Hermes: in-memory `/tavily-auth` → `~/.hermes/tavily-keys.env` → lifestyle `.env` (with `${VAR}` + numbered `TAVILY_API_KEY_<N>` SoT) → `process.env` → `~/.hermes/.env` → `~/.pi/agent/auth.json`
- Auto-rotate at plan ≥95%, paygo burn, or usage-API 401/403 via the same bedroom script (`tavily_key_rotate.py rotate --best`)
- `/tavily-usage rotate`, `/tavily-usage pool`, `/tavily-usage auto on|off`, `/tavily-auth <key>`
- Footer shows active pool tag (`#2`) and a rotate mark; details include pool size, last rotation, and reset countdown
- Paygo meter matches Hermes (100–200% with `*` suffix)

### Changed

- This extension still does **not** write the pool itself. Rotate reuses the Hermes skill script so `tavily-keys.env`, lifestyle `.env`, Hermes `.env`, and mcporter stay one SoT
- 5-minute rotate cooldown and pool-of-one skip match the widget

## [1.0.1] - 2026-07-18

### Fixed

- Footer no longer shows `auth?` for every first-fetch failure
- Rate limits render as `Tavily:ratelimit`; other failures map to `auth?` / `timeout` / `network` / HTTP status / `err`
- Idle refresh actually hits ~10 min: interval is cooldown + 5s (10m5s), not cooldown − 15s (9m45s). The old "slightly under" tick always landed inside the 10-min success cooldown, so every other tick no-op'd and real idle fetches only ran every ~19.5 min
- Stale session context no longer kills idle refresh forever: timer keeps fetching when `lastCtx` is missing until a live event rebinds it

### Changed

- Refresh cadence aligned with `pi-grok-usage` model, on a **10-minute** success cooldown
- Idle `setInterval` tick at cooldown + 5s so the meter updates even without turns
- Also refreshes on `agent_start` (prompt-time) and `turn_end` when cooldown elapsed
- Failures no longer burn the full cooldown (30s error retry; 429 still honors `Retry-After`)

### Docs

- Troubleshooting notes for `Tavily:ratelimit` and duplicate usage footers

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

[1.1.0]: https://github.com/apoapostolov/pi-tavily-usage/releases/tag/v1.1.0
[1.0.1]: https://github.com/apoapostolov/pi-tavily-usage/releases/tag/v1.0.1
[1.0.0]: https://github.com/apoapostolov/pi-tavily-usage/releases/tag/v1.0.0
