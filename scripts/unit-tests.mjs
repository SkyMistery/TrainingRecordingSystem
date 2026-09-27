// Runs the unit tests (tests/unit/*.test.ts): each is bundled with esbuild (it
// comes with Vite) into a temporary folder, then run with Node's test runner.
// Electron and the native modules stay outside the bundle.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = join(import.meta.dirname, '..')
const testsDir = join(root, 'tests', 'unit')
const outDir = mkdtempSync(join(tmpdir(), 'trs-unit-'))
try {
  const entries = readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(testsDir, name))
  await build({
    entryPoints: entries,
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outExtension: { '.js': '.cjs' },
    external: ['electron', 'koffi', 'uiohook-napi'],
    nodePaths: [join(root, 'node_modules')],
    logLevel: 'warning'
  })
  const files = readdirSync(outDir).map((name) => join(outDir, name))
  const result = spawnSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, NODE_PATH: join(root, 'node_modules') }
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
