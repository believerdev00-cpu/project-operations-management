import bcrypt from 'bcryptjs';

// One password policy for every way a password is set: the Director creating or
// resetting an account, a partner invitation, and an owner choosing their own.
// Six characters was the old minimum; it was raised because nothing else slows a
// guess once an attacker is past the login limiter.
export const MINIMUM_PASSWORD_LENGTH = 8;
export const BCRYPT_ROUNDS = 10;

// Returns the sentence to show, or null when the password is acceptable. The
// value is trimmed the same way it is stored, so what is checked is what is kept.
export function passwordProblem(password, { username } = {}) {
  if (typeof password !== 'string' || password.trim().length < MINIMUM_PASSWORD_LENGTH) {
    return `The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
  }
  // bcrypt ignores everything after 72 bytes, so a longer password would
  // silently accept any text that shares its first 72 bytes.
  if (Buffer.byteLength(password.trim(), 'utf8') > 72) {
    return 'The password must be at most 72 characters.';
  }
  if (username && password.trim().toLowerCase() === String(username).trim().toLowerCase()) {
    return 'The password must not be the same as the username.';
  }
  return null;
}

export function hashPassword(password) {
  return bcrypt.hash(password.trim(), BCRYPT_ROUNDS);
}

// Compared against a real hash even when the account does not exist, so an
// unknown username takes as long to refuse as a wrong password -- answering
// faster told an attacker which usernames were real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-for-timing', BCRYPT_ROUNDS);

// Accounts have been created with the password trimmed, so a password typed
// with a stray trailing space was hashed without it. The exact text is checked
// first and the trimmed text second, so both sign in. Asynchronous, so a burst
// of sign-ins no longer blocks every other request while bcrypt runs.
export async function passwordMatches(typed, hash) {
  const text = typeof typed === 'string' ? typed : '';
  const stored = hash || DUMMY_HASH;
  let matches = await bcrypt.compare(text, stored);
  if (!matches && text.trim() !== text) matches = await bcrypt.compare(text.trim(), stored);
  return Boolean(hash) && matches;
}
