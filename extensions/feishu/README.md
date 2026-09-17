# OpenClaw Feishu/Lark

Official OpenClaw channel plugin for Feishu and Lark workplace chats. Community maintained by @m1heng.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/feishu
```

Configure the Feishu/Lark app credentials in OpenClaw, then connect the plugin to the chats where agents should receive and send messages.

## Two-phase result card (opt-in)

`twoPhase` changes how a reply is presented **for turns that run tools**:

1. While the turn runs, the live streaming card shows only a tool timeline (plus optional narration) instead of the streaming answer text.
2. On completion, that card settles to a one-line collapsed summary (`✅ 已完成 · source · steps · duration`).
3. The full answer is delivered as a separate **green result card**.

It is **disabled by default**; when disabled the channel behaves exactly as before. Enable it at the channel level or, to pilot it on a single bot, per account (per-account overrides the channel default):

```json
{
  "channels": {
    "feishu": {
      "twoPhase": { "enabled": true }
    }
  }
}
```

```json
{ "channels": { "feishu": { "accounts": { "primary": { "twoPhase": { "enabled": true } } } } }
```

`footerMeta` (default `true`) shows a grey `Agent/Model/Provider · tokens · duration` footer on the result card using only values actually observed for the turn (no values are invented).

Delivery always falls back to the standard path whenever the feature is off, the turn ran no tools, the reply is media/voice or a native presentation card, or the answer exceeds the card size limit. If the green result card cannot be sent after the processing card settles, the full answer is recovered through the normal static-card path so content is never silently dropped.
