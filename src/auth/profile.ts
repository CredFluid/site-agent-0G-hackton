import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { getStoredIdentity, hasStoredIdentity } from "./credentialStore.js";

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
  AUTH_TEST_USERNAME: z
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
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  AUTH_EMAIL_DOMAIN: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value))
});

const parsed = AuthEnvSchema.parse(process.env);

type AgentIdentityTemplate = {
  firstName: string;
  lastName: string;
  emailLocalPart: string;
  phone: string;
  company: string;
};

export type AccessIdentityContext = {
  agentIndex?: number;
  agentLabel?: string | null;
  agentProfileLabel?: string | null;
};

const ACCESS_IDENTITY_CONTEXT = new AsyncLocalStorage<AccessIdentityContext>();

const HARD_CODED_AGENT_IDENTITIES: AgentIdentityTemplate[] = [
  {
    firstName: "Atlas",
    lastName: "Sentinel",
    emailLocalPart: "agentprobe-atlas",
    phone: "+12025550111",
    company: "AgentProbe Atlas QA"
  },
  {
    firstName: "Beacon",
    lastName: "Sentinel",
    emailLocalPart: "agentprobe-beacon",
    phone: "+12025550122",
    company: "AgentProbe Beacon QA"
  },
  {
    firstName: "Cipher",
    lastName: "Sentinel",
    emailLocalPart: "agentprobe-cipher",
    phone: "+12025550133",
    company: "AgentProbe Cipher QA"
  },
  {
    firstName: "Drift",
    lastName: "Sentinel",
    emailLocalPart: "agentprobe-drift",
    phone: "+12025550144",
    company: "AgentProbe Drift QA"
  },
  {
    firstName: "Echo",
    lastName: "Sentinel",
    emailLocalPart: "agentprobe-echo",
    phone: "+12025550155",
    company: "AgentProbe Echo QA"
  }
];

export type AuthIdentity = {
  email: string;
  username?: string | undefined;
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
  source: "stored" | "configured";
};

const generatedAccessIdentities = new Map<number, AuthIdentity>();

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

function resolveAgentSlot(args?: AccessIdentityContext): number {
  const rawIndex = args?.agentIndex;
  const normalized = typeof rawIndex === "number" && Number.isFinite(rawIndex) ? Math.round(rawIndex) : 1;
  return Math.min(HARD_CODED_AGENT_IDENTITIES.length, Math.max(1, normalized));
}

function getActiveAccessIdentityContext(): AccessIdentityContext {
  return ACCESS_IDENTITY_CONTEXT.getStore() ?? {};
}

function resolveAgentIdentityTemplate(args?: AccessIdentityContext): AgentIdentityTemplate {
  return HARD_CODED_AGENT_IDENTITIES[resolveAgentSlot(args) - 1] ?? HARD_CODED_AGENT_IDENTITIES[0]!;
}

function buildScopedEmail(baseEmail: string | undefined, template: AgentIdentityTemplate): string {
  if (!baseEmail) {
    if (parsed.AUTH_EMAIL_DOMAIN) {
      const seed = crypto.randomBytes(4).toString("hex");
      return `${template.emailLocalPart}-${seed}@${parsed.AUTH_EMAIL_DOMAIN}`;
    }
    return `${template.emailLocalPart}@example.com`;
  }

  const parts = splitEmailAddress(baseEmail);
  if (!parts) {
    return baseEmail;
  }

  const baseLocal = parts.localPart.split("+", 1)[0] || parts.localPart;
  return `${baseLocal}+${template.emailLocalPart}@${parts.domain}`;
}

export async function runWithAccessIdentityContext<T>(
  context: AccessIdentityContext,
  fn: () => Promise<T>
): Promise<T> {
  return await ACCESS_IDENTITY_CONTEXT.run(context, fn);
}

export function getAccessIdentityLabel(context?: AccessIdentityContext): string {
  const template = resolveAgentIdentityTemplate(context ?? getActiveAccessIdentityContext());
  return `${template.firstName} ${template.lastName}`;
}

export function isAuthBootstrapConfigured(url?: string): boolean {
  return Boolean((url && hasStoredIdentity(url)) || (parsed.AUTH_TEST_EMAIL && parsed.AUTH_TEST_PASSWORD));
}

