import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readUtf8, resolveRunsDir } from "../utils/files.js";
import { isSafeRunFileName } from "./runArtifacts.js";

export interface RunRepository {
  listRunIds(): Promise<string[]>;
  hasRun(runId: string): Promise<boolean>;
  readTextArtifact(runId: string, fileName: string): Promise<string | null>;
  readBinaryArtifact(runId: string, fileName: string): Promise<Buffer | null>;
  readJsonArtifact<T>(runId: string, fileName: string, schema: z.ZodType<T>): Promise<T | null>;
}

type RunRepositoryAdapter = {
  listRunIds: () => Promise<string[]>;
  hasRun?: (runId: string) => Promise<boolean>;
  readTextArtifact: (runId: string, fileName: string) => Promise<string | null>;
  readBinaryArtifact: (runId: string, fileName: string) => Promise<Buffer | null>;
  readJsonArtifact: <T>(runId: string, fileName: string, schema: z.ZodType<T>) => Promise<T | null>;
};

function normalizeRunId(runId: string): string | null {
  const trimmed = runId.trim();
  return isSafeRunFileName(trimmed) ? trimmed : null;
}

function resolveLocalRunDir(runId: string): string | null {
  const normalizedRunId = normalizeRunId(runId);
  if (!normalizedRunId) {
    return null;
  }

  const baseDir = resolveRunsDir();
  const runDir = path.resolve(baseDir, normalizedRunId);
  if (!runDir.startsWith(`${baseDir}${path.sep}`)) {
    return null;
  }

  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    return null;
  }

  return runDir;
}

function resolveLocalArtifactPath(runId: string, fileName: string): string | null {
  const runDir = resolveLocalRunDir(runId);
  const normalizedFileName = isSafeRunFileName(fileName) ? fileName.trim() : null;
  if (!runDir || !normalizedFileName) {
    return null;
  }

  const artifactPath = path.resolve(runDir, normalizedFileName);
  if (!artifactPath.startsWith(`${runDir}${path.sep}`)) {
    return null;
  }

  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    return null;
  }

  return artifactPath;
}

export function createRunRepository(adapter: RunRepositoryAdapter): RunRepository {
  return {
    listRunIds: adapter.listRunIds,
    hasRun:
      adapter.hasRun ??
      (async (runId: string) => {
        const runIds = await adapter.listRunIds();
        return runIds.includes(runId);
      }),
    readTextArtifact: adapter.readTextArtifact,
    readBinaryArtifact: adapter.readBinaryArtifact,
    readJsonArtifact: adapter.readJsonArtifact
  };
}

export function createLocalRunRepository(): RunRepository {
  return createRunRepository({
    listRunIds: async () => {
      const runsDir = resolveRunsDir();
      if (!fs.existsSync(runsDir)) {
        return [];
      }

      return fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));
    },
    hasRun: async (runId: string) => resolveLocalRunDir(runId) !== null,
    readTextArtifact: async (runId: string, fileName: string) => {
      const artifactPath = resolveLocalArtifactPath(runId, fileName);
      return artifactPath ? readUtf8(artifactPath) : null;
    },
    readBinaryArtifact: async (runId: string, fileName: string) => {
      const artifactPath = resolveLocalArtifactPath(runId, fileName);
      return artifactPath ? fs.readFileSync(artifactPath) : null;
    },
    readJsonArtifact: async <T>(runId: string, fileName: string, schema: z.ZodType<T>) => {
      const artifactPath = resolveLocalArtifactPath(runId, fileName);
      if (!artifactPath) {
        return null;
      }

      return schema.parse(JSON.parse(readUtf8(artifactPath)));
    }
  });
}
