/**
 * Ce que le statut d'une commune veut dire.
 *
 * Il y a trois régimes, et un seul endroit pour en décider :
 *
 *  - **silencieuse** (`prospect`) — des habitants signalent, rien n'est publié.
 *    La coquille de la migration 025 : elle porte la donnée, et c'est tout ;
 *  - **citoyenne** (`community`) — publiée, sans mairie. Les habitants se
 *    lisent entre eux et ferment eux-mêmes ce qui a été réparé. Personne ne
 *    traite, aucun délai ne court, rien n'est transmis à un service ;
 *  - **partenaire** (`trial`, `active`, `demo`) — quelqu'un répond.
 *
 * `suspended` n'est aucun des trois : c'est un accès coupé, et une commune
 * suspendue ne publie plus. Les tests de ce fichier existent pour que ce cas
 * ne retombe jamais dans « tout ce qui n'est pas prospect est public », qui
 * était la règle implicite avant la migration 040.
 */

export const TENANT_STATUSES = [
  'trial',
  'active',
  'suspended',
  'demo',
  'prospect',
  'community',
] as const

export type TenantStatus = (typeof TENANT_STATUSES)[number]

export function isTenantStatus(value: unknown): value is TenantStatus {
  return TENANT_STATUSES.includes(value as TenantStatus)
}

/** Une commune dont la mairie a accès au back-office. */
export const PARTNER_STATUSES: readonly TenantStatus[] = ['trial', 'active', 'demo']

/**
 * Les communes dont les signalements sont publics.
 *
 * C'est ce qui décide d'`is_published` à l'insertion, et ce que bascule
 * l'ouverture ou la fermeture d'une commune.
 */
const PUBLISHING_STATUSES: readonly TenantStatus[] = ['trial', 'active', 'demo', 'community']

/** Il y a une équipe municipale en face : statuts, délais, transmission. */
export function isPartner(status: string): boolean {
  return PARTNER_STATUSES.includes(status as TenantStatus)
}

/** Les signalements de cette commune sont visibles de tous. */
export function publishesReports(status: string): boolean {
  return PUBLISHING_STATUSES.includes(status as TenantStatus)
}

/**
 * La commune est ouverte au public **sans** mairie pour répondre.
 *
 * C'est le seul cas où l'application doit changer de vocabulaire : pas de
 * frise à quatre étapes, pas de délai annoncé, pas de « la mairie traite votre
 * signalement ». Dire le contraire serait mentir à l'habitant.
 */
export function isCommunityMode(status: string): boolean {
  return status === 'community'
}

/** Une commune qu'on peut proposer dans le sélecteur de l'application. */
export function isBrowsable(status: string): boolean {
  return publishesReports(status)
}

/**
 * Ce qu'il faut faire des signalements existants quand le statut change.
 *
 * La règle tient en une phrase : l'historique suit la publication. Elle vaut
 * dans les deux sens, et le sens descendant est le moins évident — une commune
 * partenaire qui s'en va **retombe au silence**, ses signalements sont
 * dépubliés. Les laisser publics serait transformer un non-renouvellement en
 * moyen de pression.
 */
export type PublicationEffect = 'publish' | 'unpublish' | 'none'

export function publicationEffect(from: string, to: string): PublicationEffect {
  const was = publishesReports(from)
  const now = publishesReports(to)

  if (was === now) return 'none'
  return now ? 'publish' : 'unpublish'
}

/**
 * Le jour du lancement : la commune devient partenaire sans l'avoir été.
 *
 * Elle déclenche l'e-mail à la liste d'attente, qui ne doit partir qu'une
 * fois. Une commune citoyenne qui signe le déclenche aussi : ses habitants
 * s'étaient inscrits pour être prévenus que leur mairie rejoigne la
 * plateforme, pas que la page s'ouvre.
 */
export function isLaunch(from: string, to: string): boolean {
  return !isPartner(from) && isPartner(to)
}
