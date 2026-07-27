/**
 * Thin wrapper around the YouTube Playables SDK (window.ytgame).
 *
 * The SDK script is loaded via a <script src="https://www.youtube.com/game_api/v1">
 * tag in src/routes/__root.tsx BEFORE any game code runs. When served outside
 * the YouTube Playables environment (local dev, direct web), the SDK runs as
 * a no-op — every helper here degrades gracefully.
 *
 * Docs: https://developers.google.com/youtube/gaming/playables/reference/sdk
 */

export type YtSdkErrorType =
  | "API_UNAVAILABLE"
  | "INVALID_PARAMS"
  | "SIZE_LIMIT_EXCEEDED"
  | "UNKNOWN";

export interface YtSdkError extends Error {
  errorType: YtSdkErrorType;
}

export interface YtContent {
  id: string;
  contentType?: "PLAYABLE" | "VIDEO";
}

export interface YtGame {
  readonly IN_PLAYABLES_ENV: boolean;
  readonly SDK_VERSION: string;
  game: {
    firstFrameReady: () => void;
    gameReady: () => void;
    loadData: () => Promise<string>;
    saveData: (data: string) => Promise<void>;
  };
  system: {
    getLanguage: () => Promise<string>;
    isAudioEnabled: () => boolean;
    onAudioEnabledChange: (cb: (enabled: boolean) => void) => () => void;
    onPause: (cb: () => void) => () => void;
    onResume: (cb: () => void) => () => void;
  };
  engagement: {
    sendScore: (score: { value: number }) => Promise<void>;
    openYTContent: (content: YtContent) => Promise<void>;
    ContentType: { PLAYABLE: "PLAYABLE"; VIDEO: "VIDEO" };
  };
  health: {
    logError: () => void;
    logWarning: () => void;
  };
  ads: {
    requestInterstitialAd: () => Promise<void>;
    requestRewardedAd: (rewardId: string) => Promise<boolean>;
  };
}

declare global {
  interface Window {
    ytgame?: YtGame;
  }
}

function yt(): YtGame | undefined {
  if (typeof window === "undefined") return undefined;
  return window.ytgame;
}

/** True when running inside the actual YouTube Playables environment. */
export function inPlayablesEnv(): boolean {
  const g = yt();
  return !!g && g.IN_PLAYABLES_ENV === true;
}

/** Notifies YouTube the first frame is on screen. Required. */
export function firstFrameReady() {
  try {
    yt()?.game.firstFrameReady();
  } catch {
    /* no-op outside Playables */
  }
}

/** Notifies YouTube the game is interactable. Required, after firstFrameReady. */
export function gameReady() {
  try {
    yt()?.game.gameReady();
  } catch {
    /* no-op */
  }
}

/** Loads cloud save data. Resolves to "" outside Playables. */
export async function loadCloudData(): Promise<string> {
  const g = yt();
  if (!g) return "";
  try {
    return (await g.game.loadData()) ?? "";
  } catch {
    return "";
  }
}

/** Saves cloud data (max 3 MiB). No-op outside Playables. */
export async function saveCloudData(data: string): Promise<void> {
  const g = yt();
  if (!g) return;
  try {
    await g.game.saveData(data);
  } catch {
    /* rate-limited or unavailable */
  }
}

/**
 * Strict variant of saveCloudData that surfaces success/failure so callers
 * can implement a retry queue. Outside Playables it resolves { ok: true }
 * (nothing to persist remotely; localStorage already holds the data).
 */
export async function saveCloudDataStrict(
  data: string,
): Promise<{ ok: boolean; error?: string; noop?: boolean }> {
  const g = yt();
  if (!g) return { ok: true, noop: true };
  try {
    await g.game.saveData(data);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Reports a best/current score to YouTube. */
export async function sendScore(value: number): Promise<void> {
  const g = yt();
  if (!g) return;
  const safe = Math.max(0, Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER));
  try {
    await g.engagement.sendScore({ value: safe });
  } catch {
    /* ignore */
  }
}

/** Opens a YouTube video or another Playable. */
export async function openYTContent(id: string, type: "VIDEO" | "PLAYABLE" = "VIDEO") {
  const g = yt();
  if (!g) return false;
  try {
    await g.engagement.openYTContent({ id, contentType: type });
    return true;
  } catch {
    return false;
  }
}

/** Returns whether YouTube wants audio enabled. Defaults to true outside Playables. */
export function isAudioEnabled(): boolean {
  const g = yt();
  if (!g) return true;
  try {
    return g.system.isAudioEnabled();
  } catch {
    return true;
  }
}

export function onAudioEnabledChange(cb: (enabled: boolean) => void): () => void {
  const g = yt();
  if (!g) return () => {};
  try {
    return g.system.onAudioEnabledChange(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}

export function onPause(cb: () => void): () => void {
  const g = yt();
  if (!g) return () => {};
  try {
    return g.system.onPause(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}

export function onResume(cb: () => void): () => void {
  const g = yt();
  if (!g) return () => {};
  try {
    return g.system.onResume(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}

/** Returns a BCP-47 tag from YouTube settings, or the browser default. */
export async function getLanguage(): Promise<string> {
  const g = yt();
  if (!g) {
    return typeof navigator !== "undefined" ? navigator.language : "en-US";
  }
  try {
    return await g.system.getLanguage();
  } catch {
    return "en-US";
  }
}

export function logError() {
  try {
    yt()?.health.logError();
  } catch {
    /* ignore */
  }
}

export function logWarning() {
  try {
    yt()?.health.logWarning();
  } catch {
    /* ignore */
  }
}

/** Request an interstitial ad at a natural break. Returns true if the request succeeded. */
export async function requestInterstitialAd(): Promise<boolean> {
  const g = yt();
  if (!g) return false;
  try {
    await g.ads.requestInterstitialAd();
    return true;
  } catch {
    return false;
  }
}

/** Request a rewarded ad. Resolves to true if the user earned the reward. */
export async function requestRewardedAd(rewardId: string): Promise<boolean> {
  const g = yt();
  if (!g) return false;
  try {
    return await g.ads.requestRewardedAd(rewardId);
  } catch {
    return false;
  }
}
