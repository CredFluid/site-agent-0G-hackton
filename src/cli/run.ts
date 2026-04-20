import path from "node:path";
import { Command } from "commander";
import { authSettings, resolveAuthSessionStatePath } from "../auth/profile.js";
import { runAuthFlow } from "../auth/runner.js";
import { config, resolveLlmRuntime, type LlmProvider } from "../config.js";
import { buildCustomTaskSuite } from "../core/customTaskSuite.js";
import { runAuditJob } from "../core/runAuditJob.js";
import { normalizeCustomTasks, SUBMISSION_TASKS_REQUIRED_MESSAGE } from "../submissions/customTasks.js";
import { resolveRunDir } from "../utils/files.js";
import { info } from "../utils/log.js";

const program = new Command();

function summarizeCliPath(filePath: string): string {
  const relativePath = path.relative(process.cwd(), filePath);
  return relativePath && relativePath !== "" && !relativePath.startsWith("..") ? relativePath : filePath;
}

function resolveMaybeUrl(baseUrl: string, value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return new URL(trimmed, baseUrl).toString();
}

function collectRepeatedOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseLlmProvider(value: string): LlmProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "ollama") {
    return normalized;
  }

  throw new Error(`Unsupported LLM provider '${value}'. Use 'openai' or 'ollama'.`);
}

