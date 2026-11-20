import { cleanTitle, lineIndexAt, sourceForPlayer, type LyricLine } from "./LrcParser";

export interface MusicMetadata {
  title: string;
  artist: string;
  appId: string;
  positionMs: number;
  durationMs: number;
}
export interface MusicEvidence {
  title: string;
  artist: string;
  lyric?: string;
  lyricContext?: string;
  lyricStatus?: "notfound" | "instrumental" | "error";
}

export async function loadMusicEvidence(
  media: MusicMetadata,
  syncedLyric: string | undefined,
  getLyrics: (title: string, artist: string, durationMs: number, force: boolean, source: string | null) => Promise<{
    lines: LyricLine[] | null; reason?: MusicEvidence["lyricStatus"];
  }>,
): Promise<MusicEvidence> {
  const { title, artist } = media;
  const evidence: MusicEvidence = { title, artist, ...(syncedLyric ? { lyric: syncedLyric } : {}) };
  try {
    const result = await getLyrics(cleanTitle(title) || title, artist, media.durationMs, false, sourceForPlayer(media.appId));
    if (!result.lines?.length) return { ...evidence, lyricStatus: result.reason ?? "notfound" };
    const indexed = media.positionMs > 0 ? lineIndexAt(result.lines, media.positionMs) : -1;
    const line = indexed >= 0 ? result.lines[indexed].text.trim().slice(0, 90) : "";
    if (!evidence.lyric && line) evidence.lyric = line;
    // 短段只用于理解歌词；没有可靠进度时不说它就是正在唱的那句。
    const start = Math.max(0, indexed - 1);
    const sample = result.lines.slice(start, start + 3).map(row => row.text.trim()).filter(Boolean).join("\n").slice(0, 220);
    if (sample) evidence.lyricContext = sample;
    return evidence;
  } catch {
    return { ...evidence, lyricStatus: "error" };
  }
}
