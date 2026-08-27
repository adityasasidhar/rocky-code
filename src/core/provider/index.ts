import {
  defaultApiKeyEnv,
  defaultBaseUrl,
  type ProviderConfig,
} from "../../config/schema.ts";
import type { Provider } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatibleProvider } from "./openai.ts";

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export type Env = Record<string, string | undefined>;

/**
 * Build a provider from config. The only place that knows which kinds exist.
 *
 * An API key is never *required* here: the Anthropic SDK can resolve an
 * `ant auth login` profile, and local servers need no auth at all. Missing
 * credentials surface as an auth error at request time, with a hint.
 */
export function createProvider(cfg: ProviderConfig, env: Env = process.env): Provider {
  const keyEnv = cfg.apiKeyEnv ?? defaultApiKeyEnv(cfg.kind);
  const apiKey = keyEnv ? env[keyEnv] : undefined;
  const baseUrl = cfg.baseUrl ?? defaultBaseUrl(cfg.kind);

  switch (cfg.kind) {
    case "anthropic":
      return new AnthropicProvider({
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });

    case "openai":
      return new OpenAICompatibleProvider({
        baseUrl: baseUrl!,
        ...(apiKey ? { apiKey } : {}),
        ...(cfg.contextWindow ? { contextWindow: cfg.contextWindow } : {}),
        ...(cfg.pricing ? { pricing: cfg.pricing } : {}),
        useMaxCompletionTokens: true,
        sendReasoningEffort: cfg.reasoningEffort,
        name: "openai",
      });

    case "openai-compatible":
      if (!baseUrl) {
        throw new ProviderConfigError(
          'provider.kind "openai-compatible" requires provider.baseUrl ' +
            '(e.g. "http://127.0.0.1:8080/v1" for llama.cpp).',
        );
      }
      return new OpenAICompatibleProvider({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(cfg.contextWindow ? { contextWindow: cfg.contextWindow } : {}),
        ...(cfg.pricing ? { pricing: cfg.pricing } : {}),
        // Older compatible servers only understand max_tokens.
        useMaxCompletionTokens: false,
        sendReasoningEffort: cfg.reasoningEffort,
        name: "openai-compatible",
      });

    case "minimax":
      return new OpenAICompatibleProvider({
        baseUrl: baseUrl!,
        ...(apiKey ? { apiKey } : {}),
        ...(cfg.contextWindow ? { contextWindow: cfg.contextWindow } : {}),
        ...(cfg.pricing ? { pricing: cfg.pricing } : {}),
        // MiniMax's compatible API accepts the legacy max_tokens field.
        useMaxCompletionTokens: false,
        sendReasoningEffort: false,
        name: "minimax",
      });

    case "ollama":
      return new OllamaProvider({
        baseUrl: baseUrl!,
        ...(cfg.contextWindow ? { contextWindow: cfg.contextWindow } : {}),
        // Omitted rather than defaulted, so `prepare()` can decide.
        ...(cfg.think === undefined ? {} : { think: cfg.think }),
      });
  }
}

export { AnthropicProvider, OllamaProvider, OpenAICompatibleProvider };
