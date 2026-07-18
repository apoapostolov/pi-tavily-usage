/**
 * Tavily account usage footer for Pi.
 *
 * Polls Tavily's usage API and shows plan credit usage in the status bar.
 *
 * Auth (first match wins):
 *   1. TAVILY_API_KEY env
 *   2. ~/.pi/agent/auth.json credential under "tavily"
 *
 * API: GET https://api.tavily.com/usage
 *
 * Refresh:
 *   - session_start: initial fetch + start 10-min timer
 *   - agent_start:   prompt-time refresh when cooldown elapsed
 *   - turn_end:      post-turn refresh when cooldown elapsed
 *   - interval:      idle refresh (~every 10 min)
 *   - /tavily-usage: force refresh + details
 *
 * Commands:
 *   /tavily-usage        force refresh + show details
 *   /tavily-usage clear  hide footer
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_ID = "tavily-usage";
const USAGE_URL = "https://api.tavily.com/usage";
/** Minimum time between successful fetches. */
const FETCH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
/** Retry sooner after a failed fetch (don't lock out for a full cooldown). */
const ERROR_RETRY_MS = 30 * 1000; // 30 seconds
/** Interval tick slightly under cooldown so timer edges don't no-op. */
const PERIODIC_TICK_MS = FETCH_COOLDOWN_MS - 15_000; // 9m45s
const REQUEST_TIMEOUT_MS = 10_000;
/** Fallback when Tavily 429 omits Retry-After. */
const DEFAULT_RETRY_AFTER_MS = 300_000;
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

interface TavilyUsageResponse {
	key?: {
		usage?: number;
		limit?: number;
		search_usage?: number;
		extract_usage?: number;
		crawl_usage?: number;
		map_usage?: number;
		research_usage?: number;
	};
	account?: {
		current_plan?: string;
		plan_usage?: number;
		plan_limit?: number;
		paygo_usage?: number;
		paygo_limit?: number;
		search_usage?: number;
		extract_usage?: number;
		crawl_usage?: number;
		map_usage?: number;
		research_usage?: number;
	};
}

interface UsageSnapshot {
	/** Plan fill percentage (0–100+) */
	percent: number;
	planUsage: number;
	planLimit: number;
	paygoUsage: number;
	paygoLimit: number;
	keyUsage: number;
	keyLimit: number;
	planName?: string;
	searchUsage: number;
	extractUsage: number;
	crawlUsage: number;
	mapUsage: number;
	researchUsage: number;
	fetchedAt: number;
}

function formatPercent(n: number): string {
	return (Math.round(n * 10) / 10).toFixed(1);
}

function sanitizeError(err: unknown): string {
	if (err instanceof Error) {
		const msg = err.message || "unknown error";
		if (msg.startsWith("auth ") || msg.startsWith("HTTP ") || msg.startsWith("rate limited")) return msg;
		if (msg.includes("abort") || /timeout/i.test(msg)) return "request timeout";
		if (/fetch failed|network|ECONN|ENOTFOUND/i.test(msg)) return "network error";
		if (/api key|TAVILY/i.test(msg)) return "no Tavily API key";
		return "request failed";
	}
	return "request failed";
}

function isStaleContextError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("stale after session") || msg.includes("extension ctx is stale");
}

function readKeyFromAuthJson(): string | null {
	if (!existsSync(AUTH_PATH)) return null;
	try {
		const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, unknown>;

		const asCred = (v: unknown): string | null => {
			if (typeof v === "string" && v.trim()) return v.trim();
			if (v && typeof v === "object") {
				const o = v as Record<string, unknown>;
				// Pi credential shapes
				if (o.type === "api_key" && typeof o.key === "string" && o.key.trim()) return o.key.trim();
				for (const k of ["key", "apiKey", "api_key", "token"]) {
					const val = o[k];
					if (typeof val === "string" && val.trim()) return val.trim();
				}
			}
			return null;
		};

		// Direct "tavily" entry
		const direct = asCred(raw.tavily);
		if (direct) return direct;

		// Nested providers map variants
		for (const [k, v] of Object.entries(raw)) {
			if (k.toLowerCase().includes("tavily")) {
				const found = asCred(v);
				if (found) return found;
			}
		}
		return null;
	} catch {
		return null;
	}
}

function resolveApiKey(): string | null {
	const env = process.env.TAVILY_API_KEY?.trim();
	if (env) return env;
	return readKeyFromAuthJson();
}

function parseRetryAfterMs(header: string | null): number {
	if (!header) return DEFAULT_RETRY_AFTER_MS;
	const seconds = Number.parseInt(header.trim(), 10);
	return Number.isFinite(seconds) ? Math.max(seconds * 1000, 0) : DEFAULT_RETRY_AFTER_MS;
}

