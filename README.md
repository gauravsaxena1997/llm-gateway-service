# llm-gateway-service

Internal provider-agnostic LLM gateway for shared usage across projects.

## Quick start

1. Copy `.env.example` to `.env`
2. Set valid client secret and provider API keys
3. Install dependencies and run

```bash
npm install
npm run dev
```

Service default URL: `http://localhost:4005`

## Client auth configuration

Provide a comma-separated list of client IDs, and a matching secret for each. Client IDs must be uppercase with underscores.

```bash
GATEWAY_CLIENT_IDS=WEALTH_FLOW,PROJECT_B
GATEWAY_CLIENT_SECRET_WEALTH_FLOW=your-secret-here
GATEWAY_CLIENT_SECRET_PROJECT_B=your-secret-here
```

## Endpoints

- `GET /health/live`
- `GET /health/ready`
- `POST /v1/infer`

## Auth headers for `/v1/infer`

- `x-gw-client-id` (e.g., `WEALTH_FLOW`)
- `x-gw-timestamp` (milliseconds since epoch)
- `x-gw-signature` (HMAC SHA256 hex of `${timestamp}.${method}.${path}.${rawBody}`)

## Infer request body

```json
{
  "provider": "cerebras",
  "messages": [
    { "role": "system", "content": "You are concise." },
    { "role": "user", "content": "Say hello" }
  ],
  "maxTokens": 120,
  "temperature": 0.3
}
```
# llm-gateway-service
