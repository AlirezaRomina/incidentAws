import { INCIDENTS } from '../src/incidents';
import { createEnvironment } from '../src/env';
import { execute, initialTermState, promptFor } from '../src/engine/terminal';

// usage: npx tsx scripts/try.ts <incident-id | path/to/incident.ts> "cmd 1" "cmd 2" ...
const arg = process.argv[2] ?? INCIDENTS[0].id;
const inc = arg.endsWith('.ts') ? (await import('../' + arg.replace(/^\.\//, ''))).default : INCIDENTS.find(i => i.id === arg)!;
const env = createEnvironment(inc);
let st = initialTermState(env);
for (const cmd of process.argv.slice(3)) {
  const r = execute(env, st, cmd);
  console.log(promptFor(env, st) + cmd);
  console.log(r.output);
  st = r.state;
}
