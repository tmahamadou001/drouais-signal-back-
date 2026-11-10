import { EMAIL_COLORS, wordmarkImg } from './brand.js'

/**
 * « Votre commune a rejoint OnSignale ».
 *
 * L'e-mail que la liste d'attente attendait. Un habitant a laissé son adresse
 * dans une commune non partenaire, sur une promesse explicite — « pour savoir
 * quand elle rejoindra la plateforme ». Il peut l'avoir fait des mois plus
 * tôt : le message rappelle donc d'où il vient, faute de quoi il se lit comme
 * une sollicitation.
 *
 * Il ne demande rien et ne crée pas de compte : il annonce, et donne le seul
 * geste qui compte — ouvrir l'application.
 */

export interface CommuneLaunchEmailParams {
  communeName: string
  /** L'accueil public, pour qui lirait depuis un ordinateur. */
  webUrl: string
}

export function buildCommuneLaunchEmail(params: CommuneLaunchEmailParams): {
  html: string
  text: string
} {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OnSignale arrive à ${params.communeName}</title>
</head>
<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.canvas};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${EMAIL_COLORS.canvas};padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

          <tr>
            <td align="center" style="padding-bottom:24px;">
              ${wordmarkImg(26)}
            </td>
          </tr>

          <tr>
            <td style="background-color:${EMAIL_COLORS.white};border-radius:12px;border:1px solid ${EMAIL_COLORS.line};padding:32px;">

              <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;line-height:1.3;color:${EMAIL_COLORS.ink};">
                ${params.communeName} a rejoint OnSignale
              </h1>

              <p style="margin:0 0 16px;font-size:15px;line-height:22px;color:${EMAIL_COLORS.ink};">
                Vous nous aviez laissé votre adresse pour être prévenu. C'est fait : les services
                techniques de ${params.communeName} reçoivent désormais les signalements des
                habitants, et y répondent.
              </p>

              <p style="margin:0 0 24px;font-size:15px;line-height:22px;color:${EMAIL_COLORS.muted};">
                Vous pouvez signaler un problème depuis l'application mobile : une photo, et votre
                position fait le reste. Vous serez tenu au courant à chaque avancée.
              </p>

              <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
                <tr>
                  <td style="background-color:${EMAIL_COLORS.brand700};border-radius:14px;padding:14px 28px;">
                    <a href="${params.webUrl}"
                       style="color:${EMAIL_COLORS.white};font-size:15px;font-weight:600;text-decoration:none;display:inline-block;">
                      Découvrir OnSignale
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-size:12px;line-height:18px;color:${EMAIL_COLORS.faint};">
                Vous recevez ce message parce que vous aviez demandé à être prévenu de l'arrivée
                d'OnSignale à ${params.communeName}. C'est le seul e-mail que cette demande
                déclenche.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const text = `${params.communeName} a rejoint OnSignale

Vous nous aviez laissé votre adresse pour être prévenu. C'est fait : les services techniques de ${params.communeName} reçoivent désormais les signalements des habitants, et y répondent.

Vous pouvez signaler un problème depuis l'application mobile : une photo, et votre position fait le reste.

${params.webUrl}

Vous recevez ce message parce que vous aviez demandé à être prévenu de l'arrivée d'OnSignale à ${params.communeName}. C'est le seul e-mail que cette demande déclenche.

— L'équipe OnSignale`

  return { html, text }
}
