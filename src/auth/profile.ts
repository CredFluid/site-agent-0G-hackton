import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";

dotenv.config();

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const AuthEnvSchema = z.object({
  AUTH_TEST_EMAIL: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_PASSWORD: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_FIRST_NAME: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_LAST_NAME: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_PHONE: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_ADDRESS_LINE1: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_ADDRESS_LINE2: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_CITY: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_STATE: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_POSTAL_CODE: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_COUNTRY: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_TEST_COMPANY: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_IMAP_HOST: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_IMAP_PORT: z.coerce.number().int().positive().default(993),
  AUTH_IMAP_SECURE: z
    .string()
    .optional()
    .transform((value: string | undefined) => value !== "false"),
  AUTH_IMAP_USER: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_IMAP_PASSWORD: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_IMAP_MAILBOX: z.string().default("INBOX").transform((value) => value.trim() || "INBOX"),
  AUTH_EMAIL_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
  AUTH_EMAIL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  AUTH_OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  AUTH_EMAIL_FROM_FILTER: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_EMAIL_SUBJECT_FILTER: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_GENERATED_IDENTITY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  AUTH_SIGNUP_URL: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_LOGIN_URL: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_ACCESS_URL: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_SESSION_STATE_PATH: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value))
});

const parsed = AuthEnvSchema.parse(process.env);

export type AuthIdentity = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  company: string;
};

export type AuthIdentityPlan = {
  maxAttempts: number;
  identities: AuthIdentity[];
};

let generatedAccessIdentity: AuthIdentity | null = null;

export type MailboxConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
};

export const authSettings = {
  signupUrl: parsed.AUTH_SIGNUP_URL,
  loginUrl: parsed.AUTH_LOGIN_URL,
  accessUrl: parsed.AUTH_ACCESS_URL,
  emailPollTimeoutMs: parsed.AUTH_EMAIL_POLL_TIMEOUT_MS,
  emailPollIntervalMs: parsed.AUTH_EMAIL_POLL_INTERVAL_MS,
  otpLength: parsed.AUTH_OTP_LENGTH,
  emailFromFilter: parsed.AUTH_EMAIL_FROM_FILTER,
  emailSubjectFilter: parsed.AUTH_EMAIL_SUBJECT_FILTER,
  generatedIdentityMaxAttempts: parsed.AUTH_GENERATED_IDENTITY_MAX_ATTEMPTS
};

export function isAuthBootstrapConfigured(): boolean {
  return Boolean(parsed.AUTH_TEST_EMAIL && parsed.AUTH_TEST_PASSWORD);
}

export function requireAuthIdentity(): AuthIdentity {
  if (!parsed.AUTH_TEST_EMAIL) {
    throw new Error("AUTH_TEST_EMAIL is required when --auth-flow is enabled.");
  }

  if (!parsed.AUTH_TEST_PASSWORD) {
    throw new Error("AUTH_TEST_PASSWORD is required when --auth-flow is enabled.");
  }

  const firstName = parsed.AUTH_TEST_FIRST_NAME ?? "Site";
  const lastName = parsed.AUTH_TEST_LAST_NAME ?? "Agent";

  return {
    email: parsed.AUTH_TEST_EMAIL,
    password: parsed.AUTH_TEST_PASSWORD,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    phone: parsed.AUTH_TEST_PHONE ?? "+12025550123",
    addressLine1: parsed.AUTH_TEST_ADDRESS_LINE1 ?? "123 Test Lane",
    addressLine2: parsed.AUTH_TEST_ADDRESS_LINE2 ?? "Suite 100",
    city: parsed.AUTH_TEST_CITY ?? "Austin",
    state: parsed.AUTH_TEST_STATE ?? "Texas",
    postalCode: parsed.AUTH_TEST_POSTAL_CODE ?? "78701",
    country: parsed.AUTH_TEST_COUNTRY ?? "United States",
    company: parsed.AUTH_TEST_COMPANY ?? "Site Agent QA"
  };
}

function splitEmailAddress(email: string): { localPart: string; domain: string } | null {
  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return null;
  }

  return {
    localPart: email.slice(0, atIndex),
    domain: email.slice(atIndex + 1)
  };
}

function buildRetrySeed(): string {
  return crypto.randomBytes(4).toString("hex");
}

function appendCompactSuffix(value: string, suffix: string): string {
  return suffix ? `${value}${suffix}` : value;
}

