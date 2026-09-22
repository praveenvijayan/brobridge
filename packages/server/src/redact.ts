/**
 * Redaction for anything that might reach a log.
 *
 * A launch token in a log line is a launch token in a support ticket
 * (`THREAT-MODEL.md` §5.6, §5.14). Every diagnostic path in this package goes
 * through {@link redact} first.
 */
import { LAUNCH_TOKEN_PARAM } from './auth.js';

const REDACTED = '[redacted]';

const TOKEN_IN_URL = new RegExp(`([?&]${LAUNCH_TOKEN_PARAM}=)[^&\\s"']+`, 'gi');
const COOKIE_HEADER = /\b(set-cookie|cookie)\s*:\s*[^\n\r]*/gi;
const SESSION_COOKIE = /\b(bb_session(?:_\d+)?)=[^;\s]+/gi;

/** Replace launch tokens and cookie material in `text` with a marker. */
export function redact(text: string): string {
  return text
    .replace(TOKEN_IN_URL, `$1${REDACTED}`)
    .replace(COOKIE_HEADER, (match) => `${match.slice(0, match.indexOf(':') + 1)} ${REDACTED}`)
    .replace(SESSION_COOKIE, `$1=${REDACTED}`);
}
