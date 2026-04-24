import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_RENDER_DATA_ROOT = "/opt/render/project/src/data";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

export function writeText(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf8");
}

function resolveDataRoot(): string {
  const configuredRoot = process.env.SITE_AGENT_DATA_DIR?.trim();
  if (configuredRoot) {
    ensureDir(configuredRoot);
    return configuredRoot;
  }

  if (process.env.RENDER === "true") {
    ensureDir(DEFAULT_RENDER_DATA_ROOT);
    return DEFAULT_RENDER_DATA_ROOT;
  }

  // Some serverless runtimes expose a read-only working tree.
  if (process.cwd().startsWith('/var/task')) {
    const tempRoot = path.join(os.tmpdir(), "site-agent-pro");
    ensureDir(tempRoot);
    return tempRoot;
  }

  return process.cwd();
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function safeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function resolveRunsDir(): string {
  const dir = path.join(resolveDataRoot(), "runs");
  ensureDir(dir);
  return dir;
}

export function resolveRunDir(baseUrl: string): string {
  const host = new URL(baseUrl).hostname.replace(/^www\./, "");
  const dir = path.join(resolveRunsDir(), `${timestampSlug()}-${safeSlug(host)}`);
  ensureDir(dir);
  return dir;
}

export function resolveSubmissionsDir(): string {
  const dir = path.join(resolveDataRoot(), "submissions");
  ensureDir(dir);
  return dir;
}
