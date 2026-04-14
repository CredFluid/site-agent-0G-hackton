function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 127) {
    return true;
  }

  if (a === 169 && b === 254) {
    return true;
  }

  if (a === 192 && b === 168) {
    return true;
  }

  if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
    return true;
  }

  if (a === 0) {
    return true;
  }

  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local");
}

export type SubmissionTargetMode = "public" | "localhost";

export const DEFAULT_SUBMISSION_TARGET_MODE: SubmissionTargetMode = "public";

export function parseSubmissionTargetMode(value: unknown): SubmissionTargetMode {
  return value === "localhost" ? "localhost" : DEFAULT_SUBMISSION_TARGET_MODE;
}

export function validateSubmissionUrl(
  rawUrl: string,
  args: {
    allowPrivateHosts?: boolean;
    targetMode?: SubmissionTargetMode;
  } = {}
): { normalizedUrl?: string; valid: boolean; reason?: string } {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: "Enter a valid http or https URL." };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, reason: "Only http and https URLs are allowed." };
  }

  const hostname = parsed.hostname.toLowerCase();
  const canUsePrivateHosts = Boolean(args.allowPrivateHosts) && args.targetMode === "localhost";

  if (!canUsePrivateHosts && isLocalHostname(hostname)) {
    return {
      valid: false,
      reason: args.allowPrivateHosts
        ? "Switch target to Localhost/private dev site to use localhost, .localhost, or .local addresses."
        : "Localhost, .localhost, and .local addresses are not allowed in V1. Use a public URL."
    };
  }

  if (!canUsePrivateHosts && (isPrivateIpv4(hostname) || isPrivateIpv6(hostname))) {
    return {
      valid: false,
      reason: args.allowPrivateHosts
        ? "Switch target to Localhost/private dev site to use 127.0.0.1 or private network addresses."
        : "Private network addresses are not allowed in V1. Use a public URL."
    };
  }

  parsed.hash = "";

  return {
    valid: true,
    normalizedUrl: parsed.toString()
  };
}

export function validatePublicUrl(rawUrl: string): { normalizedUrl?: string; valid: boolean; reason?: string } {
  return validateSubmissionUrl(rawUrl, {
    allowPrivateHosts: false,
    targetMode: DEFAULT_SUBMISSION_TARGET_MODE
  });
}
