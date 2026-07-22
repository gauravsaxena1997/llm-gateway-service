import { env } from '../config/env.js'
import { logger } from '../logger.js'
import type { EmbedRequestBody, EmbedResponse, InferRequestBody, InferResponse } from '../types.js'

let currentKeyIndex = 0
const keyCooldownUntil = new Map<number, number>()
const rejectedKeyUntil = new Map<number, number>()
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000
const INVALID_KEY_COOLDOWN_MS = 15 * 60_000

interface SelectedKey {
  key: string
  index: number
}

interface OllamaChatResponse {
  done?: boolean
  error?: string
  eval_count?: number
  message?: {
    content?: string
  }
  prompt_eval_count?: number
}

interface OllamaEmbedResponse {
  embeddings?: unknown
  error?: string
}

export class OllamaProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'OllamaProviderError'
  }
}

function nextAvailableKey(): SelectedKey | null {
  const now = Date.now()
  for (let offset = 0; offset < env.ollamaApiKeys.length; offset += 1) {
    const index = (currentKeyIndex + offset) % env.ollamaApiKeys.length
    const cooldownUntil = Math.max(keyCooldownUntil.get(index) ?? 0, rejectedKeyUntil.get(index) ?? 0)
    if (cooldownUntil <= now) {
      currentKeyIndex = (index + 1) % env.ollamaApiKeys.length
      return { key: env.ollamaApiKeys[index], index }
    }
  }
  return null
}

function allKeysRejected(): boolean {
  const now = Date.now()
  return env.ollamaApiKeys.length > 0 && env.ollamaApiKeys.every((_, index) => (rejectedKeyUntil.get(index) ?? 0) > now)
}

function retryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RATE_LIMIT_COOLDOWN_MS
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 15 * 60_000)
  const retryAt = Date.parse(header)
  if (Number.isFinite(retryAt)) return Math.min(Math.max(retryAt - Date.now(), 1_000), 15 * 60_000)
  return DEFAULT_RATE_LIMIT_COOLDOWN_MS
}

function allKeysCooldownDelayMs(): number {
  const now = Date.now()
  const delays = env.ollamaApiKeys
    .map((_, index) => (keyCooldownUntil.get(index) ?? now) - now)
    .filter((delay) => delay > 0)
  return delays.length > 0 ? Math.min(...delays) : DEFAULT_RATE_LIMIT_COOLDOWN_MS
}

function shouldTryAnotherKey(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

function applyKeyCooldown(status: number, index: number, retryAfterHeader: string | null): number | undefined {
  if (status === 429) {
    const delayMs = retryAfterMs(retryAfterHeader)
    keyCooldownUntil.set(index, Date.now() + delayMs)
    return delayMs
  }
  if (status === 401 || status === 403) {
    rejectedKeyUntil.set(index, Date.now() + INVALID_KEY_COOLDOWN_MS)
  }
  return undefined
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), timeoutMs)
  return controller.signal
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveModel(requestedModel?: string): string {
  const model = requestedModel || env.ollamaModel
  if (!env.ollamaAllowedModels.includes(model)) {
    throw new OllamaProviderError(`Ollama model is not allowed: ${model}`, 400, false)
  }
  return model
}

function resolveEmbeddingModel(requestedModel?: string): string {
  const model = requestedModel || env.ollamaEmbeddingModel
  if (!env.ollamaEmbeddingAllowedModels.includes(model)) {
    throw new OllamaProviderError(`Ollama embedding model is not allowed: ${model}`, 400, false)
  }
  return model
}

