# Image generation from the message paintbrush: context and prompt issue

## Scope

This note documents the Image Generation paintbrush button attached to a chat message (`.sd_message_gen`), especially the first generation and subsequent media swipes.

## Observed behavior

When the selected chat message has no existing media, `sdMessageButton()` creates a synthetic media attachment with:

```js
{ url: '', title: message.mes, type: MEDIA_TYPE.IMAGE, generation_type: generationMode.FREE }
```

`generateMediaSwipe()` then reads that value as `savedPrompt`, optionally opens the manual Refine Mode editor, and passes it to `sendGenerationRequest()`.

Because the generation type is `FREE`, this path does not call the LLM image-prompt generator. The positive prompt sent to Stable Diffusion is effectively:

```text
global prompt prefix + message.mes
```

A character-specific prefix may still be included for message swipes in a character chat, but no earlier chat messages are appended.

For an existing generated image, subsequent swipes reuse the prompt saved in `mediaAttachment.title` (or fall back to `message.extra.title`). They also do not regenerate a contextual prompt with the LLM.

## Context boundary

For this paintbrush/swipe path:

- Included: the selected/current message text (`message.mes`) when there is no image yet.
- Optionally included: global and character positive/negative prefixes.
- Not included: preceding messages, broader chat history, relationship state, prior actions, or scene continuity.
- Not performed automatically: translation to English, extraction of visible details, removal of dialogue/internal thoughts, or conversion to SD-style tags.

Therefore, a Vietnamese roleplay message can be sent nearly verbatim to an English/tag-oriented SD checkpoint. The request can succeed technically while producing an image unrelated to the intended scene.

## Confirmed runtime example

Two requests observed on 2026-08-06 sent the same Vietnamese roleplay message beginning with:

```text
best quality, absurdres, masterpiece, *Camille tăng tốc độ...*
```

Both returned HTTP 200, but the prompt was not an LLM-produced visual description.

## Relevant code

- `public/scripts/extensions/stable-diffusion/index.js`
  - `sdMessageButton()` around lines 5149–5220
  - initial fallback using `title: message.mes` around line 5207
  - `generateMediaSwipe()` around lines 5271–5333
  - `sendGenerationRequest()` around lines 3317–3450
  - `generateAutoImage()` around lines 3797–3861

## Desired behavior for discussion

A more context-aware flow could use the selected message plus a bounded number of preceding messages, ask the configured LLM for a concise English visual prompt, then save that processed prompt for later swipes. The design still needs decisions about context size, latency/cost, language, manual review, privacy, fallback behavior, and whether existing swipe semantics should remain deterministic.
