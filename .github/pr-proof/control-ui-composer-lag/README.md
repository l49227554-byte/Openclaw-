# Control UI composer lag proof

This proof uses the real bundled Control UI with a mock Gateway and 400 synthetic transcript messages. It contains no user or production data.

Source under test: `10684f60cb91085b1bb6d50d2a1fb4eb94603a61`

## Results

- Complete composer input-event path: median **0.2 ms**, p95 **0.3 ms**, maximum **0.3 ms** across 24 sequential characters.
- Native growth: 36 px at one line, 84 px at three lines, and capped at 156 px for 20 lines with `overflow-y: auto`.
- End-pinned transcript: bottom gap remained 0 through all growth states.
- Reader takeover: PageUp delivered between the two anchoring frames left the transcript 361 px from the end (`didNotSnapToEnd: true`).

The machine-readable output is in [`browser-evidence.json`](./browser-evidence.json). The screenshot in [`native-after.png`](./native-after.png) shows the sanitized composer surface used by the timing run. The capture used Playwright against the repository's `startControlUiE2eServer` and `installMockGateway` helpers; fixture parameters are serialized in the JSON.
