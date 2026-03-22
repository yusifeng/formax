import type { CompiledScene, CompiledTerminalEvent, SceneDefinition, SceneStep } from './types'

const COLOR_RESET = '\x1b[0m'
const COLOR_DIM = '\x1b[38;5;245m'
const COLOR_BLUE = '\x1b[38;5;81m'
const COLOR_GREEN = '\x1b[38;5;114m'
const COLOR_AMBER = '\x1b[38;5;221m'
const COLOR_RED = '\x1b[38;5;203m'
const DEFAULT_PROMPT = `${COLOR_DIM}demo@formax ~ % ${COLOR_RESET}`
const DEFAULT_COMMAND_CPS = 24
const DEFAULT_STREAM_CPS = 90
const DEFAULT_SHELL_CPS = 140
const ASSISTANT_PREFIX = `${COLOR_BLUE}assistant${COLOR_RESET} `
const TOOL_PREFIX = `${COLOR_DIM}[tool]${COLOR_RESET} `

function clampCps(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

function perCharIntervalMs(cps: number): number {
  return Math.max(8, Math.round(1000 / cps))
}

function pushChunkedText(args: {
  events: CompiledTerminalEvent[]
  startMs: number
  text: string
  intervalMs: number
}): number {
  let currentTime = args.startMs
  for (const char of args.text) {
    args.events.push({ atMs: currentTime, output: char })
    currentTime += args.intervalMs
  }
  return currentTime
}

function notePrefix(tone: NonNullable<Extract<SceneStep, { type: 'note' }>['tone']>): string {
  if (tone === 'success') return `${COLOR_GREEN}[ok]${COLOR_RESET} `
  if (tone === 'warning') return `${COLOR_AMBER}[warn]${COLOR_RESET} `
  if (tone === 'error') return `${COLOR_RED}[error]${COLOR_RESET} `
  return `${COLOR_DIM}[note]${COLOR_RESET} `
}

export function compileScene(scene: SceneDefinition): CompiledScene {
  const events: CompiledTerminalEvent[] = []
  let currentTime = 0

  for (const step of scene.steps) {
    if (step.type === 'wait') {
      currentTime += Math.max(0, step.ms)
      continue
    }

    if (step.type === 'type_command') {
      events.push({ atMs: currentTime, output: step.prompt ?? DEFAULT_PROMPT })
      currentTime = pushChunkedText({
        events,
        startMs: currentTime + 10,
        text: step.text,
        intervalMs: perCharIntervalMs(clampCps(step.cps, DEFAULT_COMMAND_CPS)),
      })
      continue
    }

    if (step.type === 'submit') {
      events.push({ atMs: currentTime, output: '\r\n' })
      currentTime += 80
      continue
    }

    if (step.type === 'assistant_stream') {
      events.push({ atMs: currentTime, output: ASSISTANT_PREFIX })
      currentTime = pushChunkedText({
        events,
        startMs: currentTime + 18,
        text: step.text,
        intervalMs: perCharIntervalMs(clampCps(step.cps, DEFAULT_STREAM_CPS)),
      })
      events.push({ atMs: currentTime, output: '\r\n' })
      currentTime += 90
      continue
    }

    if (step.type === 'tool_start') {
      events.push({
        atMs: currentTime,
        output: `${TOOL_PREFIX}${step.label}\r\n`,
      })
      currentTime += 160
      continue
    }

    if (step.type === 'tool_end') {
      const prefix =
        step.outcome === 'failed'
          ? `${COLOR_RED}[failed]${COLOR_RESET} `
          : step.outcome === 'warning'
            ? `${COLOR_AMBER}[done?]${COLOR_RESET} `
            : `${COLOR_GREEN}[done]${COLOR_RESET} `
      events.push({
        atMs: currentTime,
        output: `${prefix}${step.label}\r\n`,
      })
      currentTime += 140
      continue
    }

    if (step.type === 'shell_chunk') {
      currentTime = pushChunkedText({
        events,
        startMs: currentTime,
        text: step.text,
        intervalMs: perCharIntervalMs(clampCps(step.cps, DEFAULT_SHELL_CPS)),
      })
      continue
    }

    if (step.type === 'note') {
      events.push({
        atMs: currentTime,
        output: `${notePrefix(step.tone ?? 'info')}${step.text}\r\n`,
      })
      currentTime += 160
      continue
    }

    if (step.type === 'finish') {
      events.push({
        atMs: currentTime,
        output: `${step.prompt ?? DEFAULT_PROMPT}`,
      })
      currentTime += 20
    }
  }

  return {
    title: scene.title,
    description: scene.description,
    events,
    durationMs: currentTime,
  }
}
