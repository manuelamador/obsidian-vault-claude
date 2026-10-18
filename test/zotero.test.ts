import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listZoteroItems, parseZoteroLink, zoteroCitation, zoteroItemByLink, zoteroLink, zoteroLinksIn, zoteroPdfPath, type ZoteroAnswer, type ZoteroGet } from '../src/zotero';

/** A stand-in for Zotero's local API: answers the paths in `routes`, 404 for the rest. */
function stand(routes: Record<string, Partial<ZoteroAnswer>>): { get: ZoteroGet; asked: string[] } {
  const asked: string[] = [];
  const get: ZoteroGet = async (path) => {
    asked.push(path);
    const answer = routes[path];
    return { status: answer ? 200 : 404, json: null, text: '', headers: {}, ...answer };
  };
  return { get, asked };
}

const kortum = { key: 'ITEM0001', data: { itemType: 'journalArticle', title: 'Research, Patenting, and Technological Change', date: '1997-11', DOI: '10.2307/2171741', publicationTitle: 'Econometrica' }, meta: { creatorSummary: '\u2068Kortum\u2069', parsedDate: '1997-11' } };

test('Zotero works are listed from every library, a page at a time, without notes or files on their own', async () => {
  const page = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ key: `K${start + i}`, data: { itemType: 'book', title: `Book ${start + i}` }, meta: { creatorSummary: 'A', parsedDate: '2001' } }));
  const { get, asked } = stand({
    '/api/users/0/groups?format=json': { json: [{ id: 42, data: { name: 'Reading Group' } }] },
    '/api/users/0/items/top?format=json&limit=100&start=0': { json: page(0, 100), headers: { 'total-results': '101' } },
    '/api/users/0/items/top?format=json&limit=100&start=100': { json: page(100, 1), headers: { 'total-results': '101' } },
    '/api/groups/42/items/top?format=json&limit=100&start=0': { json: [kortum, { key: 'N1', data: { itemType: 'note' } }], headers: { 'total-results': '2' } },
  });
  const items = await listZoteroItems(get);
  assert.equal(items.length, 102);
  assert.equal(asked.filter((path) => path.startsWith('/api/users/0/items/top')).length, 2);
  const work = items.find((item) => item.key === 'ITEM0001');
  assert.deepEqual(work?.library, { kind: 'group', id: 42, name: 'Reading Group' });
  assert.equal(work && zoteroLink(work), 'zotero://select/groups/42/items/ITEM0001');
  assert.equal(work && zoteroCitation(work), 'Kortum (1997). Research, Patenting, and Technological Change. Econometrica. https://doi.org/10.2307/2171741');
});

test('a Zotero link in a message is looked up again, with where its PDF is on this computer', async () => {
  const { get } = stand({
    '/api/users/0/items/ITEM0001?format=json': { json: kortum },
    '/api/users/0/items/ITEM0001/children?format=json': { json: [{ key: 'NOTE1', data: { itemType: 'note' } }, { key: 'FILE0001', data: { itemType: 'attachment', contentType: 'application/pdf' } }] },
    '/api/users/0/items/FILE0001/file/view/url': { text: 'file:///Users/me/Zotero/storage/FILE0001/Kortum%20-%201997.pdf' },
  });
  const text = 'see @[Kortum (1997) — Research](zotero://select/library/items/ITEM0001) and again zotero://select/library/items/ITEM0001';
  assert.deepEqual(zoteroLinksIn(text), ['zotero://select/library/items/ITEM0001']);
  const item = await zoteroItemByLink(zoteroLinksIn(text)[0], get);
  assert.equal(item?.title, 'Research, Patenting, and Technological Change');
  assert.equal(item && (await zoteroPdfPath(item, get)), '/Users/me/Zotero/storage/FILE0001/Kortum - 1997.pdf');
  assert.equal(await zoteroItemByLink('zotero://select/library/items/GONE', get), null);
  assert.deepEqual(parseZoteroLink('zotero://select/groups/7/items/AB12'), { key: 'AB12', library: { kind: 'group', id: 7, name: '' } });
  assert.equal(parseZoteroLink('https://example.com'), null);
});

test('Zotero not running: listing rejects, so the picker can say to start it', async () => {
  const get: ZoteroGet = async () => {
    throw new Error('connection refused');
  };
  await assert.rejects(listZoteroItems(get));
});
