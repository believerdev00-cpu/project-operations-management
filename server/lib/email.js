// The one place PMS sends email from: the invitation that tells an external
// partner the Director has given them access.
//
// Sent through Resend (provisioned from the Vercel Marketplace), over its HTTP
// API, so there is no SDK and nothing else in the app knows which service is
// behind it. Two settings switch it on: RESEND_API_KEY, which the Marketplace
// integration puts in the project's environment, and EMAIL_FROM, an address on
// a domain verified in Resend ("GISUMA PMS <pms@example.com>") -- Resend only
// delivers to other people's inboxes from a verified domain.
//
// Every failure answers { sent: false } instead of throwing: an invitation the
// mail service refused must never undo the account the Director just created.
// The caller then shows the Director the link to pass on by hand, which is how
// the app behaves when email is not set up at all.

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10000;

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail({ to, subject, text, html }) {
  if (!emailConfigured()) return { sent: false, reason: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text, html }),
      signal: controller.signal
    });
    if (!response.ok) {
      // The service's own words, never the key: enough to tell an unverified
      // domain from a rate limit in the server log.
      const detail = await response.text().catch(() => '');
      console.error(`Email to the partner was not sent: ${response.status} ${detail.slice(0, 300)}`);
      return { sent: false, reason: 'refused' };
    }
    return { sent: true };
  } catch (error) {
    console.error(`Email to the partner was not sent: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    return { sent: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
