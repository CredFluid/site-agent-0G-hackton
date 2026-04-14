import path from "node:path";

const SAFE_RUN_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const IMAGE_ARTIFACT_PATTERN = /^[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp)$/i;
const STATIC_REPORT_ARTIFACTS = new Set(["report.html", "report.json", "report.md"]);

export function isSafeRunFileName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && path.basename(trimmed) === trimmed && SAFE_RUN_NAME_PATTERN.test(trimmed);
}

export function isImageArtifact(fileName: string): boolean {
  return IMAGE_ARTIFACT_PATTERN.test(fileName.trim());
}

export function isStaticReportArtifact(fileName: string): boolean {
  return STATIC_REPORT_ARTIFACTS.has(fileName.trim());
}

export function isAllowedDashboardArtifact(fileName: string): boolean {
  return isStaticReportArtifact(fileName) || isImageArtifact(fileName);
}

export function artifactContentType(fileName: string): string {
  if (fileName.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (fileName.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (fileName.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  if (fileName.endsWith(".png")) {
    return "image/png";
  }

  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (fileName.endsWith(".webp")) {
    return "image/webp";
  }

  return "application/octet-stream";
}
