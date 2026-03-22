# ToolSearch Alignment Report

- generatedAt: 2026-03-05T23:08:09.503Z
- cwd: /Users/david/Documents/github/formax
- provider: anthropic
- deferredToolExposureEnabled: true
- targetTool: Bash

## Turns

### Turn 1
- tools: ToolSearch
- hasDeferredToolsBlock: true
- hasSkillsReminder: true
- hasToolReferenceForTarget: false
- targetToolDeferLoading: false

### Turn 2
- tools: ToolSearch, Bash
- hasDeferredToolsBlock: true
- hasSkillsReminder: true
- hasToolReferenceForTarget: true
- targetToolDeferLoading: true

## Checks

- [PASS] turn1_only_toolsearch_exposed: turn1 tools: ToolSearch
- [PASS] turn1_contains_available_deferred_tools_block: turn1 has <available-deferred-tools>: true
- [PASS] turn2_contains_tool_reference_for_target: turn2 has tool_reference(Bash): true
- [PASS] turn2_exposes_target_tool_and_toolsearch: turn2 tools: ToolSearch, Bash
- [PASS] turn2_target_tool_marked_defer_loading: turn2 Bash.defer_loading: true
