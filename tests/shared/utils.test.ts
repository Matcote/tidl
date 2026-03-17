/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { escapeHtml, openTidalLink } from '../../src/shared/utils';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('<tag>')).toBe('&lt;tag&gt;');
  });

  it('escapes greater-than', () => {
    expect(escapeHtml('a>b')).toBe('a&gt;b');
  });

  it('escapes double quote', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('passes through plain strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes multiple special chars', () => {
    expect(escapeHtml('<a href="foo&bar">')).toBe('&lt;a href=&quot;foo&amp;bar&quot;&gt;');
  });
});

describe('openTidalLink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'open').mockReturnValue(null);
  });

  it('appends and removes an anchor with appUrl href', () => {
    openTidalLink('tidal://track/123', 'https://tidal.com/track/123');
    // Anchor is removed synchronously after click
    expect(document.querySelector('a[href="tidal://track/123"]')).toBeNull();
  });

  it('opens webUrl in _blank after 600ms', () => {
    openTidalLink('tidal://track/123', 'https://tidal.com/track/123');
    expect(window.open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(window.open).toHaveBeenCalledWith('https://tidal.com/track/123', '_blank');
  });

  it('does not open webUrl if window blur fires before 600ms', () => {
    openTidalLink('tidal://track/123', 'https://tidal.com/track/123');
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(600);
    expect(window.open).not.toHaveBeenCalled();
  });
});