export function requireAuthIdentity(): AuthIdentity {
  if (!parsed.AUTH_TEST_EMAIL) {
    throw new Error("AUTH_TEST_EMAIL is required when --auth-flow is enabled.");
  }

  if (!parsed.AUTH_TEST_PASSWORD) {
    throw new Error("AUTH_TEST_PASSWORD is required when --auth-flow is enabled.");
  }

  const template = resolveAgentIdentityTemplate(getActiveAccessIdentityContext());

  return {
    email: buildScopedEmail(parsed.AUTH_TEST_EMAIL, template),
    username: parsed.AUTH_TEST_USERNAME,
    password: parsed.AUTH_TEST_PASSWORD,
    firstName: template.firstName,
    lastName: template.lastName,
    fullName: `${template.firstName} ${template.lastName}`.trim(),
    phone: parsed.AUTH_TEST_PHONE ?? template.phone,
    addressLine1: parsed.AUTH_TEST_ADDRESS_LINE1 ?? "123 Test Lane",
    addressLine2: parsed.AUTH_TEST_ADDRESS_LINE2 ?? "Suite 100",
    city: parsed.AUTH_TEST_CITY ?? "Austin",
    state: parsed.AUTH_TEST_STATE ?? "Texas",
    postalCode: parsed.AUTH_TEST_POSTAL_CODE ?? "78701",
    country: parsed.AUTH_TEST_COUNTRY ?? "United States",
    company: parsed.AUTH_TEST_COMPANY ?? template.company
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

  return {
    email: buildVariantEmail(baseIdentity.email, attempt, retrySeed),
    username: baseIdentity.username,
    password: baseIdentity.password,
    firstName: baseIdentity.firstName,
    lastName: baseIdentity.lastName,
    fullName: baseIdentity.fullName,
    phone: buildVariantPhoneNumber(baseIdentity.phone, attempt),
    addressLine1: baseIdentity.addressLine1,
    addressLine2: baseIdentity.addressLine2,
    city: baseIdentity.city,
    state: baseIdentity.state,
    postalCode: baseIdentity.postalCode,
    country: baseIdentity.country,
    company: baseIdentity.company
  };
}

export function createAuthIdentityPlan(url?: string): AuthIdentityPlan {
  if (url) {
    const storedIdentity = getStoredIdentity(url);
    if (storedIdentity) {
      return {
        maxAttempts: 1,
        identities: [storedIdentity],
        source: "stored"
      };
    }
  }

  const baseIdentity = requireAuthIdentity();
  const retrySeed = buildRetrySeed();
  const maxAttempts = authSettings.generatedIdentityMaxAttempts;

  return {
    maxAttempts,
    identities: Array.from({ length: maxAttempts }, (_, index) => buildVariantIdentity(baseIdentity, index + 1, retrySeed)),
    source: "configured"
  };
}

export function getPreferredAccessIdentity(url?: string): AuthIdentity {
  if (url) {
    const storedIdentity = getStoredIdentity(url);
    if (storedIdentity) {
      return storedIdentity;
    }
  }

  if (isAuthBootstrapConfigured()) {
    return requireAuthIdentity();
  }

  const context = getActiveAccessIdentityContext();
  const agentSlot = resolveAgentSlot(context);

  if (!generatedAccessIdentities.has(agentSlot)) {
    const retrySeed = buildRetrySeed();
    const template = resolveAgentIdentityTemplate(context);
    const emailDomain = parsed.AUTH_EMAIL_DOMAIN;

    generatedAccessIdentities.set(agentSlot, {
      email: emailDomain
        ? `${template.emailLocalPart}-${retrySeed}@${emailDomain}`
        : `${template.emailLocalPart}+${retrySeed}@example.com`,
      password: `SiteAgent!${retrySeed.slice(0, 4)}9`,
      firstName: template.firstName,
      lastName: template.lastName,
      fullName: `${template.firstName} ${template.lastName}`,
      phone: template.phone,
      addressLine1: "123 Test Lane",
      addressLine2: "Suite 100",
      city: "Austin",
      state: "Texas",
      postalCode: "78701",
      country: "United States",
      company: template.company
    });
  }

  return generatedAccessIdentities.get(agentSlot)!;
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
