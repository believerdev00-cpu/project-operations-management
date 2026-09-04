import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataFile = path.join(__dirname, '..', 'data', 'seedData.js');

export function readSeedData() {
  try {
    const content = fs.readFileSync(dataFile, 'utf8');
    const match = content.match(/export const initialProjects = (\[[\s\S]*?\]);\n\nexport const initialApprovals =/);
    if (!match) return { initialProjects: [], initialApprovals: [], initialMovements: [] };

    const projects = match[1];
    return { initialProjects: Function(`"use strict"; return (${projects});`)(), initialApprovals: [], initialMovements: [] };
  } catch (error) {
    return { initialProjects: [], initialApprovals: [], initialMovements: [] };
  }
}
