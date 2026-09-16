import { logoImg } from './brand.js'
export interface ServiceNotificationParams {
  recipientEmails: string[]
  serviceName: string
  tenantName: string
  tenantSlug: string
  cityName: string
  reportId: string
  reportTitle: string
  category: string
  description?: string | null
  addressApprox?: string | null
  photoUrl?: string | null
  createdAt: string
  isAnonymous: boolean
}

/**
 * Le repère que `notificationService` remplace par le lien de chaque
 * destinataire, juste avant l'envoi.
 */
export const HANDOFF_PLACEHOLDER = '__ONSIGNALE_HANDOFF_URL__'

export function buildServiceNotificationEmail(params: ServiceNotificationParams): { html: string; text: string } {
  const {
    serviceName, tenantName, cityName, tenantSlug,
    reportId, reportTitle, category,
    description, addressApprox, photoUrl,
    createdAt, isAnonymous,
  } = params

  /**
   * L'emplacement du lien d'action, rempli à l'envoi.
   *
   * Chaque destinataire reçoit le sien : le gabarit est construit une fois, et
   * `notificationService` y substitue le jeton propre à chacun juste avant
   * d'expédier. Passer le lien en paramètre obligerait à reconstruire tout
   * l'e-mail par destinataire pour une seule chaîne.
   */
  const date = new Date(createdAt).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: system-ui, -apple-system, sans-serif; background: #F6F7F9; margin: 0; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto;">

    <!-- Header -->
    <div style="background: #1A56A0; border-radius: 16px 16px 0 0; padding: 24px 28px;">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 4px;">
        ${logoImg(32)}
        <span style="color: rgba(255,255,255,0.7); font-size: 13px; font-weight: 500;">OnSignale — ${cityName}</span>
      </div>
      <h1 style="color: white; font-size: 18px; font-weight: 700; margin: 8px 0 0;">
        Nouveau signalement transmis à ${serviceName}
      </h1>
    </div>

    <!-- Corps -->
    <div style="background: white; padding: 28px; border: 1px solid #E2E5EA; border-top: none;">

      <p style="color: #6B7280; font-size: 14px; margin: 0 0 20px; line-height: 1.6;">
        Un nouveau signalement vient d'être soumis sur <strong>${tenantName}</strong> dans la catégorie
        <strong>${category}</strong>. Il vous est transmis pour prise en charge.
      </p>

      <!-- Fiche signalement -->
      <div style="background: #F6F7F9; border: 1px solid #E2E5EA; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
        <h2 style="color: #0F2B4A; font-size: 15px; font-weight: 700; margin: 0 0 14px;">
          ${reportTitle}
        </h2>

        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="color: #9CA3AF; padding: 4px 0; width: 110px; vertical-align: top;">Catégorie</td>
            <td style="color: #374151; font-weight: 500;">${category}</td>
          </tr>
          ${addressApprox ? `
          <tr>
            <td style="color: #9CA3AF; padding: 4px 0; vertical-align: top;">Localisation</td>
            <td style="color: #374151;">${addressApprox}</td>
          </tr>` : ''}
          <tr>
            <td style="color: #9CA3AF; padding: 4px 0; vertical-align: top;">Date</td>
            <td style="color: #374151;">${date}</td>
          </tr>
          <tr>
            <td style="color: #9CA3AF; padding: 4px 0; vertical-align: top;">Plateforme</td>
            <td style="color: #374151;">${tenantName} (${tenantSlug}.onsignale.fr)</td>
          </tr>
        </table>

        ${description ? `
        <div style="margin-top: 14px; padding-top: 14px; border-top: 1px solid #E2E5EA;">
          <p style="color: #9CA3AF; font-size: 12px; font-weight: 500; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.5px;">Description</p>
          <p style="color: #374151; font-size: 13px; line-height: 1.6; margin: 0;">${description}</p>
        </div>` : ''}
      </div>

      ${photoUrl ? `
      <!-- Photo -->
      <div style="margin-bottom: 20px;">
        <p style="color: #9CA3AF; font-size: 12px; font-weight: 500; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Photo jointe</p>
        <img src="${photoUrl}" alt="Photo du signalement"
          style="width: 100%; max-height: 280px; object-fit: cover; border-radius: 10px; border: 1px solid #E2E5EA;" />
      </div>` : ''}

      <!-- Les deux seuls gestes qu'un service a à faire. Le lien porte
           l'autorisation : pas de compte à créer, pas de mot de passe. Il ne
           vaut que pour ce signalement, et il expire au bout de 30 jours. -->
      <a href="${HANDOFF_PLACEHOLDER}"
        style="display: block; text-align: center; background: #1A56A0; color: white;
               padding: 14px; border-radius: 10px; font-size: 15px; font-weight: 600;
               text-decoration: none; margin-bottom: 10px;">
        Je m'en occupe →
      </a>

      <a href="${HANDOFF_PLACEHOLDER}"
        style="display: block; text-align: center; background: #FFFFFF; color: #0F2B4A;
               border: 1px solid #E2E5EA; padding: 13px; border-radius: 10px;
               font-size: 14px; font-weight: 600; text-decoration: none; margin-bottom: 16px;">
        Signaler l'intervention terminée
      </a>

      <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0; line-height: 1.6;">
        Cet email vous a été transmis automatiquement par OnSignale<br>
        car votre service est associé à la catégorie <strong>${category}</strong> sur <strong>${tenantName}</strong>.<br>
        Ce lien vous est personnel — il ne donne accès qu'à ce signalement.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding: 16px 28px; text-align: center;">
      <p style="color: #9CA3AF; font-size: 11px; margin: 0;">
        OnSignale — Plateforme de signalement citoyen · ${cityName}
      </p>
    </div>
  </div>
</body>
</html>`

  const text = `Nouveau signalement — ${tenantName} (${cityName})

Service destinataire : ${serviceName}
Catégorie : ${category}
Titre : ${reportTitle}
${addressApprox ? `Localisation : ${addressApprox}\n` : ''}Date : ${date}
Déclarant : ${isAnonymous ? 'Anonyme' : 'Citoyen inscrit'}
${description ? `\nDescription :\n${description}\n` : ''}
Répondre en un clic : ${HANDOFF_PLACEHOLDER}
(« Je m'en occupe » ou « intervention terminée » — aucun compte n'est nécessaire)

---
Cet email vous a été transmis automatiquement par OnSignale.
Ce lien vous est personnel et ne donne accès qu'à ce signalement. Il expire dans 30 jours.
`

  return { html, text }
}
