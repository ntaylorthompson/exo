/**
 * AnthropicService — Central wrapper for all Claude LLM calls.
 *
 * Three responsibilities:
 * 1. WRAP — Invokes Claude Code CLI (`claude -p`) instead of the Anthropic SDK directly
 * 2. RETRY — Exponential backoff on transient errors (non-blocking async setTimeout)
 * 3. RECORD — Every call logged to llm_calls table for cost tracking
 *
 * REDACTION: Never records email body/subject. Only IDs and metadata.
 *
 * This fork uses the user's Claude Code subscription (CLI) instead of a separate
 * Anthropic API key. The agent framework (@anthropic-ai/claude-agent-sdk) already
 * works via subscription OAuth — see claude-agent-provider.ts:342-345.
 */
import { spawn, execSync } from "child_process";
import { createLogger } from "./logger";
import { randomUUID } from "crypto";

const log = createLogger("anthropic");

// ---------------------------------------------------------------------------
// Types — local definitions replacing @anthropic-ai/sdk imports
// ---------------------------------------------------------------------------

/** Subset of Anthropic Message type that consumers actually use. */
export interface ClaudeMessage {
  content: Array<{ type: string; text: string; [key: string]: unknown }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model: string;
  stop_reason: string;
}

/** Request params matching the subset of MessageCreateParamsNonStreaming that consumers pass. */
export interface LlmRequestParams {
  model: string;
  max_tokens: number;
  system?:
    | string
    | Array<{ type: string; text: string; cache_control?: { type: string } }>;
  messages: Array<{
    role: string;
    content:
      | string
      | Array<{ type: string; text: string; [key: string]: unknown }>;
  }>;
  tools?: Array<{ type: string; name?: string; [key: string]: unknown }>;
  thinking?: { type: string; budget_tokens?: number };
  temperature?: number;
}

// Backward-compat aliases so consumers importing these types still compile.
// These are the same as the local types above.
export type MessageCreateParamsNonStreaming = LlmRequestParams;
export type Message = ClaudeMessage;

// ---------------------------------------------------------------------------
// CLI response shape from `claude -p --output-format json`
// ---------------------------------------------------------------------------

interface CliJsonResponse {
  type: "result";
  subtype: "success" | "error";
  result: string;
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
}

// ---------------------------------------------------------------------------
// Pricing & retry config (unchanged from SDK version)
// ---------------------------------------------------------------------------

const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-opus-4-20250514": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
};

const DEFAULT_PRICING = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const RETRY_CONFIGS: Record<string, RetryConfig> = {
  rate_limit: { maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 30000 },
  server_error: { maxRetries: 3, initialDelayMs: 2000, maxDelayMs: 30000 },
  connection: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 },
};

export interface LlmCallRecord {
  id: string;
  created_at: string;
  model: string;
  caller: string;
  email_id: string | null;
  account_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_cents: number;
  duration_ms: number;
  success: number;
  error_message: string | null;
}

export interface UsageStats {
  today: { totalCostCents: number; totalCalls: number };
  thisWeek: { totalCostCents: number; totalCalls: number };
  thisMonth: { totalCostCents: number; totalCalls: number };
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  byCaller: Array<{ caller: string; costCents: number; calls: number }>;
}

interface CreateOptions {
  /** Which service is making this call, for cost attribution */
  caller: string;
  /** Optional email ID for tracing */
  emailId?: string;
  /** Optional account ID for attribution */
  accountId?: string;
  /** Timeout in milliseconds (default: none) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

let _cliPath: string | null = null;

function resolveCliPath(): string {
  if (_cliPath) return _cliPath;
  try {
    _cliPath = execSync("which claude", { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    _cliPath = "claude"; // fall back to PATH
  }
  return _cliPath;
}

// ---------------------------------------------------------------------------
// Concurrency limiter — prevent spawning too many CLI processes
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 4;
let _activeCount = 0;
const _queue: Array<{ resolve: () => void }> = [];

function acquireSlot(): Promise<void> {
  if (_activeCount < MAX_CONCURRENT) {
    _activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _queue.push({ resolve }));
}

function releaseSlot(): void {
  _activeCount--;
  const next = _queue.shift();
  if (next) {
    _activeCount++;
    next.resolve();
  }
}

// ---------------------------------------------------------------------------
// CLI executor — injectable for testing
// ---------------------------------------------------------------------------

type CliExecutorFn = (
  args: string[],
  stdin: string,
  timeoutMs?: number,
) => Promise<{ stdout: string; stderr: string }>;

let _cliExecutor: CliExecutorFn | null = null;

/**
 * Replace the CLI executor for testing. Pass null to reset.
 */
export function _setCliExecutorForTesting(executor: CliExecutorFn | null): void {
  _cliExecutor = executor;
}

/** Default CLI executor using child_process.spawn */
function defaultCliExecutor(
  args: string[],
  stdin: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cliPath = resolveCliPath();
    const child = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
        (err as Error & { code: number; stderr: string }).code = code ?? 1;
        (err as Error & { stderr: string }).stderr = stderr;
        reject(err);
      }
    });

    // Write prompt to stdin and close
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Backward-compat stubs for removed SDK functions
// ---------------------------------------------------------------------------

