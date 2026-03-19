import { Router } from 'express'

export const healthRouter = Router()

healthRouter.get('/live', (_req, res) => {
  res.json({ success: true, status: 'live' })
})

healthRouter.get('/ready', (_req, res) => {
  res.json({ success: true, status: 'ready' })
})
