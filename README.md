# dsh-pi-tui

pi-tui based interactive terminal front door for DeepSeek Harness agents.

> M0 scaffold — install/boot instructions and the keybinding table land in M3.

## Install

```sh
dsh plugin --profile pi-tui add dsh-pi-tui
dsh --profile pi-tui
```

`dsh --profile pi-tui --resume <session-id>` reopens a persisted session.

## Status

| Milestone | State |
|---|---|
| M0 scaffold + boot smoke | ✅ done (2026-08-14) |
| M1 chat loop (streaming, tool cards, --resume) | planned |
| M2 parity (slash commands, approval, questions, status bar) | planned |
| M3 engineering + publish | planned |

## License

MIT. See NOTICE for attribution of adapted pi components.
