import { plainSubject, logoImg } from '../../templates/brand.js'
import { Resend } from 'resend'
import { unsubscribeUrl } from '../../services/notificationPreferences.js'

const resend = new Resend(
  process.env.RESEND_API_KEY
)

interface CommentNotificationParams {
  to: string
  reportTitle: string
  agentName: string
  agentJobTitle?: string
  message: string
  tenantName: string
  tenantSlug: string
  reportId: string
  hasPhoto: boolean
}

export async function sendCommentNotification(
  params: CommentNotificationParams
): Promise<void> {
  const {
    to, reportTitle, agentName, agentJobTitle,
    message, tenantName, tenantSlug, reportId, hasPhoto,
  } = params

  const agentDisplay = agentJobTitle
    ? `${agentName} — ${agentJobTitle}`
    : agentName

  const baseUrl = process.env.APP_URL ?? 'https://onsignale.fr'
  const appUrl = baseUrl.replace('://', `://${tenantSlug}.`)

  await resend.emails.send({
    from: `OnSignale <noreply@onsignale.fr>`,
    to: [to],
    subject: plainSubject(`Nouveau message sur votre signalement — ${reportTitle}`),
    headers: {
      // Même exigence que pour les e-mails de statut : Gmail affiche ce
      // bouton, et il doit réellement désabonner.
      'List-Unsubscribe': `<${unsubscribeUrl(to)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    html: `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport"
              content="width=device-width,
                       initial-scale=1.0">
      </head>
      <body style="
        font-family: system-ui, sans-serif;
        background: #F6F7F9;
        margin: 0; padding: 24px;
      ">
        <div style="
          max-width: 520px; margin: 0 auto;
          background: white; border-radius: 16px;
          border: 1px solid #E2E5EA;
          overflow: hidden;
        ">
          <!-- Header -->
          <div style="
            background: #1A56A0; padding: 24px;
            text-align: center;
          ">
            <!-- La marque manquait sur ce seul e-mail : une notification de
                 message arrivait avec un bandeau bleu sans signe, quand toutes
                 les autres portaient le logo. -->
            <div style="margin: 0 auto 10px; width: 36px;">${logoImg(36, 9)}</div>
            <p style="
              color: white; font-size: 20px;
              font-weight: 700; margin: 0;
            ">OnSignale</p>
            <p style="
              color: rgba(255,255,255,0.75);
              font-size: 13px; margin: 4px 0 0;
            ">${tenantName}</p>
          </div>

          <!-- Body -->
          <div style="padding: 28px 24px;">
            <p style="
              font-size: 16px; font-weight: 600;
              color: #0F2B4A; margin: 0 0 4px;
            ">
              Nouveau message sur votre signalement
            </p>
            <p style="
              font-size: 13px; color: #6B7280;
              margin: 0 0 20px;
            ">
              ${reportTitle}
            </p>

            <!-- Message -->
            <div style="
              background: #F6F7F9;
              border-radius: 12px;
              padding: 16px; margin-bottom: 20px;
            ">
              <p style="
                font-size: 12px; font-weight: 600;
                color: #1A56A0; margin: 0 0 8px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
              ">
                ${agentDisplay}
              </p>
              <p style="
                font-size: 14px; color: #111827;
                margin: 0; line-height: 1.6;
              ">
                ${message}
              </p>
              ${hasPhoto ? `
              <p style="
                font-size: 12px; color: #6B7280;
                margin: 8px 0 0;
              ">
                Une photo a été jointe
              </p>` : ''}
            </div>

            <!-- CTA -->
            <a href="${appUrl}/signalement/${reportId}"
               style="
                 display: block; text-align: center;
                 background: #1A56A0; color: white;
                 padding: 13px; border-radius: 10px;
                 font-size: 14px; font-weight: 600;
                 text-decoration: none;
               ">
              Voir le signalement et répondre →
            </a>
          </div>

          <!-- Footer -->
          <div style="
            padding: 16px 24px;
            border-top: 1px solid #F6F7F9;
            text-align: center;
          ">
            <p style="
              font-size: 11px; color: #9CA3AF;
              margin: 0;
            ">
              Vous recevez cet email car vous avez
              créé un signalement sur OnSignale.
              <br>
              <a href="${unsubscribeUrl(to)}"
                 style="color: #9CA3AF;">Se désabonner</a>
            </p>
          </div>
        </div>
      </body>
      </html>
    `,
  })
}
