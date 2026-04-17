import { z } from "zod";
import { getPreferredAccessIdentity } from "../auth/profile.js";
import { generateStructured } from "../llm/client.js";
import { BROWSER_AGENT_PROMPT } from "../prompts/browserAgent.js";
import {
  classifyTaskText,
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
const ORDERED_STEP_PATTERNS = [/^step\s+\d+\b/i, /^\d+[.)]\s+/, /^(first|second|third|fourth|fifth|next|then|finally)\b/i];
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

const PlannerInputSchema = z.object({
  persona: z.object({
    name: z.string(),
    intent: z.string(),
    constraints: z.array(z.string())
  }),
  task: z.object({
    name: z.string(),
    goal: z.string(),
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
    company: z.string()
  }),
  pageState: z.object({
    title: z.string(),
    url: z.string(),
    visibleText: z.string(),
    visibleLines: z.array(z.string()),
    formFields: z.array(
      z.object({
        label: z.string(),
        placeholder: z.string(),
        name: z.string(),
        id: z.string(),
        tag: z.string(),
        inputType: z.string(),
        value: z.string(),
        required: z.boolean(),
        options: z.array(z.string())
      })
    ),
    interactive: z.array(
      z.object({
        role: z.string(),
        tag: z.string(),
        type: z.string().optional(),
        text: z.string(),
        href: z.string().optional(),
        disabled: z.boolean()
      })
    ),
    headings: z.array(z.string()),
    formsPresent: z.boolean(),
    modalHints: z.array(z.string())
  }),
  remainingSeconds: z.number().int().positive().optional(),
  history: z.array(
    z.object({
      step: z.number(),
      url: z.string(),
      title: z.string(),
      decision: z.object({
        stepNumber: z.number().nullable().optional(),
        instructionQuote: z.string().optional(),
        action: z.string(),
        target: z.string(),
        expectation: z.string(),
        friction: z.string()
      }),
      result: z.object({
        success: z.boolean(),
        note: z.string()
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

function stripOrderedStepPrefix(value: string): string {
  return normalizeLineText(value)
    .replace(/^step\s+\d+\s*[:.)-]?\s*/i, "")
    .replace(/^\d+\s*[.):-]\s*/, "")
    .replace(/^(?:first|second|third|fourth|fifth|next|then|finally)\s*[:,.-]?\s*/i, "")
    .trim();
}

function buildInstructionLineCandidates(instructionQuote: string): string[] {
  const candidates = [
    normalizeLineText(instructionQuote),
    stripOrderedStepPrefix(instructionQuote)
  ].filter(Boolean);

  return [...new Set(candidates)];
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
    target: "",
    text: "",
    expectation: args.expectation,
    friction: args.friction ?? "high"
  };
}

function isActionableInstruction(line: string): boolean {
  return ACTIONABLE_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(line));
}

function isInteractiveLine(pageState: PageState, line: string): boolean {
  const normalizedLine = normalizeKey(line);
  return pageState.interactive.some((item) => {
    const label = normalizeKey(item.text || item.href || "");
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
  const match = stripOrderedStepPrefix(instructionQuote).match(
    /^(?:click|tap|press|select|choose|open)\s+(?:the\s+)?["'“]?([^"'”]+?)["'”]?(?:\s+(?:button|link|tab|menu|menu item|option|card))?(?:[.!?].*)?$/i
  );
  const target = cleanInstructionTarget(match?.[1] ?? "");
  return target || null;
}

function extractTypeTarget(instructionQuote: string): string | null {
  const normalized = normalizeLineText(instructionQuote);
  const stripped = stripOrderedStepPrefix(instructionQuote);
  const explicitMatch = normalized.match(
    /^(?:step\s+\d+[:.)-]?\s*)?(?:enter|type|fill|input|provide)\s+(?:your\s+|the\s+)?(.+?)(?:\s+(?:field|box|input|value|details?))?(?:[.!?].*)?$/i
  );
  if (explicitMatch?.[1]) {
    return cleanInstructionTarget(explicitMatch[1]);
  }

  return ORDERED_STEP_PATTERNS.some((pattern) => pattern.test(normalized))
    ? cleanInstructionTarget(stripped) || null
    : null;
}

function findInteractiveTarget(pageState: PageState, instructionQuote: string): string | null {
  for (const candidate of buildInstructionLineCandidates(instructionQuote)) {
    const normalizedLine = normalizeKey(candidate);
    const exact = pageState.interactive.find((item) => normalizeKey(item.text || item.href || "") === normalizedLine);
    if (exact) {
      return normalizeLineText(exact.text || exact.href || "");
    }
  }

  return null;
}

function findMatchingFormField(pageState: PageState, instructionQuote: string): PageState["formFields"][number] | null {
  const instructionCandidates = buildInstructionLineCandidates(instructionQuote);
  const normalizedLineCandidates = instructionCandidates.map((value) => normalizeKey(value));
  const normalizedTarget = normalizeKey(extractTypeTarget(instructionQuote) ?? instructionCandidates[0] ?? instructionQuote);
  const rankedCandidates = pageState.formFields
    .map((field) => {
      const haystack = [field.label, field.placeholder, field.name, field.id].map((value) => normalizeKey(value)).filter(Boolean);
      let score = 0;

      for (const value of haystack) {
        if (normalizedLineCandidates.includes(value)) {
          score = Math.max(score, 120);
        }
        if (value === normalizedTarget) {
          score = Math.max(score, 110);
        }
        if (value.includes(normalizedTarget) || normalizedTarget.includes(value)) {
          score = Math.max(score, 80);
        }
      }

      if (field.inputType === normalizedTarget) {
        score = Math.max(score, 100);
      }

      return { field, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return rankedCandidates[0]?.field ?? null;
}

function inferFormFieldValue(field: PageState["formFields"][number]): string | null {
  const profile = getPreferredAccessIdentity();
  const key = normalizeKey([field.label, field.placeholder, field.name, field.id, field.inputType].join(" "));
  const defaultAge = "24";
  const defaultOccupations = "Student, designer, trader";

  if (field.inputType === "email" || /\bemail\b|e-mail/.test(key)) {
    return profile.email;
  }
  if (field.inputType === "password" || /\bpassword\b|passcode|pin\b/.test(key)) {
    return profile.password;
  }
  if (/^names?$/.test(normalizeKey(field.label)) || /\bnames\b/.test(key)) {
    return profile.fullName;
  }
  if (/first.?name|given.?name/.test(key)) {
    return profile.firstName;
  }
  if (/last.?name|surname|family.?name/.test(key)) {
    return profile.lastName;
  }
  if (/full.?name|\bname\b/.test(key) && !/company|organization|business/.test(key)) {
    return profile.fullName;
  }
  if (field.inputType === "number" || /\bage\b|years?\b|how old/.test(key)) {
    return defaultAge;
  }
  if (field.inputType === "tel" || /phone|mobile|telephone|tel\b/.test(key)) {
    return profile.phone;
  }
  if (/address.*line.*2|address 2|suite|unit|apt|apartment/.test(key)) {
    return profile.addressLine2;
  }
  if (/street|address/.test(key)) {
    return profile.addressLine1;
  }
  if (/city|town/.test(key)) {
    return profile.city;
  }
  if (/state|province|region/.test(key)) {
    return profile.state;
  }
  if (/zip|postal/.test(key)) {
    return profile.postalCode;
  }
  if (/country/.test(key)) {
    return profile.country;
  }
  if (/company|organization|business/.test(key)) {
    return profile.company;
  }
  if (/occupation|occupations|job title|profession|role|roles|what do you do/.test(key)) {
    return defaultOccupations;
  }

  if (field.required && (field.inputType === "text" || field.tag === "textarea")) {
    return profile.fullName;
  }

  if (field.tag === "select" && field.options.length > 0) {
    const exactCountry = field.options.find((option) => normalizeKey(option) === normalizeKey(profile.country));
    if (exactCountry) {
      return exactCountry;
    }

    const firstRealOption = field.options.find((option) => !/select|choose|pick|--/i.test(option));
    return firstRealOption ?? null;
  }

  return null;
}

function resolveFormFieldTarget(field: PageState["formFields"][number]): string {
  return normalizeLineText(field.label || field.placeholder || field.name || field.id || field.inputType);
}

function resolveInteractiveTarget(item: PageState["interactive"][number]): string {
  return normalizeLineText(item.text || item.href || "");
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
  const normalizedValue = normalizeKey(value);
  if (!normalizedValue) {
    return true;
  }

  if (field.tag === "select" && /^(?:select|choose|pick|please select|--+|option)$/i.test(normalizedValue)) {
    return true;
  }

  return false;
}

function findFirstPendingFormField(pageState: PageState): PageState["formFields"][number] | null {
  for (const field of pageState.formFields) {
    const inferredValue = inferFormFieldValue(field);
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
    .filter((candidate) => Number.isFinite(candidate.score))
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
  const text = inferFormFieldValue(args.pendingField);
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
    target,
    text,
    expectation: `Fill '${target}' before attempting any later field or submit action on this form.`,
    friction: "medium"
  };
}

function enforceFormFirstDecision(args: {
  pageState: PageState;
  decision: PlannerDecision;
}): PlannerDecision {
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

function buildDecisionFromVisibleInstruction(args: {
  pageState: PageState;
  instruction: { stepNumber: number; instructionQuote: string };
}): PlannerDecision {
  const matchingField = findMatchingFormField(args.pageState, args.instruction.instructionQuote);
  if (matchingField) {
    const formValue = inferFormFieldValue(matchingField);
    if (formValue) {
      const target = resolveFormFieldTarget(matchingField);
      return {
        thought: "The next unread visible instruction points to a form field that can be advanced safely with the reusable dummy details.",
        stepNumber: args.instruction.stepNumber,
        instructionQuote: args.instruction.instructionQuote,
        action: "type",
        target,
        text: formValue,
        expectation: `Fill '${target}' for this single step, then wait for the form state to update before moving on.`,
        friction: "medium"
      };
    }
  }

  const directInteractiveTarget = findInteractiveTarget(args.pageState, args.instruction.instructionQuote);
  if (directInteractiveTarget) {
    return {
      thought: "The next unread visible instruction directly matches a visible control, so follow that exact step before considering anything later on the page.",
      stepNumber: args.instruction.stepNumber,
      instructionQuote: args.instruction.instructionQuote,
      action: "click",
      target: directInteractiveTarget,
      text: "",
      expectation: `Click only '${directInteractiveTarget}' and wait for the page to update before considering any later instruction.`,
      friction: ACCESS_GATE_PATTERNS.some((pattern) => pattern.test(args.instruction.instructionQuote)) ? "low" : "medium"
    };
  }

  const clickTarget = extractClickTarget(args.instruction.instructionQuote);
  if (clickTarget) {
    return {
      thought: "The next unread visible instruction explicitly names a control, so follow that single step without skipping ahead.",
      stepNumber: args.instruction.stepNumber,
      instructionQuote: args.instruction.instructionQuote,
      action: "click",
      target: clickTarget,
      text: "",
      expectation: `Click only '${clickTarget}' and wait for the page to update before considering any later instruction.`,
      friction: "medium"
    };
  }

  const typeTarget = extractTypeTarget(args.instruction.instructionQuote);
  if (typeTarget) {
    const field = findMatchingFormField(args.pageState, typeTarget);
    const formValue = field ? inferFormFieldValue(field) : null;

    if (field && formValue) {
      const target = resolveFormFieldTarget(field);
      return {
        thought: "The next unread visible instruction explicitly asks for input and a matching visible field is present.",
        stepNumber: args.instruction.stepNumber,
        instructionQuote: args.instruction.instructionQuote,
        action: "type",
        target,
        text: formValue,
        expectation: `Fill '${target}' for this one step and wait for the form to reflect the new value before moving on.`,
        friction: "medium"
      };
    }
  }

  if (/^(?:step\s+\d+[:.)-]?\s*)?(?:scroll|swipe)\b/i.test(args.instruction.instructionQuote)) {
    return {
      thought: "The next unread visible instruction is an explicit scroll step.",
      stepNumber: args.instruction.stepNumber,
      instructionQuote: args.instruction.instructionQuote,
      action: "scroll",
      target: "",
      text: "",
      expectation: "Scroll once, then wait for the page to settle before evaluating the next visible instruction.",
      friction: "low"
    };
  }

  if (/^(?:step\s+\d+[:.)-]?\s*)?(?:wait|pause|hold)\b/i.test(args.instruction.instructionQuote)) {
    return {
      thought: "The next unread visible instruction explicitly says to wait.",
      stepNumber: args.instruction.stepNumber,
      instructionQuote: args.instruction.instructionQuote,
      action: "wait",
      target: "",
      text: "",
      expectation: "Wait briefly, observe the result, and do not execute any later step yet.",
      friction: "low"
    };
  }

  if (/^(?:step\s+\d+[:.)-]?\s*)?(?:go back|back)\b/i.test(args.instruction.instructionQuote)) {
    return {
      thought: "The next unread visible instruction explicitly says to go back.",
      stepNumber: args.instruction.stepNumber,
      instructionQuote: args.instruction.instructionQuote,
      action: "back",
      target: "",
      text: "",
      expectation: "Go back once and wait for the page update before reading further instructions.",
      friction: "medium"
    };
  }

  return buildStopDecision({
    thought: "The next visible instruction cannot be executed safely without guessing, so the run should stop instead of inventing a different action.",
    expectation: "Stop and report that the current step is ambiguous instead of inferring a missing action.",
    stepNumber: args.instruction.stepNumber,
    instructionQuote: args.instruction.instructionQuote
  });
}

function decisionMatchesExpectedInstruction(args: {
  pageState: PageState;
  decision: PlannerDecision;
  expected: PlannerDecision;
}): boolean {
  if (args.decision.action !== args.expected.action) {
    return false;
  }

  if (args.decision.stepNumber !== args.expected.stepNumber) {
    return false;
  }

  if (normalizeLineText(args.decision.instructionQuote || "") !== normalizeLineText(args.expected.instructionQuote || "")) {
    return false;
  }

  if (args.expected.action === "click") {
    return normalizeKey(args.decision.target || "") === normalizeKey(args.expected.target || "");
  }

  if (args.expected.action === "type") {
    const expectedField = findMatchingFormField(args.pageState, args.expected.target || args.expected.instructionQuote);
    const actualField = findMatchingFormField(args.pageState, args.decision.target || args.decision.instructionQuote);

    if (expectedField && actualField) {
      return expectedField === actualField;
    }

    return normalizeKey(args.decision.target || "") === normalizeKey(args.expected.target || "");
  }

  return true;
}

function enforceInstructionOrderDecision(args: {
  pageState: PageState;
  history: TaskHistoryEntry[];
  decision: PlannerDecision;
}): PlannerDecision {
  const nextInstruction = findNextInstruction({
    pageState: args.pageState,
    history: args.history
  });

  if (nextInstruction) {
    const expected = buildDecisionFromVisibleInstruction({
      pageState: args.pageState,
      instruction: nextInstruction
    });

    return decisionMatchesExpectedInstruction({
      pageState: args.pageState,
      decision: args.decision,
      expected
    })
      ? args.decision
      : expected;
  }

  if (!pageHasStrictStepContent(args.pageState)) {
    return args.decision;
  }

  if (args.decision.action === "extract" || args.decision.action === "stop") {
    return args.decision;
  }

  return buildStopDecision({
    thought: "The page still presents ordered step content, but there are no unread actionable instructions left, so the run should stop instead of inventing a new click path.",
    expectation: "Stop and preserve the evidence already captured rather than branching away from the page instructions."
  });
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
  const pendingField = findFirstPendingFormField(args.pageState);
  if (pendingField) {
    const target = resolveFormFieldTarget(pendingField);
    const text = inferFormFieldValue(pendingField);
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
        target,
        text,
        expectation: `Fill '${target}' with a safe dummy value and wait for the field state to update before moving on.`,
        friction: "medium"
      };
    }
  }

  const pageEvidenceText = normalizeTaskText([args.pageState.title, args.pageState.visibleText, ...args.pageState.headings].join(" "));
  const bestTaskInteractive = findBestTaskInteractiveCandidate({
    suite: args.suite,
    taskIndex: args.taskIndex,
    pageState: args.pageState,
    history: args.history
  });
  const nextInstruction = findNextInstruction({
    pageState: args.pageState,
    history: args.history
  });

  if (nextInstruction) {
    return buildDecisionFromVisibleInstruction({
      pageState: args.pageState,
      instruction: nextInstruction
    });
  }

  if (pageHasStrictStepContent(args.pageState)) {
    return buildStopDecision({
      thought: "Model planning was unavailable and there are no clearly unread actionable steps left on the page.",
      expectation: "Stop rather than inventing a new step or reordering the page instructions."
    });
  }

  if (
    bestTaskInteractive &&
    (taskProfile.engagement || taskProfile.gameplay || taskProfile.buttonCoverage) &&
    bestTaskInteractive.score >= 80
  ) {
    const target = resolveInteractiveTarget(bestTaskInteractive.item);
    return buildTaskInteractiveDecision({
      pageState: args.pageState,
      item: bestTaskInteractive.item,
      thought: `Model planning was unavailable, but '${target}' is the clearest task-aligned live control still visible on the page.`,
      expectation: `Click '${target}' once and confirm whether the visible state meaningfully changes.`,
      friction: "medium"
    });
  }

  if (textHasInstructionCue(pageEvidenceText) || textHasOutcomeCue(pageEvidenceText)) {
    return {
      thought: "Model planning was unavailable, so preserve the visible page state as evidence rather than guessing the next step.",
      stepNumber: null,
      instructionQuote: "",
      action: "extract",
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

export async function decideNextAction(args: {
  suite: TaskSuite;
  taskIndex: number;
  siteBrief: SiteBrief;
  pageState: PageState;
  history: TaskHistoryEntry[];
  remainingSeconds?: number;
}): Promise<PlannerResolution> {
  const task = args.suite.tasks[args.taskIndex];
  const accessProfile = getPreferredAccessIdentity();
  const payload = PlannerInputSchema.parse({
    persona: args.suite.persona,
    task,
    siteBrief: args.siteBrief,
    accessProfile,
    pageState: args.pageState,
    ...(args.remainingSeconds !== undefined ? { remainingSeconds: args.remainingSeconds } : {}),
    history: args.history.slice(-12).map((item) => ({
      step: item.step,
      url: item.url,
      title: item.title,
      decision: {
        stepNumber: item.decision.stepNumber,
        instructionQuote: item.decision.instructionQuote,
        action: item.decision.action,
        target: item.decision.target,
        expectation: item.decision.expectation,
        friction: item.decision.friction
      },
      result: {
        success: item.result.success,
        note: item.result.note
      }
    }))
  });

  try {
    const decision = await generateStructured<PlannerDecision>({
      systemPrompt: BROWSER_AGENT_PROMPT,
      userPayload: payload,
      schemaName: "planner_decision",
      schema: PlannerDecisionSchema,
      timeoutMs: PLANNER_TIMEOUT_MS,
      maxRetries: PLANNER_MAX_RETRIES
    });

    return {
      decision: enforceFormFirstDecision({
        pageState: args.pageState,
        decision: enforceInstructionOrderDecision({
          pageState: args.pageState,
          history: args.history,
          decision: PlannerDecisionSchema.parse(decision)
        })
      })
    };
  } catch (error) {
    return {
      decision: enforceFormFirstDecision({
        pageState: args.pageState,
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
