import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { removePhoto } from '../lib/photoStorage.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Supprimer son compte, depuis l'application.
 *
 * Apple exige que la suppression soit **initiable depuis l'app** : un lien
 * vers une page web passe souvent, et c'est le point d'une fiche qui revient
 * le plus volontiers en revue. Au-delà de la règle, demander à quelqu'un
 * d'écrire un e-mail pour disparaître est une friction qu'on n'imposerait pas
 * pour s'inscrire.
 *
 * Ce qui est supprimé et ce qui reste n'est pas inventé ici : c'est ce que la
 * page publique `/supprimer-mes-donnees` promet, mot pour mot.
 *
 *   **Supprimé** — le compte et son adresse, les photos des signalements
 *   déposés, les messages échangés avec les agents, le lien entre la personne
 *   et ses signalements, les jetons de notification de ses appareils.
 *
 *   **Conservé** — le signalement lui-même, dépersonnalisé : catégorie,
 *   position, dates, avancement. Une fois la photo et le lien au compte
 *   effacés, il ne désigne plus personne, et il reste ce qui permet à la
 *   commune de savoir qu'un lampadaire a été réparé. Son obligation de traiter
 *   ce qui lui est signalé ne disparaît pas avec un compte.
 *
 * L'ordre compte : on efface les photos **avant** de couper le lien, sinon on
 * ne sait plus quelles photos étaient les siennes.
 */

export interface DeletionOutcome {
  reportsAnonymised: number
  photosRemoved: number
}

export async function deleteAccount(userId: string): Promise<DeletionOutcome> {
  /**
   * Un membre d'une équipe municipale ne se supprime pas lui-même.
   *
   * Son compte porte un rôle dans une commune, et les journaux d'audit
   * existent pour qu'on puisse vérifier qui a fait quoi. Sa révocation passe
   * par un administrateur, depuis l'écran Équipe — c'est une décision de la
   * collectivité, pas de la personne.
   */
  const { data: memberships } = await supabaseAdmin
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', userId)
    .limit(1)

  if (memberships && memberships.length > 0) {
    throw new AppError(
      409,
      'team_member',
      'Ce compte appartient à l’équipe d’une commune. Demandez à un administrateur de le révoquer depuis l’écran Équipe.'
    )
  }

  // Les photos d'abord : après la dépersonnalisation, plus rien ne dit
  // lesquelles étaient les siennes.
  const { data: reports } = await supabaseAdmin
    .from('reports')
    .select('id, photo_url')
    .eq('user_id', userId)

  const owned = reports ?? []
  let photosRemoved = 0

  for (const report of owned) {
    if (!report.photo_url) continue
    if (await removePhoto(report.photo_url)) photosRemoved += 1
  }

  /**
   * Le signalement survit, la personne non.
   *
   * `anonymous_token` est mis à `null` plutôt que laissé : c'est une preuve
   * d'identité, et elle n'a plus de titulaire.
   */
  const { error: anonymiseError } = await supabaseAdmin
    .from('reports')
    .update({
      user_id: null,
      photo_url: null,
      anonymous_email: null,
      anonymous_token: null,
      is_anonymous: true,
    })
    .eq('user_id', userId)

  if (anonymiseError) throw anonymiseError

  // Les messages échangés avec les agents : supprimés, pas anonymisés. Un fil
  // de conversation dépersonnalisé reste une conversation.
  await supabaseAdmin.from('report_comments').delete().eq('author_id', userId)

  // Ce qui ne sert qu'à joindre la personne.
  await supabaseAdmin.from('device_tokens').delete().eq('user_id', userId)
  await supabaseAdmin.from('notification_preferences').delete().eq('user_id', userId)

  /**
   * Le compte lui-même, en dernier.
   *
   * S'il échouait alors que tout le reste est fait, la personne garderait un
   * compte vide — gênant, mais réparable. L'inverse — un compte supprimé et
   * des photos restées en ligne — ne le serait pas.
   */
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId)

  if (deleteError) {
    console.error('[Suppression] Compte non supprimé :', deleteError.message)
    throw new AppError(
      500,
      'internal_error',
      'Vos données ont été effacées, mais le compte n’a pas pu être supprimé. Écrivez à dpo@onsignale.fr.'
    )
  }

  return { reportsAnonymised: owned.length, photosRemoved }
}
