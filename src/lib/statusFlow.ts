/**
 * L'ordre des statuts d'un signalement, et ce qu'on a le droit d'en faire.
 *
 * Il vivait implicitement dans trois endroits — la contrainte CHECK en base, le
 * schéma Zod, et le `nextStatus()` du front — qui étaient d'accord par accident.
 * Deux règles s'ajoutent ici et ont besoin d'un seul propriétaire :
 *
 *  - **on peut revenir en arrière.** Un agent qui clique « Résolu » sur la
 *    mauvaise ligne n'avait aucun moyen de se corriger, et la seule issue était
 *    de supprimer le signalement — donc de perdre l'historique et de laisser
 *    l'habitant sans réponse. Le retour est tracé comme n'importe quel
 *    changement, avec sa mention explicite dans le journal d'audit ;
 *
 *  - **sauf depuis « Résolu ».** Clore un signalement prévient l'habitant que
 *    c'est fait ; le rouvrir en silence ferait de cette promesse quelque chose
 *    qu'on reprend. Le statut est donc terminal, et l'écran le dit **avant** le
 *    clic plutôt que de le découvrir après.
 */
export const STATUS_ORDER = ['en_attente', 'transmis', 'pris_en_charge', 'resolu'] as const

export type ReportStatus = (typeof STATUS_ORDER)[number]

/** Le statut au-delà duquel plus rien ne bouge. */
export const TERMINAL_STATUS: ReportStatus = 'resolu'

export function isReportStatus(value: unknown): value is ReportStatus {
  return STATUS_ORDER.includes(value as ReportStatus)
}

/** Un retour en arrière : la cible est plus tôt dans le parcours que l'actuel. */
export function isRollback(from: string, to: string): boolean {
  const origin = STATUS_ORDER.indexOf(from as ReportStatus)
  const target = STATUS_ORDER.indexOf(to as ReportStatus)
  return origin >= 0 && target >= 0 && target < origin
}

/** Un signalement clos ne change plus de statut. */
export function isFinal(status: string): boolean {
  return status === TERMINAL_STATUS
}
