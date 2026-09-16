import { OPERATIONS_WITH_CATEGORIES } from '../../shared/categories.js';

export const demoUsers = [
  {
    id: 'usr-admin',
    username: 'admin',
    password: 'admin123',
    name: 'Director Admin',
    role: 'super-admin'
  }
];

// The four business operations of the organisation, as this API serves them.
// Their names, their translations and the categories each one works in are
// defined once, in shared/, and reused here rather than restated: a second copy
// is a second thing to keep in step, and the browser reads the same files.
export const sectors = OPERATIONS_WITH_CATEGORIES;

export const initialProjects = [];

export const initialApprovals = [];

export const initialMovements = [];
