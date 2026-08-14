/** Verified download and extraction of the official Intiface Engine CLI. */

import { createHash, randomBytes } from 'node:crypto'
import { access, chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { ToyError } from './types.ts'

const RELEASE_TAG = 'intiface-engine-4.0.2'
const RELEASE_VERSION = '4.0.2'
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

/** One pinned upstream artifact and its GitHub-provided SHA-256 digest. */
export interface IntifaceArtifact {
  name: string
  sha256: string
}

const ARTIFACTS: Readonly<Record<string, IntifaceArtifact>> = {
  'darwin-arm64': {
    name: 'intiface-engine-v4.0.2-macos-arm64.zip',
    sha256: '4331e57a68635f5b1ce062b29759ec75187773f53f80d15e0e13a2d253957909',
  },
  'linux-arm64': {
    name: 'intiface-engine-v4.0.2-linux-arm64.zip',
    sha256: 'bdedaa1f2e460e31a1b33fb6dfbb9d410d3e17929c16eb5b696aeb8b4adb4016',
  },
  'linux-x64': {
    name: 'intiface-engine-v4.0.2-linux-x64.zip',
    sha256: 'f1c61ab0abfab265beedfd89805a36c7641984b1baee680846814d22af3d6b3a',
  },
  'win32-x64': {
    name: 'intiface-engine-v4.0.2-win-x64.zip',
    sha256: '38797ab30121b55cdedd50b457b676f0fb0d3bee2da7bcd149a21a30170a284e',
  },
}

/** Return the pinned artifact for a supported Node platform/architecture pair. */
export function selectIntifaceArtifact(platform = process.platform, arch = process.arch): IntifaceArtifact {
  const artifact = ARTIFACTS[`${platform}-${arch}`]
  if (artifact === undefined) throw new ToyError(`Automatic Intiface Engine download is unavailable for ${platform}-${arch}`)
  return artifact
}

function cacheRoot(): string {
  if (process.env.DSH_TOY_CACHE_DIR !== undefined && process.env.DSH_TOY_CACHE_DIR.length > 0) {
    return process.env.DSH_TOY_CACHE_DIR
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-toy')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'dsh-toy')
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-toy')
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const lowerBound = Math.max(0, zip.length - 65_557)
  for (let offset = zip.length - 22; offset >= lowerBound; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new ToyError('Downloaded Intiface Engine archive has no ZIP central directory')
}

/** Extract only the expected executable from a small, non-ZIP64 upstream archive. */
export function extractIntifaceExecutable(zip: Buffer, windows = process.platform === 'win32'): Buffer {
  const eocd = findEndOfCentralDirectory(zip)
  const entryCount = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  const expected = windows ? 'intiface-engine.exe' : 'intiface-engine'
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new ToyError('Downloaded Intiface Engine archive has a malformed ZIP entry')
    }
    const flags = zip.readUInt16LE(offset + 8)
    const compression = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const uncompressedSize = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd > zip.length) throw new ToyError('Downloaded Intiface Engine archive has a truncated filename')
    const name = zip.subarray(offset + 46, nameEnd).toString('utf8')
    offset = nameEnd + extraLength + commentLength
    if (basename(name) !== expected) continue
    if ((flags & 0x1) !== 0) throw new ToyError('Downloaded Intiface Engine archive is unexpectedly encrypted')
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ToyError('Downloaded Intiface Engine archive has a malformed local entry')
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > zip.length) throw new ToyError('Downloaded Intiface Engine executable is truncated')
    const compressed = zip.subarray(dataStart, dataEnd)
    const executable = compression === 0
      ? Buffer.from(compressed)
      : compression === 8
        ? inflateRawSync(compressed)
        : undefined
    if (executable === undefined) throw new ToyError(`Unsupported ZIP compression method ${compression}`)
    if (executable.length !== uncompressedSize) throw new ToyError('Downloaded Intiface Engine executable has an invalid size')
    return executable
  }
  throw new ToyError(`Downloaded archive does not contain ${expected}`)
}

/** Download, verify, cache, and return an executable path for Intiface Engine. */
export async function installIntifaceEngine(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const artifact = selectIntifaceArtifact()
  const directory = join(cacheRoot(), `intiface-engine-${RELEASE_VERSION}`)
  const executable = join(directory, process.platform === 'win32' ? 'intiface-engine.exe' : 'intiface-engine')
  try {
    await access(executable)
    return executable
  } catch {
    // Download below.
  }
  await mkdir(directory, { recursive: true })
  const url = `https://github.com/buttplugio/buttplug/releases/download/${RELEASE_TAG}/${artifact.name}`
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', signal })
  } catch (error) {
    throw new ToyError(`Could not download Intiface Engine from the official release: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new ToyError(`Official Intiface Engine download failed with HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_ARCHIVE_BYTES) throw new ToyError('Official Intiface Engine archive is unexpectedly large')
  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.length > MAX_ARCHIVE_BYTES) throw new ToyError('Official Intiface Engine archive is unexpectedly large')
  const actualHash = createHash('sha256').update(archive).digest('hex')
  if (actualHash !== artifact.sha256) throw new ToyError('Official Intiface Engine archive failed SHA-256 verification')
  const body = extractIntifaceExecutable(archive)
  const temporary = `${executable}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, body, { mode: 0o755, flag: 'wx' })
  try {
    await chmod(temporary, 0o755)
    try {
      await rename(temporary, executable)
    } catch (error) {
      try {
        await access(executable)
      } catch {
        throw error
      }
    }
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return executable
}
