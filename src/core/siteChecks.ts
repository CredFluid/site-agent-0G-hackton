import { devices, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { config } from "../config.js";
import { PageProbeSchema, SiteChecksSchema, type CoverageNote, type PageProbe, type SiteChecks, type TaskRunResult } from "../schemas/types.js";

const CTA_KEYWORDS = [
  "get started",
  "start now",
  "start free",
  "book",
  "buy",
  "shop",
  "sign up",
  "sign in",
  "subscribe",
  "contact",
  "request demo",
  "schedule",
  "try",
  "join",
  "create",
  "checkout",
  "add to cart",
  "learn more"
];

const TRUST_SIGNAL_KEYWORDS = [
  "testimonial",
  "testimonials",
  "review",
  "reviews",
  "trusted",
  "secure",
  "guarantee",
  "guaranteed",
  "refund",
  "privacy",
  "terms",
  "contact",
  "support",
  "verified",
  "customers"
];

const FRAMEWORK_PATTERNS = [
  { label: "WordPress", pattern: /wp-content|wp-includes|wordpress/i },
  { label: "Shopify", pattern: /cdn\.shopify|shopify/i },
  { label: "Next.js", pattern: /_next\/|__next|next-data/i },
  { label: "Nuxt", pattern: /_nuxt\/|__nuxt/i },
  { label: "Wix", pattern: /wixstatic|wix\.com/i },
  { label: "Webflow", pattern: /webflow/i },
  { label: "Squarespace", pattern: /static\.squarespace|squarespace/i }
];

const SECURITY_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy"
] as const;

