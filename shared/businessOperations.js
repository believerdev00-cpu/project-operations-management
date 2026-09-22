// The operations of the organisation. There are no others, and none of them is
// a generic "sector N" placeholder.
//
// THE STRUCTURE IS NOT FOUR EQUAL COLUMNS. Three operations produce; the fourth
// exists to serve them:
//
//   PRIMARY OPERATIONS (they produce)      id
//   ├── Mining                             mining
//   ├── Agriculture                        agriculture
//   └── Farming                            farming
//
//   SUPPORT FUNCTION (it coordinates the three)
//   └── Movement & Facilitation            movement
//         transport, movement of people and materials, logistics and the
//         other facilitation the three primary operations need.
//
// Movement & Facilitation is NOT a fourth production operation. It has its own
// manager and its own monthly plan like the others -- but the work on that plan
// is support given TO Mining, Agriculture or Farming, and the system keeps that
// link: an objective on its plan names the primary operation it supports (see
// plan_objectives.supports_operation).
//
// It is still an entry in this list, and still a value of users.sector and
// monthly_plans.sector, because that is what gives it a manager, a month, a
// budget and a place in every scoping rule. `kind` is what tells the two apart.
//
// Imported by both the API and the browser so the two can never disagree about
// what exists or what it is called. The `id` values are stored in every foreign
// key in the database -- activities.sector, movements.related_area,
// users.sector, monthly_plans.sector and more -- so they can never change. Only
// the human-readable names live here.

export const BUSINESS_OPERATIONS = [
  {
    id: 'farming',
    name: 'Farming',
    kind: 'primary',
    shortName: 'Farming',
    translations: {
      en: 'Farming',
      // Ubuhinzi is crop growing generally; farming as a going concern is
      // ubuhinzi n'ubworozi -- growing and keeping livestock together.
      rw: 'Ubuhinzi n’Ubworozi',
      // "Agriculture et élevage" rather than plain "Agriculture", which is the
      // Agriculture operation below, so the two do not read alike in French.
      fr: 'Agriculture et élevage',
      sw: 'Kilimo na Ufugaji'
    }
  },
  {
    id: 'agriculture',
    name: 'Agriculture',
    kind: 'primary',
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
    kind: 'primary',
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
    name: 'Movement & Facilitation',
    kind: 'support',
    shortName: 'Movement',
    translations: {
      // THE SUPPORT FUNCTION, not a fourth production operation. It coordinates
      // transport, the movement of people and materials, logistics and the other
      // facilitation that Mining, Agriculture and Farming need.
      //
      // It has a manager and a monthly plan like the three, because that is how
      // work gets recorded against it. What makes it different is that its
      // objectives name the primary operation they support, so "50 transport
      // trips" is always visible as 50 trips FOR Mining rather than as an
      // unattached number of its own.
      en: 'Movement & Facilitation',
      rw: 'Ingendo n’Ubufasha',
      fr: 'Déplacements et facilitation',
      sw: 'Safari na Uwezeshaji'
    }
  }
];

export const OPERATION_IDS = BUSINESS_OPERATIONS.map((operation) => operation.id);

// The three operations that produce. A Movement & Facilitation objective
// supports one of these, and nothing supports the support function itself.
export const PRIMARY_OPERATIONS = BUSINESS_OPERATIONS.filter((operation) => operation.kind === 'primary');
export const PRIMARY_OPERATION_IDS = PRIMARY_OPERATIONS.map((operation) => operation.id);

// The coordinating function, by id.
export const SUPPORT_OPERATION = 'movement';

export function isPrimaryOperation(id) {
  return PRIMARY_OPERATION_IDS.includes(id);
}

// Whether this id is the coordination/support function rather than an operation
// that produces. Read this instead of comparing against 'movement' by hand: the
// id is historical and says nothing about what the operation is.
export function isSupportOperation(id) {
  return id === SUPPORT_OPERATION;
}

// Which operation runs the trips register: Movement & Facilitation, because
// coordinating transport and the movement of people and materials for the three
// primary operations is precisely what that function is for.
//
// WHY THIS IS A CONSTANT AND NOT A LITERAL: the answer is needed in six places
// across the API and the browser -- who may raise a trip, who may edit one, who
// sees the whole register rather than only their own area's trips, which
// partner sees the unlinked ones, and whether the Trips page appears in the
// nav. Written out by hand in each, they drifted the moment the operation
// changed. Importing this is the only way the client and the server can be sure
// they are gating on the same operation.
export const TRIPS_OPERATION = SUPPORT_OPERATION;

// Whether this account runs the trips register, as opposed to merely being able
// to see the trips that touch their own operation. A manager covering every
// operation runs it too; a team member never does -- following their operation's
// trips is not the same as raising one.
export function runsTrips(user) {
  if (!user) return false;
  if (user.coversAllSectors) return true;
  return user.role === 'manager' && user.sector === TRIPS_OPERATION;
}

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
