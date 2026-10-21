import { closesFence, fenceMarker } from './fences';

// Replies are rendered with Obsidian's Markdown renderer, which fetches remote images, media and
// frames as soon as they are displayed. A reply shaped by a prompt injection could carry vault
// text in such a URL. So before rendering, an image is shown only when it is plainly a file of the
// vault (any other becomes a link), and raw HTML is shown as text, but for a few tags with no
// attributes, which can load nothing; a sweep of the rendered output catches anything missed.
// Code and math are left as they are.

/** Schemes rendered output may load from: the vault's own files (app:), and data that is already here. */
const LOCAL_SCHEMES = new Set(['app:', 'data:', 'blob:', 'file:', 'capacitor:']);
/** Files a `![[…]]` embed shows as themselves; any other embed (a note) is shown as a link instead. */
const MEDIA_EMBED = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|tiff?|pdf|mp3|wav|m4a|ogg|flac|webm|mp4|mov|mkv|ogv)$/i;
/** Elements rendered output never needs, whatever their attributes: they load or run things. */
const DROPPED_ELEMENTS = 'style, link, meta, base, script, iframe, frame, frameset, object, embed';
/** Raw HTML tags kept as they are: with no attributes, they can load nothing. Any other tag is shown as text. */
const PLAIN_TAG = /^<\/?(?:br|hr|wbr|sup|sub|kbd|b|i|u|em|strong|mark|s|del|ins|small|details|summary|code|pre|p|span|div|ul|ol|li|dl|dt|dd|table|thead|tbody|tr|th|td|blockquote|h[1-6])\s*\/?>$/i;
/** An autolink (`<https://…>`, `<a@b.c>`): a link, not HTML. */
const AUTOLINK = /^<(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>$/i;
/** Inside math, raw HTML tags that load resources; shown as text there. */
const MEDIA_TAGS = /<(\/?)(img|image|picture|source|video|audio|track|iframe|frame|frameset|object|embed|link|style|svg|meta|base|input|script)\b/gi;
/** Inside math, any other raw HTML tag, whose loading attributes are taken off. */
const HTML_TAG = /<[a-z][\w:-]*(?:[\s/][^<>]*)?>/gi;
/**
 * Attributes that make a tag load something: inline styles (url(), image-set(), CSS escapes),
 * legacy `background`, `poster`, and source attributes. Removed however they are quoted.
 */
const LOADING_ATTRIBUTES = /(?<=[\s/"'])(?:style|background|poster|srcset|src|data|lowsrc|dynsrc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;
/** An inline style that can load something: url(), image-set(), image(), @import, or a CSS escape hiding one. */
const LOADING_STYLE = /url\s*\(|image-set|image\s*\(|@import|\\/i;
const MEDIA_SELECTOR = 'img, video, audio, source, track, iframe, frame, object, embed, picture, input';

/**
 * For each bracket or parenthesis in `text` that opens, the index of the one closing it, honouring
 * nesting and escapes (brackets and parentheses each counted on their own); one never closed is
 * absent. Worked out in one pass, so that many unclosed `![` cost no more than one.
 */
function closers(text: string): Map<number, number> {
  const found = new Map<number, number>();
  const open: Record<string, number[]> = { '[': [], '(': [] };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') i += 1;
    else if (char === '[' || char === '(') open[char].push(i);
    else if (char === ']' || char === ')') {
      const start = open[char === ']' ? '[' : '('].pop();
      if (start !== undefined) found.set(start, i);
    }
  }
  return found;
}

/**
 * Markdown images → links unless plainly a file of the vault (see isVaultTarget); reference or
 * shortcut images always (their definition can point anywhere). Brackets nested in the alt text are
 * matched, so they cannot hide an image. A `![[…]]` embed stays when it is an image or other media
 * file; a note's embed becomes a link, since the note drawn in place would be drawn unfiltered.
 */
function rewriteImages(text: string): string {
  let out = '';
  let from = 0;
  let matched: Map<number, number> | null = null;
  const closing = (open: number) => (matched ??= closers(text)).get(open) ?? -1;
  // Once no `]]` is left, none is looked for again.
  let embedsClose = true;
  for (let start = text.indexOf('![', from); start !== -1; start = text.indexOf('![', from)) {
    if (text[start + 2] === '[') {
      const end = embedsClose ? text.indexOf(']]', start + 3) : -1;
      if (end === -1) embedsClose = false;
      const stop = end === -1 ? start + 3 : end + 2;
      const target = end === -1 ? '' : text.slice(start + 3, end).split(/[|#^]/)[0].trim();
      // A media file of the vault, as it is; anything else as a link to it.
      out += end === -1 || MEDIA_EMBED.test(target) ? text.slice(from, stop) : `${text.slice(from, start)}${text.slice(start + 1, stop)}`;
      from = stop;
      continue;
    }
    const altEnd = closing(start + 1);
    if (altEnd === -1) {
      out += text.slice(from, start + 2);
      from = start + 2;
      continue;
    }
    const alt = text.slice(start + 2, altEnd);
    const label = alt.trim() || 'image';
    if (text[altEnd + 1] === '(') {
      const targetEnd = closing(altEnd + 1);
      if (targetEnd === -1) {
        out += text.slice(from, altEnd + 1);
        from = altEnd + 1;
        continue;
      }
      const target = text.slice(altEnd + 2, targetEnd);
      out += text.slice(from, start) + (isVaultTarget(target) ? text.slice(start, targetEnd + 1) : `[${label}](${target})`);
      from = targetEnd + 1;
    } else {
      // Reference (`![alt][ref]`) or shortcut (`![alt]`) image: drop the `!`.
      out += `${text.slice(from, start)}[${alt}]`;
      from = altEnd + 1;
    }
  }
  return out + text.slice(from);
}

/**
 * Whether an image's target is plainly a file of the vault: a relative path, with no scheme, no
 * escape or entity that could spell one, and not starting with `/`. Anything else is not shown.
 */
function isVaultTarget(target: string): boolean {
  const trimmed = target.trim();
  const close = trimmed.indexOf('>');
  const destination = trimmed.startsWith('<') ? trimmed.slice(1, close === -1 ? undefined : close) : (trimmed.split(/\s+/)[0] ?? '');
  return destination !== '' && !/[:\\&]/.test(destination) && !destination.startsWith('/');
}

/**
 * Raw HTML shown as text, but for the tags that can load nothing (PLAIN_TAG) and autolinks; an
 * HTML comment is dropped. A link's or image's target in angle brackets (`[x](<my file.png>)`) is
 * not HTML either: those of real links, found by their brackets, are set aside first.
 */
function escapeHtml(text: string): string {
  const targets: string[] = [];
  const masked = angleTargets(text, (target) => {
    targets.push(target);
    return `\u0002${targets.length - 1}\u0002`;
  });
  return dropComments(masked)
    .replace(/<(?=[a-z/!?])[^<>]*>?/gi, (tag) => (PLAIN_TAG.test(tag) || AUTOLINK.test(tag) ? tag : `&lt;${tag.slice(1)}`))
    .replace(/\u0002(\d+)\u0002/g, (_match, index: string) => targets[Number(index)]);
}

/**
 * `text` without its HTML comments, each `<!--` to the first `-->` after it. One never closed stays
 * as text (escapeHtml escapes its `<`). A scan, not `/<!--[\s\S]*?-->/g`, which searches to the end
 * again from every unclosed `<!--`.
 */
function dropComments(text: string): string {
  let out = '';
  let from = 0;
  for (let open = text.indexOf('<!--'); open !== -1; open = text.indexOf('<!--', from)) {
    const close = text.indexOf('-->', open + 4);
    // No `-->` after this one, so none after any later one either.
    if (close === -1) break;
    out += text.slice(from, open);
    from = close + 3;
  }
  return out + text.slice(from);
}

/**
 * `text` with each link's target in angle brackets (`[x](<…>)`, the `[` matched to its `]`) given
 * to `mask`, which returns what stands in for it. A `](<` with no `[` before it is no link.
 */
function angleTargets(text: string, mask: (target: string) => string): string {
  let out = '';
  let from = 0;
  const matched = closers(text);
  for (let open = text.indexOf('[', from); open !== -1; open = text.indexOf('[', from)) {
    const close = matched.get(open) ?? -1;
    if (close === -1) break;
    if (text.startsWith('(<', close + 1)) {
      const end = text.indexOf('>', close + 3);
      const target = end === -1 ? '' : text.slice(close + 2, end + 1);
      // A path in brackets: no line break, quote, `=` or further `<` in it.
      if (target && !/[\n"'=<]/.test(target.slice(1, -1))) {
        out += text.slice(from, close + 2) + mask(target);
        from = end + 1;
        continue;
      }
    }
    out += text.slice(from, open + 1);
    from = open + 1;
  }
  return out + text.slice(from);
}

/**
 * Math, display (`$$…$$`) or inline (`$…$`, opening on no space and closing on none, not before a
 * digit): its `<` is a sign, not HTML, so it is left as it is but for tags that would load
 * something, should Obsidian not read it as math after all.
 */
export const MATH = /\$\$[\s\S]+?\$\$|(?<![\\$])\$(?=\S)(?:\\.|[^$\\\n])+?(?<=\S)\$(?![\d$])/g;

function neutralizeText(text: string): string {
  const math: string[] = [];
  const masked = rewriteImages(text).replace(MATH, (span) => {
    math.push(span.replace(MEDIA_TAGS, (_match, slash: string, tag: string) => `&lt;${slash}${tag}`).replace(HTML_TAG, (tag) => tag.replace(LOADING_ATTRIBUTES, '')));
    return `\u0001${math.length - 1}\u0001`;
  });
  return escapeHtml(masked).replace(/\u0001(\d+)\u0001/g, (_match, index: string) => math[Number(index)]);
}

/** Applies `neutralizeText` outside inline code spans. */
function outsideInlineCode(text: string): string {
  const spans: string[] = [];
  // A code span as CommonMark has it: a run of backticks, not escaped, closed by a run of the same
  // length, within one paragraph (no blank line in it).
  const masked = text.replace(/(?<![`\\])(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, (span) => {
    spans.push(span);
    return ` ${spans.length - 1} `;
  });
  return neutralizeText(masked).replace(/ (\d+) /g, (_match, index: string) => spans[Number(index)]);
}

/** Rewrites remote images and media in Markdown as links, leaving fenced and inline code alone. */
export function neutralizeRemoteMedia(markdown: string): string {
  const out: string[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (buffer.length > 0) out.push(outsideInlineCode(buffer.join('\n')));
    buffer = [];
  };
  // An indented fence (in a list item) ends with its item: at the first line indented less than it.
  let indent = 0;
  // A fence in a quote ends with its quote: at the first line with fewer `>` marks than it opened with.
  let quotes = 0;
  for (const line of markdown.split('\n')) {
    // A fence in a quote is one too: its `>` marks are not part of it.
    const marks = /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? '';
    const bare = line.slice(marks.length);
    const depth = marks.split('>').length - 1;
    const opening = fenceMarker(bare);
    if (fence) {
      const ended = depth < quotes || (line.trim() !== '' && line.length - line.trimStart().length < indent);
      if (!ended) {
        out.push(line);
        // Closed only at the depth it opened at: a quoted fence line inside an unquoted block is content.
        if (depth === quotes && closesFence(bare, fence)) fence = null;
        continue;
      }
      fence = null;
    }
    if (opening) {
      flush();
      fence = opening;
      indent = line.length - line.trimStart().length;
      quotes = depth;
      out.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join('\n');
}

/** The elements of `root` matching `selector`: `root` itself when it does, then those in it. */
function within<T extends Element>(root: Element | DocumentFragment, selector: string, shallow: boolean): T[] {
  const inside = shallow ? [] : Array.from(root.querySelectorAll<T>(selector));
  return root instanceof Element && root.matches(selector) ? [root as T, ...inside] : inside;
}

/** Whether `value`, an address in rendered output, would load from outside this computer. */
function loadsRemote(value: string, base: string): boolean {
  try {
    return !LOCAL_SCHEMES.has(new URL(value.trim(), base).protocol);
  } catch {
    // Not an address a browser would load.
    return false;
  }
}

/**
 * Makes rendered output load nothing from outside this computer, on an allow-list of schemes (see
 * LOCAL_SCHEMES): an image or media element with any other address, in any of the attributes it
 * loads from, becomes a link to it; an inline style or legacy attribute that could load something
 * is taken off; and elements that load or run things are removed. Run on output not yet in the
 * page, a style is removed before it is ever applied. `shallow`: `root` alone, not what is in it
 * (an attribute of it changed).
 */
export function sweepRemoteMedia(root: Element | DocumentFragment, shallow = false): void {
  const doc = root.ownerDocument ?? document;
  const base = doc.baseURI;
  for (const el of within(root, DROPPED_ELEMENTS, shallow)) el.remove();
  for (const el of within<HTMLElement>(root, '[style], [background], [poster]', shallow)) {
    if (LOADING_STYLE.test(el.getAttribute('style') ?? '')) el.removeAttribute('style');
    el.removeAttribute('background');
    el.removeAttribute('poster');
  }
  // SVG's own loaders, which Markdown never makes: removed.
  for (const el of within(root, 'image, use, feImage', shallow)) {
    const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
    if (href && !href.startsWith('#') && loadsRemote(href, base)) el.remove();
  }
  for (const el of within<HTMLElement>(root, MEDIA_SELECTOR, shallow)) {
    const addresses = [el.getAttribute('src'), el.getAttribute('data'), ...(el.getAttribute('srcset') ?? '').split(',').map((candidate) => candidate.trim().split(/\s+/)[0])];
    const remote = addresses.find((address): address is string => !!address && loadsRemote(address, base));
    if (remote === undefined) continue;
    const link = doc.createElement('a');
    link.href = remote.trim();
    link.textContent = el.getAttribute('alt') || remote.trim();
    link.className = 'external-link';
    link.target = '_blank';
    link.rel = 'noopener';
    el.replaceWith(link);
  }
}

/** Schemes a link in a reply never opens: they run script rather than name something to open. */
const SCRIPT_SCHEMES = new Set(['javascript:', 'vbscript:', 'data:', 'blob:']);

/** Whether a link in a reply may be opened: an address that parses, in a scheme that runs no script. */
export function openableHref(href: string): boolean {
  try {
    return !SCRIPT_SCHEMES.has(new URL(href).protocol);
  } catch {
    return false;
  }
}
