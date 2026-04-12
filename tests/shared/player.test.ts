/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @tidal-music/player before importing our module
const mockBootstrap = vi.fn();
const mockSetCredentialsProvider = vi.fn();
const mockSetEventSender = vi.fn();
const mockLoad = vi.fn().mockResolvedValue(undefined);
const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockPause = vi.fn();
const mockSeek = vi.fn().mockResolvedValue(undefined);
const mockReset = vi.fn().mockResolvedValue(undefined);
const mockGetAssetPosition = vi.fn().mockReturnValue(0);
const mockGetPlaybackState = vi.fn().mockReturnValue('IDLE');

const eventListeners = new Map<string, Set<(e: Event) => void>>();
const mockEvents = {
  addEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type)!.add(fn);
  }),
  removeEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
    eventListeners.get(type)?.delete(fn);
  }),
};

function dispatchPlayerEvent(type: string, detail: unknown): void {
  const event = new CustomEvent(type, { detail });
  eventListeners.get(type)?.forEach(fn => fn(event));
}

vi.mock('@tidal-music/player', () => ({
  bootstrap: mockBootstrap,
  setCredentialsProvider: mockSetCredentialsProvider,
  setEventSender: mockSetEventSender,
  load: mockLoad,
  play: mockPlay,
  pause: mockPause,
  seek: mockSeek,
  reset: mockReset,
  events: mockEvents,
  getAssetPosition: mockGetAssetPosition,
  getPlaybackState: mockGetPlaybackState,
}));

// Mock the auth module
const mockGetCredentials = vi.fn().mockResolvedValue({
  token: 'test-token',
  clientId: 'test-client',
  userId: 'test-user',
  requestedScopes: [],
});

vi.mock('../../src/shared/auth', () => ({
  initAuth: vi.fn().mockResolvedValue(undefined),
  credentialsProvider: {
    bus: () => {},
    getCredentials: (...args: unknown[]) => mockGetCredentials(...args),
  },
}));

// Dynamic import so the mock is in place first
const { createPlayer } = await import('../../src/shared/player');

function makeTrackLi(trackId: string): HTMLLIElement {
  const li = document.createElement('li');
  const img = document.createElement('img');
  img.className = 'test-art';
  li.appendChild(img);
  return li;
}

describe('createPlayer', () => {
  let container: HTMLUListElement;

  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    mockGetCredentials.mockResolvedValue({
      token: 'test-token',
      clientId: 'test-client',
      userId: 'test-user',
      requestedScopes: [],
    });
    container = document.createElement('ul');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('calls load and play with correct MediaProduct', async () => {
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    await player.play('track-1', li);

    expect(mockLoad).toHaveBeenCalledWith({
      productId: 'track-1',
      productType: 'track',
      sourceId: 'tidl-extension',
      sourceType: 'SEARCH',
    });
    expect(mockPlay).toHaveBeenCalled();
  });

  it('inserts scrub bar after the track li', async () => {
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    await player.play('track-1', li);

    const scrubBar = li.nextElementSibling;
    expect(scrubBar).not.toBeNull();
    expect(scrubBar!.classList.contains('test-player-bar')).toBe(true);
  });

  it('toggles pause when same track is playing', async () => {
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    await player.play('track-1', li);
    mockGetPlaybackState.mockReturnValue('PLAYING');
    await player.play('track-1', li);

    expect(mockPause).toHaveBeenCalled();
  });

  it('toggles resume when same track is paused', async () => {
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    await player.play('track-1', li);
    mockPlay.mockClear();
    mockGetPlaybackState.mockReturnValue('NOT_PLAYING');
    await player.play('track-1', li);

    expect(mockPlay).toHaveBeenCalled();
    expect(mockLoad).toHaveBeenCalledTimes(1); // no second load
  });

  it('switches tracks when different track is played', async () => {
    const player = createPlayer('test');
    const li1 = makeTrackLi('track-1');
    const li2 = makeTrackLi('track-2');
    container.append(li1, li2);

    await player.play('track-1', li1);
    await player.play('track-2', li2);

    expect(mockLoad).toHaveBeenCalledTimes(2);
    expect(mockLoad).toHaveBeenLastCalledWith(expect.objectContaining({ productId: 'track-2' }));

    // Scrub bar moved to after li2
    expect(li2.nextElementSibling?.classList.contains('test-player-bar')).toBe(true);
    // Old scrub bar removed
    expect(li1.nextElementSibling).toBe(li2);
  });

  it('adds playing class to art element', async () => {
    const player = createPlayer('test');
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.className = 'test-art';
    li.appendChild(img);
    container.appendChild(li);

    await player.play('track-1', li);
    expect(img.classList.contains('test-art-playing')).toBe(true);
  });

  it('stop removes scrub bar and resets state', async () => {
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    await player.play('track-1', li);
    player.stop();

    expect(player.getCurrentTrackId()).toBeNull();
    expect(container.querySelector('.test-player-bar')).toBeNull();
    expect(mockReset).toHaveBeenCalled();
  });

  it('getCurrentTrackId returns correct value', async () => {
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    expect(player.getCurrentTrackId()).toBeNull();
    await player.play('track-1', li);
    expect(player.getCurrentTrackId()).toBe('track-1');
  });

  it('destroy cleans up event listeners', async () => {
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    await player.play('track-1', li);
    player.destroy();

    expect(mockEvents.removeEventListener).toHaveBeenCalledWith('playback-state-change', expect.any(Function));
    expect(mockEvents.removeEventListener).toHaveBeenCalledWith('media-product-transition', expect.any(Function));
    expect(mockEvents.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(player.getCurrentTrackId()).toBeNull();
  });

  it('scrub bar click calls seek with correct position', async () => {
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    await player.play('track-1', li);

    // Simulate media-product-transition with duration
    dispatchPlayerEvent('media-product-transition', {
      playbackContext: { actualDuration: 200 },
      mediaProduct: { productId: 'track-1' },
    });

    const trackBar = container.querySelector('.test-player-track') as HTMLElement;
    expect(trackBar).not.toBeNull();

    // Mock getBoundingClientRect for the track bar
    vi.spyOn(trackBar, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 100, width: 100, top: 0, bottom: 4, height: 4, x: 0, y: 0, toJSON: () => {},
    });

    trackBar.dispatchEvent(new MouseEvent('click', { clientX: 50, bubbles: true }));
    expect(mockSeek).toHaveBeenCalledWith(100); // 50% of 200s
  });

  it('does not play after destroy', async () => {
    const player = createPlayer('test');
    player.destroy();

    const li = makeTrackLi('track-1');
    container.appendChild(li);
    await player.play('track-1', li);

    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('does not play if credentials have no token', async () => {
    mockGetCredentials.mockResolvedValue({ token: '', clientId: '', userId: '', requestedScopes: [] });
    const player = createPlayer('test');
    const li = makeTrackLi('track-1');
    container.appendChild(li);

    await player.play('track-1', li);

    expect(mockLoad).not.toHaveBeenCalled();
  });
});
