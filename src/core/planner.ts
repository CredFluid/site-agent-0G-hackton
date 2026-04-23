import { z } from "zod";
import { getPreferredAccessIdentity } from "../auth/profile.js";
import { generateStructured, type LlmRuntimeOptions } from "../llm/client.js";
import { isWalletConfigured, getWalletAddress } from "../wallet/wallet.js";
import { BROWSER_AGENT_PROMPT } from "../prompts/browserAgent.js";
import {
  scoreFormFieldTargetMatch,
  inferFormFieldValue as inferProfileFormFieldValue,
  isPlaceholderFieldValue as isPlaceholderProfileFieldValue,
  shouldCheckField
} from "./formHeuristics.js";
import { buildTaskDirectiveSummary, parseTaskDirectives, type TaskDirective } from "./taskDirectives.js";
import {
  classifyTaskText,
  extractTaskKeywords,
  isRegressiveTaskControlLabel,
  normalizeTaskText,
  scoreInteractiveForTask,
  textHasInstructionCue,
  textHasOutcomeCue
} from "./taskHeuristics.js";
import {
  PlannerDecisionSchema,
  type PageState,
  type PlannerDecision,
  type SiteBrief,
  type TaskHistoryEntry,
  type TaskSuite
} from "../schemas/types.js";

const PLANNER_TIMEOUT_MS = 30000;
const PLANNER_MAX_RETRIES = 3;
const ORDERED_STEP_PATTERNS = [/^step\s+\d+\b/i, /^\d+[\.\)]\s+/, /^(first|second|third|fourth|fifth|next|then|finally)\b/i];
const ACTIONABLE_INSTRUCTION_PATTERNS = [
  /^(?:step\s+\d+[:.)-]?\s*)?(?:click|tap|press|select|choose|open)\b/i,
  /^(?:step\s+\d+[:.)-]?\s*)?(?:enter|type|fill|input|provide)\b/i,
  /^(?:step\s+\d+[:.)-]?\s*)?(?:scroll|swipe)\b/i,
  /^(?:step\s+\d+[:.)-]?\s*)?(?:wait|pause|hold)\b/i,
  /^(?:step\s+\d+[:.)-]?\s*)?(?:go back|back)\b/i,
  /^(?:first|second|third|fourth|fifth|next|then|finally)\b.*\b(?:click|tap|press|select|choose|open|enter|type|fill|scroll|wait|back)\b/i
];
const ACCESS_GATE_PATTERNS = [
  /\baccess\b/i,
  /\bcontinue\b/i,
  /\bnext\b/i,
  /\bunlock\b/i,
  /\bview\b/i,
  /\bproceed\b/i,
  /\benter\b/i
];
const ACCOUNT_CREATION_TASK_PATTERN = /\b(?:sign ?up|signup|register|create(?:\s+your)?\s+(?:account|profile)|create\s+my\s+account|join)\b/i;
const ACCOUNT_CREATION_SUCCESS_PATTERN =
  /\b(?:registered users?|add another registration|account created|account ready|welcome|dashboard|profile active|view live market screen)\b/i;
const ACCOUNT_CREATION_STRONG_SUCCESS_PATTERN =
  /\b(?:registered users?|add another registration|account created|account ready|profile active|view live market screen)\b/i;
const ACCOUNT_CREATION_LOCAL_ONLY_PATTERN =
  /\b(?:browser fallback|browser storage only|using browser storage only|local server is unavailable|api is unavailable)\b/i;
const ACCOUNT_CREATION_VERIFICATION_PENDING_PATTERN =
  /\b(?:please\s+verify|verify\s+your\s+email|check\s+your\s+email|send\s+otp|enter\s+(?:the\s+)?(?:code|otp)|verification\s+code|resend\s*\(\d+\s*s\))\b/i;

const PlannerInputSchema = z.object({
  persona: z.object({
    name: z.string(),
    intent: z.string(),
    constraints: z.array(z.string())
  }),
  task: z.object({
    name: z.string(),
    goal: z.string(),
    original_instruction: z.string().default(""),
    ordered_steps: z
      .array(
        z.object({
          action: z.string(),
          target: z.string(),
          raw: z.string()
        })
      )
      .default([]),
    ordered_step_notes: z.array(z.string()).default([]),
    ordered_step_confidence: z.enum(["high", "low", "none"]).default("high"),
    success_condition: z.string(),
    failure_signals: z.array(z.string()),
    gameplay: z
      .object({
        rounds: z.number().optional(),
        requireHowToPlay: z.boolean().optional()
      })
      .optional()
  }),
  siteBrief: z.object({
    sitePurpose: z.string(),
    intendedUserActions: z.array(z.string()),
    summary: z.string(),
    evidence: z.array(z.string())
  }),
  accessProfile: z.object({
    email: z.string(),
    password: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string(),
    phone: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string(),
    company: z.string(),
    walletAddress: z.string().default("")
  }),
  pageState: z.object({
    title: z.string(),
    url: z.string(),
    visibleText: z.string(),
    visibleLines: z.array(z.string()),
    formFields: z.array(
      z.object({
        agentId: z.string(),
        label: z.string(),
        placeholder: z.string(),
        name: z.string(),
        id: z.string(),
        tag: z.string(),
        inputType: z.string(),
        autocomplete: z.string().default(""),
        inputMode: z.string().default(""),
        value: z.string(),
        required: z.boolean(),
        checked: z.boolean().optional(),
        maxLength: z.number().int().positive().nullable().optional(),
        options: z.array(z.string())
      })
    ),
    interactive: z.array(
      z.object({
        agentId: z.string(),
        role: z.string(),
        tag: z.string(),
        type: z.string().optional(),
        text: z.string(),
        href: z.string().optional(),
        disabled: z.boolean()
      })
    ),
    numberedElements: z.array(z.string()).default([]),
    headings: z.array(z.string()),
    formsPresent: z.boolean(),
    modalHints: z.array(z.string())
  }),
  remainingSeconds: z.number().int().positive().optional(),
  previous_actions: z.array(
    z.object({
      step: z.number(),
      action: z.string(),
      target_id: z.string().default(""),
      target: z.string().default(""),
      success: z.boolean(),
      state_changed: z.boolean().default(false),
      note: z.string()
    })
  ).default([]),
  history: z.array(
    z.object({
      step: z.number(),
      url: z.string(),
      title: z.string(),
      decision: z.object({
        stepNumber: z.number().nullable().optional(),
        instructionQuote: z.string().optional(),
        action: z.string(),
        target_id: z.string().default(""),
        target: z.string(),
        expectation: z.string(),
        friction: z.string()
      }),
      result: z.object({
        success: z.boolean(),
        note: z.string(),
        stateChanged: z.boolean().optional()
      })
    })
  )
});

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown planner error";
}

function normalizeLineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return normalizeLineText(value).toLowerCase();
}

