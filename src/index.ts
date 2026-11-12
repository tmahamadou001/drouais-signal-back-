import { isAllowedOrigin } from './lib/corsOrigin.js'
import { readEnv, missingInProduction } from './lib/env.js'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import {
  globalApiLimiter,
  duplicateCheckLimiter,
  analyzeLimiter,
  heatmapLimiter,
  geoResolveLimiter,
  adminSlowDown,
  weeklyReportLimiter,
} from './middleware/rateLimits.js'
import reportsRouter from './routes/reports.js'
import adminRouter from './routes/admin.js'
import duplicatesRouter from './routes/duplicates.js'
import votesRouter from './routes/votes.js'
import resolutionsRouter from './routes/resolutions.js'
import moderationRouter from './routes/moderation.js'
import analyzeRouter from './routes/analyze.js'
import mapRouter from './routes/map.js'
import heatmapRouter from './routes/heatmap.js'
import weeklyReportRouter from './routes/weeklyReport.js'
import serviceHandoffRouter from './routes/serviceHandoff.js'
import tenantRouter from './routes/tenant.js'
import tenantsRouter from './routes/tenants.js'
import devicesRouter from './routes/devices.js'
import notificationsRouter from './routes/notifications.js'
import commentsRouter from './modules/comments/comments.router.js'
import unreadCommentsRouter from './modules/comments/unread.router.js'
import uploadRouter from './routes/upload.js'
import auditRouter from './routes/audit.js'
import authRouter from './routes/auth.js'
import { resolveTenant, requireTenant } from './middleware/tenantResolver.js'
import { errorHandler } from './middleware/errorHandler.js'
import compression from 'compression'
import './cron/weeklyReport.js'
import './cron/retention.js'


/**
 * La configuration est validée avant que la première route existe.
 *
 * Une variable absente ne produisait aucune erreur : chaque lecteur avait son
 * repli, et le repli devenait la vérité sans que personne le décide. Mieux
 * vaut refuser de démarrer que répondre faux pendant des mois.
 */
readEnv()

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
    const allowed = isAllowedOrigin(origin, {
      clientUrl: process.env.CLIENT_URL,
      nodeEnv: process.env.NODE_ENV,
    })

    /**
     * Un refus n'est pas une panne.
     *
     * Passer une `Error` au callback la fait remonter dans `errorHandler`, qui
     * répond **500** : les tableaux de bord d'erreurs se remplissaient de
     * pannes imaginaires à chaque requête d'une origine inconnue. `false` omet
     * simplement l'en-tête, et c'est le navigateur qui bloque — ce qui est
     * exactement le fonctionnement de CORS.
     */
    callback(null, allowed)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug'],
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─── Rate Limiting Global ───
app.use('/api/', globalApiLimiter)

// ─── Tenant Resolution (toutes les routes /api/) ───
app.use('/api/', resolveTenant)

// ─── Routes ───
/**
 * Every route below `/api/` that reads commune data requires a resolved tenant.
 *
 * Each handler filtered with `if (req.tenant?.id) query.eq('tenant_id', …)`,
 * which silently returned **every commune's rows** when no slug reached the
 * server. The web front always sends `X-Tenant-Slug`, so it never showed —
 * until the mobile app, whose first launch has no commune yet, listed 35
 * reports from four towns at once.
 *
 * Enforced here rather than in each handler: a conditional filter is the kind
 * of thing the next endpoint forgets, and forgetting it leaks by default. This
 * way a missing slug is a 400 everywhere, and the failure mode of an oversight
 * becomes "no data" instead of "everyone's data".
 *
 * `/api/tenants` and `/api/auth` are mounted outside this guard: the first
 * resolves a position into a commune — it is what the app calls *before* it has
 * a slug — and the second handles password reset, where the slug is optional.
 */
app.use('/api/reports', requireTenant)
app.use('/api/comments', requireTenant)
app.use('/api/upload', requireTenant)
app.use('/api/analyze-photo', requireTenant)
app.use('/api/map', requireTenant)
app.use('/api/admin', requireTenant)
app.use('/api/audit', requireTenant)

// Routes publiques avec rate limiting spécifique
app.use('/api/reports', reportsRouter)
app.use('/api/reports', duplicateCheckLimiter, duplicatesRouter)
app.use('/api/reports', votesRouter)
app.use('/api/reports', resolutionsRouter)
// Hors de `/api/reports`, qui passe par `requireTenant` : la modération
// travaille en travers des communes (migration 040).
app.use('/api/moderation', moderationRouter)
app.use('/api/reports/:reportId/comments', commentsRouter)
app.use('/api/comments', unreadCommentsRouter)
app.use('/api/upload', uploadRouter)
app.use('/api/analyze-photo', analyzeLimiter, analyzeRouter)
app.use('/api/map', mapRouter)
app.use('/api/tenant', tenantRouter)
// Public commune directory — no slug, no auth. Mobile only (see routes/tenants.ts).
app.use('/api/tenants/resolve', geoResolveLimiter)
app.use('/api/tenants', tenantsRouter)
app.use('/api/devices', devicesRouter)
// Préférences de notification et désabonnement en un clic (List-Unsubscribe).
app.use('/api/notifications', notificationsRouter)

// Routes admin avec slow down progressif
app.use('/api/admin', adminSlowDown)
app.use('/api/admin', adminRouter)
app.use('/api/admin', heatmapLimiter, heatmapRouter)
app.use('/api/admin/weekly-report/send', weeklyReportLimiter)
app.use('/api/admin', weeklyReportRouter)
app.use('/api/audit', auditRouter)
/**
 * Les liens remis aux services extérieurs.
 *
 * Hors de `resolveTenant` : celui qui clique n'a ni compte, ni sous-domaine, ni
 * en-tête — le jeton porte déjà sa commune, et c'est lui qui fait autorité.
 */
app.use('/api/service', serviceHandoffRouter)

app.use('/api/auth', authRouter)

// ─── Health check ───
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Error handler ───
app.use(errorHandler)

// ─── Start ───
app.listen(PORT, () => {
  console.log(`🛡️  OnSignale API démarrée sur http://localhost:${PORT}`)
  console.log(`   Client attendu sur: ${process.env.CLIENT_URL || 'http://localhost:5173'}`)

  // Ce qui manque en production, dit une fois, là où quelqu'un le lit — plutôt
  // que découvert dans un lien mort envoyé à un agent municipal.
  for (const missing of missingInProduction()) {
    console.warn(`⚠️  Configuration incomplète : ${missing}`)
  }
})
