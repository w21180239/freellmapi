# Image

- Prompts for free image models need four parts: subject and position ("a single red circle centred on a pure white background"), style (flat vector, photorealistic, isometric), light and background, exclusions (no text, no watermark). `"a red dot on white, minimal"` returns noise.
- Change one variable per retry rather than adding adjectives.
- Providers often return JPEG for a `.png` request. `freellm image` prints a stderr note when the bytes differ from the extension; rename before converting or embedding.
- View the file before delivering it: a successful call can return an image unrelated to the prompt.
- `no enabled image provider` / 503: image providers are switched off in the app. Noise output: rewrite the prompt.

