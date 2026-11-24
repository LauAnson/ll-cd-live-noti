#!/usr/bin/env node
/**
 * LoveLive! official-news scraper
 * ==============================
 *
 * IMPORTANT LIMITATIONS - read this before changing selectors:
 *
 * 1. Only titles, dates and links are extracted. The scraper does NOT classify
 *    items, so `type` defaults to "Uncategorized" and needs manual follow-up.
 * 2. Special offers (bonus goods), ticket info and locations live on DETAIL
 *    pages. This script intentionally does not follow those links (keeps the
 *    request count low and avoids anti-bot blocks), so those fields stay "TODO"
 *    for manual entry.
 * 3. X (Twitter) is not scraped: there is no free API and the anti-scraping
 *    measures are strict. Check the official X accounts manually; the official
 *    News pages normally cover the important announcements.
 * 4. lovelive-anime.jp may answer 403 to automated clients. A failing source is
 *    reported and skipped, and the run still exits successfully so the
 *    scheduled GitHub Action is not spammed with red runs. Update the selectors
 *    (and possibly the headers) when the site markup changes.
 *
 * Usage:
 *   npm run scrape        Fetch, merge and write ../data.json
 *   npm run scrape:dry    Same but never writes (safe local test)
 *
 * De-duplication key: officialLink, plus the shared article number (01_xxxx) so
 * mirrors of the same story do not appear twice. Existing entries are never
 * modified, and
 * the cds array is never touched.
 */
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const fse = require('fs-extra');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_PATH = path.resolve(__dirname, '..', 'data.json');
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_ITEMS_PER_SOURCE = 40;
const DEFAULT_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 20000;

// A browser-like User-Agent is polite minimum for these official sites. It does
// not guarantee access: 403 / Cloudflare-style blocks are still possible.
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function cleanText(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

async function readConfig() {
  const config = await fse.readJson(CONFIG_PATH);
  if (!config || !Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error('config.json must contain a non-empty "sources" array.');
  }
  return config;
}

async function readData() {
  if (!(await fse.pathExists(DATA_PATH))) {
    console.warn('[WARN] ' + DATA_PATH + ' does not exist yet; it will be created.');
    return { cds: [], news: [] };
  }

  let data;
  try {
    data = await fse.readJson(DATA_PATH);
  } catch (error) {
    throw new Error('data.json is not valid JSON (' + error.message + '). Fix it manually; refusing to overwrite it.');
  }

  return Object.assign({}, data, {
    cds: Array.isArray(data.cds) ? data.cds : [],
    news: Array.isArray(data.news) ? data.news : []
  });
}

/**
 * Read text from the first matching child, falling back to the whole item.
 */
function readText($, element, selector) {
  const picked = selector ? $(element).find(selector).first() : null;
  if (picked && picked.length) return cleanText(picked.text());
  return cleanText($(element).text());
}

/**
 * Normalise common Japanese / ISO date strings to YYYY-MM-DD.
 * Returns "" when nothing trustworthy can be parsed.
 */
function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) return '';

  let match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) match = text.match(/(\d{4})\s+(\d{1,2})[-/.](\d{1,2})/);
  if (!match) match = text.match(/(\d{4})\u5e74\s*(\d{1,2})\u6708\s*(\d{1,2})\u65e5/);
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
  return year + '-' + pad2(month) + '-' + pad2(day);
}

/**
 * Turn a possibly relative href into an absolute http(s) URL.
 */
