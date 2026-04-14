import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import WebP, { type WebPFrame } from "node-webpmux";
import type { TaskRunResult } from "../schemas/types.js";

export const CLICK_REPLAY_ARTIFACT = "click-replay.webp";

const MAX_REPLAY_WIDTH = 640;
const MAX_REPLAY_HEIGHT = 720;
const BEFORE_FRAME_DURATION_MS = 320;
const AFTER_FRAME_DURATION_MS = 760;
const MAX_REPLAY_DURATION_MS = 15000;
const MIN_FRAME_DURATION_MS = 80;

type ReplayClickIndicator = NonNullable<TaskRunResult["history"][number]["result"]["clickIndicator"]>;

type ReplayFrameSource = {
  filePath: string;
  durationMs: number;
  annotation?: string;
  clickIndicator?: ReplayClickIndicator;
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}...`;
}

function buildReplayAnnotation(step: number, target: string): string {
  const cleanedTarget = truncateText(normalizeText(target) || "selected element", 52);
  return `Step ${step}: Click ${cleanedTarget}`;
}

function collectReplaySources(args: {
  runDir: string;
  taskResults: TaskRunResult[];
}): ReplayFrameSource[] {
  const sources: ReplayFrameSource[] = [];

  for (const task of args.taskResults) {
    for (const entry of task.history) {
      if (entry.decision.action !== "click") {
        continue;
      }

      const beforePath = entry.result.beforeScreenshotPath
        ? path.join(args.runDir, entry.result.beforeScreenshotPath)
        : null;
      const afterPath = entry.result.afterScreenshotPath
        ? path.join(args.runDir, entry.result.afterScreenshotPath)
        : null;
      const annotation = buildReplayAnnotation(
        entry.step,
        entry.result.clickIndicator?.targetLabel ?? entry.decision.target
      );

      if (beforePath && fs.existsSync(beforePath)) {
        sources.push({
          filePath: beforePath,
          durationMs: BEFORE_FRAME_DURATION_MS,
          annotation,
          ...(entry.result.clickIndicator ? { clickIndicator: entry.result.clickIndicator } : {})
        });
      }

      if (afterPath && fs.existsSync(afterPath)) {
        sources.push({ filePath: afterPath, durationMs: AFTER_FRAME_DURATION_MS });
      }
    }
  }

  return sources;
}

function normalizeDurations(sources: ReplayFrameSource[]): ReplayFrameSource[] {
  const totalDurationMs = sources.reduce((sum, source) => sum + source.durationMs, 0);

  if (totalDurationMs <= MAX_REPLAY_DURATION_MS) {
    return sources;
  }

  const scale = MAX_REPLAY_DURATION_MS / totalDurationMs;
  return sources.map((source) => ({
    ...source,
    durationMs: Math.max(MIN_FRAME_DURATION_MS, Math.round(source.durationMs * scale))
  }));
}

async function resolveReplayCanvas(sources: ReplayFrameSource[]): Promise<{ width: number; height: number } | null> {
  for (const source of sources) {
    const metadata = await sharp(source.filePath).metadata();
    if (!metadata.width || !metadata.height) {
      continue;
    }

    const scale = Math.min(1, MAX_REPLAY_WIDTH / metadata.width, MAX_REPLAY_HEIGHT / metadata.height);
    return {
      width: Math.max(1, Math.round(metadata.width * scale)),
      height: Math.max(1, Math.round(metadata.height * scale))
    };
  }

  return null;
}

function resolveResizeTransform(args: {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}): {
  scale: number;
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
} {
  const scale = Math.min(1, args.targetWidth / args.sourceWidth, args.targetHeight / args.sourceHeight);
  const renderedWidth = Math.max(1, Math.round(args.sourceWidth * scale));
  const renderedHeight = Math.max(1, Math.round(args.sourceHeight * scale));

  return {
    scale,
    renderedWidth,
    renderedHeight,
    offsetX: Math.round((args.targetWidth - renderedWidth) / 2),
    offsetY: Math.round((args.targetHeight - renderedHeight) / 2)
  };
}

function buildOverlayBuffer(args: {
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth?: number;
  sourceHeight?: number;
  annotation?: string;
  clickIndicator?: ReplayClickIndicator;
}): Buffer | null {
  const label = args.annotation ? truncateText(args.annotation, 70) : "";
  const fontSize = clamp(Math.round(args.canvasWidth * 0.028), 16, 24);
  const labelPaddingX = 14;
  const labelHeight = fontSize + 18;
  const labelWidth = label
    ? Math.min(args.canvasWidth - 24, Math.max(200, Math.round(label.length * (fontSize * 0.62)) + labelPaddingX * 2))
    : 0;
  const labelTextY = 16 + Math.round(labelHeight / 2 + fontSize * 0.34);

  let highlightMarkup = "";
  if (args.clickIndicator && args.sourceWidth && args.sourceHeight) {
    const transform = resolveResizeTransform({
      sourceWidth: args.sourceWidth,
      sourceHeight: args.sourceHeight,
      targetWidth: args.canvasWidth,
      targetHeight: args.canvasHeight
    });
    const padding = clamp(Math.round(Math.min(args.canvasWidth, args.canvasHeight) * 0.012), 8, 18);
    const rawX = transform.offsetX + args.clickIndicator.x * transform.scale;
    const rawY = transform.offsetY + args.clickIndicator.y * transform.scale;
    const rawWidth = Math.max(18, args.clickIndicator.width * transform.scale);
    const rawHeight = Math.max(18, args.clickIndicator.height * transform.scale);
    const boxX = clamp(rawX - padding, 0, args.canvasWidth - 2);
    const boxY = clamp(rawY - padding, 0, args.canvasHeight - 2);
    const boxWidth = clamp(rawWidth + padding * 2, 18, args.canvasWidth - boxX);
    const boxHeight = clamp(rawHeight + padding * 2, 18, args.canvasHeight - boxY);
    const centerX = clamp(rawX + rawWidth / 2, 0, args.canvasWidth);
    const centerY = clamp(rawY + rawHeight / 2, 0, args.canvasHeight);
    const outerRadius = clamp(Math.max(boxWidth, boxHeight) * 0.5, 24, 72);
    const innerRadius = clamp(Math.max(boxWidth, boxHeight) * 0.3, 14, 40);
    const centerRadius = clamp(Math.min(boxWidth, boxHeight) * 0.18, 8, 14);
    const strokeWidth = clamp(Math.round(Math.min(args.canvasWidth, args.canvasHeight) * 0.006), 3, 7);
    const cornerRadius = clamp(Math.round(Math.min(boxWidth, boxHeight) * 0.16), 10, 18);

    highlightMarkup = `
      <rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxWidth.toFixed(1)}" height="${boxHeight.toFixed(1)}" rx="${cornerRadius}" fill="#f59e0b" fill-opacity="0.18" stroke="#ffffff" stroke-opacity="0.98" stroke-width="${strokeWidth + 2}" />
      <rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxWidth.toFixed(1)}" height="${boxHeight.toFixed(1)}" rx="${cornerRadius}" fill="none" stroke="#f97316" stroke-opacity="0.98" stroke-width="${strokeWidth}" />
      <circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${outerRadius.toFixed(1)}" fill="none" stroke="#ffffff" stroke-opacity="0.95" stroke-width="${strokeWidth + 2}" />
      <circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${outerRadius.toFixed(1)}" fill="none" stroke="#ef4444" stroke-opacity="0.88" stroke-width="${strokeWidth}" />
      <circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${innerRadius.toFixed(1)}" fill="none" stroke="#facc15" stroke-opacity="0.9" stroke-width="${Math.max(2, strokeWidth - 1)}" />
      <circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="${centerRadius.toFixed(1)}" fill="#ef4444" fill-opacity="0.96" stroke="#ffffff" stroke-width="3" />
    `;
  }

  if (!highlightMarkup && !label) {
    return null;
  }

  const svg = `
    <svg width="${args.canvasWidth}" height="${args.canvasHeight}" viewBox="0 0 ${args.canvasWidth} ${args.canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      ${highlightMarkup}
      ${
        label
          ? `
            <g>
              <rect x="16" y="16" width="${labelWidth}" height="${labelHeight}" rx="${Math.round(labelHeight / 2)}" fill="#111827" fill-opacity="0.84" stroke="#ffffff" stroke-opacity="0.25" stroke-width="1" />
              <text x="${16 + labelPaddingX}" y="${labelTextY}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeXml(label)}</text>
            </g>
          `
          : ""
      }
    </svg>
  `;

  return Buffer.from(svg);
}

async function buildReplayFrameBuffer(args: {
  source: ReplayFrameSource;
  width: number;
  height: number;
}): Promise<Buffer> {
  const metadata = await sharp(args.source.filePath).metadata();
  let frame = sharp(args.source.filePath)
    .rotate()
    .resize({
      width: args.width,
      height: args.height,
      fit: "contain",
      background: "#ffffff",
      withoutEnlargement: true
    })
    .flatten({ background: "#ffffff" });

  const overlayBuffer = buildOverlayBuffer({
    canvasWidth: args.width,
    canvasHeight: args.height,
    ...(metadata.width ? { sourceWidth: metadata.width } : {}),
    ...(metadata.height ? { sourceHeight: metadata.height } : {}),
    ...(args.source.annotation ? { annotation: args.source.annotation } : {}),
    ...(args.source.clickIndicator ? { clickIndicator: args.source.clickIndicator } : {})
  });

  if (overlayBuffer) {
    frame = frame.composite([{ input: overlayBuffer }]);
  }

  return frame
    .webp({
      quality: 58,
      effort: 4
    })
    .toBuffer();
}

export async function generateClickReplay(args: {
  runDir: string;
  taskResults: TaskRunResult[];
}): Promise<{ artifactName: string; durationMs: number; frameCount: number } | null> {
  const rawSources = collectReplaySources(args);
  if (rawSources.length === 0) {
    return null;
  }

  const sources = normalizeDurations(rawSources);
  const canvas = await resolveReplayCanvas(sources);
  if (!canvas) {
    return null;
  }

  const frames: WebPFrame[] = [];
  for (const source of sources) {
    const buffer = await buildReplayFrameBuffer({
      source,
      width: canvas.width,
      height: canvas.height
    });
    const frame = await WebP.Image.generateFrame({
      buffer,
      delay: source.durationMs
    });
    frames.push(frame);
  }

  const outputPath = path.join(args.runDir, CLICK_REPLAY_ARTIFACT);
  await WebP.Image.save(outputPath, {
    width: canvas.width,
    height: canvas.height,
    frames,
    bgColor: [255, 255, 255, 255],
    loops: 0
  });

  return {
    artifactName: CLICK_REPLAY_ARTIFACT,
    durationMs: sources.reduce((sum, source) => sum + source.durationMs, 0),
    frameCount: frames.length
  };
}