/** @deprecated No-op in CLI mode. Kept for backward compatibility. */
export function resetClient(): void {
  // No persistent client to reset in CLI mode
}

/** @deprecated No-op in CLI mode. Kept for backward compatibility. */
export function _setClientForTesting(_client: unknown): void {
  // Use _setCliExecutorForTesting() instead
}

/** @deprecated Not available in CLI mode. Returns a stub. */
export function getClient(): unknown {
  throw new Error(
    "getClient() is not available in CLI mode. " +
    "Use createMessage() or _setCliExecutorForTesting() for testing.",
  );
}

// ---------------------------------------------------------------------------
// Database (unchanged)
// ---------------------------------------------------------------------------

type DatabaseInstance = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => void;
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => () => T;
};

let _db: DatabaseInstance | null = null;
let _insertStmt: ReturnType<DatabaseInstance["prepare"]> | null = null;

export function setAnthropicServiceDb(db: DatabaseInstance): void {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      caller TEXT NOT NULL,
      email_id TEXT,
      account_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_create_tokens INTEGER DEFAULT 0,
      cost_cents REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_caller ON llm_calls(caller);
  `);
  _insertStmt = db.prepare(`
    INSERT INTO llm_calls (id, model, caller, email_id, account_id,
      input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
      cost_cents, duration_ms, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): number {
  const pricing = PRICING[model] || DEFAULT_PRICING;
  const inputCost = (inputTokens * pricing.input) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  const cacheReadCost = (cacheReadTokens * pricing.cacheRead) / 1_000_000;
  const cacheWriteCost = (cacheCreateTokens * pricing.cacheWrite) / 1_000_000;
  return (inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100;
}

function recordCall(
  model: string,
  caller: string,
  emailId: string | null,
  accountId: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  durationMs: number,
  success: boolean,
  errorMessage: string | null,
): void {
  if (!_insertStmt) {
    log.warn("AnthropicService: database not initialized, skipping call recording");
    return;
  }

  const costCents = calculateCostCents(model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);

  try {
    _insertStmt.run(
      randomUUID(),
      model,
      caller,
      emailId,
      accountId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      costCents,
      durationMs,
      success ? 1 : 0,
      errorMessage,
    );
  } catch (err) {
    log.error({ err }, "Failed to record LLM call to database");
  }
}

export function recordStreamingCall(
  model: string,
  caller: string,
  usage: Record<string, number>,
  durationMs: number,
  options?: { emailId?: string; accountId?: string },
): void {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheCreateTokens = usage.cache_creation_input_tokens || 0;
  recordCall(
    model,
    caller,
    options?.emailId || null,
    options?.accountId || null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    durationMs,
    true,
    null,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asyncSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryCategory(error: unknown): string | null {
  const msg = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: string }).stderr ?? "";
  const combined = `${msg} ${stderr}`.toLowerCase();

  if (combined.includes("rate limit") || combined.includes("429")) return "rate_limit";
  if (combined.includes("overloaded") || combined.includes("529")) return "server_error";
  if (combined.includes("500") || combined.includes("internal server error")) return "server_error";
  if (combined.includes("enoent") || combined.includes("eacces") || combined.includes("not found")) {
    return "connection";
  }
  if (combined.includes("timeout") || combined.includes("timed out")) return "connection";
  return null;
}

/** Extract system prompt text from params.system (handles string or array-of-blocks). */
function extractSystemText(
  system: LlmRequestParams["system"],
): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

/** Concatenate user message content into a single prompt string for stdin. */
function extractUserContent(messages: LlmRequestParams["messages"]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// createMessage() — the main entry point
// ---------------------------------------------------------------------------

export async function createMessage(
  params: LlmRequestParams,
  options: CreateOptions,
): Promise<ClaudeMessage> {
  const { caller, emailId, accountId, timeoutMs } = options;
  const model = params.model;
  const startTime = Date.now();

  let lastError: unknown = null;
  let totalAttempts = 0;

  const maxPossibleRetries = Math.max(...Object.values(RETRY_CONFIGS).map((c) => c.maxRetries));

  for (let attempt = 0; attempt <= maxPossibleRetries; attempt++) {
    totalAttempts = attempt + 1;

    await acquireSlot();
    try {
      // Build CLI arguments
      const args = [
        "--print",
        "--output-format", "json",
        "--model", model,
        "--verbose",
      ];

      // System prompt
      const systemText = extractSystemText(params.system);
      if (systemText) {
        args.push("--system-prompt", systemText);
      }

      // Web search tool
      const hasWebSearch = params.tools?.some(
        (t) => t.type === "web_search_20250305" || t.name === "web_search",
      );
      if (hasWebSearch) {
        args.push("--allowedTools", "WebSearch");
      }

      // User message content
      const userContent = extractUserContent(params.messages);

      // Execute CLI
      const executor = _cliExecutor ?? defaultCliExecutor;
      const { stdout } = await executor(args, userContent, timeoutMs);

      // Parse JSON response
      let cliResponse: CliJsonResponse;
      try {
        cliResponse = JSON.parse(stdout);
      } catch {
        // Try to find JSON in output (CLI may emit non-JSON lines before the result)
        const jsonMatch = stdout.match(/\{[\s\S]*"type"\s*:\s*"result"[\s\S]*\}/);
        if (jsonMatch) {
          cliResponse = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`Failed to parse CLI JSON output: ${stdout.slice(0, 200)}`);
        }
      }

      if (cliResponse.subtype === "error" || cliResponse.is_error) {
        throw new Error(`CLI returned error: ${cliResponse.result}`);
      }

      // Map CLI response to ClaudeMessage
      const usage = cliResponse.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;

      // Record cost — prefer CLI's total_cost_usd when available
      let costCents: number;
      if (cliResponse.total_cost_usd != null && cliResponse.total_cost_usd > 0) {
        costCents = cliResponse.total_cost_usd * 100;
      } else {
        costCents = calculateCostCents(model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);
      }

      recordCall(
        model,
        caller,
        emailId || null,
        accountId || null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens,
        Date.now() - startTime,
        true,
        null,
      );

      if (totalAttempts > 1) {
        log.info({ caller, model, attempts: totalAttempts }, "LLM call succeeded after retries");
      }

      return {
        content: [{ type: "text", text: cliResponse.result }],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheCreateTokens,
        },
        model: cliResponse.model ?? model,
        stop_reason: "end_turn",
      };
    } catch (error) {
      lastError = error;
      const category = getRetryCategory(error);

      if (!category) break;

      const config = RETRY_CONFIGS[category];
      if (attempt >= config.maxRetries) break;

      const baseDelay = Math.min(config.initialDelayMs * Math.pow(2, attempt), config.maxDelayMs);
      const jitter = baseDelay * 0.1 * Math.random();
      const delay = baseDelay + jitter;

      log.warn(
        { caller, model, attempt: attempt + 1, maxRetries: config.maxRetries, category, delayMs: Math.round(delay) },
        "LLM call failed, retrying",
      );

      await asyncSleep(delay);
    } finally {
      releaseSlot();
    }
  }

  // All retries exhausted
  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  recordCall(model, caller, emailId || null, accountId || null, 0, 0, 0, 0, Date.now() - startTime, false, errMsg);
  throw lastError;
}

// ---------------------------------------------------------------------------
// Usage stats (unchanged)
// ---------------------------------------------------------------------------

export function getUsageStats(): UsageStats {
  if (!_db) {
    return {
      today: { totalCostCents: 0, totalCalls: 0 },
      thisWeek: { totalCostCents: 0, totalCalls: 0 },
      thisMonth: { totalCostCents: 0, totalCalls: 0 },
      byModel: [],
      byCaller: [],
    };
  }

  const today = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE date(created_at) = date('now')",
    )
    .get() as { cost: number; calls: number };

  const thisWeek = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-7 days')",
    )
    .get() as { cost: number; calls: number };

  const thisMonth = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days')",
    )
    .get() as { cost: number; calls: number };

  const byModel = _db
    .prepare(
      "SELECT model, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY model ORDER BY costCents DESC",
    )
    .all() as Array<{ model: string; costCents: number; calls: number }>;

  const byCaller = _db
    .prepare(
      "SELECT caller, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY caller ORDER BY costCents DESC",
    )
    .all() as Array<{ caller: string; costCents: number; calls: number }>;

  return {
    today: { totalCostCents: today.cost, totalCalls: today.calls },
    thisWeek: { totalCostCents: thisWeek.cost, totalCalls: thisWeek.calls },
    thisMonth: { totalCostCents: thisMonth.cost, totalCalls: thisMonth.calls },
    byModel,
    byCaller,
  };
}

export function getCallHistory(limit: number = 50): LlmCallRecord[] {
  if (!_db) return [];
  return _db
    .prepare("SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?")
    .all(limit) as LlmCallRecord[];
}
