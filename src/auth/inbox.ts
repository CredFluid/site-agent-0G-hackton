import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { authSettings, type MailboxConfig } from "./profile.js";

export type InboxCheckpoint = {
  uidNext: number;
  capturedAt: string;
};

export type VerificationEmail = {
  uid: number;
  receivedAt: string;
  subject: string;
  from: string;
  otpCode?: string;
  verificationLink?: string;
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(mailbox: MailboxConfig): ImapFlow {
  return new ImapFlow({
    host: mailbox.host,
    port: mailbox.port,
    secure: mailbox.secure,
    auth: {
      user: mailbox.user,
      pass: mailbox.password
    },
    logger: false,
    disableAutoIdle: true
  });
}

function sanitizeUrlCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/[)>.,;]+$/g, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function extractUrls(source: string): string[] {
  const matches = source.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const unique = new Set<string>();

  for (const match of matches) {
    const sanitized = sanitizeUrlCandidate(match);
    if (sanitized) {
      unique.add(sanitized);
    }
  }

  return Array.from(unique);
}

function hostMatches(candidateUrl: string, siteHost: string): boolean {
  try {
    const candidateHost = new URL(candidateUrl).hostname.replace(/^www\./, "").toLowerCase();
    const normalizedSiteHost = siteHost.replace(/^www\./, "").toLowerCase();
    return candidateHost === normalizedSiteHost || candidateHost.endsWith(`.${normalizedSiteHost}`);
  } catch {
    return false;
  }
}

function extractVerificationLink(source: string, siteHost: string): string | undefined {
  const urls = extractUrls(source);
  const scored = urls
    .map((url) => {
      const lower = url.toLowerCase();
      let score = 0;

      if (hostMatches(url, siteHost)) {
        score += 50;
      }
      if (/verify|verification|confirm|activate|magic|signin|sign-in|login|auth|token/.test(lower)) {
        score += 25;
      }
      if (/unsubscribe|privacy|preferences|support/.test(lower)) {
        score -= 25;
      }

      return { url, score };
    })
    .sort((left, right) => right.score - left.score);

  return scored[0]?.score && scored[0].score > 0 ? scored[0].url : undefined;
}

function extractOtpCode(source: string, otpLength: number): string | undefined {
  const contextualPatterns = [
    new RegExp(`(?:otp|one[ -]?time|verification|security|auth|passcode|code)[^\\d]{0,40}(\\d{${otpLength}})`, "i"),
    new RegExp(`(\\d{${otpLength}})[^\\d]{0,40}(?:otp|one[ -]?time|verification|security|auth|passcode|code)`, "i")
  ];

  for (const pattern of contextualPatterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const exactLengthMatch = source.match(new RegExp(`(?<!\\d)(\\d{${otpLength}})(?!\\d)`));
  if (exactLengthMatch?.[1]) {
    return exactLengthMatch[1];
  }

  const genericMatch = source.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return genericMatch?.[1];
}

function messageMatchesFilters(args: {
  subject: string;
  from: string;
  sourceText: string;
}): boolean {
  const subject = args.subject.toLowerCase();
  const from = args.from.toLowerCase();
  const text = args.sourceText.toLowerCase();

  if (authSettings.emailFromFilter && !from.includes(authSettings.emailFromFilter.toLowerCase())) {
    return false;
  }

  if (authSettings.emailSubjectFilter && !subject.includes(authSettings.emailSubjectFilter.toLowerCase())) {
    return false;
  }

  if (authSettings.emailFromFilter || authSettings.emailSubjectFilter) {
    return true;
  }

  return /verify|verification|confirm|activate|otp|one-time|passcode|code|magic link|login/.test(
    `${subject} ${from} ${text}`
  );
}

export async function captureInboxCheckpoint(mailbox: MailboxConfig): Promise<InboxCheckpoint> {
  const client = createClient(mailbox);

  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox.mailbox, { readOnly: true });
    try {
      const mailboxState = client.mailbox === false ? null : client.mailbox;
      return {
        uidNext: mailboxState?.uidNext ?? 1,
        capturedAt: new Date().toISOString()
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function waitForVerificationEmail(args: {
  mailbox: MailboxConfig;
  checkpoint: InboxCheckpoint;
  siteHost: string;
  recipientEmail?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  otpLength?: number;
}): Promise<VerificationEmail> {
  const timeoutMs = args.timeoutMs ?? authSettings.emailPollTimeoutMs;
  const pollIntervalMs = args.pollIntervalMs ?? authSettings.emailPollIntervalMs;
  const otpLength = args.otpLength ?? authSettings.otpLength;
  const deadline = Date.now() + timeoutMs;
  const client = createClient(args.mailbox);

  try {
    await client.connect();

    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock(args.mailbox.mailbox, { readOnly: true });

      try {
        const uidList = (await client.search({ uid: `${args.checkpoint.uidNext}:*` }, { uid: true })) || [];
        const sortedUids = Array.isArray(uidList) ? [...uidList].sort((left, right) => right - left) : [];

        if (sortedUids.length > 0) {
          const messages = await client.fetchAll(
            sortedUids.slice(0, 12),
            {
              uid: true,
              envelope: true,
              source: true
            },
            { uid: true }
          );

          for (const message of messages.sort((left, right) => right.uid - left.uid)) {
            if (!message.source) {
              continue;
            }

            const parsed = await simpleParser(message.source);
            const subject = normalizeText(parsed.subject || message.envelope?.subject || "");
            const from = normalizeText(
              parsed.from?.text ||
                message.envelope?.from?.map((entry) => entry.address || entry.name || "").join(", ") ||
                ""
            );
            const sourceText = normalizeText([parsed.text || "", typeof parsed.html === "string" ? parsed.html : ""].join("\n"));

            if (args.recipientEmail) {
              const toAddresses = (
                message.envelope?.to?.map((entry) => entry.address?.toLowerCase()).filter(Boolean) ?? []
              ) as string[];

              if (!toAddresses.includes(args.recipientEmail.toLowerCase())) {
                continue;
              }
            }

            if (!messageMatchesFilters({ subject, from, sourceText })) {
              continue;
            }

            const verificationLink = extractVerificationLink(sourceText, args.siteHost);
            const otpCode = extractOtpCode(sourceText, otpLength);

            if (!verificationLink && !otpCode) {
              continue;
            }

            return {
              uid: message.uid,
              receivedAt: (parsed.date || message.envelope?.date || new Date()).toISOString(),
              subject,
              from,
              ...(otpCode ? { otpCode } : {}),
              ...(verificationLink ? { verificationLink } : {})
            };
          }
        }
      } finally {
        lock.release();
      }

      await sleep(pollIntervalMs);
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for a verification email in ${args.mailbox.mailbox}.`
  );
}
