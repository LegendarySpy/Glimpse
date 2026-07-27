const FEED_URL = "https://tryglimpse.cc/blog.json";
const CACHE_KEY = "glimpse_news_cache";
const LAST_SEEN_KEY = "glimpse_news_last_seen";

export interface NewsItem {
  id: string;
  title: string;
  tag: string;
  description: string;
  date: string;
  publishedAt: string;
  url: string;
  image?: string;
}

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

function parseItem(raw: unknown): NewsItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) return null;
  if (typeof item.title !== "string" || !item.title) return null;
  if (!isHttpsUrl(item.url)) return null;

  return {
    id: item.id,
    title: item.title,
    tag: str(item.tag),
    description: str(item.description),
    date: str(item.date),
    publishedAt: str(item.publishedAt),
    url: item.url,
    image: isHttpsUrl(item.image) ? item.image : undefined,
  };
}

function parseFeed(raw: unknown): NewsItem[] {
  if (typeof raw !== "object" || raw === null) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items
    .map(parseItem)
    .filter((item): item is NewsItem => item !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function readCache(): NewsItem[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? parseFeed(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeCache(items: NewsItem[]) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ items }));
}

export async function fetchNews(): Promise<NewsItem[]> {
  try {
    const response = await fetch(FEED_URL, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return readCache();
    const items = parseFeed(await response.json());
    writeCache(items);
    return items;
  } catch {
    return readCache();
  }
}

export function getLastSeenId(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

export function setLastSeenId(id: string) {
  try {
    localStorage.setItem(LAST_SEEN_KEY, id);
  } catch {
    // storage unavailable; unread state just won't persist
  }
}
