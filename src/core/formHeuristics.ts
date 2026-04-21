import type { AuthIdentity } from "../auth/profile.js";

export type FormFieldLike = {
  label: string;
  placeholder: string;
  name: string;
  id: string;
  tag: string;
  inputType: string;
  required: boolean;
  options: string[];
  autocomplete?: string | undefined;
  inputMode?: string | undefined;
  checked?: boolean | undefined;
  maxLength?: number | null | undefined;
};

export type SupplementalAccessProfile = {
  username: string;
  age: string;
  website: string;
  occupation: string;
  bio: string;
  message: string;
  birthDateIso: string;
  birthDay: string;
  birthMonthNumber: string;
  birthMonthName: string;
  birthMonthShort: string;
  birthYear: string;
  pronouns: string;
  gender: string;
};

export const CHECK_FIELD_SENTINEL = "__SITE_AGENT_CHECK_FIELD__";

const SELECT_PLACEHOLDER_PATTERN = /^(?:(?:please\s+)?(?:select|choose|pick)(?:\s+[a-z0-9][a-z0-9 -]*)?|--+|option)$/i;
const DATE_CONTEXT_BLOCKLIST =
  /arrival|departure|return date|check[- ]?in|check[- ]?out|appointment|meeting|delivery|pickup|reservation|booking|schedule/i;
const CODE_FIELD_PATTERN = /\b(?:coupon|promo|referral|invite|gift|discount|access)\b.*\b(?:code|token)\b|\b(?:coupon|promo|referral|invite|gift|discount)\b/;
const PAYMENT_FIELD_PATTERN = /credit card|cardholder|card number|\bcvv\b|\bcvc\b|expiry|expiration|mm\/yy|mm-yy/;
const PASSWORD_FIELD_PATTERN = /\bpassword\b|passcode|\bpin\b/i;
const EMAIL_FIELD_PATTERN = /\bemail\b|e-mail/i;
const PASSWORD_CONFIRMATION_PATTERN = /\bconfirm\b|re[- ]?(?:enter|type)|repeat|again|verify/i;

function normalizeFormText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeFormKey(value: string): string {
  return normalizeFormText(value).toLowerCase();
}

export function hasPasswordConfirmationCue(value: string): boolean {
  return PASSWORD_CONFIRMATION_PATTERN.test(normalizeFormText(value));
}

function normalizeLooseKey(value: string): string {
  return normalizeFormKey(value).replace(/[^a-z0-9]+/g, "");
}

function localEmailBase(email: string): string {
  return email.split("@", 1)[0] || "";
}

function buildFallbackUsername(identity: AuthIdentity): string {
  const emailBase = localEmailBase(identity.email).replace(/\+/g, "-").replace(/[^a-z0-9._-]+/gi, "");
  if (emailBase) {
    return emailBase.toLowerCase().slice(0, 24);
  }

  return `${identity.firstName}.${identity.lastName}`.replace(/[^a-z0-9._-]+/gi, "").toLowerCase().slice(0, 24);
}

export function buildSupplementalAccessProfile(identity: AuthIdentity): SupplementalAccessProfile {
  return {
    username: identity.username?.trim() || buildFallbackUsername(identity),
    age: "24",
    website: "https://example.com",
    occupation: "QA analyst",
    bio: "Independent QA tester reviewing the signup flow.",
    message: "Testing the signup flow for a product evaluation.",
    birthDateIso: "1998-04-17",
    birthDay: "17",
    birthMonthNumber: "04",
    birthMonthName: "April",
    birthMonthShort: "Apr",
    birthYear: "1998",
    pronouns: "they/them",
    gender: "Prefer not to say"
  };
}

export function buildFormFieldKey(field: Pick<FormFieldLike, "label" | "placeholder" | "name" | "id" | "autocomplete" | "inputType" | "inputMode">): string {
  return normalizeFormKey([field.label, field.placeholder, field.name, field.id, field.autocomplete ?? "", field.inputType, field.inputMode ?? ""].join(" "));
}

