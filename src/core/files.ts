/**
 * @ file-listing data source helpers: ripgrep-backed enumeration with the
 * industry-standard ignore convention (ripgrep/fd semantics) plus a small
 * unconditional exclude list, hidden-file policy (Claude Code style), and a
 * display cap constant. Pure helpers stay unit-testable.
 */
import { spawn } from 'node:child_process'

/** How many items the picker renders before falling back to the filter. */
export const RG_DISPLAY_CAP = 100

/**
 * Unconditional excludes on top of rg's native .gitignore/.ignore handling:
 * build artifacts, caches, and VCS/editor metadata (fd/rg ecosystem
 * consensus + dsh's own glob-tool VCS list).
 */
export const RG_EXCLUDE_GLOBS = [
  '!.git/**',
  '!.DS_Store',
  '!**/__pycache__/**',
  '!*.pyc',
  '!*.pyo',
  '!node_modules/**',
  '!dist/**',
  '!build/**',
  '!coverage/**',
  '!.dsh/**',
  '!.svn/**',
  '!.hg/**',
  '!.bzr/**',
  '!.jj/**',
  '!.sl/**',
]

/** Split rg --files stdout into clean relative paths. */
export function parseRgFiles(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Any dot-prefixed path segment (hidden file OR inside a hidden dir). */
export function isHiddenPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')
}

/** Claude Code policy: hidden paths show only when the query starts with '.'. */
export function shouldShowPath(query: string, path: string): boolean {
  if (query.startsWith('.')) return true
  return !isHiddenPath(path)
}

/**
 * Enumerate visible files under `cwd` with one rg invocation. Resolves []
 * on any failure (the caller falls back to the fs walker).
 */
export function runRgFiles(rgPath: string, cwd: string, timeoutMs = 15000): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(
      rgPath,
      [
        '--files',
        '--hidden',
        '--sort=modified',
        ...RG_EXCLUDE_GLOBS.flatMap((glob) => ['-g', glob]),
      ],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    const finish = (value: string[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', () => {
      finish([])
    })
    child.on('close', () => {
      finish(parseRgFiles(stdout))
    })
  })
}
