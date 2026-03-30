import cron from 'node-cron'
import { generateAndSendWeeklyReport } from '../lib/weeklyReportGenerator.js'

// Chaque lundi à 8h00 heure de Paris
cron.schedule(
  '0 8 * * 1',
  async () => {
    console.log('[CRON] Démarrage résumé hebdomadaire...')
    try {
      const stats = await generateAndSendWeeklyReport()
      console.log(
        `[CRON] Rapport envoyé — ${stats.new_reports} nouveaux signalements cette semaine`
      )
    } catch (err) {
      console.error('[CRON] Erreur rapport hebdomadaire:', err)
    }
  },
  {
    timezone: 'Europe/Paris',
  }
)

console.log('[CRON] Rapport hebdomadaire planifié — lundi 8h00 Europe/Paris')
