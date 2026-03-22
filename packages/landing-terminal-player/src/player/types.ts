export type SceneStep =
  | { type: 'wait'; ms: number }
  | { type: 'type_command'; text: string; prompt?: string; cps?: number }
  | { type: 'submit' }
  | { type: 'assistant_stream'; text: string; cps?: number }
  | { type: 'tool_start'; label: string }
  | { type: 'tool_end'; label: string; outcome?: 'completed' | 'warning' | 'failed' }
  | { type: 'shell_chunk'; text: string; cps?: number }
  | { type: 'note'; text: string; tone?: 'info' | 'success' | 'warning' | 'error' }
  | { type: 'finish'; prompt?: string }

export type SceneDefinition = {
  title: string
  description: string
  steps: SceneStep[]
}

export type CompiledTerminalEvent = {
  atMs: number
  output: string
}

export type CompiledTerminalTheme = {
  background: string
  foreground: string
  cursor: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
  selectionBackground?: string
}

export type CompiledScene = {
  title: string
  description: string
  events: CompiledTerminalEvent[]
  durationMs: number
  terminalCols?: number
  terminalRows?: number
  terminalTheme?: CompiledTerminalTheme
}
