import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { env } from '../config/env.js'

declare module 'express-serve-static-core' {
  interface Request {
    gatewayClientId?: string
  }
}

function toSafeBuffer(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = toSafeBuffer(a)
  const bBuffer = toSafeBuffer(b)
  if (aBuffer.length !== bBuffer.length) return false
  return timingSafeEqual(aBuffer, bBuffer)
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const clientId = req.header('x-gw-client-id')
  const timestampHeader = req.header('x-gw-timestamp')
  const signature = req.header('x-gw-signature')

  if (!clientId || !timestampHeader || !signature) {
    res.status(401).json({ success: false, error: { code: 'AUTH_MISSING_HEADERS', message: 'Missing gateway auth headers' } })
    return
  }

  const client = env.clients[clientId]
  if (!client) {
    res.status(403).json({ success: false, error: { code: 'AUTH_CLIENT_FORBIDDEN', message: 'Client is not allowed' } })
    return
  }

  const timestamp = Number(timestampHeader)
  if (!Number.isFinite(timestamp)) {
    res.status(401).json({ success: false, error: { code: 'AUTH_INVALID_TIMESTAMP', message: 'Invalid timestamp' } })
    return
  }

  const now = Date.now()
  if (Math.abs(now - timestamp) > env.clockSkewMs) {
    res.status(401).json({ success: false, error: { code: 'AUTH_STALE_REQUEST', message: 'Request timestamp is out of range' } })
    return
  }

  const rawBody = JSON.stringify(req.body || {})
  const fullPath = req.originalUrl.split('?')[0]
  const payload = `${timestampHeader}.${req.method.toUpperCase()}.${fullPath}.${rawBody}`
  const expectedSignature = createHmac('sha256', client.secret).update(payload).digest('hex')

  if (!safeEqual(signature, expectedSignature)) {
    res.status(401).json({ success: false, error: { code: 'AUTH_INVALID_SIGNATURE', message: 'Invalid signature' } })
    return
  }

  req.gatewayClientId = clientId

  next()
}
