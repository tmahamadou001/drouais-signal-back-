/**
 * L'adresse web d'une commune.
 *
 * Depuis que `onsignale.fr` sert le site de présentation, l'apex ne porte plus
 * aucune commune : le client qui s'y charge ne peut déduire aucun slug, n'envoie
 * pas `X-Tenant-Slug`, et l'API lui répond « Tenant requis. » C'est exactement
 * ce qu'on lisait en cliquant sur « Suivre mon signalement » dans un e-mail.
 *
 * Un signalement appartient à une commune ; son lien doit donc porter la
 * commune, et c'est le sous-domaine qui le fait — le même mécanisme que celui
 * par lequel un agent atteint son back-office.
 */

/** L'origine publique du front. Jamais l'apex en production. */
function baseUrl(): string {
  return (process.env.FRONTEND_URL || 'https://onsignale.fr').replace(/\/$/, '')
}

export function tenantWebUrl(slug: string | null | undefined): string {
  const base = baseUrl()

  // En développement le front est un seul serveur Vite sur `localhost` : il n'y
  // a pas de sous-domaine à viser, et le slug y est fixé par `VITE_DEV_TENANT`.
  if (!slug || !base.startsWith('https://')) return base

  const host = base.slice('https://'.length).replace(/^www\./, '')

  // Un sous-domaine déjà présent n'est pas remplacé : `FRONTEND_URL` peut
  // pointer un environnement de recette qui porte le sien.
  if (host.split('.').length > 2) return base

  return `https://${slug}.${host}`
}
