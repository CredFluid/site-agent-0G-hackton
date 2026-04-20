import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { toJSONSchema, type ZodType } from "zod";
import { config, resolveLlmRuntime, type LlmProvider } from "../config.js";

export type LlmRuntimeOptions = {
  provider?: LlmProvider;
  model?: string;
  ollamaBaseUrl?: string;
};

function getOpenAIClient(): OpenAI {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required when the selected LLM provider is openai.");
  }

  return new OpenAI({ apiKey: config.openaiApiKey });
}

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown LLM error";
}

function stripJsonCodeFence(value: string): string {
  const trimmed = value.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch?.[1]?.trim() ?? trimmed;
}

async function generateWithOpenAI<T>(options: {
  model: string;
  systemPrompt: string;
  userPayload: unknown;
  schemaName: string;
  schema: ZodType<T>;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<T> {
  const response = await getOpenAIClient().responses.parse(
    {
      model: options.model,
      input: [
        { role: "system", content: options.systemPrompt },
        {
          role: "user",
          content: JSON.stringify(options.userPayload, null, 2)
        }
      ],
      text: {
        format: zodTextFormat(options.schema, options.schemaName)
      }
    },
    {
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
    }
  );

  return options.schema.parse(response.output_parsed);
}

async function requestOllama<T>(options: {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPayload: unknown;
  schema: ZodType<T>;
  timeoutMs?: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId =
    options.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(new Error(`Ollama request timed out after ${options.timeoutMs}ms.`)), options.timeoutMs)
      : null;

  try {
    const response = await fetch(new URL("/api/chat", options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: JSON.stringify(options.userPayload, null, 2) }
        ],
        stream: false,
        format: toJSONSchema(options.schema),
        options: {
          temperature: 0
        }
      }),
      signal: controller.signal
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Ollama request failed with ${response.status} ${response.statusText}: ${responseText.slice(0, 400)}`);
    }

    const parsedResponse = JSON.parse(responseText) as {
      error?: string;
      message?: {
        content?: string;
      };
    };

    if (parsedResponse.error) {
      throw new Error(`Ollama returned an error: ${parsedResponse.error}`);
    }

    const rawContent = parsedResponse.message?.content?.trim() ?? "";
    if (!rawContent) {
      throw new Error("Ollama returned an empty message content.");
    }

    return options.schema.parse(JSON.parse(stripJsonCodeFence(rawContent)));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(options.timeoutMs !== undefined ? `Ollama request timed out after ${options.timeoutMs}ms.` : "Ollama request timed out.");
    }

    throw error;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

async function generateWithOllama<T>(options: {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPayload: unknown;
  schema: ZodType<T>;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<T> {
  const maxAttempts = 1 + Math.max(0, options.maxRetries ?? 0);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestOllama(options);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }

  throw new Error(cleanErrorMessage(lastError));
}

export async function generateStructured<T>(options: {
  provider?: LlmProvider;
  model?: string;
  ollamaBaseUrl?: string;
  systemPrompt: string;
  userPayload: unknown;
  schemaName: string;
  schema: ZodType<T>;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<T> {
  const runtime = resolveLlmRuntime({
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.ollamaBaseUrl ? { ollamaBaseUrl: options.ollamaBaseUrl } : {})
  });

  if (runtime.provider === "ollama") {
    return generateWithOllama({
      baseUrl: runtime.ollamaBaseUrl,
      model: runtime.model,
      systemPrompt: options.systemPrompt,
      userPayload: options.userPayload,
      schema: options.schema,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
    });
  }

  return generateWithOpenAI({
    model: runtime.model,
    systemPrompt: options.systemPrompt,
    userPayload: options.userPayload,
    schemaName: options.schemaName,
    schema: options.schema,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
  });
}
