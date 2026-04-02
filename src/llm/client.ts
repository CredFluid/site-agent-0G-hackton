import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { config } from "../config.js";

export const openai = new OpenAI({ apiKey: config.openaiApiKey });

export async function generateStructured<T>(options: {
  model?: string;
  systemPrompt: string;
  userPayload: unknown;
  schemaName: string;
  schema: Parameters<typeof zodTextFormat>[0];
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<T> {
  const response = await openai.responses.parse({
    model: options.model ?? config.model,
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
  }, {
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
  });

  return response.output_parsed as T;
}
