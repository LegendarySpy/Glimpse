import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const DEFAULT_PROJECT_ID = "6252908169c7abdf708bc0.88157474";
const SOURCE_LOCALE = "en";
const API_BASE = "https://api.lokalise.com/api2";
const SYNC_STATE_FILE = ".lokalise-sync.json";

function usage() {
  return [
    "Usage: bun run locale:pull-task [latest|task-id]",
    "",
    "Omit the argument or use latest to pull every task completed since the last sync.",
    "Set LOKALISE_API_TOKEN in .env or the shell before running.",
    "LOKALISE_PROJECT_ID may override the Glimpse project ID.",
  ].join("\n");
}

function parseTaskId(value) {
  if (!value) {
    throw new Error(usage());
  }

  const match = value.match(/^\d+$/) ?? value.match(/task_(\d+)/);
  if (!match) {
    throw new Error(
      `Could not find a Lokalise task ID in: ${value}\n\n${usage()}`,
    );
  }

  return match[1] ?? match[0];
}

function apiErrorMessage(status, payload) {
  const detail = payload?.error?.message ?? payload?.message;
  return detail
    ? `Lokalise API ${status}: ${detail}`
    : `Lokalise API ${status}`;
}

async function fetchLokalise(path, token, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }

  const response = await globalThis.fetch(url, {
    headers: {
      "X-Api-Token": token,
    },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(apiErrorMessage(response.status, payload));
  }
  return payload;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function keyName(key) {
  if (typeof key.key_name === "string") {
    return key.key_name;
  }

  const names = Object.values(key.key_name ?? {}).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length !== 1) {
    throw new Error(
      `Key ${key.key_id} does not have one unambiguous app key name`,
    );
  }
  return uniqueNames[0];
}

function translationText(key, locale) {
  const translation = key.translations?.find(
    (candidate) => candidate.language_iso === locale,
  );
  if (!translation || translation.is_untranslated) {
    throw new Error(`${keyName(key)} is untranslated in ${locale}`);
  }
  if (
    typeof translation.translation !== "string" ||
    translation.translation.length === 0
  ) {
    throw new Error(`${keyName(key)} has no usable ${locale} translation`);
  }
  return translation.translation;
}

function poString(value) {
  if (value.includes("\0")) {
    throw new Error("PO translations cannot contain null bytes");
  }
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}"`;
}

function updateCatalog(content, updates, locale) {
  const lines = content.split("\n");
  let changed = 0;

  for (const [id, translation] of updates) {
    const msgid = `msgid ${poString(id)}`;
    const indexes = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === msgid) {
        indexes.push(index);
      }
    }
    if (indexes.length !== 1) {
      throw new Error(
        `${locale}: expected one ${id} catalog entry, found ${indexes.length}`,
      );
    }

    let start = indexes[0] + 1;
    while (start < lines.length && !lines[start].startsWith("msgstr")) {
      if (lines[start] === "" || lines[start].startsWith("msgid ")) {
        throw new Error(`${locale}: ${id} has no msgstr`);
      }
      start += 1;
    }

    let end = start + 1;
    while (end < lines.length && lines[end].startsWith('"')) {
      end += 1;
    }
    const next = `msgstr ${poString(translation)}`;
    if (lines.slice(start, end).join("\n") !== next) {
      lines.splice(start, end - start, next);
      changed += 1;
    }
  }

  return { content: lines.join("\n"), changed };
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

