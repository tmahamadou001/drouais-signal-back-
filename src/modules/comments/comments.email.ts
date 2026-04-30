import { Resend } from 'resend'

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
  reportId: string
  hasPhoto: boolean
}

export async function sendCommentNotification(
  params: CommentNotificationParams
): Promise<void> {
  const {
    to, reportTitle, agentName, agentJobTitle,
    message, tenantName, reportId, hasPhoto,
  } = params

  const agentDisplay = agentJobTitle
    ? `${agentName} — ${agentJobTitle}` 
    : agentName

  const appUrl = process.env.APP_URL
    ?? 'https://onsignale.fr'

  await resend.emails.send({
    from: `OnSignale <noreply@onsignale.fr>`,
    to: [to],
    subject: `Nouveau message sur votre signalement — ${reportTitle}`,
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
        background: #F8FAFC;
        margin: 0; padding: 24px;
      ">
        <div style="
          max-width: 520px; margin: 0 auto;
          background: white; border-radius: 16px;
          border: 1px solid #E2E8F0;
          overflow: hidden;
        ">
          <!-- Header -->
          <div style="
            background: #1A56A0; padding: 24px;
            text-align: center;
          ">
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
              color: #0F172A; margin: 0 0 4px;
            ">
              Nouveau message sur votre signalement
            </p>
            <p style="
              font-size: 13px; color: #64748B;
              margin: 0 0 20px;
            ">
              ${reportTitle}
            </p>

            <!-- Message -->
            <div style="
              background: #F1F5F9;
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
                font-size: 14px; color: #1E293B;
                margin: 0; line-height: 1.6;
              ">
                ${message}
              </p>
              ${hasPhoto ? `
              <p style="
                font-size: 12px; color: #64748B;
                margin: 8px 0 0;
              ">
                📎 Une photo a été jointe
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
            border-top: 1px solid #F1F5F9;
            text-align: center;
          ">
            <p style="
              font-size: 11px; color: #94A3B8;
              margin: 0;
            ">
              Vous recevez cet email car vous avez
              créé un signalement sur OnSignale.
            </p>
          </div>
        </div>
      </body>
      </html>
    `,
  })
}
