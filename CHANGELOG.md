1.0.6

### Improvements

- Your first dictation after setup is faster. The model now loads in the background as soon as it finishes downloading, instead of on your first recording.
- Choosing a model during setup now names the actual models and shows what each one supports, instead of Accurate, Balanced, and Small.
- Glimpse now tells you when a recording was too quiet or had no speech, instead of discarding it without a word.

### Fixes

- Fixed the default dictation shortcut on Windows. Alt+Space opens the Windows window menu, so Glimpse never received it. New setups use Ctrl+Shift+Space. If you set Glimpse up before this update, pick a new shortcut under Settings, General.
- Fixed the Usage Analytics box stretching down the page on Windows.
- Fixed the Glimpse icon showing small on a blue square in the Microsoft Store version. The 1.0.4 fix for this never took effect.
- Fixed the Glimpse icon looking blurry on high-resolution Windows displays.
- Fixed the export options panel opening off the edge of the window, where it couldn't be clicked.
- Fixed the Dictionary warning appearing when a cloud speech model is selected. Cloud models use your dictionary, so the warning didn't apply.
- Fixed the API start and stop buttons splitting onto two lines in languages other than English.

---

1.0.5

### Features

- There is now a notification menu in the top right to show new updates surrounding Glimpse.

### Improvements

- The recording pill has reduced latency.
- Your account is back in the top right. Click it to open Account.
- Added Spanish language support.
- Improved translations across every supported language.

### Fixes

- Fixed long membership details being cut off on the account card.
- Fixed the app language sometimes switching back after changing Settings tabs.
---

1.0.4

### Features

- Glimpse is now available in Arabic, Dutch, French, German, Hindi, Italian, and Russian. It follows your system language, or pick one under Settings, App.
- Export your recordings and transcripts as audio and text pairs, ready for fine-tuning. Find it under Settings, About. Timestamps are optional.
- Delete all data from Settings, About. Hold the button to erase everything Glimpse has stored and quit the app.

### Improvements

- Video imports on Windows now work out of the box for common MP4, MOV, and WebM files. FFmpeg is only needed as a fallback for less common codecs.
- Microsoft Store installs now include a proper `glimpse` command that stays connected to the Store version.

### Fixes

- Fixed library files sometimes failing to delete on Windows.
- Fixed the Glimpse icon appearing too small with a blue background in Windows.
- Fixed sidebar icons sitting slightly off-center on Windows.

---

1.0.3

### Features

