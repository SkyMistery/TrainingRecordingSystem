// Downloads the whisper.cpp Windows command-line program into resources/whisper,
// which electron-builder ships as an extra resource. Skips work when present.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = 'v1.9.2'
const URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/whisper-bin-x64.zip`
const target = join(import.meta.dirname, '..', 'resources', 'whisper')
const stamp = join(target, 'VERSION')

/** Only the CLI and the libraries it loads (CPU backends are picked at runtime). */
const wanted = (name) => name === 'whisper-cli.exe' || /^(whisper|ggml.*)\.dll$/i.test(name)

if (existsSync(stamp) && existsSync(join(target, 'whisper-cli.exe'))) {
  console.log(`whisper.cpp ${VERSION} already present`)
  process.exit(0)
}

const work = join(tmpdir(), `trs-whisper-${Date.now()}`)
mkdirSync(work, { recursive: true })
const zip = join(work, 'whisper.zip')
console.log(`Downloading ${URL}`)
const response = await fetch(URL)
if (!response.ok) throw new Error(`Download failed: ${response.status}`)
writeFileSync(zip, Buffer.from(await response.arrayBuffer()))

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
