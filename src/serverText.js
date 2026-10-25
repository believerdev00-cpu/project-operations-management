// A sentence the server sent, in the reader's language.
//
// The API answers in English: a refusal's `message`, or the confirmation some
// routes send back ("Access restored."). Every such sentence is also in the
// dictionary -- apiMessage.* word for word, apiPattern.* with the values it
// carries written {0}, {1}... -- so the screen can find it by its English and
// show the translation instead. A sentence that is not there (changed on the
// server, or new) is shown as the server sent it: English, never an empty box.
// tests/translations.test.mjs fails when a server sentence has no entry.
//
// Values inside a sentence -- a name, a number, a status -- are put back as
// the server sent them.
import { englishEntries, fill } from './i18n.js';

let fixed = null;
let patterns = null;

function index() {
  if (fixed) return;
  fixed = new Map(englishEntries('apiMessage.').map(([key, en]) => [en, key]));
  patterns = englishEntries('apiPattern.').map(([key, en]) => {
    const names = [];
    const source = en.split(/(\{\d+\})/).map((part) => {
      const hole = /^\{(\d+)\}$/.exec(part);
      if (hole) { names.push(hole[1]); return '([\\s\\S]+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    // The sentence with the most fixed words wins when two would match, so
    // "{0} not found." never takes "External partner not found." from its own
    // entry (exact sentences are looked up first anyway).
    return { key, names, regex: new RegExp(`^${source}$`), weight: en.replace(/\{\d+\}/g, '').length };
  }).sort((a, b) => b.weight - a.weight);
}

export function serverText(message, t) {
  if (!message || typeof message !== 'string') return message;
  index();
  const key = fixed.get(message);
  if (key) return t(key);
  for (const pattern of patterns) {
    const match = pattern.regex.exec(message);
    if (match) {
      const values = Object.fromEntries(pattern.names.map((name, i) => [name, match[i + 1]]));
      return fill(t(pattern.key), values);
    }
  }
  return message;
}