export async function inferWithOllama(body: InferRequestBody): Promise<InferResponse> {
  if (env.ollamaCloudTransport === 'local-daemon') {
    return inferWithLocalOllama(body)
  }

  if (env.ollamaApiKeys.length === 0) {
    throw new OllamaProviderError('Ollama Cloud is not configured', 503, false)
  }

  let lastError: OllamaProviderError | null = null
  const model = resolveModel(body.model)
  const requestTimeoutMs = body.messages.some((message) => message.images?.length)
    ? env.visionRequestTimeoutMs
    : env.requestTimeoutMs

  for (let attempt = 0; attempt < env.ollamaApiKeys.length; attempt += 1) {
    const selectedKey = nextAvailableKey()
    if (!selectedKey) {
      if (allKeysRejected()) {
        throw new OllamaProviderError('All configured Ollama Cloud credentials were rejected', 503, false)
      }
      const delayMs = allKeysCooldownDelayMs()
      throw new OllamaProviderError('All Ollama Cloud API keys are cooling down', 429, true, delayMs)
    }
    logger.info({ attempt, keyIndex: selectedKey.index, model }, 'ollama_request_started')

    const response = await fetch(`${env.ollamaBaseUrl}/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${selectedKey.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: body.messages,
        options: { temperature: body.temperature ?? 0.2 },
        ...(body.responseFormat ? { format: body.responseFormat } : {}),
        stream: false,
      }),
      signal: timeoutSignal(requestTimeoutMs),
    })

    const payload = await response.json().catch(() => ({})) as OllamaChatResponse
    if (!response.ok) {
      const retryWithAnotherKey = shouldTryAnotherKey(response.status)
      const retryable = response.status === 429 || response.status >= 500
      const delayMs = applyKeyCooldown(response.status, selectedKey.index, response.headers.get('retry-after'))
      lastError = new OllamaProviderError(
        `Ollama API error (HTTP ${response.status}): ${(payload.error || 'Unknown error').slice(0, 240)}`,
        response.status,
        retryable,
        delayMs
      )
      logger.warn({ attempt, keyIndex: selectedKey.index, model, status: response.status, retryable, retryAfterMs: delayMs }, 'ollama_request_failed')
      if (retryWithAnotherKey && attempt < env.ollamaApiKeys.length - 1) {
        await sleep(2_000 * (attempt + 1))
        continue
      }
      break
    }

    const content = payload.message?.content
    if (!content) {
      lastError = new OllamaProviderError('Ollama returned empty response content', 502, true)
      if (attempt < env.ollamaApiKeys.length - 1) {
        await sleep(2_000 * (attempt + 1))
        continue
      }
      throw lastError
    }

    const promptTokens = payload.prompt_eval_count ?? 0
    const completionTokens = payload.eval_count ?? 0
    return {
      content,
      toolCalls: [],
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    }
  }

  if (lastError?.status === 401 || lastError?.status === 403) {
    throw new OllamaProviderError('All configured Ollama Cloud credentials were rejected', 503, false)
  }

  throw lastError ?? new OllamaProviderError('Ollama provider request failed', 500, true)
}

async function inferWithLocalOllama(body: InferRequestBody): Promise<InferResponse> {
  const model = resolveModel(body.model)
  const requestTimeoutMs = body.messages.some((message) => message.images?.length)
    ? env.visionRequestTimeoutMs
    : env.requestTimeoutMs

  try {
    const response = await fetch(`${env.ollamaLocalBaseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: body.messages,
        options: { temperature: body.temperature ?? 0.2 },
        ...(body.responseFormat ? { format: body.responseFormat } : {}),
        stream: false,
      }),
      signal: timeoutSignal(requestTimeoutMs),
    })
    const payload = (await response.json().catch(() => ({}))) as OllamaChatResponse
    if (!response.ok) {
      throw new OllamaProviderError(
        `Local Ollama inference error (HTTP ${response.status}): ${(payload.error || 'Unknown error').slice(0, 240)}`,
        response.status,
        response.status >= 500,
      )
    }
    const content = payload.message?.content
    if (!content) throw new OllamaProviderError('Local Ollama returned empty response content', 502, true)
    const promptTokens = payload.prompt_eval_count ?? 0
    const completionTokens = payload.eval_count ?? 0
    return {
      content,
      toolCalls: [],
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    }
  } catch (error) {
    if (error instanceof OllamaProviderError) throw error
    const message = error instanceof Error ? error.message : 'Unknown request failure'
    throw new OllamaProviderError(`Local Ollama inference request failed: ${message.slice(0, 240)}`, 503, true)
  }
}

function parseEmbeddings(payload: OllamaEmbedResponse, expectedCount: number): EmbedResponse {
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== expectedCount) {
    throw new OllamaProviderError('Ollama Cloud returned an invalid embeddings response', 502, true)
  }

  const embeddings = payload.embeddings.map((embedding) => {
    if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new OllamaProviderError('Ollama Cloud returned an invalid embedding vector', 502, true)
    }
    return embedding
  })
  const dimensions = embeddings[0].length
  if (embeddings.some((embedding) => embedding.length !== dimensions)) {
    throw new OllamaProviderError('Ollama Cloud returned embeddings with inconsistent dimensions', 502, true)
  }

  return { embeddings, dimensions }
}

