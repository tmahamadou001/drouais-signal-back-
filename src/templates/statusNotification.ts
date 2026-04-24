const COLORS = {
  primary: '#1A56A0',
  success: '#1D9E75',
  warning: '#EF9F27',
  background: '#F9FAFB',
  white: '#FFFFFF',
  text: '#1F2937',
  textLight: '#6B7280',
  border: '#E5E7EB',
}

const STATUS_CONFIG = {
  pris_en_charge: {
    label: 'Pris en charge',
    emoji: '🔧',
    color: COLORS.warning,
    bgColor: '#FFFBEB',
    message: 'Bonne nouvelle ! Vos agents municipaux ont pris en charge votre signalement et vont intervenir prochainement.',
    cta: 'Suivre mon signalement',
  },
  resolu: {
    label: 'Résolu',
    emoji: '✅',
    color: COLORS.success,
    bgColor: '#ECFDF5',
    message: 'Votre signalement a été traité et résolu par les services municipaux. Merci pour votre contribution à l\'amélioration de votre ville !',
    cta: 'Voir la résolution',
  },
  en_attente: {
    label: 'En attente',
    emoji: '⏳',
    color: '#888780',
    bgColor: '#F9FAFB',
    message: 'Votre signalement est en attente de traitement par les services municipaux.',
    cta: 'Voir mon signalement',
  },
}

const CATEGORY_LABELS: Record<string, string> = {
  voirie: 'Voirie',
  eclairage: 'Éclairage',
  dechets: 'Déchets',
  autre: 'Autre',
}

interface StatusEmailParams {
  reportTitle: string
  reportId: string
  newStatus: 'en_attente' | 'pris_en_charge' | 'resolu'
  category: string
  addressApprox: string | null
  photoUrl: string | null
  createdAt: string
  frontendUrl: string
  isAnonymous?: boolean
  anonymousToken?: string | null
}

export const buildStatusEmail = (params: StatusEmailParams): string => {
  const config = STATUS_CONFIG[params.newStatus]
  const categoryLabel = CATEGORY_LABELS[params.category] || params.category
  const reportUrl = params.isAnonymous && params.anonymousToken
    ? `${params.frontendUrl}/signalement/suivi/${params.anonymousToken}`
    : `${params.frontendUrl}/signalement/${params.reportId}`
  
  const formattedDate = new Date(params.createdAt).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mise à jour de votre signalement</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: ${COLORS.background};">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${COLORS.background};">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: ${COLORS.white}; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
          
          <!-- Header -->
          <tr>
            <td style="background-color: ${COLORS.primary}; padding: 24px 32px; text-align: center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: left;">
                    <span style="font-size: 24px; font-weight: 700; color: ${COLORS.white};">🔔 OnSignale</span>
                  </td>
                  <td style="text-align: right;">
                    <span style="font-size: 14px; color: rgba(255, 255, 255, 0.9); font-weight: 500;">Dreux</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Status Badge -->
          <tr>
            <td style="padding: 32px 32px 24px 32px; text-align: center;">
              <div style="display: inline-block; background-color: ${config.bgColor}; border: 2px solid ${config.color}; border-radius: 8px; padding: 12px 24px;">
                <span style="font-size: 24px; margin-right: 8px;">${config.emoji}</span>
                <span style="font-size: 16px; font-weight: 700; color: ${config.color};">${config.label}</span>
              </div>
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td style="padding: 0 32px 24px 32px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: ${COLORS.text}; line-height: 1.3;">
                Votre signalement a été mis à jour
              </h1>
            </td>
          </tr>

          <!-- Report Card -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${COLORS.background}; border-radius: 8px; border: 1px solid ${COLORS.border}; overflow: hidden;">
                ${params.photoUrl ? `
                <tr>
                  <td style="padding: 0;">
                    <img 
                      src="${params.photoUrl}" 
                      alt="Photo du signalement" 
                      style="width: 100%; max-width: 600px; height: auto; max-height: 300px; object-fit: cover; display: block; border: 0;" 
                      width="600"
                      height="300"
                    />
                  </td>
                </tr>
                ` : ''}
                <tr>
                  <td style="padding: 20px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 12px;">
                          <span style="font-size: 18px; font-weight: 600; color: ${COLORS.text};">📋 ${params.reportTitle}</span>
                        </td>
                      </tr>
                      ${params.addressApprox ? `
                      <tr>
                        <td style="padding-bottom: 8px;">
                          <span style="font-size: 14px; color: ${COLORS.textLight};">📍 ${params.addressApprox}</span>
                        </td>
                      </tr>
                      ` : ''}
                      <tr>
                        <td style="padding-bottom: 8px;">
                          <span style="font-size: 14px; color: ${COLORS.textLight};">🏷️ ${categoryLabel}</span>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <span style="font-size: 14px; color: ${COLORS.textLight};">📅 Signalé le ${formattedDate}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Message -->
          <tr>
            <td style="padding: 0 32px 32px 32px;">
              <p style="margin: 0; font-size: 16px; line-height: 1.6; color: ${COLORS.text}; text-align: center;">
                ${config.message}
              </p>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding: 0 32px 32px 32px; text-align: center;">
              <a href="${reportUrl}" style="display: inline-block; background-color: ${COLORS.primary}; color: ${COLORS.white}; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                ${config.cta}
              </a>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding: 0 32px;">
              <div style="border-top: 1px solid ${COLORS.border};"></div>
            </td>
          </tr>

          <!-- Help Text -->
          <tr>
            <td style="padding: 24px 32px;">
              <p style="margin: 0; font-size: 14px; line-height: 1.5; color: ${COLORS.textLight}; text-align: center;">
                Si vous pensez que ce changement est une erreur, contactez votre mairie.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: ${COLORS.background}; text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: ${COLORS.text};">
                OnSignale • Signalement urbain citoyen
              </p>
              <p style="margin: 0 0 16px 0; font-size: 12px; color: ${COLORS.textLight};">
                Vous avez signalé ce problème le ${formattedDate}
              </p>
              <a href="${params.frontendUrl}" style="font-size: 12px; color: ${COLORS.textLight}; text-decoration: underline;">
                Gérer mes notifications
              </a>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}