async function pullTask({
  taskId,
  token,
  projectId,
  workspace,
  supportedLocales,
}) {
  const targetLocales = new Set(
    supportedLocales.filter((locale) => locale !== SOURCE_LOCALE),
  );

  const taskPayload = await fetchLokalise(
    `/projects/${encodeURIComponent(projectId)}/tasks/${taskId}`,
    token,
  );
  const task = taskPayload.task;
  if (!task?.languages?.length) {
    throw new Error(`Lokalise task ${taskId} has no language assignments`);
  }

  const unsupported = task.languages
    .map((language) => language.language_iso)
    .filter((locale) => locale !== SOURCE_LOCALE && !targetLocales.has(locale));
  if (unsupported.length > 0) {
    throw new Error(
      `Task ${taskId} contains unsupported app locales: ${unsupported.join(", ")}`,
    );
  }

  const languages = task.languages.filter((language) =>
    targetLocales.has(language.language_iso),
  );
  if (languages.length === 0) {
    throw new Error(`Task ${taskId} contains no shipped Glimpse locales`);
  }
  const incomplete = languages.filter(
    (language) => language.status !== "completed",
  );
  if (incomplete.length > 0) {
    throw new Error(
      `Task ${taskId} is not complete for: ${incomplete
        .map((language) => language.language_iso)
        .join(", ")}`,
    );
  }

  const keyIdsByLocale = new Map();
  for (const language of languages) {
    const ids = new Set((language.keys ?? []).map(String));
    if (ids.size === 0) {
      throw new Error(
        `Task ${taskId} returned no keys for ${language.language_iso}`,
      );
    }
    keyIdsByLocale.set(language.language_iso, ids);
  }
  const keyIds = [
    ...new Set(
      [...keyIdsByLocale.values()].flatMap((localeKeyIds) => [...localeKeyIds]),
    ),
  ];

  const keys = [];
  for (const batch of chunks(keyIds, 100)) {
    const payload = await fetchLokalise(
      `/projects/${encodeURIComponent(projectId)}/keys`,
      token,
      {
        filter_key_ids: batch.join(","),
        include_translations: 1,
        limit: 500,
      },
    );
    keys.push(...(payload.keys ?? []));
  }
  const keysById = new Map(keys.map((key) => [String(key.key_id), key]));
  const missingKeyIds = keyIds.filter((id) => !keysById.has(id));
  if (missingKeyIds.length > 0) {
    throw new Error(
      `Lokalise did not return ${missingKeyIds.length} task keys: ${missingKeyIds.join(", ")}`,
    );
  }

  const catalogWrites = [];
  let changedTotal = 0;
  let taskEntryTotal = 0;
  for (const language of languages) {
    const locale = language.language_iso;
    const updates = new Map();
    for (const id of keyIdsByLocale.get(locale)) {
      const key = keysById.get(id);
      updates.set(keyName(key), translationText(key, locale));
    }

    const catalogPath = resolve(workspace, `src/locales/${locale}/messages.po`);
    const current = readFileSync(catalogPath, "utf8");
    const updated = updateCatalog(current, updates, locale);
    catalogWrites.push({ path: catalogPath, content: updated.content });
    changedTotal += updated.changed;
    taskEntryTotal += updates.size;
    console.log(
      `${locale}: ${updates.size} task translations, ${updated.changed} changed`,
    );
  }

  for (const catalog of catalogWrites) {
    writeFileSync(catalog.path, catalog.content, "utf8");
  }

  run(process.execPath, ["run", "lingui:compile"]);
  run("git", ["diff", "--check", "--", "src/locales"]);
  console.log(
    `Pulled task ${taskId}: ${taskEntryTotal} entries checked, ${changedTotal} translations updated.`,
  );
}

function taskIsAfterCheckpoint(task, checkpoint) {
  const completedAt = task.completed_at_timestamp ?? 0;
  return (
    completedAt > checkpoint.completedAtTimestamp ||
    (completedAt === checkpoint.completedAtTimestamp &&
      task.task_id > checkpoint.taskId)
  );
}

async function main() {
  if (process.argv.length > 3) {
    throw new Error(usage());
  }

  const token = process.env.LOKALISE_API_TOKEN;
  if (!token) {
    throw new Error(`LOKALISE_API_TOKEN is not set\n\n${usage()}`);
  }

  const projectId = process.env.LOKALISE_PROJECT_ID ?? DEFAULT_PROJECT_ID;
  const workspace = process.cwd();
  const supportedLocales = JSON.parse(
    readFileSync(resolve(workspace, "supported-app-locales.json"), "utf8"),
  );
  const context = {
    token,
    projectId,
    workspace,
    supportedLocales,
  };
  const requestedTask = process.argv[2];
  if (requestedTask && requestedTask !== "latest") {
    await pullTask({ ...context, taskId: parseTaskId(requestedTask) });
    return;
  }

  const statePath = resolve(workspace, SYNC_STATE_FILE);
  const checkpoint = JSON.parse(readFileSync(statePath, "utf8"));
  if (
    !Number.isInteger(checkpoint.taskId) ||
    !Number.isInteger(checkpoint.completedAtTimestamp)
  ) {
    throw new Error(`${SYNC_STATE_FILE} contains an invalid checkpoint`);
  }

  const tasksPayload = await fetchLokalise(
    `/projects/${encodeURIComponent(projectId)}/tasks`,
    token,
    {
      filter_statuses: "completed",
      limit: 5000,
    },
  );
  const pendingTasks = (tasksPayload.tasks ?? [])
    .filter((task) => taskIsAfterCheckpoint(task, checkpoint))
    .sort(
      (left, right) =>
        left.completed_at_timestamp - right.completed_at_timestamp ||
        left.task_id - right.task_id,
    );

  if (pendingTasks.length === 0) {
    console.log(`No completed Lokalise tasks after ${checkpoint.taskId}.`);
    return;
  }

  console.log(
    `Pulling ${pendingTasks.length} completed Lokalise ${pendingTasks.length === 1 ? "task" : "tasks"}.`,
  );
  for (const task of pendingTasks) {
    await pullTask({ ...context, taskId: String(task.task_id) });
  }

  const latest = pendingTasks.at(-1);
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        taskId: latest.task_id,
        completedAtTimestamp: latest.completed_at_timestamp,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Lokalise checkpoint advanced to task ${latest.task_id}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
