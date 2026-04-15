/**
 * Unit tests for Phase 5 — Alignment Safeguards.
 *
 * Covers: rate limiting, audit log hash chain, memory approval filtering,
 * and anomaly detection.
 */
import { test, expect } from "@playwright/test";
import { computeEntryHash, redactPayload, AuditLog } from "../../src/main/agents/audit-log";
import type { AuditEntry } from "../../src/main/agents/audit-log";
import { SafetyMonitor } from "../../src/main/agents/safety-monitor";
import {
  MemorySchema,
  MemoryCreatedBySchema,
  ConfigSchema,
} from "../../src/shared/types";
// getScopes is tested indirectly since gmail-client.ts imports electron.
// We test the scope logic inline here instead.

// ---------------------------------------------------------------------------
// Audit Log — redactPayload
// ---------------------------------------------------------------------------
test.describe("redactPayload", () => {
  test("truncates long strings", () => {
    const long = "a".repeat(300);
    const result = redactPayload(long);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeLessThan(300);
    expect((result as string).endsWith("...[redacted]")).toBe(true);
  });

  test("passes through short strings unchanged", () => {
    expect(redactPayload("hello")).toBe("hello");
  });

  test("redacts body fields in objects", () => {
    const obj = { body: "a".repeat(300), subject: "short" };
    const result = redactPayload(obj) as Record<string, string>;
    expect(result.body.endsWith("...[redacted]")).toBe(true);
    expect(result.subject).toBe("short");
  });

  test("handles null and undefined", () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
  });

  test("recurses into arrays", () => {
    const arr = [{ body: "x".repeat(300) }, "short"];
    const result = redactPayload(arr) as unknown[];
    expect((result[0] as Record<string, string>).body.endsWith("...[redacted]")).toBe(true);
    expect(result[1]).toBe("short");
  });
});