function normalizeInteractiveIntentLabel(value: string): string {
  return normalizeLineText(value)
    .replace(/[^a-z0-9\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countSharedKeywords(left: string, right: string): number {
  const leftKeywords = extractTaskKeywords(left);
  const rightKeywords = new Set(extractTaskKeywords(right));
  return leftKeywords.filter((keyword) => rightKeywords.has(keyword)).length;
}

function getInteractiveLabel(item: PageState["interactive"][number]): string {
  return normalizeLineText(item.text || "");
}

function normalizeTargetId(value: string): string {
  return normalizeLineText(value);
}

function findInteractiveByTargetId(pageState: PageState, targetId: string): PageState["interactive"][number] | null {
  const normalizedTargetId = normalizeTargetId(targetId);
  if (!normalizedTargetId) {
    return null;
  }

  return pageState.interactive.find((item) => item.agentId === normalizedTargetId) ?? null;
}

function findFormFieldByTargetId(pageState: PageState, targetId: string): PageState["formFields"][number] | null {
  const normalizedTargetId = normalizeTargetId(targetId);
  if (!normalizedTargetId) {
    return null;
  }

  return pageState.formFields.find((field) => field.agentId === normalizedTargetId) ?? null;
}

function enrichDecisionTarget(args: {
  pageState: PageState;
  decision: PlannerDecision;
}): PlannerDecision {
  const targetId = normalizeTargetId(args.decision.target_id || "");
  const explicitTarget = normalizeLineText(args.decision.target || "");

  if (!targetId) {
    return {
      ...args.decision,
      target_id: "",
      target: explicitTarget
    };
  }

  const interactiveTarget = findInteractiveByTargetId(args.pageState, targetId);
  if (interactiveTarget) {
    return {
      ...args.decision,
      target_id: targetId,
      target: explicitTarget || resolveInteractiveTarget(interactiveTarget)
    };
  }

  const fieldTarget = findFormFieldByTargetId(args.pageState, targetId);
  if (fieldTarget) {
    return {
      ...args.decision,
      target_id: targetId,
      target: explicitTarget || resolveFormFieldTarget(fieldTarget)
    };
  }

  return {
    ...args.decision,
    target_id: targetId,
    target: explicitTarget
  };
}

function buildInvalidTargetIdStopDecision(args: {
  pageState: PageState;
  decision: PlannerDecision;
}): PlannerDecision {
  const targetId = normalizeTargetId(args.decision.target_id || "");
  return buildStopDecision({
    thought: targetId
      ? `The planner selected target_id '${targetId}', but that ID is not present in the current numbered page state.`
      : `The planner returned '${args.decision.action}' without a valid target_id from the current numbered page state.`,
    expectation:
      args.decision.action === "click" || args.decision.action === "type"
        ? "Stop instead of guessing another element or label that was not explicitly numbered on the page."
        : "Stop because the requested action could not be grounded in the numbered page state."
  });
}

function enforceTargetIdDecision(args: {
  pageState: PageState;
  decision: PlannerDecision;
}): PlannerDecision {
  const decision = enrichDecisionTarget(args);

  if (decision.action === "click") {
    return decision.target_id && findInteractiveByTargetId(args.pageState, decision.target_id)
      ? decision
      : buildInvalidTargetIdStopDecision({ pageState: args.pageState, decision });
  }

  if (decision.action === "type") {
    const fieldTarget = decision.target_id ? findFormFieldByTargetId(args.pageState, decision.target_id) : null;
    if (!fieldTarget) {
      return buildInvalidTargetIdStopDecision({ pageState: args.pageState, decision });
    }

    const inferredValue = inferFormFieldValue(fieldTarget, args.pageState.url);
    if (inferredValue && inferredValue !== decision.text && !shouldCheckField(inferredValue)) {
      return {
        ...decision,
        text: inferredValue,
        thought: decision.thought + ` (Overriding LLM text '${decision.text}' with strictly generated profile value).`
      };
    }

    return decision;
  }

  if (decision.target_id || decision.target) {
    return {
      ...decision,
      target_id: "",
      target: decision.target
    };
  }

  return decision;
}

function enforceLoopAvoidance(args: {
  history: TaskHistoryEntry[];
  decision: PlannerDecision;
}): PlannerDecision {
  if (!["click", "type"].includes(args.decision.action)) {
    return args.decision;
  }

  const targetId = normalizeTargetId(args.decision.target_id || "");
  if (!targetId) {
    return args.decision;
  }

  const repeatedAction = [...args.history]
    .reverse()
    .find(
      (entry) =>
        entry.decision.action === args.decision.action &&
        normalizeTargetId(entry.decision.target_id || "") === targetId
    );

  if (!repeatedAction) {
    return args.decision;
  }

  if (repeatedAction.result.stateChanged === false) {
    return buildStopDecision({
      thought: `BLOCKED: target_id '${targetId}' was already tried for '${args.decision.action}' and the page state did not change.`,
      expectation: "Stop instead of retrying the same numbered element or clicking a random alternative to escape the loop."
    });
  }

  return args.decision;
}

function directiveTargetsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeKey(left);
  const normalizedRight = normalizeKey(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }

  const leftKeywords = extractTaskKeywords(left);
  const rightKeywords = extractTaskKeywords(right);
  if (leftKeywords.length === 0 || rightKeywords.length === 0) {
    return false;
  }

  const shared = countSharedKeywords(left, right);
  return shared >= Math.min(leftKeywords.length, rightKeywords.length) || shared >= 2;
}

function scoreInteractiveForDirectiveTarget(item: PageState["interactive"][number], target: string): number {
  const label = getInteractiveLabel(item);
  if (!label || item.disabled) {
    return Number.NEGATIVE_INFINITY;
  }

  const normalizedLabel = normalizeKey(label);
  const normalizedTarget = normalizeKey(target);
  let score = 0;

  if (normalizedLabel === normalizedTarget) {
    score = Math.max(score, 220);
  }
  if (normalizedLabel.includes(normalizedTarget) || normalizedTarget.includes(normalizedLabel)) {
    score = Math.max(score, 180);
  }

  const targetKeywords = extractTaskKeywords(target);
  const keywordMatches = countSharedKeywords(target, label);
  if (targetKeywords.length > 0) {
    score = Math.max(score, keywordMatches * 40 + (keywordMatches === targetKeywords.length ? 40 : 0));
  }

  const role = item.role.toLowerCase();
  const tag = item.tag.toLowerCase();
  if (role === "button" || role === "tab" || role === "link" || tag === "button" || tag === "a") {
    score += 10;
  }

  return score;
}

function findBestDirectiveInteractiveMatch(pageState: PageState, target: string): PageState["interactive"][number] | null {
  const ranked = pageState.interactive
    .map((item) => ({
      item,
      score: scoreInteractiveForDirectiveTarget(item, target)
    }))
    .filter((candidate) => Number.isFinite(candidate.score) && candidate.score >= 80)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.item ?? null;
}

function isSubmitLikeInteractiveLabel(label: string): boolean {
  return /^(?:submit|continue|next|finish|complete|done|send|verify|create(?:\s+\w+){0,2}\s+account|sign ?up|register|join(?: now)?|start free|save(?: and continue)?)$/i.test(
    normalizeInteractiveIntentLabel(label)
  );
}

function taskLooksLikeAccountCreation(goal: string): boolean {
  return ACCOUNT_CREATION_TASK_PATTERN.test(goal);
}

function pageShowsAccountCreationSuccess(pageState: PageState): boolean {
  const blob = normalizeTaskText([pageState.title, pageState.visibleText, ...pageState.headings].join(" "));
  if (ACCOUNT_CREATION_VERIFICATION_PENDING_PATTERN.test(blob)) {
    return false;
  }

  if (ACCOUNT_CREATION_STRONG_SUCCESS_PATTERN.test(blob)) {
    return true;
  }

  if (pageState.formsPresent) {
    return false;
  }

  return ACCOUNT_CREATION_SUCCESS_PATTERN.test(blob);
}

function pageShowsAccountCreationVerificationPending(pageState: PageState): boolean {
  const blob = normalizeTaskText([pageState.title, pageState.visibleText, ...pageState.headings].join(" "));
  return ACCOUNT_CREATION_VERIFICATION_PENDING_PATTERN.test(blob);
}

function pageShowsAccountCreationLocalOnlyFallback(pageState: PageState): boolean {
  const blob = normalizeTaskText([pageState.title, pageState.visibleText, ...pageState.headings].join(" "));
  return ACCOUNT_CREATION_LOCAL_ONLY_PATTERN.test(blob);
}

function findBestSubmitControl(pageState: PageState): PageState["interactive"][number] | null {
  const ranked = pageState.interactive
    .map((item) => {
      const label = resolveInteractiveTarget(item);
      let score = Number.NEGATIVE_INFINITY;
      if (!item.disabled && label) {
        if (isSubmitLikeInteractiveLabel(label)) {
          score = 180;
        } else if (/\bsubmit\b|\bcontinue\b|\bnext\b|\bfinish\b|\bcomplete\b|\bregister\b|\bsign ?up\b|\bcreate\b.*\baccount\b/i.test(label)) {
          score = 120;
        }

        const role = item.role.toLowerCase();
        const tag = item.tag.toLowerCase();
        if (Number.isFinite(score) && (role === "button" || role === "link" || role === "tab" || tag === "button" || tag === "a")) {
          score += 10;
        }
      }

      return { item, score };
    })
    .filter((candidate) => Number.isFinite(candidate.score) && candidate.score >= 100)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.item ?? null;
}

function historyHasSuccessfulClickTarget(history: TaskHistoryEntry[], target: string): boolean {
  return history.some(
    (entry) =>
      entry.decision.action === "click" &&
      entry.result.success &&
      directiveTargetsMatch(entry.decision.target || entry.decision.instructionQuote || "", target)
  );
}

function taskHasPendingExplicitDirective(taskGoal: string, history: TaskHistoryEntry[]): boolean {
  return parseTaskDirectives(taskGoal).some((directive) => {
    if (directive.action === "fill_visible_form") {
      return false;
    }

    if (directive.action === "click") {
      return !historyHasSuccessfulClickTarget(history, directive.target);
    }

    return true;
  });
}

function buildStopDecision(args: {
  thought: string;
  expectation: string;
  stepNumber?: number | null;
  instructionQuote?: string;
  friction?: PlannerDecision["friction"];
}): PlannerDecision {
  return {
    thought: args.thought,
    stepNumber: args.stepNumber ?? null,
    instructionQuote: args.instructionQuote ?? "",
    action: "stop",
    target_id: "",
    target: "",
    text: "",
    expectation: args.expectation,
    friction: args.friction ?? "high"
  };
}

function hasSingleProfileConstraint(constraints: string[]): boolean {
  const constraintBlob = normalizeTaskText(constraints.join(" "));
  if (!/\b(?:profile|account|identity)\b/i.test(constraintBlob)) {
    return false;
  }

  return /\b(?:single|same|one|at most|no more than|only create|create only|reuse|keep using|do not create|don't create|never create)\b/i.test(
    constraintBlob
  );
}

function pageShowsActiveProfile(pageState: PageState): boolean {
  const pageBlob = normalizeTaskText([pageState.title, pageState.visibleText, ...pageState.headings].join(" "));
  return /profile active|this visitor profile is saved|update profile|occupations:/i.test(pageBlob);
}

function isProfileLifecycleControlLabel(label: string): boolean {
  return /(?:create|register|sign ?up|new|add)\s+(?:profile|account)|(?:profile|account).*(?:create|register|sign ?up)|^(?:update|edit|change|reset|clear)\s+(?:profile|details?|settings?)$/i.test(
    label
  );
}

function violatesRunWideGuardrail(args: {
  suite: TaskSuite;
  pageState: PageState;
  target: string;
}): boolean {
  const target = normalizeTaskText(args.target);
  if (!target) {
    return false;
  }

  if (hasSingleProfileConstraint(args.suite.persona.constraints) && pageShowsActiveProfile(args.pageState)) {
    return isRegressiveTaskControlLabel(target) || isProfileLifecycleControlLabel(target);
  }

  return false;
}

function isActionableInstruction(line: string): boolean {
  return ACTIONABLE_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(line));
}

function isInteractiveLine(pageState: PageState, line: string): boolean {
  const normalizedLine = normalizeKey(line);
  return pageState.interactive.some((item) => {
    const label = normalizeKey(getInteractiveLabel(item));
    return Boolean(label) && label === normalizedLine;
  });
}

function isFormFieldLine(pageState: PageState, line: string): boolean {
  const normalizedLine = normalizeKey(line);
  return pageState.formFields.some((field) =>
    [field.label, field.placeholder, field.name, field.id].some((value) => {
      const normalizedValue = normalizeKey(value);
      return Boolean(normalizedValue) && normalizedValue === normalizedLine;
    })
  );
}

function extractOrderedInstructionLines(pageState: PageState): Array<{ stepNumber: number; instructionQuote: string }> {
  return pageState.visibleLines
    .map((line, index) => ({
      stepNumber: index + 1,
      instructionQuote: normalizeLineText(line)
    }))
    .filter(
      (entry) =>
        entry.instructionQuote.length > 0 &&
        (isActionableInstruction(entry.instructionQuote) ||
          ORDERED_STEP_PATTERNS.some((pattern) => pattern.test(entry.instructionQuote)) ||
          isInteractiveLine(pageState, entry.instructionQuote) ||
          isFormFieldLine(pageState, entry.instructionQuote))
    );
}

function cleanInstructionTarget(value: string): string {
  return normalizeLineText(
    value
      .replace(/^the\s+/i, "")
      .replace(/\s+(?:button|link|tab|menu|menu item|option|field|input|textbox|text box|checkbox|radio button)\b.*$/i, "")
      .replace(/[.:!?]+$/g, "")
  );
}

function extractClickTarget(instructionQuote: string): string | null {
  const match = instructionQuote.match(
    /^(?:step\s+\d+[:.)-]?\s*)?(?:click|tap|press|select|choose|open)\s+(?:the\s+)?["'“]?([^"'”]+?)["'”]?(?:\s+(?:button|link|tab|menu|menu item|option|card))?(?:[.!?].*)?$/i
  );
  const target = cleanInstructionTarget(match?.[1] ?? "");
  return target || null;
}

