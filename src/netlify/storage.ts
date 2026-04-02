import fs from "node:fs";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { z } from "zod";
import { SubmissionSchema, type Submission } from "../submissions/types.js";
import { readUtf8, resolveRunsDir, resolveSubmissionsDir, writeJson } from "../utils/files.js";

export const RUN_ARTIFACT_NAMES = [
  "inputs.json",
  "raw-events.json",
  "task-results.json",
  "accessibility.json",
  "report.json",
  "report.html",
  "report.md"
] as const;

export type RunArtifactName = (typeof RUN_ARTIFACT_NAMES)[number];

const RUNS_INDEX_KEY = "runs/index.json";
const STORE_NAME = "site-agent-pro";
const JSON_RUN_ARTIFACTS = new Set<RunArtifactName>([
  "inputs.json",
  "raw-events.json",
  "task-results.json",
  "accessibility.json",
  "report.json"
]);

function shouldUseBlobStorage(): boolean {
  return process.env.NETLIFY === "true" || process.env.NETLIFY_LOCAL === "true";
}

function getBlobStore() {
  return getStore(STORE_NAME);
}

function runArtifactKey(runId: string, fileName: RunArtifactName): string {
  return `runs/${runId}/${fileName}`;
}

function submissionKey(id: string): string {
  return `submissions/${id}.json`;
}

function localSubmissionPath(id: string): string {
  return path.join(resolveSubmissionsDir(), `${id}.json`);
}

function localRunArtifactPath(runId: string, fileName: RunArtifactName): string {
  return path.join(resolveRunsDir(), runId, fileName);
}

async function readRunIndexFromBlobs(): Promise<string[]> {
  const store = getBlobStore();
  const raw = await store.get(RUNS_INDEX_KEY, { type: "json" });
  return z.array(z.string()).catch([]).parse(raw);
}

async function writeRunIndexToBlobs(runIds: string[]): Promise<void> {
  const store = getBlobStore();
  const normalized = Array.from(new Set(runIds)).sort((left, right) => right.localeCompare(left));
  await store.setJSON(RUNS_INDEX_KEY, normalized);
}

export async function recordRunId(runId: string): Promise<void> {
  if (shouldUseBlobStorage()) {
    const existing = await readRunIndexFromBlobs();
    await writeRunIndexToBlobs([runId, ...existing]);
    return;
  }

  const runDir = path.join(resolveRunsDir(), runId);
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }
}

export async function listRunIds(): Promise<string[]> {
  if (shouldUseBlobStorage()) {
    return readRunIndexFromBlobs();
  }

  const runsDir = resolveRunsDir();
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

export async function writeSubmission(submission: Submission): Promise<void> {
  const normalized = SubmissionSchema.parse(submission);

  if (shouldUseBlobStorage()) {
    const store = getBlobStore();
    await store.setJSON(submissionKey(normalized.id), normalized);
    return;
  }

  writeJson(localSubmissionPath(normalized.id), normalized);
}

export async function readSubmission(id: string): Promise<Submission | null> {
  if (shouldUseBlobStorage()) {
    const store = getBlobStore();
    const raw = await store.get(submissionKey(id), { type: "json" });
    return raw === null ? null : SubmissionSchema.parse(raw);
  }

  const filePath = localSubmissionPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return SubmissionSchema.parse(JSON.parse(readUtf8(filePath)));
}

export async function listSubmissions(): Promise<Submission[]> {
  if (shouldUseBlobStorage()) {
    const store = getBlobStore();
    const { blobs } = await store.list({ prefix: "submissions/" });
    const submissions = await Promise.all(
      blobs
        .map((entry) => entry.key)
        .filter((key) => key.endsWith(".json"))
        .map(async (key) => {
          const raw = await store.get(key, { type: "json" });
          return raw === null ? null : SubmissionSchema.parse(raw);
        })
    );

    return submissions
      .filter((submission): submission is Submission => submission !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  const submissionsDir = resolveSubmissionsDir();
  if (!fs.existsSync(submissionsDir)) {
    return [];
  }

  return fs
    .readdirSync(submissionsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => SubmissionSchema.parse(JSON.parse(readUtf8(path.join(submissionsDir, entry.name)))))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function findSubmissionByReportToken(reportToken: string): Promise<Submission | null> {
  return (await listSubmissions()).find((submission) => submission.reportToken === reportToken) ?? null;
}

export async function uploadRunArtifacts(runId: string, runDir: string): Promise<void> {
  if (shouldUseBlobStorage()) {
    const store = getBlobStore();

    for (const fileName of RUN_ARTIFACT_NAMES) {
      const artifactPath = path.join(runDir, fileName);
      if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        continue;
      }

      if (JSON_RUN_ARTIFACTS.has(fileName)) {
        await store.setJSON(runArtifactKey(runId, fileName), JSON.parse(readUtf8(artifactPath)));
        continue;
      }

      await store.set(runArtifactKey(runId, fileName), readUtf8(artifactPath));
    }

    await recordRunId(runId);
    return;
  }

  await recordRunId(runId);
}

export async function readRunArtifactText(runId: string, fileName: RunArtifactName): Promise<string | null> {
  if (shouldUseBlobStorage()) {
    const store = getBlobStore();
    return await store.get(runArtifactKey(runId, fileName), { type: "text" });
  }

  const artifactPath = localRunArtifactPath(runId, fileName);
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    return null;
  }

  return readUtf8(artifactPath);
}

export async function readRunArtifactJson<T>(runId: string, fileName: RunArtifactName, schema: z.ZodType<T>): Promise<T | null> {
  if (shouldUseBlobStorage()) {
    const store = getBlobStore();
    const raw = await store.get(runArtifactKey(runId, fileName), { type: "json" });
    return raw === null ? null : schema.parse(raw);
  }

  const artifactPath = localRunArtifactPath(runId, fileName);
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    return null;
  }

  return schema.parse(JSON.parse(readUtf8(artifactPath)));
}
