import 'dotenv/config'

interface ClientConfig {
  secret: string
}

function parseClientsJson(raw: string): Record<string, ClientConfig> {
  try {
    const parsed = JSON.parse(raw) as Record<string, ClientConfig>
    return parsed
  } catch {
    throw new Error('Invalid GATEWAY_CLIENTS_JSON. Expected valid JSON object.')
  }
}

function parseClientsFromEnv(): Record<string, ClientConfig> {
  const clientIdsRaw = process.env.GATEWAY_CLIENT_IDS?.trim() || ''
  if (clientIdsRaw) {
    const clientIds = clientIdsRaw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)

    const clients: Record<string, ClientConfig> = {}
    for (const clientId of clientIds) {
      const key = `GATEWAY_CLIENT_SECRET_${clientId}`
      const secret = process.env[key]?.trim() || ''
      if (!secret) {
        throw new Error(`Missing ${key} for client ${clientId}`)
      }

      clients[clientId] = { secret }
    }

    return clients
  }

  const clientsJson = process.env.GATEWAY_CLIENTS_JSON?.trim() || ''
  if (clientsJson) {
    return parseClientsJson(clientsJson)
  }

  throw new Error(
    'Missing gateway clients config. Set GATEWAY_CLIENT_IDS and matching GATEWAY_CLIENT_SECRET_<ID>'
  )
}

const apiKeys = (process.env.CEREBRAS_API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean)

const ollamaApiKeys = (process.env.OLLAMA_API_KEYS || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean)

const ollamaAllowedModels = (process.env.OLLAMA_ALLOWED_MODELS || 'gemma4:31b')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean)

const ollamaEmbeddingAllowedModels = (process.env.OLLAMA_EMBEDDING_ALLOWED_MODELS || 'embeddinggemma:300m-qat-q8_0')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean)

function parseOllamaCloudTransport(value: string | undefined): 'cloud-api' | 'local-daemon' {
  const transport = value?.trim() || 'cloud-api'
  if (transport === 'cloud-api' || transport === 'local-daemon') return transport
  throw new Error('Invalid OLLAMA_CLOUD_TRANSPORT. Expected cloud-api or local-daemon.')
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4005),
  clients: parseClientsFromEnv(),
  clockSkewMs: 300000,
  requestTimeoutMs: Number(process.env.LLM_REQUEST_TIMEOUT_MS || 120000),
  visionRequestTimeoutMs: Number(process.env.OLLAMA_VISION_REQUEST_TIMEOUT_MS || 90000),
  providerDefault: 'ollama',
  cerebrasBaseUrl: 'https://api.cerebras.ai/v1',
  cerebrasModel: process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
  cerebrasApiKeys: apiKeys,
  ollamaBaseUrl: 'https://ollama.com/api',
  ollamaModel: process.env.OLLAMA_MODEL || 'gemma4:31b',
  ollamaAllowedModels,
  ollamaApiKeys,
  ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma:300m-qat-q8_0',
  ollamaEmbeddingAllowedModels,
  ollamaLocalBaseUrl: (process.env.OLLAMA_LOCAL_BASE_URL || 'http://127.0.0.1:11434/api').replace(/\/$/, ''),
  ollamaCloudTransport: parseOllamaCloudTransport(process.env.OLLAMA_CLOUD_TRANSPORT),
} as const
