// Downloads the whisper.cpp Windows command-line program into resources/whisper,
// which electron-builder ships as an extra resource. Skips work when present.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = 'v1.9.2'
// The program ships in the installer: only this exact archive is accepted
// (the digest GitHub shows for the release asset).
const SHA256 = '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a'
const URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/whisper-bin-x64.zip`
const target = join(import.meta.dirname, '..', 'resources', 'whisper')
const stamp = join(target, 'VERSION')

/** Only the CLI and the libraries it loads (CPU backends are picked at runtime). */
const wanted = (name) => name === 'whisper-cli.exe' || /^(whisper|ggml.*)\.dll$/i.test(name)

const installed = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null
if (installed === VERSION && existsSync(join(target, 'whisper-cli.exe'))) {
  console.log(`whisper.cpp ${VERSION} already present`)
  process.exit(0)
}

const work = join(tmpdir(), `trs-whisper-${Date.now()}`)
mkdirSync(work, { recursive: true })
const zip = join(work, 'whisper.zip')
console.log(`Downloading ${URL}`)
const response = await fetch(URL)
if (!response.ok) throw new Error(`Download failed: ${response.status}`)
const archive = Buffer.from(await response.arrayBuffer())
const digest = createHash('sha256').update(archive).digest('hex')
if (digest !== SHA256) {
  rmSync(work, { recursive: true, force: true })
  throw new Error(`Unexpected whisper.cpp archive (sha256 ${digest}): refusing to ship it`)
}
writeFileSync(zip, archive)

execFileSync('powershell', [
  '-NoProfile',
  '-Command',
  `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${work}' -Force`
])
const release = join(work, 'Release')
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const name of readdirSync(release).filter(wanted)) copyFileSync(join(release, name), join(target, name))
writeFileSync(stamp, `${VERSION}\n`)
rmSync(work, { recursive: true, force: true })
console.log(`whisper.cpp ${VERSION} installed in resources/whisper:`, readdirSync(target).join(', '))
