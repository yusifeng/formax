import { describe, expect, it } from 'vitest'
import { parseAsciinemaCast } from './parseAsciinemaCast'

describe('parseAsciinemaCast', () => {
  it('parses header metadata and accumulates output event timing', () => {
    const cast = [
      JSON.stringify({
        version: 3,
        term: {
          cols: 120,
          rows: 30,
          theme: {
            fg: '#ffffff',
            bg: '#000000',
            palette: '#000000:#111111:#222222:#333333:#444444:#555555:#666666:#777777:#888888:#999999:#aaaaaa:#bbbbbb:#cccccc:#dddddd:#eeeeee:#ffffff',
          },
        },
      }),
      JSON.stringify([0.5, 'o', 'hello']),
      JSON.stringify([0.25, 'i', 'ignored']),
      JSON.stringify([0.25, 'o', ' world']),
    ].join('\n')

    const compiled = parseAsciinemaCast(cast)

    expect(compiled.terminalCols).toBe(120)
    expect(compiled.terminalRows).toBe(30)
    expect(compiled.events).toHaveLength(2)
    expect(compiled.events[0]).toEqual({ atMs: 500, output: 'hello' })
    expect(compiled.events[1]).toEqual({ atMs: 1000, output: ' world' })
    expect(compiled.durationMs).toBe(1000)
    expect(compiled.terminalTheme?.background).toBe('#000000')
    expect(compiled.terminalTheme?.brightWhite).toBe('#ffffff')
  })

  it('throws for invalid header data', () => {
    expect(() => parseAsciinemaCast('not-json')).toThrow(/Invalid asciinema header/)
  })

  it('can trim playback to the first matching output event', () => {
    const cast = [
      JSON.stringify({ version: 3, term: { cols: 80, rows: 24 } }),
      JSON.stringify([0.5, 'o', 'before']),
      JSON.stringify([0.25, 'o', 'start here']),
      JSON.stringify([0.25, 'o', 'after']),
    ].join('\n')

    const compiled = parseAsciinemaCast(cast, { startAtOutputMatch: 'start here' })

    expect(compiled.events).toHaveLength(2)
    expect(compiled.events[0]).toEqual({ atMs: 0, output: 'start here' })
    expect(compiled.events[1]).toEqual({ atMs: 250, output: 'after' })
    expect(compiled.durationMs).toBe(250)
  })
})
