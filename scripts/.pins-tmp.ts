import { createEnvironment } from '../src/env';
import { pinnablesFor } from '../src/engine/pins';
const inc = (await import('../' + process.argv[2])).default;
const env = createEnvironment(inc);
const tools = (process.argv[3] ?? 'cloudwatch').split(',');
const filt = process.argv[4] ? new RegExp(process.argv[4]) : undefined;
for (const t of tools) for (const p of pinnablesFor(env, t as never)) if (!filt || filt.test(p.text)) console.log(`[${t}] ${p.text.slice(0, 700)}`);