program
  .name("site-agent-pro")
  .description("Run accepted website tasks like a realistic user and generate an evidence-based task output")
  .requiredOption("--url <url>", "Website URL to test")
  .option("--headed", "Run browser in headed mode")
  .option("--mobile", "Run using a mobile device profile")
  .option("--ignore-https-errors", "Allow invalid or self-signed HTTPS certificates")
  .option("--storage-state <path>", "Load Playwright storage state JSON before the run")
  .option("--save-storage-state <path>", "Save Playwright storage state JSON after the run")
  .option("--task <task>", "Accepted task for the agent to perform. Repeat for multiple tasks.", collectRepeatedOption, [])
  .option("--llm-provider <provider>", "LLM provider to use: openai or ollama")
  .option("--model <model>", "Override the model name for the selected LLM provider")
  .option("--ollama-base-url <url>", "Override the Ollama base URL")
  .option("--auth-flow", "Create or verify a test account, log in, save session state, then continue the accepted tasks behind auth")
  .option("--auth-only", "Run only the signup/verification/login bootstrap and save session state")
  .option("--signup-url <url>", "Absolute or relative signup URL to use during auth bootstrap")
  .option("--login-url <url>", "Absolute or relative login URL to use during auth bootstrap")
  .option("--access-url <url>", "Absolute or relative protected URL to verify after login")
  .action(async (options: {
    url: string;
    headed?: boolean;
    mobile?: boolean;
    ignoreHttpsErrors?: boolean;
    storageState?: string;
    saveStorageState?: string;
    task?: string[];
    llmProvider?: string;
    model?: string;
    ollamaBaseUrl?: string;
    authFlow?: boolean;
    authOnly?: boolean;
    signupUrl?: string;
    loginUrl?: string;
    accessUrl?: string;
  }) => {
    const baseUrl = options.url as string;
    const storageStatePath = options.storageState?.trim() ? path.resolve(options.storageState) : undefined;
    const saveStorageStatePath = options.saveStorageState?.trim() ? path.resolve(options.saveStorageState) : undefined;
    const configuredStorageStatePath = config.playwrightStorageStatePath
      ? path.resolve(config.playwrightStorageStatePath)
      : undefined;
    const effectiveStorageStatePath = storageStatePath ?? configuredStorageStatePath;
    const authRequested = Boolean(options.authFlow) || Boolean(options.authOnly);
    const authOnly = Boolean(options.authOnly);
    const acceptedTasks = normalizeCustomTasks(options.task ?? []);
    const suiteOverride = !authOnly
      ? (() => {
          if (acceptedTasks.length === 0) {
            throw new Error(`${SUBMISSION_TASKS_REQUIRED_MESSAGE} Use --task \"...\" one or more times for CLI runs.`);
          }

          return buildCustomTaskSuite(acceptedTasks);
        })()
      : undefined;
    const signupUrl = resolveMaybeUrl(baseUrl, options.signupUrl ?? authSettings.signupUrl);
    const loginUrl = resolveMaybeUrl(baseUrl, options.loginUrl ?? authSettings.loginUrl);
    const accessUrl = resolveMaybeUrl(baseUrl, options.accessUrl ?? authSettings.accessUrl);
    const llmRuntime = resolveLlmRuntime({
      ...(options.llmProvider ? { provider: parseLlmProvider(options.llmProvider) } : {}),
      ...(options.model?.trim() ? { model: options.model.trim() } : {}),
      ...(options.ollamaBaseUrl?.trim() ? { ollamaBaseUrl: options.ollamaBaseUrl.trim() } : {})
    });

    info(`Running site agent against ${baseUrl}`);
    info(`Total run budget is capped at ${Math.round(config.maxSessionDurationMs / 1000)} seconds`);
    info(
      llmRuntime.provider === "ollama"
        ? `Using Ollama model ${llmRuntime.model} via ${llmRuntime.ollamaBaseUrl}`
        : `Using OpenAI model ${llmRuntime.model}`
    );
    if (!authOnly) {
      info(`Using ${acceptedTasks.length} accepted task${acceptedTasks.length === 1 ? "" : "s"} from explicit input`);
    }
    if (options.ignoreHttpsErrors) {
      info("Ignoring HTTPS certificate errors for this run");
    }
    if (effectiveStorageStatePath) {
      info(`Loading Playwright storage state from ${summarizeCliPath(effectiveStorageStatePath)}`);
    }
    if (saveStorageStatePath) {
      info(`Will save Playwright storage state to ${summarizeCliPath(saveStorageStatePath)}`);
    }

    if (authRequested) {
      const runDir = resolveRunDir(baseUrl);
      const authSessionStatePath = saveStorageStatePath ?? configuredStorageStatePath ?? resolveAuthSessionStatePath();

      info(`Auth bootstrap is enabled${authOnly ? " in auth-only mode" : ""}`);
      info(`Authenticated storage state will be saved to ${summarizeCliPath(authSessionStatePath)}`);
      if (signupUrl) {
        info(`Using signup URL ${signupUrl}`);
      }
      if (loginUrl) {
        info(`Using login URL ${loginUrl}`);
      }
      if (accessUrl) {
        info(`Using protected access URL ${accessUrl}`);
      }

      const authResult = await runAuthFlow({
        baseUrl,
        runDir,
        signupUrl,
        loginUrl,
        accessUrl,
        headed: Boolean(options.headed),
        mobile: Boolean(options.mobile),
        ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors),
        saveStorageStatePath: authSessionStatePath
      });

      info(`Auth bootstrap finished with status: ${authResult.status}`);
      info(`Auth artifacts were written to ${path.join(runDir, "auth-flow.json")}`);

      if (authOnly) {
        info(`Authenticated session is ready at ${summarizeCliPath(authSessionStatePath)}`);
        return;
      }

      if (authResult.status === "failed") {
        throw new Error("Auth bootstrap failed before the audit could start.");
      }

      const result = await runAuditJob({
        baseUrl,
        runDir,
        suiteOverride: suiteOverride!,
        headed: Boolean(options.headed),
        mobile: Boolean(options.mobile),
        ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors),
        storageStatePath: authSessionStatePath,
        saveStorageStatePath: authSessionStatePath,
        extraInputs: {
          customTasks: acceptedTasks,
          instructionText: acceptedTasks.join("\n"),
          instructionFileName: null,
          authBootstrapEnabled: true,
          authAccessConfirmed: authResult.accessConfirmed,
          authVerificationMethod: authResult.verificationMethod,
          ...(signupUrl ? { authSignupUrl: signupUrl } : {}),
          ...(loginUrl ? { authLoginUrl: loginUrl } : {}),
          ...(accessUrl ? { authAccessUrl: accessUrl } : {})
        },
        llmProvider: llmRuntime.provider,
        model: llmRuntime.model,
        ollamaBaseUrl: llmRuntime.ollamaBaseUrl
      });

      info(`Artifacts will be written to ${result.runDir}`);
      info(`Completed. Overall score: ${result.report.overall_score}/10`);
      info(`Task summary: ${result.report.summary}`);
      return;
    }

    const result = await runAuditJob({
      baseUrl,
      suiteOverride: suiteOverride!,
      headed: Boolean(options.headed),
      mobile: Boolean(options.mobile),
      ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors),
      storageStatePath,
      saveStorageStatePath,
      extraInputs: {
        customTasks: acceptedTasks,
        instructionText: acceptedTasks.join("\n"),
        instructionFileName: null
      },
      llmProvider: llmRuntime.provider,
      model: llmRuntime.model,
      ollamaBaseUrl: llmRuntime.ollamaBaseUrl
    });

    info(`Artifacts will be written to ${result.runDir}`);
    info(`Completed. Overall score: ${result.report.overall_score}/10`);
    info(`Task summary: ${result.report.summary}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`[ERROR] ${message}\n`);
  process.exit(1);
});