async function fetchUsage(apiKey: string, signal: AbortSignal): Promise<UsageSnapshot | null> {
	const res = await fetch(USAGE_URL, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": "pi-tavily-usage/1.0.2",
		},
		signal,
	});

	if (res.status === 401 || res.status === 403) {
		throw new Error(`auth ${res.status}`);
	}
	if (res.status === 429) {
		const retryMs = parseRetryAfterMs(res.headers.get("retry-after"));
		throw new Error(`rate limited (${Math.round(retryMs / 1000)}s)`);
	}
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}

	const body = await res.text();
	// Tavily may return 202/200 with empty body when no usage history exists yet.
	if (!body.trim()) return null;

	let data: TavilyUsageResponse;
	try {
		data = JSON.parse(body) as TavilyUsageResponse;
	} catch {
		return null;
	}

	const planUsage = Number(data.account?.plan_usage ?? 0);
	const planLimit = Number(data.account?.plan_limit ?? 0);
	const paygoUsage = Number(data.account?.paygo_usage ?? 0);
	const paygoLimit = Number(data.account?.paygo_limit ?? 0);
	const keyUsage = Number(data.key?.usage ?? 0);
	const keyLimit = Number(data.key?.limit ?? 0);

	// Primary meter: plan fill. Fallback to key limit if plan missing.
	let percent = 0;
	if (planLimit > 0) percent = (planUsage / planLimit) * 100;
	else if (keyLimit > 0) percent = (keyUsage / keyLimit) * 100;

	return {
		percent: Number.isFinite(percent) ? percent : 0,
		planUsage,
		planLimit,
		paygoUsage,
		paygoLimit,
		keyUsage,
		keyLimit,
		planName: data.account?.current_plan,
		searchUsage: Number(data.account?.search_usage ?? data.key?.search_usage ?? 0),
		extractUsage: Number(data.account?.extract_usage ?? data.key?.extract_usage ?? 0),
		crawlUsage: Number(data.account?.crawl_usage ?? data.key?.crawl_usage ?? 0),
		mapUsage: Number(data.account?.map_usage ?? data.key?.map_usage ?? 0),
		researchUsage: Number(data.account?.research_usage ?? data.key?.research_usage ?? 0),
		fetchedAt: Date.now(),
	};
}

function formatErrorLabel(error: string): string {
	const e = error.toLowerCase();
	if (e.startsWith("rate limited") || e.includes("rate limit")) return "ratelimit";
	if (e.startsWith("auth ") || e.includes("no tavily api key") || e.includes("api key")) return "auth?";
	if (e.includes("timeout")) return "timeout";
	if (e.includes("network")) return "network";
	if (e.startsWith("http ")) return e.slice(5); // e.g. "HTTP 500" → "500"
	return "err";
}

function formatFooter(
	theme: ExtensionContext["ui"]["theme"],
	snap: UsageSnapshot | null,
	error?: string,
): string {
	const label = theme.fg("muted", "Tavily:");
	if (error && !snap) {
		return label + theme.fg("warning", formatErrorLabel(error));
	}
	if (!snap) {
		return label + theme.fg("accent", "…");
	}

	const pct = formatPercent(snap.percent);
	const pctNum = Number(pct);
	const hot = pctNum >= 80;
	const critical = pctNum >= 95;
	const color = critical ? "error" : hot ? "warning" : "accent";
	return label + theme.fg(color as "accent" | "warning" | "error", `${pct}%`);
}

class TavilyUsageCache {
	private last: UsageSnapshot | null = null;
	private lastError: string | null = null;
	/** Timestamp of last successful fetch (drives success cooldown). */
	private lastSuccessTime = 0;
	/** Timestamp of last failed fetch (drives short error backoff). */
	private lastErrorTime = 0;
	/** Hard floor from Tavily Retry-After on 429. */
	private backoffUntil = 0;
	private inflight: Promise<void> | null = null;
	private generation = 0;

	setStatus(ctx: ExtensionContext, forceError?: string): void {
		const status = formatFooter(ctx.ui.theme, this.last, forceError ?? this.lastError ?? undefined);
		ctx.ui.setStatus(STATUS_ID, status);
	}

