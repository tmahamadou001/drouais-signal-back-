import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { findAuthUserByEmail } from '../lib/authHelpers.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Ce qu'une invitation a produit côté authentification.
 *
 * `actionLink` est `null` quand la personne avait déjà un compte : elle a déjà
 * un mot de passe, et lui envoyer un lien pour en choisir un serait au mieux
 * déroutant, au pire une invitation à le changer sans raison.
 */
export interface InviteProvision {
  userId: string
  actionLink: string | null
  alreadyRegistered: boolean
}

/**
 * Trouve ou crée le compte d'un invité.
 *
 * `generateLink({ type: 'invite' })` **refuse** toute adresse déjà enregistrée :
 * elle répond `422 email_exists`. Le code s'attendait au contraire à recevoir
 * l'utilisateur existant et à lire son `email_confirmed_at` pour distinguer les
 * deux cas — une branche que l'on n'atteignait jamais. Inviter quelqu'un qui
 * avait déjà un compte échouait donc sur une erreur serveur, sans ligne dans
 * `tenant_users` et sans e-mail.
 *
 * Ce n'est pas un cas de bord : c'est l'habitant qui a déposé un signalement
 * avec un compte et que la mairie recrute, l'agent qui intervient sur une
 * deuxième commune, ou la personne qu'on réinvite après l'avoir révoquée. La
 * base savait déjà les représenter — `tenant_users` a une clé composée
 * `(tenant_id, user_id)` — c'est l'appel en amont qui fermait la porte.
 */
export async function provisionInvite(
  email: string,
  redirectTo: string
): Promise<InviteProvision> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo },
  })

  if (!error && data?.user) {
    return { userId: data.user.id, actionLink: data.properties.action_link, alreadyRegistered: false }
  }

  // On ne se fie pas au seul code d'erreur : une adresse déjà prise est la
  // seule cause connue d'échec ici, et la vérifier lève le doute pour toutes
  // les autres — qui restent alors des erreurs, comme il se doit.
  const existing = await findAuthUserByEmail(email)

  if (!existing) {
    console.error('[Invite] generateLink a échoué et aucun compte ne correspond:', error)
    throw new AppError(
      500,
      'internal_error',
      'Erreur lors de la génération du lien d’invitation.'
    )
  }

  return { userId: existing.id, actionLink: null, alreadyRegistered: true }
}
