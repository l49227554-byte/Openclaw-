# Tool Pre-filter Plugin

A lightweight OpenClaw plugin that uses typed decision models (such as TypeSafe Jev) to prune unneeded tool schemas before calling the primary conversational model.

## Why This Matters

Loading dozens of tool and skill definitions on every agent turn bloats the context window by 5,000–10,000 tokens, slows down model inference, and increases the likelihood of tool hallucinations.

When enabled, this plugin hooks into `before_prompt_build`:
- **Pure Conversation:** If the user's turn does not require external tools (probability below `thresholdAnyTool`), all tool schemas are pruned (`toolsAllow: []`), saving ~1,800+ tokens per turn.
- **Fail-open Resilience:** If the decision provider is unavailable or times out, the plugin fails open without interrupting the conversation.

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "tool-prefilter": {
        "enabled": true,
        "config": {
          "thresholdAnyTool": 0.35,
          "timeoutMs": 500
        }
      }
    }
  }
}
```
