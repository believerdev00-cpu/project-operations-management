import { BUSINESS_OPERATIONS } from '../../shared/businessOperations.js';

export const demoUsers = [
  {
    id: 'usr-admin',
    username: 'admin',
    password: 'admin123',
    name: 'Director Admin',
    role: 'super-admin'
  }
];

// The categories of work an activity can be booked against, per business
// operation. They are offered as a preset list; anything not listed is still
// accepted, because the form lets the user pick "Other" and type a value.
const CATEGORIES = {
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

// The four business operations of the organisation, as this API serves them.
// Their names and translations are defined once, in shared/businessOperations.js,
// and reused here rather than restated: a second copy is a second thing to keep
// in step, and the browser reads the same file.
export const sectors = BUSINESS_OPERATIONS.map((operation) => ({
  ...operation,
  categories: CATEGORIES[operation.id] || []
}));

export const initialProjects = [];

export const initialApprovals = [];

export const initialMovements = [];