function extractTypeTarget(instructionQuote: string): string | null {
  const normalized = normalizeLineText(instructionQuote);
  const explicitMatch = normalized.match(
    /^(?:step\s+\d+[:.)-]?\s*)?(?:enter|type|fill|input|provide)\s+(?:your\s+|the\s+)?(.+?)(?:\s+(?:field|box|input|value|details?))?(?:[.!?].*)?$/i
  );
  if (explicitMatch?.[1]) {
    return cleanInstructionTarget(explicitMatch[1]);
  }

  return ORDERED_STEP_PATTERNS.some((pattern) => pattern.test(normalized))
    ? cleanInstructionTarget(normalized.replace(/^step\s+\d+[:.)-]?\s*/i, "")) || null
    : null;
}

function findInteractiveControl(pageState: PageState, instructionQuote: string): PageState["interactive"][number] | null {
  const normalizedLine = normalizeKey(instructionQuote);
  return pageState.interactive.find((item) => normalizeKey(getInteractiveLabel(item)) === normalizedLine) ?? null;
}

function findInteractiveTarget(pageState: PageState, instructionQuote: string): string | null {
  const exact = findInteractiveControl(pageState, instructionQuote);
  return exact ? getInteractiveLabel(exact) : null;
}

function findMatchingFormField(pageState: PageState, instructionQuote: string): PageState["formFields"][number] | null {
  const normalizedLine = normalizeKey(instructionQuote);
  const target = extractTypeTarget(instructionQuote) ?? instructionQuote;
  const candidates = pageState.formFields
    .map((field) => {
      const score = Math.max(
        scoreFormFieldTargetMatch(field, target),
        scoreFormFieldTargetMatch(field, instructionQuote),
        normalizedLine === normalizeKey(resolveFormFieldTarget(field)) ? 120 : 0
      );

      return { field, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.field ?? null;
}

function inferFormFieldValue(field: PageState["formFields"][number], url?: string): string | null {
  return inferProfileFormFieldValue(field, getPreferredAccessIdentity(url));
}

function resolveFormFieldTarget(field: PageState["formFields"][number]): string {
  return normalizeLineText(field.label || field.placeholder || field.name || field.id || field.inputType);
}

function resolveInteractiveTarget(item: PageState["interactive"][number]): string {
  return getInteractiveLabel(item);
}

function findFormFieldStepReference(args: {
  pageState: PageState;
  field: PageState["formFields"][number];
}): { stepNumber: number | null; instructionQuote: string } {
  const candidates = [args.field.label, args.field.placeholder, args.field.name, args.field.id].map((value) => normalizeLineText(value)).filter(Boolean);

  for (let index = 0; index < args.pageState.visibleLines.length; index += 1) {
    const line = normalizeLineText(args.pageState.visibleLines[index] || "");
    if (!line) {
      continue;
    }

    if (candidates.some((candidate) => normalizeKey(candidate) === normalizeKey(line))) {
      return {
        stepNumber: index + 1,
        instructionQuote: line
      };
    }
  }

  return {
    stepNumber: null,
    instructionQuote: resolveFormFieldTarget(args.field)
  };
}

function isPlaceholderFieldValue(field: PageState["formFields"][number], value: string): boolean {
  return isPlaceholderProfileFieldValue(field, value);
}

function findFirstPendingFormField(pageState: PageState): PageState["formFields"][number] | null {
  for (const field of pageState.formFields) {
    if (
      field.inputType === "radio" &&
      field.name &&
      pageState.formFields.some(
        (candidate) => candidate !== field && candidate.inputType === "radio" && candidate.name === field.name && candidate.checked
      )
    ) {
      continue;
    }

    const inferredValue = inferFormFieldValue(field, pageState.url);
    if (!inferredValue) {
      continue;
    }

    if (!isPlaceholderFieldValue(field, field.value || "")) {
      continue;
    }

    return field;
  }

  return null;
}

function findInteractiveStepReference(args: {
  pageState: PageState;
  item: PageState["interactive"][number];
}): { stepNumber: number | null; instructionQuote: string } {
  const target = resolveInteractiveTarget(args.item);
  for (let index = 0; index < args.pageState.visibleLines.length; index += 1) {
    const line = normalizeLineText(args.pageState.visibleLines[index] || "");
    if (!line) {
      continue;
    }

    if (normalizeKey(line) === normalizeKey(target)) {
      return {
        stepNumber: index + 1,
        instructionQuote: line
      };
    }
  }

  return {
    stepNumber: null,
    instructionQuote: target
  };
}

function buildTaskInteractiveDecision(args: {
  pageState: PageState;
  item: PageState["interactive"][number];
  thought: string;
  expectation: string;
  friction?: PlannerDecision["friction"];
}): PlannerDecision {
  const target = resolveInteractiveTarget(args.item);
  const stepReference = findInteractiveStepReference({
    pageState: args.pageState,
    item: args.item
  });

  return {
    thought: args.thought,
    stepNumber: stepReference.stepNumber,
    instructionQuote: stepReference.instructionQuote,
    action: "click",
    target_id: args.item.agentId,
    target,
    text: "",
    expectation: args.expectation,
    friction: args.friction ?? "medium"
  };
}

function findBestTaskInteractiveCandidate(args: {
  suite: TaskSuite;
  taskIndex: number;
  pageState: PageState;
  history: TaskHistoryEntry[];
  disallowTarget?: (target: string) => boolean;
}): { item: PageState["interactive"][number]; score: number } | null {
  const task = args.suite.tasks[args.taskIndex] ?? args.suite.tasks[0];
  if (!task) {
    return null;
  }

  const ranked = args.pageState.interactive
    .map((item) => ({
      item,
      score: scoreInteractiveForTask({
        task,
        item,
        history: args.history
      })
    }))
    .filter(
      (candidate) =>
        Number.isFinite(candidate.score) &&
        !(args.disallowTarget?.(resolveInteractiveTarget(candidate.item)) ?? false)
    )
    .sort((left, right) => right.score - left.score);

  return ranked[0] ?? null;
}

function decisionTargetsPendingField(args: {
  pageState: PageState;
  decision: PlannerDecision;
  pendingField: PageState["formFields"][number];
}): boolean {
  if (args.decision.action !== "type") {
    return false;
  }

  if (normalizeTargetId(args.decision.target_id || "") === args.pendingField.agentId) {
    return true;
  }

  const targetText = normalizeLineText(args.decision.target || args.decision.instructionQuote || "");
  if (!targetText) {
    return false;
  }

  const matchedField = findMatchingFormField(args.pageState, targetText);
  if (matchedField === args.pendingField) {
    return true;
  }

  return normalizeKey(targetText) === normalizeKey(resolveFormFieldTarget(args.pendingField));
}

function buildFormFirstDecision(args: {
  pageState: PageState;
  pendingField: PageState["formFields"][number];
  originalDecision: PlannerDecision;
}): PlannerDecision {
  const text = inferFormFieldValue(args.pendingField, args.pageState.url);
  const target = resolveFormFieldTarget(args.pendingField);
  const stepReference = findFormFieldStepReference({
    pageState: args.pageState,
    field: args.pendingField
  });

  if (!text) {
    return args.originalDecision;
  }

  return {
    thought: `A visible form is still incomplete, so '${args.originalDecision.target || args.originalDecision.instructionQuote}' must wait until the next unresolved field is filled first.`,
    stepNumber: stepReference.stepNumber,
    instructionQuote: stepReference.instructionQuote,
    action: "type",
    target_id: args.pendingField.agentId,
    target,
    text,
    expectation: `Fill '${target}' before attempting any later field or submit action on this form.`,
    friction: "medium"
  };
}

function isOtpTriggerClickDecision(decision: PlannerDecision): boolean {
  if (decision.action !== "click") {
    return false;
  }

  const targetLabel = normalizeKey(decision.target || decision.instructionQuote || "");
  return /\b(?:send\s*(?:otp|code)|get\s*(?:otp|code)|verify\s*email|request\s*(?:otp|code))\b/.test(targetLabel);
}

function enforceFormFirstDecision(args: {
  taskGoal: string;
  history: TaskHistoryEntry[];
  pageState: PageState;
  decision: PlannerDecision;
}): PlannerDecision {
  if (taskHasPendingExplicitDirective(args.taskGoal, args.history)) {
    return args.decision;
  }

  // Allow OTP trigger clicks to pass through even when there are pending form
  // fields — the verification step must not be deferred until all fields are
  // filled because many sites gate remaining fields behind OTP completion.
  if (isOtpTriggerClickDecision(args.decision)) {
    return args.decision;
  }

  if (!args.pageState.formsPresent || args.pageState.formFields.length === 0) {
    return args.decision;
  }

  const pendingField = findFirstPendingFormField(args.pageState);
  if (!pendingField) {
    return args.decision;
  }

  if (
    decisionTargetsPendingField({
      pageState: args.pageState,
      decision: args.decision,
      pendingField
    })
  ) {
    return args.decision;
  }

  return buildFormFirstDecision({
    pageState: args.pageState,
    pendingField,
    originalDecision: args.decision
  });
}

function enforceOrderedTaskDirectives(args: {
  task: TaskSuite["tasks"][number];
  pageState: PageState;
  history: TaskHistoryEntry[];
  decision: PlannerDecision;
}): PlannerDecision {
  const directives = parseTaskDirectives(args.task.goal);
  if (directives.length === 0) {
    return args.decision;
  }

  for (const directive of directives) {
    if (directive.action === "click") {
      if (historyHasSuccessfulClickTarget(args.history, directive.target)) {
        continue;
      }

      const matchingControl = findBestDirectiveInteractiveMatch(args.pageState, directive.target);
      if (!matchingControl) {
        return buildStopDecision({
          thought: `The next literal user instruction is to click '${directive.target}', but no visible control clearly matches that target on the current page.`,
          expectation: `Stop instead of exploring unrelated controls before '${directive.target}' is visible or unambiguous.`
        });
      }

      if (args.decision.action === "click" && directiveTargetsMatch(args.decision.target || args.decision.instructionQuote || "", directive.target)) {
        return args.decision;
      }

      return buildTaskInteractiveDecision({
        pageState: args.pageState,
        item: matchingControl,
        thought: `The user gave an explicit ordered step to click '${directive.target}', so that named control must be used before any later action in the instruction.`,
        expectation: `Click '${resolveInteractiveTarget(matchingControl)}' and wait for the page to update before filling fields or using any other tab.`,
        friction: "medium"
      });
    }

    if (directive.action === "type_field") {
      const field = findMatchingFormField(args.pageState, directive.target);
      if (!field) {
        continue;
      }

      if (!isPlaceholderFieldValue(field, field.value || "")) {
        continue;
      }

      const value = inferFormFieldValue(field, args.pageState.url);
      if (!value) {
        return buildStopDecision({
          thought: `The next literal user instruction is to fill '${directive.target}', but there is no safe inferred value for that visible field.`,
          expectation: `Stop instead of guessing data for '${directive.target}'.`
        });
      }

      if (
        args.decision.action === "type" &&
        (normalizeTargetId(args.decision.target_id || "") === field.agentId ||
          normalizeKey(args.decision.target || args.decision.instructionQuote || "") === normalizeKey(resolveFormFieldTarget(field)))
      ) {
        return args.decision;
      }

      const stepReference = findFormFieldStepReference({
        pageState: args.pageState,
        field
      });

      return {
        thought: `The user explicitly named '${directive.target}' as the next field to fill, so that field must be completed before any later form action.`,
        stepNumber: stepReference.stepNumber,
        instructionQuote: stepReference.instructionQuote,
        action: "type",
        target_id: field.agentId,
        target: resolveFormFieldTarget(field),
        text: value,
        expectation: `Fill '${resolveFormFieldTarget(field)}' and wait for the form state to update before moving on.`,
        friction: "medium"
      };
    }

    if (directive.action === "fill_visible_form") {
      if (!args.pageState.formsPresent) {
        continue;
      }

      // Allow OTP trigger clicks to pass through even during a fill_visible_form
      // directive — the OTP step is part of completing the form, not a deviation.
      if (isOtpTriggerClickDecision(args.decision)) {
        return args.decision;
      }

      const pendingField = findFirstPendingFormField(args.pageState);
      if (!pendingField) {
        continue;
      }

      return buildFormFirstDecision({
        pageState: args.pageState,
        pendingField,
        originalDecision: args.decision
      });
    }

    if (directive.action === "submit") {
      if (!args.pageState.formsPresent) {
        continue;
      }

      // Allow OTP trigger clicks through even during a submit directive —
      // the OTP must be completed before the form can be submitted.
      if (isOtpTriggerClickDecision(args.decision)) {
        return args.decision;
      }

      const pendingField = findFirstPendingFormField(args.pageState);
      if (pendingField) {
        return buildFormFirstDecision({
          pageState: args.pageState,
          pendingField,
          originalDecision: args.decision
        });
      }

      const submitControl = findBestSubmitControl(args.pageState);
      if (!submitControl) {
        return buildStopDecision({
          thought: "The next literal user instruction is to submit the visible form, but there is no clear visible submit-style control on the page.",
          expectation: "Stop instead of exploring unrelated controls before the submit action is unambiguous."
        });
      }

      if (args.decision.action === "click" && isSubmitLikeInteractiveLabel(args.decision.target || args.decision.instructionQuote || "")) {
        if (!args.decision.target_id || args.decision.target_id === submitControl.agentId) {
          return args.decision;
        }
      }

      return buildTaskInteractiveDecision({
        pageState: args.pageState,
        item: submitControl,
        thought: "The user explicitly instructed the agent to submit after filling the visible form, so the submit-style control must be used next.",
        expectation: `Click '${resolveInteractiveTarget(submitControl)}' and verify whether the form submits or the next confirmation state appears.`,
        friction: "medium"
      });
    }

    if (directive.action === "scroll" && args.decision.action !== "scroll") {
      return {
        thought: "The user explicitly instructed the next step to scroll, so do not substitute another control first.",
        stepNumber: null,
        instructionQuote: directive.raw,
        action: "scroll",
        target_id: "",
        target: "",
        text: "",
        expectation: "Scroll once, then reassess the next visible step from the same task.",
        friction: "low"
      };
    }

    if (directive.action === "wait" && args.decision.action !== "wait") {
      return {
        thought: "The user explicitly instructed the next step to wait, so do not replace that with another action.",
        stepNumber: null,
        instructionQuote: directive.raw,
        action: "wait",
        target_id: "",
        target: "",
        text: "",
        expectation: "Wait briefly and observe whether the requested next state appears.",
        friction: "low"
      };
    }

    if (directive.action === "back" && args.decision.action !== "back") {
      return {
        thought: "The user explicitly instructed the next step to go back, so do not click a different control first.",
        stepNumber: null,
        instructionQuote: directive.raw,
        action: "back",
        target_id: "",
        target: "",
        text: "",
        expectation: "Go back once and reassess the visible page state.",
        friction: "medium"
      };
    }
  }

  return args.decision;
}

function findNextInstruction(args: {
  pageState: PageState;
  history: TaskHistoryEntry[];
}): { stepNumber: number; instructionQuote: string } | null {
  const seenInstructions = new Set(
    args.history
      .filter(
        (entry) =>
          normalizeLineText(entry.url) === normalizeLineText(args.pageState.url) &&
          normalizeLineText(entry.title) === normalizeLineText(args.pageState.title)
      )
      .map((entry) => normalizeLineText(entry.decision.instructionQuote || ""))
      .filter(Boolean)
  );

  return extractOrderedInstructionLines(args.pageState).find((entry) => !seenInstructions.has(normalizeLineText(entry.instructionQuote))) ?? null;
}

function pageHasStrictStepContent(pageState: PageState): boolean {
  return extractOrderedInstructionLines(pageState).length > 0;
}

function buildFallbackDecision(args: {
  suite: TaskSuite;
  taskIndex: number;
  pageState: PageState;
  history: TaskHistoryEntry[];
}): PlannerDecision {
  const task = args.suite.tasks[args.taskIndex] ?? args.suite.tasks[0];
  if (!task) {
    return buildStopDecision({
      thought: "No accepted task was available for planning, so there is no safe next step to execute.",
      expectation: "Stop rather than guessing a task that was not provided."
    });
  }

  const taskProfile = classifyTaskText(task.goal);
  const latestSuccessfulSubmit = [...args.history]
    .reverse()
    .find((entry) => entry.decision.action === "click" && entry.result.success && isSubmitLikeInteractiveLabel(entry.decision.target || ""));
  if (taskLooksLikeAccountCreation(task.goal) && latestSuccessfulSubmit && pageShowsAccountCreationSuccess(args.pageState)) {
    const localOnlyFallback = pageShowsAccountCreationLocalOnlyFallback(args.pageState);
    return buildStopDecision({
      thought: localOnlyFallback
        ? "Model planning was unavailable, but a submit-style action already succeeded and the page now shows a browser-only fallback post-registration state, so continuing to click around would only add misleading noise."
        : "Model planning was unavailable, but the signup flow already appears complete because a submit-style action succeeded and the visible page now shows a post-registration state.",
      expectation: localOnlyFallback
        ? "Stop and report that the form submitted, but the page explicitly indicates browser-only fallback storage rather than a shared persisted account state."
        : "Stop and report the successful post-registration state instead of clicking unrelated navigation controls."
    });
  }

  if (
    taskLooksLikeAccountCreation(task.goal) &&
    latestSuccessfulSubmit &&
    pageShowsAccountCreationVerificationPending(args.pageState) &&
    !taskHasPendingExplicitDirective(task.goal, args.history)
  ) {
    return buildStopDecision({
      thought:
        "Model planning was unavailable, but the signup flow is still explicitly requesting email or OTP verification after the last submit-style action, so the account is not complete yet.",
      expectation: "Stop and report the pending verification state instead of navigating away or claiming signup success.",
      friction: "medium"
    });
  }

  const pendingField = findFirstPendingFormField(args.pageState);

  // Detect inline OTP-trigger buttons (e.g. "Send OTP", "Send Code", "Verify Email") that need
  // to be clicked mid-form-fill, BEFORE continuing to fill remaining fields or submitting.
  const emailFieldFilled = args.pageState.formFields.some((field) => {
    const key = normalizeKey([field.label, field.placeholder, field.name, field.id, field.autocomplete].join(" "));
    return /\bemail\b/.test(key) && field.value && field.value.trim().length > 0;
  });

  if (emailFieldFilled) {
    const otpTriggerControl = args.pageState.interactive.find((item) => {
      if (item.disabled) {
        return false;
      }

      const label = normalizeKey(getInteractiveLabel(item));
      return /\b(?:send\s*(?:otp|code)|get\s*(?:otp|code)|verify\s*email|request\s*(?:otp|code))\b/.test(label);
    });

    if (otpTriggerControl) {
      const alreadyClicked = args.history.some(
        (entry) =>
          entry.decision.action === "click" &&
          entry.result.success &&
          normalizeKey(entry.decision.target || "").includes(normalizeKey(getInteractiveLabel(otpTriggerControl)))
      );

      if (!alreadyClicked) {
        const target = resolveInteractiveTarget(otpTriggerControl);
        const stepReference = findInteractiveStepReference({
          pageState: args.pageState,
          item: otpTriggerControl
        });

        return {
          thought: "Model planning was unavailable, but the email field is filled and the page has a visible OTP/verification trigger button that must be clicked before proceeding with the rest of the form.",
          stepNumber: stepReference.stepNumber,
          instructionQuote: stepReference.instructionQuote,
          action: "click",
          target_id: otpTriggerControl.agentId,
          target,
          text: "",
          expectation: `Click '${target}' to trigger email verification or OTP delivery, then wait for the page to respond before filling remaining fields.`,
          friction: "medium"
        };
      }
    }
  }

  if (pendingField) {
    const target = resolveFormFieldTarget(pendingField);
    const text = inferFormFieldValue(pendingField, args.pageState.url);
    const stepReference = findFormFieldStepReference({
      pageState: args.pageState,
      field: pendingField
    });

    if (text) {
      return {
        thought: "Model planning was unavailable, so follow strict form order and fill the first unresolved visible field before any later action.",
        stepNumber: stepReference.stepNumber,
        instructionQuote: stepReference.instructionQuote,
        action: "type",
        target_id: pendingField.agentId,
        target,
        text,
        expectation: `Fill '${target}' with a safe dummy value and wait for the field state to update before moving on.`,
        friction: "medium"
      };
    }
  }

  const pageEvidenceText = normalizeTaskText([args.pageState.title, args.pageState.visibleText, ...args.pageState.headings].join(" "));
  const nextInstruction = findNextInstruction({
    pageState: args.pageState,
    history: args.history
  });

  if (nextInstruction) {
    const matchingField = findMatchingFormField(args.pageState, nextInstruction.instructionQuote);
    if (matchingField) {
      const formValue = inferFormFieldValue(matchingField, args.pageState.url);
      if (formValue) {
        const target = resolveFormFieldTarget(matchingField);
        return {
          thought: "Model planning was unavailable, but the next unread visible step matches a form field and can be advanced safely with dummy details.",
          stepNumber: nextInstruction.stepNumber,
          instructionQuote: nextInstruction.instructionQuote,
          action: "type",
          target_id: matchingField.agentId,
          target,
          text: formValue,
          expectation: `Fill '${target}' for this single step, then wait for the form state to update before moving on.`,
          friction: "medium"
        };
      }
    }

    const directInteractiveControl = findInteractiveControl(args.pageState, nextInstruction.instructionQuote);
    if (directInteractiveControl) {
      const directInteractiveTarget = resolveInteractiveTarget(directInteractiveControl);
      if (
        violatesRunWideGuardrail({
          suite: args.suite,
          pageState: args.pageState,
          target: directInteractiveTarget
        })
      ) {
        return buildStopDecision({
          thought: `Model planning was unavailable, and '${directInteractiveTarget}' would violate a run-wide user constraint from the submission.`,
          expectation: `Stop instead of using '${directInteractiveTarget}' because it would break the accepted guardrail.`,
          stepNumber: nextInstruction.stepNumber,
          instructionQuote: nextInstruction.instructionQuote
        });
      }

      // Block regressive navigation ("Back to Home", "Home", etc.) when the page
      // still has a visible form — this prevents abandoning the signup mid-flow
      // after an OTP timeout or validation error.
      if (args.pageState.formsPresent && isRegressiveTaskControlLabel(directInteractiveTarget)) {
        return buildStopDecision({
          thought: `Model planning was unavailable, and '${directInteractiveTarget}' is a regressive navigation control while a form is still present on the page. Clicking it would abandon the current form flow.`,
          expectation: `Stop instead of navigating away from the form via '${directInteractiveTarget}'.`,
          stepNumber: nextInstruction.stepNumber,
          instructionQuote: nextInstruction.instructionQuote
        });
      }

      return {
        thought: "Model planning was unavailable, but the next unread visible step directly matches a visible control, so follow it exactly.",
        stepNumber: nextInstruction.stepNumber,
        instructionQuote: nextInstruction.instructionQuote,
        action: "click",
        target_id: directInteractiveControl.agentId,
        target: directInteractiveTarget,
        text: "",
        expectation: `Click only '${directInteractiveTarget}' and wait for the page to update before considering any later instruction.`,
        friction: ACCESS_GATE_PATTERNS.some((pattern) => pattern.test(nextInstruction.instructionQuote)) ? "low" : "medium"
      };
    }

    const clickTarget = extractClickTarget(nextInstruction.instructionQuote);
    if (clickTarget) {
      if (
        violatesRunWideGuardrail({
          suite: args.suite,
          pageState: args.pageState,
          target: clickTarget
        })
      ) {
        return buildStopDecision({
          thought: `Model planning was unavailable, and '${clickTarget}' would violate a run-wide user constraint from the submission.`,
          expectation: `Stop instead of clicking '${clickTarget}' because it would break the accepted guardrail.`,
          stepNumber: nextInstruction.stepNumber,
          instructionQuote: nextInstruction.instructionQuote
        });
      }

      const matchingControl = findBestDirectiveInteractiveMatch(args.pageState, clickTarget);
      if (!matchingControl) {
        return buildStopDecision({
          thought: `Model planning was unavailable, and the named click target '${clickTarget}' does not map to any numbered visible control on the page.`,
          expectation: `Stop instead of guessing which numbered element might correspond to '${clickTarget}'.`,
          stepNumber: nextInstruction.stepNumber,
          instructionQuote: nextInstruction.instructionQuote
        });
      }

      return {
        thought: "Model planning was unavailable, but the next unread visible instruction explicitly names a control, so follow that single step without skipping ahead.",
        stepNumber: nextInstruction.stepNumber,
        instructionQuote: nextInstruction.instructionQuote,
        action: "click",
        target_id: matchingControl.agentId,
        target: resolveInteractiveTarget(matchingControl),
        text: "",
        expectation: `Click only '${resolveInteractiveTarget(matchingControl)}' and wait for the page to update before considering any later instruction.`,
        friction: "medium"
      };
    }

    const typeTarget = extractTypeTarget(nextInstruction.instructionQuote);
    if (typeTarget) {
      const field = findMatchingFormField(args.pageState, typeTarget);
      const formValue = field ? inferFormFieldValue(field, args.pageState.url) : null;

      if (field && formValue) {
        const target = resolveFormFieldTarget(field);
        return {
          thought: "Model planning was unavailable, but the next unread visible instruction explicitly asks for form input and a matching field is present.",
          stepNumber: nextInstruction.stepNumber,
          instructionQuote: nextInstruction.instructionQuote,
          action: "type",
          target_id: field.agentId,
          target,
          text: formValue,
          expectation: `Fill '${target}' for this one step and wait for the form to reflect the new value before moving on.`,
          friction: "medium"
        };
      }
    }

    if (/^(?:step\s+\d+[:.)-]?\s*)?(?:scroll|swipe)\b/i.test(nextInstruction.instructionQuote)) {
      return {
        thought: "Model planning was unavailable, but the next unread visible instruction is an explicit scroll step.",
        stepNumber: nextInstruction.stepNumber,
        instructionQuote: nextInstruction.instructionQuote,
        action: "scroll",
        target_id: "",
        target: "",
        text: "",
        expectation: "Scroll once, then wait for the page to settle before evaluating the next visible instruction.",
        friction: "low"
      };
    }

    if (/^(?:step\s+\d+[:.)-]?\s*)?(?:wait|pause|hold)\b/i.test(nextInstruction.instructionQuote)) {
      return {
        thought: "Model planning was unavailable, but the next unread visible instruction explicitly says to wait.",
        stepNumber: nextInstruction.stepNumber,
        instructionQuote: nextInstruction.instructionQuote,
        action: "wait",
        target_id: "",
        target: "",
        text: "",
        expectation: "Wait briefly, observe the result, and do not execute any later step yet.",
        friction: "low"
      };
    }

    if (/^(?:step\s+\d+[:.)-]?\s*)?(?:go back|back)\b/i.test(nextInstruction.instructionQuote)) {
      return {
        thought: "Model planning was unavailable, but the next unread visible instruction explicitly says to go back.",
        stepNumber: nextInstruction.stepNumber,
        instructionQuote: nextInstruction.instructionQuote,
        action: "back",
        target_id: "",
        target: "",
        text: "",
        expectation: "Go back once and wait for the page update before reading further instructions.",
        friction: "medium"
      };
    }

    return buildStopDecision({
      thought: "Model planning was unavailable and the next visible instruction cannot be executed safely without guessing, so strict mode requires stopping here.",
      expectation: "Stop and report that the current step is ambiguous instead of inferring a missing action.",
      stepNumber: nextInstruction.stepNumber,
      instructionQuote: nextInstruction.instructionQuote
    });
  }

  if (pageHasStrictStepContent(args.pageState)) {
    return buildStopDecision({
      thought: "Model planning was unavailable and there are no clearly unread actionable steps left on the page that can be followed exactly.",
      expectation: "Stop rather than inventing a new step, substituting another control, or reordering the page instructions."
    });
  }

  if (taskProfile.engagement || taskProfile.gameplay || taskProfile.buttonCoverage || taskProfile.broadNavigation) {
    return buildStopDecision({
      thought: "Model planning was unavailable, and strict execution mode forbids guessing a next click from generic live controls.",
      expectation: "Stop and report that no exact instruction-aligned control could be selected safely."
    });
  }

  if (textHasInstructionCue(pageEvidenceText) || textHasOutcomeCue(pageEvidenceText)) {
    return {
      thought: "Model planning was unavailable, so preserve the visible page state as evidence rather than guessing the next step.",
      stepNumber: null,
      instructionQuote: "",
      action: "extract",
      target_id: "",
      target: "",
      text: "",
      expectation: "Record the current visible state exactly as shown and wait for a clearer next instruction.",
      friction: "low"
    };
  }

  return buildStopDecision({
    thought: "Model planning was unavailable and the page does not expose clear sequential instructions to follow safely.",
    expectation: "Stop and report that the next step is ambiguous instead of guessing."
  });
}