export function scoreFormFieldTargetMatch(
  field: Pick<FormFieldLike, "label" | "placeholder" | "name" | "id" | "autocomplete" | "inputType" | "inputMode">,
  target: string
): number {
  const normalizedTarget = normalizeFormKey(target);
  if (!normalizedTarget) {
    return 0;
  }

  const candidates = [field.label, field.placeholder, field.name, field.id, field.autocomplete ?? "", field.inputMode ?? ""]
    .map((value) => normalizeFormKey(value))
    .filter(Boolean);

  let score = 0;

  for (const candidate of candidates) {
    if (candidate === normalizedTarget) {
      score = Math.max(score, 120);
    }

    if (candidate.includes(normalizedTarget) || normalizedTarget.includes(candidate)) {
      score = Math.max(score, 90);
    }
  }

  if (field.inputType === normalizedTarget) {
    score = Math.max(score, 110);
  }

  const fieldKey = buildFormFieldKey(field);
  const targetWantsPassword = PASSWORD_FIELD_PATTERN.test(normalizedTarget);
  const fieldLooksPasswordLike = field.inputType === "password" || PASSWORD_FIELD_PATTERN.test(fieldKey);
  const targetWantsConfirm = hasPasswordConfirmationCue(target);
  const fieldLooksLikeConfirm = hasPasswordConfirmationCue(fieldKey);

  if (targetWantsPassword && fieldLooksPasswordLike) {
    score = Math.max(score, targetWantsConfirm === fieldLooksLikeConfirm ? 130 : 85);
  }

  if (EMAIL_FIELD_PATTERN.test(normalizedTarget) && (field.inputType === "email" || EMAIL_FIELD_PATTERN.test(fieldKey))) {
    score = Math.max(score, 130);
  }

  if (targetWantsConfirm) {
    if (fieldLooksLikeConfirm) {
      score += 70;
    } else if (fieldLooksPasswordLike) {
      score -= 70;
    }
  }

  if (!targetWantsConfirm && targetWantsPassword && fieldLooksLikeConfirm) {
    score -= 40;
  }

  return score;
}

function stripLeadingZero(value: string): string {
  return value.replace(/^0+(\d)/, "$1");
}

function findOptionByCandidates(options: string[], candidates: string[]): string | null {
  const normalizedCandidates = [...new Set(candidates.map((value) => normalizeFormKey(value)).filter(Boolean))];
  const looseCandidates = [...new Set(candidates.map((value) => normalizeLooseKey(value)).filter(Boolean))];
  if (normalizedCandidates.length === 0) {
    return null;
  }

  for (const option of options) {
    const normalizedOption = normalizeFormKey(option);
    if (normalizedCandidates.includes(normalizedOption)) {
      return option;
    }
  }

  for (const option of options) {
    const looseOption = normalizeLooseKey(option);
    if (looseCandidates.includes(looseOption)) {
      return option;
    }
  }

  for (const option of options) {
    const normalizedOption = normalizeFormKey(option);
    if (normalizedCandidates.some((candidate) => normalizedOption.includes(candidate) || candidate.includes(normalizedOption))) {
      return option;
    }
  }

  for (const option of options) {
    const looseOption = normalizeLooseKey(option);
    if (looseCandidates.some((candidate) => looseOption.includes(candidate) || candidate.includes(looseOption))) {
      return option;
    }
  }

  return null;
}

function findAgeOption(options: string[], age: number): string | null {
  for (const option of options) {
    const normalized = normalizeFormKey(option);
    const exactMatch = normalized.match(/\b(\d{1,2})\b/);
    if (exactMatch && Number(exactMatch[1]) === age && !/[-+]/.test(normalized)) {
      return option;
    }

    const rangeMatch = normalized.match(/(\d{1,2})\s*[-to]+\s*(\d{1,2})/);
    if (rangeMatch) {
      const lowerBound = Number(rangeMatch[1]);
      const upperBound = Number(rangeMatch[2]);
      if (Number.isFinite(lowerBound) && Number.isFinite(upperBound) && age >= lowerBound && age <= upperBound) {
        return option;
      }
    }

    const plusMatch = normalized.match(/(\d{1,2})\s*\+/);
    if (plusMatch && age >= Number(plusMatch[1])) {
      return option;
    }
  }

  return null;
}

function getFirstRealOption(options: string[]): string | null {
  return options.find((option) => !SELECT_PLACEHOLDER_PATTERN.test(normalizeFormText(option))) ?? null;
}

function resolveStateCandidates(state: string): string[] {
  const normalized = normalizeFormKey(state);
  if (normalized === "texas") {
    return [state, "TX"];
  }

  if (normalized === "california") {
    return [state, "CA"];
  }

  if (normalized === "new york") {
    return [state, "NY"];
  }

  if (normalized === "florida") {
    return [state, "FL"];
  }

  return [state];
}

export function findMatchingSelectOption(options: string[], desiredValues: string[]): string | null {
  return findOptionByCandidates(options, desiredValues);
}

