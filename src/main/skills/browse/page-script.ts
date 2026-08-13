/**
 * Code in this file runs inside the *page*, not in the main process, so it is kept as a string
 * rather than a function. Playwright accepts either, and a string keeps the DOM lib out of the
 * main-process TypeScript project, where it would collide with Node's own fetch and stream types.
 *
 * Keep it small and dependency-free; there is no bundling step on the far side of `evaluate`.
 *
 * Each script must be *self-invoking*: Playwright evaluates a string as an expression rather than
 * calling it, so a bare arrow function would serialize back as `undefined`.
 */
export const EXTRACT_READABLE_TEXT = `(() => {
  const clone = document.body.cloneNode(true);
  const strip = [
    'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe',
    'svg', 'button', '[role="navigation"]', '[role="banner"]',
    '[role="complementary"]', '[role="search"]', '[hidden]'
  ];
  for (const selector of strip) {
    for (const node of clone.querySelectorAll(selector)) node.remove();
  }
  // Prefer the semantic content region; fall back to the whole body when a page has none.
  const main = clone.querySelector('main, article, [role="main"]') || clone;
  return (main.textContent || '').replace(/\\s+/g, ' ').trim();
})()`

/**
 * Cookie and login walls set aria-hidden on the whole app. After stripping chrome, that can leave
 * nothing. This keeps the article even when a modal is sitting on top of it.
 */
export const EXTRACT_LOOSE_TEXT = `(() => {
  const main = document.querySelector('article, main, [role="main"]') || document.body;
  return (main.textContent || '').replace(/\\s+/g, ' ').trim();
})()`
