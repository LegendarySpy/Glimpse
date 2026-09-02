#!/usr/bin/env bun
// Regenerates the README screenshots from demo data.
//
// The app is launched with HOME pointed at a throwaway directory, so it reads a
// copy of your settings (license, models, shortcuts) but sees only the demo
// transcriptions, dictionary, personalities and library items below. Your real
// data is never modified. API keys are stripped from the copy; the models
// folder is shared with the real install, so leave the model manager alone
// during a `--keep` session.
//
//   bun run screenshots              # dark theme, writes assets/readme/*.png
//   bun run screenshots -- --theme light --out /tmp/shots
//   bun run screenshots -- --skip-build --keep
//
// macOS only. Needs the terminal to have Accessibility access (window sizing)
// and Screen Recording access (screencapture).

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IDENTIFIER = (
  await Bun.file(join(ROOT, "src-tauri/tauri.conf.json")).json()
).identifier;
const BINARY = join(ROOT, "src-tauri/target/debug/Glimpse");
const VITE_PORT = 8735;
const WINDOW = { x: 200, y: 120, width: 900, height: 750 };

// ---------------------------------------------------------------------------
// Demo content. Edit freely; nothing here is read from your real data.
// ---------------------------------------------------------------------------

const TRANSCRIPTIONS = [
  "Hey, people reading this picture.",
  "This is Glimpse.",
  "It's fast, open source, runs on Apple Silicon Neural Accelerators, and it's pretty awesome.",
  "How much wood could a woodchuck chuck if a woodchuck could chuck wood?",
  "Which came first, the chicken or the egg?",
  "What other placeholder text can I say to fill this screen and give people reading this a great example?",
  "Remind me to water the plants before the weekend and pick up coffee beans on the way home.",
];

const DICTIONARY = ["Groq", "Tauri", "Electrobun"];

const REPLACEMENTS = [{ from: "my email", to: "example@test.com" }];

const PERSONALITIES = [
  {
    id: "demo-messaging",
    name: "Messaging",
    enabled: true,
    apps: ["Messages", "Slack", "Calendar"],
    websites: ["slack.com", "reddit.com", "tryglimpse.cc"],
    instructions: [
      "Write semi-casual, friendly, as if you're messaging a colleague.",
      "Keep it to a couple of sentences.",
    ],
  },
  {
    id: "demo-email",
    name: "Email",
    enabled: true,
    apps: ["Mail", "Outlook", "Spark"],
    websites: ["mail.google.com", "outlook.com", "mail.yahoo.com"],
    instructions: [
      "Write in correct email semi-formal, friendly, form.",
      "Open with a greeting and close with a sign-off.",
    ],
  },
  {
    id: "demo-notes",
    name: "Notes",
    enabled: true,
    apps: ["Notes", "Notion", "Obsidian", "Bear", "Craft"],
    websites: ["notion.so", "craft.do", "affine.pro", "bear.app"],
    instructions: [
      "Distill into a concise, scannable format based on what was said.",
      "Use short bullet points.",
    ],
  },
  {
    id: "demo-coding",
    name: "Coding",
    enabled: true,
    apps: ["Cursor", "Visual Studio Code", "Xcode", "Zed", "Terminal"],
    websites: ["github.com", "gitlab.com", "bitbucket.org"],
    instructions: [
      "Treat technical keywords, library names, and log output literally.",
      "Prefer code-style formatting for identifiers.",
    ],
  },
];

const LIBRARY_ITEMS = [
  {
    name: "Script reading",
    status: "complete",
    progress: 1,
    duration: 56,
    size: 1_900_000_000,
    format: "mov",
    transcript:
      "Scene one. Interior, kitchen, morning. She pours the coffee and looks out of the window.",
  },
  {
    name: "Podcast",
    status: "complete",
    progress: 1,
    duration: 265,
    size: 8_300_000,
    format: "mp3",
    transcript:
      "Welcome back to the show. Today we are talking about how people actually use dictation at work.",
  },
];

const SCREENS = [
  { target: "home", file: "home.png" },
  { target: "dictionary", file: "dictionary.png" },
  { target: "personalization", file: "personalization.png" },
  { target: "library", file: "library.png" },
];

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const has = (name) => args.includes(name);

const OUT_DIR = resolve(flag("--out", join(ROOT, "assets/readme")));
const THEME = flag("--theme", "dark");
const SKIP_BUILD = has("--skip-build");
const KEEP = has("--keep");

if (process.platform !== "darwin") {
  console.error("The screenshot script only runs on macOS.");
  process.exit(1);
}

