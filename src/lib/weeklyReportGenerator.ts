import { supabaseAdmin } from './supabaseAdmin.js'
import { Resend } from 'resend'
import { logoImg, plainSubject } from '../templates/brand.js'

const resend = new Resend(process.env.RESEND_API_KEY)

export interface WeeklyStats {
  period: { from: string; to: string }
  city_name: string
  new_reports: number
  resolved: number
  in_progress: number
  overdue: number
  vs_last_week: number
  by_category: Record<string, number>
  top_zones: Array<{ address: string; count: number }>
  total_votes: number
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
  })
}

/**
 * Get the start of the current calendar week (Monday 00:00)
 */
function getWeekStart(date: Date = new Date()): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Adjust when day is Sunday
  const monday = new Date(d.setDate(diff))
  monday.setHours(0, 0, 0, 0)
  return monday
}

/**
 * Get the end of the current calendar week (Sunday 23:59:59)
 */
function getWeekEnd(date: Date = new Date()): Date {
  const weekStart = getWeekStart(date)
  const sunday = new Date(weekStart)
  sunday.setDate(sunday.getDate() + 6)
  sunday.setHours(23, 59, 59, 999)
  return sunday
}

/**
 * Les chiffres d'**une** commune.
 *
 * `tenantId` était facultatif, et l'envoi automatique l'omettait : le rapport
 * agrégeait alors toutes les communes ensemble, prospects compris. Il est
 * obligatoire, et c'est le type qui l'impose plutôt qu'une note de vigilance.
 */
async function collectStats(tenantId: string): Promise<WeeklyStats> {
  const now = new Date()
  const weekStart = getWeekStart(now)
  const weekEnd = getWeekEnd(now)
  
  // Previous week for comparison
  const prevWeekStart = new Date(weekStart)
  prevWeekStart.setDate(prevWeekStart.getDate() - 7)
  const prevWeekEnd = new Date(weekStart)
  prevWeekEnd.setMilliseconds(-1) // Just before current week starts

  const [
    newReportsResult,
    resolvedResult,
    inProgressResult,
    overdueResult,
    prevWeekResult,
    topZonesResult,
    votesResult,
  ] = await Promise.all([
    // 1. Nouveaux signalements cette semaine
    (async () => {
      let query = supabaseAdmin
        .from('reports')
        .select('category')
        .gte('created_at', weekStart.toISOString())
        .lte('created_at', weekEnd.toISOString())
      query = query.eq('tenant_id', tenantId)
      return query
    })(),

    // 2. Signalements résolus cette semaine
    (async () => {
      let query = supabaseAdmin
        .from('reports')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'resolu')
        .gte('updated_at', weekStart.toISOString())
        .lte('updated_at', weekEnd.toISOString())
      query = query.eq('tenant_id', tenantId)
      return query
    })(),

    // 3. Signalements pris en charge cette semaine
    (async () => {
      let query = supabaseAdmin
        .from('reports')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pris_en_charge')
        .gte('updated_at', weekStart.toISOString())
        .lte('updated_at', weekEnd.toISOString())
      query = query.eq('tenant_id', tenantId)
      return query
    })(),

    // 4. Signalements en retard (>7j sans résolution)
    (async () => {
      let query = supabaseAdmin
        .from('reports')
        .select('id', { count: 'exact', head: true })
        .neq('status', 'resolu')
        .lt('created_at', prevWeekStart.toISOString())
      query = query.eq('tenant_id', tenantId)
      return query
    })(),

    // 5. Semaine précédente (pour delta)
    (async () => {
      let query = supabaseAdmin
        .from('reports')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', prevWeekStart.toISOString())
        .lt('created_at', weekStart.toISOString())
      query = query.eq('tenant_id', tenantId)
      return query
    })(),

    // 6. Top 3 zones actives
    (async () => {
      let query = supabaseAdmin
        .from('reports')
        .select('address_approx')
        .gte('created_at', weekStart.toISOString())
        .lte('created_at', weekEnd.toISOString())
        .not('address_approx', 'is', null)
      query = query.eq('tenant_id', tenantId)
      return query
    })(),

    // 7. Total votes cette semaine
    (async () => {
      let query = supabaseAdmin
        .from('reports')
        .select('vote_count')
        .gte('created_at', weekStart.toISOString())
        .lte('created_at', weekEnd.toISOString())
      query = query.eq('tenant_id', tenantId)
      return query
    })(),
  ])

  // Traitement des résultats
  const newReports = newReportsResult.data || []
  const newReportsCount = newReports.length
  const resolvedCount = resolvedResult.count || 0
  const inProgressCount = inProgressResult.count || 0
  const overdueCount = overdueResult.count || 0
  const prevWeekCount = prevWeekResult.count || 0

  // Agrégation par catégorie
  const byCategory: Record<string, number> = {}
  newReports.forEach((r) => {
    const cat = r.category || 'autre'
    byCategory[cat] = (byCategory[cat] || 0) + 1
  })

  // Top zones
  const addressCounts: Record<string, number> = {}
  ;(topZonesResult.data || []).forEach((r) => {
    if (r.address_approx) {
      addressCounts[r.address_approx] = (addressCounts[r.address_approx] || 0) + 1
    }
  })
  const topZones = Object.entries(addressCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([address, count]) => ({ address, count }))

  // Total votes
  const totalVotes = (votesResult.data || []).reduce(
    (sum, r) => sum + (r.vote_count || 0),
    0
  )

  const { data: config } = await supabaseAdmin
    .from('tenant_configs')
    .select('city_name')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  const cityName = config?.city_name ?? 'la ville'

  return {
    period: {
      from: formatDate(weekStart),
      to: formatDate(weekEnd),
    },
    city_name: cityName,
    new_reports: newReportsCount,
    resolved: resolvedCount,
    in_progress: inProgressCount,
    overdue: overdueCount,
    vs_last_week: newReportsCount - prevWeekCount,
    by_category: byCategory,
    top_zones: topZones,
    total_votes: totalVotes,
  }
}

