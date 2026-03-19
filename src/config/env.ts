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

if (apiKeys.length === 0) {
  throw new Error('Missing CEREBRAS_API_KEYS')
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4005),
  clients: parseClientsFromEnv(),
  clockSkewMs: 300000,
  requestTimeoutMs: 30000,
  providerDefault: 'cerebras',
  cerebrasBaseUrl: 'https://api.cerebras.ai/v1',
  cerebrasModel: 'llama3.1-8b',
  cerebrasApiKeys: apiKeys,
} as const
