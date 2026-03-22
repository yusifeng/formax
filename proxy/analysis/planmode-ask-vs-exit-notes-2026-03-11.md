# Plan Mode Behavioral Diff Notes (2026-03-11)

## Scope
- Compare:
  - `proxy/traffic-log-2026-03-11T22-07-42` (Claude-side capture)
  - `proxy/traffic-log-2026-03-11T22-12-51` (Formax-side capture)
- Task context: Snake game request in plan mode.

## Confirmed Differences
- `AskUserQuestion` tool exposure exists on both sides.
- `AskUserQuestion` was actually called in Claude capture, but not in Formax capture.
- Key reason is prompt-state difference, not tool absence:
  - Claude plan reminder includes explicit workflow steps that instruct asking questions first.
  - Formax plan reminder is shorter and does not include that mandatory phased workflow text.
  - Formax capture also entered with an already-existing plan file, reducing ambiguity pressure.

## Evidence (AskUserQuestion)
- Claude reminder with phased workflow:
  - `proxy/traffic-log-2026-03-11T22-07-42/0008_2026-03-11T22-09-16,103_REQ__v1_messages.json:71`
- Claude actual call:
  - `proxy/traffic-log-2026-03-11T22-07-42/0008_2026-03-11T22-09-16,103_REQ__v1_messages.json:94`
- Formax shorter plan reminder:
  - `proxy/traffic-log-2026-03-11T22-12-51/0003_2026-03-11T22-14-15,671_REQ__v1_messages.json:73`

## Evidence (ExitPlanMode question)
- Claude tool invocation instance:
  - `proxy/traffic-log-2026-03-11T22-07-42/0014_2026-03-11T22-09-43,336_REQ__v1_messages.json:205`
- `ExitPlanMode` tool description appears equivalent in both captures:
  - Claude sample file:
    - `proxy/traffic-log-2026-03-11T22-07-42/0014_2026-03-11T22-09-43,336_REQ__v1_messages.json`
  - Formax sample files:
    - `proxy/traffic-log-2026-03-11T22-12-51/0003_2026-03-11T22-14-15,671_REQ__v1_messages.json`
    - `proxy/traffic-log-2026-03-11T22-12-51/0004_2026-03-11T22-14-24,723_REQ__v1_messages.json`
- Claude reminder additionally contains explicit phase text:
  - "Phase 5: Call ExitPlanMode ... always call ExitPlanMode"
  - This phrase is not present in the Formax reminder from the capture above.

## Local Code Pointers (Formax)
- Plan reminder builder:
  - `src/shared/utils/planMode.ts:15`
- Plan path creation/reuse in plan mode turn send:
  - `src/features/repl/controller/send/sendMainTurn.ts:99`
