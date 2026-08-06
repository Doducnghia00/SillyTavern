# Plan: LLM prompt builder for message image generation

## Goal

Improve the paintbrush action on a roleplay message by asking a separately selected Chat Completion model to return a complete English diffusion prompt before image generation.

## Scope

Only the first paintbrush generation for a message without generated media is enhanced. Existing media swipes keep reusing their saved prompt and negative prompt, so they remain deterministic and do not spend another LLM request.

No SD model, sampler, scheduler, CFG, seed, dimensions, provider credentials, or active chat model is changed.

## Settings and UI

Add a compact **Message Prompt Builder** block to Image Generation settings:

- Enable/disable toggle; enabled for this installation as the requested message-paintbrush behavior.
- Model selector populated from the current Chat Completion provider's model list.
- Context message count (`0–10`, default `3`).
- Include character information toggle (default enabled).

The builder uses the current Chat Completion provider, URL, key, and connection settings, but overrides only the model for its own non-streaming request. It never changes the model selected for roleplay chat.

## LLM input

A bounded request contains:

1. A strict system instruction to output JSON only and construct one coherent still-image moment.
2. The selected roleplay message.
3. Up to the configured number of preceding non-system chat messages, labeled with speaker names.
4. Character card information when available: name, description, personality, scenario, and character-specific image prompt fields.
5. Current common and character-specific positive/negative image prompts as guidance.

The model is instructed to return final prompt text, not prose or an explanation. It must use English comma-separated diffusion tags/short phrases and omit dialogue, thoughts, backstory, and invisible traits.

## Output contract

Structured JSON:

```json
{
  "prompt": "complete English positive prompt",
  "negative_prompt": "complete English negative prompt"
}
```

Both fields are final. The regular global/character prefix concatenation is skipped for successful builder output to prevent duplication. SD runtime parameters remain controlled by Image Generation settings.

## Runtime flow

```text
Paintbrush on message with no media
  -> gather bounded context and character data
  -> call selected Chat Completion model with JSON schema
  -> validate non-empty prompt
  -> refine/edit UI if enabled
  -> send final prompt + negative prompt to the existing image provider
  -> save both in media attachment

Existing media swipe
  -> reuse saved prompt + negative prompt
  -> no LLM request
```

## Failure behavior

If the builder is disabled, has no model, or the LLM request/JSON validation fails:

- show a concise warning for an actual request failure;
- continue through the existing raw-message path;
- the existing server-side Vietnamese-to-English translation remains the fallback for A1111.

Aborting the paintbrush action also aborts the builder request.

## Files

- `public/scripts/extensions/stable-diffusion/index.js`: settings, context assembly, structured request, paintbrush integration.
- `public/scripts/extensions/stable-diffusion/settings.html`: isolated UI block.
- `docs/image-generation-message-button-context-issue.md`: update current behavior/resolution notes.

No new server endpoint is required: the existing authenticated Chat Completion proxy already supports a model override and structured output.

## Verification

1. JavaScript syntax and `git diff --check`.
2. Settings persist without changing the active chat model.
3. Builder request uses the selected model and returns parsed JSON.
4. Final SD payload contains the generated English prompt and generated negative prompt once, without automatic prefix duplication.
5. A second image swipe performs no new LLM request and reuses saved values.
6. Builder failure falls back without blocking image generation.
7. SillyTavern service and nginx origin remain healthy.
