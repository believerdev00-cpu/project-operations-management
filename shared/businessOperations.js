// The four business operations of the organisation. There are no others, and
// none of them is a generic "sector N" placeholder:
//
//   BUSINESS OPERATIONS
//   ├── Farming
//   ├── Agriculture
//   ├── Mining
//   └── Movements & Facilitation
//
// Imported by both the API and the browser so the two can never disagree about
// what exists or what it is called.
//
// The `id` values are the ones already stored in every foreign key in the
// database -- activities.sector, movements.related_area, users.sector, and so
// on -- so they are deliberately left alone. Only the human-readable names are
// defined here. In particular the Logistics operation keeps the id 'movement'
// while reading as "Movements & Facilitation".

export const BUSINESS_OPERATIONS = [
  {
    id: 'farming',
    name: 'Farming',
    shortName: 'Farming',
    translations: {
      en: 'Farming',
      // Ubuhinzi is crop growing generally; farming as a going concern is
      // ubuhinzi n'ubworozi -- growing and keeping livestock together.
      rw: 'Ubuhinzi n’Ubworozi',
      fr: 'Agriculture et élevage',
      sw: 'Kilimo na Ufugaji'
    }
  },
  {
    id: 'agriculture',
    name: 'Agriculture',
    shortName: 'Agriculture',
    translations: {
      en: 'Agriculture',
      rw: 'Ubuhinzi',
      // Agronomie rather than agriculture, so this operation and Farming do not
      // both come out as "agriculture" in French.
      fr: 'Agronomie',
      sw: 'Kilimo'
    }
  },
  {
    id: 'mining',
    name: 'Mining',
    shortName: 'Mining',
    translations: {
      en: 'Mining',
      rw: 'Ubucukuzi bw’Amabuye y’Agaciro',
      fr: 'Exploitation minière',
      sw: 'Uchimbaji Madini'
    }
  },
  {
    id: 'movement',
    name: 'Movements & Facilitation',
    shortName: 'Movements',
    translations: {
      en: 'Movements & Facilitation',
      rw: 'Ingendo n’Ubufasha',
      fr: 'Déplacements et facilitation',
      sw: 'Safari na Uwezeshaji'
    }
  }
];

export const OPERATION_IDS = BUSINESS_OPERATIONS.map((operation) => operation.id);

export function operationById(id) {
  return BUSINESS_OPERATIONS.find((operation) => operation.id === id) || null;
}

// The name of an operation in the reader's language, falling back to English
// and finally to the raw id, so an unknown value is still legible rather than
// rendering as an empty cell.
export function operationName(id, language = 'en') {
  const operation = operationById(id);
  if (!operation) return id || '';
  return operation.translations[language] || operation.translations.en || operation.name;
}
