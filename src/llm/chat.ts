import OpenAI from "openai";
import type { Config } from "../config.js";
import type { ChatMessage } from "./prompt.js";

export interface ChatModel {
  readonly name: string;
  complete(messages: ChatMessage[], options: { json: boolean; signal?: AbortSignal }): Promise<string>;
}

export function createClient(config: Config, maxRetries = 2): OpenAI {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, timeout: 45_000, maxRetries });
}

export class OpenAICompatibleChat implements ChatModel {
  constructor(
    private readonly client: OpenAI,
    readonly name: string,
    private readonly reasoningEffort?: OpenAI.Chat.Completions.ChatCompletionReasoningEffort
  ) {}

  async complete(messages: ChatMessage[], options: { json: boolean; signal?: AbortSignal }): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.name,
      messages,
      max_completion_tokens: 2048,
      ...(options.json ? { response_format: { type: "json_object" as const } } : {}),
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {})
    }, { signal: options.signal });
    return completion.choices[0]?.message.content ?? "";
  }
}

export function describeModelError(error: unknown): string {
  let message = "The model request failed. Try again shortly.";
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    message = "The model provider did not respond in time. It may be overloaded; try again shortly.";
  } else if (error instanceof OpenAI.APIConnectionError) {
    message = "Could not reach the model provider. Check your network and LLM_BASE_URL.";
  } else if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const hint = status === 401 || status === 403 ? "Check LLM_API_KEY and LLM_BASE_URL."
      : status === 404 ? "Check that LLM_MODEL exists for this provider."
        : status === 429 ? "Rate limit or quota reached. Wait a minute and try again."
          : status !== undefined && status >= 500 ? "The provider is overloaded or unavailable. Try again shortly."
            : "The provider rejected the request.";
    message = `Model provider request failed (HTTP ${status ?? "unknown"}). ${hint}`;
  }
  return message;
}
