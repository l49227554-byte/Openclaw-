---
summary: "Use TEKIZAI intelligent model routing in OpenClaw"
read_when:
  - You want to use TEKIZAI as a model provider
  - You need a TEKIZAI API key or setup help
title: "TEKIZAI"
---

[TEKIZAI](https://tekiz.ai) provides intelligent routing across authorized
model providers through an OpenAI Responses-compatible API.

| Property | Value                     |
| -------- | ------------------------- |
| Provider | `tekizai`                 |
| Auth     | `TEKIZAI_API_KEY`         |
| API      | OpenAI Responses          |
| Base URL | `https://api.tekiz.ai/v1` |

## Getting started

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/tekizai-provider
    ```
  </Step>
  <Step title="Add your API key">
    Set `TEKIZAI_API_KEY`, or let onboarding prompt for it.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice tekizai-api-key
    ```
  </Step>
  <Step title="Verify models">
    ```bash
    openclaw models list --provider tekizai
    ```
  </Step>
</Steps>

Onboarding selects `tekizai/auto`. The provider also exposes
`tekizai/frontier` and `tekizai/fusion` routing profiles. Availability depends
on your TEKIZAI account.

The catalog uses a conservative 4096-token output budget. Routing profiles can
select different upstream models, so this is a default budget rather than an
advertised maximum. Adjust `maxTokens` in your model configuration when needed.
Token cost estimates are unset (zero); consult TEKIZAI for actual billing.

## Config example

```json5
{
  env: { vars: { TEKIZAI_API_KEY: "..." } },
  agents: { defaults: { model: { primary: "tekizai/auto" } } },
  models: {
    mode: "merge",
    providers: {
      tekizai: {
        baseUrl: "https://api.tekiz.ai/v1",
        api: "openai-responses",
        headers: { "X-TEKIZAI-Route-Disclosure": "host-model-prefix" },
      },
    },
  },
}
```

The example opts into the optional disclosure header, which asks TEKIZAI to
return routed-model information with a host-model prefix. Omit `headers` if you
do not want that prefix; onboarding does not enable it by default.

<Tip>
Model IDs in provider configuration are bare (`auto`, `frontier`, `fusion`).
OpenClaw adds the provider prefix when selecting a model, for example
`tekizai/auto`.
</Tip>
