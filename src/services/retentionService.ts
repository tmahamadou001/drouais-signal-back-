import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { removePhoto } from '../lib/photoStorage.js'

/**
 * La purge des données personnelles arrivées à terme.
 *
 * Le RGPD demande une durée de conservation *déterminée*, pas « le temps qu'il
 * faudra ». Deux données du signalement en portent une :
 *
 *  - **la photo**, parce qu'on ne maîtrise pas ce qu'elle contient. Un habitant
 *    photographie un trottoir ; il y a une plaque d'immatriculation dessus, une
 *    devanture, parfois un visage ;
 *  - **l'adresse e-mail d'un signalement sans compte**, qui n'existe que pour
 *    prévenir l'auteur de l'avancement de *ce* signalement.
 *
 * Ce qui reste après la purge — la catégorie, la position, les dates, le statut
 * — ne désigne personne et constitue la mémoire technique de la commune. Le
 * signalement n'est donc pas supprimé : il est dépersonnalisé.
 */

/** Douze mois après la résolution : le temps d'un exercice budgétaire et d'un recours. */
export const PHOTO_RETENTION_MONTHS_AFTER_RESOLUTION = 12

/**
 * Vingt-quatre mois après le dépôt pour un signalement jamais résolu.
 *
 * Plus long, parce qu'une photo est la preuve d'un problème encore ouvert et
 * que l'effacer priverait la commune de ce qu'elle doit traiter. Mais pas
 * infini : un signalement oublié depuis deux ans n'est plus un dossier en cours.
 */
export const PHOTO_RETENTION_MONTHS_UNRESOLVED = 24

function monthsBefore(date: Date, months: number): string {
  const result = new Date(date)
  result.setMonth(result.getMonth() - months)
  return result.toISOString()
}

/**
 * Douze mois pour les journaux d'audit.
 *
 * La CNIL admet six mois pour de simples journaux de connexion et davantage
 * pour une trace d'actions administratives, qui doit couvrir un contrôle ou une
 * contestation. Douze mois tiennent le cycle d'une collectivité sans garder
 * indéfiniment qui a fait quoi.
 */
export const AUDIT_LOG_RETENTION_MONTHS = 12

export interface PurgeResult {
  photosRemoved: number
  emailsErased: number
  auditLogsRemoved: number
}

/**
 * Passe une fois sur ce qui a dépassé sa durée.
 *
 * Le repère de la résolution est `updated_at`, faute d'une colonne qui date la
 * résolution elle-même. Toute modification ultérieure le repousse, donc la
 * purge arrive au plus tôt douze mois après la résolution — jamais avant. Se
 * tromper dans ce sens efface trop tard ; l'inverse effacerait une pièce encore
 * utile.
 */
export async function purgeExpiredPersonalData(now = new Date()): Promise<PurgeResult> {
  const resolvedBefore = monthsBefore(now, PHOTO_RETENTION_MONTHS_AFTER_RESOLUTION)
  const createdBefore = monthsBefore(now, PHOTO_RETENTION_MONTHS_UNRESOLVED)

  const { data: resolved } = await supabaseAdmin
    .from('reports')
    .select('id, photo_url')
    .eq('status', 'resolu')
    .not('photo_url', 'is', null)
    .lt('updated_at', resolvedBefore)

  const { data: stale } = await supabaseAdmin
    .from('reports')
    .select('id, photo_url')
    .neq('status', 'resolu')
    .not('photo_url', 'is', null)
    .lt('created_at', createdBefore)

  const expired = [...(resolved ?? []), ...(stale ?? [])]
  let photosRemoved = 0

  for (const report of expired) {
    await removePhoto(report.photo_url)
    // `photo_url` est vidé même si le fichier était déjà absent : l'URL signée
    // est expirée depuis longtemps, et la garder ferait croire à une image.
    await supabaseAdmin.from('reports').update({ photo_url: null }).eq('id', report.id)
    photosRemoved += 1
  }

  // L'adresse d'un signalement sans compte suit la même échéance que sa photo.
  const { data: erased } = await supabaseAdmin
    .from('reports')
    .update({ anonymous_email: null })
    .not('anonymous_email', 'is', null)
    .lt('created_at', createdBefore)
    .select('id')

  const { data: purgedLogs } = await supabaseAdmin
    .from('audit_logs')
    .delete()
    .lt('created_at', monthsBefore(now, AUDIT_LOG_RETENTION_MONTHS))
    .select('id')

  return {
    photosRemoved,
    emailsErased: erased?.length ?? 0,
    auditLogsRemoved: purgedLogs?.length ?? 0,
  }
}
