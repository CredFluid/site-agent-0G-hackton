export const LEGACY_CUSTOM_TASK_INPUT_COUNT = 5;
export const MAX_ACCEPTED_TASK_COUNT = 12;
export const MAX_CUSTOM_TASK_LENGTH = 420;
export const MAX_INSTRUCTION_SOURCE_LENGTH = 16000;
export const SUBMISSION_TASKS_REQUIRED_MESSAGE =
  "Paste instructions into the task box or upload a text or JSON instruction file before starting a run.";

type SupportedForm = URLSearchParams | FormData;

type ParsedInstructionSource = {
  customTasks: string[];
  instructionText: string;
  instructionFileName: string | null;
  uploadedInstructionText: string;
};

function normalizeTaskText(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_CUSTOM_TASK_LENGTH) {
    return collapsed;
  }

  return `${collapsed.slice(0, MAX_CUSTOM_TASK_LENGTH - 3).trimEnd()}...`;
}

function normalizeInstructionSourceText(value: string): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= MAX_INSTRUCTION_SOURCE_LENGTH) {
    return normalized;
  }

  return normalized.slice(0, MAX_INSTRUCTION_SOURCE_LENGTH).trimEnd();
}

function stripBulletPrefix(value: string): string {
  return value.replace(/^\s*(?:[-*•]+|\d+[.)]|task\s+\d+[:.)])\s*/i, "").trim();
}

function normalizeTaskCandidate(value: string): string {
  return normalizeTaskText(stripBulletPrefix(value.replace(/^[;,\s]+|[;,\s]+$/g, "")));
}

function looksLikeNairaCryptoExchangeSpec(value: string): boolean {
  return (
    /\bbuy\s+flow\b/i.test(value) &&
    /\bsell\s+flow\b/i.test(value) &&
    /\bnaira\b/i.test(value) &&
    /\bcrypto\b/i.test(value) &&
    /\blogging|monitoring|events?\b/i.test(value)
  );
}

function buildNairaCryptoExchangeTasks(): string[] {
  return [
    [
      "Click Buy;",
      "enter a harmless Naira amount; confirm the crypto preview updates; select a token; select a network; provide a harmless test wallet address; click Next; verify a Naira payment account card is shown; copy the account number if a copy control is available; stop before making any real payment."
    ].join(" "),
    [
      "Click Sell;",
      "enter a harmless crypto amount; confirm the Naira payout preview updates; click Next; provide a harmless test bank account number when requested; verify the business crypto wallet address is shown; copy the crypto address if a copy control is available; stop before sending any real crypto."
    ].join(" "),
    [
      "Check exchange-flow monitoring evidence:",
      "while testing Buy and Sell, look for visible console logs, analytics/debug messages, or emitted events for amount entry, wallet address submission, bank account submission, account or wallet details displayed, clipboard actions, transfer trigger attempts, crypto payout initiation, and Naira payout initiation. Report which monitoring events were observed or missing."
    ].join(" ")
  ];
}

function isFileLike(value: FormDataEntryValue | null): value is File {
  return Boolean(value) && typeof value !== "string" && typeof (value as File).text === "function";
}

function getStringValue(form: SupportedForm, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function extractTaskStringsFromJsonValue(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTaskStringsFromJsonValue(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;

  for (const key of ["goal", "task", "instruction", "prompt", "step"]) {
    if (typeof record[key] === "string") {
      return [record[key] as string];
    }
  }

  for (const key of ["tasks", "instructions", "steps", "items"]) {
    if (record[key] !== undefined) {
      return extractTaskStringsFromJsonValue(record[key]);
    }
  }

  return [];
}

function parseJsonInstructionSource(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return [];
  }

  try {
    return extractTaskStringsFromJsonValue(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

function splitInstructionText(raw: string): string[] {
  const normalized = normalizeInstructionSourceText(raw);
  if (!normalized) {
    return [];
  }

  if (looksLikeNairaCryptoExchangeSpec(normalized)) {
    return buildNairaCryptoExchangeTasks();
  }

  const jsonTasks = parseJsonInstructionSource(normalized);
  if (jsonTasks.length > 0) {
    return jsonTasks;
  }

  const numberedInlineSegments = normalized
    .split(/(?=(?:^|\s)(?:\d+[.)]|[-*•])\s+)/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (numberedInlineSegments.length > 1) {
    return numberedInlineSegments;
  }

  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 1) {
    return lines.flatMap((line) => {
      const stripped = stripBulletPrefix(line);
      if (!stripped) {
        return [];
      }

      const semicolonParts = stripped
        .split(/\s*;\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 8);

      return semicolonParts.length > 1 ? semicolonParts : [stripped];
    });
  }

  const semicolonParts = normalized
    .split(/\s*;\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
  if (semicolonParts.length > 1) {
    return semicolonParts;
  }

  return [normalized];
}

export function normalizeCustomTasks(values: Iterable<string | null | undefined>): string[] {
  const tasks: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizeTaskCandidate(value ?? "");
    if (!normalized) {
      continue;
    }

    const dedupeKey = normalized.toLocaleLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    tasks.push(normalized);

    if (tasks.length >= MAX_ACCEPTED_TASK_COUNT) {
      break;
    }
  }

  return tasks;
}

export function readLegacyTaskInputs(form: SupportedForm): string[] {
  return Array.from({ length: LEGACY_CUSTOM_TASK_INPUT_COUNT }, (_, index) => getStringValue(form, `task-${index + 1}`));
}

export async function readSubmittedInstructionSource(form: SupportedForm): Promise<ParsedInstructionSource> {
  const manualInstructionText = normalizeInstructionSourceText(getStringValue(form, "instructions"));
  const legacyInstructionText = normalizeInstructionSourceText(readLegacyTaskInputs(form).filter(Boolean).join("\n"));

  const uploadedFile = form.get("instructions_file");
  const uploadedInstructionText = isFileLike(uploadedFile)
    ? normalizeInstructionSourceText(await uploadedFile.text())
    : "";
  const instructionFileName = isFileLike(uploadedFile) && uploadedFile.name ? uploadedFile.name : null;

  const combinedInstructionText = normalizeInstructionSourceText(
    [manualInstructionText, uploadedInstructionText, legacyInstructionText].filter(Boolean).join("\n\n")
  );

  const tasksFromText = normalizeCustomTasks([
    ...extractTasksFromInstructionSource(manualInstructionText),
    ...extractTasksFromInstructionSource(uploadedInstructionText),
    ...extractTasksFromInstructionSource(legacyInstructionText)
  ]);

  return {
    customTasks: tasksFromText,
    instructionText: combinedInstructionText,
    instructionFileName,
    uploadedInstructionText
  };
}

export function parseInstructionText(raw: string): string[] {
  return splitInstructionText(raw);
}

function extractTasksFromInstructionSource(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }

  const jsonTasks = parseJsonInstructionSource(raw);
  return jsonTasks.length > 0 ? jsonTasks : parseInstructionText(raw);
}
