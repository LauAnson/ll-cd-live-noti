/**
 * tools/import-discography.mjs
 * ----------------------------
 * One-off (but re-runnable) importer for the full LoveLive! CD discography.
 *
 * Sources (verified against the live sites):
 *   mu's        https://www.lovelive-anime.jp/otonokizaka/release.php
 *   Aqours      https://www.lovelive-anime.jp/uranohoshi/cd.php
 *   Nijigasaki  https://www.lovelive-anime.jp/nijigasaki/cd.php
 *   Liella!     https://www.lovelive-anime.jp/yuigaoka/music/
 *   Hasunosora  https://www.lovelive-anime.jp/hasunosora/music/
 *
 * Usage:
 *   node tools/import-discography.mjs            # dry-run report
 *   node tools/import-discography.mjs --write    # append to data.json
 *   node tools/import-discography.mjs --write --refresh
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = path.join(ROOT, 'data.json');
const requireFromScraper = createRequire(path.join(ROOT, 'scraper', 'package.json'));
const axios = requireFromScraper('axios');
const cheerio = requireFromScraper('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' };
const WRITE = process.argv.includes('--write');
const REFRESH = process.argv.includes('--refresh');
const GROUP_ORDER = ["μ's", 'Aqours', 'Nijigasaki', 'Liella!', 'Hasunosora', 'All'];
const GROUP_SLUG = {
  "μ's": 'mus',
  Aqours: 'aqours',
  Nijigasaki: 'nijigasaki',
  'Liella!': 'liella',
  Hasunosora: 'hasunosora',
  All: 'all'
};
const SOURCES = {
  "μ's": 'https://www.lovelive-anime.jp/otonokizaka/release.php',
  Aqours: 'https://www.lovelive-anime.jp/uranohoshi/cd.php',
  Nijigasaki: 'https://www.lovelive-anime.jp/nijigasaki/cd.php',
  'Liella!': 'https://www.lovelive-anime.jp/yuigaoka/music/',
  Hasunosora: 'https://www.lovelive-anime.jp/hasunosora/music/'
};

const stats = {
  perGroup: {},
  sourceErrors: [],
  skippedBluRay: 0,
  skippedPending: 0,
  skippedNoDate: 0,
  crossGroupDuplicates: 0,
  matchedSeed: 0,
  added: 0,
  refreshed: 0
};

function note(msg) {
  console.log(msg);
}

function normalizeSpace(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Text of an element with <br> turned into newlines and credit spans removed. */
function blockText($, el) {
  const clone = $(el).clone();
  clone.find('br').replaceWith('\n');
  clone.find('.uta').remove();
  return clone
    .text()
    .split('\n')
    .map(function (line) {
      return normalizeSpace(line);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeDate(value) {
  const text = normalizeSpace(value);
  if (!text) return '';
  let match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) match = text.match(/(\d{4})\s+(\d{1,2})[-/.](\d{1,2})/);
  if (!match) match = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return '';
  }
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function extractDate(text) {
  const labeled = text.match(/(?:【発売日】|発売日[:：])\s*\n?\s*([^\n]+)/);
  if (labeled) {
    const parsed = normalizeDate(labeled[1]);
    if (parsed) return parsed;
  }
  return normalizeDate(text);
}

function extractLabeled(text, labels) {
  for (const label of labels) {
    const pattern = new RegExp(label + '\\s*[:：]?\\s*\\n?\\s*([^\\n]+)');
    const match = text.match(pattern);
    if (match && normalizeSpace(match[1])) return normalizeSpace(match[1]);
  }
  return '';
}

function cleanSong(raw) {
  let song = normalizeSpace(raw);
  song = song.replace(/^(?:M)?\s*\d{1,3}[.．]\s*/, '');
  song = song.replace(/\s*(?:歌|作詞|作曲|編曲)\s*[:：].*$/, '');
  song = song.replace(/\s*[／/]\s*(?:μ'?s|Aqours|Liella!|虹ヶ咲学園スクールアイドル同好会)\s*$/, '');
  return song.trim();
}

function parseTracksFromBlock(text) {
  const lines = text.split('\n').map(normalizeSpace).filter(Boolean);
  const songs = [];
  let inside = false;
  let plainSection = false;
  for (const line of lines) {
    const header = line.match(/^(【|＜|〈|≪)収録(?:曲|内容)(】|＞|〉|≫)/);
    if (header) {
      inside = true;
      plainSection = header[1] !== '【';
      continue;
    }
    if (!inside) continue;
    if (/^(?:【|＜|〈|≪|■)/.test(line)) break;
    if (/^Disc[.\s]*\d+/i.test(line)) continue;
    if (/^\d{1,2}[.．]\s*/.test(line)) {
      const song = cleanSong(line);
      if (song && song.length <= 120) songs.push(song);
      continue;
    }
    if (plainSection) {
      if (/^(?:・|※|上記|価格|品番|発売|収録|Disc)/.test(line)) continue;
      if (/[円税]|枚組/.test(line)) continue;
      if (line.length <= 90) songs.push(line);
    }
  }
  if (!songs.length) {
    // A few older entries list tracks without a 【収録曲】 heading.
    for (const line of lines) {
      if (/^\d{1,2}[.．]\s*/.test(line)) {
        const song = cleanSong(line);
        if (song && song.length <= 120) songs.push(song);
      }
    }
  }
  return uniqueList(songs);
}

function uniqueList(list) {
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const key = value.normalize('NFKC').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function isBluRay(title) {
  return /Blu-?ray|ブルーレイ/i.test(title);
}

function isVideo(title) {
  if (isBluRay(title)) return true;
  // "CD+DVD" singles stay; live/DVD-only products are video releases.
  return /DVD/i.test(title) && !/CD\s*\+\s*DVD|CD\+DVD/i.test(title);
}

function isPending(title) {
  return title.indexOf('タイトル未定') !== -1;
}

/**
 * Old mu's entries sometimes only say "4月2日発売". The page is chronological,
 * so the year can be recovered from the nearest dated neighbours.
 */
function inferPartialDate(text, rows, index) {
  const match = text.match(/(\d{1,2})月\s*(\d{1,2})日発売/);
  if (!match) return '';
  const monthDay = String(match[1]).padStart(2, '0') + '-' + String(match[2]).padStart(2, '0');
  let prev = '';
  let next = '';
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rows[i].date) {
      prev = rows[i].date;
      break;
    }
  }
  for (let i = index + 1; i < rows.length; i += 1) {
    if (rows[i].date) {
      next = rows[i].date;
      break;
    }
  }
  if (!prev && !next) return '';
  const from = next ? Number(next.slice(0, 4)) : Number(prev.slice(0, 4)) - 1;
  const to = prev ? Number(prev.slice(0, 4)) : Number(next.slice(0, 4)) + 1;
  for (let year = from; year <= to; year += 1) {
    const candidate = year + '-' + monthDay;
    if ((!next || candidate >= next) && (!prev || candidate <= prev)) return candidate;
  }
  return '';
}

const MUS_DATE_OVERRIDES = [
  [/劇場版.*Notes of School Idol/i, '2015-08-05'],
  [/ミはμ[’']sicのミ/, '2015-04-22'],
  [/テーマソングDJCD/, '2012-10-17']
];

function overrideDate(title) {
  for (const pair of MUS_DATE_OVERRIDES) {
    if (pair[0].test(title)) return pair[1];
  }
  return '';
}

function keyFor(title, date) {
  return (
    title
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s「」『』【】\[\]（）()]/g, '') +
    '|' +
    date
  );
}

function makeId(group, title, date) {
  const hash = createHash('sha1').update(title + '|' + date).digest('hex').slice(0, 10);
  return 'disc-' + (GROUP_SLUG[group] || 'other') + '-' + hash;
}

async function fetchHtml(url, attempt) {
  const tries = attempt || 1;
  try {
    const response = await axios.get(url, { headers: HEADERS, timeout: 30000 });
    return response.data;
  } catch (error) {
    if (tries >= 3) throw error;
    await new Promise(function (resolve) {
      setTimeout(resolve, 800 * tries);
    });
    return fetchHtml(url, tries + 1);
  }
}

function pushItem(list, item) {
  if (!item.title || !item.date) {
    stats.skippedNoDate += 1;
    return;
  }
  list.push(item);
}

async function collectMus() {
  const $ = cheerio.load(await fetchHtml(SOURCES["μ's"]));
  const rows = [];
  $('.titlebase').each(function (i, el) {
    const box = $(el).closest('.box');
    const text = blockText($, box.find('.text'));
    const title = normalizeSpace(blockText($, el).split('\n').join(' '));
    if (isVideo(title)) {
      stats.skippedBluRay += 1;
      return;
    }
    if (isPending(title)) {
      stats.skippedPending += 1;
      return;
    }
    rows.push({ title: title, text: text, date: extractDate(text) });
  });

  rows.forEach(function (row, index) {
    if (row.date) return;
    row.date = overrideDate(row.title) || inferPartialDate(row.text, rows, index);
  });

  return rows
    .filter(function (row) {
      if (row.date) return true;
      stats.skippedNoDate += 1;
      note('  ! μ\'s without date: ' + row.title.slice(0, 60));
      return false;
    })
    .map(function (row) {
    return {
      group: "μ's",
      title: row.title,
      date: row.date,
      artist: extractLabeled(row.text, ['【アーティスト】']) || "μ's",
      songs: parseTracksFromBlock(row.text),
      link: SOURCES["μ's"]
    };
  });
}

async function collectAqours() {
  const $ = cheerio.load(await fetchHtml(SOURCES.Aqours));
  const items = [];
  $('.box')
    .filter(function (i, el) {
      return $(el).find('.cover').length > 0;
    })
    .each(function (i, el) {
      const box = $(el);
      const text = blockText($, box.find('.text'));
      const title =
        normalizeSpace(blockText($, box.find('.llbox'))) ||
        extractLabeled(text, ['【タイトル】']);
      if (!title) return;
      if (isVideo(title)) {
        stats.skippedBluRay += 1;
        return;
      }
      if (isPending(title)) {
        stats.skippedPending += 1;
        return;
      }
      const date = extractDate(text);
      const artist = extractLabeled(text, ['【アーティスト】']) || 'Aqours';
      pushItem(items, {
        group: 'Aqours',
        title: title,
        date: date,
        artist: artist,
        songs: parseTracksFromBlock(text),
        link: SOURCES.Aqours
      });
    });
  return items;
}

async function collectNijigasaki() {
  const $ = cheerio.load(await fetchHtml(SOURCES.Nijigasaki));
  const items = [];
  $('.box')
    .filter(function (i, el) {
      return $(el).find('.title').length > 0;
    })
    .each(function (i, el) {
      const box = $(el);
      const titleEl = box.find('.title').first().clone();
      titleEl.find('span').remove();
      const title = normalizeSpace(titleEl.text()) || normalizeSpace(box.find('.title').text());
      if (!title) return;
      if (isVideo(title)) {
        stats.skippedBluRay += 1;
        return;
      }
      if (isPending(title)) {
        stats.skippedPending += 1;
        return;
      }

      let date = '';
      let artist = '';
      box.find('dt').each(function (j, dt) {
        const label = normalizeSpace($(dt).text());
        const value = normalizeSpace($(dt).next('dd').text());
        if (/発売日/.test(label) && !date) date = normalizeDate(value);
        if (/アーティスト/.test(label) && !artist) artist = value;
      });

      const songs = [];
      box.find('ul.track li').each(function (j, li) {
        const clone = $(li).clone();
        clone.find('dl, span').remove();
        const song = cleanSong(clone.text());
        if (song && song.length <= 120) songs.push(song);
      });

      pushItem(items, {
        group: 'Nijigasaki',
        title: title,
        date: date,
        artist: artist || 'Nijigasaki High School Idol Club',
        songs: uniqueList(songs),
        link: SOURCES.Nijigasaki
      });
    });
  return items;
}

function parseLiellaDetail($) {
  const text = blockText($, $('body'));
  return {
    songs: parseTracksFromBlock(text),
    artist: extractLabeled(text, ['【アーティスト】'])
  };
}

async function collectLiella() {
  const baseUrl = SOURCES['Liella!'];
  const $ = cheerio.load(await fetchHtml(baseUrl));
  const anchors = $('.jkt').closest('a');
  const items = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors.eq(i);
    const date = normalizeDate(anchor.find('.date').text());
    const subtitle = normalizeSpace(anchor.find('.subtitle').text());
    const rawTitle = normalizeSpace(anchor.find('.title').text()).replace(/^「|」$/g, '');
    const title = normalizeSpace(subtitle + ' ' + rawTitle);
    if (!title) continue;
    if (isVideo(title)) {
      stats.skippedBluRay += 1;
      continue;
    }
    if (isPending(title)) {
      stats.skippedPending += 1;
      continue;
    }

    const href = anchor.attr('href') || '';
    let link = baseUrl;
    try {
      link = new URL(href, baseUrl).href;
    } catch (error) {
      link = baseUrl;
    }

    let songs = [];
    let artist = '';
    if (href) {
      try {
        const detail = cheerio.load(await fetchHtml(link));
        const parsed = parseLiellaDetail(detail);
        songs = parsed.songs;
        artist = parsed.artist;
      } catch (error) {
        note('  ! Liella! detail failed: ' + link + ' (' + error.message + ')');
      }
      await new Promise(function (resolve) {
        setTimeout(resolve, 250);
      });
    }

    pushItem(items, {
      group: 'Liella!',
      title: title,
      date: date,
      artist: artist || 'Liella!',
      songs: songs,
      link: link
    });
  }
  return items;
}

async function collectHasunosora() {
  const baseUrl = SOURCES.Hasunosora;
  const $ = cheerio.load(await fetchHtml(baseUrl));
  const items = [];
  $('.list--block').each(function (i, el) {
    const block = $(el);
    const anchor = block.closest('a');
    const headline = normalizeSpace(block.find('.list--headline').text());
    const rawTitle = normalizeSpace(block.find('.list--title').text()).replace(/^「|」$/g, '');
    const title = normalizeSpace(headline + ' ' + rawTitle);
    if (!title) return;
    if (isVideo(title)) {
      stats.skippedBluRay += 1;
      return;
    }
    if (isPending(title)) {
      stats.skippedPending += 1;
      return;
    }
    const date = normalizeDate(block.find('.list--desc__date').text());
    const href = anchor.attr('href') || '';
    let link = baseUrl;
    try {
      link = new URL(href, baseUrl).href;
    } catch (error) {
      link = baseUrl;
    }
    pushItem(items, {
      group: 'Hasunosora',
      title: title,
      date: date,
      artist: "Hasunosora Girls' High School Idol Club",
      songs: [],
      link: link
    });
  });
  return items;
}

function markCrossGroupDuplicates(items) {
  const byKey = new Map();
  items.forEach(function (item) {
    const key = keyFor(item.title, item.date);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  });
  const unique = [];
  byKey.forEach(function (group) {
    if (group.length === 1) {
      unique.push(group[0]);
      return;
    }
    const groups = new Set(group.map(function (item) { return item.group; }));
    stats.crossGroupDuplicates += group.length - 1;
    const primary = group[0];
    if (groups.size > 1) {
      note(
        '  ~ cross-listed: ' + primary.date + ' | ' + primary.title.slice(0, 60) +
        ' (' + Array.from(groups).join(' + ') + ')'
      );
      primary.group = 'All';
      primary.artist = uniqueList(
        group.map(function (item) { return item.artist; }).filter(Boolean)
      ).join(' / ');
    } else {
      note('  ~ duplicate row: ' + primary.date + ' | ' + primary.title.slice(0, 60) + ' (' + primary.group + ')');
    }
    unique.push(primary);
  });
  return unique;
}

function seedMatches(seed, item) {
  if (seed.releaseDate !== item.date) return false;
  const a = seed.albumTitle
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s「」『』【】\[\]（）()]/g, '');
  const b = item.title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s「」『』【】\[\]（）()]/g, '');
  return b.indexOf(a) !== -1;
}

