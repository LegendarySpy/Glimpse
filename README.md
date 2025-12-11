# What's Glimpse?

Glimpse is a productivity app built on Tauri for cross-platform support. Its purpose is to make it easier & faster to create & build at the speed of speech. If you've used Superwhisper or Wisprflow, think of this as the open-source alternative.

> **Licensing & hosting**
>
> Glimpse is licensed under the **GNU Affero General Public License v3 (AGPL-3.0)**. You can self-host or modify it as long as changes remain open. A paid/hosted plan will be available for individuals or teams that prefer a managed instance.

## Running locally

### Prerequisites

- macOS 13+
- [Rust](https://rustup.rs/) 1.74+
- [Bun](https://bun.sh/) (or npm/pnpm)
- Xcode Command Line Tools (`xcode-select --install`)

### Development

```bash
git clone https://github.com/LegendarySpy/Glimpse.git
cd Glimpse
bun install
bun tauri dev
```

### Production build

```bash
bun tauri build
```
> Note when running production builds sometimes you may need to remove and re-enable accessibility features to make them work again.
## Roadmap

- [x] Custom dictionary for words and phrases
- [ ] Temporary mode 0 doesn't save transcriptions at all (either keybind or global mode)
- [ ] Built in updater
- [ ] Personalization features (per app writing styles: emailing, messaging etc)
- [ ] Contextual awareness (detect destination app and adjust tone)
- [ ] Edit mode (rewrite selected text with full context)
- [ ] Ask mode (query what's on your screen)

## Thank you

* [Tauri](https://v2.tauri.app/) - the framework Glimpse is built on
* [Transcribe-rs](https://github.com/cjpais/transcribe-rs) - the underlying STT engine that powers Glimpse locally