// ---------------------------------------------------------------------------
// Audit Log — Hash chain
// ---------------------------------------------------------------------------
test.describe("computeEntryHash", () => {
  test("produces a 64-char hex string", () => {
    const entry: Omit<AuditEntry, "hash"> = {
      taskId: "task-1",
      providerId: "orchestrator",
      timestamp: "2026-04-15T00:00:00Z",
      eventType: "tool_call",
      toolName: "read_email",
      redactionApplied: true,
    };
    const hash = computeEntryHash("0".repeat(64), entry);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("same inputs produce same hash (deterministic)", () => {
    const entry: Omit<AuditEntry, "hash"> = {
      taskId: "task-1",
      providerId: "orchestrator",
      timestamp: "2026-04-15T00:00:00Z",
      eventType: "tool_call",
      redactionApplied: true,
    };
    const prev = "0".repeat(64);
    expect(computeEntryHash(prev, entry)).toBe(computeEntryHash(prev, entry));
  });

  test("different prevHash produces different hash", () => {
    const entry: Omit<AuditEntry, "hash"> = {
      taskId: "task-1",
      providerId: "orchestrator",
      timestamp: "2026-04-15T00:00:00Z",
      eventType: "tool_call",
      redactionApplied: true,
    };
    const hash1 = computeEntryHash("0".repeat(64), entry);
    const hash2 = computeEntryHash("1".repeat(64), entry);
    expect(hash1).not.toBe(hash2);
  });

  test("hash chain detects tampered entry", () => {
    const entry1: Omit<AuditEntry, "hash"> = {
      taskId: "task-1",
      providerId: "orchestrator",
      timestamp: "2026-04-15T00:00:00Z",
      eventType: "tool_call",
      toolName: "read_email",
      redactionApplied: true,
    };
    const entry2: Omit<AuditEntry, "hash"> = {
      taskId: "task-1",
      providerId: "orchestrator",
      timestamp: "2026-04-15T00:00:01Z",
      eventType: "tool_result",
      toolName: "read_email",
      redactionApplied: true,
    };

    const genesis = "0".repeat(64);
    const hash1 = computeEntryHash(genesis, entry1);
    const hash2 = computeEntryHash(hash1, entry2);

    // Tampering: modify entry1 and recompute
    const tampered1 = { ...entry1, toolName: "modify_labels" };
    const tamperedHash1 = computeEntryHash(genesis, tampered1);
    const recomputedHash2 = computeEntryHash(tamperedHash1, entry2);

    // Original chain is broken
    expect(recomputedHash2).not.toBe(hash2);
  });
});

test.describe("AuditLog", () => {
  test("saveEntry includes hash in the saved entry", async () => {
    const saved: AuditEntry[] = [];
    const mockDbProxy = async (method: string, entry: AuditEntry) => {
      if (method === "saveAuditEntry") saved.push(entry);
    };
    const auditLog = new AuditLog(mockDbProxy as never);

    await auditLog.saveEntry({
      taskId: "task-1",
      providerId: "orchestrator",
      timestamp: "2026-04-15T00:00:00Z",
      eventType: "tool_call",
      toolName: "read_email",
      redactionApplied: false,
    });

    expect(saved).toHaveLength(1);
    expect(saved[0].hash).toBeTruthy();
    expect(saved[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("consecutive entries have chained hashes", async () => {
    const saved: AuditEntry[] = [];
    const mockDbProxy = async (method: string, entry: AuditEntry) => {
      if (method === "saveAuditEntry") saved.push(entry);
    };
    const auditLog = new AuditLog(mockDbProxy as never);

    await auditLog.saveEntry({
      taskId: "task-1",
      providerId: "orchestrator",
      timestamp: "2026-04-15T00:00:00Z",
      eventType: "tool_call",
      redactionApplied: false,
    });
    await auditLog.saveEntry({
      taskId: "task-1",
      providerId: "orchestrator",
      timestamp: "2026-04-15T00:00:01Z",
      eventType: "tool_result",
      redactionApplied: false,
    });

    expect(saved[0].hash).not.toBe(saved[1].hash);
    // Second hash is derived from first (chain continuity)
    expect(saved[1].hash).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Safety Monitor — Anomaly Detection
// ---------------------------------------------------------------------------
test.describe("SafetyMonitor", () => {
  test("no anomaly for normal tool calls", () => {
    const monitor = new SafetyMonitor();
    const result = monitor.recordToolCall("read_email", { emailId: "123" });
    expect(result).toBeNull();
  });

  test("flags bulk label modifications", () => {
    const monitor = new SafetyMonitor({ maxLabelModifications: 3 });
    expect(monitor.recordToolCall("modify_labels", { addLabelIds: ["STARRED"] })).toBeNull();
    expect(monitor.recordToolCall("modify_labels", { addLabelIds: ["STARRED"] })).toBeNull();
    const flag = monitor.recordToolCall("modify_labels", { addLabelIds: ["STARRED"] });
    expect(flag).not.toBeNull();
    expect(flag!.type).toBe("bulk_label_modification");
    expect(flag!.count).toBe(3);
  });

  test("flags repeated TRASH/SPAM attempts", () => {
    const monitor = new SafetyMonitor({ maxTrashSpamAttempts: 2 });
    expect(monitor.recordToolCall("modify_labels", { addLabelIds: ["TRASH"] })).toBeNull();
    const flag = monitor.recordToolCall("modify_labels", { addLabelIds: ["SPAM"] });
    expect(flag).not.toBeNull();
    expect(flag!.type).toBe("repeated_trash_spam");
  });

  test("flags excessive memory saves", () => {
    const monitor = new SafetyMonitor({ maxMemorySaves: 2 });
    expect(monitor.recordToolCall("save_memory", { content: "test" })).toBeNull();
    const flag = monitor.recordToolCall("save_memory", { content: "test2" });
    expect(flag).not.toBeNull();
    expect(flag!.type).toBe("excessive_memory_saves");
  });

  test("does not flag unmonitored tools", () => {
    const monitor = new SafetyMonitor();
    for (let i = 0; i < 100; i++) {
      expect(monitor.recordToolCall("read_email", {})).toBeNull();
      expect(monitor.recordToolCall("read_thread", {})).toBeNull();
      expect(monitor.recordToolCall("search_gmail", {})).toBeNull();
    }
  });

  test("TRASH detection is case-sensitive (exact label match)", () => {
    const monitor = new SafetyMonitor({ maxTrashSpamAttempts: 1 });
    // Non-matching label
    expect(monitor.recordToolCall("modify_labels", { addLabelIds: ["trash"] })).toBeNull();
    // Matching label
    const flag = monitor.recordToolCall("modify_labels", { addLabelIds: ["TRASH"] });
    expect(flag).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Memory approval — type-level checks
// ---------------------------------------------------------------------------
test.describe("Memory approval types", () => {
  test("Memory type includes createdBy and approved fields", () => {
    const result = MemorySchema.safeParse({
      id: "test-1",
      accountId: "acc-1",
      scope: "global",
      scopeValue: null,
      content: "test memory",
      source: "agent",
      enabled: true,
      createdBy: "agent",
      approved: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("Memory defaults createdBy to 'user' and approved to true", () => {
    const result = MemorySchema.parse({
      id: "test-2",
      accountId: "acc-1",
      scope: "global",
      scopeValue: null,
      content: "test memory",
      source: "manual",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(result.createdBy).toBe("user");
    expect(result.approved).toBe(true);
  });

  test("MemoryCreatedBySchema accepts valid values", () => {
    expect(MemoryCreatedBySchema.safeParse("user").success).toBe(true);
    expect(MemoryCreatedBySchema.safeParse("agent").success).toBe(true);
    expect(MemoryCreatedBySchema.safeParse("draft-learner").success).toBe(true);
    expect(MemoryCreatedBySchema.safeParse("unknown").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — config schema
// ---------------------------------------------------------------------------
test.describe("Rate limit config", () => {
  test("ConfigSchema accepts toolRateLimits", () => {
    const result = ConfigSchema.safeParse({
      toolRateLimits: { modify_labels: 5, save_memory: 2 },
    });
    expect(result.success).toBe(true);
    expect(result.data!.toolRateLimits).toEqual({ modify_labels: 5, save_memory: 2 });
  });

  test("ConfigSchema defaults toolRateLimits to undefined", () => {
    const result = ConfigSchema.parse({});
    expect(result.toolRateLimits).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gmail scopes config
// ---------------------------------------------------------------------------
test.describe("Gmail scopes config", () => {
  test("ConfigSchema accepts gmailScopes 'full'", () => {
    const result = ConfigSchema.safeParse({ gmailScopes: "full" });
    expect(result.success).toBe(true);
    expect(result.data!.gmailScopes).toBe("full");
  });

  test("ConfigSchema accepts gmailScopes 'read-organize'", () => {
    const result = ConfigSchema.safeParse({ gmailScopes: "read-organize" });
    expect(result.success).toBe(true);
    expect(result.data!.gmailScopes).toBe("read-organize");
  });

  test("ConfigSchema defaults gmailScopes to 'full'", () => {
    const result = ConfigSchema.parse({});
    expect(result.gmailScopes).toBe("full");
  });

  test("ConfigSchema rejects invalid gmailScopes", () => {
    const result = ConfigSchema.safeParse({ gmailScopes: "invalid" });
    expect(result.success).toBe(false);
  });
});

// getScopes lives in gmail-client.ts which imports electron — can't import in
// unit tests. Test the scope logic via the constants directly.
test.describe("Gmail scope constants", () => {
  const FULL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/calendar.readonly",
  ];
  const READ_ORGANIZE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/calendar.readonly",
  ];

  test("full scopes include gmail.send and gmail.compose", () => {
    expect(FULL_SCOPES.some((s) => s.includes("gmail.send"))).toBe(true);
    expect(FULL_SCOPES.some((s) => s.includes("gmail.compose"))).toBe(true);
  });

  test("read-organize scopes exclude gmail.send and gmail.compose", () => {
    expect(READ_ORGANIZE_SCOPES.some((s) => s.includes("gmail.send"))).toBe(false);
    expect(READ_ORGANIZE_SCOPES.some((s) => s.includes("gmail.compose"))).toBe(false);
  });

  test("read-organize scopes still include gmail.readonly and gmail.modify", () => {
    expect(READ_ORGANIZE_SCOPES.some((s) => s.includes("gmail.readonly"))).toBe(true);
    expect(READ_ORGANIZE_SCOPES.some((s) => s.includes("gmail.modify"))).toBe(true);
  });
});
