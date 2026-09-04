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
  categoryIcon: string
  description?: string | null
  addressApprox?: string | null
  photoUrl?: string | null
  createdAt: string
  isAnonymous: boolean
}

export function buildServiceNotificationEmail(params: ServiceNotificationParams): { html: string; text: string } {
  const {
    serviceName, tenantName, cityName, tenantSlug,
    reportId, reportTitle, category, categoryIcon,
    description, addressApprox, photoUrl,
    createdAt, isAnonymous,
  } = params

  const clientUrl = process.env.CLIENT_URL ?? 'https://onsignale.fr'
  const adminUrl = clientUrl.replace('://', `://${tenantSlug}.`) + '/admin/signalements'
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
<body style="font-family: system-ui, -apple-system, sans-serif; background: #F8FAFC; margin: 0; padding: 24px;">
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
    <div style="background: white; padding: 28px; border: 1px solid #E2E8F0; border-top: none;">

      <p style="color: #475569; font-size: 14px; margin: 0 0 20px; line-height: 1.6;">
        Un nouveau signalement vient d'être soumis sur <strong>${tenantName}</strong> dans la catégorie
        <strong>${category}</strong>. Il vous est transmis pour prise en charge.
      </p>

      <!-- Fiche signalement -->
      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
        <h2 style="color: #0F172A; font-size: 15px; font-weight: 700; margin: 0 0 14px;">
          ${reportTitle}
        </h2>

        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="color: #94A3B8; padding: 4px 0; width: 110px; vertical-align: top;">Catégorie</td>
            <td style="color: #334155; font-weight: 500;">${categoryIcon} ${category}</td>
          </tr>
          ${addressApprox ? `
          <tr>
            <td style="color: #94A3B8; padding: 4px 0; vertical-align: top;">Localisation</td>
            <td style="color: #334155;">📍 ${addressApprox}</td>
          </tr>` : ''}
          <tr>
            <td style="color: #94A3B8; padding: 4px 0; vertical-align: top;">Date</td>
            <td style="color: #334155;">${date}</td>
          </tr>
          <tr>
            <td style="color: #94A3B8; padding: 4px 0; vertical-align: top;">Plateforme</td>
            <td style="color: #334155;">${tenantName} (${tenantSlug}.onsignale.fr)</td>
          </tr>
        </table>

        ${description ? `
        <div style="margin-top: 14px; padding-top: 14px; border-top: 1px solid #E2E8F0;">
          <p style="color: #94A3B8; font-size: 12px; font-weight: 500; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.5px;">Description</p>
          <p style="color: #334155; font-size: 13px; line-height: 1.6; margin: 0;">${description}</p>
        </div>` : ''}
      </div>

      ${photoUrl ? `
      <!-- Photo -->
      <div style="margin-bottom: 20px;">
        <p style="color: #94A3B8; font-size: 12px; font-weight: 500; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Photo jointe</p>
        <img src="${photoUrl}" alt="Photo du signalement"
          style="width: 100%; max-height: 280px; object-fit: cover; border-radius: 10px; border: 1px solid #E2E8F0;" />
      </div>` : ''}

      <!-- CTA 
      <!-- <a href="${adminUrl}"
        style="display: block; text-align: center; background: #1A56A0; color: white;
               padding: 13px; border-radius: 10px; font-size: 14px; font-weight: 600;
               text-decoration: none; margin-bottom: 16px;">
        Voir et traiter dans le back-office →
      </a> -->

      <p style="color: #94A3B8; font-size: 12px; text-align: center; margin: 0; line-height: 1.6;">
        Cet email vous a été transmis automatiquement par OnSignale<br>
        car votre service est associé à la catégorie <strong>${categoryIcon} ${category}</strong> sur <strong>${tenantName}</strong>.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding: 16px 28px; text-align: center;">
      <p style="color: #CBD5E1; font-size: 11px; margin: 0;">
        OnSignale — Plateforme de signalement citoyen · ${cityName}
      </p>
    </div>
  </div>
</body>
</html>`

  const text = `Nouveau signalement — ${tenantName} (${cityName})

Service destinataire : ${serviceName}
Catégorie : ${categoryIcon} ${category}
Titre : ${reportTitle}
${addressApprox ? `Localisation : ${addressApprox}\n` : ''}Date : ${date}
Déclarant : ${isAnonymous ? 'Anonyme' : 'Citoyen inscrit'}
${description ? `\nDescription :\n${description}\n` : ''}
Accéder au back-office : ${adminUrl}

---
Cet email vous a été transmis automatiquement par OnSignale.
`

  return { html, text }
}