async function generateAiText(stats: WeeklyStats): Promise<string> {
  const prompt = `Tu es un assistant municipal qui rédige des résumés hebdomadaires professionnels pour des élus locaux français.

Voici les données de la semaine du ${stats.period.from} au ${stats.period.to} pour la ville de ${stats.city_name} :
- ${stats.new_reports} nouveaux signalements (${stats.vs_last_week >= 0 ? '+' : ''}${stats.vs_last_week} vs semaine précédente)
- ${stats.resolved} signalements résolus
- ${stats.in_progress} signalements en cours de traitement
- ${stats.overdue} signalements en retard (>7 jours)
- Catégories : ${Object.entries(stats.by_category).map(([cat, count]) => `${cat} (${count})`).join(', ')}
${stats.top_zones.length > 0 ? `- Zones actives : ${stats.top_zones.map(z => z.address.split(',')[0]).join(', ')}` : ''}

Rédige un résumé professionnel en 4 paragraphes courts :
1. Synthèse de la semaine (chiffres clés, ton neutre)
2. Points d'attention (retards, zones actives)
3. Tendance vs semaine précédente
4. Une phrase sur l'engagement citoyen

Ton : professionnel, direct, sans jargon technique.
Maximum 200 mots. En français uniquement. IMPORTANT : Rédige le texte complet, ne t'arrête pas au milieu d'une phrase.`


  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generationConfig: {
            maxOutputTokens: 2000,
            temperature: 0.5,
            responseMimeType: 'text/plain',
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
        }),
      }
    )

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`)
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>
        }
      }>
    }
    const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

    if (aiText && aiText.length > 50) {
      console.log('[WeeklyReport] Texte IA généré:', aiText.substring(0, 100) + '...')
      return aiText.trim()
    } else {
      console.warn('[WeeklyReport] Texte IA incomplet ou vide:', aiText)
    }
  } catch (err) {
    console.error('[WeeklyReport] Erreur appel Gemini:', err)
  }

  // Fallback si Gemini échoue
  console.log('[WeeklyReport] Utilisation du texte fallback')
  return `Cette semaine du ${stats.period.from} au ${stats.period.to}, ${stats.new_reports} nouveaux signalements ont été enregistrés sur ${stats.city_name} (${stats.vs_last_week >= 0 ? '+' : ''}${stats.vs_last_week} vs semaine précédente).

${stats.resolved} signalements ont été résolus et ${stats.in_progress} sont en cours de traitement. Cependant, ${stats.overdue} signalements dépassent 7 jours sans résolution, nécessitant une attention particulière.

Les catégories les plus actives sont : ${Object.entries(stats.by_category).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cat, count]) => `${cat} (${count})`).join(', ')}.

L'engagement citoyen reste soutenu avec ${stats.total_votes} votes enregistrés cette semaine.`
}

