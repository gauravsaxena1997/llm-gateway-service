import { env } from '../config/env.js'
import type { InferRequestBody, InferResponse } from '../types.js'

let currentKeyIndex = 0

function nextKey(): string {
  const key = env.cerebrasApiKeys[currentKeyIndex]
  currentKeyIndex = (currentKeyIndex + 1) % env.cerebrasApiKeys.length
  return key
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), timeoutMs)
  return controller.signal
}

export async function inferWithCerebras(body: InferRequestBody): Promise<InferResponse> {
  const apiKey = nextKey()
  const response = await fetch(`${env.cerebrasBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: body.model || env.cerebrasModel,
      messages: body.messages,
      max_completion_tokens: body.maxTokens ?? 1024,
      temperature: body.temperature ?? 0.3,
      stream: false,
    }),
    signal: timeoutSignal(env.requestTimeoutMs),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error')
    throw new Error(`Cerebras API error (HTTP ${response.status}): ${errorBody.slice(0, 240)}`)
  }

  const data = await response.json()
  const choice = data?.choices?.[0]?.message?.content

  if (!choice || typeof choice !== 'string') {
    throw new Error('Provider returned empty response content')
  }

  return {
    content: choice,
    usage: data?.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  }
}