- Added Apple Speech, the transcription built into your Mac. Spoken punctuation and emoji work like system dictation ("comma", "new line", "thumbs up emoji"). Requires macOS 26 on Apple Silicon.
- Added Apple Intelligence as a writing model provider. Requires macOS 26 on Apple Silicon with Apple Intelligence turned on.
- Glimpse is now on the [Microsoft Store](https://apps.microsoft.com/detail/9PJWF4W8V4WG), and it's now the main way to install on Windows. Store installs are signed by Microsoft and update through the Store. Downloads from GitHub keep the built-in updater.

### Changes

- Personality instructions are now in charge of cleanup when a mode matches. 

### Fixes

- Fixed long error messages overflowing the Settings sidebar.

---

1.0.2

### Improvements

- History now loads much faster and stays smooth with thousands of transcripts.
- History search, sorting, and scrolling no longer need to load your entire transcript library at once.
- Reduced unnecessary background work and frontend overhead to make Glimpse feel lighter.
- Settings now save more reliably.

### Fixes

- Fixed numbered lists being cut off in formatted transcripts.

---

1.0.1

### Improvements

- Improved UI stability.
- Improved crash reporting so startup and frontend issues are easier to diagnose.

---

1.0.0

### Features
- You can now install Glimpse with Homebrew: `brew install --cask glimpse-hq/tap/glimpse`. This sets up the app and the `glimpse` command together. Updates still come through Glimpse itself.
- Added OpenRouter as a first class cloud speech provider, with its transcription models listed automatically.
- Library transcriptions can now detect speakers automatically when you use a provider that supports it (like Mistral). Turn on Detect speakers when importing or retranscribing and the transcript gets labeled by who's talking.

### Changes

- Enabled 3rd party STT models now show in the models screen. This replaces the warning.

### Improvements
- Serving models via API to other model providers is smoother.
- The API now automatically adds url prefixes if you forget.
- The CLI commands have been overhauled to be cleaner and show you all options.
- Many UI elements have been tweaked to be cleaner.
- Glimpse can now be auto refocused by searching it up in windows, instead of having to use the tray.
- (Nvidia) Long imported files now fill in their transcript and timestamps as they process, instead of only showing up once the whole file is done.

### Fixes

- Fixed the CLI not being able to use different media formats.
- The models screen now shows which cloud provider and model is active, instead of leaving the name blank.
- Fixed remote speech model lists not loading from some self-hosted servers.
- Fixed Perplexity not working as a language model provider.
- The Custom speech provider no longer defaults to an OpenAI model that may not exist on your endpoint.
- The library will now correctly react to OS level pauses.
- On Windows, license activation links now work when Glimpse is already running, instead of being ignored.
- Fixed a startup crash for some modern CPUs on Windows.

---

0.9.9

### Features

- Added Parakeet Unified (experimental): one English model that handles both fast file transcription and live streaming, so a single download covers what used to take two. It's about a quarter the size of Nemotron Streaming, faster, and adds word-level timestamps.

### Improvements

- The Glimpse command-line tool can now do much more. Beyond transcribing files, you can browse and search your history, import and export library items, manage your dictionary and replacements, switch models, and check status, so you can script Glimpse or build your own integrations (Raycast, alfred, etc.). Run `glimpse --help` to explore, and add `--json` to any command for easy scripting.
- Tidied up model names so it's clearer what each one is.
- Older models can now be marked Legacy. They no longer show up to download, but if you already have one installed you can keep using it.
- You can now open the customer portal to manage your license straight from the account view, even when you're signed out.
- The start of your recordings no longer gets clipped: the mic now warms up as the pill appears, so your first word makes it in.
- Fixed a rare hang where transcription could stall for a while if the app you were in was slow to respond.
- Fixed library items that could come unstuck from their audio after an update.
- Licensing is more reliable behind the scenes.

### Changes

- Nemotron Streaming is now Legacy, superseded by Parakeet Unified. It won't appear to download anymore, but if you already have it installed it keeps working.
- Updated onboarding for a more unified experience.
- Small UI changes.
- Small change to the UI icon for a cleaner look.

### Fixes

- When using a streaming model, it could get mixed with ongoing library transcriptions if being done simultaneously.

---

0.9.8

### Features

- Playing back transcripts in library view now show word-level timestamps. (You will need to retranscribe library items for this to take effect)

### Improvements

- Local transcription is faster: Parakeet and Nemotron now use more performance cores, making them up to 50% quicker.
- Fixed a bug where live-streamed words could be blurred and improved streaming animations.
- The about page now has a new support page, you can export logs here too.
- Glimpse now uses Silero VAD for higher quality noise cancellation.
- You can now say Thank you.

---

0.9.7

### Features

- Added support for using mouse buttons as keybinds.

### Improvements

- The library import modal is now cleaner and supports more options.

---

0.9.6

### Features

- Whisper models can now run on the Apple Neural Engine (ANE) on Apple Silicon Macs, making transcriptions faster and more power-efficient.
- Library overhaul: A new cleaner UI, support for assigning speakers, and better performance.

### Improvements

- Much of Glimpse in this update has been optimized for an even smoother experience :)
- Local Whisper transcription is up to 30% faster after decoder tuning.
- Improved performance and reduced memory use during transcription, especially for longer recordings and cloud speech providers.
- Improved recording pill responsiveness and reduced unnecessary background work while recording.
- Improved History performance when loading recordings or importing transcripts.
- Parakeet now transcribes long recordings in chunks, improving transcriptions past around 5 minutes.

### Changes

