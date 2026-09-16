// The kinds of work each business operation does.
//
// One copy, read by the browser and by the API. This list used to be written out
// twice -- in src/App.jsx and in server/data/seedData.js -- with a note on each
// saying it had to be kept in step with the other. It now also has a third
// reader (the monthly plan screens, where the Director says what a month is
// about), and three copies of a list is three chances for a category to be
// spelled one way on one screen and another way on the next.
//
// The operations themselves -- their ids and their names in all four languages --
// are in ./businessOperations.js, so this file never restates what an operation
// is called.

import { BUSINESS_OPERATIONS } from './businessOperations.js';

export const CATEGORIES = {
  farming: [
    'Land preparation', 'Planting and sowing', 'Irrigation', 'Fertilizer and inputs',
    'Pest and disease control', 'Livestock and animal feed', 'Harvesting',
    'Storage and preservation', 'Farm equipment and tools', 'Farm labour'
  ],
  mining: [
    'Exploration and survey', 'Extraction', 'Haulage', 'Washing and sorting',
    'Processing', 'Site preparation and access roads', 'Machinery and equipment',
    'Safety and protective equipment', 'Licenses and permits', 'Mining labour'
  ],
  agriculture: [
    'Seeds and seedlings', 'Land preparation', 'Planting', 'Crop maintenance',
    'Fertilizer and agro-inputs', 'Harvesting', 'Post-harvest handling',
    'Storage and warehousing', 'Transport to market', 'Agricultural labour'
  ],
  movement: [
    'Vehicle hire', 'Fuel and lubricants', 'Freight and haulage', 'Border clearance',
    'Permits and licenses', 'Escort and security', 'Warehousing and handling',
    'Loading and offloading', 'Travel and allowances', 'Documentation and administration'
  ]
};

// Each operation with its categories attached, which is the shape both the API's
// seed data and the browser's forms want.
export const OPERATIONS_WITH_CATEGORIES = BUSINESS_OPERATIONS.map((operation) => ({
  ...operation,
  categories: CATEGORIES[operation.id] || []
}));

export function categoriesForOperation(operationId) {
  return CATEGORIES[operationId] || [];
}

// What a form offers when none of the presets fit. The value is stored as the
// category, so it is a real string rather than a marker the API would have to
// know about.
export const OTHER_CATEGORY = 'Other (specify)';
