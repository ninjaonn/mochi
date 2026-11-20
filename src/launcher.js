// Quick launcher search over keys and links. Items carry no secrets: the
// launcher window sees titles and usernames, and copying goes through the vault.
const LIMIT = 8;

function buildItems(entries, projects) {
  const keys = entries.filter((e) => !e.deletedAt).map((e) => ({
    kind: 'key',
    id: e.id,
    title: e.title,
    sub: [e.username, e.group].filter(Boolean).join(' · '),
    chips: e.envs || [],
    username: e.username,
    hasPassword: e.hasPassword,
    fav: e.fav,
  }));
  const links = projects.flatMap((p) => p.items.filter((i) => i.url).map((i) => ({
    kind: 'link',
    url: i.url,
    title: p.project,
    sub: i.url,
    chips: i.label ? [i.label] : [],
    fav: false,
  })));
  return [...keys, ...links];
}

// Every word must match somewhere, so "portal uat" finds the UAT link of Portal.
function search(items, query, limit = LIMIT) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const rank = (item) => {
    if (!words.length) return 0;
    const title = item.title.toLowerCase();
    if (title.startsWith(words[0])) return 0;
    return title.includes(words[0]) ? 1 : 2;
  };
  return items
    .filter((item) => {
      const text = [item.title, item.sub, ...item.chips].join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .map((item) => ({ item, score: rank(item) * 2 + (item.fav ? 0 : 1) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ item }) => item);
}

module.exports = { buildItems, search };
