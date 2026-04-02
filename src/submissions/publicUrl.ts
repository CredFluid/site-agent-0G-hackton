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

export function validatePublicUrl(rawUrl: string): { normalizedUrl?: string; valid: boolean; reason?: string } {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: "Enter a valid http or https URL." };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, reason: "Only public http and https URLs are allowed in V1." };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    return { valid: false, reason: "Localhost and .local addresses are not allowed in V1. Use a public URL." };
  }

  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return { valid: false, reason: "Private network addresses are not allowed in V1. Use a public URL." };
  }

  parsed.hash = "";

  return {
    valid: true,
    normalizedUrl: parsed.toString()
  };
}
