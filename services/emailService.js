const nodemailer = require('nodemailer')

let transporter = null

function getTransporter() {
  if (transporter) return transporter

  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com'
  const smtpPort = parseInt(process.env.SMTP_PORT || '587')
  const smtpUser = process.env.SMTP_USER || ''
  const smtpPass = process.env.SMTP_PASS || ''

  if (!smtpUser || !smtpPass) {
    console.warn('[EmailService] SMTP not configured — emails will be logged')
    return null
  }

  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  })

  return transporter
}

async function sendEmail({ to, subject, html }) {
  const t = getTransporter()
  if (!t) {
    console.log(`[EmailService] Would send email to ${to}: ${subject}`)
    return { logged: true }
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@dalletek.live'

  const info = await t.sendMail({ from, to, subject, html })
  console.log(`[EmailService] Sent email to ${to}: ${info.messageId}`)
  return info
}

module.exports = { sendEmail }
