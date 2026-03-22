import { useEffect, useMemo, useState } from 'react'
import { TerminalStage } from './components/TerminalStage'
import { compileScene } from './player/compileScene'
import { parseAsciinemaCast } from './cast/parseAsciinemaCast'
import type { CompiledScene } from './player/types'
import { initDemoScene } from './scenarios/initDemo'

export function App() {
  const fallbackScene = useMemo(() => compileScene(initDemoScene), [])
  const [compiledScene, setCompiledScene] = useState<CompiledScene>(fallbackScene)

  useEffect(() => {
    let cancelled = false

    void fetch('/my_terminal_session.cast')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load cast: ${response.status}`)
        }
        return response.text()
      })
      .then((text) => {
        if (cancelled) return
        setCompiledScene(
          parseAsciinemaCast(text, {
            title: 'my_terminal_session.cast',
            description: 'Imported directly from asciinema cast.',
          }),
        )
      })
      .catch(() => {
        if (cancelled) return
        setCompiledScene(fallbackScene)
      })

    return () => {
      cancelled = true
    }
  }, [fallbackScene])

  return (
    <main className="app-shell">
      <TerminalStage compiledScene={compiledScene} />
    </main>
  )
}