function appendSpacedSuffix(value: string, suffix: string): string {
  return suffix ? `${value} ${suffix}` : value;
}

function buildVariantPhoneNumber(phone: string, attempt: number): string {
  if (attempt <= 1) {
    return phone;
  }

  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) {
    return phone;
  }

  const attemptDigits = String(attempt).padStart(4, "0").slice(-4);
  const prefix = digits.slice(0, Math.max(0, digits.length - 4));
  const normalized = `${prefix}${attemptDigits}`;

  return phone.trim().startsWith("+") ? `+${normalized}` : normalized;
}

function buildVariantEmail(baseEmail: string, attempt: number, retrySeed: string): string {
  if (attempt <= 1) {
    return baseEmail;
  }

  const parts = splitEmailAddress(baseEmail);
  if (!parts) {
    return baseEmail;
  }

  return `${parts.localPart}+siteagent-${retrySeed}-${attempt}@${parts.domain}`;
}

function buildVariantIdentity(baseIdentity: AuthIdentity, attempt: number, retrySeed: string): AuthIdentity {
  if (attempt <= 1) {
    return baseIdentity;
  }

  const suffix = String(attempt);
  const firstName = appendCompactSuffix(baseIdentity.firstName, suffix);
  const lastName = appendCompactSuffix(baseIdentity.lastName, suffix);

  return {
    email: buildVariantEmail(baseIdentity.email, attempt, retrySeed),
    password: baseIdentity.password,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    phone: buildVariantPhoneNumber(baseIdentity.phone, attempt),
    addressLine1: baseIdentity.addressLine1,
    addressLine2: appendSpacedSuffix(baseIdentity.addressLine2, suffix),
    city: baseIdentity.city,
    state: baseIdentity.state,
    postalCode: baseIdentity.postalCode,
    country: baseIdentity.country,
    company: appendSpacedSuffix(baseIdentity.company, suffix)
  };
}

export function createAuthIdentityPlan(): AuthIdentityPlan {
  const baseIdentity = requireAuthIdentity();
  const retrySeed = buildRetrySeed();
  const maxAttempts = authSettings.generatedIdentityMaxAttempts;

  return {
    maxAttempts,
    identities: Array.from({ length: maxAttempts }, (_, index) => buildVariantIdentity(baseIdentity, index + 1, retrySeed))
  };
}

export function getPreferredAccessIdentity(): AuthIdentity {
  if (isAuthBootstrapConfigured()) {
    return requireAuthIdentity();
  }

  if (!generatedAccessIdentity) {
    const retrySeed = buildRetrySeed();
    const firstName = "Site";
    const lastName = "Agent";

    generatedAccessIdentity = {
      email: `siteagent+${retrySeed}@example.com`,
      password: `SiteAgent!${retrySeed.slice(0, 4)}9`,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      phone: "+12025550123",
      addressLine1: "123 Test Lane",
      addressLine2: "Suite 100",
      city: "Austin",
      state: "Texas",
      postalCode: "78701",
      country: "United States",
      company: "Site Agent QA"
    };
  }

  return generatedAccessIdentity;
}

export function getMailboxConfig(): MailboxConfig | null {
  if (!parsed.AUTH_IMAP_HOST || !parsed.AUTH_IMAP_USER || !parsed.AUTH_IMAP_PASSWORD) {
    return null;
  }

  return {
    host: parsed.AUTH_IMAP_HOST,
    port: parsed.AUTH_IMAP_PORT,
    secure: parsed.AUTH_IMAP_SECURE,
    user: parsed.AUTH_IMAP_USER,
    password: parsed.AUTH_IMAP_PASSWORD,
    mailbox: parsed.AUTH_IMAP_MAILBOX
  };
}

export function requireMailboxConfig(): MailboxConfig {
  const mailbox = getMailboxConfig();
  if (!mailbox) {
    throw new Error(
      "AUTH_IMAP_HOST, AUTH_IMAP_USER, and AUTH_IMAP_PASSWORD are required when the auth flow needs to read OTP or verification emails."
    );
  }

  return mailbox;
}

export function resolveAuthSessionStatePath(): string {
  const configuredPath =
    parsed.AUTH_SESSION_STATE_PATH ??
    config.playwrightStorageStatePath ??
    path.join(".auth", "session.json");

  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(process.cwd(), configuredPath);
}
