// Zotero items for the `@` picker, read through Zotero's local API on this computer
// (127.0.0.1:23119, the one Zotero serves while it runs): the only requests the plugin makes
// itself, and only with "Zotero in @" on. Every library is read: My Library and the groups.
import { requestUrl } from 'obsidian';

const ZOTERO = 'http://127.0.0.1:23119';
/** Items read per request: the most the API gives. */
const PAGE = 100;
/** Kinds of item that are not works to cite: a library's notes, files and annotations on their own. */
const NOT_WORKS = new Set(['note', 'attachment', 'annotation']);

/** A Zotero library: My Library, or a group's. */
export type ZoteroLibrary = { kind: 'user' } | { kind: 'group'; id: number; name: string };

export interface ZoteroItem {
  key: string;
  library: ZoteroLibrary;
  title: string;
  /** As Zotero sums up the authors: "Kortum", "Eaton and Kortum", "Eaton et al.". */
  creators: string;
  year: string;
  venue: string;
  doi: string;
  url: string;
}

/** An answer from the API: its status, its body read as JSON (null when it is not), and its headers. */
export interface ZoteroAnswer {
  status: number;
  json: unknown;
  text: string;
  headers: Record<string, string>;
}

/** Reads `path` of the local API; rejects when Zotero does not answer (not running). */
export type ZoteroGet = (path: string) => Promise<ZoteroAnswer>;

export const zoteroGet: ZoteroGet = async (path) => {
  const answer = await requestUrl({ url: `${ZOTERO}${path}`, throw: false });
  let json: unknown = null;
  try {
    json = answer.json;
  } catch {
    json = null;
  }
  return { status: answer.status, json, text: answer.text, headers: answer.headers };
};

/** The API's path for a library. */
function libraryPath(library: ZoteroLibrary): string {
  return library.kind === 'user' ? '/api/users/0' : `/api/groups/${library.id}`;
}

/** The link that selects `item` in Zotero, as the vault's notes cite it. */
export function zoteroLink(item: { key: string; library: ZoteroLibrary }): string {
  return item.library.kind === 'user' ? `zotero://select/library/items/${item.key}` : `zotero://select/groups/${item.library.id}/items/${item.key}`;
}

/** `link` read back: the library and key it selects; null for a link that is not one. */
export function parseZoteroLink(link: string): { key: string; library: ZoteroLibrary } | null {
  const match = /^zotero:\/\/select\/(?:library|groups\/(\d+))\/items\/([A-Z0-9]+)$/.exec(link);
  if (!match) return null;
  return { key: match[2], library: match[1] ? { kind: 'group', id: Number(match[1]), name: '' } : { kind: 'user' } };
}

/** The `zotero://select` links in `text`. */
export function zoteroLinksIn(text: string): string[] {
  return [...new Set([...text.matchAll(/zotero:\/\/select\/(?:library|groups\/\d+)\/items\/[A-Z0-9]+/g)].map((match) => match[0]))];
}

/** How the picker and a message's chip name `item`: "Kortum (1997)". */
export function zoteroLabel(item: ZoteroItem): string {
  return `${item.creators || 'Unknown'}${item.year ? ` (${item.year})` : ''}`;
}

/** A work's title cut to `max` characters, for the link the picker puts in the input. */
export function shortTitle(title: string, max = 60): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `item` as a line of citation: authors, year, title, venue and its DOI link (else its web page). */
export function zoteroCitation(item: ZoteroItem): string {
  const where = item.doi ? `https://doi.org/${item.doi}` : item.url;
  return [`${zoteroLabel(item)}.`, item.title ? `${item.title}.` : '', item.venue ? `${item.venue}.` : '', where].filter(Boolean).join(' ');
}

/** An item as the API gives it, read as a ZoteroItem; null for one that is not a work to cite. */
function readItem(raw: unknown, library: ZoteroLibrary): ZoteroItem | null {
  const item = raw as { key?: string; data?: Record<string, unknown>; meta?: { creatorSummary?: string; parsedDate?: string } };
  const data = item.data ?? {};
  // Without the direction marks Zotero puts around names (\u2066–\u2069), which would go into links and citations.
  const text = (value: unknown) => (typeof value === 'string' ? value.replace(/[\u2066-\u2069]/g, '') : '');
  if (!item.key || NOT_WORKS.has(text(data.itemType))) return null;
  return {
    key: item.key,
    library,
    title: text(data.title),
    creators: text(item.meta?.creatorSummary),
    year: (text(item.meta?.parsedDate) || text(data.date)).slice(0, 4),
    venue: text(data.publicationTitle) || text(data.bookTitle) || text(data.proceedingsTitle) || text(data.publisher) || text(data.institution),
    doi: text(data.DOI),
    url: text(data.url),
  };
}

/** Every work in `library`, read a page at a time. */
async function libraryItems(get: ZoteroGet, library: ZoteroLibrary): Promise<ZoteroItem[]> {
  const items: ZoteroItem[] = [];
  for (let start = 0; ; start += PAGE) {
    const answer = await get(`${libraryPath(library)}/items/top?format=json&limit=${PAGE}&start=${start}`);
    if (answer.status !== 200 || !Array.isArray(answer.json)) throw new Error(`Zotero answered ${answer.status}`);
    for (const raw of answer.json) {
      const item = readItem(raw, library);
      if (item) items.push(item);
    }
    const total = Number(answer.headers['total-results'] ?? answer.headers['Total-Results'] ?? 0);
    if (answer.json.length < PAGE || start + PAGE >= total) return items;
  }
}

/** Every work in every library: My Library, then the groups. Rejects when Zotero is not running. */
export async function listZoteroItems(get: ZoteroGet = zoteroGet): Promise<ZoteroItem[]> {
  const groups = await get('/api/users/0/groups?format=json');
  const libraries: ZoteroLibrary[] = [{ kind: 'user' }];
  if (groups.status === 200 && Array.isArray(groups.json)) {
    for (const group of groups.json as { id?: number; data?: { name?: string } }[]) {
      if (typeof group.id === 'number') libraries.push({ kind: 'group', id: group.id, name: group.data?.name ?? '' });
    }
  }
  return (await Promise.all(libraries.map((library) => libraryItems(get, library)))).flat();
}

/** The item `link` selects, read from Zotero; null when it is not there. Rejects when Zotero is not running. */
export async function zoteroItemByLink(link: string, get: ZoteroGet = zoteroGet): Promise<ZoteroItem | null> {
  const parsed = parseZoteroLink(link);
  if (!parsed) return null;
  const answer = await get(`${libraryPath(parsed.library)}/items/${parsed.key}?format=json`);
  return answer.status === 200 ? readItem(answer.json, parsed.library) : null;
}

/** Where `item`'s PDF is on this computer (its first PDF attachment); null when it has none. */
export async function zoteroPdfPath(item: { key: string; library: ZoteroLibrary }, get: ZoteroGet = zoteroGet): Promise<string | null> {
  const children = await get(`${libraryPath(item.library)}/items/${item.key}/children?format=json`);
  if (children.status !== 200 || !Array.isArray(children.json)) return null;
  const pdf = (children.json as { key?: string; data?: { contentType?: string; itemType?: string } }[]).find((child) => child.data?.itemType === 'attachment' && child.data.contentType === 'application/pdf');
  if (!pdf?.key) return null;
  const file = await get(`${libraryPath(item.library)}/items/${pdf.key}/file/view/url`);
  const url = file.status === 200 ? file.text.trim() : '';
  if (!url.startsWith('file://')) return null;
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    // On Windows the path follows a slash: /C:/Users/…
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}