export async function embedWithOllamaCloud(body: EmbedRequestBody): Promise<EmbedResponse> {
  if (env.ollamaApiKeys.length === 0) {
    throw new OllamaProviderError('Ollama Cloud is not configured', 503, false)
  }

  const model = resolveEmbeddingModel(body.model)
  let lastError: OllamaProviderError | null = null

  for (let attempt = 0; attempt < env.ollamaApiKeys.length; attempt += 1) {
    const selectedKey = nextAvailableKey()
    if (!selectedKey) {
      if (allKeysRejected()) {
        throw new OllamaProviderError('All configured Ollama Cloud credentials were rejected', 503, false)
      }
      const delayMs = allKeysCooldownDelayMs()
      throw new OllamaProviderError('All Ollama Cloud API keys are cooling down', 429, true, delayMs)
    }

    logger.info({ attempt, keyIndex: selectedKey.index, model, inputCount: body.input.length }, 'ollama_embedding_started')
    try {
      const response = await fetch(`${env.ollamaBaseUrl}/embed`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${selectedKey.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: body.input }),
        signal: timeoutSignal(env.requestTimeoutMs),
      })
      const payload = (await response.json().catch(() => ({}))) as OllamaEmbedResponse
      if (response.ok) {
        return parseEmbeddings(payload, body.input.length)
      }

      const retryWithAnotherKey = shouldTryAnotherKey(response.status)
      const retryable = response.status === 429 || response.status >= 500
      const delayMs = applyKeyCooldown(response.status, selectedKey.index, response.headers.get('retry-after'))
      lastError = new OllamaProviderError(
        `Ollama Cloud embedding API error (HTTP ${response.status}): ${(payload.error || 'Unknown error').slice(0, 240)}`,
        response.status,
        retryable,
        delayMs
      )
      logger.warn({ attempt, keyIndex: selectedKey.index, model, status: response.status, retryable, retryAfterMs: delayMs }, 'ollama_embedding_failed')
    } catch (error) {
      if (error instanceof OllamaProviderError) throw error
      const message = error instanceof Error ? error.message : 'Unknown request failure'
      lastError = new OllamaProviderError(`Ollama Cloud embedding request failed: ${message.slice(0, 240)}`, 503, true)
      logger.warn({ attempt, keyIndex: selectedKey.index, model, error: message }, 'ollama_embedding_transport_failed')
    }

    if (shouldTryAnotherKey(lastError.status) && attempt < env.ollamaApiKeys.length - 1) {
      await sleep(2_000 * (attempt + 1))
      continue
    }
    break
  }

  if (lastError?.status === 401 || lastError?.status === 403) {
    throw new OllamaProviderError('All configured Ollama Cloud credentials were rejected', 503, false)
  }

  throw lastError ?? new OllamaProviderError('Ollama Cloud embedding request failed', 503, true)
}

export async function embedWithOllamaLocal(body: EmbedRequestBody): Promise<EmbedResponse> {
  const model = resolveEmbeddingModel(body.model)
  logger.info({ model, inputCount: body.input.length }, 'ollama_local_embedding_started')

  try {
    const response = await fetch(`${env.ollamaLocalBaseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: body.input }),
      signal: timeoutSignal(env.requestTimeoutMs),
    })
    const payload = (await response.json().catch(() => ({}))) as OllamaEmbedResponse
    if (response.ok) return parseEmbeddings(payload, body.input.length)
    throw new OllamaProviderError(
      `Local Ollama embedding API error (HTTP ${response.status}): ${(payload.error || 'Unknown error').slice(0, 240)}`,
      response.status,
      response.status >= 500,
    )
  } catch (error) {
    if (error instanceof OllamaProviderError) throw error
    const message = error instanceof Error ? error.message : 'Unknown request failure'
    throw new OllamaProviderError(`Local Ollama embedding request failed: ${message.slice(0, 240)}`, 503, true)
  }
}