- Onboarding setup is down to one question and on Apple Silicon the Neural Engine encoder comes included automatically.
- Distil whisper models are now under experimental (They're not great at following dictionary rules).

---

0.9.5

### Improvements

- The recording pill now moves out of the way when your cursor is near it.
- Models page revision: each model shows its quantization and installed versions are highlighted.
- What's New now renders full Markdown.

### Changes

- Home greetings no longer change based on the day of the week.
- Recordings now stop on their own after 30 minutes.

### Fixes

- The Models screen now updates right away when you install or delete a model, instead of only after reopening Settings.
- Cancelling a model download partway through no longer leaves an empty model folder behind.

---

0.9.4

### Features

- Onboarding is now a quick guided setup: tell Glimpse which language you dictate in and whether to prioritize quality, balance, or size, and it picks and downloads the right local model for you.
- New model browser for choosing local models: search by name, filter by category, and see each model's size and supported languages at a glance. Quantization options (Q5, Q8, Full) are grouped under each model so switching between them is simpler.

### Improvements

- Words spoken on your account card is now a running lifetime total, it counts everything you've dictated and is no longer based on the current amount of transcripts.
- Model downloads are now verified after they finish, so an interrupted or corrupted download won't leave you with a broken model.
- The transcription language list now clearly separates the languages your current model supports from the ones that need a different model.
- Auto Dictionary now works with online transcription providers, not just local models.

### Fixes

- Fixed cancelling a dictation and immediately starting a new one occasionally pasting the cancelled text and glitching the recording pill.
- Fixed the Nemotron Streaming model downloading mismatched files, which left it broken and showing the wrong size.

---

0.9.3

### Features

- Glimpse can now recover recordings if the app closes while you're still dictating, then save them to History when you reopen it.

### Improvements

- Home now has a date header with rotating greetings and today's dictation stats.
- Setting shortcuts now works more like other apps: press the full combo, release all keys to save it, and the result no longer depends on which key you let go of first.
- Transcript history search is cleaner now, with quick sorting and time filters for finding older dictations faster.
- The license card in Settings → Account and onboarding now surfaces plan pricing more clearly, including per-seat Commercial licensing and volume discounts.
- Personalization mode handles long app and website lists better and looks a bit cleaner.

### Changes

- Updated Glimpse Personal pricing: Personal is $24.99, and Commercial licensing starts at $19.99 per seat with volume discounts as your team grows.

### Fixes

- Fixed cancelling a dictation while it's processing sometimes still pasting the text.

---

0.9.2

### Features

- During onboarding, Glimpse can detect Aqua Voice, superwhisper, Wispr Flow, or Handy and import what you want, dictionary words, text replacements, personalization modes, shortcuts, language, launch-at-login, speech models, and past transcripts.

### Changes

- Auto-pause media now works system-wide on macOS and Windows, not just with a handful of apps. In Settings → App you can pause playback completely, duck it to 10%, 25%, 50%, or 75%, or turn it off.
- Glimpse CLI can now be pointed at any whisper models, it is no longer locked to Glimpse specific ones.

### Fixes

- Fixed some modifier-only shortcuts, like Fn or Option, occasionally not responding.
- Fixed HTML-style lists in transcript history showing as plain text.
- Fixed the Transcription Language dropdown in Settings opening behind the Edit Mode section.
- Cleaned up some UI elements.

---

0.9.1

### Features

- If you use Launch at Login, you can now choose to start in the background so Glimpse opens to the menu bar instead of the main window. (#63)
- You can now use online transcription services in Settings → Providers, not just local models.
- When the API server is running, the sidebar shows you it's active along with the address and how many requests it's handled.

### Improvements

- Recording should transcribe a little more accurately.
- Shortcuts should feel easier to set and more reliable day to day.
- The model menu is cleaner now: it shows what Glimpse is using, lets you switch remote speech on or off, and only lists local models you've downloaded.
- Start in background is on by default when Launch at Login is enabled.
- More UI improvements.

### Fixes

- Fixed library error cards being hidden under other cards.
- Fixed website favicons not showing in Personalization.
- Fixed opening What's New from the menu bar before Settings was ready.

---

0.9.0

### Features

- Glimpse Personal is here. Dictation is still free, but the more advanced stuff now has a one-time license so I can keep making this without exploding.
- Local API! You can now start a local OpenAI-compatible endpoint from Settings → Developer → API Server, choose the host/port/model, add an API key, enable CORS, and optionally start it on launch.
- Added an optional `glimpse` command line install from About → Advanced, for using Glimpse from the terminal.
- Added a new Providers tab split from Models, with a fresh new design.

### Improvements

- Account has been replaced with a cleaner license view, including trial status, activation, and buying Personal / Commercial.
- Settings got reorganized into Core, Local, and Developer sections. Models is for speech models only; AI writing has its own Providers tab.
- Auto-delete in Settings → App now lets you choose **Audio** or **Transcripts**, not just local recordings. Audio-only keeps your transcript history; deleting transcripts also removes the audio they reference.
- (i) has been updated to now support email support.
- Redesigned About with Updates and FAQ up front, plus a clearer storage breakdown.
- Small redesign in personalization to look cleaner.
- Improved button rendering across the app for different view sizes.
- Models tab has been redesigned to work better at a glance. (or a Glimpse.. :) )
- Model downloads now use the shared Glimpse Speech model manager. Installs, progress, cancellation, and model metadata should feel more consistent.
- Onboarding now keeps more of your existing setup when finishing, does a better job picking the recommended local models, and has a calmer license step at the end.

### Fixes

- Fixed auto-delete forgetting whether you picked Audio or Transcripts when duration was set to Never, or after closing and reopening settings.
- Fixed the auto-delete dropdowns resizing and scrolling awkwardly when switching between Audio and Transcripts.
- Fixed the home transcription list shifting around while it loads.
- Fixed a bug where the app would resize on startup to large or small.

---

0.8.7

### Improvements

- LLM cleanup has been improved for mid-conversation corrections.
- The pill now has animations and has a different background based on the stage of processing.
- Settings errors now show in the sidebar, so they are easier to find without jumping back to General.
- Shortcut conflicts should feel less weird while editing. Bad shortcuts stay visible until you fix them instead of silently changing.
- Cleaned up a few Settings spacing and text-size issues, especially around shortcuts and permissions.
- Fixed an onboarding bug preventing completion.

---

0.8.6

### Features

- Keybinds can now have temporary mode and cleanup set individually. You can find more in the General settings tab's Shortcuts info button.
- Auto Dictionary: Corrected words are now automatically detected, with prompts to add them to your dictionary.
- Personalization entries now support snippets, allowing you to add dynamic information like {{time}} or {{site}}

### Improvements

- UI refinements
- On supported text fields, capitalization automatically matches previous text.
- Background system commands on Windows run silently now, preventing brief command prompt window flashes.

---

0.8.5

### Improvements

- Keybinds should feel much more reliable, especially with repeated presses and custom shortcuts.
- Settings and personalization should open faster and save more consistently.
- Model changes now save immediately, and recordings keep using the model they started with.
- Media pausing during recordings is more reliable.
- The pill and toast windows behave more predictably without stealing focus.
- AI cleanup has stronger prompt-injection guardrails.
- Edit mode works better in terminals and TUIs.
- Improved Windows key handling and tray behavior.

  0.8.4

### New Features

- Windows support! 🎉🎉

### Improvements

- Improved many UI elements, improving readability and sizing.
- Fixed an onboarding bug.

  0.8.3

### New Features

- Windows support! 🎉

### Improvements

- Significantly improved keybind registration, much more reliable across edge cases.
- Separated usage analytics so they can be toggled independently.
- Some animations have been micro-adjusted to be better.
- Multimonitor users should notice a more intuitive experience.

### Bug Fixes

- Fixed hover states on library and personalization buttons.
- Fixed streaming warning cleanup on Intel macOS.

---

0.8.2

### New Features

- Added a microphone test button in general settings.

### Improvements

- Major onboarding redesign.
- Cleaned up some smaller UI interactions.
- Connecting a new microphone will show up instantly.
- Update FAQ design & info.
- Update What's new design.

---

0.8.1

### New Features

- Launch at Login toggle and OS autostart support!
- Light theme option!
- Search and sorting for transcriptions.

### Improvements

- Large UI overhaul: Light mode, new styles - lots to see!
- Settings: change light / dark mode, enable auto launch.

### Bug Fixes

- Improved microphone permissions handling on newer macOS versions.

---

0.8.0

### Features

- App localization support (English for now)
- Streaming speech transcription with Nvidia Nemotron
- Enhanced keybind customization including function keys
- Input monitoring settings in App preferences

### Changes

- Dictionary & Replacements have been merged into one view.
- Library views have had a small redesign - `_` and `.` in file names are now stripped for cleaner titles.
- Models tab now has a new system models category.
- Media is now unpaused after recording rather than after recording + processing.
- Edit mode is now significantly more consistent.
- UI across the app has been optimized to feel smoother.

---

0.7.5

### Changes

- Changed Github icon to a bug in (i)
- Simplified LLM cleanup, this should make it more consistant.
- Removed pre-release from updater settings (in prep for Windows)
- Many performance optimizations, less ram usage.

---

0.7.4

### Features

- Added remove recordings to automation, you can select how long to wait to remove them.

### Changes

- Small UI tweaks.
- The retry recording button will no longer show, if the recording audio has been removed.
- Improved JSON removal from LLM cleanup (looking at you Mistral)

### Fixes

- Sometimes auto music pausing would not work.
- Text was cut off in some drop down menus.

---

0.7.3

### Features

- Added Auto-pause media in Settings > App to pause playback during transcription.
- Added auto-update in Settings > App - when idle for 10+ minutes Glimpse will auto-update.

### Changes

- Advanced tab has been renamed to App and now includes automations.
- Subtly redesigned some settings menus.
- Toasts now appear for auto-updates only, not manual updates.
- Shrunk the caret size in personalization.
- Added blank spaces in preset personalization.

---

0.7.2

### Changes

- Fully updated analytics, changed from Aptabase to PostHog.
- Advanced settings and onboarding have UI changes to explain and disable anonymous analytics.

---

0.7.1

Spring Cleaning update 🌱
This update was focused on cleaning up internal files and overhauling the organizing of the app, this is mainly in preparation for windows, which is coming soon!

### Changes

- Bumped Glimpse-Speech to 1.0.3 making Whisper even faster.

### Fixes

- A bug where the Language Model dropdown wouldn't open.
- fix `Glimpse quit unexpectedly.` by properly unloading models when force closing the app.
- Fix invisible pill blocking scrolling on other apps.

---

0.7.0

**Note:** Glimpse is moving directories from dev.glimpse.glimpse to com.glimpse.data, this will require anyone updating the app to re-enable permissions for Glimpse, an extra system permission is also prompted to request copying files from the old location to the new one.

### Features

- Apps & websites in personalization now show their icons.
- AI Cleanup and LLM model providers are now separate, allowing you to use features like personalization without using Cleanup.

### Changes

- Removed Moonshine support, as it didn't serve a purpose.
- Glimpse now requires MacOS 14+
- Parakeet V3 now only supports Auto mode.
- Glimpse now uses Glimpse-Speech as the local transcription backend. Whisper transcription is now ~25% faster.
- Turning on AI cleanup now requries a LLM configured first.
- Small UI tweaks across the app.
- Added a copy button to error toasts

### Fixes

- Text would create newlines at end of chunk.
- Capital letters from merged library recordings.
- Dictionary would not apply past 30 seconds on transcription & library.
- Fixed a bug where library item's could be stuck cancelling.

---

0.6.7

### Features

- Added the ability to try pre-release builds. (If you like to test things and sending feedback, this would be a big help!)

### Changes

- Reverted back to the previous hotkey system. This should fix using hotkeys with macros.

### Fixes

- Setting hotkeys should be much less finicky now, recording shouldn't trigger when trying to set hotkeys.
- Many other hyper-niche bug fixes

---

0.6.6

### Fixes

- Fixed Whisper hallucinations where "Thank you." would be added in silent pieces of audio.
- Fixed "An error occurred" errors from happening when spamming the transcribe button too much.

### Changes

- Added a debounce when starting and stopping recordings, this should prevent accidental double taps.

---

0.6.5

### Features

- Added the ability to change text size. (Advanced settings)

- Changed the backend hotkey manager to allow for more hotkey combinations instead of modifier key plus key; support for fn/globe key is still in the works.

### Changes

- Gently reorganized some text and sizing elements.

---

0.6.4

### Features

- Updated the Transcription Language dropdown to show available languages based on the installed model, and what models support which languages if multiple are installed.

**Personalization**

- Personalization modes now support up to 3,000 custom instruction characters with a live counter.

- You can now resize the custom instructions box.

- Holding Shift on a card now lets you quickly delete it.

### Changes

- Redesigned the model download screen and removed AI cleanup from onboarding.

- Updated design of AI Cleanup to fit the app better.

- Updated how some background tasks are run to reduce CPU usage.

### Fixes

- Cleaned up how expanding the sidebar looks in library view to feel smoother.

- Fixed custom instructions getting cut off early after closing/reopening.

- New modes now start with an empty name field when you click to rename.

- Smoothed and cleaned up the Applications/Websites list scrolling so cards keep clear space from the scrollbar.

- Improved search in AI Cleanup window

---

0.6.3

### Fixes

- Fixed "Failed to read chunk" which could happen when downloading models

---

0.6.2

### Features

- Added the ability when tagging a library item to see a list of already existing tags.

- Added the ability in the menu bar to see & copy last transcriptions.

### Changes

- Changed the ordering of the tray menu to match the Glimpse menu

### Fixes

- Fixed a visual bug where opening settings would feel laggy.

---

0.6.1

### Changes

- LLM preflight now runs in the background. If recording with LLM cleanup used to feel delayed, that lag is gone.
- Cleaned up analytics so session length is tracked more accurately. We now record which keybind was used (hold, toggle, smart) and separate active vs background time.
- New background art for the DMG install screen (temporary, still iterating).

### Fixes

- Fixed a visual bug where buttons would shift when opening the overlay.
- Library view hitboxes feel better, tag add jitter is gone, and the `+` button is a touch larger.

---

0.6.0

### Library mode

Added a new Library tab where you can drag files anywhere in the app to transcribe.

- Files can be imported into the app or transcribed from where they are.
- Tag, rename, delete, search, and filter your library items.
- Export transcripts as TXT, MD, SRT, or VTT.
- Retranscribe items with a different local model.
- Using Whisper & Parakeet models you can timestamp speech and play it back with auto highlighting.

---

0.5.5

### Changes

- Made the tray icon slightly smaller to match other apps better.
- Add slight visual fixes across the app for better uniformity.

### Fixes

- Pasting API keys & Endpoints wouldn't work.

---

0.5.4

### Changes

- Improved local transcription reliability for longer recordings by chunking and VAD gating.
- Centralized scrollbar styling for more consistent UI polish.

### Fixes

- Added the ability to cancel in-progress transcription retries.
- Updates whisper prompt, this should make the dictionary perform better
- Removed username from the personality prompt

---

0.5.3

### Features

- When the app is open, you can now use spotlight / raycast to open the main window again without having to reopen it from the tray.

- Added proper mac menu bar options (the top left) allowing you to more easily change model, and adjust other settings.

- Added proper GitHub issue templates, making it easier to report bugs or request features.

### Changes

- Several internal cleanups to keep the code cleaner & slimmer.

---

0.5.2

### Features

- Added model preloading when the hotkey is pressed.

### Changes

- Enhanced accessibility and improved UI consistency across components.

- Clarified edit mode "(i) message" in General Settings.

- Cleaned up padding around the transcription list.

### Fixes

- Added guarding for unadded Appwrite credentials. (Mainly for local dev)

---

0.5.1

### Changes

- Removed animations between pages.

- Redesigned models tab to group by model type, and other QoL changes

### Fixes

- Fixed a bug where the info button would reopen after it was clicked while already open.

---

0.5.0

## New Features & improvements

**Edit Mode:**
You can now use voice commands to edit highlighted text ("Make this more professional"). This can be enabled in settings under 'edit mode' and requires LLM cleanup if on local mode

**Auto unloading:**
Added an idle unloading feature for local models to save your system memory when not in use (5 min).

**Redesigned Toasts:**
Toasts are now fully redesigned to use space better, check for auto updates, and be overall cleaner.

### UI/UX Changes:

- Redesigned Settings and Account views for a cleaner look.
- Updated "What's New" to show history of past releases.
- Onboarding now displays model sizes and includes account confirmation steps.
- Transcription list now has MarkDown support.

### Fixes

- Fixed a bug where toast notifications could cause the app to soft-lock.
- Fixed issues causing duplicate transcriptions and weird whitespace pasting.
- Improved handling for "Smart Press" vs. "Hold" shortcuts so they don't conflict.
- Fixed the startup "blip" and made window expansion smoother.
- Removed all user content (transcripts/responses) from application logs.

### Technical changes

- Switched from MP3 encoding to WAV.
- Switched to Accessibility API for grabbing selected text (with clipboard fallback).
- Pinned `tauri-plugin-aptabase` and `tauri-nspanel` versions.
