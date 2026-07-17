# pi-tavily-usage

Show **Tavily plan usage** in the [Pi](https://pi.dev) status bar.

Lightweight footer-only extension. No search tools — just the meter.

```
Tavily:67.8%
```

## Why

If you use Tavily for web search/extract (via `pi-web-access`, MCP, or other tools), this keeps plan burn visible while you work — same idea as [pi-grok-usage](https://github.com/apoapostolov/pi-grok-usage).

## Install

Requires [Pi](https://github.com/badlogic/pi) and a Tavily API key.

```bash
pi install git:github.com/apoapostolov/pi-tavily-usage
```

Or pin a tag:

```bash
pi install git:github.com/apoapostolov/pi-tavily-usage@v1.0.0
```

Reload Pi (`/reload` or new session).

## Prerequisites

Set a Tavily key (first match wins):

1. **Environment**

```bash
export TAVILY_API_KEY="tvly-..."
```

2. **Or** Pi auth file `~/.pi/agent/auth.json` with a `tavily` API-key credential

Get a key at [tavily.com](https://tavily.com).

## What you get

| Surface | Behavior |
|--------|----------|
| Footer | `Tavily:<pct.1>%` of plan |
| Colors | normal → warning ≥80% → error ≥95% |
| Refresh | session start + turn end (120s cache) |
| `/tavily-usage` | force refresh + breakdown |
| `/tavily-usage clear` | hide footer |

Example detail output:

```text
Tavily usage: 67.8% of plan (Researcher)
Plan: 678 / 1000
Pay-as-you-go: 0 / 2000
This API key: 678 / 1000
Breakdown: search 158, extract 52, crawl 178, map 77, research 213
Fetched: 2s ago
```

## How it works

```text
TAVILY_API_KEY  (or ~/.pi/agent/auth.json)
        │
        ▼
GET https://api.tavily.com/usage
Authorization: Bearer <key>
        │
        ▼
Pi footer status: "Tavily:67.8%"
```

Primary meter = `plan_usage / plan_limit`. Details also show pay-as-you-go and per-key limits.

## Commands

```text
/tavily-usage          Force refresh and show details
/tavily-usage clear    Hide the footer status
```

## Troubleshooting

### Footer shows `Tavily:auth?`

Key missing or rejected.

```bash
export TAVILY_API_KEY="tvly-..."
# then in Pi:
/tavily-usage
```

### Footer stuck on `Tavily:…`

First fetch still running, empty usage history, or network blocked. Run `/tavily-usage` for the error text.

### Already using `@alexanderfortin/pi-tavily-tools`?

That package also paints a Tavily footer **and** registers search tools. This extension is **usage-only**. Don't install both if you hate duplicate footers — pick one.

## Privacy

- Key never leaves your machine except to Tavily's usage endpoint
- No third-party analytics
- Errors are sanitized (no raw upstream bodies in the UI)

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

- [pi-grok-usage](https://github.com/apoapostolov/pi-grok-usage) — same idea for Grok credits
- [Pi coding agent](https://github.com/badlogic/pi)
- [Tavily usage API](https://docs.tavily.com/documentation/api-reference/endpoint/usage)

## License

MIT © Apostol Apostolov
