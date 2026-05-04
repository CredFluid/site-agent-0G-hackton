import { normalizeTaskText } from "./taskHeuristics.js";

export type TaskDirective =
  | { action: "click"; raw: string; target: string }
  | { action: "type_field"; raw: string; target: string; value?: string }
  | { action: "fill_visible_form"; raw: string; target: "" }
  | { action: "submit"; raw: string; target: "" }
  | { action: "scroll"; raw: string; target: "" }
  | { action: "wait"; raw: string; target: "" }
  | { action: "back"; raw: string; target: "" }
  | { action: "stop"; raw: string; target: "" }
  | { action: "unstructured"; raw: string; target: string };

const ACTION_WORD_PATTERN =
  "(?:click|tap|press|open|select|choose|copy|fill(?:\\s+(?:out|up|in))?|enter|type|input|provide|submit|create|register|sign\\s*up|signup|join|scroll|swipe|wait|pause|hold|go back|back|stop|halt)";

function cleanDirectiveText(value: string): string {
  return normalizeTaskText(
    value
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^(?:task|step)\s+\d+[:.)-]?\s*/i, "")
      .replace(/[.?!,]+$/g, "")
  );
}

function cleanDirectiveTarget(value: string): string {
  return cleanDirectiveText(
    value
      .replace(/^(?:on|into|to)\s+/i, "")
      .replace(/^(?:the|a|an|your|my|this|that)\s+/i, "")
      .replace(/^(?:only|just)\s+/i, "")
      .replace(/\s+(?:tab|tabs|button|buttons|link|links|option|options|page|pages|screen|screens|section|sections|menu|item|items|cta|card|cards)\b.*$/i, "")
  );
}

function splitDirectiveSegments(taskText: string): string[] {
  const normalized = normalizeTaskText(taskText)
    .replace(new RegExp(`\\b(?:and then|then|after that|afterwards)\\b`, "gi"), "; ")
    .replace(new RegExp(`\\bnext\\b(?=\\s*${ACTION_WORD_PATTERN}\\b)`, "gi"), "; ")
    .replace(new RegExp(`\\band\\b(?=\\s*${ACTION_WORD_PATTERN}\\b)`, "gi"), "; ")
    .replace(new RegExp(`,(?=\\s*${ACTION_WORD_PATTERN}\\b)`, "gi"), "; ");

  return normalized
    .split(/[;]+/)
    .map((segment) =>
      segment
        .replace(/^(?:first|second|third|fourth|fifth)\b[:,]?\s*/i, "")
        .replace(/^(?:task|step)\s+\d+[:.)-]?\s*/i, "")
        .trim()
    )
    .filter(Boolean);
}

function extractClickTargets(remainder: string): string[] {
  const cleanedRemainder = cleanDirectiveText(remainder.replace(/^(?:on|into|to)\s+/i, ""));
  if (!cleanedRemainder) {
    return [];
  }

  const pluralControlMatch = cleanedRemainder.match(/(.+?)\s+(?:tabs|buttons|links|options|cards|sections|pages|screens)\b/i);
  const listSource = pluralControlMatch?.[1] ?? cleanedRemainder;

  if (pluralControlMatch && /,|\band\b/i.test(listSource)) {
    const splitTargets = listSource
      .split(/\s*,\s*|\s+\band\b\s+/i)
      .map((part) => cleanDirectiveTarget(part))
      .filter(Boolean);

    if (splitTargets.length > 1) {
      return splitTargets;
    }
  }

  const singleTarget = cleanDirectiveTarget(cleanedRemainder);
  return singleTarget ? [singleTarget] : [];
}

function isGenericVisibleFormInstruction(remainder: string): boolean {
  const normalized = cleanDirectiveText(remainder);
  if (!normalized) {
    return true;
  }

  return (
    /^(?:it|them|the form)(?:\s+out)?$/i.test(normalized) ||
    /(?:all|every)\s+(?:the\s+)?(?:visible\s+|required\s+)?(?:details?|fields?|inputs?|boxes?|blanks?|information|info|questions?|form(?:\s+fields?)?)/i.test(
      normalized
    ) ||
    /visible\s+(?:details?|fields?|inputs?|information|form)/i.test(normalized)
  );
}

