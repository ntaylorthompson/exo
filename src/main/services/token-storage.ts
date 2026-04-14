/**
 * Secure token storage using Electron's safeStorage API.
 *
 * In production (packaged app): tokens are encrypted via the OS keychain
 * (macOS Keychain, Windows DPAPI, Linux libsecret) and stored as binary files.
 *
 * In dev mode: tokens are stored as plain JSON to avoid macOS keychain ACL
 * churn when the code signing identity changes between dev builds.
 * See extension-context.ts:39-44 for prior art on this decision.
 *
 * All files are written with 0o600 permissions (owner read/write only).
 */
import { safeStorage, app } from "electron";
import { readFile, writeFile, unlink, access, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir";
import { createLogger } from "./logger";

const log = createLogger("token-storage");

function isDev(): boolean {
  return !app.isPackaged;
}

function canEncrypt(): boolean {
  return !isDev() && safeStorage.isEncryptionAvailable();
}

function getEncPath(accountId: string): string {
  const file = accountId === "default" ? "tokens.enc" : `tokens-${accountId}.enc`;
  return join(getDataDir(), file);
}

function getJsonPath(accountId: string): string {
  const file = accountId === "default" ? "tokens.json" : `tokens-${accountId}.json`;
  return join(getDataDir(), file);
}

/**
 * Save OAuth tokens for an account. In production, encrypts via OS keychain.
 */
export async function saveTokens(accountId: string, tokens: object): Promise<void> {
  const json = JSON.stringify(tokens, null, 2);

  if (canEncrypt()) {
    const encPath = getEncPath(accountId);
    const encrypted = safeStorage.encryptString(json);
    await writeFile(encPath, encrypted, { mode: 0o600 });
    log.info(`Saved encrypted tokens for account ${accountId}`);
  } else {
    const jsonPath = getJsonPath(accountId);
    await writeFile(jsonPath, json, { mode: 0o600 });
  }
}

/**
 * Load OAuth tokens for an account. Tries encrypted first, falls back to JSON.
 * Automatically migrates plaintext tokens to encrypted on first read in production.
 */
export async function loadTokens(accountId: string): Promise<object | null> {
  // Try encrypted first
  if (canEncrypt()) {
    const encPath = getEncPath(accountId);
    try {
      const buffer = await readFile(encPath);
      const json = safeStorage.decryptString(buffer);
      return JSON.parse(json);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn({ err }, `Failed to read encrypted tokens for ${accountId}, trying JSON fallback`);
      }
    }
  }

  // Fallback to plain JSON
  const jsonPath = getJsonPath(accountId);
  try {
    const raw = await readFile(jsonPath, "utf-8");
    const tokens = JSON.parse(raw);

    // Auto-migrate to encrypted if available
    if (canEncrypt()) {
      await migrateToEncrypted(accountId, tokens);
    } else {
      // Ensure permissions are restrictive even for plaintext
      await setPermissions(jsonPath);
    }

    return tokens;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Delete all token files for an account (both encrypted and plaintext).
 */
export async function deleteTokens(accountId: string): Promise<void> {
  for (const path of [getEncPath(accountId), getJsonPath(accountId)]) {
    try {
      await unlink(path);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * Check if tokens exist for an account (either encrypted or plaintext).
 */
export async function hasTokens(accountId: string): Promise<boolean> {
  for (const path of [getEncPath(accountId), getJsonPath(accountId)]) {
    try {
      await access(path);
      return true;
    } catch {
      // continue to next path
    }
  }
  return false;
}

/**
 * Get the path to the credentials file (shared across accounts).
 * Credentials are the OAuth app ID/secret, which Google considers non-secret
 * for desktop apps (security relies on localhost redirect + user consent).
 */
export function getCredentialsFile(): string {
  return join(getDataDir(), "credentials.json");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function migrateToEncrypted(accountId: string, tokens: object): Promise<void> {
  try {
    const encPath = getEncPath(accountId);
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens, null, 2));
    await writeFile(encPath, encrypted, { mode: 0o600 });
    // Delete plaintext after successful encryption
    const jsonPath = getJsonPath(accountId);
    await unlink(jsonPath);
    log.info(`Migrated tokens for account ${accountId} from plaintext to encrypted storage`);
  } catch (err) {
    log.warn({ err }, `Failed to migrate tokens for ${accountId} to encrypted storage`);
  }
}

async function setPermissions(filePath: string): Promise<void> {
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Best-effort — may fail on some platforms
  }
}
