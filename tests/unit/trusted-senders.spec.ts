/**
 * Unit tests for trusted-senders module.
 *
 * Tests cover: extractEmail, extractDomain, matchesPattern, and isTrustedSender
 * with all trust paths (disabled, own address, explicit match, wildcard,
 * auto-trust, untrusted).
 */
import { test, expect } from "@playwright/test";
import {
  extractEmail,
  extractDomain,
  matchesPattern,
  isTrustedSender,
  _setDepsForTesting,
} from "../../src/main/services/trusted-senders";
import type { Config } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setupDeps(overrides: {
  config?: Partial<Config>;
  accounts?: Array<{ email: string }>;
  sentToDomain?: unknown[];
}) {
  _setDepsForTesting({
    getConfig: () => (overrides.config ?? {}) as Config,
    getAccounts: () => overrides.accounts ?? [],
    getSentEmailsToSameDomain: () => overrides.sentToDomain ?? [],
  });
}

// ---------------------------------------------------------------------------
// extractEmail
// ---------------------------------------------------------------------------
test.describe("extractEmail", () => {
  test("extracts email from angle bracket format", () => {
    expect(extractEmail("Alice Smith <alice@example.com>")).toBe("alice@example.com");
  });

  test("handles bare email address", () => {
    expect(extractEmail("bob@example.com")).toBe("bob@example.com");
  });

  test("lowercases the result", () => {
    expect(extractEmail("Alice@EXAMPLE.COM")).toBe("alice@example.com");
  });

  test("handles whitespace", () => {
    expect(extractEmail("  alice@example.com  ")).toBe("alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// extractDomain
// ---------------------------------------------------------------------------
test.describe("extractDomain", () => {
  test("extracts domain from email", () => {
    expect(extractDomain("alice@example.com")).toBe("example.com");
  });

  test("handles subdomains", () => {
    expect(extractDomain("alice@mail.example.com")).toBe("mail.example.com");
  });

  test("returns empty string for invalid email", () => {
    expect(extractDomain("nope")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// matchesPattern
// ---------------------------------------------------------------------------
test.describe("matchesPattern", () => {
  test("exact match", () => {
    expect(matchesPattern("alice@co.com", "alice@co.com")).toBe(true);
  });

  test("exact match is case-insensitive", () => {
    expect(matchesPattern("alice@co.com", "Alice@CO.com")).toBe(true);
  });

  test("exact match rejects different addresses", () => {
    expect(matchesPattern("bob@co.com", "alice@co.com")).toBe(false);
  });

  test("wildcard domain match", () => {
    expect(matchesPattern("anyone@trusted.com", "*@trusted.com")).toBe(true);
  });

  test("wildcard does not match subdomains", () => {
    expect(matchesPattern("user@evil.trusted.com", "*@trusted.com")).toBe(false);
  });

  test("wildcard is case-insensitive", () => {
    expect(matchesPattern("user@TRUSTED.COM", "*@trusted.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isTrustedSender
// ---------------------------------------------------------------------------
test.describe("isTrustedSender", () => {
  test("returns true when mode is not configured", () => {
    setupDeps({ config: {} });
    expect(isTrustedSender("stranger@evil.com", "acct-1")).toBe(true);
  });

  test("returns true when mode is explicitly disabled", () => {
    setupDeps({ config: { trustedSendersMode: { enabled: false, senders: [], domainsAutoTrust: true } } });
    expect(isTrustedSender("stranger@evil.com", "acct-1")).toBe(true);
  });

  test("trusts user's own email address", () => {
    setupDeps({
      config: { trustedSendersMode: { enabled: true, senders: [], domainsAutoTrust: false } },
      accounts: [{ email: "me@mycompany.com" }],
    });
    expect(isTrustedSender("Me <me@mycompany.com>", "acct-1")).toBe(true);
  });

  test("own address match is case-insensitive", () => {
    setupDeps({
      config: { trustedSendersMode: { enabled: true, senders: [], domainsAutoTrust: false } },
      accounts: [{ email: "Me@MyCompany.com" }],
    });
    expect(isTrustedSender("ME@MYCOMPANY.COM", "acct-1")).toBe(true);
  });

  test("explicit sender match", () => {
    setupDeps({
      config: { trustedSendersMode: { enabled: true, senders: ["alice@co.com"], domainsAutoTrust: false } },
    });
    expect(isTrustedSender("Alice <alice@co.com>", "acct-1")).toBe(true);
  });

  test("wildcard domain match", () => {
    setupDeps({
      config: { trustedSendersMode: { enabled: true, senders: ["*@trusted-corp.com"], domainsAutoTrust: false } },
    });
    expect(isTrustedSender("anyone@trusted-corp.com", "acct-1")).toBe(true);
  });

  test("wildcard does not match subdomains", () => {
    setupDeps({
      config: { trustedSendersMode: { enabled: true, senders: ["*@corp.com"], domainsAutoTrust: false } },
    });
    expect(isTrustedSender("attacker@evil.corp.com", "acct-1")).toBe(false);
  });

  test("auto-trust from sent history", () => {
    setupDeps({
      config: { trustedSendersMode: { enabled: true, senders: [], domainsAutoTrust: true } },
      sentToDomain: [{ id: "sent-1" }],
    });
    expect(isTrustedSender("new-person@partner.com", "acct-1")).toBe(true);
  });

  test("auto-trust disabled returns false for unknown sender", () => {
    setupDeps({
      config: { trustedSendersMode: { enabled: true, senders: [], domainsAutoTrust: false } },
    });
    expect(isTrustedSender("stranger@unknown.com", "acct-1")).toBe(false);
  });

  test("untrusted sender when no rules match", () => {
    setupDeps({
      config: { trustedSendersMode: { enabled: true, senders: ["friend@known.com"], domainsAutoTrust: false } },
      accounts: [{ email: "me@mycompany.com" }],
      sentToDomain: [],
    });
    expect(isTrustedSender("stranger@evil.com", "acct-1")).toBe(false);
  });
});
