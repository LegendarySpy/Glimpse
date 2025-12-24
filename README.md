<div align="center">
  <h1>Glimpse</h1>
    <p>(in beta)</p>
  <img
    src="https://github.com/user-attachments/assets/c34a35a5-e2c9-469f-87c4-4c0d20c8082d"
    width="256"
    height="256"
    alt="current"
  />
    <p>Glimpse is a voice-to-text productivity app that lets you create and build at the speed of speech. Think of it as an open-source alternative to Superwhisper or Wisprflow.
</p>
</div>



> [!NOTE]
> **macOS only** — Glimpse currently supports macOS 11+ exclusively. Windows and Linux support may be added in the future.

## Download

Pre-built releases are available on the [Releases page](https://github.com/LegendarySpy/Glimpse/releases). Download the latest `.dmg` and drag Glimpse to your Applications folder.

## Features

- **Local transcription** — Runs entirely on-device using Whisper or Parakeet models
- **Cloud transcription** — Optional paid cloud mode for those who prefer it
- **Replacements** - Directly replace words in sentences for other defined words
- **Custom dictionary** — Define custom words and phrases for accurate transcription
- **Assistive text insertion** — Automatically inserts transcribed text where you're typing
- **More coming soon** — See the [Roadmap](#roadmap) below

## Building Locally

### Prerequisites

- macOS 11+
- [Rust](https://rustup.rs/) 1.74+
- [Bun](https://bun.sh/) (or npm/pnpm)
- Xcode Command Line Tools

```bash
xcode-select --install
```

### Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/LegendarySpy/Glimpse.git
cd Glimpse
bun install
```

### Development

Run in development mode with hot reload:

```bash
bun tauri dev
```

### Production Build

Build a release version:

```bash
bun tauri build
```

> [!TIP]
> After running production builds, you may need to re-enable accessibility permissions in System Settings for text insertion to work.

## Roadmap

- [x] Custom dictionary for words and phrases
- [ ] Temporary mode: transcribe without saving
- [x] Built-in updater
- [ ] Transcribe audio and video files
- [ ] App localization
- [ ] Personalization & per app context: per-app writing styles (email, messaging, etc.)
- [ ] Edit mode: rewrite selected text with full context
- [ ] Ask mode: query what's on your screen

## Privacy

Glimpse collects anonymous usage analytics via [Aptabase](https://aptabase.com/) to help improve the app. This includes:

- App launches and session duration
- Which transcription engine is used (local vs cloud)
- Model downloads and onboarding completion

**What's NOT collected:** transcription content, API keys, prompts, or any personally identifiable information.

Analytics are privacy-first and GDPR compliant. No opt-out is currently provided, but the data is fully anonymous. For full transparency, see [`src-tauri/src/analytics.rs`](src-tauri/src/analytics.rs) for exactly what's tracked.

## License

Glimpse is licensed under the **GNU Affero General Public License v3 (AGPL-3.0)**. You can self-host or modify it as long as changes remain open. A paid hosted option will be available for those who prefer a managed instance.

## Acknowledgments

- [Tauri](https://v2.tauri.app/) — the framework Glimpse is built on
- [Transcribe-rs](https://github.com/cjpais/transcribe-rs) — the underlying STT engine that powers local transcription
