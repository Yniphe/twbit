const PLAYBACK_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const ACCESS_QUERY_HASH = "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";

export interface AudioPlaylist {
  url: string;
  audioOnly: boolean;
}

interface PlaybackResponse {
  data?: { streamPlaybackAccessToken?: { value: string; signature: string } | null };
  errors?: unknown[];
}

/** Anonymous playback uses Twitch's web-player endpoints, separately from Helix/chat OAuth. */
export class TwitchPlayback {
  async resolve(channel: string, signal: AbortSignal): Promise<AudioPlaylist> {
    const response = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Client-ID": PLAYBACK_CLIENT_ID, "Content-Type": "application/json" },
      body: JSON.stringify({
        operationName: "PlaybackAccessToken",
        extensions: { persistedQuery: { version: 1, sha256Hash: ACCESS_QUERY_HASH } },
        variables: { isLive: true, login: channel, isVod: false, vodID: "", playerType: "embed", platform: "site" },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error(`Twitch playback: HTTP ${response.status}`);
    const data = await response.json() as PlaybackResponse;
    const token = data.data?.streamPlaybackAccessToken;
    if (data.errors?.length || !token?.value || !token.signature) {
      throw new Error("Twitch не выдал доступ к публичному медиапотоку");
    }
    const url = new URL(`https://usher.ttvnw.net/api/v2/channel/hls/${channel}.m3u8`);
    url.search = new URLSearchParams({
      sig: token.signature, token: token.value, platform: "web",
      allow_source: "true", allow_audio_only: "true", supported_codecs: "h264",
    }).toString();
    const playlist = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (!playlist.ok) throw new Error(`Медиапоток Twitch недоступен: HTTP ${playlist.status}`);
    return selectAudioPlaylist(await playlist.text(), url.href);
  }
}

export function selectAudioPlaylist(manifest: string, baseUrl: string): AudioPlaylist {
  const variants: (AudioPlaylist & { bandwidth: number })[] = [];
  let attributes: Record<string, string> | undefined;
  for (const line of manifest.split(/\r?\n/).map((line) => line.trim())) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      attributes = Object.fromEntries(Array.from(line.slice(18).matchAll(/([\w-]+)=("[^"]*"|[^,]*)/g),
        ([, key, value]) => [key!, value!.replace(/^"|"$/g, "")]));
    } else if (line && !line.startsWith("#") && attributes) {
      const url = new URL(line, baseUrl);
      if (url.protocol !== "https:") throw new Error("Неподдерживаемый протокол медиапотока Twitch");
      const codecs = attributes.CODECS ?? "";
      variants.push({
        url: url.href,
        audioOnly: /audio/i.test(attributes.VIDEO ?? "")
          || (/mp4a|opus/i.test(codecs) && !/avc|hvc|hev|av01|vp0/i.test(codecs)),
        bandwidth: Number(attributes.BANDWIDTH) || Number.MAX_SAFE_INTEGER,
      });
      attributes = undefined;
    }
  }
  const chosen = variants.find((variant) => variant.audioOnly)
    ?? variants.sort((a, b) => a.bandwidth - b.bandwidth)[0];
  if (!chosen) throw new Error("В плейлисте Twitch нет доступных вариантов воспроизведения");
  return { url: chosen.url, audioOnly: chosen.audioOnly };
}
