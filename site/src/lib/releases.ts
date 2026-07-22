const REPO = "barry-napier/tracker";

export const GITHUB_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${GITHUB_URL}/releases`;

const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "tracker-latest-release";
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const { at, release } = JSON.parse(cached);
      if (typeof at === "number" && Date.now() - at < CACHE_TTL_MS) return release;
    } catch {
      // Old cache shape or garbage — refetch.
    }
  }

  const data = await fetch(API_URL).then((r) => r.json());

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release: data }));
  }

  return data;
}