function resolveUrl(href, baseUrl) {
  if (!href || typeof href !== 'string') return '';
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(javascript|mailto|tel):/i.test(trimmed)) return '';
  try {
    const url = new URL(trimmed, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (error) {
    return '';
  }
}

/**
 * Stable id derived from the link, so re-running the scraper is idempotent.
 */
/**
 * Read a date from the selector. Some sites split the date into two <time>
 * elements (year + month-day), so prefer their datetime attributes.
 */
function readDate($, element, selector) {
  if (!selector) return '';
  const picked = $(element).find(selector).first();
  if (!picked.length) return '';

  const times = picked.find('time');
  if (times.length >= 2) {
    const year = cleanText(times.eq(0).attr('datetime'));
    const monthDay = cleanText(times.eq(1).attr('datetime'));
    const combined = normalizeDate(year + '-' + monthDay);
    if (combined) return combined;
  } else if (times.length === 1) {
    const single = normalizeDate(times.eq(0).attr('datetime'));
    if (single) return single;
  }

  return normalizeDate(picked.text());
}

/**
 * Same story can appear as /news/01_6863.html and as /nijigasaki/detail.php?p=01_6863.
 * The article number collapses those mirrors; otherwise fall back to the URL.
 */
function articleKey(url) {
  const match = /01_\d{3,}/.exec(url);
  return match ? match[0] : url;
}

/**
 * Optional per-item group mapping (used by the aggregate portal, where the
 * series is printed as a category label instead of being encoded in the URL).
 */
function resolveGroup($, element, source) {
  if (source.groupSelector && source.groupMap) {
    const label = cleanText($(element).find(source.groupSelector).first().text());
    if (label && source.groupMap[label]) return source.groupMap[label];
  }
  return source.group || 'All';
}

function buildId(officialLink) {
  const hash = crypto.createHash('sha1').update(officialLink).digest('hex').slice(0, 12);
  return 'scraped-' + hash;
}

/**
 * Build one news record from a matched item element.
 */
function buildEntry($, element, source, baseUrl) {
  const $el = $(element);
  const title = readText($, element, source.titleSelector);

  let href = source.linkSelector ? $el.find(source.linkSelector).first().attr('href') : $el.attr('href');
  if (!href && $el.is('a')) href = $el.attr('href');
  const officialLink = resolveUrl(href, baseUrl);

  if (!title || !officialLink) return null;

  return {
    id: buildId(officialLink),
    type: 'Uncategorized',
    title: title,
    date: readDate($, element, source.dateSelector),
    location: '',
    ticketInfo: 'TODO',
    specialOffer: 'TODO',
    description: '',
    imageUrl: '',
    officialLink: officialLink,
    group: resolveGroup($, element, source)
  };
}

/**
 * Fetch and parse a single source. Throws a descriptive error when the source
 * cannot be used, so main() can report it and continue.
 */
async function scrapeSource(source) {
  if (!source || typeof source !== 'object' || !source.url) {
    throw new Error('source is missing "url".');
  }

  const itemSelector = cleanText(source.itemSelector);
  if (!itemSelector) throw new Error('itemSelector is empty; tune config.json.');

  const response = await axios.get(source.url, {
    headers: REQUEST_HEADERS,
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    responseType: 'text'
  });

  const $ = cheerio.load(response.data);
  const nodes = $(itemSelector);
  if (!nodes.length) {
    throw new Error('itemSelector "' + itemSelector + '" matched 0 elements; inspect the page and update config.json.');
  }

  const baseUrl = source.baseUrl || source.url;
  const entries = [];
  nodes.slice(0, MAX_ITEMS_PER_SOURCE).each(function (index, element) {
    const entry = buildEntry($, element, source, baseUrl);
    if (entry) entries.push(entry);
  });

  return entries;
}
async function main() {
  const config = await readConfig();
  const data = await readData();

  const existingLinks = new Set();
  data.news.forEach(function (item) {
    if (item && typeof item.officialLink === 'string' && item.officialLink) {
      existingLinks.add(item.officialLink);
      existingLinks.add(articleKey(item.officialLink));
    }
  });

  const configuredDelay = Number(config.requestDelayMs);
  const delay = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : DEFAULT_DELAY_MS;
  const summary = [];
  let added = 0;
  let skipped = 0;
  let failed = 0;

  console.log('Scraping ' + config.sources.length + ' source(s)...');

  for (const source of config.sources) {
    const label = cleanText(source.name) || source.url || 'unnamed source';

    try {
      const entries = await scrapeSource(source);
      let addedHere = 0;

      entries.forEach(function (entry) {
        const key = articleKey(entry.officialLink);
        if (existingLinks.has(entry.officialLink) || existingLinks.has(key)) {
          skipped += 1;
          return;
        }
        existingLinks.add(entry.officialLink);
        existingLinks.add(key);
        data.news.push(entry);
        addedHere += 1;
      });

      added += addedHere;
      summary.push({ label: label, fetched: entries.length, added: addedHere, error: '' });
      console.log('[OK] ' + label + ': ' + entries.length + ' entry/entries read, ' + addedHere + ' new.');
    } catch (error) {
      failed += 1;
      summary.push({ label: label, fetched: 0, added: 0, error: error.message });
      console.warn('[WARN] ' + label + ': ' + error.message);
    }

    if (delay > 0) await sleep(delay);
  }

  if (DRY_RUN) {
    console.log('[dry-run] data.json was not modified.');
  } else if (added > 0) {
    await fse.outputJson(DATA_PATH, data, { spaces: 2, EOL: '\n' });
    console.log('Wrote ' + DATA_PATH);
  } else {
    console.log('No new items; data.json was left untouched.');
  }

  console.log('\nReport');
  summary.forEach(function (row) {
    if (row.error) {
      console.log('- ' + row.label + ': FAILED (' + row.error + ')');
    } else {
      console.log('- ' + row.label + ': ' + row.added + ' new / ' + row.fetched + ' read');
    }
  });
  console.log('Total news items in data.json: ' + data.news.length + ' (+' + added + ' this run, ' + skipped + ' duplicate(s) skipped)');
  console.log('Sources failed: ' + failed + '/' + config.sources.length + (DRY_RUN ? ' | dry-run' : ''));

  if (failed === config.sources.length) {
    console.warn('\nAll sources failed. The official sites may be blocking bots (403) or the selectors are stale. data.json was not changed in this case.');
  }
}

main().catch(function (error) {
  console.error('[fatal] ' + error.message);
  process.exitCode = 1;
});