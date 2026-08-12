/**
 * Tavily account usage footer for Pi.
 *
 * Polls Tavily's usage API and shows plan credit usage in the status bar.
 * Multi-key store/rotate matches the Hermes TUI widget
 * (`~/.hermes/tui-widgets/07-tavily-usage.mjs`): same files, same ${VAR}
 * expansion, same numbered SoT fallback, same rotate script.
 *
 * Auth (first match wins):
 *   1. /tavily-auth <key> in-memory
 *   2. ~/.hermes/tavily-keys.env TAVILY_API_KEY
 *   3. /mnt/c/git/lifestyle/.env TAVILY_API_KEY
 *      (expands ${VAR}; numbered TAVILY_API_KEY_<N> is lifestyle SoT)
 *   4. process.env.TAVILY_API_KEY
 *   5. ~/.hermes/.env TAVILY_API_KEY
 *   6. ~/.pi/agent/auth.json tavily credential
 *
 * Auto-rotates the active key from TAVILY_API_KEY_POOL when plan burn hits
 * 95%, paygo is active, or the key is rejected. Rotation reuses the bedroom
 * script (same writers as the Hermes skill) — this extension does not fork
 * the env/mcporter writers.
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
 *   /tavily-usage              force refresh + show details
 *   /tavily-usage detail       same (breakdown + pool)
 *   /tavily-usage rotate       force pool rotate (--best) then refresh
 *   /tavily-usage pool         details with pool section first
 *   /tavily-usage auto on|off  toggle auto-rotate (default on)
 *   /tavily-auth <key>         session in-memory key override
 *   /tavily-usage clear        hide footer
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_ID = "tavily-usage";
const USAGE_URL = "https://api.tavily.com/usage";
/** Minimum time between successful fetches. */
const FETCH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
/** Retry sooner after a failed fetch (don't lock out for a full cooldown). */
const ERROR_RETRY_MS = 30 * 1000; // 30 seconds
/**
 * Idle poll cadence. Must be >= FETCH_COOLDOWN_MS.
 *
 * Prior bug: this was cooldown - 15s (9m45s). After a success at T=0 the first
 * tick always hit the 10m cooldown and no-op'd, so the next real fetch only
 * landed at T=19m30s. Effective idle refresh was ~19.5 min, not 10.
 * Keep a small positive skew so timer jitter can't land inside the cooldown.
 */
const PERIODIC_TICK_MS = FETCH_COOLDOWN_MS + 5_000; // 10m5s
const REQUEST_TIMEOUT_MS = 10_000;
/** Fallback when Tavily 429 omits Retry-After. */
const DEFAULT_RETRY_AFTER_MS = 300_000;
/** Match Hermes widget + rotate script default. */
const ROTATE_THRESHOLD = 95;
const ROTATE_COOLDOWN_MS = 5 * 60 * 1000;
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const LIFESTYLE_ENV_PATH = "/mnt/c/git/lifestyle/.env";
const HERMES_ENV_PATH = join(homedir(), ".hermes", ".env");
const TAVILY_KEYS_ENV_PATH = join(homedir(), ".hermes", "tavily-keys.env");
const ROTATE_SCRIPT = join(
	homedir(),
	".hermes",
	"skills",
	"mcp",
	"tavily-key-rotation",
	"scripts",
	"tavily_key_rotate.py",
);

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

interface PoolState {
	keys: string[];
	labels: string[];
	index: number;
	active: string | null;
	lastRotated: string;
	lastReason: string;
}

interface UsageSnapshot {
	/** Plan fill percentage (0–200 when paygo is burning). */
	percent: number;
	inPaygo: boolean;
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
	poolIndex: number;
	poolLabel: string;
	poolSize: number;
	rotateNote?: string;
	rotatedFrom?: string;
	fetchedAt: number;
}

interface RotateResult {
	ok: boolean;
	note: string;
	detail?: string;
	raw?: string;
}

let inMemoryKey: string | null = null;
let autoRotate = true;
let lastRotateAttempt = 0;
let lastRotateNote: string | null = null;
let rotateInflight: Promise<RotateResult> | null = null;

function formatPercent(n: number): string {
	return (Math.round(n * 10) / 10).toFixed(1);
}