const IMAGE_URL_PATTERN = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)(?:[?#]|$)/i;
const API_URL_PATTERN = /\/api(?:\/|$)|graphql|wp-json|\.json(?:[?#]|$)/i;
const NON_HTML_RESOURCE_PATTERN = /\.(?:pdf|jpe?g|png|gif|svg|zip|mp4|mp3|css|js)(?:[?#]|$)/i;
const GENERIC_ANCHOR_PATTERN = /^(?:click here|read more|learn more|more|here|details|view more|see more)$/i;
const NON_DESCRIPTIVE_IMAGE_PATTERN = /^(?:img|image|photo|pic|dsc|screenshot|banner|hero)[-_]?\d+/i;
const PLACEHOLDER_CONTENT_PATTERN = /\b(?:lorem ipsum|coming soon|under construction|placeholder|sample text|dummy text|tbd|todo)\b/i;
const SEO_CRAWL_MAX_PAGES = 50;
const SEO_CRAWL_MAX_DEPTH = 3;

type ProbeCapture = {
  probe: PageProbe;
  html: string;
  headers: Record<string, string>;
};

type SeoCrawlSummary = {
  totalPagesAudited: number;
  crawlDepthReached: number;
  pagesSkipped: number;
  skipReasons: string[];
};

type SeoPageStats = {
  pagesMissingTitle: number;
  pagesBadTitleLength: number;
  pagesMissingMetaDescription: number;
  pagesBadMetaDescriptionLength: number;
  pagesMissingCanonical: number;
  pagesNonSelfCanonical: number;
  noindexPages: number;
  nofollowPages: number;
  pagesMissingViewport: number;
  pagesMissingCharset: number;
  pagesWithStructuredData: number;
  pagesMissingOpenGraphBasics: number;
  pagesMissingTwitterCard: number;
  pagesWithUrlIssues: number;
  pagesMissingH1: number;
  pagesWithMultipleH1: number;
  pagesWithHeadingOrderIssues: number;
  pagesLowWordCount: number;
  pagesThinOrPlaceholder: number;
  pagesWithGenericAnchors: number;
  imagesMissingAlt: number;
  imagesWithNonDescriptiveFilenames: number;
  pagesWithRenderBlockingHeadScripts: number;
  pagesWithNonLazyImages: number;
  pagesWithResourceHints: number;
  pagesMissingLang: number;
  pagesWithUnlabeledInputs: number;
  pagesWithUnlabeledInteractive: number;
  pagesMissingSkipNav: number;
};

type SeoAuditedPage = {
  url: string;
  depth: number;
  statusCode: number | null;
  issueCount: number;
  wordCount: number;
  titleLength: number;
  metaDescriptionLength: number;
  h1Count: number;
  notableIssues: string[];
};

type SeoCrawlResult = {
  crawlSummary: SeoCrawlSummary;
  pageStats: SeoPageStats;
  auditedPages: SeoAuditedPage[];
  evidence: string[];
};

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown error";
}

function classifyCrawlRequestFailure(error: unknown): string {
  const message = cleanErrorMessage(error).toLowerCase();
  if (/timed out|timeout/.test(message)) {
    return "request timeout";
  }

  if (/enotfound|name_not_resolved|dns|domain/.test(message)) {
    return "dns or host failure";
  }

  if (/econnrefused|connection refused|err_connection_refused/.test(message)) {
    return "connection refused";
  }

  if (/ssl|tls|certificate|cert_/.test(message)) {
    return "tls or certificate failure";
  }

  if (/net::err_|network/.test(message)) {
    return "network request failure";
  }

  return "request failed";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueItems(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))].slice(0, limit);
}

function ensureSentence(value: string): string {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    return "";
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function buildCoverage(status: CoverageNote["status"], summary: string, evidence: string[] = [], blockers: string[] = []): CoverageNote {
  return {
    status,
    summary: ensureSentence(summary),
    evidence: uniqueItems(evidence.map((item) => ensureSentence(item)), 5),
    blockers: uniqueItems(blockers.map((item) => ensureSentence(item)), 4)
  };
}

function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function hasProbeDomEvidence(probe: PageProbe | null): boolean {
  if (!probe) {
    return false;
  }

  return Boolean(
    probe.title ||
      probe.metaDescription ||
      probe.h1Count > 0 ||
      probe.h2Count > 0 ||
      probe.visibleLinkCount > 0 ||
      probe.internalLinkSamples.length > 0 ||
      probe.ctaSamples.length > 0 ||
      probe.formCount > 0 ||
      probe.wordCount > 0 ||
      probe.mediaCount > 0 ||
      probe.heroText
  );
}

function hasPerformanceEvidence(probe: PageProbe | null): boolean {
  if (!probe) {
    return false;
  }

  return Boolean(
    hasProbeDomEvidence(probe) ||
      probe.performance.domContentLoadedMs !== null ||
      probe.performance.loadMs !== null ||
      probe.performance.firstContentfulPaintMs !== null ||
      probe.performance.largestContentfulPaintMs !== null ||
      probe.performance.cumulativeLayoutShift !== null
  );
}

function hasContentEvidence(probe: PageProbe | null): boolean {
  if (!probe) {
    return false;
  }

  return probe.wordCount > 0 || probe.mediaCount > 0 || probe.readabilityScore !== null || probe.longParagraphCount > 0;
}

function hasCroEvidence(probe: PageProbe | null): boolean {
  if (!probe) {
    return false;
  }

  return probe.ctaSamples.length > 0 || probe.formCount > 0 || probe.submitControlCount > 0 || probe.trustSignalCount > 0;
}

function scoreProbeCapture(capture: ProbeCapture): number {
  return [
    capture.probe.loadOk ? 200 : 0,
    capture.probe.statusCode !== null ? 80 : 0,
    Object.keys(capture.headers).length > 0 ? 60 : 0,
    hasPerformanceEvidence(capture.probe) ? 40 : 0,
    hasProbeDomEvidence(capture.probe) ? 30 : 0,
    capture.probe.wordCount > 0 ? 20 : 0,
    isHttpUrl(capture.probe.finalUrl) ? 10 : 0
  ].reduce((sum, value) => sum + value, 0);
}

function choosePreferredCapture(captures: ProbeCapture[]): ProbeCapture {
  return [...captures].sort((left, right) => scoreProbeCapture(right) - scoreProbeCapture(left))[0] ?? captures[0]!;
}

function buildEmptySeoPageStats(): SeoPageStats {
  return {
    pagesMissingTitle: 0,
    pagesBadTitleLength: 0,
    pagesMissingMetaDescription: 0,
    pagesBadMetaDescriptionLength: 0,
    pagesMissingCanonical: 0,
    pagesNonSelfCanonical: 0,
    noindexPages: 0,
    nofollowPages: 0,
    pagesMissingViewport: 0,
    pagesMissingCharset: 0,
    pagesWithStructuredData: 0,
    pagesMissingOpenGraphBasics: 0,
    pagesMissingTwitterCard: 0,
    pagesWithUrlIssues: 0,
    pagesMissingH1: 0,
    pagesWithMultipleH1: 0,
    pagesWithHeadingOrderIssues: 0,
    pagesLowWordCount: 0,
    pagesThinOrPlaceholder: 0,
    pagesWithGenericAnchors: 0,
    imagesMissingAlt: 0,
    imagesWithNonDescriptiveFilenames: 0,
    pagesWithRenderBlockingHeadScripts: 0,
    pagesWithNonLazyImages: 0,
    pagesWithResourceHints: 0,
    pagesMissingLang: 0,
    pagesWithUnlabeledInputs: 0,
    pagesWithUnlabeledInteractive: 0,
    pagesMissingSkipNav: 0
  };
}

function buildEmptySeoCrawlResult(): SeoCrawlResult {
  return {
    crawlSummary: {
      totalPagesAudited: 0,
      crawlDepthReached: 0,
      pagesSkipped: 0,
      skipReasons: []
    },
    pageStats: buildEmptySeoPageStats(),
    auditedPages: [],
    evidence: []
  };
}

function normalizeCrawlUrl(value: string): string | null {
  if (!isHttpUrl(value)) {
    return null;
  }

  try {
    const parsed = new URL(value);
    parsed.hash = "";
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function recordSkip(skipCounts: Map<string, number>, reason: string): void {
  skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
}

function summarizeSkipReasons(skipCounts: Map<string, number>): string[] {
  return Array.from(skipCounts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([reason, count]) => `${reason} (${count})`);
}

function normalizeTimingValue(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value <= 0) {
    return null;
  }

  return value;
}

function estimateSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!cleaned) {
    return 0;
  }

  const vowelRuns = cleaned.match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = cleaned.endsWith("e") ? 1 : 0;
  return Math.max(1, vowelRuns - silentE);
}

function computeReadability(text: string): { score: number | null; label: string; wordCount: number; longParagraphCount: number } {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { score: null, label: "Insufficient text", wordCount: 0, longParagraphCount: 0 };
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const sentences = normalized.split(/[.!?]+/).map((item) => item.trim()).filter(Boolean);
  const syllables = words.reduce((sum, word) => sum + estimateSyllables(word), 0);
  const score = 206.835 - 1.015 * (words.length / Math.max(1, sentences.length)) - 84.6 * (syllables / Math.max(1, words.length));
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const longParagraphCount = paragraphs.filter((paragraph) => paragraph.split(/\s+/).length >= 120).length;

  if (score >= 70) {
    return { score: Number(score.toFixed(1)), label: "Easy", wordCount: words.length, longParagraphCount };
  }

  if (score >= 50) {
    return { score: Number(score.toFixed(1)), label: "Moderate", wordCount: words.length, longParagraphCount };
  }

  return { score: Number(score.toFixed(1)), label: "Complex", wordCount: words.length, longParagraphCount };
}

function detectFramework(html: string, headers: Record<string, string>): string | null {
  const haystack = `${html} ${Object.entries(headers)
    .map(([key, value]) => `${key}:${value}`)
    .join(" ")}`;

  for (const candidate of FRAMEWORK_PATTERNS) {
    if (candidate.pattern.test(haystack)) {
      return candidate.label;
    }
  }

  return null;
}

function createContextOptions(args: {
  mobile: boolean;
  ignoreHttpsErrors: boolean;
  timezoneId: string;
  storageState: BrowserContextOptions["storageState"];
}): BrowserContextOptions {
  const baseOptions: BrowserContextOptions = args.mobile
    ? {
        ...devices["iPhone 13"],
        viewport: config.mobileViewport,
        ignoreHTTPSErrors: args.ignoreHttpsErrors,
        timezoneId: args.timezoneId
      }
    : {
        viewport: config.desktopViewport,
        ignoreHTTPSErrors: args.ignoreHttpsErrors,
        timezoneId: args.timezoneId,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
      };

  if (args.storageState) {
    baseOptions.storageState = args.storageState;
  }

  return baseOptions;
}

async function collectProbe(args: {
  browser: Browser;
  baseUrl: string;
  mobile: boolean;
  ignoreHttpsErrors: boolean;
  timezoneId: string;
  storageState: BrowserContextOptions["storageState"];
  timeoutMs: number;
}): Promise<ProbeCapture> {
  const context = await args.browser.newContext(
    createContextOptions({
      mobile: args.mobile,
      ignoreHttpsErrors: args.ignoreHttpsErrors,
      timezoneId: args.timezoneId,
      storageState: args.storageState
    })
  );

  await context.addInitScript(() => {
    (window as typeof window & {
      __siteAgentMetrics?: {
        fcp: number | null;
        lcp: number | null;
        cls: number;
      };
    }).__siteAgentMetrics = { fcp: null, lcp: null, cls: 0 };

    try {
      const metricsWindow = window as typeof window & {
        __siteAgentMetrics?: {
          fcp: number | null;
          lcp: number | null;
          cls: number;
        };
      };

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === "first-contentful-paint") {
            metricsWindow.__siteAgentMetrics!.fcp = entry.startTime;
          }
        }
      }).observe({ type: "paint", buffered: true });

      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) {
          metricsWindow.__siteAgentMetrics!.lcp = last.startTime;
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
          if (!entry.hadRecentInput) {
            metricsWindow.__siteAgentMetrics!.cls += entry.value ?? 0;
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // Some browsers or pages may block performance observers.
    }
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(args.timeoutMs);
  page.setDefaultTimeout(args.timeoutMs);

  let responseStatus: number | null = null;
  let headers: Record<string, string> = {};
  let note = "Loaded successfully.";
  let loadOk = false;

  try {
    const response = await page.goto(args.baseUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    responseStatus = response?.status() ?? null;
    headers = response?.headers() ?? {};
    await page.waitForLoadState("load", { timeout: Math.min(5000, args.timeoutMs) }).catch(() => undefined);
    await page.waitForTimeout(1200).catch(() => undefined);
    loadOk = Boolean(responseStatus === null || responseStatus < 400);
    note = responseStatus ? `Loaded with status ${responseStatus}.` : "Loaded without an explicit document response status.";
  } catch (error) {
    note = `Navigation error: ${cleanErrorMessage(error)}`;
    await page.waitForTimeout(600).catch(() => undefined);
  }

  const html = await page.content().catch(() => "");
  const snapshot = await page.evaluate(({ ctaKeywords, trustKeywords }) => {
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const lowerBodyText = bodyText.toLowerCase();
    const visibleLinks: Array<{ href: string; text: string }> = [];
    const internalLinkSamples: string[] = [];
    const ctaSamples: string[] = [];
    const trustSignalSamples: string[] = [];
    const paragraphs: string[] = [];
    let tapTargetIssueCount = 0;
    let smallTextIssueCount = 0;
    let navigationLinkCount = 0;

    for (const candidate of Array.from(document.querySelectorAll("a[href]"))) {
      if (!(candidate instanceof HTMLAnchorElement)) {
        continue;
      }

      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") {
        continue;
      }

      if (!/^https?:/i.test(candidate.href)) {
        continue;
      }

      const text = (candidate.innerText || candidate.getAttribute("aria-label") || candidate.title || "")
        .replace(/\s+/g, " ")
        .trim();
      visibleLinks.push({ href: candidate.href, text });

      try {
        if (new URL(candidate.href).origin === window.location.origin && !internalLinkSamples.includes(candidate.href) && internalLinkSamples.length < 12) {
          internalLinkSamples.push(candidate.href);
        }
      } catch {
        // Ignore malformed href values.
      }
    }

    for (const candidate of Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button'], [role='button']"))) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }

      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") {
        continue;
      }

      if (rect.width < 44 || rect.height < 44) {
        tapTargetIssueCount += 1;
      }

      const text = (candidate.innerText || candidate.getAttribute("aria-label") || candidate.getAttribute("value") || "")
        .replace(/\s+/g, " ")
        .trim();
      const lowerText = text.toLowerCase();
      if (text && ctaSamples.length < 8 && !ctaSamples.includes(text) && ctaKeywords.some((keyword) => lowerText.includes(keyword))) {
        ctaSamples.push(text);
      }
    }

    for (const candidate of Array.from(document.querySelectorAll("p, li, a, button, label, span"))) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }

      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") {
        continue;
      }

      const text = (candidate.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length < 20) {
        continue;
      }

      const fontSize = Number.parseFloat(style.fontSize || "0");
      if (fontSize > 0 && fontSize < 14) {
        smallTextIssueCount += 1;
      }
    }

    for (const candidate of Array.from(document.querySelectorAll("nav a, header a"))) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }

      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") {
        navigationLinkCount += 1;
      }
    }

    for (const keyword of trustKeywords) {
      if (lowerBodyText.includes(keyword) && trustSignalSamples.length < 8 && !trustSignalSamples.includes(keyword)) {
        trustSignalSamples.push(keyword);
      }
    }

    for (const candidate of Array.from(document.querySelectorAll("p"))) {
      const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();
      if (text) {
        paragraphs.push(text);
      }
    }

    const heroText = ((document.querySelector("h1")?.textContent || "").replace(/\s+/g, " ").trim() ||
      (document.querySelector("main")?.textContent || "").slice(0, 160).replace(/\s+/g, " ").trim() ||
      null);

    return {
      title: document.title || "",
      finalUrl: window.location.href,
      metaDescription: document.querySelector("meta[name='description']")?.getAttribute("content")?.trim() || null,
      canonical: document.querySelector("link[rel='canonical']")?.getAttribute("href")?.trim() || null,
      h1Count: document.querySelectorAll("h1").length,
      h2Count: document.querySelectorAll("h2").length,
      structuredDataCount: document.querySelectorAll("script[type='application/ld+json']").length,
      visibleLinkCount: visibleLinks.length,
      internalLinkSamples,
      ctaSamples,
      formCount: document.querySelectorAll("form").length,
      submitControlCount: document.querySelectorAll("button[type='submit'], input[type='submit']").length,
      trustSignalCount: trustSignalSamples.length,
      trustSignalSamples,
      bodyText,
      mediaCount: document.querySelectorAll("img, video, picture, svg").length,
      horizontalOverflow: ((document.documentElement?.scrollWidth ?? window.innerWidth) - window.innerWidth) > 4,
      tapTargetIssueCount,
      smallTextIssueCount,
      navigationLinkCount,
      heroText,
      paragraphs
    };
  }, { ctaKeywords: CTA_KEYWORDS, trustKeywords: TRUST_SIGNAL_KEYWORDS });

  const perf = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const metricsWindow = window as typeof window & {
      __siteAgentMetrics?: {
        fcp: number | null;
        lcp: number | null;
        cls: number;
      };
    };

    return {
      domContentLoadedMs: navigation ? navigation.domContentLoadedEventEnd : null,
      loadMs: navigation ? navigation.loadEventEnd : null,
      firstContentfulPaintMs: metricsWindow.__siteAgentMetrics?.fcp ?? null,
      largestContentfulPaintMs: metricsWindow.__siteAgentMetrics?.lcp ?? null,
      cumulativeLayoutShift: metricsWindow.__siteAgentMetrics?.cls ?? null
    };
  }).catch(() => ({
    domContentLoadedMs: null,
    loadMs: null,
    firstContentfulPaintMs: null,
    largestContentfulPaintMs: null,
    cumulativeLayoutShift: null
  }));

  const normalizedPerf = {
    domContentLoadedMs: normalizeTimingValue(perf.domContentLoadedMs),
    loadMs: normalizeTimingValue(perf.loadMs),
    firstContentfulPaintMs: normalizeTimingValue(perf.firstContentfulPaintMs),
    largestContentfulPaintMs: normalizeTimingValue(perf.largestContentfulPaintMs),
    cumulativeLayoutShift: perf.cumulativeLayoutShift
  };

  await context.close().catch(() => undefined);

  const readability = computeReadability(snapshot.bodyText);

  const probe = PageProbeSchema.parse({
    viewport: args.mobile ? "mobile" : "desktop",
    finalUrl: snapshot.finalUrl,
    title: snapshot.title,
    loadOk,
    note,
    statusCode: responseStatus,
    metaDescription: snapshot.metaDescription,
    canonical: snapshot.canonical,
    h1Count: snapshot.h1Count,
    h2Count: snapshot.h2Count,
    structuredDataCount: snapshot.structuredDataCount,
    visibleLinkCount: snapshot.visibleLinkCount,
    internalLinkSamples: snapshot.internalLinkSamples,
    ctaSamples: snapshot.ctaSamples,
    formCount: snapshot.formCount,
    submitControlCount: snapshot.submitControlCount,
    trustSignalCount: snapshot.trustSignalCount,
    trustSignalSamples: snapshot.trustSignalSamples,
    wordCount: readability.wordCount,
    readabilityScore: readability.score,
    readabilityLabel: readability.label,
    longParagraphCount: readability.longParagraphCount,
    mediaCount: snapshot.mediaCount,
    horizontalOverflow: snapshot.horizontalOverflow,
    tapTargetIssueCount: snapshot.tapTargetIssueCount,
    smallTextIssueCount: snapshot.smallTextIssueCount,
    navigationLinkCount: snapshot.navigationLinkCount,
    heroText: snapshot.heroText,
    performance: normalizedPerf,
    evidence: uniqueItems(
      [
        note,
        snapshot.h1Count > 0 ? `Detected ${snapshot.h1Count} H1 heading(s) and ${snapshot.h2Count} H2 heading(s).` : "No H1 heading was detected on the probed page.",
        snapshot.horizontalOverflow ? "The layout overflowed horizontally in this viewport." : "No horizontal overflow was detected in this viewport.",
        snapshot.tapTargetIssueCount > 0 ? `${snapshot.tapTargetIssueCount} small tap target(s) were detected.` : "Tap target sizing cleared the 44px threshold in this viewport."
      ],
      5
    )
  });

  return {
    probe,
    html,
    headers
  };
}

