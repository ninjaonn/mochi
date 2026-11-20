const test = require('node:test');
const assert = require('node:assert');
const { buildItems, search } = require('../src/launcher');

const entry = (over) => ({ id: over.title, group: '', envs: [], username: '', hasPassword: true, fav: false, deletedAt: null, ...over });
const entries = [
  entry({ title: 'Report DB', group: 'DB', username: 'report.user', envs: ['UAT'] }),
  entry({ title: 'Main DB', group: 'DB', username: 'main.user', envs: ['PROD'], fav: true }),
  entry({ title: 'Old server', deletedAt: 1 }),
];
const projects = [{
  project: 'Portal',
  items: [{ label: 'PROD', url: 'https://prod.example.invalid' }, { label: 'UAT', url: 'https://uat.example.invalid' }, { raw: 'not a link' }],
}];
const items = buildItems(entries, projects);
const titles = (query) => search(items, query).map((i) => `${i.title}${i.kind === 'link' ? ' ' + i.chips[0] : ''}`);

test('items never contain a password, and skip trash and non-links', () => {
  const withSecret = buildItems([entry({ title: 'X', password: 'Fake-Pass', prevPassword: 'Old-Fake' })], []);
  assert.ok(!JSON.stringify(withSecret).includes('Fake'));
  assert.strictEqual(items.length, 4);
  assert.ok(!items.some((i) => i.title === 'Old server'));
});

test('words can match across title, environment and username', () => {
  assert.deepStrictEqual(titles('portal uat'), ['Portal UAT']);
  assert.deepStrictEqual(titles('uat portal'), ['Portal UAT']);
  assert.deepStrictEqual(titles('REPORT.USER'), ['Report DB']);
  assert.deepStrictEqual(titles('db prod'), ['Main DB']);
});

test('every word has to match', () => {
  assert.deepStrictEqual(titles('portal dev'), []);
});

test('a title match beats a match elsewhere', () => {
  const list = buildItems([entry({ title: 'Billing', group: 'report' }), entry({ title: 'My report' }), entry({ title: 'Report' })], []);
  assert.deepStrictEqual(search(list, 'report').map((i) => i.title), ['Report', 'My report', 'Billing']);
});

test('an empty search lists favourites first', () => {
  assert.strictEqual(titles('')[0], 'Main DB');
  assert.strictEqual(titles('   ').length, 4);
});

test('results stop at the limit', () => {
  const many = buildItems(Array.from({ length: 20 }, (_, i) => entry({ title: `Key ${i}` })), []);
  assert.strictEqual(search(many, 'key').length, 8);
});
