import { getAuthUserEmail } from './authHelpers.js'

/**
 * Comment joindre l'auteur d'un signalement.
 *
 * Une seule règle, deux appelants : le message d'un agent, qui a besoin de
 * l'adresse, et le détail du signalement, qui a besoin de dire à cet agent s'il
 * y en a une. Elles vivaient séparément et avaient divergé — la notification de
 * changement de statut lisait `anonymous_email`, celle des commentaires non.
 * Le même habitant recevait donc « votre signalement est pris en charge » et
 * jamais « voici notre message », alors que son adresse était sur la même ligne
 * de la même table.
 *
 * Trois cas, et le troisième est réel : un signalement peut n'avoir ni compte
 * ni adresse. C'est le prix du dépôt sans inscription, et c'est assumé — mais
 * il faut le dire à l'agent plutôt que de le lui laisser découvrir.
 */

export interface CitizenContactSource {
  user_id: string | null
  anonymous_email?: string | null
}

export type CitizenChannel = 'account' | 'email' | 'none'

export interface CitizenContact {
  channel: CitizenChannel
  /** `false` quand rien ne permet de prévenir l'auteur. */
  reachable: boolean
  email: string | null
}

/**
 * Résout l'adresse de l'auteur.
 *
 * Un compte d'abord — son adresse est à jour et vérifiée. À défaut,
 * `anonymous_email`, laissée à la volée au moment du dépôt. `null` si ni l'un
 * ni l'autre : le signalement existe, personne ne peut être prévenu.
 */
export async function resolveCitizenContact(
  report: CitizenContactSource
): Promise<CitizenContact> {
  if (report.user_id) {
    const email = await getAuthUserEmail(report.user_id)
    // Un compte sans adresse lisible n'est pas joignable : mieux vaut le dire
    // que de laisser croire qu'un e-mail est parti.
    return { channel: email ? 'account' : 'none', reachable: Boolean(email), email }
  }

  const anonymous = report.anonymous_email?.trim() || null
  if (anonymous) return { channel: 'email', reachable: true, email: anonymous }

  return { channel: 'none', reachable: false, email: null }
}
