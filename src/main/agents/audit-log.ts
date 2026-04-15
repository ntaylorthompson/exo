/**
 * Audit logging for agent actions.
 *
 * Works via the DB proxy in the utility process — all writes go through
 * the dbProxy function rather than importing better-sqlite3 directly.
 *
 * Each entry includes a SHA-256 hash chain: hash = SHA-256(prevHash + entryJson).
 * This provides tamper detection for forensic review.
 */

import { createHash } from "node:crypto";
import type { DbProxyFn } from "./types";

export interface AuditEntry {
  taskId: string;
  providerId: string;
  timestamp: string;
  eventType: string;
  toolName?: string;
  inputJson?: string;
  outputJson?: string;
  redactionApplied: boolean;
  userApproved?: boolean;
  accountId?: string;
  expiresAt?: string;
  hash?: string;
}

const MAX_BODY_LENGTH = 200;

/**
 * Redact sensitive content from a payload before logging.
 * Strips email bodies to 200 chars and removes attachment content.
 */
export function redactPayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") {
    return payload.length > MAX_BODY_LENGTH
      ? payload.slice(0, MAX_BODY_LENGTH) + "...[redacted]"
      : payload;
  }
  if (Array.isArray(payload)) {
    return payload.map(redactPayload);
  }
  if (typeof payload === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (key === "body" || key === "bodyHtml" || key === "bodyText" || key === "body_text") {
        result[key] =
          typeof value === "string" && value.length > MAX_BODY_LENGTH
            ? value.slice(0, MAX_BODY_LENGTH) + "...[redacted]"
            : value;
      } else if (key === "content" && typeof value === "string" && value.length > MAX_BODY_LENGTH) {
        // Attachment content or large text blocks
        result[key] = "[redacted: content too large]";
      } else {
        result[key] = redactPayload(value);
      }
    }
    return result;
  }
  return payload;
}

/** Compute SHA-256(prevHash + serializedEntry) for hash chain continuity. */
export function computeEntryHash(prevHash: string, entry: Omit<AuditEntry, "hash">): string {
  const entryJson = JSON.stringify(entry);
  return createHash("sha256").update(prevHash + entryJson).digest("hex");
}

export class AuditLog {
  private lastHash = "0".repeat(64); // genesis hash

  constructor(private readonly dbProxy: DbProxyFn) {}

  async saveEntry(entry: AuditEntry): Promise<void> {
    const redacted: AuditEntry = {
      ...entry,
      inputJson: entry.inputJson
        ? JSON.stringify(redactPayload(JSON.parse(entry.inputJson)))
        : undefined,
      outputJson: entry.outputJson
        ? JSON.stringify(redactPayload(JSON.parse(entry.outputJson)))
        : undefined,
      redactionApplied: true,
    };

    // Compute and attach hash chain link
    const hash = computeEntryHash(this.lastHash, redacted);
    redacted.hash = hash;
    this.lastHash = hash;

    await this.dbProxy("saveAuditEntry", redacted);
  }

  async cleanupExpired(): Promise<void> {
    await this.dbProxy("cleanupExpiredAudit");
  }
}