async function checkUrl(args: {
  page: Page;
  url: string;
  timeoutMs: number;
}): Promise<{ url: string; ok: boolean; statusCode: number | null; note: string }> {
  try {
    const response = await args.page.context().request.get(args.url, {
      timeout: args.timeoutMs,
      failOnStatusCode: false
    });
    const statusCode = response.status();
    const ok = statusCode >= 200 && statusCode < 400;
    return {
      url: args.url,
      ok,
      statusCode,
      note: ok ? `Responded with ${statusCode}.` : `Responded with ${statusCode}.`
    };
  } catch (error) {
    return {
      url: args.url,
      ok: false,
      statusCode: null,
      note: `Request failed: ${cleanErrorMessage(error)}`
    };
  }
}

async function fetchHtmlDocument(args: {
  page: Page;
  url: string;
  timeoutMs: number;
}): Promise<{
  finalUrl: string;
  statusCode: number | null;
  html: string | null;
  skipReason: string | null;
}> {
  try {
    const response = await args.page.context().request.get(args.url, {
      timeout: args.timeoutMs,
      failOnStatusCode: false
    });
    const statusCode = response.status();
    const finalUrl = response.url();
    const contentType = response.headers()["content-type"] ?? "";
    const body = await response.text().catch(() => "");
    const looksHtml = /html|xhtml/i.test(contentType) || /^\s*(?:<!doctype html|<html)\b/i.test(body);

    if (statusCode >= 400) {
      return {
        finalUrl,
        statusCode,
        html: null,
        skipReason: `non-success status ${statusCode}`
      };
    }

    if (!looksHtml) {
      return {
        finalUrl,
        statusCode,
        html: null,
        skipReason: "non-HTML response"
      };
    }

    return {
      finalUrl,
      statusCode,
      html: body,
      skipReason: null
    };
  } catch (error) {
    return {
      finalUrl: args.url,
      statusCode: null,
      html: null,
      skipReason: classifyCrawlRequestFailure(error)
    };
  }
}

