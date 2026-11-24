// Destructive check: does the bridge notice that SOLIDWORKS died, and say so?
//
// This runs in its own file because it stops SOLIDWORKS. Run it deliberately,
// not as part of the normal suite.
//
// The failure it guards against is the one that cost a whole session: a dead
// instance reported as "not running", or worse, as ready.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, '..', 'bridge', 'bin', 'SwBridge.exe');
if (!existsSync(exe)) throw new Error(`missing bridge at ${exe}`);

const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
let buf = '';
const pending = new Map();
let seq = 0;
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const p = pending.get(String(msg.id));
    if (p) { pending.delete(String(msg.id)); p(msg); }
  }
});
const send = (op, args = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(String(id), resolve);
  child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
});

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const before = await send('status');
check('starts ready', before.ready === true, `${before.reason}`);
const pid = before.processId;
check('reports a real pid', Number.isInteger(pid) && pid > 0, String(pid));

const ping = await send('ping');
check('ping alive before kill', ping.alive === true);

console.log(`  ..   killing SOLIDWORKS pid ${pid}`);
spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
await new Promise((r) => setTimeout(r, 4000));

const after = await send('status');
check('status no longer claims ready', after.ready === false, String(after.ready));
check('status names the crash', after.reason === 'crashed', String(after.reason));
check('status keeps the dead pid for the user', after.processId === pid, String(after.processId));
check('status offers a next step', Array.isArray(after.action) && after.action.length > 0,
  JSON.stringify(after.action));

const ping2 = await send('ping');
check('ping after kill is a clean failure, not a hang',
  ping2.ok === false && ping2.error && ping2.error.code === 'crashed',
  JSON.stringify(ping2.error || {}).slice(0, 160));

child.stdin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
