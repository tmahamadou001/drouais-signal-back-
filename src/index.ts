import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import {
  globalApiLimiter,
  duplicateCheckLimiter,
  voteLimiter,
  analyzeLimiter,
  heatmapLimiter,
  adminSlowDown,
  weeklyReportLimiter,
} from './middleware/rateLimits.js'
import reportsRouter from './routes/reports.js'
import adminRouter from './routes/admin.js'
import duplicatesRouter from './routes/duplicates.js'
import votesRouter from './routes/votes.js'
import analyzeRouter from './routes/analyze.js'
import mapRouter from './routes/map.js'
import heatmapRouter from './routes/heatmap.js'
import weeklyReportRouter from './routes/weeklyReport.js'
import tenantRouter from './routes/tenant.js'
import { resolveTenant } from './middleware/tenantResolver.js'
import compression from 'compression'
import './cron/weeklyReport.js'


const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)

app.use(compression({
  threshold: 1024,
  level: 6,
}))

// ─── Trust proxy (obligatoire derrière Railway/Vercel/Cloudflare) ───
app.set('trust proxy', 1)

// ─── Security Headers (Helmet) ───
app.use(helmet({
  contentSecurityPolicy: false, // Désactiver CSP côté API (pas de HTML servi)
}))
app.disable('x-powered-by')

// Headers manuels supplémentaires
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})

// ─── CORS ───
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true)
      return
    }
    const allowed =
      origin.endsWith('.onsignale.fr') ||
      origin === 'https://onsignale.fr' ||
      origin === 'https://www.onsignale.fr' ||
      origin.includes('localhost') ||
      origin === process.env.CLIENT_URL

    if (allowed) {
      callback(null, true)
    } else {
      callback(new Error(`Not allowed by CORS: ${origin}`))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug', 'X-API-Key'],
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─── Rate Limiting Global ───
app.use('/api/', globalApiLimiter)

// ─── Tenant Resolution (toutes les routes /api/) ───
app.use('/api/', resolveTenant)

// ─── Routes ───
// Routes publiques avec rate limiting spécifique
app.use('/api/reports', reportsRouter)
app.use('/api/reports', duplicateCheckLimiter, duplicatesRouter)
app.use('/api/reports', voteLimiter, votesRouter)
app.use('/api/analyze-photo', analyzeLimiter, analyzeRouter)
app.use('/api/map', mapRouter)
app.use('/api/tenant', tenantRouter)

// Routes admin avec slow down progressif
app.use('/api/admin', adminSlowDown)
app.use('/api/admin', adminRouter)
app.use('/api/admin', heatmapLimiter, heatmapRouter)
app.use('/api/admin/weekly-report/send', weeklyReportLimiter)
app.use('/api/admin', weeklyReportRouter)

// ─── Health check ───
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Error handler ───
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Erreur non gérée:', err)
  res.status(500).json({ error: err.message || 'Erreur interne du serveur.' })
})

// ─── Start ───
app.listen(PORT, () => {
  console.log(`🛡️  OnSignale API démarrée sur http://localhost:${PORT}`)
  console.log(`   Client attendu sur: ${process.env.CLIENT_URL || 'http://localhost:5173'}`)
})
