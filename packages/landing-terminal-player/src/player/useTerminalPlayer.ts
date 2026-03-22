import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { CompiledTerminalEvent } from './types'

type UseTerminalPlayerArgs = {
  terminal: Terminal | null
  events: CompiledTerminalEvent[]
  durationMs: number
  autoStart?: boolean
}

type PlayerState = {
  completed: boolean
  elapsedMs: number
  isPlaying: boolean
  progress: number
  speed: number
  pause: () => void
  replay: () => void
  resume: () => void
  setSpeed: (nextSpeed: number) => void
}

const DEFAULT_SPEED = 1
const SUPPORTED_SPEEDS = new Set([0.75, 1, 1.5, 2])

export function useTerminalPlayer(args: UseTerminalPlayerArgs): PlayerState {
  const timersRef = useRef<number[]>([])
  const nextEventIndexRef = useRef(0)
  const logicalElapsedMsRef = useRef(0)
  const startedAtRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const speedRef = useRef(DEFAULT_SPEED)
  const [isPlaying, setIsPlaying] = useState(Boolean(args.autoStart))
  const [completed, setCompleted] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [speed, setSpeedState] = useState(DEFAULT_SPEED)

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) {
      window.clearTimeout(timer)
    }
    timersRef.current = []
  }, [])

  const resetPlayback = useCallback(() => {
    clearTimers()
    generationRef.current += 1
    nextEventIndexRef.current = 0
    logicalElapsedMsRef.current = 0
    startedAtRef.current = null
    setElapsedMs(0)
    setCompleted(false)
    args.terminal?.reset()
  }, [args.terminal, clearTimers])

  const finalizePlayback = useCallback(() => {
    clearTimers()
    generationRef.current += 1
    nextEventIndexRef.current = args.events.length
    logicalElapsedMsRef.current = args.durationMs
    startedAtRef.current = null
    setElapsedMs(args.durationMs)
    setCompleted(true)
    setIsPlaying(false)
  }, [args.durationMs, args.events.length, clearTimers])

  const scheduleFromCurrentPosition = useCallback(() => {
    const terminal = args.terminal
    if (!terminal) return

    clearTimers()
    generationRef.current += 1
    const generation = generationRef.current
    const baseLogicalElapsed = logicalElapsedMsRef.current
    startedAtRef.current = performance.now()

    while (
      nextEventIndexRef.current < args.events.length &&
      args.events[nextEventIndexRef.current]!.atMs <= baseLogicalElapsed
    ) {
      terminal.write(args.events[nextEventIndexRef.current]!.output)
      nextEventIndexRef.current += 1
    }

    if (nextEventIndexRef.current >= args.events.length) {
      finalizePlayback()
      return
    }

    for (let index = nextEventIndexRef.current; index < args.events.length; index += 1) {
      const event = args.events[index]!
      const delayMs = Math.max(0, Math.round((event.atMs - baseLogicalElapsed) / speedRef.current))
      const timer = window.setTimeout(() => {
        if (generationRef.current !== generation) return
        terminal.write(event.output)
        nextEventIndexRef.current = index + 1
        if (index + 1 >= args.events.length) {
          finalizePlayback()
        }
      }, delayMs)
      timersRef.current.push(timer)
    }
  }, [args.events, args.terminal, clearTimers, finalizePlayback])

  const pause = useCallback(() => {
    if (!isPlaying) return
    const startedAt = startedAtRef.current
    if (startedAt != null) {
      logicalElapsedMsRef.current += (performance.now() - startedAt) * speedRef.current
    }
    startedAtRef.current = null
    clearTimers()
    setElapsedMs(Math.min(logicalElapsedMsRef.current, args.durationMs))
    setIsPlaying(false)
  }, [args.durationMs, clearTimers, isPlaying])

  const resume = useCallback(() => {
    if (completed || !args.terminal) return
    setIsPlaying(true)
  }, [args.terminal, completed])

  const replay = useCallback(() => {
    if (!args.terminal) return
    resetPlayback()
    setIsPlaying(true)
  }, [args.terminal, resetPlayback])

  const setSpeed = useCallback(
    (nextSpeed: number) => {
      const normalized = SUPPORTED_SPEEDS.has(nextSpeed) ? nextSpeed : DEFAULT_SPEED
      if (normalized === speedRef.current) return
      if (isPlaying) {
        const startedAt = startedAtRef.current
        if (startedAt != null) {
          logicalElapsedMsRef.current += (performance.now() - startedAt) * speedRef.current
          startedAtRef.current = null
        }
      }
      speedRef.current = normalized
      setSpeedState(normalized)
    },
    [isPlaying],
  )

  useEffect(() => {
    if (!args.terminal) return
    resetPlayback()
    if (args.autoStart !== false) {
      setIsPlaying(true)
    }
  }, [args.autoStart, args.events, args.terminal, resetPlayback])

  useEffect(() => {
    if (!isPlaying || !args.terminal) return
    if (completed) return
    scheduleFromCurrentPosition()
    return clearTimers
  }, [args.terminal, clearTimers, completed, isPlaying, scheduleFromCurrentPosition, speed])

  useEffect(() => {
    if (!isPlaying) return
    let frame = 0
    const tick = () => {
      const startedAt = startedAtRef.current
      const nextElapsed =
        startedAt == null
          ? logicalElapsedMsRef.current
          : logicalElapsedMsRef.current + (performance.now() - startedAt) * speedRef.current
      setElapsedMs(Math.min(nextElapsed, args.durationMs))
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [args.durationMs, isPlaying])

  useEffect(() => {
    return clearTimers
  }, [clearTimers])

  return useMemo(
    () => ({
      completed,
      elapsedMs,
      isPlaying,
      progress: args.durationMs <= 0 ? 0 : Math.min(1, elapsedMs / args.durationMs),
      speed,
      pause,
      replay,
      resume,
      setSpeed,
    }),
    [args.durationMs, completed, elapsedMs, isPlaying, pause, replay, resume, setSpeed, speed],
  )
}
