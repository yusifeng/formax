# Landing Terminal Player

Standalone landing-page terminal replay prototype for Formax.

## Goals

- Feel like a real terminal session, not a reduced web app
- Stay isolated from `packages/web-reference-react`
- Be easy to move into another repository or landing page later

## Commands

```bash
bun run dev
bun run test -- src/player/compileScene.test.ts
bun run build
```

## Structure

- `src/components/TerminalStage.tsx`
  - xterm host, playback controls, terminal chrome
- `src/player/compileScene.ts`
  - compiles author-friendly scene steps into timestamped terminal events
- `src/player/useTerminalPlayer.ts`
  - playback state, replay/pause/resume/speed logic
- `src/scenarios/initDemo.ts`
  - first `/init` landing demo scene

## Portability Rules

- Do not import app state or UI from `packages/web-reference-react`
- Keep dependencies direct and minimal (`react`, `react-dom`, `xterm`, `vite`)
- Prefer plain CSS over repo-specific styling systems
- Keep scene definitions data-oriented so future recorded sessions can be converted into the same format
