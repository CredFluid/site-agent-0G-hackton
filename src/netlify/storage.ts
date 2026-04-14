import fs from "node:fs";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { z } from "zod";
import { createRunRepository } from "../backend/runRepository.js";
import { isImageArtifact, isSafeRunFileName } from "../backend/runArtifacts.js";
import { SubmissionSchema, type Submission } from "../submissions/types.js";
import { readUtf8, resolveRunsDir, resolveSubmissionsDir, writeJson } from "../utils/files.js";

export const RUN_ARTIFACT_NAMES = [
  "inputs.json",
  "raw-events.json",
  "task-results.json",
  "accessibility.json",
  "site-checks.json",
  "report.json",
  "report.html",
  "report.md",
  "click-replay.webp"
] as const;

const RUNS_INDEX_KEY = "runs/index.json";
const STORE_NAME = "site-agent-pro";

const JSON_RUN_ARTIFACTS = new Set([
  "inputs.json",
  "raw-events.json",
  "task-results.json",
  "accessibility.json",
  "site-checks.json",
  "report.json"
]);

const TEXT_RUN_ARTIFACTS = new Set(["report.html", "report.md"]);
const BINARY_RUN_ARTIFACTS = new Set(["click-replay.webp"]);

type ClaimSubmissionResult =
  | { ok: true; reason: "claimed"; submission: Submission }
  | {
      ok: false;
      reason:
        | "not_found"
        | "already_completed"
        | "already_running"
        | "claim_verify_failed"
        | "claim_lost";
      submission: Submission | null;
    };

function shouldUseBlobStorage(): boolean {
  const useBlobs =
    process.env.NETLIFY_LOCAL === "true" ||
    Boolean(process.env.SITE_ID) ||
    Boolean(process.env.URL);

  console.log("storage mode", {
    useBlobs,
    NETLIFY: process.env.NETLIFY,
    NETLIFY_LOCAL: process.env.NETLIFY_LOCAL,
    SITE_ID: process.env.SITE_ID,
    URL: process.env.URL
  });

  return useBlobs;
}

function getBlobStore() {
  return getStore({
    name: STORE_NAME,
    consistency: "strong"
  });
}

function runArtifactKey(runId: string, fileName: string): string {
  return `runs/${runId}/${fileName}`;
}

function submissionKey(id: string): string {
  return `submissions/${id}.json`;
}

function localSubmissionPath(id: string): string {
  return path.join(resolveSubmissionsDir(), `${id}.json`);
}

function localRunArtifactPath(runId: string, fileName: string): string {
  return path.join(resolveRunsDir(), runId, fileName);
}

function isSafeRunId(runId: string): boolean {
  return isSafeRunFileName(runId);
}

function isJsonArtifact(fileName: string): boolean {
  return JSON_RUN_ARTIFACTS.has(fileName);
}

function isTextArtifact(fileName: string): boolean {
  return TEXT_RUN_ARTIFACTS.has(fileName);
}

function isBinaryArtifact(fileName: string): boolean {
  return BINARY_RUN_ARTIFACTS.has(fileName) || isImageArtifact(fileName);
}

function listLocalRunArtifactNames(runDir: string): string[] {
  if (!fs.existsSync(runDir)) {
    return [];
  }

  return fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSafeRunFileName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
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

export async function claimSubmissionForProcessing(id: string): Promise<ClaimSubmissionResult> {
  const submission = await readSubmission(id);

  if (!submission) {
    return { ok: false, reason: "not_found", submission: null };
  }

  if (submission.status === "completed") {
    return { ok: false, reason: "already_completed", submission };
  }

  if (submission.status === "running") {
    return { ok: false, reason: "already_running", submission };
  }

  const startedAt = new Date().toISOString();

  const claimedSubmission = SubmissionSchema.parse({
    ...submission,
    status: "running",
    startedAt,
    completedAt: null,
    error: null
  });

  await writeSubmission(claimedSubmission);

  const verified = await readSubmission(id);
  if (!verified) {
    return { ok: false, reason: "claim_verify_failed", submission: null };
  }

  if (verified.status !== "running") {
    return { ok: false, reason: "claim_verify_failed", submission: verified };
  }

  if (verified.startedAt !== startedAt) {
    return { ok: false, reason: "claim_lost", submission: verified };
  }

  return { ok: true, reason: "claimed", submission: verified };
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
    .map((entry) =>
      SubmissionSchema.parse(JSON.parse(readUtf8(path.join(submissionsDir, entry.name))))
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function findSubmissionByReportToken(reportToken: string): Promise<Submission | null> {
  return (await listSubmissions()).find((submission) => submission.reportToken === reportToken) ?? null;
}

export async function uploadRunArtifacts(runId: string, runDir: string): Promise<void> {
  if (shouldUseBlobStorage()) {
    const store = getBlobStore();

    for (const fileName of listLocalRunArtifactNames(runDir)) {
      const artifactPath = path.join(runDir, fileName);
      if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        continue;
      }

      if (isJsonArtifact(fileName)) {
        await store.setJSON(runArtifactKey(runId, fileName), JSON.parse(readUtf8(artifactPath)));
        continue;
      }

      if (isBinaryArtifact(fileName)) {
        const bytes = fs.readFileSync(artifactPath);
        await store.set(
          runArtifactKey(runId, fileName),
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        );
        continue;
      }

      if (isTextArtifact(fileName)) {
        await store.set(runArtifactKey(runId, fileName), readUtf8(artifactPath));
        continue;
      }

      const bytes = fs.readFileSync(artifactPath);
      await store.set(
        runArtifactKey(runId, fileName),
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      );
    }

    await recordRunId(runId);
    return;
  }

  await recordRunId(runId);
}

export async function readRunArtifactText(runId: string, fileName: string): Promise<string | null> {
  if (!isSafeRunId(runId) || !isSafeRunFileName(fileName)) {
    return null;
  }

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

export async function readRunArtifactBinary(runId: string, fileName: string): Promise<Buffer | null> {
  if (!isSafeRunId(runId) || !isSafeRunFileName(fileName)) {
    return null;
  }

  if (shouldUseBlobStorage()) {
    const store = getBlobStore();
    const raw = await store.get(runArtifactKey(runId, fileName), { type: "arrayBuffer" });
    return raw === null ? null : Buffer.from(raw);
  }

  const artifactPath = localRunArtifactPath(runId, fileName);
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    return null;
  }

  return fs.readFileSync(artifactPath);
}

export async function readRunArtifactJson<T>(
  runId: string,
  fileName: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  if (!isSafeRunId(runId) || !isSafeRunFileName(fileName)) {
    return null;
  }

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

export function createNetlifyRunRepository() {
  return createRunRepository({
    listRunIds,
    hasRun: async (runId: string) => {
      const runIds = await listRunIds();
      return runIds.includes(runId);
    },
    readTextArtifact: readRunArtifactText,
    readBinaryArtifact: readRunArtifactBinary,
    readJsonArtifact: readRunArtifactJson
  });
}