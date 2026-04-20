import { inspect } from "node:util";

function isDebugEnabled(): boolean {
  const value = process.env.SITE_AGENT_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function info(message: string): void {
  process.stdout.write(`[INFO] ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`[WARN] ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`[ERROR] ${message}\n`);
}

export function debug(message: string, details?: unknown): void {
  if (!isDebugEnabled()) {
    return;
  }

  if (details === undefined) {
    process.stdout.write(`[DEBUG] ${message}\n`);
    return;
  }

  process.stdout.write(`[DEBUG] ${message} ${inspect(details, { depth: 4, breakLength: 120 })}\n`);
}