function endOfMonthLabel(): string {
	const now = new Date();
	const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	const diffMs = end.getTime() - now.getTime();
	if (diffMs <= 0) return "reset";
	if (diffMs < 48 * 3600000) {
		const hours = Math.floor(diffMs / 3600000);
		const mins = Math.floor((diffMs % 3600000) / 60000);
		return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
	}
	return `${Math.floor(diffMs / (1000 * 60 * 60 * 24))}d`;
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

function parseEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#") || !t.includes("=")) continue;
			const i = t.indexOf("=");
			const k = t.slice(0, i).trim();
			let v = t.slice(i + 1).trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			}
			if (k) out[k] = v;
		}
	} catch {
		/* ok */
	}
	return out;
}

/** Resolve ${NAME} refs against the same map (lifestyle numbered SoT layout). */
function expandEnvVars(data: Record<string, string>, maxPasses = 12): Record<string, string> {
	const out = { ...data };
	for (let p = 0; p < maxPasses; p++) {
		let changed = false;
		for (const [k, v] of Object.entries(out)) {
			if (typeof v !== "string" || !v.includes("${")) continue;
			const nv = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => {
				const rep = out[name];
				if (typeof rep !== "string" || rep === m) return m;
				return rep;
			});
			if (nv !== v) {
				out[k] = nv;
				changed = true;
			}
		}
		if (!changed) break;
	}
	return out;
}

function looksLikeApiKey(value: string | null | undefined): boolean {
	const v = (value || "").trim();
	if (!v || v.includes("${")) return false;
	return v.startsWith("tvly-") || v.length >= 20;
}

/** Fallback pool from TAVILY_API_KEY_<N> + _LABEL (1-based). */
function numberedPoolFromData(data: Record<string, string>): { keys: string[]; labels: string[] } {
	const keysByN = new Map<number, string>();
	const labelsByN = new Map<number, string>();
	for (const [k, v] of Object.entries(data || {})) {
		let m = /^TAVILY_API_KEY_(\d+)$/.exec(k);
		if (m && looksLikeApiKey(v)) {
			keysByN.set(Number(m[1]), v.trim());
			continue;
		}
		m = /^TAVILY_API_KEY_(\d+)_LABEL$/.exec(k);
		if (m && String(v || "").trim()) {
			labelsByN.set(Number(m[1]), String(v).trim());
		}
	}
	if (!keysByN.size) return { keys: [], labels: [] };
	const nums = [...keysByN.keys()].sort((a, b) => a - b);
	return {
		keys: nums.map((n) => keysByN.get(n) as string),
		labels: nums.map((n) => labelsByN.get(n) || `acct${n}`),
	};
}

