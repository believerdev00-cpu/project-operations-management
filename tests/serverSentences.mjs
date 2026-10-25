// Every sentence the API can put in front of somebody, read from the server's
// source: a `message:`, an error thrown with a status, a refusal, and the
// partner-status wording. A sentence with values inside it comes back with
// each ${...} written {0}, {1}... -- the form its apiPattern.* entry takes in
// shared/strings.js. Used by tests/translations.test.mjs to fail when one of
// them has no translation (src/serverText.js finds them by their English).
import fs from 'node:fs';
import path from 'node:path';

const LITERAL = String.raw`('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\]|\\.)*\x60)`;
const PATTERNS = [
  new RegExp(String.raw`message:\s*` + LITERAL, 'g'),
  new RegExp(String.raw`new (?:BoutiqueError|FarmError|ReportError|HttpError|Error)\(\s*\d{3}\s*,\s*` + LITERAL, 'g'),
  new RegExp(String.raw`new BoutiqueError\(\s*\d{3}\s*,\s*minimum > 0\s*\?\s*` + LITERAL + String.raw`\s*:\s*` + LITERAL, 'g'),
  new RegExp(String.raw`refuse\([^,]+,\s*res,\s*\d{3},\s*` + LITERAL, 'g'),
  new RegExp(String.raw`(?:active|suspended|revoked): ` + LITERAL, 'g')
];

function serverFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['uploads', 'data'].includes(entry.name)) found.push(...serverFiles(full)); }
    else if (full.endsWith('.js')) found.push(full);
  }
  return found;
}

// `${a} of ${b}` -> `{0} of {1}`, braces inside an expression included.
function withHoles(body) {
  let out = '';
  let n = 0;
  for (let i = 0; i < body.length;) {
    if (body.startsWith('${', i)) {
      let depth = 1;
      let j = i + 2;
      while (j < body.length && depth) { if (body[j] === '{') depth += 1; else if (body[j] === '}') depth -= 1; j += 1; }
      out += `{${n}}`; n += 1; i = j;
    } else { out += body[i]; i += 1; }
  }
  return out;
}

export function serverSentences(root) {
  const sentences = new Map();
  for (const file of serverFiles(path.join(root, 'server'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) for (const match of source.matchAll(pattern)) {
      for (const literal of match.slice(1).filter(Boolean)) {
        const body = literal.slice(1, -1);
        const dynamic = literal[0] === '`' && body.includes('${');
        const en = dynamic ? withHoles(body) : body.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`');
        sentences.set(en, { en, dynamic, file: path.relative(root, file) });
      }
    }
  }
  return [...sentences.values()];
}
