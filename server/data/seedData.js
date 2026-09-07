export const demoUsers = [
  {
    id: 'usr-admin',
    username: 'admin',
    password: 'admin123',
    name: 'Director Admin',
    role: 'super-admin'
  }
];

// Categories are the kinds of work or item an activity can be booked against.
// They are offered as a preset list per sector; anything not listed is still
// accepted, because the form lets the user pick "Other" and type a value.
export const sectors = [
  {
    id: 'farming',
    name: 'Farming Activity',
    shortName: 'Farming',
    categories: [
      'Land preparation', 'Planting and sowing', 'Irrigation', 'Fertilizer and inputs',
      'Pest and disease control', 'Livestock and animal feed', 'Harvesting',
      'Storage and preservation', 'Farm equipment and tools', 'Farm labour'
    ]
  },
  {
    id: 'mining',
    name: 'Mining Activity',
    shortName: 'Mining',
    categories: [
      'Exploration and survey', 'Extraction', 'Haulage', 'Washing and sorting',
      'Processing', 'Site preparation and access roads', 'Machinery and equipment',
      'Safety and protective equipment', 'Licenses and permits', 'Mining labour'
    ]
  },
  {
    id: 'agriculture',
    name: 'Agriculture Activity',
    shortName: 'Agriculture',
    categories: [
      'Seeds and seedlings', 'Land preparation', 'Planting', 'Crop maintenance',
      'Fertilizer and agro-inputs', 'Harvesting', 'Post-harvest handling',
      'Storage and warehousing', 'Transport to market', 'Agricultural labour'
    ]
  },
  {
    id: 'movement',
    name: 'Logistics & Facilitation',
    shortName: 'Logistics',
    categories: [
      'Vehicle hire', 'Fuel and lubricants', 'Freight and haulage', 'Border clearance',
      'Permits and licenses', 'Escort and security', 'Warehousing and handling',
      'Loading and offloading', 'Travel and allowances', 'Documentation and administration'
    ]
  }
];

export const initialProjects = [];

export const initialApprovals = [];

export const initialMovements = [];