	clear(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_ID, undefined);
	}

	/** True when a network fetch is allowed under cooldown rules. */
	private canFetch(force: boolean): boolean {
		if (force) return true;
		const now = Date.now();

		// Explicit 429 Retry-After window.
		if (now < this.backoffUntil) return false;

		// Successful fetch: full 10-min cooldown.
		if (this.lastSuccessTime && now - this.lastSuccessTime < FETCH_COOLDOWN_MS) {
			return false;
		}

		// Failed fetch (and no newer success): short backoff only.
		if (this.lastErrorTime > this.lastSuccessTime && now - this.lastErrorTime < ERROR_RETRY_MS) {
			return false;
		}

		return true;
	}

	async update(ctx: ExtensionContext, opts: { force?: boolean } = {}): Promise<UsageSnapshot | null> {
		const force = opts.force === true;

		if (!this.canFetch(force)) {
			this.setStatus(ctx);
			return this.last;
		}

		if (this.inflight && !force) {
			await this.inflight;
			this.setStatus(ctx);
			return this.last;
		}

		const gen = ++this.generation;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		const run = (async () => {
			try {
				const apiKey = resolveApiKey();
				if (!apiKey) {
					throw new Error("no Tavily API key — set TAVILY_API_KEY");
				}

				const snap = await fetchUsage(apiKey, controller.signal);
				if (gen !== this.generation) return;

				if (!snap) {
					// Empty body: API reachable, no usage history yet.
					// Count as success so we don't hammer the endpoint.
					this.lastError = null;
					this.lastSuccessTime = Date.now();
					this.lastErrorTime = 0;
					this.backoffUntil = 0;
					this.setStatus(ctx);
					return;
				}

				this.last = snap;
				this.lastError = null;
				this.lastSuccessTime = Date.now();
				this.lastErrorTime = 0;
				this.backoffUntil = 0;
				this.setStatus(ctx);
			} catch (err) {
				if (gen !== this.generation) return;
				if (isStaleContextError(err)) {
					// Don't burn cooldown on stale ctx — caller should rebind.
					throw err;
				}
				const msg = sanitizeError(err);
				this.lastError = msg;
				this.lastErrorTime = Date.now();
				// Do NOT advance success cooldown on failure.

				// Honor rate-limit backoff when message encodes seconds.
				const m = /^rate limited \((\d+)s\)$/.exec(msg);
				if (m) {
					this.backoffUntil = Date.now() + Number(m[1]) * 1000;
				}

				// Keep stale data if we have it.
				this.setStatus(ctx, this.last ? undefined : this.lastError);
			} finally {
				clearTimeout(timeout);
			}
		})();

		this.inflight = run.finally(() => {
			if (this.inflight === run) this.inflight = null;
		});
		await this.inflight;
		return this.last;
	}

	details(): string {
		if (this.lastError && !this.last) {
			return `Tavily usage unavailable: ${this.lastError}\nSet TAVILY_API_KEY or add a tavily credential to ~/.pi/agent/auth.json`;
		}
		if (!this.last) return "Tavily usage: not fetched yet.";

		const s = this.last;
		const lines = [
			`Tavily usage: ${formatPercent(s.percent)}% of plan` +
				(s.planName ? ` (${s.planName})` : ""),
			`Plan: ${s.planUsage} / ${s.planLimit}`,
		];
		if (s.paygoLimit > 0 || s.paygoUsage > 0) {
			lines.push(`Pay-as-you-go: ${s.paygoUsage} / ${s.paygoLimit}`);
		}
		if (s.keyLimit > 0) {
			lines.push(`This API key: ${s.keyUsage} / ${s.keyLimit}`);
		}
		lines.push(
			`Breakdown: search ${s.searchUsage}, extract ${s.extractUsage}, crawl ${s.crawlUsage}, map ${s.mapUsage}, research ${s.researchUsage}`,
		);
		if (this.lastError) lines.push(`Last error: ${this.lastError}`);
		const ageSec = Math.round((Date.now() - s.fetchedAt) / 1000);
		lines.push(`Fetched: ${ageSec}s ago`);
		return lines.join("\n");
	}
}

export default function (pi: ExtensionAPI) {
	const cache = new TavilyUsageCache();
	let lastCtx: ExtensionContext | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	const remember = (ctx: ExtensionContext) => {
		lastCtx = ctx;
	};

	const stopPeriodicRefresh = () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	};

	const startPeriodicRefresh = () => {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => {
			const ctx = lastCtx;
			if (!ctx) return;
			// Cooldown still applies; tick is slightly under 10m so edges don't miss.
			cache.update(ctx).catch((err) => {
				if (isStaleContextError(err)) {
					// Session was replaced — drop dead ctx and wait for a live event.
					lastCtx = null;
					return;
				}
				// Soft-fail: keep last known status; next tick/event retries.
			});
		}, PERIODIC_TICK_MS);
		// Don't keep the process alive solely for this timer if Pi exits.
		if (typeof refreshTimer === "object" && refreshTimer && "unref" in refreshTimer) {
			(refreshTimer as NodeJS.Timeout).unref?.();
		}
	};

	const kick = (ctx: ExtensionContext, opts?: { force?: boolean }) => {
		remember(ctx);
		startPeriodicRefresh();
		cache.update(ctx, opts).catch((err) => {
			if (isStaleContextError(err)) {
				lastCtx = null;
			}
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		// Fire-and-forget: never block session startup.
		kick(ctx);
	});

	// Prompt-time: refresh as soon as a new agent run starts if cooldown elapsed.
	pi.on("agent_start", async (_event, ctx) => {
		kick(ctx);
	});

	// Post-turn: catch usage that landed during the turn.
	pi.on("turn_end", async (_event, ctx) => {
		kick(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopPeriodicRefresh();
		lastCtx = null;
		try {
			cache.clear(ctx);
		} catch {
			// ctx may already be tearing down
		}
	});

	pi.registerCommand("tavily-usage", {
		description: "Show/refresh Tavily account credit usage in the footer",
		handler: async (args, ctx) => {
			remember(ctx);
			startPeriodicRefresh();
			const cmd = (args ?? "").trim().toLowerCase();
			if (cmd === "clear" || cmd === "hide" || cmd === "off") {
				cache.clear(ctx);
				ctx.ui.notify("Tavily usage footer cleared", "info");
				return;
			}
			await cache.update(ctx, { force: true });
			ctx.ui.notify(cache.details(), "info");
		},
	});
}
