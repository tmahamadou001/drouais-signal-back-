import cron from 'node-cron'
import { sendScheduledWeeklyReports } from '../lib/weeklyReportGenerator.js'

/**
 * Toutes les heures, pas le lundi à 8 h.
 *
 * La tâche était figée à un instant unique, et envoyait *un* rapport agrégeant
 * toutes les communes à tous les destinataires. Chaque commune a désormais son
 * rapport, à son jour et à son heure — `weekly_report_day` et
 * `weekly_report_hour`, deux réglages que l'admin proposait déjà et que
 * personne ne lisait.
 *
 * Le déclenchement à la minute 0 fait office de clé : une commune dont c'est le
 * créneau est servie une fois, parce qu'il n'y a qu'un passage par heure.
 */
cron.schedule(
  '0 * * * *',
  async () => {
    try {
      const sent = await sendScheduledWeeklyReports()
      if (sent > 0) console.log(`[CRON] ${sent} rapport(s) hebdomadaire(s) envoyé(s)`)
    } catch (err) {
      console.error('[CRON] Erreur rapport hebdomadaire:', err)
    }
  },
  {
    timezone: 'Europe/Paris',
  }
)

console.log('[CRON] Rapports hebdomadaires — vérification horaire (Europe/Paris)')