const log = (message) => console.log(`• ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const run = async (cmd, options = {}) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...options });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

const osascript = async (script) => {
  const result = await run(["osascript", "-e", script]);
  if (result.code !== 0) throw new Error(`osascript failed: ${result.stderr}`);
  return result.stdout;
};

// --- sandbox ---------------------------------------------------------------

const realHome = homedir();
const realData = join(realHome, "Library/Application Support", IDENTIFIER);
const sandboxHome = join(tmpdir(), "glimpse-screenshots", "home");
const sandboxData = join(
  sandboxHome,
  "Library/Application Support",
  IDENTIFIER,
);
const cli = join(tmpdir(), "glimpse-screenshots", "glimpse-cli");

const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();

const sqliteBackup = (from, to) => {
  const db = new Database(from, { readonly: true });
  db.run("VACUUM INTO ?", [to]);
  db.close();
};

// A valid 16 kHz mono WAV of silence, so library rows point at a real file.
const silentWav = (seconds) => {
  const samples = 16_000 * seconds;
  const data = samples * 2;
  const buffer = Buffer.alloc(44 + data);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(data, 40);
  return buffer;
};

const seedSettings = (path) => {
  const db = new Database(path);
  const set = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const json = (value) => JSON.stringify(value);
  set.run("dictionary", json(DICTIONARY));
  set.run("replacements", json(REPLACEMENTS));
  set.run("personalities", json(PERSONALITIES));
  set.run("personalities_notes_seeded", "true");
  set.run("theme_mode", json(THEME));
  set.run("analytics_enabled", "false");
  // Keys never leave the real install; local models cover the screenshots.
  for (const key of ["llm_api_key", "remote_speech_api_key", "local_api_key"])
    set.run(key, json(""));
  set.run("remote_speech_enabled", "false");
  set.run("llm_enabled", "false");
  set.run("auto_update_enabled", "false");
  set.run("auto_launch_enabled", "false");
  set.run("start_in_background", "false");
  set.run("local_api_start_on_launch", "false");
  // Home asks (survey, review, star) stay hidden.
  const dismissed = json({
    prompt_version: 1,
    outcome: "dismissed",
    resolved_at: nowIso,
    history: {},
  });
  for (const key of ["survey_state", "review_state", "star_state"])
    set.run(key, dismissed);
  db.close();
};

const seedTranscriptions = (path) => {
  const db = new Database(path);
  db.run("DELETE FROM transcriptions");
  db.run("DELETE FROM library_items");
  db.run(
    "INSERT INTO lifetime_stats (id, words, duration_ms, dictations) VALUES (1, 48210, 21600000, 812) ON CONFLICT(id) DO UPDATE SET words = excluded.words, duration_ms = excluded.duration_ms, dictations = excluded.dictations",
  );

  const insertTranscription = db.prepare(
    `INSERT INTO transcriptions (id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned, speech_model, llm_model, word_count, audio_duration_seconds, synced)
     VALUES (?1, ?2, ?3, NULL, '', 'success', NULL, 0, 'parakeet_unified_en_int8', NULL, ?4, ?5, 0)`,
  );
  TRANSCRIPTIONS.forEach((text, index) => {
    const words = text.split(/\s+/).length;
    // Newest first, spaced a few minutes apart, all earlier today.
    const timestamp = nowMs - (index + 1) * 4 * 60_000 - 90_000;
    insertTranscription.run(
      `demo-${index + 1}`,
      timestamp,
      text,
      words,
      Math.round((words / 152) * 60 * 10) / 10,
    );
  });

  const insertItem = db.prepare(
    `INSERT INTO library_items (id, name, audio_path, source_path, store_original, status, progress, error_message, transcript, segments, duration_seconds, file_size_bytes, original_format, created_at, transcribed_at, tags, llm_cleanup_enabled, speech_model, show_timestamps, kind)
     VALUES (?1, ?2, ?3, '', 0, ?4, ?5, NULL, ?6, NULL, ?7, ?8, ?9, ?10, ?11, '[]', 0, 'parakeet_unified_en_int8', 0, 'import')`,
  );
  LIBRARY_ITEMS.forEach((item, index) => {
    const id = `demo-library-${index + 1}`;
    const dir = join(
      sandboxData,
      "library",
      `${item.name.toLowerCase().replace(/\s+/g, "-")}-${id}`,
    );
    mkdirSync(dir, { recursive: true });
    const audioPath = join(dir, `${id}.wav`);
    writeFileSync(audioPath, silentWav(2));
    const createdAt = new Date(nowMs - (index + 1) * 40 * 60_000).toISOString();
    const transcribedAt =
      item.status === "complete"
        ? new Date(nowMs - index * 30 * 60_000).toISOString()
        : null;
    insertItem.run(
      id,
      item.name,
      audioPath,
      item.status,
      item.progress,
      item.transcript,
      item.duration,
      item.size,
      item.format,
      createdAt,
      transcribedAt,
    );
  });
  db.close();
};

const prepareSandbox = async () => {
  rmSync(dirname(sandboxHome), { recursive: true, force: true });
  mkdirSync(join(sandboxData, "Glimpse"), { recursive: true });

  sqliteBackup(
    join(realData, "Glimpse/settings.db"),
    join(sandboxData, "Glimpse/settings.db"),
  );
  sqliteBackup(
    join(realData, "transcriptions.db"),
    join(sandboxData, "transcriptions.db"),
  );
  seedSettings(join(sandboxData, "Glimpse/settings.db"));
  seedTranscriptions(join(sandboxData, "transcriptions.db"));

  // Installed models stay where they are; the app only needs to see them.
  if (existsSync(join(realData, "models")))
    symlinkSync(join(realData, "models"), join(sandboxData, "models"));

  // Cached app and site icons, so personalization cards show them right away.
  const iconCache = join(realData, "local/cache");
  if (existsSync(iconCache))
    cpSync(iconCache, join(sandboxData, "local/cache"), { recursive: true });

  // Webview storage carries the "seen" state for news and What's New.
  const webkit = join(realHome, "Library/WebKit", IDENTIFIER);
  if (existsSync(webkit))
    cpSync(webkit, join(sandboxHome, "Library/WebKit", IDENTIFIER), {
      recursive: true,
    });

  symlinkSync(BINARY, cli);
};

// --- processes -------------------------------------------------------------

const installedAppRunning = async () =>
  (
    await run([
      "pgrep",
      "-f",
      "/Applications/Glimpse.app/Contents/MacOS/Glimpse",
    ])
  ).code === 0;

const waitFor = async (probe, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const viteUp = async () => {
  try {
    await fetch(`http://localhost:${VITE_PORT}/`);
    return true;
  } catch {
    return false;
  }
};