async function main() {
  const raw = JSON.parse((await readFile(DATA_PATH, 'utf8')).replace(/^\uFEFF/, ''));
  const seeds = Array.isArray(raw.cds) ? raw.cds.slice() : [];

  const collectors = [
    ["μ's", collectMus],
    ['Aqours', collectAqours],
    ['Nijigasaki', collectNijigasaki],
    ['Liella!', collectLiella],
    ['Hasunosora', collectHasunosora]
  ];

  let imported = [];
  for (const pair of collectors) {
    const label = pair[0];
    try {
      const items = await pair[1]();
      stats.perGroup[label] = items.length;
      note('  [OK] ' + label + ': ' + items.length + ' items');
      imported = imported.concat(items);
    } catch (error) {
      stats.sourceErrors.push(label + ': ' + error.message);
      note('  [FAIL] ' + label + ': ' + error.message);
    }
  }

  imported = markCrossGroupDuplicates(imported);

  const usedIds = new Set(seeds.map(function (seed) { return seed.id; }));
  const unmatchedSeeds = [];
  seeds.forEach(function (seed) {
    const match = imported.find(function (item) { return seedMatches(seed, item); });
    if (!match) {
      unmatchedSeeds.push(seed.id);
      return;
    }
    stats.matchedSeed += 1;
    if (!Array.isArray(seed.songs) || seed.songs.length === 0) seed.songs = match.songs;
    if (!seed.artistOrUnit) seed.artistOrUnit = match.artist;
    if (!seed.officialLink) seed.officialLink = match.link;
    imported = imported.filter(function (item) { return item !== match; });
  });
  if (unmatchedSeeds.length) {
    note('  ! seeds without a discography match: ' + unmatchedSeeds.join(', '));
  }

  const existingByKey = new Map();
  seeds.forEach(function (seed) {
    existingByKey.set(keyFor(seed.albumTitle, seed.releaseDate), seed);
  });

  const newEntries = [];
  for (const item of imported) {
    const key = keyFor(item.title, item.date);
    if (existingByKey.has(key)) {
      const existing = existingByKey.get(key);
      if (REFRESH && Array.isArray(existing.songs) && existing.songs.length === 0) {
        existing.songs = item.songs;
        stats.refreshed += 1;
      }
      continue;
    }
    let id = makeId(item.group, item.title, item.date);
    let suffix = 2;
    while (usedIds.has(id)) {
      id = makeId(item.group, item.title, item.date) + '-' + suffix;
      suffix += 1;
    }
    usedIds.add(id);
    existingByKey.set(key, { id: id, albumTitle: item.title, releaseDate: item.date });
    newEntries.push({
      id: id,
      group: item.group,
      artistOrUnit: item.artist,
      albumTitle: item.title,
      releaseDate: item.date,
      songs: item.songs,
      specialOffer: '',
      imageUrl: '',
      officialLink: item.link,
      owned: false
    });
  }

  newEntries.sort(function (a, b) {
    const groupDiff = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (groupDiff !== 0) return groupDiff;
    return a.releaseDate.localeCompare(b.releaseDate);
  });

  const nextCds = seeds.concat(newEntries);
  stats.added = newEntries.length;

  const today = new Date().toISOString().slice(0, 10);
  const nextData = Object.assign({}, raw, {
    _comment: (raw._comment || []).map(function (line) {
      if (!/^cds:/.test(line)) return line;
      return (
        'cds: ' + nextCds.length + ' releases imported from the official group discography pages on ' +
        today + ' by tools/import-discography.mjs (one entry per edition; Blu-ray and ' +
        '"タイトル未定" excluded; Hasunosora track lists unavailable in static HTML).'
      );
    }),
    cds: nextCds
  });

  note('');
  note('Report');
  Object.keys(stats.perGroup).forEach(function (group) {
    note('- ' + group + ': ' + stats.perGroup[group] + ' kept');
  });
  note('- skipped Blu-ray/DVD: ' + stats.skippedBluRay);
  note('- skipped タイトル未定: ' + stats.skippedPending);
  note('- skipped no/invalid date: ' + stats.skippedNoDate);
  note('- cross-page duplicates collapsed: ' + stats.crossGroupDuplicates);
  note('- seed CDs enriched: ' + stats.matchedSeed + ' / ' + seeds.length);
  note('- new entries: ' + stats.added);
  note('- total cds after import: ' + nextCds.length);
  note('- source failures: ' + (stats.sourceErrors.length ? stats.sourceErrors.join('; ') : 'none'));
  note('');
  note('Samples:');
  newEntries.slice(0, 3).forEach(function (item) {
    note('  ' + item.group + ' | ' + item.releaseDate + ' | ' + item.albumTitle.slice(0, 80) + ' | songs=' + item.songs.length);
  });
  newEntries.slice(-3).forEach(function (item) {
    note('  ' + item.group + ' | ' + item.releaseDate + ' | ' + item.albumTitle.slice(0, 80) + ' | songs=' + item.songs.length);
  });

  if (!WRITE) {
    note('');
    note('[dry-run] data.json was not modified. Re-run with --write to apply.');
    return;
  }
  if (stats.sourceErrors.length) {
    note('');
    console.error('Refusing to write because one or more sources failed.');
    process.exitCode = 1;
    return;
  }

  const payload = JSON.stringify(nextData, null, 2) + '\n';
  await writeFile(DATA_PATH, payload, 'utf8');
  note('');
  note('Wrote ' + nextCds.length + ' CDs to data.json (' + Buffer.byteLength(payload, 'utf8') + ' bytes).');
  note('Next: node tools/sync-fallback.mjs');
}

main().catch(function (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
