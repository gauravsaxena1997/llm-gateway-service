import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerId = req.header('x-request-id')
  const requestId = headerId && headerId.trim().length > 0 ? headerId : `gw_${randomUUID()}`
  req.requestId = requestId
  res.setHeader('x-request-id', requestId)
  next()
}
