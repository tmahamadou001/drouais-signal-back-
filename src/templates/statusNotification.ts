import { logoImg, EMAIL_COLORS } from './brand.js'

/**
 * Les teintes de cet e-mail, prises dans la palette de la plateforme.
 *
 * Elles étaient proches sans être les mêmes : un gris ardoise ici, un gris
 * neutre dans l'e-mail de commentaire, et deux messages de la même commune
 * ouverts côte à côte n'avaient pas l'air d'en venir.
 */
const COLORS = {
  primary:    EMAIL_COLORS.brand700,
  success:    EMAIL_COLORS.success,
  warning:    EMAIL_COLORS.progressDot,
  background: EMAIL_COLORS.canvas,
  white:      EMAIL_COLORS.white,
  text:       EMAIL_COLORS.ink,
  textLight:  EMAIL_COLORS.muted,
  border:     EMAIL_COLORS.line,
}

const STATUS_CONFIG = {
  /**
   * Transmis à un service extérieur (migration 034).
   *
   * Le message ne promet pas d'intervention : l'e-mail est parti, personne n'a
   * encore répondu. Dire « pris en charge » ici était la promesse que le
   * statut faisait à tort avant qu'on le sépare en deux.
   */
  transmis: {
    label: 'Transmis au service',
    color: EMAIL_COLORS.progressFg,
    bgColor: EMAIL_COLORS.progressBg,
    message: 'Votre signalement a été transmis au service compétent de la commune. Vous serez prévenu dès qu’il est pris en charge.',
    cta: 'Suivre mon signalement',
  },
  pris_en_charge: {
    label: 'Pris en charge',
    color: EMAIL_COLORS.progressFg,
    bgColor: EMAIL_COLORS.progressBg,
    message: 'Bonne nouvelle ! Vos agents municipaux ont pris en charge votre signalement et vont intervenir prochainement.',
    cta: 'Suivre mon signalement',
  },
  resolu: {
    label: 'Résolu',
    color: EMAIL_COLORS.doneFg,
    bgColor: EMAIL_COLORS.doneBg,
    message: 'Votre signalement a été traité et résolu par les services municipaux. Merci pour votre contribution à l\'amélioration de votre ville !',
    cta: 'Voir la résolution',
  },
  en_attente: {
    label: 'En attente',
    color: EMAIL_COLORS.pendingFg,
    bgColor: EMAIL_COLORS.pendingBg,
    message: 'Votre signalement est en attente de traitement par les services municipaux.',
    cta: 'Voir mon signalement',
  },
}

interface StatusEmailParams {
  reportTitle: string
  reportId: string
  newStatus: 'en_attente' | 'transmis' | 'pris_en_charge' | 'resolu'
  /** Libellé déjà résolu par l'appelant — voir `services/categoryService.ts`. */
  categoryLabel: string
  addressApprox: string | null
  photoUrl: string | null
  createdAt: string
  frontendUrl: string
  /** Lien de désabonnement signé, identique à celui de l'en-tête `List-Unsubscribe`. */
  unsubscribeUrl: string
  cityName?: string
  isAnonymous?: boolean
  anonymousToken?: string | null
}

export const buildStatusEmail = (params: StatusEmailParams): string => {
  const config = STATUS_CONFIG[params.newStatus]
  const categoryLabel = params.categoryLabel
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
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding-right: 10px;">${logoImg(32)}</td>
                        <td><span style="font-size: 24px; font-weight: 700; color: ${COLORS.white};">OnSignale</span></td>
                      </tr>
                    </table>
                  </td>
                  <td style="text-align: right;">
                    <span style="font-size: 14px; color: rgba(255, 255, 255, 0.9); font-weight: 500;">${params.cityName ?? 'OnSignale'}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Status Badge -->
          <tr>
            <td style="padding: 32px 32px 24px 32px; text-align: center;">
              <div style="display: inline-block; background-color: ${config.bgColor}; border: 2px solid ${config.color}; border-radius: 8px; padding: 12px 24px;">
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
                        <td style="padding-bottom: 14px;">
                          <span style="font-size: 18px; font-weight: 600; color: ${COLORS.text};">${params.reportTitle}</span>
                        </td>
                      </tr>
                      ${params.addressApprox ? `
                      <tr>
                        <td style="padding-bottom: 8px;">
                          <span style="font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: ${EMAIL_COLORS.faint};">ADRESSE</span><br />
                          <span style="font-size: 14px; color: ${COLORS.textLight};">${params.addressApprox}</span>
                        </td>
                      </tr>
                      ` : ''}
                      <tr>
                        <td style="padding-bottom: 8px;">
                          <span style="font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: ${EMAIL_COLORS.faint};">CATÉGORIE</span><br />
                          <span style="font-size: 14px; color: ${COLORS.textLight};">${categoryLabel}</span>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <span style="font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: ${EMAIL_COLORS.faint};">SIGNALÉ LE</span><br />
                          <span style="font-size: 14px; color: ${COLORS.textLight};">${formattedDate}</span>
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
              <a href="${params.unsubscribeUrl}" style="font-size: 12px; color: ${COLORS.textLight}; text-decoration: underline;">
                Ne plus recevoir ces e-mails
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
