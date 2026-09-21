// Turns what the user typed or pasted into the capture box into an item's title
// and body, and recognises a capture that is nothing but a link.
import { linkify } from './linkify.js';

/**
 * First non-blank line = title; everything after it = body. A single long line
 * is never split: only a real line break separates title from body.
 * @param {unknown} raw
 * @returns {{ text: string, body: string }}
 */
export function parseCapture(raw) {
  if (typeof raw !== 'string') return { text: '', body: '' };

  // Windows and old-Mac line endings would otherwise leave stray \r in the body.
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return { text: '', body: '' };

  return {
    text: lines[first].trim(),
    body: lines.slice(first + 1).join('\n').trim(),
  };
}

/**
 * True when the whole capture is one link and nothing else, so the title of the
 * page it points to can stand in for the raw URL. Asking linkify (not just
 * toHref) keeps this in step with what a row will actually render as a link:
 * "https://x.org." is a sentence, not a bare URL.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isBareUrl(text) {
  if (typeof text !== 'string') return false;
  const segments = linkify(text.trim());
  return segments.length === 1 && segments[0].type === 'link';
}