const appUp = async () => {
  const result = await run([cli, "status", "--json"]);
  return result.code === 0 && result.stdout.includes('"app_running":true');
};

const placeWindow = async () => {
  await osascript(
    `tell application "System Events" to tell process "Glimpse"
       set frontmost to true
       set position of window 1 to {${WINDOW.x}, ${WINDOW.y}}
       set size of window 1 to {${WINDOW.width}, ${WINDOW.height}}
     end tell`,
  );
};

const windowId = async () => {
  // The window can take a moment to be listed as on screen.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await run([
      "swift",
      join(ROOT, "scripts/screenshots/window-id.swift"),
      "Glimpse",
    ]);
    if (result.code === 0 && result.stdout) return result.stdout;
    await sleep(500);
  }
  throw new Error("Could not find the Glimpse window");
};

const capture = async (target, file, id) => {
  const open = await run([cli, "open", target]);
  if (open.code !== 0) throw new Error(`open ${target} failed: ${open.stderr}`);
  await placeWindow();
  // Let the view swap settle and the overlay scrollbar fade out.
  await sleep(1800);
  // Something may have taken focus meanwhile; an inactive window captures
  // with grey traffic lights and a thinner shadow.
  await osascript(
    'tell application "System Events" to tell process "Glimpse" to set frontmost to true',
  );
  await sleep(300);
  const out = join(OUT_DIR, file);
  const shot = await run(["screencapture", "-x", "-l", id, out]);
  if (shot.code !== 0) throw new Error(`screencapture failed: ${shot.stderr}`);
  log(`captured ${file}`);
};

// --- main ------------------------------------------------------------------

let vite = null;
let app = null;
let relaunchInstalled = false;

const cleanup = async () => {
  app?.kill();
  vite?.kill();
  if (app) await app.exited.catch(() => {});
  if (vite) await vite.exited.catch(() => {});
  if (!KEEP) rmSync(dirname(sandboxHome), { recursive: true, force: true });
  if (relaunchInstalled) await run(["open", "-a", "Glimpse"]);
};

try {
  if (await installedAppRunning()) {
    log(
      "quitting the installed Glimpse app (it will be relaunched afterwards)",
    );
    await osascript('tell application "Glimpse" to quit');
    await waitFor(
      async () => !(await installedAppRunning()),
      15_000,
      "Glimpse to quit",
    );
    relaunchInstalled = true;
  }

  if (!SKIP_BUILD) {
    log("building the debug binary");
    const build = await run(
      [
        "cargo",
        "build",
        "--manifest-path",
        join(ROOT, "src-tauri/Cargo.toml"),
        "--no-default-features",
      ],
      {
        stderr: "inherit",
      },
    );
    if (build.code !== 0) throw new Error("cargo build failed");
  }
  if (!existsSync(BINARY))
    throw new Error(`Missing ${BINARY}; run without --skip-build first`);

  log("preparing demo data");
  await prepareSandbox();
  mkdirSync(OUT_DIR, { recursive: true });

  log("starting the frontend dev server");
  vite = Bun.spawn(["bun", "run", "dev"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(viteUp, 60_000, "vite");

  log("launching Glimpse with the demo home");
  app = Bun.spawn([BINARY], {
    env: { ...process.env, HOME: sandboxHome },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(appUp, 90_000, "Glimpse to start");
  await sleep(1500);

  // The window only exists once something asks for it.
  await run([cli, "open", "home"]);
  await sleep(1000);
  await placeWindow();
  const id = await windowId();
  for (const screen of SCREENS) await capture(screen.target, screen.file, id);
  log(`done: ${OUT_DIR}`);
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