function inferSelectValue(field: FormFieldLike, identity: AuthIdentity, supplemental: SupplementalAccessProfile): string | null {
  if (field.options.length === 0) {
    return null;
  }

  const key = buildFormFieldKey(field);

  if (/country/.test(key)) {
    return (
      findMatchingSelectOption(field.options, [identity.country, "United States of America", "United States", "USA", "US"]) ??
      getFirstRealOption(field.options)
    );
  }

  if (/state|province|region/.test(key)) {
    return findMatchingSelectOption(field.options, resolveStateCandidates(identity.state)) ?? getFirstRealOption(field.options);
  }

  if (field.autocomplete === "bday-month" || /(?:birth|dob|bday).*(?:month)|month of birth|\bmonth\b/.test(key)) {
    return (
      findMatchingSelectOption(field.options, [
        supplemental.birthMonthName,
        supplemental.birthMonthShort,
        supplemental.birthMonthNumber,
        stripLeadingZero(supplemental.birthMonthNumber)
      ]) ?? getFirstRealOption(field.options)
    );
  }

  if (field.autocomplete === "bday-day" || /(?:birth|dob|bday).*(?:day)|day of birth|\bday\b/.test(key)) {
    return findMatchingSelectOption(field.options, [supplemental.birthDay, stripLeadingZero(supplemental.birthDay)]) ?? getFirstRealOption(field.options);
  }

  if (field.autocomplete === "bday-year" || /(?:birth|dob|bday).*(?:year)|year of birth|\byear\b/.test(key)) {
    return findMatchingSelectOption(field.options, [supplemental.birthYear]) ?? getFirstRealOption(field.options);
  }

  if (/gender|sex/.test(key)) {
    return (
      findMatchingSelectOption(field.options, [
        supplemental.gender,
        "Rather not say",
        "Prefer not to answer",
        "Other",
        "Non-binary",
        "Nonbinary",
        "Male",
        "Female"
      ]) ?? getFirstRealOption(field.options)
    );
  }

  if (/pronouns?/.test(key)) {
    return (
      findMatchingSelectOption(field.options, [
        supplemental.pronouns,
        "Prefer not to say",
        "Rather not say",
        "They/them",
        "They / them"
      ]) ?? getFirstRealOption(field.options)
    );
  }

  if (/age|age range/.test(key)) {
    return findAgeOption(field.options, Number(supplemental.age)) ?? getFirstRealOption(field.options);
  }

  if (/occupation|job title|profession|role/.test(key)) {
    return findMatchingSelectOption(field.options, [supplemental.occupation, "QA", "Tester", "Student"]) ?? getFirstRealOption(field.options);
  }

  return getFirstRealOption(field.options);
}

