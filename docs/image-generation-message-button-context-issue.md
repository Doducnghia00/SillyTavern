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

## Implemented resolution

The message paintbrush now has an optional Message Prompt Builder. For the first image on a message it sends the selected message, bounded preceding context, character information, and current positive/negative guidance to a separately selected Chat Completion model. The model returns final structured English `prompt` and `negative_prompt` values. They are saved with the generated media and reused without another LLM call on later swipes.

If prompt construction fails, the original message flow remains available and the A1111 server endpoint still translates Vietnamese as a final fallback.
