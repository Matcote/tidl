// tIDl — Shared Player Module
// Wraps @tidal-music/player SDK with scrub bar UI for track preview.

import {
  bootstrap,
  setCredentialsProvider,
  setEventSender,
  load,
  play as sdkPlay,
  pause as sdkPause,
  seek as sdkSeek,
  reset,
  events,
  getAssetPosition,
  getPlaybackState,
} from '@tidal-music/player';
import { initAuth, credentialsProvider } from './auth';

export interface Player {
  play(trackId: string, trackLi: HTMLLIElement): Promise<void>;
  stop(): void;
  getCurrentTrackId(): string | null;
  isPlaying(): boolean;
  destroy(): void;
}

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;

  // Initialize the auth SDK so its credentialsProvider is ready
  await initAuth();

  bootstrap({
    outputDevices: false,
    players: [{ itemTypes: ['track'], player: 'shaka', qualities: ['LOW', 'HIGH', 'LOSSLESS', 'HI_RES_LOSSLESS'] }],
  });

  // Pass the SDK's own credentialsProvider — it handles token refresh,
  // scopes, and clientUniqueKey automatically.
  setCredentialsProvider(credentialsProvider);

  // Stub event sender — SDK requires one but we don't need analytics.
  // Runtime only calls .sendEvent() on the object.
  setEventSender({ sendEvent: () => Promise.resolve() } as never);

  initialized = true;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function createPlayer(
  prefix: string,
): Player {
  let currentTrackId: string | null = null;
  let duration = 0;
  let progressInterval: ReturnType<typeof setInterval> | null = null;
  let scrubBar: HTMLLIElement | null = null;
  let fillEl: HTMLDivElement | null = null;
  let elapsedEl: HTMLSpanElement | null = null;
  let totalEl: HTMLSpanElement | null = null;
  let currentArtEl: HTMLImageElement | null = null;
  let destroyed = false;

  // --- Scrub bar DOM ---

  function createScrubBar(): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `${prefix}-player-bar`;

    const row = document.createElement('div');
    row.className = `${prefix}-player-row`;

    const elapsed = document.createElement('span');
    elapsed.className = `${prefix}-player-time`;
    elapsed.textContent = '0:00';
    elapsedEl = elapsed;

    const track = document.createElement('div');
    track.className = `${prefix}-player-track`;

    const fill = document.createElement('div');
    fill.className = `${prefix}-player-fill`;
    fillEl = fill;

    track.appendChild(fill);

    const total = document.createElement('span');
    total.className = `${prefix}-player-time`;
    total.textContent = '0:00';
    totalEl = total;

    const stopBtn = document.createElement('button');
    stopBtn.className = `${prefix}-player-stop`;
    stopBtn.setAttribute('aria-label', 'Stop');
    stopBtn.textContent = '×';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stop();
    });

    row.append(elapsed, track, total, stopBtn);
    li.appendChild(row);

    // Seek on click
    track.addEventListener('click', (e) => {
      if (!duration) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      sdkSeek(ratio * duration);
    });

    return li;
  }

  function insertScrubBar(afterLi: HTMLLIElement): void {
    removeScrubBar();
    scrubBar = createScrubBar();
    afterLi.insertAdjacentElement('afterend', scrubBar);
  }

  function removeScrubBar(): void {
    if (scrubBar) {
      scrubBar.remove();
      scrubBar = null;
      fillEl = null;
      elapsedEl = null;
      totalEl = null;
    }
  }

  // --- Progress ---

  function startProgress(): void {
    stopProgress();
    progressInterval = setInterval(updateProgress, 250);
  }

  function stopProgress(): void {
    if (progressInterval !== null) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
  }

  function updateProgress(): void {
    if (!fillEl || !elapsedEl) return;
    const pos = getAssetPosition();
    const pct = duration > 0 ? Math.min(100, (pos / duration) * 100) : 0;
    fillEl.style.width = `${pct}%`;
    elapsedEl.textContent = formatTime(pos);
  }

  // --- Events ---

  function onStateChange(e: Event): void {
    const detail = (e as CustomEvent<{ state: string }>).detail;
    if (detail.state === 'PLAYING') {
      startProgress();
    } else {
      stopProgress();
    }
    document.dispatchEvent(new CustomEvent('tidl-playback-state', {
      detail: { trackId: currentTrackId, state: detail.state },
    }));
  }

  function onTransition(e: Event): void {
    const detail = (e as CustomEvent<{ playbackContext: {
      actualDuration: number;
      actualAssetPresentation: string;
      assetPresentation: string;
      previewReason?: string;
    } }>).detail;
    const ctx = detail.playbackContext;
    duration = ctx.actualDuration;
    if (totalEl) totalEl.textContent = formatTime(duration);

    // Debug: why is playback preview-only?
    console.log('[tIDl] media-product-transition playbackContext:', JSON.stringify({
      actualAssetPresentation: ctx.actualAssetPresentation,
      assetPresentation: ctx.assetPresentation,
      actualDuration: ctx.actualDuration,
      previewReason: ctx.previewReason,
    }));
  }

  function onEnded(): void {
    stop();
  }

  events.addEventListener('playback-state-change', onStateChange);
  events.addEventListener('media-product-transition', onTransition);
  events.addEventListener('ended', onEnded);

  // --- Public API ---

  async function play(trackId: string, trackLi: HTMLLIElement): Promise<void> {
    if (destroyed) return;

    // Toggle pause/resume if same track
    if (currentTrackId === trackId) {
      const state = getPlaybackState();
      if (state === 'PLAYING') {
        sdkPause();
      } else {
        await sdkPlay();
      }
      return;
    }

    await ensureInitialized();

    // Verify we have a valid token before proceeding
    const creds = await credentialsProvider.getCredentials();
    if (!creds.token) return;

    // Debug: inspect credentials being sent to the player SDK
    console.log('[tIDl] credentials:', JSON.stringify({
      clientId: creds.clientId,
      userId: creds.userId,
      clientUniqueKey: creds.clientUniqueKey,
      grantedScopes: creds.grantedScopes,
      requestedScopes: creds.requestedScopes,
      tokenPrefix: creds.token?.substring(0, 20) + '...',
    }));

    // Update art indicators
    if (currentArtEl) currentArtEl.classList.remove(`${prefix}-art-playing`);
    const art = trackLi.querySelector<HTMLImageElement>(`.${prefix}-art`);
    if (art) {
      art.classList.add(`${prefix}-art-playing`);
      currentArtEl = art;
    }

    currentTrackId = trackId;
    duration = 0;
    insertScrubBar(trackLi);

    await load({
      productId: trackId,
      productType: 'track',
      sourceId: 'tidl-extension',
      sourceType: 'SEARCH',
    });

    await sdkPlay();
  }

  function stop(): void {
    const stoppedTrackId = currentTrackId;
    stopProgress();
    removeScrubBar();
    if (currentArtEl) {
      currentArtEl.classList.remove(`${prefix}-art-playing`);
      currentArtEl = null;
    }
    currentTrackId = null;
    duration = 0;
    reset().catch(() => {});
    document.dispatchEvent(new CustomEvent('tidl-playback-state', {
      detail: { trackId: stoppedTrackId, state: 'IDLE' },
    }));
  }

  function getCurrentTrackId(): string | null {
    return currentTrackId;
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    stop();
    events.removeEventListener('playback-state-change', onStateChange);
    events.removeEventListener('media-product-transition', onTransition);
    events.removeEventListener('ended', onEnded);
  }

  function isPlaying(): boolean {
    return getPlaybackState() === 'PLAYING';
  }

  return { play, stop, getCurrentTrackId, isPlaying, destroy };
}
