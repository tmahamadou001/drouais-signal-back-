import cron from 'node-cron'
import { purgeExpiredPersonalData } from '../services/retentionService.js'

/**
 * La purge de conservation, une fois par nuit.
 *
 * À 3 h 30 : après le rapport hebdomadaire, loin des heures où une mairie
 * travaille, et à une minute qui n'est pas ronde — les tâches calées sur
 * l'heure pile se déclenchent toutes ensemble.
 *
 * Une durée de conservation qui n'est pas appliquée par une tâche n'est pas une
 * durée de conservation : c'est une phrase dans une politique.
 */
cron.schedule('30 3 * * *', async () => {
  try {
    const result = await purgeExpiredPersonalData()
    const total = result.photosRemoved + result.emailsErased + result.auditLogsRemoved
    if (total > 0) {
      console.log(
        `🧹 Purge RGPD : ${result.photosRemoved} photo(s), ${result.emailsErased} adresse(s), ` +
        `${result.auditLogsRemoved} entrée(s) d'audit`
      )
    }
  } catch (err) {
    console.error('Purge RGPD impossible :', err)
  }
})
