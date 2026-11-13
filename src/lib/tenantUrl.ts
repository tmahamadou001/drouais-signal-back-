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

/**
 * L'origine publique du front. Jamais l'apex si on peut l'éviter.
 *
 * `FRONTEND_URL` n'est définie nulle part : la fonction retombait donc toujours
 * sur `https://onsignale.fr`, qui sert le site de présentation depuis
 * Cloudflare et n'a pas de page `/set-password`. `CLIENT_URL`, elle, existe
 * et désigne l'application — on la lit en second, avant de supposer quoi que
 * ce soit. `lib/env.ts` prévient au démarrage si les deux manquent en
 * production.
 */
function baseUrl(): string {
  const configured = process.env.FRONTEND_URL || process.env.CLIENT_URL

  return (configured || 'https://onsignale.fr').replace(/\/$/, '')
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

/**
 * L'adresse du site public — `onsignale.fr`, sans commune.
 *
 * Le jumeau de `tenantWebUrl`, et son contraire : celle-ci vise l'apex
 * **exprès**, là où l'autre s'en détourne. Les deux ont leur emploi, et les
 * confondre est la méprise que tout ce fichier documente.
 *
 * Sa raison d'être est la confirmation d'inscription. Au moment où un habitant
 * crée son compte, aucune commune n'est encore en jeu : il ne rejoint pas
 * l'espace de Dreux, il crée un compte OnSignale, qui le suivra partout — un
 * compte vaut pour toutes les communes, c'est la règle de `/mine`. Lui envoyer
 * un lien vers `dreux.onsignale.fr` graverait dans son e-mail une commune
 * qu'il quittera peut-être, et poserait la question insoluble du slug à
 * choisir quand il n'y en a pas.
 *
 * Le site, lui, est servi par Cloudflare depuis ce dossier `site/` : il
 * répond sans commune, sans application Vue et sans compte.
 */
export function publicSiteUrl(): string {
  const configured = process.env.PUBLIC_SITE_URL

  if (configured) return configured.replace(/\/$/, '')

  return 'https://onsignale.fr'
}