function isCompleteVisibleFormInstruction(segment: string): boolean {
  const normalized = cleanDirectiveText(segment);
  if (!/^complete\b/i.test(normalized)) {
    return false;
  }

  const remainder = normalized.replace(/^complete\b\s*/i, "");
  return (
    isGenericVisibleFormInstruction(remainder) ||
    /^(?:the\s+)?(?:(?:sign\s*up|signup|registration|account(?:\s+creation)?)\s+)?form(?:\s+out)?$/i.test(remainder)
  );
}

function extractCompactExchangeAmountDirective(raw: string): TaskDirective | null {
  const match = raw.match(
    /^(buy|sell)(?:\s+me)?(?:\s+(?:crypto|cypto|coin|token))?(?:\s+worth)?\s+([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z₦]+)?$/i
  );
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const action = match[1].toLowerCase();
  const unit = (match[3] ?? "").toLowerCase();
  const target = action === "buy" || /\b(?:ngn|naira|₦)\b/i.test(unit) ? "Naira amount" : "crypto amount";

  return {
    action: "type_field",
    raw,
    target,
    value: match[2]
  };
}

function extractExplicitFieldValueDirective(raw: string): TaskDirective | null {
  const intoMatch = raw.match(
    /^(?:fill(?:\s+(?:out|up|in))?|enter|type|input|provide)\s+["'“]?(.+?)["'”]?\s+(?:into|in)\s+(?:the\s+|your\s+)?(.+?)(?:\s+(?:field|box|input|textbox|text box|value|details?))?$/i
  );
  if (intoMatch?.[1] && intoMatch[2]) {
    const value = cleanDirectiveText(intoMatch[1]);
    const target = cleanDirectiveTarget(intoMatch[2]);
    if (value && target && !isGenericVisibleFormInstruction(target)) {
      return {
        action: "type_field",
        raw,
        target,
        value
      };
    }
  }

  const match = raw.match(
    /^(?:fill(?:\s+(?:out|up|in))?|enter|type|input|provide)\s+(?:the\s+|your\s+)?(.+?)\s+(?:with|as|to)\s+["'“]?(.+?)["'”]?$/i
  );
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const target = cleanDirectiveTarget(match[1]);
  const value = cleanDirectiveText(match[2]);
  if (isGenericVisibleFormInstruction(`${target} ${value}`) || isGenericVisibleFormInstruction(target)) {
    return null;
  }

  if (!target || !value) {
    return null;
  }

  return {
    action: "type_field",
    raw,
    target,
    value
  };
}

function extractBareNumericEntryDirective(raw: string): TaskDirective | null {
  const match = raw.match(/^(?:enter|type|input|provide|fill(?:\s+(?:out|up|in))?)\s+([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z₦]+)?$/i);
  if (!match?.[1]) {
    return null;
  }

  const unit = (match[2] ?? "").toLowerCase();
  return {
    action: "type_field",
    raw,
    target: /\b(?:crypto|usdt|btc|eth|usdc)\b/i.test(unit) ? "crypto amount" : "amount",
    value: match[1]
  };
}

export function parseTaskDirectives(taskText: string): TaskDirective[] {
  const directives: TaskDirective[] = [];

  for (const segment of splitDirectiveSegments(taskText)) {
    const raw = cleanDirectiveText(segment);
    if (!raw) {
      continue;
    }

    if (isCompleteVisibleFormInstruction(raw)) {
      directives.push({
        action: "fill_visible_form",
        raw,
        target: ""
      });
      continue;
    }

    const compactExchangeAmountDirective = extractCompactExchangeAmountDirective(raw);
    if (compactExchangeAmountDirective) {
      directives.push(compactExchangeAmountDirective);
      continue;
    }

    const explicitFieldValueDirective = extractExplicitFieldValueDirective(raw);
    if (explicitFieldValueDirective) {
      directives.push(explicitFieldValueDirective);
      continue;
    }

    const bareNumericEntryDirective = extractBareNumericEntryDirective(raw);
    if (bareNumericEntryDirective) {
      directives.push(bareNumericEntryDirective);
      continue;
    }

    const match = segment.match(
      /^(click|tap|press|open|select|choose|copy|fill(?:\s+(?:out|up|in))?|enter|type|input|provide|submit|create|register|sign\s*up|signup|join|scroll|swipe|wait|pause|hold|go back|back|stop|halt)\b\s*(.*)$/i
    );

    if (!match) {
      directives.push({
        action: "unstructured",
        raw,
        target: raw
      });
      continue;
    }

    const verb = (match[1] ?? "").toLowerCase();
    const remainder = match[2] ?? "";
    if (!verb) {
      continue;
    }

    if (verb === "copy") {
      directives.push({
        action: "click",
        raw,
        target: "Copy"
      });
      continue;
    }

    if (["click", "tap", "press", "open", "select", "choose"].includes(verb)) {
      for (const target of extractClickTargets(remainder)) {
        directives.push({
          action: "click",
          raw,
          target
        });
      }
      continue;
    }

    if (["fill", "fill out", "fill up", "fill in", "enter", "type", "input", "provide"].includes(verb)) {
      if (isGenericVisibleFormInstruction(remainder)) {
        directives.push({
          action: "fill_visible_form",
          raw,
          target: ""
        });
        continue;
      }

      const target = cleanDirectiveTarget(remainder.replace(/\s+(?:field|box|input|value|details?)\b.*$/i, ""));
      if (target) {
        directives.push({
          action: "type_field",
          raw,
          target
        });
      }
      continue;
    }

    if (
      verb === "submit" ||
      ((verb === "create" || verb === "register" || verb === "sign up" || verb === "signup" || verb === "join") &&
        /\b(?:account|profile|registration|sign[- ]?up|signup|membership)\b/i.test(remainder || raw))
    ) {
      directives.push({
        action: "submit",
        raw,
        target: ""
      });
      continue;
    }

    if (verb === "scroll" || verb === "swipe") {
      directives.push({
        action: "scroll",
        raw,
        target: ""
      });
      continue;
    }

    if (["wait", "pause", "hold"].includes(verb)) {
      directives.push({
        action: "wait",
        raw,
        target: ""
      });
      continue;
    }

    if (verb === "go back" || verb === "back") {
      directives.push({
        action: "back",
        raw,
        target: ""
      });
      continue;
    }

    if (verb === "stop" || verb === "halt") {
      directives.push({
        action: "stop",
        raw,
        target: ""
      });
    }
  }

  return directives;
}

export function describeTaskDirective(directive: TaskDirective): string {
  switch (directive.action) {
    case "click":
      return `Click the visible control labeled '${directive.target}' before any later step.`;
    case "type_field":
      return `Fill the visible field matching '${directive.target}'.`;
    case "fill_visible_form":
      return "Fill the visible form fields in on-page order until no safe pending visible fields remain.";
    case "submit":
      return "Submit the form only after the earlier form-filling steps are complete.";
    case "scroll":
      return "Scroll once, then reassess the next visible step.";
    case "wait":
      return "Wait briefly before taking any later action.";
    case "back":
      return "Go back once before taking any later action.";
    case "stop":
      return "Stop execution immediately and perform no further actions.";
    case "unstructured":
      return `Follow the user's instruction: '${directive.target}'.`;
    default:
      return "";
  }
}

export function buildTaskDirectiveSummary(taskText: string): string[] {
  return parseTaskDirectives(taskText).map((directive, index) => `${index + 1}. ${describeTaskDirective(directive)}`);
}
