// Exercises the bridge's new surface directly over its line protocol.
//
// The point of driving the bridge rather than the MCP server here is that a
// bridge defect and a server defect look identical from the outside; this file
// pins the bridge half.
//
// Usage:  node test/bridge2.mjs [--live]
//         --live also runs the operations that need a running SOLIDWORKS.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, '..', 'bridge', 'bin');

function newestBridge() {
  const exe = join(binDir, 'SwBridge.exe');
  if (existsSync(exe)) return exe;
  const names = readdirSync(binDir).filter((n) => /^SwBridge.*\.exe$/i.test(n));
  if (!names.length) throw new Error(`no bridge executable in ${binDir}`);
  names.sort((a, b) => statSync(join(binDir, b)).mtimeMs - statSync(join(binDir, a)).mtimeMs);
  return join(binDir, names[0]);
}

class Bridge {
  constructor(exe) {
    this.child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.buf = '';
    this.pending = new Map();
    this.seq = 0;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.stderr = '';
    this.child.stderr.on('data', (c) => { this.stderr += c; });
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`bridge exited ${code}: ${this.stderr}`));
      this.pending.clear();
    });
  }
  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(String(msg.id));
      if (p) { this.pending.delete(String(msg.id)); p.resolve(msg); }
    }
  }
  send(op, args = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
      setTimeout(() => {
        if (this.pending.has(String(id))) {
          this.pending.delete(String(id));
          reject(new Error(`timeout waiting for ${op}`));
        }
      }, 120000);
    });
  }
  close() { try { this.child.stdin.end(); } catch {} }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const live = process.argv.includes('--live');
const b = new Bridge(newestBridge());

try {
  console.log('bridge surface');
  const version = await b.send('version');
  check('version.op=version', version.op === 'version', JSON.stringify(version).slice(0, 120));
  check('version.bridge>=0.2.0', version.ok && String(version.bridge) >= '0.2.0', version.bridge);
  // 协议号只增不减；断言「不是 1」而不是钉死一个数，否则每次加 op 都要改测试。
check('version.protocol >= 3', version.protocol >= 3, String(version.protocol));
  check('version.interop present', Boolean(version.interop), String(version.interop));

  const summary = await b.send('interopIndex', { mode: 'summary' });
  check('interopIndex.summary ok', summary.ok === true);
  check('interopIndex.sldworksTypes>1000', summary.sldworksTypes > 1000, String(summary.sldworksTypes));
  check('interopIndex.interopVersion', typeof summary.interopVersion === 'string');

  const types = await b.send('interopIndex', { mode: 'types', limit: 5 });
  check('interopIndex.types paginates', types.types.length === 5 && types.total > 100,
    `${types.returned}/${types.total}`);
  check('interopIndex.types nextOffset', typeof types.nextOffset === 'number');

  const iface = await b.send('interopIndex', { mode: 'iface', iface: 'IFeatureManager' });
  check('interopIndex.iface ok', iface.ok === true && iface.memberCount > 50, String(iface.memberCount));
  const extrusion = iface.members.find((m) => m.name === 'FeatureExtrusion3');
  check('iface lists FeatureExtrusion3', Boolean(extrusion), 'missing');
  check('iface FeatureExtrusion3 has 23 params',
    extrusion && extrusion.paramCount === 23, extrusion && String(extrusion.paramCount));

  const search = await b.send('interopIndex', { mode: 'search', q: 'LinearPattern' });
  check('interopIndex.search finds patterns', search.ok && search.count > 0, String(search.count));

  const addins = await b.send('addins');
  check('addins ok', addins.ok === true);
  check('addins.count>=10', addins.count >= 10, String(addins.count));
  check('addins not probed by default', addins.probed === false);
  check('addins entries carry clsid', Array.isArray(addins.entries)
    && addins.entries.every((e) => typeof e.clsid === 'string' && e.clsid.startsWith('{')));

  const status = await b.send('status');
  check('status returns a state', status.ok === true && typeof status.ready === 'boolean');
  check('status reports a specific reason when not ready',
    status.ready === true || ['not-running', 'crashed', 'not-reachable', 'blocked-by-dialog']
      .includes(status.reason), String(status.reason));

  if (live) {
    console.log('live surface (requires SOLIDWORKS)');
    const ping = await b.send('ping');
    check('ping alive', ping.ok === true && ping.alive === true, JSON.stringify(ping).slice(0, 160));
    check('ping round trip is fast', ping.roundTripMs < 5000, String(ping.roundTripMs));

    // Reflective invoke is the escape hatch: prove it reaches a real member.
    const invoke = await b.send('invoke', {
      target: 'app', iface: 'ISldWorks', member: 'RevisionNumber',
    });
    check('invoke reaches a member', invoke.ok === true, JSON.stringify(invoke.error || {}).slice(0, 200));
    check('invoke reports a signature', typeof invoke.signature === 'string', invoke.signature);
    check('invoke returns the member value',
      typeof invoke.result === 'string' && /^\d+\.\d+/.test(invoke.result), String(invoke.result));

    // Overload resolution: GetUserPreferenceToggle takes a single int.
    const invoke2 = await b.send('invoke', {
      target: 'app', iface: 'ISldWorks', member: 'GetUserPreferenceToggle', args: [85],
    });
    check('invoke resolves an overload by args', invoke2.ok === true,
      JSON.stringify(invoke2.error || {}).slice(0, 200));
    check('invoke overload picked 1 param', invoke2.signature && invoke2.signature.endsWith('Int32) -> Boolean')
      || (invoke2.signature || '').includes('Int32'), invoke2.signature);

    // 报错要能自纠：一个会话里曾连挂四次 UNKNOWN_MEMBER，因为错误只说「没有匹配的
    // 重载」。参数个数不对时给出签名与实参，目标对象不对时指出它其实在哪个 target。
    const wrongArgs = await b.send('invoke', {
      target: 'app', member: 'RevisionNumber', args: [1, 2, 3],
    })
    check('参数个数不对时失败', wrongArgs.ok === false && wrongArgs.error?.code === 'UNKNOWN_MEMBER',
      JSON.stringify(wrongArgs.error || {}).slice(0, 160))
    check('错误里说清楚实际传了几个参数',
      wrongArgs.error?.detail?.supplied?.count === 3,
      JSON.stringify(wrongArgs.error?.detail?.supplied ?? null))
    check('错误里带候选签名',
      Array.isArray(wrongArgs.error?.detail?.candidates)
      && wrongArgs.error.detail.candidates.some((s) => /RevisionNumber/.test(s)),
      JSON.stringify(wrongArgs.error?.detail?.candidates ?? null).slice(0, 200))

    const wrongTarget = await b.send('invoke', {
      target: 'app', member: 'SelectByID2', args: [],
    })
    check('目标对象不对时指出它该挂在哪',
      wrongTarget.ok === false && wrongTarget.error?.detail?.tryTarget === 'extension',
      JSON.stringify(wrongTarget.error?.detail ?? {}).slice(0, 200))
  } else {
    console.log('  ..   skipping live checks (pass --live with SOLIDWORKS running)');
  }
} catch (e) {
  fail++;
  console.log('  FAIL harness — ' + e.message);
} finally {
  b.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
