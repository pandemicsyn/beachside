---
"@beachside/cli": patch
---

The bundled `beachside-cli` skill now shows agents Rex's exact split-pane commands: `rex run --split=right -s "$REX_SESSION" --keep-open --json`, then `rex wait` and `rex capture` by the saved pane id. It also explains how to start a Rex server inside a sandbox, following the Rex guide.
