import fs from "node:fs";
import path from "node:path";
import type { AuthIdentity } from "./profile.js";

const CREDENTIALS_FILE = path.resolve(process.cwd(), ".auth", "credentials.json");

function getOriginKey(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    return /^https?:$/i.test(url.protocol) ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

function getLegacyHostnameKey(urlString: string): string | null {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function loadCredentials(): Record<string, AuthIdentity> {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const content = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, AuthIdentity>) : {};
    }
  } catch (error) {
    console.error(`Failed to read credentials from ${CREDENTIALS_FILE}`, error);
  }
  return {};
}

export function saveStoredIdentity(url: string, identity: AuthIdentity): void {
  const credentialKey = getOriginKey(url);
  if (!credentialKey) return;

  const credentials = loadCredentials();
  credentials[credentialKey] = identity;

  try {
    const dir = path.dirname(CREDENTIALS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), "utf-8");
  } catch (error) {
    console.error(`Failed to save credentials to ${CREDENTIALS_FILE}`, error);
  }
}

export function getStoredIdentity(url: string): AuthIdentity | null {
  const credentials = loadCredentials();
  const originKey = getOriginKey(url);
  if (originKey && credentials[originKey]) {
    return credentials[originKey] || null;
  }

  const legacyHostnameKey = getLegacyHostnameKey(url);
  return legacyHostnameKey ? credentials[legacyHostnameKey] || null : null;
}

export function hasStoredIdentity(url: string): boolean {
  return getStoredIdentity(url) !== null;
}
