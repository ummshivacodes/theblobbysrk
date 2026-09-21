import { isBareUrl } from '../core/capture.js';
import { toHref } from '../core/linkify.js';

// Gives a captured link the title of the page it points to, so a row reads "An article worth reading" instead of
// https://www.example.com/2026/09/an-article-worth-rea…. The fetch is the main process's job (it has the
// network, a timeout and a size cap); this only decides WHEN to ask and what to do with the answer.
//
// It is a courtesy, never a requirement: fire and forget. A page with no title, a site that hides it from a
// non-browser (Instagram often does), no network, a timeout: all just mean "no title", silently, and the row
// keeps showing the shortened address.
//
// fetchTitle(href) → Promise<string | null>          setLinkTitle(id, url, title)
export function createLinkTitles({ fetchTitle, setLinkTitle }) {
  const pending = new Set(); // "id url" keys in flight: asking twice for the same thing is one fetch

  // id: the item just created (null = nothing was captured); text: what it says. Only a title that is nothing
  // but one link is worth asking about.
  function request(id, text) {
    if (!id || typeof text !== 'string' || !isBareUrl(text)) return;
    const url = text.trim(); // the store only applies a title while the item's text is still exactly this
    const href = toHref(url);
    const key = `${id} ${url}`;
    if (!href || pending.has(key)) return;
    pending.add(key);
    Promise.resolve()
      .then(() => fetchTitle(href))
      .then((title) => {
        if (typeof title === 'string' && title.trim() !== '') setLinkTitle(id, url, title);
      })
      .catch(() => { /* no title is not an error */ })
      .finally(() => { pending.delete(key); });
  }

  return { request };
}