export type PlannerResolution = {
  decision: PlannerDecision;
  fallbackReason?: string;
};

function enforceOtpTriggerPrioritization(args: {
  pageState: PageState;
  history: TaskHistoryEntry[];
  decision: PlannerDecision;
}): PlannerDecision {

  // Check if the email field is filled
  const emailFieldFilled = args.pageState.formFields.some((field) => {
    const key = normalizeKey([field.label, field.placeholder, field.name, field.id, field.autocomplete ?? ""].join(" "));
    return /\bemail\b/.test(key) && field.value && field.value.trim().length > 0;
  });
  if (!emailFieldFilled) {
    return args.decision;
  }

  // Check if there's a visible OTP trigger button
  const otpTriggerControl = args.pageState.interactive.find((item) => {
    if (item.disabled) {
      return false;
    }

    const label = normalizeKey(getInteractiveLabel(item));
    return /\b(?:send\s*(?:otp|code)|get\s*(?:otp|code)|verify\s*email|request\s*(?:otp|code))\b/.test(label);
  });
  if (!otpTriggerControl) {
    return args.decision;
  }

  // Check if the OTP trigger was already clicked
  const alreadyClicked = args.history.some(
    (entry) =>
      entry.decision.action === "click" &&
      entry.result.success &&
      normalizeKey(entry.decision.target || "").includes(normalizeKey(getInteractiveLabel(otpTriggerControl)))
  );
  if (alreadyClicked) {
    return args.decision;
  }

  // Redirect to click the OTP trigger before submitting
  const target = resolveInteractiveTarget(otpTriggerControl);
  const stepReference = findInteractiveStepReference({
    pageState: args.pageState,
    item: otpTriggerControl
  });

  return {
    thought: `The form has an unclicked OTP/verification trigger '${target}' that must be completed before proceeding with the rest of the form. Redirecting from '${args.decision.target || args.decision.action}' to '${target}'.`,
    stepNumber: stepReference.stepNumber,
    instructionQuote: stepReference.instructionQuote,
    action: "click",
    target_id: otpTriggerControl.agentId,
    target,
    text: "",
    expectation: `Click '${target}' to trigger email verification before submitting the form.`,
    friction: "medium"
  };
}

