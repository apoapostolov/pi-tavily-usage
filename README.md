# pi-tavily-usage

Show **Tavily plan usage** in the [Pi](https://pi.dev) status bar, and rotate a multi-key pool the same way the Hermes Tavily widget does.

Lightweight footer-only extension. No search tools. Just the meter + the bedroom key pool.

```
Tavily:67.8% #2
```

## Why

If you use Tavily for web search/extract (via `pi-web-access`, MCP, or other tools), this keeps plan burn visible while you work. Same idea as [pi-grok-usage](https://github.com/apoapostolov/pi-grok-usage), plus the Hermes TUI pool:

- one active key
- ordered pool of Researcher accounts
- auto-rotate when the active plan hits 95% / paygo / auth fail
- same files and rotate script as Hermes, so Pi and Hermes never drift

## Install

Requires [Pi](https://github.com/badlogic/pi) and at least one Tavily API key.

```bash
pi install git:github.com/apoapostolov/pi-tavily-usage
```

Or pin a tag:

```bash
pi install git:github.com/apoapostolov/pi-tavily-usage@v1.1.0
```

After install, start a new Pi process. `/reload` loads the extension code from this checkout; a version pin change (`@v1.1.0`) needs a restart.

## Prerequisites

Auth, first match wins (same order as `~/.hermes/tui-widgets/07-tavily-usage.mjs`):

1. `/tavily-auth <key>` (session in-memory override)
2. `~/.hermes/tavily-keys.env` `TAVILY_API_KEY`
3. `/mnt/c/git/lifestyle/.env` `TAVILY_API_KEY` (expands `${VAR}`; numbered `TAVILY_API_KEY_<N>` is lifestyle SoT)
4. `process.env.TAVILY_API_KEY`
5. `~/.hermes/.env` `TAVILY_API_KEY`
6. `~/.pi/agent/auth.json` `tavily` credential

Get keys at [tavily.com](https://tavily.com). Do not put raw keys in this README, chat, or git.

## What you get

| Surface | Behavior |
|--------|----------|
| Footer | `Tavily:<pct.1>% #N` of the active pool slot |
| Colors | normal → warning ≥80% → error ≥95% (paygo uses `*` and 100–200%) |
| Auto-rotate | plan ≥95%, paygo, or usage API 401/403 |
| Refresh | session start, agent start, turn end, idle timer (10 min cooldown) |
| `/tavily-usage` | force refresh + breakdown + pool |
| `/tavily-usage pool` | same, pool section first |
| `/tavily-usage rotate` | force `--best` rotate then refresh |
| `/tavily-usage auto on\|off` | toggle auto-rotate (default on) |
| `/tavily-auth <key>` | session-only override |
| `/tavily-usage clear` | hide footer |

Example detail output:

```text
Tavily usage: 67.8% of plan (Researcher)
Plan: 678 / 1000
Resets: 19d
Pay-as-you-go: 0 / 2000
This API key: 678 / 1000
Breakdown: search 158, extract 52, crawl 178, map 77, research 213
Pool: 5 keys  auto=on
Active: acct2-researcher [1]
Last rot: 2026-08-05T10:09:56Z
reason: pool-add
Fetched: 2s ago
```

## How it works

```text
in-memory / tavily-keys.env / lifestyle .env / process.env / hermes .env / auth.json
        │
        ▼
GET https://api.tavily.com/usage
Authorization: Bearer <active key>
        │
        ├─ plan ≥95% / paygo / auth fail
        │     └─ python3 ~/.hermes/skills/mcp/tavily-key-rotation/scripts/tavily_key_rotate.py
        │           rotate --reason widget-100|widget-auth|widget-manual --best
        │           (writes tavily-keys.env, lifestyle .env, hermes .env, mcporter)
        ▼
Pi footer status: "Tavily:67.8% #2"
```

Primary meter matches Hermes: `plan_usage / plan_limit`, then 100+ when paygo is burning. This package does **not** fork the writers. The Hermes rotate script is the only mutator.

Pool layout (Hermes unique file, literals):

```bash
TAVILY_API_KEY=tvly-...
TAVILY_API_KEY_POOL=key1,key2,...
TAVILY_API_KEY_INDEX=0
TAVILY_API_KEY_LABELS=acct1,acct2
TAVILY_LAST_ROTATED=
TAVILY_LAST_REASON=
```

Lifestyle SoT prefers numbered canon + `${}` refs. Widget and script expand those on read.

## Commands

```text
/tavily-usage              Force refresh and show details
/tavily-usage detail       Same
/tavily-usage pool         Details with pool first
/tavily-usage rotate       Force pool rotate (--best) then refresh
/tavily-usage auto on|off  Toggle auto-rotate
/tavily-auth <key>         Session in-memory key
/tavily-usage clear        Hide the footer status
```

## Troubleshooting

### Footer shows `Tavily:auth?`

Key missing or rejected. Check the pool, then:

```text
/tavily-usage rotate
```

or set a session key with `/tavily-auth tvly-...`.

### Footer shows `Tavily:ratelimit`

Usage endpoint returned 429. Wait for cooldown (honors `Retry-After`). Do not rotate on a pure 429 unless `/tavily-usage` shows plan ≥95%.

### Footer stuck on `Tavily:…`

First fetch still running, empty usage history, or network blocked. Run `/tavily-usage` for the error text.

### `widget: no-script`

The Hermes rotate script is missing. Expected at:

`~/.hermes/skills/mcp/tavily-key-rotation/scripts/tavily_key_rotate.py`

Without it the footer still meters the active key, but it cannot rotate.

### `widget: pool1` / `pool-full`

One key cannot rotate. All keys over threshold means no headroom. Add a key to lifestyle numbered SoT **and** `tavily-keys.env`, then `python3 …/tavily_key_rotate.py set-index <n> --reason pool-add`.

### Already using `@alexanderfortin/pi-tavily-tools`?

That package also paints a Tavily footer **and** registers search tools. This extension is **usage-only**. Don't install both if you hate duplicate footers.

## Privacy

- Key never leaves your machine except to Tavily's usage endpoint (and the local rotate script)
- No third-party analytics
- Errors are sanitized (no raw upstream bodies or full keys in the UI)

## Uninstall

```bash
pi remove git:github.com/apoapostolov/pi-tavily-usage
```

## Development

```bash
git clone https://github.com/apoapostolov/pi-tavily-usage
cd pi-tavily-usage
pi -e ./src/index.ts
```

## Related

- Hermes widget: `~/.hermes/tui-widgets/07-tavily-usage.mjs`
- Hermes rotate skill: `~/.hermes/skills/mcp/tavily-key-rotation`
- [pi-grok-usage](https://github.com/apoapostolov/pi-grok-usage)
- [Pi coding agent](https://github.com/badlogic/pi)
- [Tavily usage API](https://docs.tavily.com/documentation/api-reference/endpoint/usage)

## License

MIT © Apostol Apostolov
