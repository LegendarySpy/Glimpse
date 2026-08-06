<div align="center">
  <h1>Glimpse</h1>
  <p>On-device voice dictation. Open-source, private by default.</p>
  <img
    src="./assets/readme/icon.png"
    width="256"
    height="256"
    alt="Glimpse"
  />
  <p>
    <a href="https://tryglimpse.cc/download">Download</a> ·
    <a href="https://tryglimpse.cc/">Website</a> ·
    <a href="https://tryglimpse.cc/#pricing">Pricing</a> ·
    <a href="https://tryglimpse.cc/privacy">Privacy</a>
  </p>
  <p>
    <a href="https://tryglimpse.cc/download">
      <img src="https://img.shields.io/badge/macOS%2014%2B-1d1d1f?style=for-the-badge&logo=apple&logoColor=white" alt="macOS 14+" />
    </a>
    <a href="https://apps.microsoft.com/detail/9PJWF4W8V4WG">
      <img src="https://img.shields.io/badge/Windows%2010%2B-0078D6?style=for-the-badge&logo=windows11&logoColor=white" alt="Windows 10+, on the Microsoft Store" />
    </a>
  </p>
</div>

---

Core dictation is free, runs on-device, and has no word limits. A license adds everything else, such as AI features, media transcription, and automations.

## Screenshots

<p align="center">
  <img src="./assets/readme/home.png" width="49%" alt="Glimpse home screen showing recent transcriptions" />
  <img src="./assets/readme/dictionary.png" width="49%" alt="Glimpse dictionary screen" />
</p>

<p align="center">
  <img src="./assets/readme/personalization.png" width="49%" alt="Glimpse personalization screen" />
  <img src="./assets/readme/library.png" width="49%" alt="Glimpse library screen for imported audio and video files" />
</p>

## Features

**Free, always**

- **Local transcription.** Turn your wifi off, it still works. ANE supported on Apple Silicon.
- **Custom dictionary.** Teach it names, brands, or terms.
- **Auto Dictionary.** It picks up your custom words on its own.
- **Replacements.** Say "my address," get 221B Baker Street.
- **History and search.** Find anything you've dictated.

**With a license**

Free during the 14-day trial, then any [license](#pricing):

- **Library.** Drop in audio or video, scrub the synced transcript, assign speakers, export to `.txt`, `.md`, `.srt`, or `.vtt`.
- **AI Cleanup.** Polish dictated text with your own LLM.
- **Edit Mode.** Highlight text, say what you want, and watch it rewrite in place.
- **Personalization.** Different tones per app or site, with [snippets](https://github.com/glimpse-hq/Glimpse/wiki/snippets) for dynamic context.
- **Local API.** An OpenAI-compatible speech endpoint, running on your machine.
- **CLI.** An optional `glimpse` command for the terminal.

Configure AI writing in **Settings → Providers**. Speech models live in **Settings → Models**.

## Integrations

- **[Raycast](https://www.raycast.com/garon/glimpse)**. Search dictations, transcribe files, switch models, and more, without leaving Raycast. Requires a [license](#pricing).

Want to build your own? See the [CLI guide](https://github.com/glimpse-hq/Glimpse/wiki/CLI).

## Pricing

| Edition        | Price             | For                                       |
| -------------- | ----------------- | ----------------------------------------- |
| **Personal**   | $24.99 one-time   | You, on up to 5 personal devices          |
| **Commercial** | $48 / seat / year | Work use, one seat per person, one device |

Start with the 14-day trial, then buy or paste a license key in **Settings → Account**.

## Privacy

Transcription stays on-device by default.

The app sends anonymous usage telemetry via [PostHog EU](https://posthog.com/) to help prioritize development. It's tied to a random install ID, not your identity, and stored in the EU.

- **Collected:** app version and platform, launches and uptime, durations and counts, country, and bounded error/crash categories. A crash also records a code location (source file and line, or module and offset) so we can find the bug.
- **Never in the telemetry payload:** transcripts, audio, API keys, prompts, raw error text or stacks, file paths or names, microphone names, provider endpoints, your IP address, or anything personally identifiable.

Opt out anytime in **Settings → App**; opting out sends one final ping, then nothing, ever.

Enabling an external speech or LLM provider sends audio or text directly to that provider. Your API keys stay local.

The above is about this app. The website, tryglimpse.cc, is a separate system: it uses Cloudflare Web Analytics for aggregate page views, and Cloudflare's edge processes ordinary request logs (including IP addresses) to serve and protect it. Neither can see anything about your app usage. The [privacy policy](https://tryglimpse.cc/privacy) covers all three.

For the full picture on app telemetry, see the [analytics wiki](https://github.com/glimpse-hq/Glimpse/wiki/Analytics) or [`analytics.rs`](src-tauri/src/analytics.rs).

## License

The source code is licensed under [AGPL-3.0](LICENSE). If you distribute Glimpse or run it as a network service, you must make your modified source available under AGPL-3.0.

**Trademarks.** The Glimpse name and logo are not part of the AGPL-3.0 license. Forks and redistributions must use a different name and icon.

## Contributing

Want to help? The [Contributing Guide](CONTRIBUTING.md) covers everything from translations to code to bug reports.

Questions, bugs, or feedback: [hello@tryglimpse.cc](mailto:hello@tryglimpse.cc) or GitHub Issues.

## Acknowledgments

- <a href="https://lokalise.com/"><img src="./assets/readme/lokalise.png" width="16" alt="Lokalise" align="center" /></a> [Lokalise](https://lokalise.com/) (localization platform, OSS supporter)
- [Tauri](https://v2.tauri.app/) (app framework)
- [Glimpse-Speech](https://github.com/glimpse-hq/Glimpse-Speech) (MIT, local transcription engine)
- [whisper-rs](https://codeberg.org/tazz4843/whisper-rs) (Unlicense, Rust bindings for Whisper)
- [parakeet-rs](https://github.com/altunenes/parakeet-rs) (MIT OR Apache-2.0, ONNX Runtime bindings for Parakeet)

**Speech models** are downloaded in-app from Hugging Face; the live list lives in **Settings → Models**. By family:

- **Whisper GGML** (MIT), via [`ggerganov/whisper.cpp`](https://huggingface.co/ggerganov/whisper.cpp)
- **Distil-Whisper GGML** (MIT, English-only), via [Pomni's conversions](https://huggingface.co/Pomni) of [`distil-whisper`](https://huggingface.co/distil-whisper)
- **Parakeet TDT ONNX** (CC-BY-4.0), via [`istupakov`](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx)
- **Parakeet Unified ONNX** (CC-BY-4.0, English-only), via [`bobNight`](https://huggingface.co/bobNight/parakeet-unified-en-0.6b-onnx)
- **Nemotron Streaming ONNX** (NVIDIA Open Model License), via [`altunenes/parakeet-rs`](https://huggingface.co/altunenes/parakeet-rs)
