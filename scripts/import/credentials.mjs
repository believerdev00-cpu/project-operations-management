// Where a password the import generates is allowed to go: a file, never the
// console.
//
// `load-plans.mjs` generates passwords in two cases only -- a brand-new
// database, where it signs the seeded Director in and has to choose them a
// password, and `--create-missing-managers`, which makes manager accounts on a
// throwaway database. It used to print both to the console, which is a
// terminal's scrollback, a CI log, or a chat transcript. Now:
//
// * nothing that generates a password runs without `--credentials-out=<path>`;
// * the path must be OUTSIDE the repository (a file inside it is one `git add`
//   from being committed);
// * the file is created new -- an existing file is never overwritten -- with
//   owner-only permissions, and on POSIX those permissions are read back and
//   the file removed again if they did not take;
// * on Windows the run is REFUSED. Node's `mode` does not set Windows ACLs, so
//   a file created there inherits whatever its folder allows and the import
//   cannot guarantee that only its owner can read it. Run such an import from
//   Linux or macOS, or create the accounts in People by hand.
import { appendFileSync, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

// Is `rawPath` an acceptable place for credentials? Pure apart from `exists`,
// which is injectable so the rule can be tested without touching the disk.
export function credentialsTarget(rawPath, { repoRoot, platform = process.platform, exists = existsSync } = {}) {
  if (platform === 'win32') {
    return { ok: false, why: 'generating passwords is refused on Windows: a file created there cannot be restricted to its owner, so the passwords could not be kept private. Run this from Linux or macOS, or create the accounts in People.' };
  }
  if (!rawPath) return { ok: false, why: 'this run would generate passwords; give --credentials-out=<path to a new file outside the repository>' };
  const path = resolve(rawPath);
  if (repoRoot) {
    const inside = relative(resolve(repoRoot), path);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
      return { ok: false, why: `--credentials-out must be outside the repository (${path} is inside it)` };
    }
  }
  if (exists(path)) return { ok: false, why: `--credentials-out names an existing file (${path}); it is never overwritten` };
  return { ok: true, path };
}

// Create the file, new, owner-only. Throws (EEXIST) rather than overwrite.
export function createCredentialsFile(path, { platform = process.platform } = {}) {
  if (platform === 'win32') throw new Error('credentials files are not created on Windows (see credentials.mjs)');
  writeFileSync(path, '# POMS import -- generated passwords. Hand over, then delete this file.\n', { flag: 'wx', mode: 0o600 });
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    unlinkSync(path);
    throw new Error(`could not restrict ${path} to its owner (mode ${mode.toString(8)}); removed it, nothing was written`);
  }
  return path;
}

// One line per account. Appends only to a file this run created.
export function recordCredential(path, { username, note = '', password }) {
  appendFileSync(path, `${username}\t${password}${note ? `\t${note}` : ''}\n`);
}