export function fitValueToField(field: Pick<FormFieldLike, "tag" | "inputType" | "maxLength" | "label" | "placeholder" | "name" | "id" | "autocomplete" | "inputMode">, value: string): string {
  const normalizedValue = normalizeFormText(value);
  const maxLength = field.maxLength && field.maxLength > 0 ? field.maxLength : null;
  if (!maxLength || normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  const key = buildFormFieldKey({
    label: field.label,
    placeholder: field.placeholder,
    name: field.name,
    id: field.id,
    autocomplete: field.autocomplete ?? "",
    inputType: field.inputType,
    inputMode: field.inputMode ?? ""
  });

  if (field.tag === "textarea" || ["text", "search"].includes(field.inputType) || /bio|about|summary|description|message|headline|title/.test(key)) {
    return normalizedValue.slice(0, maxLength).trim();
  }

  return normalizedValue;
}

export function inferFormFieldValue(field: FormFieldLike, identity: AuthIdentity): string | null {
  const supplemental = buildSupplementalAccessProfile(identity);
  const key = buildFormFieldKey(field);

  if (PAYMENT_FIELD_PATTERN.test(key)) {
    return null;
  }

  if (field.inputType === "checkbox") {
    if (field.checked) {
      return null;
    }

    if (field.required || /agree|accept|terms|privacy|conditions|policy|consent|adult|human|acknowledge|confirm|over\s*(?:13|16|18|21)/.test(key)) {
      return CHECK_FIELD_SENTINEL;
    }

    return null;
  }

  if (field.inputType === "radio") {
    if (field.checked) {
      return null;
    }

    // Picking the first visible radio option is a reasonable default for
    // required signup groups like "experience level" when no model plan is available.
    return CHECK_FIELD_SENTINEL;
  }

  if (field.tag === "select") {
    const selectValue = inferSelectValue(field, identity, supplemental);
    if (selectValue) {
      return selectValue;
    }
  }

  if (field.autocomplete === "email" || field.inputType === "email" || /\bemail\b|e-mail/.test(key)) {
    return identity.email;
  }

  if (field.autocomplete === "username" || /\buser.?name\b|handle|screen.?name|user id/.test(key)) {
    return fitValueToField(field, supplemental.username);
  }

  if (field.inputType === "password" || /\bpassword\b|passcode|pin\b/.test(key)) {
    return identity.password;
  }

  if (/^names?$/.test(normalizeFormKey(field.label)) || /\bnames\b/.test(key)) {
    return identity.fullName;
  }

  if (/first.?name|given.?name/.test(key)) {
    return identity.firstName;
  }

  if (/last.?name|surname|family.?name/.test(key)) {
    return identity.lastName;
  }

  if (/display.?name|profile.?name/.test(key)) {
    return identity.fullName;
  }

  if (/full.?name|\bname\b/.test(key) && !/company|organization|business/.test(key)) {
    return identity.fullName;
  }

  if (/pronouns?/.test(key)) {
    return supplemental.pronouns;
  }

  if (/gender|sex/.test(key)) {
    return supplemental.gender;
  }

  if (
    field.autocomplete === "bday" ||
    /date of birth|dob|birthday/.test(key) ||
    (field.inputType === "date" && !DATE_CONTEXT_BLOCKLIST.test(key))
  ) {
    return supplemental.birthDateIso;
  }

  if (field.autocomplete === "bday-year" || /(?:birth|dob|bday).*(?:year)|year of birth/.test(key)) {
    return supplemental.birthYear;
  }

  if (field.autocomplete === "bday-month" || /(?:birth|dob|bday).*(?:month)|month of birth/.test(key)) {
    return supplemental.birthMonthNumber;
  }

  if (field.autocomplete === "bday-day" || /(?:birth|dob|bday).*(?:day)|day of birth/.test(key)) {
    return supplemental.birthDay;
  }

  if (/\bage\b|years?\b|how old/.test(key)) {
    return supplemental.age;
  }

  if (field.inputType === "tel" || /phone|mobile|telephone|tel\b/.test(key)) {
    return identity.phone;
  }

  if (field.inputType === "url" || /website|url|portfolio|linkedin|homepage/.test(key)) {
    return supplemental.website;
  }

  if (/address.*line.*2|address 2|suite|unit|apt|apartment/.test(key)) {
    return identity.addressLine2;
  }

  if (/street|address/.test(key)) {
    return identity.addressLine1;
  }

  if (/city|town/.test(key)) {
    return identity.city;
  }

  if (/state|province|region/.test(key)) {
    return identity.state;
  }

  if (/zip|postal/.test(key)) {
    return identity.postalCode;
  }

  if (/country/.test(key)) {
    return identity.country;
  }

  if (/company|organization|business/.test(key)) {
    return identity.company;
  }

  if (/occupation|job title|profession|role|what do you do/.test(key)) {
    return supplemental.occupation;
  }

  if (/bio|about|summary|description|introduce yourself|tell us about yourself/.test(key)) {
    return fitValueToField(field, supplemental.bio);
  }

  if (/message|why are you interested|why do you want|comment|notes?/.test(key)) {
    return fitValueToField(field, supplemental.message);
  }

  if (field.required && CODE_FIELD_PATTERN.test(key)) {
    return null;
  }

  if (field.required && field.tag === "textarea") {
    return fitValueToField(field, supplemental.bio);
  }

  if (field.required && ["text", "search"].includes(field.inputType)) {
    if (/headline|title/.test(key)) {
      return fitValueToField(field, supplemental.occupation);
    }

    return fitValueToField(field, identity.fullName);
  }

  return null;
}

export function isPlaceholderFieldValue(field: Pick<FormFieldLike, "tag" | "inputType" | "checked">, value: string): boolean {
  if (field.inputType === "checkbox" || field.inputType === "radio") {
    return !field.checked;
  }

  const normalizedValue = normalizeFormKey(value);
  if (!normalizedValue) {
    return true;
  }

  if (field.tag === "select" && SELECT_PLACEHOLDER_PATTERN.test(normalizedValue)) {
    return true;
  }

  return false;
}

export function shouldCheckField(value: string): boolean {
  return value === CHECK_FIELD_SENTINEL;
}
