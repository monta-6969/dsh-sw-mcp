import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'
const session = openSession({})
await session.start()
try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })
  const designId = `probe-${Date.now()}`
  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      params: { 'plate.w': 100 },
      features: [
        { kind: 'sketch', id: 's', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 60, bind: { width: 'plate.w' } }] },
        { kind: 'extrude', id: 'e', profile: 's', depth: 20 },
      ],
    },
  })
  const dims = built.changes?.dimensionBindings ?? {}
  console.log('document', JSON.stringify(built.changes?.document))
  console.log('dims', JSON.stringify(dims))
  const name = dims['plate.w']
  for (const candidate of [name, name?.replace(/\.Part$/, ''), name?.replace(/@[^@]+\.Part$/, '')]) {
    const r = await session.tool('model', {
      action: 'invoke', target: 'doc', member: 'Parameter', args: [candidate],
    })
    console.log('candidate', JSON.stringify(candidate), '=>', JSON.stringify(r.changes ?? r.summary))
  }
} finally {
  await session.tool('workspace', { action: 'cleanup' }).catch(() => {})
  await session.close()
}
process.exit(0)
