/**
 * Entry point for utils/tiktoken.bundle.js -- NOT loaded directly by the extension.
 *
 *     cd dashboard && npm run build:tiktoken
 *
 * Bundles js-tiktoken and the cl100k_base rank table into one local ES module, so the
 * extension can count tokens exactly without a network request. The rules this obeys:
 * no executable code from a CDN, no tokenizer files downloaded at runtime, and the
 * whole thing works with no connection after install.
 *
 * WHY IT IS NOT IN THE MANIFEST. The rank table is about a megabyte of JSON. Listing
 * this in content_scripts would parse it on every ChatGPT page load, before the user
 * has typed anything, to serve a count that the heuristic already approximates. Instead
 * content.js imports it once the page is idle and hands the encoder to
 * PromptMeterTokenizer.setEncoder(), which is exactly the seam that method exists for.
 * Until that import resolves the estimate is used and the card says so with a ~.
 */
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';

const encoder = new Tiktoken(cl100k);

/** The encoding these ranks implement, for the UI and for debugging. */
export const name = 'cl100k_base';

/**
 * @param {string} text
 * @returns {Array} Token ids. Only its length is read.
 */
export function encode(text) {
    return encoder.encode(text);
}