function buildEmailHtml(stats: WeeklyStats, aiText: string): string {
  const deltaClass = stats.vs_last_week >= 0 ? 'delta-pos' : 'delta-neg'
  const deltaSymbol = stats.vs_last_week >= 0 ? '▲' : '▼'
  const deltaSign = stats.vs_last_week >= 0 ? '+' : ''

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           margin: 0; background: #F6F7F9; }
    .container { max-width: 600px; margin: 0 auto;
                 padding: 24px 16px; }
    .header { background: #1A56A0; color: white;
              padding: 24px; border-radius: 12px 12px 0 0;
              text-align: center; }
    .header h1 { margin: 0; font-size: 20px; }
    .header p  { margin: 4px 0 0; opacity: 0.85;
                 font-size: 13px; }
    .body { background: white; padding: 24px;
            border: 1px solid #E2E5EA;
            border-top: none; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr;
                  gap: 12px; margin: 20px 0; }
    .stat-card { padding: 16px; border-radius: 8px;
                 text-align: center; }
    .stat-card .number { font-size: 28px; font-weight: 700;
                          line-height: 1; }
    .stat-card .label  { font-size: 12px; margin-top: 4px;
                          opacity: 0.75; }
    .stat-new      { background: #F1F6FC; color: #1A56A0; }
    .stat-resolved { background: #E8F7F1; color: #1D9E75; }
    .stat-progress { background: #FEF6E7; color: #8A5A08; }
    .stat-overdue  { background: #FBEAEA; color: #DC2626; }
    .section { margin: 24px 0; }
    .section h2 { font-size: 14px; font-weight: 600;
                  color: #374151; margin-bottom: 12px;
                  text-transform: uppercase;
                  letter-spacing: 0.05em; }
    .ai-text { background: #F6F7F9; border-left: 3px solid
               #1A56A0; padding: 16px; border-radius: 0 8px
               8px 0; font-size: 14px; line-height: 1.7;
               color: #374151; white-space: pre-wrap; }
    .zone-item { display: flex; justify-content: space-between;
                 align-items: center; padding: 10px 0;
                 border-bottom: 1px solid #F6F7F9;
                 font-size: 14px; }
    .zone-badge { background: #F1F6FC; color: #1A56A0;
                  padding: 2px 10px; border-radius: 20px;
                  font-size: 12px; font-weight: 600; }
    .cta { text-align: center; margin: 28px 0 16px; }
    .cta a { background: #1A56A0; color: white !important;
             padding: 14px 32px; border-radius: 8px;
             text-decoration: none; font-weight: 600;
             font-size: 15px; display: inline-block; }
    .footer { background: #F6F7F9; padding: 16px 24px;
              border: 1px solid #E2E5EA; border-top: none;
              border-radius: 0 0 12px 12px; text-align: center;
              font-size: 12px; color: #9CA3AF; }
    .delta-pos { color: #1D9E75; font-weight: 600; }
    .delta-neg { color: #DC2626; font-weight: 600; }
  </style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1 style="display:flex;align-items:center;justify-content:center;gap:10px;">${logoImg(36)}OnSignale</h1>
    <p>Résumé hebdomadaire — Semaine du ${stats.period.from} au ${stats.period.to}</p>
  </div>

  <div class="body">

    <!-- 4 stat cards -->
    <div class="stats-grid">
      <div class="stat-card stat-new">
        <div class="number">${stats.new_reports}</div>
        <div class="label">Nouveaux signalements</div>
      </div>
      <div class="stat-card stat-resolved">
        <div class="number">${stats.resolved}</div>
        <div class="label">Résolus</div>
      </div>
      <div class="stat-card stat-progress">
        <div class="number">${stats.in_progress}</div>
        <div class="label">En cours</div>
      </div>
      <div class="stat-card stat-overdue">
        <div class="number">${stats.overdue}</div>
        <div class="label">En retard</div>
      </div>
    </div>

    <!-- Delta semaine précédente -->
    <p style="text-align:center; font-size:13px; color:#6B7280;">
      <span class="${deltaClass}">${deltaSymbol} ${deltaSign}${stats.vs_last_week}</span>
      signalement${Math.abs(stats.vs_last_week) > 1 ? 's' : ''} vs semaine précédente
    </p>

    <!-- Texte IA -->
    <div class="section">
      <h2>Analyse de la semaine</h2>
      <div class="ai-text">${aiText}</div>
    </div>

    <!-- Top zones -->
    ${
      stats.top_zones.length > 0
        ? `
    <div class="section">
      <h2>Zones les plus actives</h2>
      ${stats.top_zones
        .map(
          (z, i) => `
      <div class="zone-item">
        <span>${i + 1}. ${z.address || 'Zone inconnue'}</span>
        <span class="zone-badge">${z.count} signalement${z.count > 1 ? 's' : ''}</span>
      </div>`
        )
        .join('')}
    </div>`
        : ''
    }

    <!-- CTA -->
    <div class="cta">
      <a href="${process.env.CLIENT_URL || 'https://onsignale.fr'}/admin">
        Accéder au dashboard →
      </a>
    </div>

  </div>

  <div class="footer">
    OnSignale — Service de signalement urbain citoyen<br>
    <a href="${process.env.CLIENT_URL || 'https://onsignale.fr'}/admin/parametres"
       style="color:#9CA3AF;">
      Gérer les destinataires
    </a>
  </div>

</div>
</body>
</html>`
}

async function sendEmails(
  tenantId: string,
  emailHtml: string,
  stats: WeeklyStats
): Promise<number> {
  // Filtré sur le tenant. Sans ce `eq`, chaque destinataire de chaque commune
  // recevait les chiffres de toutes les autres, chaque lundi à 8 h.
  const { data: recipients, error } = await supabaseAdmin
    .from('weekly_report_recipients')
    .select('email, name')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)

  if (error) {
    throw new Error(`Erreur récupération destinataires: ${error.message}`)
  }

  if (!recipients || recipients.length === 0) {
    console.log(`[WeeklyReport] ${stats.city_name} — aucun destinataire actif`)
    return 0
  }

  const fromEmail = 'OnSignale <rapport@onsignale.fr>'
  let sent = 0

  for (const recipient of recipients) {
    try {
      const result = await resend.emails.send({
        from: fromEmail,
        to: recipient.email,
        subject: plainSubject(`Résumé hebdomadaire ${stats.city_name} — semaine du ${stats.period.from}`),
        html: emailHtml,
      })

      sent += 1
      console.log(`[WeeklyReport] ${stats.city_name} → envoyé, ID ${result.data?.id}`)
    } catch (err) {
      // Un destinataire en échec ne doit pas priver les autres de leur rapport.
      const e = err as { message?: string }
      console.error(`[WeeklyReport] ${stats.city_name} → échec:`, e.message)
    }
  }

  return sent
}

/**
 * Le rapport d'une commune, généré et envoyé.
 *
 * C'est l'unité : une commune, ses chiffres, ses destinataires. L'ancienne
 * version ne prenait aucun argument et mélangeait tout le monde.
 */
export async function sendWeeklyReport(tenantId: string): Promise<WeeklyStats> {
  const stats = await collectStats(tenantId)
  const aiText = await generateAiText(stats)
  const emailHtml = buildEmailHtml(stats, aiText)

  await sendEmails(tenantId, emailHtml, stats)

  return stats
}

/**
 * Les communes qu'il faut servir à cette heure-ci.
 *
 * `weekly_report_day` et `weekly_report_hour` étaient réglables dans l'admin et
 * lus par personne : la tâche planifiée était figée au lundi 8 h. Elle tourne
 * désormais toutes les heures et ne retient que les communes dont c'est le
 * créneau — ce qui rend ces deux réglages réels.
 *
 * Les prospects sont exclus : personne n'y attend de rapport, et leurs
 * signalements ne sont pas publiés.
 */
async function tenantsDueAt(day: number, hour: number): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabaseAdmin
    .from('tenant_configs')
    .select('tenant_id, weekly_report_day, weekly_report_hour, feature_weekly_report, tenants!inner(id, name, status)')
    .eq('feature_weekly_report', true)
    .in('tenants.status', ['active', 'trial', 'demo'])

  if (error) {
    console.error('[WeeklyReport] Lecture des communes impossible:', error.message)
    return []
  }

  return (data ?? [])
    .filter((row) => (row.weekly_report_day ?? 1) === day && (row.weekly_report_hour ?? 8) === hour)
    .map((row) => {
      const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants
      return { id: row.tenant_id as string, name: (tenant as { name?: string })?.name ?? row.tenant_id as string }
    })
}

/** Appelée par la tâche planifiée, chaque heure. */
export async function sendScheduledWeeklyReports(now = new Date()): Promise<number> {
  const due = await tenantsDueAt(now.getDay(), now.getHours())

  if (due.length === 0) return 0

  let sent = 0

  for (const tenant of due) {
    try {
      await sendWeeklyReport(tenant.id)
      sent += 1
    } catch (err) {
      // Une commune en échec ne doit pas empêcher les suivantes.
      console.error(`[WeeklyReport] ${tenant.name} — rapport non envoyé:`, err)
    }
  }

  return sent
}

export async function generateReportPreview(tenantId: string): Promise<{
  stats: WeeklyStats
  html: string
}> {
  const stats = await collectStats(tenantId)
  const aiText = await generateAiText(stats)
  const html = buildEmailHtml(stats, aiText)
  return { stats, html }
}