function readKeyFromAuthJson(): string | null {
	if (!existsSync(AUTH_PATH)) return null;
	try {
		const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, unknown>;

		const asCred = (v: unknown): string | null => {
			if (typeof v === "string" && v.trim()) return v.trim();
			if (v && typeof v === "object") {
				const o = v as Record<string, unknown>;
				if (o.type === "api_key" && typeof o.key === "string" && o.key.trim()) return o.key.trim();
				for (const k of ["key", "apiKey", "api_key", "token"]) {
					const val = o[k];
					if (typeof val === "string" && val.trim()) return val.trim();
				}
			}
			return null;
		};

		const direct = asCred(raw.tavily);
		if (direct) return direct;

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

function readPoolState(): PoolState {
	// Prefer Hermes unique pool file, then lifestyle, then hermes .env.
	// Expand ${VAR} so lifestyle numbered SoT (KEY_1 + POOL=${KEY_1},...) works.
	const merged = expandEnvVars({
		...parseEnvFile(HERMES_ENV_PATH),
		...parseEnvFile(LIFESTYLE_ENV_PATH),
		...parseEnvFile(TAVILY_KEYS_ENV_PATH),
	});
	const poolRaw = (merged.TAVILY_API_KEY_POOL || "").trim();
	let keys = poolRaw
		? poolRaw.split(",").map((s) => s.trim()).filter(Boolean)
		: merged.TAVILY_API_KEY
			? [merged.TAVILY_API_KEY.trim()]
			: [];
	keys = keys.filter(looksLikeApiKey);
	let labels = (merged.TAVILY_API_KEY_LABELS || "")
		.split(",")
		.map((s) => s.trim())
		.map((s) => (s && !s.includes("${") ? s : ""));

	if (!keys.length) {
		const numbered = numberedPoolFromData(merged);
		keys = numbered.keys;
		if (numbered.labels.length) labels = numbered.labels;
	}

	let index = Number.parseInt(String(merged.TAVILY_API_KEY_INDEX || "0"), 10);
	if (!Number.isFinite(index) || index < 0) index = 0;
	if (keys.length) index = Math.min(index, keys.length - 1);

	let active = (merged.TAVILY_API_KEY || "").trim() || null;
	if (!looksLikeApiKey(active)) {
		active = keys.length ? keys[index] : null;
	}
	const found = active ? keys.indexOf(active) : -1;
	if (found >= 0) index = found;
	return {
		keys,
		labels: keys.map((_, i) => labels[i] || `acct${i + 1}`),
		index,
		active,
		lastRotated: merged.TAVILY_LAST_ROTATED || "",
		lastReason: merged.TAVILY_LAST_REASON || "",
	};
}

function shortLabel(label: string | undefined, index: number): string {
	if (!label) return `#${index + 1}`;
	const m = /^acct(\d+)/i.exec(label);
	if (m) return `#${m[1]}`;
	if (Number.isFinite(index) && index >= 0) return `#${index + 1}`;
	return "#?";
}

function resolveApiKey(): string | null {
	if (inMemoryKey) return inMemoryKey;
	const pool = readPoolState();
	if (pool.active && looksLikeApiKey(pool.active)) return pool.active;
	if (typeof process !== "undefined" && process.env?.TAVILY_API_KEY?.trim()) {
		const envKey = process.env.TAVILY_API_KEY.trim();
		if (looksLikeApiKey(envKey)) return envKey;
	}
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
			"User-Agent": "pi-tavily-usage/1.1",
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

	// Same meter as Hermes widget: plan 0–99.9, 100 if exhausted, 100–200 if paygo.
	let percent = 0;
	let inPaygo = false;

	if (planLimit > 0) {
		const planPct = (planUsage / planLimit) * 100;
		if (planPct < 100) {
			percent = planPct;
		} else if (paygoUsage > 0) {
			inPaygo = true;
			const paygoPct = paygoLimit > 0 ? (paygoUsage / paygoLimit) * 100 : 0;
			percent = 100 + Math.min(paygoPct, 100);
		} else {
			percent = 100;
		}
	} else if (keyLimit > 0) {
		percent = (keyUsage / keyLimit) * 100;
	}

	const pool = readPoolState();
	return {
		percent: Number.isFinite(percent) ? percent : 0,
		inPaygo,
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
		poolIndex: pool.index,
		poolLabel: pool.labels[pool.index] || `acct${pool.index + 1}`,
		poolSize: pool.keys.length,
		fetchedAt: Date.now(),
	};
}

function runRotateScript({ force = false, reason = "widget-auto" }: { force?: boolean; reason?: string } = {}): RotateResult {
	if (!existsSync(ROTATE_SCRIPT)) {
		return { ok: false, note: "no-script" };
	}
	const args = [ROTATE_SCRIPT, "rotate", "--reason", reason, "--best"];
	if (force) args.push("--force");
	const res = spawnSync("python3", args, {
		encoding: "utf8",
		timeout: 45_000,
		env: process.env,
	});
	const out = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
	const m = /applied:\s*index\s+(\d+)\s*->\s*(\d+)\s+label=(\S+)/i.exec(out);
	const skipped = /skip:\s*active/i.test(out);
	if (res.status === 0 && m) {
		return {
			ok: true,
			note: `${shortLabel(m[3], Number(m[2]))}`,
			detail: `rot ${m[1]}→${m[2]} ${m[3]}`,
			raw: out.slice(0, 400),
		};
	}
	if (res.status === 0 && skipped) {
		return { ok: false, note: "skip", detail: "under threshold", raw: out.slice(0, 400) };
	}
	if (res.status === 0 && /would-apply/i.test(out)) {
		return { ok: false, note: "dry", detail: out.slice(0, 120) };
	}
	if (res.status === 3) {
		return { ok: false, note: "pool-full", detail: "no headroom", raw: out.slice(0, 400) };
	}
	return {
		ok: false,
		note: "rot-fail",
		detail: (out || `exit ${res.status}`).slice(0, 160),
		raw: out.slice(0, 400),
	};
}

async function maybeRotate({
	force = false,
	reason = "widget-auto",
	authFail = false,
}: {
	force?: boolean;
	reason?: string;
	authFail?: boolean;
} = {}): Promise<RotateResult | null> {
	if (!autoRotate && !force) return null;
	const now = Date.now();
	if (!force && now - lastRotateAttempt < ROTATE_COOLDOWN_MS) {
		return { ok: false, note: "cooldown" };
	}
	if (rotateInflight) return rotateInflight;

	rotateInflight = (async () => {
		lastRotateAttempt = Date.now();
		const before = readPoolState();
		if (before.keys.length < 2 && !force) {
			lastRotateNote = "pool1";
			return { ok: false, note: "pool1" };
		}
		const result = runRotateScript({ force: force || authFail, reason });
		if (result.ok) {
			inMemoryKey = null;
			if (typeof process !== "undefined" && process.env) {
				try {
					const after = readPoolState();
					if (after.active) process.env.TAVILY_API_KEY = after.active;
				} catch {
					/* ok */
				}
			}
			lastRotateNote = result.note;
		} else if (result.note && result.note !== "skip" && result.note !== "cooldown") {
			lastRotateNote = result.note;
		}
		return result;
	})();

	try {
		return await rotateInflight;
	} finally {
		rotateInflight = null;
	}
}

function formatErrorLabel(error: string): string {
	const e = error.toLowerCase();
	if (e.startsWith("rate limited") || e.includes("rate limit")) return "ratelimit";
	if (e.startsWith("auth ") || e.includes("no tavily api key") || e.includes("api key")) return "auth?";
	if (e.includes("timeout")) return "timeout";
	if (e.includes("network")) return "network";
	if (e.startsWith("http ")) return e.slice(5);
	return "err";
}

function formatFooter(
	theme: ExtensionContext["ui"]["theme"],
	snap: UsageSnapshot | null,
	error?: string,
): string {
	const label = theme.fg("muted", "Tavily:");
	if (error && !snap) {
		const errBit = label + theme.fg("warning", formatErrorLabel(error));
		return lastRotateNote ? `${errBit} ${theme.fg("muted", lastRotateNote)}` : errBit;
	}
	if (!snap) {
		return label + theme.fg("accent", "…");
	}

	const pct = formatPercent(snap.percent);
	const pctNum = Number(pct);
	const suffix = snap.inPaygo ? `${pct}%*` : `${pct}%`;
	let color: "accent" | "warning" | "error";
	if (snap.inPaygo) {
		color = pctNum >= 150 ? "warning" : "error";
	} else {
		color = pctNum >= 95 ? "error" : pctNum >= 80 ? "warning" : "accent";
	}
	const acct = shortLabel(snap.poolLabel, snap.poolIndex ?? 0);
	const rotMark = snap.rotateNote || lastRotateNote === "pool-full" ? theme.fg("warning", " ↻") : "";
	return `${label}${theme.fg(color, suffix)} ${theme.fg("muted", acct)}${rotMark}`;
}

function formatPoolLines(pool: PoolState, poolFirst: boolean): string[] {
	const lines = [
		`Pool: ${pool.keys.length} keys  auto=${autoRotate ? "on" : "off"}`,
		`Active: ${pool.labels[pool.index] || `acct${pool.index + 1}`} [${pool.index}]`,
	];
	if (pool.lastRotated) lines.push(`Last rot: ${pool.lastRotated}`);
	if (pool.lastReason) lines.push(`reason: ${pool.lastReason}`);
	if (lastRotateNote) lines.push(`widget: ${lastRotateNote}`);
	if (!poolFirst) {
		lines.push("rotate: /tavily-usage rotate · files: tavily-keys.env + lifestyle .env");
	}
	return lines;
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

	/** Drop cached snap + cooldown. Bumps generation so a later update() wins. */
	invalidateAfterRotate(): void {
		this.resetCooldown();
		this.last = null;
		this.generation += 1;
	}

	/** Clear success/error cooldown without cancelling the in-flight update. */
	private resetCooldown(): void {
		this.lastError = null;
		this.lastSuccessTime = 0;
		this.lastErrorTime = 0;
		this.backoffUntil = 0;
	}

	setStatus(ctx: ExtensionContext | null, forceError?: string): void {
		if (!ctx) return;
		try {
			const status = formatFooter(ctx.ui.theme, this.last, forceError ?? this.lastError ?? undefined);
			ctx.ui.setStatus(STATUS_ID, status);
		} catch (err) {
			if (!isStaleContextError(err)) throw err;
		}
	}

	clear(ctx: ExtensionContext): void {
		try {
			ctx.ui.setStatus(STATUS_ID, undefined);
		} catch (err) {
			if (!isStaleContextError(err)) throw err;
		}
	}

	/** True when a network fetch is allowed under cooldown rules. */
	private canFetch(force: boolean): boolean {
		if (force) return true;
		const now = Date.now();

		if (now < this.backoffUntil) return false;

		if (this.lastSuccessTime && now - this.lastSuccessTime < FETCH_COOLDOWN_MS) {
			return false;
		}

		if (this.lastErrorTime > this.lastSuccessTime && now - this.lastErrorTime < ERROR_RETRY_MS) {
			return false;
		}

		return true;
	}

	async update(ctx: ExtensionContext | null, opts: { force?: boolean } = {}): Promise<UsageSnapshot | null> {
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
				let apiKey = resolveApiKey();
				if (!apiKey) {
					throw new Error("no Tavily API key — set TAVILY_API_KEY");
				}

				let snap = await fetchUsage(apiKey, controller.signal);
				if (gen !== this.generation) return;

				if (!snap) {
					this.lastError = null;
					this.lastSuccessTime = Date.now();
					this.lastErrorTime = 0;
					this.backoffUntil = 0;
					this.setStatus(ctx);
					return;
				}

				const needRotate =
					autoRotate &&
					(snap.percent >= ROTATE_THRESHOLD ||
						snap.inPaygo ||
						(snap.planLimit > 0 && snap.planUsage >= snap.planLimit)) &&
					(snap.poolSize || 0) >= 2;

				if (needRotate) {
					const rot = await maybeRotate({ reason: "widget-100", force: false });
					if (rot?.ok) {
						this.resetCooldown();
						apiKey = resolveApiKey();
						if (apiKey) {
							try {
								const snap2 = await fetchUsage(apiKey, controller.signal);
								if (gen === this.generation && snap2) {
									snap = { ...snap2, rotatedFrom: snap.poolLabel, rotateNote: rot.detail || rot.note };
								}
							} catch {
								snap = { ...snap, rotateNote: rot.detail || rot.note };
							}
						}
					} else if (rot?.note === "pool-full" || rot?.note === "pool1") {
						snap = { ...snap, rotateNote: rot.note };
					}
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
					throw err;
				}
				const msg = sanitizeError(err);

				if (/^auth /.test(msg) && autoRotate) {
					const rot = await maybeRotate({ reason: "widget-auth", force: true, authFail: true });
					if (rot?.ok) {
						this.resetCooldown();
						try {
							const apiKey = resolveApiKey();
							if (apiKey) {
								const snap = await fetchUsage(apiKey, controller.signal);
								if (gen === this.generation && snap) {
									this.last = { ...snap, rotateNote: rot.detail || "auth-rot" };
									this.lastError = null;
									this.lastSuccessTime = Date.now();
									this.lastErrorTime = 0;
									this.backoffUntil = 0;
									this.setStatus(ctx);
									return;
								}
							}
						} catch (err2) {
							this.lastError = sanitizeError(err2);
							this.lastErrorTime = Date.now();
							this.setStatus(ctx, this.last ? undefined : this.lastError);
							return;
						}
					}
				}

				this.lastError = msg;
				this.lastErrorTime = Date.now();

				const m = /^rate limited \((\d+)s\)$/.exec(msg);
				if (m) {
					this.backoffUntil = Date.now() + Number(m[1]) * 1000;
				}

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

	details(poolFirst = false): string {
		const pool = readPoolState();
		const poolLines = formatPoolLines(pool, poolFirst);

		if (this.lastError && !this.last) {
			const isRl = this.lastError.startsWith("rate limited");
			const isAuth = /auth|401|403/.test(this.lastError);
			const isNoKey = /no key|TAVILY/i.test(this.lastError);
			const hint = isNoKey
				? "Set TAVILY_API_KEY_POOL / TAVILY_API_KEY or /tavily-auth <key>"
				: isAuth
					? "Key rejected — /tavily-usage rotate or fix pool"
					: isRl
						? "Rate limited — wait; rotate only if plan ≥95%"
						: "Check network / API status";
			return [`Tavily usage unavailable: ${this.lastError}`, hint, ...poolLines].join("\n");
		}
		if (!this.last) {
			return ["Tavily usage: not fetched yet.", ...poolLines].join("\n");
		}

		const s = this.last;
		const lines: string[] = [];
		if (poolFirst) lines.push(...poolLines);

		lines.push(
			`Tavily usage: ${formatPercent(s.percent)}% of plan` +
				(s.inPaygo ? " (paygo)" : "") +
				(s.planName ? ` (${s.planName})` : ""),
		);
		lines.push(`Plan: ${s.planUsage} / ${s.planLimit}`);
		lines.push(`Resets: ${endOfMonthLabel()}`);
		if (s.paygoLimit > 0 || s.paygoUsage > 0) {
			lines.push(`Pay-as-you-go: ${s.paygoUsage} / ${s.paygoLimit}`);
		}
		if (s.keyLimit > 0) {
			lines.push(`This API key: ${s.keyUsage} / ${s.keyLimit}`);
		}
		lines.push(
			`Breakdown: search ${s.searchUsage}, extract ${s.extractUsage}, crawl ${s.crawlUsage}, map ${s.mapUsage}, research ${s.researchUsage}`,
		);
		if (!poolFirst) lines.push(...poolLines);
		if (s.rotateNote) lines.push(`Rotate: ${s.rotateNote}`);
		if (s.rotatedFrom) lines.push(`Rotated from: ${s.rotatedFrom}`);
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
			cache.update(ctx).catch((err) => {
				if (isStaleContextError(err)) {
					lastCtx = null;
					return;
				}
			});
		}, PERIODIC_TICK_MS);
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
		kick(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		kick(ctx);
	});

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

	const handleUsage = async (args: string, ctx: ExtensionContext) => {
		remember(ctx);
		startPeriodicRefresh();
		const raw = (args ?? "").trim();
		const cmd = raw.toLowerCase();

		if (cmd === "clear" || cmd === "hide" || cmd === "off") {
			cache.clear(ctx);
			ctx.ui.notify("Tavily usage footer cleared", "info");
			return;
		}

		if (cmd.startsWith("auth ") || cmd.startsWith("key ")) {
			const key = raw.slice(4).trim();
			if (!key) {
				ctx.ui.notify("Usage: /tavily-auth <key>", "warning");
				return;
			}
			inMemoryKey = key;
			cache.invalidateAfterRotate();
			await cache.update(ctx, { force: true });
			ctx.ui.notify("Tavily session key set. Footer refreshed.", "info");
			return;
		}

		if (cmd === "auto on" || cmd === "auto-on") {
			autoRotate = true;
			ctx.ui.notify("Tavily auto-rotate on", "info");
			return;
		}
		if (cmd === "auto off" || cmd === "auto-off") {
			autoRotate = false;
			ctx.ui.notify("Tavily auto-rotate off", "info");
			return;
		}

		if (cmd === "rotate" || cmd === "rot" || cmd === "next") {
			const rot = await maybeRotate({ force: true, reason: "widget-manual" });
			if (rot?.ok) cache.invalidateAfterRotate();
			await cache.update(ctx, { force: true });
			const note = rot?.ok
				? `Rotated to ${rot.detail || rot.note}`
				: `Rotate ${rot?.note || "failed"}${rot?.detail ? `: ${rot.detail}` : ""}`;
			ctx.ui.notify(`${note}\n${cache.details(true)}`, rot?.ok ? "info" : "warning");
			return;
		}

		const poolFirst = cmd === "pool" || cmd === "keys" || cmd === "accounts";
		await cache.update(ctx, { force: true });
		ctx.ui.notify(cache.details(poolFirst), "info");
	};

	pi.registerCommand("tavily-usage", {
		description: "Show/refresh Tavily plan usage + pool (rotate / auto / pool / clear)",
		handler: handleUsage,
	});

	pi.registerCommand("tavily-auth", {
		description: "Set a session-only Tavily API key override",
		handler: async (args, ctx) => {
			const key = (args ?? "").trim();
			await handleUsage(key ? `auth ${key}` : "auth", ctx);
		},
	});
}
