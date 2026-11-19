# Audio

- Text to speech: voices take OpenAI names (alloy, nova, echo, fable, onyx, shimmer) and unknown names fall back to the provider default. `--format` accepts mp3, wav, opus, flac, aac; wav is large, so use mp3 for long text. Split long text into chunks and join with `ffmpeg -f concat`.
- After `speak`, check `bytes` in the stderr line: a few hundred bytes is an error page; a few seconds of speech is 20-100 KB.
- Transcribe: 25 MB limit. Extract the audio track first: `ffmpeg -i in.mp4 -vn -ar 16000 -ac 1 out.mp3`. Pass `--lang` (zh, en, ja) when known; it raises accuracy. `--format verbose_json` returns segments with timestamps for subtitles; build srt/vtt yourself (`srt` returns 400, `vtt` works on the Cloudflare path only). `auto` fails over between groq and cloudflare; `freellm models --kind transcription` lists explicit ids.
- Round-trip check for a suspect chain: `speak` a known sentence, `transcribe` the file, compare the text.
- `no_transcription_models` / 503: the catalog has no transcription model yet; refresh it in the app. `unsupported_format`: use json, verbose_json or vtt.