function finalizePlannerDecision(args: {
  task: TaskSuite["tasks"][number];
  pageState: PageState;
  history: TaskHistoryEntry[];
  decision: PlannerDecision;
}): PlannerDecision {
  return enforceLoopAvoidance({
    history: args.history,
    decision: enforceTargetIdDecision({
      pageState: args.pageState,
      decision: enforceFormFirstDecision({
        taskGoal: args.task.goal,
        history: args.history,
        pageState: args.pageState,
        decision: enforceOtpTriggerPrioritization({
          pageState: args.pageState,
          history: args.history,
          decision: enforceOrderedTaskDirectives({
            task: args.task,
            pageState: args.pageState,
            history: args.history,
            decision: enrichDecisionTarget({
              pageState: args.pageState,
              decision: args.decision
            })
          })
        })
      })
    })
  });
}

export async function decideNextAction(args: {
  suite: TaskSuite;
  taskIndex: number;
  siteBrief: SiteBrief;
  pageState: PageState;
  history: TaskHistoryEntry[];
  remainingSeconds?: number;
  llm?: LlmRuntimeOptions;
}): Promise<PlannerResolution> {
  const task = args.suite.tasks[args.taskIndex] ?? args.suite.tasks[0]!;
  const orderedSteps = parseTaskDirectives(task.goal);
  const orderedStepNotes = buildTaskDirectiveSummary(task.goal);
  const hasUnstructuredSteps = orderedSteps.some((directive) => directive.action === "unstructured");
  const orderedStepConfidence = orderedSteps.length === 0 ? "none" : hasUnstructuredSteps ? "low" : "high";
  const accessProfile = getPreferredAccessIdentity(args.pageState.url);
  const walletAddress = isWalletConfigured() ? await getWalletAddress().catch(() => "") : "";
  const payload = PlannerInputSchema.parse({
    persona: args.suite.persona,
    task: {
      ...task,
      original_instruction: task.goal,
      ordered_step_confidence: orderedStepConfidence,
      ordered_steps: orderedSteps.map((directive) => ({
        action: directive.action,
        target: directive.target,
        raw: directive.raw
      })),
      ordered_step_notes: orderedStepNotes
    },
    siteBrief: args.siteBrief,
    accessProfile: {
      ...accessProfile,
      walletAddress
    },
    pageState: args.pageState,
    ...(args.remainingSeconds !== undefined ? { remainingSeconds: args.remainingSeconds } : {}),
    previous_actions: args.history.slice(-20).map((item) => ({
      step: item.step,
      action: item.decision.action,
      target_id: item.decision.target_id,
      target: item.decision.target,
      success: item.result.success,
      state_changed: item.result.stateChanged ?? false,
      note: item.result.note
    })),
    history: args.history.slice(-20).map((item) => ({
      step: item.step,
      url: item.url,
      title: item.title,
      decision: {
        stepNumber: item.decision.stepNumber,
        instructionQuote: item.decision.instructionQuote,
        action: item.decision.action,
        target_id: item.decision.target_id,
        target: item.decision.target,
        expectation: item.decision.expectation,
        friction: item.decision.friction
      },
      result: {
        success: item.result.success,
        note: item.result.note,
        ...(item.result.stateChanged !== undefined ? { stateChanged: item.result.stateChanged } : {})
      }
    }))
  });

  try {
    const decision = await generateStructured<PlannerDecision>({
      ...(args.llm ?? {}),
      systemPrompt: BROWSER_AGENT_PROMPT,
      userPayload: payload,
      schemaName: "planner_decision",
      schema: PlannerDecisionSchema,
      timeoutMs: PLANNER_TIMEOUT_MS,
      maxRetries: PLANNER_MAX_RETRIES
    });

    return {
      decision: finalizePlannerDecision({
        task,
        pageState: args.pageState,
        history: args.history,
        decision: PlannerDecisionSchema.parse(decision)
      })
    };
  } catch (error) {
    return {
      decision: finalizePlannerDecision({
        task,
        pageState: args.pageState,
        history: args.history,
        decision: buildFallbackDecision({
          suite: args.suite,
          taskIndex: args.taskIndex,
          pageState: args.pageState,
          history: args.history
        })
      }),
      fallbackReason: cleanErrorMessage(error)
    };
  }
}
