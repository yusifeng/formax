import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { CompiledScene } from '../player/types'
import { useTerminalPlayer } from '../player/useTerminalPlayer'

type TerminalStageProps = {
  compiledScene: CompiledScene
}

export function TerminalStage(props: TerminalStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [terminal, setTerminal] = useState<Terminal | null>(null)
  const [windowWidthPx, setWindowWidthPx] = useState<number | null>(null)
  const [windowHeightPx, setWindowHeightPx] = useState<number | null>(null)
  useTerminalPlayer({
    terminal,
    events: props.compiledScene.events,
    durationMs: props.compiledScene.durationMs,
    autoStart: true,
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const applyRecordedGeometry = (instance: Terminal, fitAddon: FitAddon) => {
      fitAddon.fit()
      const cols = props.compiledScene.terminalCols
      const rows = props.compiledScene.terminalRows
      if (!cols || !rows) {
        host.style.width = '100%'
        host.style.height = '100%'
        setWindowWidthPx(null)
        setWindowHeightPx(null)
        return
      }

      const renderService = (instance as Terminal & {
        _core?: {
          _renderService?: {
            dimensions?: {
              css?: {
                cell?: { width?: number; height?: number }
              }
            }
          }
        }
      })._core?._renderService
      const cellWidth = renderService?.dimensions?.css?.cell?.width
      const cellHeight = renderService?.dimensions?.css?.cell?.height
      if (!cellWidth || !cellHeight) return

      instance.resize(cols, rows)
      const viewportWidth = Math.ceil(cellWidth * cols)
      const viewportHeight = Math.ceil(cellHeight * rows)
      host.style.width = `${viewportWidth}px`
      host.style.height = `${viewportHeight}px`

      const screenStyles = getComputedStyle(host.parentElement ?? host)
      const screenPadLeft = Number.parseFloat(screenStyles.paddingLeft || '0')
      const screenPadRight = Number.parseFloat(screenStyles.paddingRight || '0')
      const screenPadTop = Number.parseFloat(screenStyles.paddingTop || '0')
      const screenPadBottom = Number.parseFloat(screenStyles.paddingBottom || '0')
      const screenBorderLeft = Number.parseFloat(screenStyles.borderLeftWidth || '0')
      const screenBorderRight = Number.parseFloat(screenStyles.borderRightWidth || '0')
      const screenBorderTop = Number.parseFloat(screenStyles.borderTopWidth || '0')
      const screenBorderBottom = Number.parseFloat(screenStyles.borderBottomWidth || '0')
      const totalWidth = Math.ceil(viewportWidth + screenPadLeft + screenPadRight + screenBorderLeft + screenBorderRight)
      const totalScreenHeight = Math.ceil(
        viewportHeight + screenPadTop + screenPadBottom + screenBorderTop + screenBorderBottom,
      )
      const chrome = host.parentElement?.previousElementSibling as HTMLElement | null
      const chromeHeight = chrome?.offsetHeight ?? 0
      setWindowWidthPx(totalWidth)
      setWindowHeightPx(totalScreenHeight + chromeHeight)
    }

    const nextTerminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cols: props.compiledScene.terminalCols,
      customGlyphs: false,
      disableStdin: true,
      fontSize: 12,
      lineHeight: 1.08,
      fontFamily: 'Monaco, Menlo, Consolas, "Liberation Mono", monospace',
      fontWeight: '400',
      fontWeightBold: '700',
      letterSpacing: 0,
      rows: props.compiledScene.terminalRows,
      scrollback: 2000,
      theme: props.compiledScene.terminalTheme,
    })
    const fitAddon = new FitAddon()
    nextTerminal.loadAddon(fitAddon)
    nextTerminal.open(host)
    applyRecordedGeometry(nextTerminal, fitAddon)
    fitAddonRef.current = fitAddon
    setTerminal(nextTerminal)

    const resizeObserver = new ResizeObserver(() => {
      applyRecordedGeometry(nextTerminal, fitAddon)
    })
    resizeObserver.observe(host.parentElement ?? host)

    return () => {
      resizeObserver.disconnect()
      nextTerminal.dispose()
      fitAddonRef.current = null
      setTerminal(null)
    }
  }, [props.compiledScene.terminalCols, props.compiledScene.terminalRows, props.compiledScene.terminalTheme])

  useEffect(() => {
    if (!terminal) return
    if (!props.compiledScene.terminalCols || !props.compiledScene.terminalRows) {
      fitAddonRef.current?.fit()
    }
  }, [props.compiledScene.terminalCols, props.compiledScene.terminalRows, terminal])

  return (
    <section className="terminal-shell" aria-label={props.compiledScene.title}>
      <div
        className="terminal-window"
        style={
          windowWidthPx == null && windowHeightPx == null
            ? undefined
            : {
                ...(windowWidthPx == null ? {} : { width: `${windowWidthPx}px` }),
                ...(windowHeightPx == null ? {} : { height: `${windowHeightPx}px` }),
              }
        }
      >
        <div className="terminal-window__chrome">
          <div className="traffic-lights" aria-hidden="true">
            <span className="traffic-lights__dot traffic-lights__dot--red" />
            <span className="traffic-lights__dot traffic-lights__dot--amber" />
            <span className="traffic-lights__dot traffic-lights__dot--green" />
          </div>
          <span className="terminal-window__title">formax-demo:init</span>
        </div>
        <div className="terminal-window__screen">
          <div ref={hostRef} className="terminal-window__viewport" />
        </div>
      </div>
    </section>
  )
}
