import type { CompiledScene, CompiledTerminalTheme } from '../player/types'

type CastHeader = {
  version?: unknown
  width?: unknown
  height?: unknown
  title?: unknown
  term?: {
    cols?: unknown
    rows?: unknown
    theme?: {
      fg?: unknown
      bg?: unknown
      palette?: unknown
    }
  }
}

const FALLBACK_THEME: CompiledTerminalTheme = {
  background: '#050816',
  foreground: '#e5ecf4',
  cursor: '#bfe1ff',
  selectionBackground: 'rgba(120, 160, 255, 0.25)',
  black: '#1b2030',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#414868',
  brightRed: '#ff899d',
  brightGreen: '#b9f27c',
  brightYellow: '#f7c57a',
  brightBlue: '#8db4ff',
  brightMagenta: '#c7a9ff',
  brightCyan: '#8ae8ff',
  brightWhite: '#f5faff',
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolveTheme(header: CastHeader): CompiledTerminalTheme {
  const theme = header.term?.theme
  const foreground = asString(theme?.fg) ?? FALLBACK_THEME.foreground
  const background = asString(theme?.bg) ?? FALLBACK_THEME.background
  const palette = (asString(theme?.palette) ?? '').split(':').filter((entry) => entry.length > 0)

  if (palette.length < 16) {
    return {
      ...FALLBACK_THEME,
      foreground,
      background,
      cursor: foreground,
    }
  }

  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: FALLBACK_THEME.selectionBackground,
    black: palette[0]!,
    red: palette[1]!,
    green: palette[2]!,
    yellow: palette[3]!,
    blue: palette[4]!,
    magenta: palette[5]!,
    cyan: palette[6]!,
    white: palette[7]!,
    brightBlack: palette[8]!,
    brightRed: palette[9]!,
    brightGreen: palette[10]!,
    brightYellow: palette[11]!,
    brightBlue: palette[12]!,
    brightMagenta: palette[13]!,
    brightCyan: palette[14]!,
    brightWhite: palette[15]!,
  }
}

export function parseAsciinemaCast(
  text: string,
  options?: { title?: string; description?: string; startAtOutputMatch?: string },
): CompiledScene {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    throw new Error('Asciinema cast is empty')
  }

  let header: CastHeader
  try {
    header = JSON.parse(lines[0]!) as CastHeader
  } catch (error) {
    throw new Error(`Invalid asciinema header: ${error instanceof Error ? error.message : String(error)}`)
  }

  let currentTimeMs = 0
  const events: CompiledScene['events'] = []
  let trimStartMs: number | null = null

  for (let index = 1; index < lines.length; index += 1) {
    let entry: unknown
    try {
      entry = JSON.parse(lines[index]!)
    } catch (error) {
      throw new Error(`Invalid asciinema event on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!Array.isArray(entry) || entry.length < 3) continue
    const deltaSeconds = asFiniteNumber(entry[0])
    const kind = entry[1]
    const payload = entry[2]
    if (deltaSeconds == null) continue
    currentTimeMs += Math.max(0, Math.round(deltaSeconds * 1000))
    if (kind !== 'o') continue
    if (typeof payload !== 'string' || payload.length === 0) continue
    if (trimStartMs == null && options?.startAtOutputMatch) {
      if (!payload.includes(options.startAtOutputMatch)) {
        continue
      }
      trimStartMs = currentTimeMs
    }
    const normalizedAtMs = trimStartMs == null ? currentTimeMs : Math.max(0, currentTimeMs - trimStartMs)
    events.push({ atMs: normalizedAtMs, output: payload })
  }

  const cols = asFiniteNumber(header.term?.cols) ?? asFiniteNumber(header.width) ?? undefined
  const rows = asFiniteNumber(header.term?.rows) ?? asFiniteNumber(header.height) ?? undefined

  return {
    title: options?.title ?? (asString(header.title) ?? 'Imported asciinema cast'),
    description: options?.description ?? 'Playback sourced directly from an asciinema cast recording.',
    events,
    durationMs: trimStartMs == null ? currentTimeMs : Math.max(0, currentTimeMs - trimStartMs),
    terminalCols: cols == null ? undefined : Math.max(1, Math.floor(cols)),
    terminalRows: rows == null ? undefined : Math.max(1, Math.floor(rows)),
    terminalTheme: resolveTheme(header),
  }
}
