# Glimpse Desktop

Glimpse is a Tauri + React overlay that records short microphone snippets, sends them to a local NVIDIA Parakeet server, and pastes the returned transcription directly into the focused application via macOS accessibility APIs.

## Prerequisites

- macOS 13+
- Rust toolchain + Bun (for the UI)
- Running instance of the Python service inside `../Glimpse-Server` (see that folder's README)
- Accessibility permission granted for Glimpse (System Settings → Privacy & Security → Accessibility)

## Transcription Bridge

The Tauri process posts every saved MP3 to the local FastAPI server. Configure the bridge via environment variables in `src-tauri/.env` (loaded with [`dotenvy`](https://crates.io/crates/dotenvy)):

| Variable | Default | Description |
| --- | --- | --- |
| `GLIMPSE_API_URL` | `http://127.0.0.1:9001` | Base URL for the Parakeet FastAPI server |
| `GLIMPSE_API_KEY` | `local-dev-key` | API key sent as the `x-api-key` header |
| `GLIMPSE_INCLUDE_WORD_TIMESTAMPS` | `false` | When `true`, asks the server for per-word timestamps |
| `GLIMPSE_AUTO_PASTE` | `true` | Toggle automatic clipboard + ⌘V injection |

When a recording finishes, the overlay status changes to **Transcribing…**. Once the server responds, the transcript is copied to the clipboard and Glimpse issues a `Cmd+V` to paste into the active text field. If Accessibility permissions are missing, you will see a "transcription error" toast and the transcript stays on the clipboard so you can paste manually.

## Development

```bash
# Terminal 1 – start the FastAPI server
cd ../Glimpse-Server
uv run -- uvicorn app.main:app --reload

# Terminal 2 – run the desktop app
cd Glimpse
bun install
tauri dev
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
