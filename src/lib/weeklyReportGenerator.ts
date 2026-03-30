import { supabaseAdmin } from './supabaseAdmin.js'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export interface WeeklyStats {
  period: { from: string; to: string }
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

async function collectStats(): Promise<WeeklyStats> {
  const now = new Date()
  const weekStart = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
  const prevWeekStart = new Date(now.getTime() - 14 * 24 * 3600 * 1000)

  // Requêtes parallèles
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
    supabaseAdmin
      .from('reports')
      .select('category')
      .gte('created_at', weekStart.toISOString()),

    // 2. Signalements résolus cette semaine
    supabaseAdmin
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'resolu')
      .gte('updated_at', weekStart.toISOString()),

    // 3. Signalements pris en charge cette semaine
    supabaseAdmin
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pris_en_charge')
      .gte('updated_at', weekStart.toISOString()),

    // 4. Signalements en retard (>7j sans résolution)
    supabaseAdmin
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'resolu')
      .lt('created_at', weekStart.toISOString()),

    // 5. Semaine précédente (pour delta)
    supabaseAdmin
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', prevWeekStart.toISOString())
      .lt('created_at', weekStart.toISOString()),

    // 6. Top 3 zones actives
    supabaseAdmin
      .from('reports')
      .select('address_approx')
      .gte('created_at', weekStart.toISOString())
      .not('address_approx', 'is', null),

    // 7. Total votes cette semaine
    supabaseAdmin
      .from('reports')
      .select('vote_count')
      .gte('created_at', weekStart.toISOString()),
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

  return {
    period: {
      from: formatDate(weekStart),
      to: formatDate(now),
    },
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

Voici les données de la semaine du ${stats.period.from} au ${stats.period.to} pour la ville de Dreux :
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
  return `Cette semaine du ${stats.period.from} au ${stats.period.to}, ${stats.new_reports} nouveaux signalements ont été enregistrés sur Dreux (${stats.vs_last_week >= 0 ? '+' : ''}${stats.vs_last_week} vs semaine précédente).

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
           margin: 0; background: #F9FAFB; }
    .container { max-width: 600px; margin: 0 auto;
                 padding: 24px 16px; }
    .header { background: #1A56A0; color: white;
              padding: 24px; border-radius: 12px 12px 0 0;
              text-align: center; }
    .header h1 { margin: 0; font-size: 20px; }
    .header p  { margin: 4px 0 0; opacity: 0.85;
                 font-size: 13px; }
    .body { background: white; padding: 24px;
            border: 1px solid #E5E7EB;
            border-top: none; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr;
                  gap: 12px; margin: 20px 0; }
    .stat-card { padding: 16px; border-radius: 8px;
                 text-align: center; }
    .stat-card .number { font-size: 28px; font-weight: 700;
                          line-height: 1; }
    .stat-card .label  { font-size: 12px; margin-top: 4px;
                          opacity: 0.75; }
    .stat-new      { background: #EFF6FF; color: #1A56A0; }
    .stat-resolved { background: #ECFDF5; color: #1D9E75; }
    .stat-progress { background: #FFFBEB; color: #D97706; }
    .stat-overdue  { background: #FEF2F2; color: #DC2626; }
    .section { margin: 24px 0; }
    .section h2 { font-size: 14px; font-weight: 600;
                  color: #374151; margin-bottom: 12px;
                  text-transform: uppercase;
                  letter-spacing: 0.05em; }
    .ai-text { background: #F8FAFC; border-left: 3px solid
               #1A56A0; padding: 16px; border-radius: 0 8px
               8px 0; font-size: 14px; line-height: 1.7;
               color: #374151; white-space: pre-wrap; }
    .zone-item { display: flex; justify-content: space-between;
                 align-items: center; padding: 10px 0;
                 border-bottom: 1px solid #F3F4F6;
                 font-size: 14px; }
    .zone-badge { background: #EFF6FF; color: #1A56A0;
                  padding: 2px 10px; border-radius: 20px;
                  font-size: 12px; font-weight: 600; }
    .cta { text-align: center; margin: 28px 0 16px; }
    .cta a { background: #1A56A0; color: white !important;
             padding: 14px 32px; border-radius: 8px;
             text-decoration: none; font-weight: 600;
             font-size: 15px; display: inline-block; }
    .footer { background: #F9FAFB; padding: 16px 24px;
              border: 1px solid #E5E7EB; border-top: none;
              border-radius: 0 0 12px 12px; text-align: center;
              font-size: 12px; color: #9CA3AF; }
    .delta-pos { color: #1D9E75; font-weight: 600; }
    .delta-neg { color: #DC2626; font-weight: 600; }
  </style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>📊 DrouaisSignal</h1>
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
      <a href="${process.env.CLIENT_URL || 'https://drouaissignal.fr'}/admin">
        Accéder au dashboard →
      </a>
    </div>

  </div>

  <div class="footer">
    DrouaisSignal — Service de signalement urbain citoyen<br>
    <a href="${process.env.CLIENT_URL || 'https://drouaissignal.fr'}/admin/parametres"
       style="color:#9CA3AF;">
      Gérer les destinataires
    </a>
  </div>

</div>
</body>
</html>`
}

