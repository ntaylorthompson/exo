/**
 * Trusted Senders — gate for AI processing of email content.
 *
 * When enabled, only emails from trusted senders are analyzed, auto-drafted,
 * or have their bodies exposed to the LLM. Untrusted email metadata (subject,
 * from, date) is still visible; only the body is withheld.
 *
 * Trust is determined by (in order):
 * 1. Mode disabled → all senders trusted (backward compatible)
 * 2. Sender is the user's own address → always trusted
 * 3. Explicit match in the senders list (supports *@domain.com patterns)
 * 4. Auto-trust: user has previously sent to this address's domain
 * 5. Otherwise → untrusted
 */

import type { Config } from "../../shared/types";

// ---------------------------------------------------------------------------
// Injectable dependencies (overridable for testing)
// ---------------------------------------------------------------------------
interface TrustedSendersDeps {
  getConfig: () => Config;
  getAccounts: () => Array<{ email: string }>;
  getSentEmailsToSameDomain: (domain: string, accountId: string, limit: number) => unknown[];
}

let deps: TrustedSendersDeps | null = null;

function getDeps(): TrustedSendersDeps {
  if (deps) return deps;
  // Lazy-load to avoid pulling in Electron at import time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const settings = require("../ipc/settings.ipc");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const db = require("../db");
  deps = {
    getConfig: settings.getConfig,
    getAccounts: db.getAccounts,
    getSentEmailsToSameDomain: db.getSentEmailsToSameDomain,
  };
  return deps;
}

/** Override dependencies for testing. */
export function _setDepsForTesting(testDeps: TrustedSendersDeps): void {
  deps = testDeps;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Extract the bare email address from a "Name <email>" or plain "email" string. */
export function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

/** Extract the domain from an email address. */
export function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

/**
 * Check whether a sender pattern matches an email address.
 * Supports exact match ("alice@co.com") and domain wildcard ("*@co.com").
 */
export function matchesPattern(email: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (normalizedPattern.startsWith("*@")) {
    const patternDomain = normalizedPattern.slice(2);
    return extractDomain(email) === patternDomain;
  }
  return email === normalizedPattern;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Determine whether a sender is trusted for AI processing.
 *
 * @param fromAddress - The email's `from` field (may include display name)
 * @param accountId - The account receiving this email
 * @returns true if the sender is trusted, false otherwise
 */
export function isTrustedSender(
  fromAddress: string,
  accountId: string,
): boolean {
  const { getConfig, getAccounts, getSentEmailsToSameDomain } = getDeps();
  const config = getConfig();
  const mode = config.trustedSendersMode;

  // 1. Mode disabled or not configured → all senders trusted
  if (!mode?.enabled) {
    return true;
  }

  const senderEmail = extractEmail(fromAddress);

  // 2. Always trust the user's own addresses
  const accounts = getAccounts();
  for (const account of accounts) {
    if (account.email.toLowerCase() === senderEmail) {
      return true;
    }
  }

  // 3. Explicit match against senders list
  const senders = mode.senders ?? [];
  for (const pattern of senders) {
    if (matchesPattern(senderEmail, pattern)) {
      return true;
    }
  }

  // 4. Auto-trust: user has sent to this domain before
  if (mode.domainsAutoTrust !== false) {
    const domain = extractDomain(senderEmail);
    if (domain) {
      const sentToDomain = getSentEmailsToSameDomain(domain, accountId, 1);
      if (sentToDomain.length > 0) {
        return true;
      }
    }
  }

  // 5. Not trusted
  return false;
}