async function auditSeoHtml(args: {
  parserPage: Page;
  html: string;
  url: string;
  depth: number;
  seedOrigin: string;
}): Promise<{
  page: SeoAuditedPage;
  pageStats: SeoPageStats;
  discoveredLinks: string[];
}> {
  const snapshot = await args.parserPage.evaluate(
    ({ html, pageUrl, depth, seedOrigin, genericAnchorSource, nonDescriptiveImageSource, placeholderContentSource, nonHtmlResourceSource }) => {
      const document = new DOMParser().parseFromString(html, "text/html");
      const genericAnchorPattern = new RegExp(genericAnchorSource, "i");
      const nonDescriptiveImagePattern = new RegExp(nonDescriptiveImageSource, "i");
      const placeholderContentPattern = new RegExp(placeholderContentSource, "i");
      const nonHtmlResourcePattern = new RegExp(nonHtmlResourceSource, "i");
      const page = new URL(pageUrl);
      page.hash = "";
      if (page.pathname.length > 1) {
        page.pathname = page.pathname.replace(/\/+$/, "");
      }

      const normalizedPageUrl = page.toString();
      const seed = new URL(seedOrigin);
      const bodyText = (document.body?.textContent || "").replace(/\s+/g, " ").trim();
      const words = bodyText ? bodyText.split(/\s+/).filter(Boolean) : [];
      const firstHundredWords = words.slice(0, 100).join(" ").toLowerCase();
      const title = (document.title || "").replace(/\s+/g, " ").trim();
      const metaDescription = (document.querySelector("meta[name='description']")?.getAttribute("content") || "").replace(/\s+/g, " ").trim();
      const canonicalRaw = (document.querySelector("link[rel='canonical']")?.getAttribute("href") || "").replace(/\s+/g, " ").trim();
      let canonical: string | null = null;
      if (canonicalRaw) {
        try {
          const canonicalUrl = new URL(canonicalRaw, pageUrl);
          canonicalUrl.hash = "";
          if (canonicalUrl.pathname.length > 1) {
            canonicalUrl.pathname = canonicalUrl.pathname.replace(/\/+$/, "");
          }
          canonical = canonicalUrl.toString();
        } catch {
          canonical = null;
        }
      }

      const robotsContent = ((document.querySelector("meta[name='robots']")?.getAttribute("content") || "").replace(/\s+/g, " ").trim()).toLowerCase();
      const viewportPresent = Boolean(document.querySelector("meta[name='viewport']"));
      const charsetPresent = Boolean(
        document.querySelector("meta[charset]") ||
          document.querySelector("meta[http-equiv='content-type'][content*='charset']")
      );
      const structuredDataTypes: string[] = [];

      document.querySelectorAll("script[type='application/ld+json']").forEach((script) => {
        const raw = script.textContent?.trim();
        if (!raw) {
          return;
        }

        try {
          const pending: unknown[] = [JSON.parse(raw)];
          while (pending.length > 0) {
            const current = pending.pop();
            if (Array.isArray(current)) {
              for (const item of current) {
                pending.push(item);
              }
              continue;
            }

            if (!current || typeof current !== "object") {
              continue;
            }

            const record = current as Record<string, unknown>;
            const typeValue = record["@type"];
            if (typeof typeValue === "string" && typeValue.trim()) {
              structuredDataTypes.push(typeValue.trim());
            } else if (Array.isArray(typeValue)) {
              for (const item of typeValue) {
                if (typeof item === "string" && item.trim()) {
                  structuredDataTypes.push(item.trim());
                }
              }
            }

            if (record["@graph"]) {
              pending.push(record["@graph"]);
            }
          }
        } catch {
          // Ignore invalid JSON-LD blobs.
        }
      });

      const ogTags = {
        title: Boolean(document.querySelector("meta[property='og:title']")),
        description: Boolean(document.querySelector("meta[property='og:description']")),
        image: Boolean(document.querySelector("meta[property='og:image']")),
        url: Boolean(document.querySelector("meta[property='og:url']"))
      };
      const twitterCardPresent = Boolean(document.querySelector("meta[name='twitter:card']"));
      const h1Count = document.querySelectorAll("h1").length;
      const headingLevels = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((heading) =>
        Number.parseInt(heading.tagName.replace(/[^0-9]/g, ""), 10)
      );
      const headingOrderIssue = headingLevels.some((level, index) => index > 0 && level > headingLevels[index - 1]! + 1);
      const lowWordCount = words.length > 0 && words.length < 300;
      const thinOrPlaceholder = words.length > 0 && (words.length < 150 || placeholderContentPattern.test(bodyText));
      const langPresent = Boolean(document.documentElement.getAttribute("lang")?.trim());
      const skipNavPresent = Array.from(document.querySelectorAll("a[href^='#']")).some((link) => {
        const text = (link.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return text.includes("skip") && (text.includes("content") || text.includes("main"));
      });

      let internalLinkCount = 0;
      let externalLinkCount = 0;
      let nofollowExternalLinkCount = 0;
      let genericAnchorCount = 0;
      const discoveredLinks = new Set<string>();

      document.querySelectorAll("a[href]").forEach((link) => {
        const rawHref = link.getAttribute("href")?.trim() || "";
        if (!rawHref || rawHref.startsWith("#") || /^(?:mailto|tel|javascript):/i.test(rawHref)) {
          return;
        }

        let resolved: URL;
        try {
          resolved = new URL(rawHref, pageUrl);
        } catch {
          return;
        }

        if (!/^https?:$/i.test(resolved.protocol)) {
          return;
        }

        const text = (link.textContent || link.getAttribute("aria-label") || link.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        if (text && genericAnchorPattern.test(text)) {
          genericAnchorCount += 1;
        }

        if (resolved.protocol === seed.protocol && resolved.host === seed.host) {
          internalLinkCount += 1;
          resolved.hash = "";
          if (resolved.pathname.length > 1) {
            resolved.pathname = resolved.pathname.replace(/\/+$/, "");
          }
          const normalizedResolved = resolved.toString();
          if (!nonHtmlResourcePattern.test(normalizedResolved)) {
            discoveredLinks.add(normalizedResolved);
          }
          return;
        }

        externalLinkCount += 1;
        if ((link.getAttribute("rel") || "").toLowerCase().includes("nofollow")) {
          nofollowExternalLinkCount += 1;
        }
      });

      let imagesMissingAlt = 0;
      let imagesWithNonDescriptiveFilenames = 0;
      let imagesWithoutLazyLoading = 0;

      document.querySelectorAll("img[src]").forEach((image) => {
        const alt = image.getAttribute("alt");
        if (alt === null || !alt.trim()) {
          imagesMissingAlt += 1;
        }
        if ((image.getAttribute("loading") || "").toLowerCase() !== "lazy") {
          imagesWithoutLazyLoading += 1;
        }

        const rawSrc = image.getAttribute("src")?.trim();
        if (!rawSrc) {
          return;
        }

        try {
          const resolved = new URL(rawSrc, pageUrl);
          const filename = decodeURIComponent(resolved.pathname.split("/").pop() || "").toLowerCase();
          if (filename && nonDescriptiveImagePattern.test(filename)) {
            imagesWithNonDescriptiveFilenames += 1;
          }
        } catch {
          // Ignore malformed image URLs.
        }
      });

      const renderBlockingHeadScripts = Array.from(document.head?.querySelectorAll("script") || []).filter((script) => {
        const type = (script.getAttribute("type") || "").toLowerCase();
        if (type === "application/ld+json") {
          return false;
        }

        return !script.hasAttribute("defer") && !script.hasAttribute("async");
      }).length;
      const resourceHintCount = document.querySelectorAll(
        "link[rel='preload'], link[rel='prefetch'], link[rel='preconnect'], link[rel='dns-prefetch']"
      ).length;

      const unlabeledInputCount = Array.from(
        document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select")
      ).filter((field) => {
        const id = field.getAttribute("id");
        const ariaLabel = field.getAttribute("aria-label")?.trim();
        const ariaLabelledBy = field.getAttribute("aria-labelledby")?.trim();
        const wrappingLabel = field.closest("label");
        const matchingLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return !ariaLabel && !ariaLabelledBy && !wrappingLabel && !matchingLabel;
      }).length;

      const unlabeledInteractiveCount = Array.from(
        document.querySelectorAll("button, a[href], input[type='submit'], input[type='button'], [role='button']")
      ).filter((element) => {
        const visibleText = ((element.textContent || "") + " " + (element.getAttribute("value") || "")).replace(/\s+/g, " ").trim();
        const ariaLabel = element.getAttribute("aria-label")?.trim();
        const titleAttr = element.getAttribute("title")?.trim();
        return !visibleText && !ariaLabel && !titleAttr;
      }).length;

      const pageUrlHasIssue = page.pathname.includes("_") || page.searchParams.size > 3;
      const notableIssues: string[] = [];
      if (!title) {
        notableIssues.push("Missing title tag");
      } else if (title.length < 50 || title.length > 60) {
        notableIssues.push("Title length outside ideal range");
      }
      if (!metaDescription) {
        notableIssues.push("Missing meta description");
      }
      if (!canonical) {
        notableIssues.push("Missing canonical");
      } else if (canonical !== normalizedPageUrl) {
        notableIssues.push("Canonical is not self-referencing");
      }
      if (h1Count !== 1) {
        notableIssues.push(h1Count === 0 ? "Missing H1" : "Multiple H1 tags");
      }
      if (headingOrderIssue) {
        notableIssues.push("Heading hierarchy skips levels");
      }
      if (lowWordCount) {
        notableIssues.push("Low visible word count");
      }
      if (thinOrPlaceholder) {
        notableIssues.push("Thin or placeholder content");
      }
      if (!ogTags.title || !ogTags.description || !ogTags.image || !ogTags.url) {
        notableIssues.push("Missing core Open Graph tags");
      }
      if (!twitterCardPresent) {
        notableIssues.push("Missing Twitter card");
      }
      if (imagesMissingAlt > 0) {
        notableIssues.push("Images missing alt text");
      }
      if (!langPresent) {
        notableIssues.push("Missing lang attribute");
      }

      const issueCount = [
        title.length === 0 || title.length < 50 || title.length > 60,
        metaDescription.length === 0 || metaDescription.length < 150 || metaDescription.length > 160,
        !canonical || canonical !== normalizedPageUrl,
        h1Count !== 1,
        headingOrderIssue,
        lowWordCount,
        thinOrPlaceholder,
        !viewportPresent,
        !charsetPresent,
        structuredDataTypes.length === 0,
        !ogTags.title || !ogTags.description || !ogTags.image || !ogTags.url,
        !twitterCardPresent,
        pageUrlHasIssue,
        genericAnchorCount > 0,
        imagesMissingAlt > 0,
        imagesWithNonDescriptiveFilenames > 0,
        renderBlockingHeadScripts > 0,
        imagesWithoutLazyLoading > 0,
        !langPresent,
        unlabeledInputCount > 0,
        unlabeledInteractiveCount > 0,
        !skipNavPresent
      ].filter(Boolean).length;

      return {
        url: normalizedPageUrl,
        depth,
        titleLength: title.length,
        metaDescriptionLength: metaDescription.length,
        canonical,
        canonicalSelfReferencing: canonical === normalizedPageUrl,
        noindex: robotsContent.includes("noindex"),
        nofollow: robotsContent.includes("nofollow"),
        viewportPresent,
        charsetPresent,
        structuredDataTypes: Array.from(new Set(structuredDataTypes)),
        missingOpenGraphBasics: !ogTags.title || !ogTags.description || !ogTags.image || !ogTags.url,
        twitterCardPresent,
        urlHasIssue: pageUrlHasIssue,
        h1Count,
        headingOrderIssue,
        wordCount: words.length,
        thinOrPlaceholder,
        internalLinkCount,
        externalLinkCount,
        nofollowExternalLinkCount,
        genericAnchorCount,
        imagesMissingAlt,
        imagesWithNonDescriptiveFilenames,
        renderBlockingHeadScripts,
        imagesWithoutLazyLoading,
        resourceHintCount,
        langPresent,
        unlabeledInputCount,
        unlabeledInteractiveCount,
        skipNavPresent,
        issueCount,
        notableIssues: notableIssues.slice(0, 6),
        discoveredLinks: Array.from(discoveredLinks),
        keywordInFirstHundredWords: firstHundredWords.length > 0
      };
    },
    {
      html: args.html,
      pageUrl: args.url,
      depth: args.depth,
      seedOrigin: args.seedOrigin,
      genericAnchorSource: GENERIC_ANCHOR_PATTERN.source,
      nonDescriptiveImageSource: NON_DESCRIPTIVE_IMAGE_PATTERN.source,
      placeholderContentSource: PLACEHOLDER_CONTENT_PATTERN.source,
      nonHtmlResourceSource: NON_HTML_RESOURCE_PATTERN.source
    }
  );

  const pageStats = buildEmptySeoPageStats();
  if (snapshot.titleLength === 0) {
    pageStats.pagesMissingTitle += 1;
  } else if (snapshot.titleLength < 50 || snapshot.titleLength > 60) {
    pageStats.pagesBadTitleLength += 1;
  }
  if (snapshot.metaDescriptionLength === 0) {
    pageStats.pagesMissingMetaDescription += 1;
  } else if (snapshot.metaDescriptionLength < 150 || snapshot.metaDescriptionLength > 160) {
    pageStats.pagesBadMetaDescriptionLength += 1;
  }
  if (!snapshot.canonical) {
    pageStats.pagesMissingCanonical += 1;
  } else if (!snapshot.canonicalSelfReferencing) {
    pageStats.pagesNonSelfCanonical += 1;
  }
  if (snapshot.noindex) {
    pageStats.noindexPages += 1;
  }
  if (snapshot.nofollow) {
    pageStats.nofollowPages += 1;
  }
  if (!snapshot.viewportPresent) {
    pageStats.pagesMissingViewport += 1;
  }
  if (!snapshot.charsetPresent) {
    pageStats.pagesMissingCharset += 1;
  }
  if (snapshot.structuredDataTypes.length > 0) {
    pageStats.pagesWithStructuredData += 1;
  }
  if (snapshot.missingOpenGraphBasics) {
    pageStats.pagesMissingOpenGraphBasics += 1;
  }
  if (!snapshot.twitterCardPresent) {
    pageStats.pagesMissingTwitterCard += 1;
  }
  if (snapshot.urlHasIssue) {
    pageStats.pagesWithUrlIssues += 1;
  }
  if (snapshot.h1Count === 0) {
    pageStats.pagesMissingH1 += 1;
  }
  if (snapshot.h1Count > 1) {
    pageStats.pagesWithMultipleH1 += 1;
  }
  if (snapshot.headingOrderIssue) {
    pageStats.pagesWithHeadingOrderIssues += 1;
  }
  if (snapshot.wordCount > 0 && snapshot.wordCount < 300) {
    pageStats.pagesLowWordCount += 1;
  }
  if (snapshot.thinOrPlaceholder) {
    pageStats.pagesThinOrPlaceholder += 1;
  }
  if (snapshot.genericAnchorCount > 0) {
    pageStats.pagesWithGenericAnchors += 1;
  }
  pageStats.imagesMissingAlt += snapshot.imagesMissingAlt;
  pageStats.imagesWithNonDescriptiveFilenames += snapshot.imagesWithNonDescriptiveFilenames;
  if (snapshot.renderBlockingHeadScripts > 0) {
    pageStats.pagesWithRenderBlockingHeadScripts += 1;
  }
  if (snapshot.imagesWithoutLazyLoading > 0) {
    pageStats.pagesWithNonLazyImages += 1;
  }
  if (snapshot.resourceHintCount > 0) {
    pageStats.pagesWithResourceHints += 1;
  }
  if (!snapshot.langPresent) {
    pageStats.pagesMissingLang += 1;
  }
  if (snapshot.unlabeledInputCount > 0) {
    pageStats.pagesWithUnlabeledInputs += 1;
  }
  if (snapshot.unlabeledInteractiveCount > 0) {
    pageStats.pagesWithUnlabeledInteractive += 1;
  }
  if (!snapshot.skipNavPresent) {
    pageStats.pagesMissingSkipNav += 1;
  }

  return {
    page: {
      url: snapshot.url,
      depth: snapshot.depth,
      statusCode: null,
      issueCount: snapshot.issueCount,
      wordCount: snapshot.wordCount,
      titleLength: snapshot.titleLength,
      metaDescriptionLength: snapshot.metaDescriptionLength,
      h1Count: snapshot.h1Count,
      notableIssues: snapshot.notableIssues
    },
    pageStats,
    discoveredLinks: snapshot.discoveredLinks
  };
}

async function crawlSeoSite(args: {
  requestPage: Page;
  parserPage: Page;
  seedUrl: string;
  requestTimeoutMs: number;
  deadline: number;
}): Promise<SeoCrawlResult> {
  const empty = buildEmptySeoCrawlResult();
  const normalizedSeedUrl = normalizeCrawlUrl(args.seedUrl);
  if (!normalizedSeedUrl) {
    return empty;
  }

  const seed = new URL(normalizedSeedUrl);
  const queue: Array<{ url: string; depth: number }> = [{ url: normalizedSeedUrl, depth: 0 }];
  const visited = new Set<string>();
  const skipCounts = new Map<string, number>();
  const pageStats = buildEmptySeoPageStats();
  const auditedPages: SeoAuditedPage[] = [];
  let pagesSkipped = 0;
  let crawlDepthReached = 0;

  while (queue.length > 0 && auditedPages.length < SEO_CRAWL_MAX_PAGES && Date.now() < args.deadline) {
    const current = queue.shift()!;
    if (visited.has(current.url)) {
      continue;
    }

    visited.add(current.url);

    if (NON_HTML_RESOURCE_PATTERN.test(current.url)) {
      pagesSkipped += 1;
      recordSkip(skipCounts, "non-HTML resource");
      continue;
    }

    const currentUrl = new URL(current.url);
    if (currentUrl.protocol !== seed.protocol || currentUrl.host !== seed.host) {
      pagesSkipped += 1;
      recordSkip(skipCounts, "external domain");
      continue;
    }

    const fetched = await fetchHtmlDocument({
      page: args.requestPage,
      url: current.url,
      timeoutMs: args.requestTimeoutMs
    });

    const normalizedFinalUrl = normalizeCrawlUrl(fetched.finalUrl) ?? current.url;
    const finalUrl = new URL(normalizedFinalUrl);
    if (finalUrl.protocol !== seed.protocol || finalUrl.host !== seed.host) {
      pagesSkipped += 1;
      recordSkip(skipCounts, "redirected outside crawl scope");
      continue;
    }

    if (!fetched.html || fetched.skipReason) {
      pagesSkipped += 1;
      recordSkip(skipCounts, fetched.skipReason ?? "non-HTML response");
      continue;
    }

    const audited = await auditSeoHtml({
      parserPage: args.parserPage,
      html: fetched.html,
      url: normalizedFinalUrl,
      depth: current.depth,
      seedOrigin: seed.origin
    });

    audited.page.statusCode = fetched.statusCode;
    auditedPages.push(audited.page);
    crawlDepthReached = Math.max(crawlDepthReached, current.depth);
    for (const key of Object.keys(pageStats) as Array<keyof SeoPageStats>) {
      pageStats[key] += audited.pageStats[key];
    }

    if (current.depth < SEO_CRAWL_MAX_DEPTH) {
      for (const discoveredLink of audited.discoveredLinks) {
        if (!visited.has(discoveredLink) && !queue.some((entry) => entry.url === discoveredLink)) {
          queue.push({ url: discoveredLink, depth: current.depth + 1 });
        }
      }
    }
  }

  if (queue.length > 0) {
    pagesSkipped += queue.length;
    recordSkip(skipCounts, auditedPages.length >= SEO_CRAWL_MAX_PAGES ? "crawl page limit reached" : "crawl budget exhausted");
  }

  const crawlSummary: SeoCrawlSummary = {
    totalPagesAudited: auditedPages.length,
    crawlDepthReached,
    pagesSkipped,
    skipReasons: summarizeSkipReasons(skipCounts)
  };

  const evidence = uniqueItems(
    [
      auditedPages.length > 0 ? `Crawled ${auditedPages.length} same-origin HTML page(s) up to depth ${crawlDepthReached}.` : "",
      pagesSkipped > 0 ? `${pagesSkipped} URL(s) were skipped during the SEO crawl.` : "",
      pageStats.pagesMissingTitle > 0 || pageStats.pagesBadTitleLength > 0
        ? `${pageStats.pagesMissingTitle + pageStats.pagesBadTitleLength} crawled page(s) had title-tag issues.`
        : "",
      pageStats.pagesMissingMetaDescription > 0 || pageStats.pagesBadMetaDescriptionLength > 0
        ? `${pageStats.pagesMissingMetaDescription + pageStats.pagesBadMetaDescriptionLength} crawled page(s) had meta-description issues.`
        : "",
      pageStats.pagesMissingH1 > 0 || pageStats.pagesWithMultipleH1 > 0
        ? `${pageStats.pagesMissingH1 + pageStats.pagesWithMultipleH1} crawled page(s) had H1 issues.`
        : ""
    ],
    5
  );

  return {
    crawlSummary,
    pageStats,
    auditedPages: auditedPages.sort((left, right) => right.issueCount - left.issueCount || left.depth - right.depth || left.url.localeCompare(right.url)),
    evidence
  };
}

export async function runSiteChecks(args: {
  browser: Browser;
  baseUrl: string;
  ignoreHttpsErrors: boolean;
  browserTimezone: string;
  storageState: BrowserContextOptions["storageState"];
  rawEvents: unknown[];
  taskResults: TaskRunResult[];
  budgetMs: number;
}): Promise<SiteChecks> {
  const blocked = (reason: string): SiteChecks =>
    SiteChecksSchema.parse({
      generatedAt: new Date().toISOString(),
      baseUrl: args.baseUrl,
      finalResolvedUrl: null,
      coverage: {
        performance: buildCoverage("blocked", "Performance checks could not be completed.", [], [reason]),
        seo: buildCoverage("blocked", "SEO checks could not be completed.", [], [reason]),
        uiux: buildCoverage("inferred", "UI and UX findings were inferred from the interaction audit because supplemental probing did not run.", [], [reason]),
        security: buildCoverage("blocked", "Security checks could not be completed.", [], [reason]),
        technicalHealth: buildCoverage("inferred", "Technical health relies on the saved runtime signals because supplemental probing did not run.", [], [reason]),
        mobileOptimization: buildCoverage("blocked", "Mobile responsiveness could not be tested.", [], [reason]),
        contentQuality: buildCoverage("blocked", "Content-quality checks could not be completed.", [], [reason]),
        cro: buildCoverage("inferred", "CRO findings were inferred from the interaction audit because supplemental probing did not run.", [], [reason])
      },
      performance: {
        desktop: null,
        mobile: null,
        failedRequestCount: 0,
        imageFailureCount: 0,
        apiFailureCount: 0,
        navigationErrorCount: 0,
        stalledInteractionCount: 0,
        evidence: []
      },
      seo: {
        robotsTxt: { url: new URL("/robots.txt", args.baseUrl).toString(), ok: false, statusCode: null, note: reason },
        sitemap: { url: new URL("/sitemap.xml", args.baseUrl).toString(), ok: false, statusCode: null, note: reason },
        brokenLinkCount: 0,
        checkedLinkCount: 0,
        brokenLinks: [],
        evidence: []
      },
      security: {
        https: args.baseUrl.startsWith("https://"),
        secureTransportVerified: false,
        initialStatusCode: null,
        securityHeaders: SECURITY_HEADERS.map((name) => ({ name, present: false, value: null, note: reason })),
        missingHeaders: [...SECURITY_HEADERS],
        evidence: []
      },
      technicalHealth: {
        framework: null,
        consoleErrorCount: 0,
        consoleWarningCount: 0,
        pageErrorCount: 0,
        apiFailureCount: 0,
        evidence: []
      },
      mobileOptimization: {
        desktop: null,
        mobile: null,
        responsiveVerdict: "blocked",
        evidence: []
      },
      contentQuality: {
        readabilityScore: null,
        readabilityLabel: "Blocked",
        wordCount: 0,
        longParagraphCount: 0,
        mediaCount: 0,
        evidence: []
      },
      cro: {
        ctaCount: 0,
        primaryCtas: [],
        formCount: 0,
        submitControlCount: 0,
        trustSignalCount: 0,
        evidence: []
      }
    });

  if (args.budgetMs < 12000) {
    return blocked(`Only ${Math.max(0, Math.round(args.budgetMs / 1000))} seconds remained for supplemental checks.`);
  }

  try {
    const siteChecksStartedAt = Date.now();
    const linkCheckReserveMs = Math.max(6000, Math.min(12000, Math.round(args.budgetMs * 0.2)));
    const perProbeTimeoutMs = Math.max(6000, Math.min(config.navigationTimeoutMs, args.budgetMs - linkCheckReserveMs));
    const [desktopCapture, mobileCapture] = await Promise.all([
      collectProbe({
        browser: args.browser,
        baseUrl: args.baseUrl,
        mobile: false,
        ignoreHttpsErrors: args.ignoreHttpsErrors,
        timezoneId: args.browserTimezone || config.deviceTimezone,
        storageState: args.storageState,
        timeoutMs: perProbeTimeoutMs
      }),
      collectProbe({
        browser: args.browser,
        baseUrl: args.baseUrl,
        mobile: true,
        ignoreHttpsErrors: args.ignoreHttpsErrors,
        timezoneId: args.browserTimezone || config.deviceTimezone,
        storageState: args.storageState,
        timeoutMs: perProbeTimeoutMs
      })
    ]);
    const captures = [desktopCapture, mobileCapture];
    const primaryCapture = choosePreferredCapture(captures);
    const headerCandidates = captures.filter((capture) => capture.probe.statusCode !== null || Object.keys(capture.headers).length > 0);
    const headerCapture = headerCandidates.length > 0 ? choosePreferredCapture(headerCandidates) : primaryCapture;
    const probeBaseUrl = isHttpUrl(primaryCapture.probe.finalUrl) ? primaryCapture.probe.finalUrl : args.baseUrl;
    const robotsUrl = new URL("/robots.txt", probeBaseUrl).toString();
    const sitemapUrl = new URL("/sitemap.xml", probeBaseUrl).toString();

    const linkProbeContext = await args.browser.newContext(
      createContextOptions({
        mobile: false,
        ignoreHttpsErrors: args.ignoreHttpsErrors,
        timezoneId: args.browserTimezone || config.deviceTimezone,
        storageState: args.storageState
      })
    );
    const linkProbePage = await linkProbeContext.newPage();
    const parserPage = await linkProbeContext.newPage();
    const linkCheckTimeoutMs = Math.max(4000, Math.min(10000, linkCheckReserveMs));
    const [robotsTxt, sitemap] = await Promise.all([
      checkUrl({
        page: linkProbePage,
        url: robotsUrl,
        timeoutMs: linkCheckTimeoutMs
      }).catch((error) => ({
        url: robotsUrl,
        ok: false,
        statusCode: null,
        note: `Request failed: ${cleanErrorMessage(error)}`
      })),
      checkUrl({
        page: linkProbePage,
        url: sitemapUrl,
        timeoutMs: linkCheckTimeoutMs
      }).catch((error) => ({
        url: sitemapUrl,
        ok: false,
        statusCode: null,
        note: `Request failed: ${cleanErrorMessage(error)}`
      }))
    ]);

    const sampleLinks = uniqueItems(
      [...desktopCapture.probe.internalLinkSamples, ...mobileCapture.probe.internalLinkSamples].filter((url) => isHttpUrl(url)),
      8
    );
    const brokenLinkChecks = await Promise.all(
      sampleLinks.map((url) =>
        checkUrl({
          page: linkProbePage,
          url,
          timeoutMs: Math.max(4000, Math.min(7000, linkCheckTimeoutMs))
        })
      )
    );
    const crawlBudgetMs = Math.max(0, args.budgetMs - (Date.now() - siteChecksStartedAt));
    const crawlDeadline = Date.now() + Math.max(0, Math.min(20000, crawlBudgetMs));
    const seoCrawl =
      crawlDeadline - Date.now() >= 3000
        ? await crawlSeoSite({
            requestPage: linkProbePage,
            parserPage,
            seedUrl: probeBaseUrl,
            requestTimeoutMs: Math.max(2500, Math.min(6000, linkCheckTimeoutMs)),
            deadline: crawlDeadline
          })
        : buildEmptySeoCrawlResult();
    await parserPage.close().catch(() => undefined);
    await linkProbeContext.close().catch(() => undefined);

    const brokenLinks = brokenLinkChecks.filter((check) => !check.ok);
    const consoleErrorCount = args.rawEvents.filter(
      (event) => typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "console" && /error/i.test(String((event as Record<string, unknown>).level ?? ""))
    ).length;
    const consoleWarningCount = args.rawEvents.filter(
      (event) => typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "console" && /warn/i.test(String((event as Record<string, unknown>).level ?? ""))
    ).length;
    const pageErrorCount = args.rawEvents.filter(
      (event) => typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "pageerror"
    ).length;
    const requestFailures = args.rawEvents.filter(
      (event) => typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "requestfailed"
    ) as Array<Record<string, unknown>>;
    const navigationErrorCount = args.rawEvents.filter(
      (event) => typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "navigation_error"
    ).length;
    const stalledInteractionCount = args.taskResults.reduce(
      (sum, task) =>
        sum +
        task.history.filter((entry) => !entry.result.success || /no clear visible change|timeout|unchanged page states/i.test(entry.result.note)).length,
      0
    );
    const imageFailureCount = requestFailures.filter((event) => IMAGE_URL_PATTERN.test(String(event.url ?? "")) || /\/images?\//i.test(String(event.url ?? ""))).length;
    const apiFailureCount = requestFailures.filter((event) => API_URL_PATTERN.test(String(event.url ?? ""))).length;
    const framework = detectFramework(primaryCapture.html || desktopCapture.html || mobileCapture.html, headerCapture.headers);
    const primaryHasDomEvidence = hasProbeDomEvidence(primaryCapture.probe);
    const primaryHasPerformanceEvidence = hasPerformanceEvidence(primaryCapture.probe);
    const resolvedSecurityUrl = isHttpUrl(headerCapture.probe.finalUrl)
      ? headerCapture.probe.finalUrl
      : isHttpUrl(primaryCapture.probe.finalUrl)
        ? primaryCapture.probe.finalUrl
        : args.baseUrl;

    const securityHeaders = SECURITY_HEADERS.map((name) => {
      const rawValue = headerCapture.headers[name] ?? headerCapture.headers[name.toLowerCase()] ?? null;
      return {
        name,
        present: Boolean(rawValue),
        value: rawValue,
        note: rawValue ? `Present with value '${rawValue}'.` : "Missing from the main document response."
      };
    });
    const missingHeaders = securityHeaders.filter((header) => !header.present).map((header) => header.name);

    const desktopHasDomEvidence = hasProbeDomEvidence(desktopCapture.probe);
    const mobileHasDomEvidence = hasProbeDomEvidence(mobileCapture.probe);
    const desktopHasPerformanceEvidence = hasPerformanceEvidence(desktopCapture.probe);
    const mobileHasPerformanceEvidence = hasPerformanceEvidence(mobileCapture.probe);
    const primaryHasContentEvidence = hasContentEvidence(primaryCapture.probe);
    const primaryHasCroEvidence = hasCroEvidence(primaryCapture.probe);
    const interactionEvidenceAvailable = args.taskResults.some((task) => task.history.length > 0);
    const responsiveVerdict =
      !mobileHasDomEvidence
        ? "blocked"
        : mobileCapture.probe.horizontalOverflow || mobileCapture.probe.tapTargetIssueCount >= 3 || mobileCapture.probe.smallTextIssueCount >= 6
          ? "poor"
          : mobileCapture.probe.tapTargetIssueCount > 0 || mobileCapture.probe.smallTextIssueCount > 0
            ? "mixed"
            : "responsive";

    const performanceCoverageStatus: CoverageNote["status"] =
      desktopHasPerformanceEvidence || mobileHasPerformanceEvidence ? "verified" : "blocked";
    const seoCoverageStatus: CoverageNote["status"] =
      primaryCapture.probe.loadOk || primaryHasDomEvidence || robotsTxt.ok || sitemap.ok || seoCrawl.crawlSummary.totalPagesAudited > 0
        ? "verified"
        : "blocked";
    const securityCoverageStatus: CoverageNote["status"] =
      headerCapture.probe.loadOk || headerCapture.probe.statusCode !== null || Object.keys(headerCapture.headers).length > 0
        ? "verified"
        : "blocked";
    const uiuxCoverageStatus: CoverageNote["status"] = desktopHasDomEvidence || mobileHasDomEvidence || interactionEvidenceAvailable ? "verified" : "blocked";
    const mobileCoverageStatus: CoverageNote["status"] = mobileHasDomEvidence || mobileHasPerformanceEvidence ? "verified" : "blocked";
    const contentCoverageStatus: CoverageNote["status"] = primaryCapture.probe.loadOk || primaryHasContentEvidence ? "verified" : "blocked";
    const croCoverageStatus: CoverageNote["status"] =
      primaryCapture.probe.loadOk || primaryHasCroEvidence || interactionEvidenceAvailable ? "verified" : "blocked";

    const siteChecks = SiteChecksSchema.parse({
      generatedAt: new Date().toISOString(),
      baseUrl: args.baseUrl,
      finalResolvedUrl: isHttpUrl(primaryCapture.probe.finalUrl)
        ? primaryCapture.probe.finalUrl
        : isHttpUrl(desktopCapture.probe.finalUrl)
          ? desktopCapture.probe.finalUrl
          : isHttpUrl(mobileCapture.probe.finalUrl)
            ? mobileCapture.probe.finalUrl
            : null,
      coverage: {
        performance: buildCoverage(
          performanceCoverageStatus,
          performanceCoverageStatus === "verified"
            ? "Performance was verified from direct desktop and mobile probe measurements plus saved runtime request failures."
            : "Performance probing was blocked because no direct probe measurements were captured in the supplemental check.",
          [
            desktopCapture.probe.note,
            mobileCapture.probe.note,
            navigationErrorCount > 0 ? `${navigationErrorCount} navigation error(s) were recorded during the main run.` : ""
          ],
          performanceCoverageStatus === "blocked" ? [desktopCapture.probe.note] : []
        ),
        seo: buildCoverage(
          seoCoverageStatus,
          seoCoverageStatus === "verified"
            ? "SEO was verified from the live page metadata, a same-origin HTML crawl, direct robots and sitemap fetches, and sampled internal-link checks."
            : "SEO checks were blocked because no direct crawl or metadata evidence was captured.",
          [
            primaryCapture.probe.h1Count > 0 ? `Detected ${primaryCapture.probe.h1Count} H1 heading(s).` : "No H1 heading was detected.",
            robotsTxt.note,
            sitemap.note,
            ...seoCrawl.evidence,
            brokenLinks.length > 0 ? `${brokenLinks.length} sampled internal link(s) failed.` : "Sampled internal links responded successfully."
          ],
          seoCoverageStatus === "blocked" ? [primaryCapture.probe.note] : []
        ),
        uiux: buildCoverage(
          uiuxCoverageStatus,
          uiuxCoverageStatus === "verified"
            ? "UI and UX findings were verified from the interaction audit plus direct desktop and mobile page probes."
            : "UI and UX checks were blocked because the run did not retain enough interaction or page evidence.",
          uniqueItems(
            [
              desktopCapture.probe.note,
              mobileCapture.probe.note,
              interactionEvidenceAvailable ? `${args.taskResults.length} task path(s) contributed direct interaction evidence.` : "",
              desktopCapture.probe.horizontalOverflow ? "The desktop viewport showed horizontal overflow." : "",
              mobileCapture.probe.horizontalOverflow ? "The mobile viewport showed horizontal overflow." : ""
            ],
            4
          ),
          uiuxCoverageStatus === "blocked" ? [desktopCapture.probe.note || mobileCapture.probe.note || "Interaction evidence was unavailable."] : []
        ),
        security: buildCoverage(
          securityCoverageStatus,
          securityCoverageStatus === "verified"
            ? "Security was verified from HTTPS transport status and sampled response headers."
            : "Security checks were blocked because the main document response could not be verified.",
          [
            headerCapture.probe.note,
            missingHeaders.length > 0 ? `${missingHeaders.length} recommended security header(s) were missing.` : "All sampled security headers were present."
          ],
          securityCoverageStatus === "blocked" ? [headerCapture.probe.note] : []
        ),
        technicalHealth: buildCoverage(
          "verified",
          "Technical health was verified from console, page error, request failure, and framework fingerprint signals.",
          [
            consoleErrorCount > 0 ? `${consoleErrorCount} console error(s) were captured.` : "No console errors were captured.",
            pageErrorCount > 0 ? `${pageErrorCount} page error(s) were captured.` : "No page errors were captured.",
            framework ? `Detected likely framework: ${framework}.` : "The framework could not be confidently fingerprinted from the page source."
          ]
        ),
        mobileOptimization: buildCoverage(
          mobileCoverageStatus,
          mobileCoverageStatus === "verified"
            ? "Mobile optimization was verified using direct evidence from the dedicated mobile viewport probe."
            : "Mobile optimization was blocked because the dedicated mobile probe did not capture direct evidence.",
          [
            mobileCapture.probe.note,
            mobileCapture.probe.horizontalOverflow ? "Horizontal overflow was detected on mobile." : "No horizontal overflow was detected on mobile.",
            mobileCapture.probe.tapTargetIssueCount > 0
              ? `${mobileCapture.probe.tapTargetIssueCount} undersized tap target(s) were detected on mobile.`
              : "Tap target sizing cleared the 44px threshold on mobile."
          ],
          mobileCoverageStatus === "blocked" ? [mobileCapture.probe.note] : []
        ),
        contentQuality: buildCoverage(
          contentCoverageStatus,
          contentCoverageStatus === "verified"
            ? "Content quality was verified from live page copy, readability, structure, and media counts."
            : "Content-quality checks were blocked because the probe did not capture direct content evidence.",
          [
            primaryCapture.probe.readabilityScore !== null
              ? `Readability scored ${primaryCapture.probe.readabilityScore} (${primaryCapture.probe.readabilityLabel}).`
              : "Readability could not be scored from the available page text.",
            primaryCapture.probe.wordCount > 0 ? `The page exposed about ${primaryCapture.probe.wordCount} visible words.` : "Very little visible copy was available."
          ],
          contentCoverageStatus === "blocked" ? [primaryCapture.probe.note] : []
        ),
        cro: buildCoverage(
          croCoverageStatus,
          croCoverageStatus === "verified"
            ? "CRO was verified from visible CTAs, forms, trust cues, and the interaction audit."
            : "CRO checks were blocked because the run did not capture direct conversion evidence.",
          [
            primaryCapture.probe.ctaSamples.length > 0 ? `Detected CTA labels such as ${primaryCapture.probe.ctaSamples.slice(0, 3).join(", ")}.` : "No strong CTA labels were detected on the sampled page.",
            primaryCapture.probe.formCount > 0 ? `Detected ${primaryCapture.probe.formCount} form(s).` : "No forms were detected on the sampled page.",
            interactionEvidenceAvailable ? `${args.taskResults.length} task path(s) contributed interaction evidence for conversion analysis.` : ""
          ],
          croCoverageStatus === "blocked" ? [primaryCapture.probe.note || "Direct conversion evidence was unavailable."] : []
        )
      },
      performance: {
        desktop: desktopCapture.probe,
        mobile: mobileCapture.probe,
        failedRequestCount: requestFailures.length,
        imageFailureCount,
        apiFailureCount,
        navigationErrorCount,
        stalledInteractionCount,
        evidence: uniqueItems(
          [
            desktopCapture.probe.performance.domContentLoadedMs !== null
              ? `Desktop DOM content loaded in ${Math.round(desktopCapture.probe.performance.domContentLoadedMs)}ms.`
              : "",
            mobileCapture.probe.performance.domContentLoadedMs !== null
              ? `Mobile DOM content loaded in ${Math.round(mobileCapture.probe.performance.domContentLoadedMs)}ms.`
              : "",
            requestFailures.length > 0 ? `${requestFailures.length} failed request(s) were recorded.` : "No failed requests were recorded during the main run."
          ],
          4
        )
      },
      seo: {
        robotsTxt,
        sitemap,
        brokenLinkCount: brokenLinks.length,
        checkedLinkCount: sampleLinks.length,
        brokenLinks,
        crawlSummary: seoCrawl.crawlSummary,
        pageStats: seoCrawl.pageStats,
        auditedPages: seoCrawl.auditedPages,
        evidence: uniqueItems(
          [
            primaryCapture.probe.metaDescription ? "A meta description was present on the sampled page." : "The sampled page did not expose a meta description.",
            primaryCapture.probe.structuredDataCount > 0
              ? `Detected ${primaryCapture.probe.structuredDataCount} structured-data block(s).`
              : "No structured-data blocks were detected on the sampled page.",
            robotsTxt.note,
            sitemap.note,
            ...seoCrawl.evidence
          ],
          7
        )
      },
      security: {
        https: resolvedSecurityUrl.startsWith("https://"),
        secureTransportVerified: resolvedSecurityUrl.startsWith("https://") && (headerCapture.probe.loadOk || headerCapture.probe.statusCode !== null),
        initialStatusCode: headerCapture.probe.statusCode,
        securityHeaders,
        missingHeaders,
        evidence: uniqueItems(
          [
            resolvedSecurityUrl.startsWith("https://")
              ? "The sampled page loaded over HTTPS."
              : "The sampled page did not load over HTTPS.",
            missingHeaders.length > 0 ? `Missing security headers: ${missingHeaders.join(", ")}.` : "All sampled security headers were present on the main document response."
          ],
          4
        )
      },
      technicalHealth: {
        framework,
        consoleErrorCount,
        consoleWarningCount,
        pageErrorCount,
        apiFailureCount,
        evidence: uniqueItems(
          [
            framework ? `Detected likely framework: ${framework}.` : "The framework could not be confidently detected from the sampled markup.",
            consoleErrorCount > 0 ? `${consoleErrorCount} console error(s) were captured.` : "No console errors were captured.",
            apiFailureCount > 0 ? `${apiFailureCount} API-like request failure(s) were captured.` : "No API-like request failures were captured."
          ],
          5
        )
      },
      mobileOptimization: {
        desktop: desktopCapture.probe,
        mobile: mobileCapture.probe,
        responsiveVerdict,
        evidence: uniqueItems(
          [
            mobileCapture.probe.horizontalOverflow ? "The mobile viewport overflowed horizontally." : "The mobile viewport stayed within the viewport width.",
            mobileCapture.probe.smallTextIssueCount > 0
              ? `${mobileCapture.probe.smallTextIssueCount} small-text issue(s) were detected on mobile.`
              : "Text sizing stayed above the small-text threshold on mobile.",
            mobileCapture.probe.tapTargetIssueCount > 0
              ? `${mobileCapture.probe.tapTargetIssueCount} tap target issue(s) were detected on mobile.`
              : "Tap target sizing cleared the minimum touch target threshold on mobile."
          ],
          5
        )
      },
      contentQuality: {
        readabilityScore: primaryCapture.probe.readabilityScore,
        readabilityLabel: primaryCapture.probe.readabilityLabel,
        wordCount: primaryCapture.probe.wordCount,
        longParagraphCount: primaryCapture.probe.longParagraphCount,
        mediaCount: primaryCapture.probe.mediaCount,
        evidence: uniqueItems(
          [
            primaryCapture.probe.readabilityScore !== null
              ? `Readability score: ${primaryCapture.probe.readabilityScore} (${primaryCapture.probe.readabilityLabel}).`
              : "Readability could not be scored from the sampled page text.",
            primaryCapture.probe.longParagraphCount > 0
              ? `${primaryCapture.probe.longParagraphCount} long paragraph(s) were detected.`
              : "No unusually long paragraphs were detected in the sampled page text.",
            primaryCapture.probe.mediaCount > 0 ? `Detected ${primaryCapture.probe.mediaCount} media element(s).` : "No media elements were detected."
          ],
          5
        )
      },
      cro: {
        ctaCount: primaryCapture.probe.ctaSamples.length,
        primaryCtas: primaryCapture.probe.ctaSamples,
        formCount: primaryCapture.probe.formCount,
        submitControlCount: primaryCapture.probe.submitControlCount,
        trustSignalCount: primaryCapture.probe.trustSignalCount,
        evidence: uniqueItems(
          [
            primaryCapture.probe.ctaSamples.length > 0
              ? `Visible CTA labels included ${primaryCapture.probe.ctaSamples.slice(0, 4).join(", ")}.`
              : "No clear high-intent CTA labels were detected on the sampled page.",
            primaryCapture.probe.trustSignalCount > 0
              ? `Detected ${primaryCapture.probe.trustSignalCount} trust-signal keyword match(es).`
              : "Trust-signal text was light on the sampled page.",
            primaryCapture.probe.formCount > 0
              ? `Detected ${primaryCapture.probe.formCount} form(s) with ${primaryCapture.probe.submitControlCount} submit control(s).`
              : "No forms were detected on the sampled page."
          ],
          5
        )
      }
    });

    return siteChecks;
  } catch (error) {
    return blocked(`Supplemental checks failed: ${cleanErrorMessage(error)}`);
  }
}
