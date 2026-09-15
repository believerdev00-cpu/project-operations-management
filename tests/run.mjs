// The test runner behind `npm test`.
//
// Runs each suite in its own process, in sequence, and reports the totals.
// Sequential is deliberate: the suites drive the real API against the real
// database and each seeds and removes accounts with the same `zz-` prefix, so
// running them at once would have them tripping over each other's fixtures.
//
// The API is started here if it is not already running, and stopped again
// afterwards, so `npm test` works from cold without a second terminal. A server
// that was already up is left alone -- it is probably the one being worked on.
//
// Every suite cleans up after itself. They are written against the live
// database rather than a fixture, so they prove the constraints, triggers and
// scoping that only exist there.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const API = process.env.API || 'http://localhost:5000';

// Order matters only in that the cheapest and most self-contained runs first:
// a broken dictionary fails in a second, without touching the database.
const SUITES = [
  ['translations', 'translations.test.mjs', { needsApi: false }],
  ['account security', 'account-security.test.mjs', { needsApi: true }],
  ['approval workflow', 'approval-workflow.test.mjs', { needsApi: true }],
  ['partner access', 'partner-access.test.mjs', { needsApi: true }],
  ['monthly workflow', 'monthly-workflow.test.mjs', { needsApi: true }]
];

const only = process.argv[2];

async function apiIsUp() {
  try {
    const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForApi(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await apiIsUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });
    child.on('close', (code) => {
      // Each suite prints its own tally; parsing it back gives a total across
      // all of them without every suite needing to know about the others.
      const tally = /(\d+) passed, (\d+) failed/.exec(output);
      resolve({
        code,
        passed: tally ? Number(tally[1]) : 0,
        failed: tally ? Number(tally[2]) : (code === 0 ? 0 : 1)
      });
    });
  });
}

const suites = only ? SUITES.filter(([name, file]) => name.includes(only) || file.includes(only)) : SUITES;
if (!suites.length) {
  console.error(`No suite matches "${only}". Available: ${SUITES.map(([name]) => name).join(', ')}`);
  process.exit(1);
}

let server = null;
const needsApi = suites.some(([, , options]) => options.needsApi);

if (needsApi && !(await apiIsUp())) {
  console.log('Starting the API for the test run...');
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: process.env
  });
  if (!(await waitForApi())) {
    console.error('The API did not come up. Check DATABASE_URL and the server log.');
    server.kill();
    process.exit(1);
  }
} else if (needsApi) {
  console.log('Using the API already running on', API);
}

let passed = 0;
let failed = 0;
const results = [];

for (const [name, file] of suites) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
  const result = await runSuite(file);
  passed += result.passed;
  failed += result.failed;
  results.push({ name, ...result });
}

if (server) server.kill();

console.log(`\n${'='.repeat(70)}`);
for (const result of results) {
  const mark = result.failed === 0 && result.code === 0 ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${result.name.padEnd(20)} ${result.passed} passed, ${result.failed} failed`);
}
console.log(`${'='.repeat(70)}\n  ${passed} passed, ${failed} failed across ${results.length} suite(s)\n`);

process.exit(failed || results.some((result) => result.code !== 0) ? 1 : 0);
