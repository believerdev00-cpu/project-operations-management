// The browser's side of the translations: the React context, the hooks, and the
// language the reader chose.
//
// THE DICTIONARY ITSELF IS IN shared/strings.js, with `translate`, `fill`,
// `LANGUAGES` and the test helpers. It moved there because the API needs the
// same words -- a report exported as a PDF or a spreadsheet is written in the
// language its reader chose -- and this module imports React, which the API
// must not. Everything it exports is re-exported below, so every call site
// still imports what it always did from './i18n.js'.
//
// What stays here is everything that only a browser can do: localStorage, the
// `navigator.language` fallback, the context and the hooks.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  LANGUAGES, LANGUAGE_CODES, fill, knownLanguage, missingTranslations, translate, translationKeys, englishEntries
} from '../shared/strings.js';

export { LANGUAGES, LANGUAGE_CODES, englishEntries, fill, knownLanguage, missingTranslations, translate, translationKeys };

const STORAGE_KEY = 'ops-language';

export function storedLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGE_CODES.includes(saved)) return saved;
    // Fall back to the browser's own preference before English, so a
    // Kinyarwanda, French or Kiswahili speaker is not made to change it on
    // every visit.
    const preferred = (navigator?.language || 'en').slice(0, 2).toLowerCase();
    return LANGUAGE_CODES.includes(preferred) ? preferred : 'en';
  } catch {
    return 'en';
  }
}

// The language the display helpers that are NOT React components should use --
// the ones called from inside tables and previews to name an operation or a
// deadline. They cannot call a hook, and threading a prop into every one of
// them would touch every component for a lookup. App sets this synchronously at
// the top of its render, so a language change is reflected on the same render.
// It is only ever read for display.
let currentLanguage = 'en';

export function setDisplayLanguage(language) {
  currentLanguage = language;
}

export function displayLanguage() {
  return currentLanguage;
}

// Carried through the tree rather than passed down every component signature:
// the tables, forms and detail panels that need it sit several levels below the
// screen that knows the language, and threading a prop through each one would
// touch every component for nothing.
export const LanguageContext = createContext({
  language: 'en',
  setLanguage: () => {},
  t: (key) => translate('en', key)
});

export function useT() {
  return useContext(LanguageContext).t;
}

export function useI18n() {
  return useContext(LanguageContext);
}

export function useLanguage() {
  const [language, setLanguage] = useState(storedLanguage);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // A browser with storage blocked still works; the choice just does not
      // survive a reload.
    }
    document.documentElement.lang = language;
  }, [language]);

  const t = useCallback((key) => translate(language, key), [language]);

  return { language, setLanguage, t };
}