async function sendEmails(emailHtml: string, stats: WeeklyStats): Promise<void> {
  // Récupérer les destinataires actifs
  const { data: recipients, error } = await supabaseAdmin
    .from('weekly_report_recipients')
    .select('email, name')
    .eq('is_active', true)

  if (error) {
    throw new Error(`Erreur récupération destinataires: ${error.message}`)
  }

  if (!recipients || recipients.length === 0) {
    console.log('[WeeklyReport] Aucun destinataire actif')
    return
  }

  console.log(`[WeeklyReport] Envoi à ${recipients.length} destinataire(s)`)

  // Déterminer l'expéditeur selon l'environnement
  const isDev = process.env.NODE_ENV !== 'production'
  const fromEmail = isDev
    ? 'onboarding@resend.dev'
    : 'DrouaisSignal <rapport@drouaissignal.fr>'

  // Envoyer à chaque destinataire
  for (const recipient of recipients) {
    try {
      console.log(`[WeeklyReport] Tentative d'envoi à ${recipient.email} depuis ${fromEmail}`)
      const result = await resend.emails.send({
        from: fromEmail,
        to: recipient.email,
        subject: `📊 Résumé hebdomadaire DrouaisSignal — Semaine du ${stats.period.from}`,
        html: emailHtml,
      })
      console.log(`[WeeklyReport] ✓ Réponse Resend complète:`, JSON.stringify(result, null, 2))
      console.log(`[WeeklyReport] ✓ Email envoyé à ${recipient.email}, ID:`, result.data?.id)
    } catch (err: any) {
      console.error(`[WeeklyReport] ✗ Erreur envoi à ${recipient.email}:`, {
        message: err.message,
        statusCode: err.statusCode,
        name: err.name,
      })
    }
  }
}

export async function generateAndSendWeeklyReport(): Promise<WeeklyStats> {
  console.log('[WeeklyReport] Génération du rapport...')
  const stats = await collectStats()
  console.log('[WeeklyReport] Stats collectées:', stats)

  const aiText = await generateAiText(stats)
  console.log('[WeeklyReport] Texte IA généré')

  const emailHtml = buildEmailHtml(stats, aiText)
  console.log('[WeeklyReport] HTML construit')

  await sendEmails(emailHtml, stats)
  console.log('[WeeklyReport] Rapport envoyé avec succès')

  return stats
}

export async function generateReportPreview(): Promise<{
  stats: WeeklyStats
  html: string
}> {
  const stats = await collectStats()
  const aiText = await generateAiText(stats)
  const html = buildEmailHtml(stats, aiText)
  return { stats, html }
}
