import { describe, expect, it } from 'vitest'
import { compileScene } from './compileScene'
import type { SceneDefinition } from './types'

describe('compileScene', () => {
  it('builds a monotonic timeline with prompt, command, and finish prompt', () => {
    const scene: SceneDefinition = {
      title: 'test',
      description: 'test scene',
      steps: [
        { type: 'type_command', text: '/init', cps: 20 },
        { type: 'submit' },
        { type: 'wait', ms: 300 },
        { type: 'assistant_stream', text: 'hello', cps: 50 },
        { type: 'finish' },
      ],
    }

    const compiled = compileScene(scene)
    const outputs = compiled.events.map((event) => event.output).join('')

    expect(compiled.durationMs).toBeGreaterThan(0)
    expect(outputs).toContain('/init')
    expect(outputs).toContain('assistant')
    expect(outputs).toContain('hello')
    expect(compiled.events[0]?.atMs).toBe(0)

    for (let index = 1; index < compiled.events.length; index += 1) {
      expect(compiled.events[index]!.atMs).toBeGreaterThanOrEqual(compiled.events[index - 1]!.atMs)
    }
  })

  it('renders note and tool outcome markers', () => {
    const scene: SceneDefinition = {
      title: 'markers',
      description: 'markers',
      steps: [
        { type: 'note', text: 'warming up', tone: 'warning' },
        { type: 'tool_start', label: 'Read AGENTS.md' },
        { type: 'tool_end', label: 'Read AGENTS.md', outcome: 'completed' },
      ],
    }

    const compiled = compileScene(scene)
    const outputs = compiled.events.map((event) => event.output).join('')

    expect(outputs).toContain('[warn]')
    expect(outputs).toContain('[tool]')
    expect(outputs).toContain('[done]')
  })
})
