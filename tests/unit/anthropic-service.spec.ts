/**
 * Unit tests for AnthropicService — the centralized Claude CLI wrapper.
 *
 * Tests cover: happy path, retry logic, cost recording, timeout,
 * error recording, and query functions (getUsageStats, getCallHistory).
 *
 * Strategy: Use _setCliExecutorForTesting() to inject a mock CLI executor, and
 * setAnthropicServiceDb() with an in-memory SQLite database for cost tracking.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import {
  createMessage,
  _setCliExecutorForTesting,
  setAnthropicServiceDb,
  getUsageStats,
  getCallHistory,
  type LlmCallRecord,
} from "../../src/main/services/anthropic-service";

const require = createRequire(import.meta.url);

// --- Database setup ---

type DB = BetterSqlite3.Database;
let DatabaseCtor: (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB) | null =
  null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const testDb = new DatabaseCtor!(":memory:");
  testDb.close();
} catch (e: unknown) {
  const err = e as Error;
  if (
    err.message?.includes("NODE_MODULE_VERSION") ||
    err.message?.includes("did not self-register")
  ) {
    nativeModuleError = err.message.split("\n")[0];
  } else {
    throw e;
  }
}

// --- Mock CLI executor ---

function makeCliSuccessResponse(model: string = "claude-sonnet-4-20250514") {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Hello, world!",
    model,
    total_cost_usd: 0.0010935,
    duration_ms: 100,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    },
  });
}

interface MockCall {
  args: string[];
  stdin: string;
}

function createMockExecutor(
  behavior: "success" | "rate-limit-then-success" | "server-error-then-success" | "always-fail",
  failCount: number = 1,
) {
  const calls: MockCall[] = [];
  let callIndex = 0;

  const executor = async (args: string[], stdin: string) => {
    calls.push({ args, stdin });
    callIndex++;

    if (behavior === "success") {
      return { stdout: makeCliSuccessResponse(), stderr: "" };
    }

    if (behavior === "rate-limit-then-success") {
      if (callIndex <= failCount) {
        const err = new Error("CLI exited with code 1: rate limit exceeded (429)");
        (err as Error & { code: number; stderr: string }).code = 1;
        (err as Error & { stderr: string }).stderr = "rate limit exceeded (429)";
        throw err;
      }
      return { stdout: makeCliSuccessResponse(), stderr: "" };
    }

    if (behavior === "server-error-then-success") {
      if (callIndex <= failCount) {
        const err = new Error("CLI exited with code 1: internal server error (500)");
        (err as Error & { code: number; stderr: string }).code = 1;
        (err as Error & { stderr: string }).stderr = "internal server error (500)";
        throw err;
      }
      return { stdout: makeCliSuccessResponse(), stderr: "" };
    }

    if (behavior === "always-fail") {
      // Non-retryable error (no recognized pattern)
      const err = new Error("CLI exited with code 1: Bad request — invalid model");
      (err as Error & { code: number; stderr: string }).code = 1;
      (err as Error & { stderr: string }).stderr = "Bad request — invalid model";
      throw err;
    }

    throw new Error("Unknown behavior");
  };

  return { executor, calls };
}

function makeTestParams(model: string = "claude-sonnet-4-20250514") {
  return {
    model,
    max_tokens: 256,
    messages: [{ role: "user" as const, content: "Hello" }],
  };
}

// --- Tests ---

test.describe("AnthropicService", () => {
  // Skip all tests if native module is unavailable
  test.skip(!!nativeModuleError, `Skipping: ${nativeModuleError}`);

  let testDb: DB;

  test.beforeEach(() => {
    testDb = new DatabaseCtor!(":memory:");
    setAnthropicServiceDb(testDb);
  });

  test.afterEach(() => {
    _setCliExecutorForTesting(null);
    testDb?.close();
  });

  test("createMessage invokes CLI and returns response", async () => {
    const { executor } = createMockExecutor("success");
    _setCliExecutorForTesting(executor);

    const result = await createMessage(makeTestParams(), { caller: "test" });

    expect(result.content[0]).toEqual({ type: "text", text: "Hello, world!" });
    expect(result.usage.input_tokens).toBe(100);
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  test("retries on rate limit error and eventually succeeds", async () => {
    const { executor, calls } = createMockExecutor("rate-limit-then-success", 2);
    _setCliExecutorForTesting(executor);

    const result = await createMessage(makeTestParams(), { caller: "test-retry" });

    expect(result.content[0].text).toBe("Hello, world!");
    // Should have made 3 calls: 2 failures + 1 success
    expect(calls.length).toBe(3);
  });

  test("retries on internal server error (up to 3x)", async () => {
    const { executor, calls } = createMockExecutor("server-error-then-success", 2);
    _setCliExecutorForTesting(executor);

    const result = await createMessage(makeTestParams(), { caller: "test-server-retry" });

    expect(result.content[0].text).toBe("Hello, world!");
    expect(calls.length).toBe(3);
  });

  test("does not retry on non-retryable errors (fails immediately)", async () => {
    const { executor, calls } = createMockExecutor("always-fail");
    _setCliExecutorForTesting(executor);

    await expect(createMessage(makeTestParams(), { caller: "test-no-retry" })).rejects.toThrow(
      "Bad request",
    );

    // Should have made exactly 1 call — no retries
    expect(calls.length).toBe(1);
  });

  test("records successful call to llm_calls table with correct values", async () => {
    const { executor } = createMockExecutor("success");
    _setCliExecutorForTesting(executor);

    await createMessage(makeTestParams(), {
      caller: "test-cost",
      emailId: "email-123",
      accountId: "acct-456",
    });

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;

    expect(row).toBeTruthy();
    expect(row.model).toBe("claude-sonnet-4-20250514");
    expect(row.caller).toBe("test-cost");
    expect(row.email_id).toBe("email-123");
    expect(row.account_id).toBe("acct-456");
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(50);
    expect(row.cache_read_tokens).toBe(20);
    expect(row.cache_create_tokens).toBe(10);
    expect(row.success).toBe(1);
    expect(row.error_message).toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("cost uses total_cost_usd from CLI response", async () => {
    const { executor } = createMockExecutor("success");
    _setCliExecutorForTesting(executor);

    await createMessage(makeTestParams("claude-sonnet-4-20250514"), { caller: "test-cost-math" });

    const row = testDb.prepare("SELECT cost_cents FROM llm_calls LIMIT 1").get() as {
      cost_cents: number;
    };

    // CLI returns total_cost_usd: 0.0010935, which is 0.10935 cents
    expect(row.cost_cents).toBeCloseTo(0.10935, 4);
  });

  test("timeout causes CLI to fail with connection error", async () => {
    const executor = async () => {
      // Simulate a timeout by never resolving
      return new Promise<{ stdout: string; stderr: string }>((_, reject) => {
        setTimeout(() => reject(new Error("timed out")), 10);
      });
    };
    _setCliExecutorForTesting(executor);

    await expect(
      createMessage(makeTestParams(), { caller: "test-timeout", timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/i);
  });

  test("records failed call with error_message", async () => {
    const { executor } = createMockExecutor("always-fail");
    _setCliExecutorForTesting(executor);

    await expect(
      createMessage(makeTestParams(), { caller: "test-error-record" }),
    ).rejects.toThrow();

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;

    expect(row).toBeTruthy();
    expect(row.success).toBe(0);
    expect(row.error_message).toContain("Bad request");
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });

  test("getUsageStats returns correct aggregation", async () => {
    const { executor } = createMockExecutor("success");
    _setCliExecutorForTesting(executor);

    await createMessage(makeTestParams(), { caller: "analyzer" });
    await createMessage(makeTestParams(), { caller: "analyzer" });
    await createMessage(makeTestParams(), { caller: "drafter" });

    const stats = getUsageStats();

    expect(stats.today.totalCalls).toBe(3);
    expect(stats.today.totalCostCents).toBeGreaterThan(0);
    expect(stats.thisWeek.totalCalls).toBe(3);
    expect(stats.thisMonth.totalCalls).toBe(3);

    expect(stats.byCaller).toHaveLength(2);
    const analyzerEntry = stats.byCaller.find((e) => e.caller === "analyzer");
    expect(analyzerEntry?.calls).toBe(2);
    const drafterEntry = stats.byCaller.find((e) => e.caller === "drafter");
    expect(drafterEntry?.calls).toBe(1);
  });

  test("getCallHistory returns records in descending order", async () => {
    const { executor } = createMockExecutor("success");
    _setCliExecutorForTesting(executor);

    await createMessage(makeTestParams(), { caller: "first" });
    await createMessage(makeTestParams(), { caller: "second" });
    await createMessage(makeTestParams(), { caller: "third" });

    const history = getCallHistory(10);

    expect(history).toHaveLength(3);
    expect(history[0].caller).toBe("third");
    expect(history[1].caller).toBe("second");
    expect(history[2].caller).toBe("first");
  });

  test("getUsageStats returns zeroes when no calls recorded", () => {
    const stats = getUsageStats();

    expect(stats.today.totalCalls).toBe(0);
    expect(stats.today.totalCostCents).toBe(0);
    expect(stats.byModel).toHaveLength(0);
    expect(stats.byCaller).toHaveLength(0);
  });

  test("getCallHistory returns empty array when no calls recorded", () => {
    const history = getCallHistory();
    expect(history).toHaveLength(0);
  });
});
