/**
 * LoveLive! CD Collection + Auto-Synced Info - front-end logic
 * -------------------------------------------------------------
 * Role:
 *   Load data.json (or the inline file:// snapshot), render the CD checklist and
 *   the news/events board, apply combined filters + sorting, and persist the
 *   "owned" ticks in localStorage.
 *
 * Data contract:
 *   See data.json / README.md. Unknown fields are ignored. Bad single entries
 *   produce console warnings instead of breaking the whole page.
 *
 * localStorage:
 *   Key: lovelive-tracker.owned.v1 -> { "<cd id>": true|false }
 *   Only the ticks (overrides) are stored; everything else comes from data.json,
 *   so editing data.json never destroys your collection state.
 *
 * Extending:
 *   - Add a new group: extend GROUP_ORDER and the .group-* colour in styles.css.
 *   - Add a new news type: extend TYPE_ORDER and the .type-* colour in styles.css.
 *   - Filters are AND-combined; text matching is case-insensitive substring.
 */
(function () {
  'use strict';

  const DATA_URL = 'data.json';
  const OWNED_STORAGE_KEY = 'lovelive-tracker.owned.v1';
  const ALL = '__all__';
  const GROUP_ORDER = ["μ's", 'Aqours', 'Nijigasaki', 'Liella!', 'Hasunosora'];
  const TYPE_ORDER = ['CD Release', 'Merch', 'Popup/Collab Store', 'Live', 'Uncategorized'];
  const TYPE_CLASS = {
    'CD Release': 'type-cd',
    Merch: 'type-merch',
    'Popup/Collab Store': 'type-store',
    Live: 'type-live'
  };
  const GROUP_CLASS = {
    "μ's": 'group-mus',
    Aqours: 'group-aqours',
    Nijigasaki: 'group-nijigasaki',
    'Liella!': 'group-liella',
    Hasunosora: 'group-hasunosora',
    All: 'group-all'
  };
  const GROUP_INITIAL = {
    "μ's": 'μ',
    Aqours: 'A',
    Nijigasaki: 'N',
    'Liella!': 'L',
    Hasunosora: 'H',
    All: 'LL'
  };
  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

  const state = {
    cds: [],
    news: [],
    ownedOverrides: Object.create(null),
    dataSource: '',
    filters: {
      cdGroup: ALL,
      cdAlbum: '',
      cdSong: '',
      cdSort: 'date-desc',
      newsType: ALL,
      newsGroup: ALL,
      newsQuery: '',
      newsSort: 'upcoming',
      newsHidePast: false
    }
  };

  const els = {};

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    cacheElements();
    bindEvents();
    state.ownedOverrides = readOwnedOverrides();

    try {
      const loaded = await loadData();
      const normalized = normalizeData(loaded.raw);
      state.cds = normalized.cds;
      state.news = normalized.news;
      state.dataSource = loaded.source;
      applyOwnedOverrides();
      populateFilterOptions();
      setSourceBadge(loaded.source, normalized.warnings.length);
      renderAll();
    } catch (error) {
      console.error('[LoveLive] data loading failed:', error);
      showLoadError();
      renderAll();
    }

    if (els.loadedAt) {
      const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date());
      els.loadedAt.textContent = 'Loaded ' + time;
    }
  }

  function cacheElements() {
    els.sourceBadge = document.getElementById('source-badge');
    els.loadedAt = document.getElementById('loaded-at');
    els.loadError = document.getElementById('load-error');
    els.storageBanner = document.getElementById('storage-banner');
    els.cdGroup = document.getElementById('cd-group');
    els.cdAlbum = document.getElementById('cd-album');
    els.cdSong = document.getElementById('cd-song');
    els.cdSort = document.getElementById('cd-sort');
    els.cdReset = document.getElementById('cd-reset');
    els.cdGrid = document.getElementById('cd-grid');
    els.cdEmpty = document.getElementById('cd-empty');
    els.cdVisible = document.getElementById('cd-visible');
    els.ownedCounter = document.getElementById('owned-counter');
    els.ownedPercent = document.getElementById('owned-percent');
    els.ownedBar = document.getElementById('owned-bar');
    els.ownedProgress = document.getElementById('owned-progress');
    els.newsType = document.getElementById('news-type');
    els.newsGroup = document.getElementById('news-group');
    els.newsQuery = document.getElementById('news-query');
    els.newsSort = document.getElementById('news-sort');
    els.newsHidePast = document.getElementById('news-hide-past');
    els.newsReset = document.getElementById('news-reset');
    els.newsGrid = document.getElementById('news-grid');
    els.newsEmpty = document.getElementById('news-empty');
    els.newsVisible = document.getElementById('news-visible');
  }

  /* ------------------------------------------------------------------ *
   * Data loading + normalisation
   * ------------------------------------------------------------------ */

  async function loadData() {
    try {
      const response = await fetch(DATA_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return { raw: await response.json(), source: 'network' };
    } catch (networkError) {
      console.warn('[LoveLive] fetch(data.json) failed; trying the inline snapshot.', networkError);
      const node = document.getElementById('fallback-data');
      if (!node || !node.textContent.trim()) throw networkError;
      try {
        return { raw: JSON.parse(node.textContent), source: 'inline' };
      } catch (parseError) {
        console.error('[LoveLive] the inline snapshot is not valid JSON.', parseError);
        throw networkError;
      }
    }
  }

  function normalizeData(raw) {
    const warnings = [];
    const source = raw && typeof raw === 'object' ? raw : {};
    if (!Array.isArray(source.cds)) warnings.push('data.cds is missing or not an array.');
    if (!Array.isArray(source.news)) warnings.push('data.news is missing or not an array.');

    const cdIds = new Set();
    const newsIds = new Set();
    const cds = (Array.isArray(source.cds) ? source.cds : [])
      .map((item, index) => normalizeCd(item, index, warnings, cdIds))
      .filter(Boolean);
    const news = (Array.isArray(source.news) ? source.news : [])
      .map((item, index) => normalizeNews(item, index, warnings, newsIds))
      .filter(Boolean);

    if (warnings.length) console.warn('[LoveLive] data warnings (' + warnings.length + '):', warnings);
    return { cds: cds, news: news, warnings: warnings };
  }

  function normalizeCd(rawItem, index, warnings, seenIds) {
    const item = rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem) ? rawItem : {};
    let id = asText(item.id) || 'cd-' + (index + 1);
    if (seenIds.has(id)) {
      warnings.push('Duplicate cd id "' + id + '" replaced.');
      id = uniqueId(id, seenIds);
    }
    seenIds.add(id);

    const releaseDate = asText(item.releaseDate);
    if (releaseDate && !isValidDateKey(releaseDate)) {
      warnings.push('CD "' + id + '" has an invalid releaseDate; it will sort last.');
    }

    return {
      id: id,
      group: asText(item.group) || 'Unknown',
      artistOrUnit: asText(item.artistOrUnit),
      albumTitle: asText(item.albumTitle) || 'Untitled CD',
      releaseDate: isValidDateKey(releaseDate) ? releaseDate : '',
      songs: Array.isArray(item.songs) ? item.songs.map(asText).filter(Boolean) : [],
      specialOffer: asText(item.specialOffer),
      imageUrl: normalizeImageUrl(item.imageUrl),
      officialLink: safeHttpUrl(item.officialLink),
      owned: item.owned === true
    };
  }

  function normalizeNews(rawItem, index, warnings, seenIds) {
    const item = rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem) ? rawItem : {};
    let id = asText(item.id) || 'news-' + (index + 1);
    if (seenIds.has(id)) {
      warnings.push('Duplicate news id "' + id + '" replaced.');
      id = uniqueId(id, seenIds);
    }
    seenIds.add(id);

    const date = asText(item.date);
    if (date && !isValidDateKey(date)) {
      warnings.push('News "' + id + '" has an invalid date; it will show as Date TBD.');
    }

    return {
      id: id,
      type: asText(item.type) || 'Uncategorized',
      title: asText(item.title) || 'Untitled news item',
      date: isValidDateKey(date) ? date : '',
      location: asText(item.location),
      ticketInfo: asText(item.ticketInfo),
      specialOffer: asText(item.specialOffer),
      description: asText(item.description),
      imageUrl: normalizeImageUrl(item.imageUrl),
      officialLink: safeHttpUrl(item.officialLink),
      group: asText(item.group) || 'All'
    };
  }

  function uniqueId(base, seenIds) {
    let suffix = 2;
    while (seenIds.has(base + '-' + suffix)) suffix += 1;
    return base + '-' + suffix;
  }
  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function asText(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
  }

  function isValidDateKey(value) {
    const match = DATE_PATTERN.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
  }

  function safeHttpUrl(value) {
    const text = asText(value);
    if (!text) return '';
    try {
      const url = new URL(text, window.location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function normalizeImageUrl(value) {
    const text = asText(value);
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (/^(\.\/|\/)?assets\//i.test(text)) return text;
    return '';
  }

  function uniqueValues(values) {
    const seen = new Set();
    return values.filter(function (value) {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function groupSlug(group) {
    return GROUP_CLASS[group] || 'group-unknown';
  }

  function groupInitial(group) {
    return GROUP_INITIAL[group] || '★';
  }

  function typeClass(type) {
    return TYPE_CLASS[type] || 'type-other';
  }

  function isTodo(value) {
    return /^TODO\b/i.test(value);
  }

  /* ------------------------------------------------------------------ *
   * localStorage (owned ticks only)
   * ------------------------------------------------------------------ */

  function readOwnedOverrides() {
    try {
      const raw = window.localStorage.getItem(OWNED_STORAGE_KEY);
      if (!raw) return Object.create(null);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.create(null);
      const overrides = Object.create(null);
      Object.keys(parsed).forEach(function (key) {
        if (typeof parsed[key] === 'boolean') overrides[key] = parsed[key];
      });
      return overrides;
    } catch (error) {
      console.warn('[LoveLive] localStorage is unavailable; ticks will not persist.', error);
      showStorageBanner();
      return Object.create(null);
    }
  }

  function persistOwned() {
    try {
      window.localStorage.setItem(OWNED_STORAGE_KEY, JSON.stringify(state.ownedOverrides));
      return true;
    } catch (error) {
      console.warn('[LoveLive] could not save to localStorage.', error);
      showStorageBanner();
      return false;
    }
  }

  function showStorageBanner() {
    if (els.storageBanner) els.storageBanner.hidden = false;
  }

  function applyOwnedOverrides() {
    state.cds.forEach(function (cd) {
      if (Object.prototype.hasOwnProperty.call(state.ownedOverrides, cd.id)) {
        cd.owned = state.ownedOverrides[cd.id];
      }
    });
  }

  function toggleOwned(id, checked) {
    const cd = state.cds.find(function (item) { return item.id === id; });
    if (!cd) return;

    cd.owned = checked;
    state.ownedOverrides[id] = checked;
    persistOwned();

    const card = Array.prototype.find.call(els.cdGrid.children, function (node) {
      return node.dataset.cdId === id;
    });
    if (card) card.classList.toggle('is-owned', checked);

    if (state.filters.cdSort === 'owned-first' || state.filters.cdSort === 'owned-last') {
      renderCds();
    } else {
      updateCdCounters(els.cdGrid.querySelectorAll('.cd-card').length);
    }
  }

  /* ------------------------------------------------------------------ *
   * Dates
   * ------------------------------------------------------------------ */

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function todayKey() {
    const now = new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  function isPast(dateKey) {
    return Boolean(dateKey) && dateKey < todayKey();
  }

  function formatDate(dateKey) {
    if (!isValidDateKey(dateKey)) return 'Date TBD';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }).format(new Date(dateKey + 'T00:00:00'));
    } catch (error) {
      return dateKey;
    }
  }

  /* ------------------------------------------------------------------ *
   * Filter select population / status badges
   * ------------------------------------------------------------------ */

  function populateFilterOptions() {
    const groups = uniqueValues(GROUP_ORDER
      .concat(state.cds.map(function (cd) { return cd.group; }))
      .concat(state.news.map(function (item) { return item.group; })));
    const types = uniqueValues(TYPE_ORDER.concat(state.news.map(function (item) { return item.type; })));

    fillSelect(els.cdGroup, groups, 'All groups');
    fillSelect(els.newsGroup, groups, 'All groups');
    fillSelect(els.newsType, types, 'All types');
  }

  function fillSelect(select, values, allLabel) {
    if (!select) return;
    select.replaceChildren();
    select.append(new Option(allLabel, ALL));
    values.forEach(function (value) { select.append(new Option(value, value)); });
  }

  function setSourceBadge(source, warningCount) {
    if (!els.sourceBadge) return;
    if (source === 'network') {
      els.sourceBadge.textContent = 'Live data: data.json';
      els.sourceBadge.dataset.state = 'ok';
      els.sourceBadge.title = 'Data was fetched from data.json.';
    } else {
      els.sourceBadge.textContent = 'Inline snapshot (file:// mode)';
      els.sourceBadge.dataset.state = 'warn';
      els.sourceBadge.title = 'fetch() was blocked, so the embedded JSON snapshot is in use. Run node tools/sync-fallback.mjs after editing data.json.';
    }
    if (warningCount > 0) {
      els.sourceBadge.title += ' ' + warningCount + ' data warning(s); see the browser console.';
    }
  }

  function showLoadError() {
    if (els.loadError) els.loadError.hidden = false;
    if (els.sourceBadge) {
      els.sourceBadge.textContent = 'Data load failed';
      els.sourceBadge.dataset.state = 'error';
    }
  }
  /* ------------------------------------------------------------------ *
   * Filtering + sorting
   * ------------------------------------------------------------------ */

  function filterCds(cds, filters) {
    const album = filters.cdAlbum.trim().toLowerCase();
    const song = filters.cdSong.trim().toLowerCase();
    return cds.filter(function (cd) {
      if (filters.cdGroup !== ALL && cd.group !== filters.cdGroup) return false;
      if (album && cd.albumTitle.toLowerCase().indexOf(album) === -1) return false;
      if (song && !cd.songs.some(function (title) { return title.toLowerCase().indexOf(song) !== -1; })) return false;
      return true;
    });
  }

  function filterNews(news, filters) {
    const query = filters.newsQuery.trim().toLowerCase();
    return news.filter(function (item) {
      if (filters.newsType !== ALL && item.type !== filters.newsType) return false;
      if (filters.newsGroup !== ALL && item.group !== filters.newsGroup) return false;
      if (filters.newsHidePast && isPast(item.date)) return false;
      if (query) {
        const haystack = (item.title + ' ' + item.description).toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
      }
      return true;
    });
  }

  function compareByDate(aValue, bValue, direction) {
    const a = aValue || '';
    const b = bValue || '';
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
  }

  function groupRank(group) {
    const index = GROUP_ORDER.indexOf(group);
    return index === -1 ? GROUP_ORDER.length : index;
  }

  function sortCds(cds, sortMode) {
    const copy = cds.slice();
    copy.sort(function (a, b) {
      switch (sortMode) {
        case 'date-asc':
          return compareByDate(a.releaseDate, b.releaseDate, 'asc');
        case 'group':
          return groupRank(a.group) - groupRank(b.group) || compareByDate(a.releaseDate, b.releaseDate, 'desc');
        case 'owned-first':
          return Number(b.owned) - Number(a.owned) || compareByDate(a.releaseDate, b.releaseDate, 'desc');
        case 'owned-last':
          return Number(a.owned) - Number(b.owned) || compareByDate(a.releaseDate, b.releaseDate, 'desc');
        case 'date-desc':
        default:
          return compareByDate(a.releaseDate, b.releaseDate, 'desc');
      }
    });
    return copy;
  }

  function sortNews(news, sortMode) {
    const copy = news.slice();
    copy.sort(function (a, b) {
      if (sortMode === 'newest') return compareByDate(a.date, b.date, 'desc');

      const aPast = isPast(a.date);
      const bPast = isPast(b.date);
      if (aPast !== bPast) return aPast ? 1 : -1;
      if (!a.date && b.date) return 1;
      if (a.date && !b.date) return -1;
      if (!a.date && !b.date) return a.title.localeCompare(b.title);
      return aPast ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
    });
    return copy;
  }

  /* ------------------------------------------------------------------ *
   * Counters
   * ------------------------------------------------------------------ */

  function updateCdCounters(visibleCount) {
    const total = state.cds.length;
    const owned = state.cds.filter(function (cd) { return cd.owned; }).length;
    const percent = total ? Math.round((owned / total) * 100) : 0;

    if (els.ownedCounter) els.ownedCounter.textContent = owned + ' of ' + total + ' CDs owned';
    if (els.ownedPercent) els.ownedPercent.textContent = percent + '%';
    if (els.ownedBar) els.ownedBar.style.width = percent + '%';
    if (els.ownedProgress) {
      els.ownedProgress.setAttribute('aria-valuemax', String(total));
      els.ownedProgress.setAttribute('aria-valuenow', String(owned));
      els.ownedProgress.setAttribute('aria-valuetext', owned + ' of ' + total + ' CDs owned');
    }
    if (els.cdVisible) els.cdVisible.textContent = 'Showing ' + visibleCount + ' of ' + total + ' CDs';
  }

  function updateNewsCount(visibleCount) {
    if (els.newsVisible) els.newsVisible.textContent = 'Showing ' + visibleCount + ' of ' + state.news.length + ' events';
  }

  function renderAll() {
    renderCds();
    renderNews();
  }

  /* ------------------------------------------------------------------ *
   * CD checklist rendering
   * ------------------------------------------------------------------ */

  function renderCds() {
    if (!els.cdGrid) return;
    const filtered = sortCds(filterCds(state.cds, state.filters), state.filters.cdSort);
    const fragment = document.createDocumentFragment();
    filtered.forEach(function (cd) { fragment.append(createCdCard(cd)); });
    els.cdGrid.replaceChildren(fragment);

    if (els.cdEmpty) {
      els.cdEmpty.hidden = filtered.length > 0;
      els.cdEmpty.textContent = state.cds.length
        ? 'No CDs match these filters yet.'
        : 'No CDs in data.json yet. Add entries to the "cds" array.';
    }
    updateCdCounters(filtered.length);
  }

  function createCdCard(cd) {
    const card = el('article', {
      class: 'card cd-card' + (cd.owned ? ' is-owned' : ''),
      dataset: { cdId: cd.id }
    });

    card.append(createCover(cd.imageUrl, cd.albumTitle, cd.group, 'square'));

    const body = el('div', { class: 'card-body' });
    const top = el('div', { class: 'card-top' });
    const tags = el('div', { class: 'tags' });
    tags.append(createGroupTag(cd.group));
    if (cd.artistOrUnit && cd.artistOrUnit !== cd.group) {
      tags.append(el('span', { class: 'tag tag--unit', text: cd.artistOrUnit }));
    }

    const ownLabel = el('label', { class: 'own-toggle', title: 'Mark "' + cd.albumTitle + '" as owned' });
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = cd.owned;
    checkbox.dataset.cdId = cd.id;
    checkbox.setAttribute('aria-label', 'Owned: ' + cd.albumTitle);
    ownLabel.append(checkbox, el('span', { text: 'Owned' }));

    top.append(tags, ownLabel);
    body.append(top);
    body.append(el('h3', { class: 'card-title', text: cd.albumTitle }));
    body.append(el('p', {
      class: 'meta' + (cd.releaseDate ? '' : ' is-todo'),
      text: cd.releaseDate ? 'Released ' + formatDate(cd.releaseDate) : 'Release date TODO'
    }));

    if (cd.songs.length) {
      const list = el('ul', { class: 'song-list' });
      cd.songs.forEach(function (song) {
        list.append(el('li', { text: song }));
      });
      body.append(list);
    } else {
      body.append(el('p', { class: 'meta is-todo', text: 'Track list TODO' }));
    }

    const offer = el('div', { class: 'offer' });
    offer.append(el('span', { class: 'offer-label', text: 'Special offer' }));
    offer.append(el('p', {
      class: 'offer-text' + (isTodo(cd.specialOffer) ? ' is-todo' : ''),
      text: cd.specialOffer || 'TODO: add store / pre-order bonus details.'
    }));
    body.append(offer);

    const actions = el('div', { class: 'card-actions' });
    if (cd.officialLink) {
      actions.append(el('a', {
        class: 'btn btn--ghost',
        href: cd.officialLink,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'Official page ↗'
      }));
    } else {
      actions.append(el('span', { class: 'link-todo', text: 'Official link TODO' }));
    }
    actions.append(el('span', { class: 'meta small', text: cd.group }));
    body.append(actions);

    card.append(body);
    return card;
  }
  /* ------------------------------------------------------------------ *
   * News board rendering
   * ------------------------------------------------------------------ */

  function renderNews() {
    if (!els.newsGrid) return;
    const filtered = sortNews(filterNews(state.news, state.filters), state.filters.newsSort);
    const fragment = document.createDocumentFragment();
    filtered.forEach(function (item) { fragment.append(createNewsCard(item)); });
    els.newsGrid.replaceChildren(fragment);

    if (els.newsEmpty) {
      els.newsEmpty.hidden = filtered.length > 0;
      els.newsEmpty.textContent = state.news.length
        ? 'No news matches these filters yet.'
        : 'No news in data.json yet. Run the scraper or add entries to the "news" array.';
    }
    updateNewsCount(filtered.length);
  }

  function createNewsCard(item) {
    const past = isPast(item.date);
    const card = el('article', { class: 'card news-card' + (past ? ' is-past' : '') });
    card.append(createCover(item.imageUrl, item.title, item.group, 'wide'));

    const body = el('div', { class: 'card-body' });
    const tags = el('div', { class: 'tags' });
    tags.append(el('span', { class: 'tag ' + typeClass(item.type), text: item.type }));
    tags.append(createGroupTag(item.group));
    if (past) tags.append(el('span', { class: 'tag tag--past', text: 'Ended' }));
    body.append(tags);

    body.append(el('h3', { class: 'card-title', text: item.title }));
    body.append(el('p', {
      class: 'date-line' + (item.date ? '' : ' is-todo'),
      text: item.date ? formatDate(item.date) : 'Date TBD'
    }));

    if (item.location && item.location !== 'N/A') {
      const locationLine = el('p', { class: 'info-line' });
      locationLine.append(el('strong', { text: 'Location ' }));
      locationLine.append(el('span', {
        class: isTodo(item.location) ? 'is-todo' : '',
        text: item.location
      }));
      body.append(locationLine);
    }

    if (item.description) {
      body.append(el('p', { class: 'description', text: item.description }));
    }

    if (item.ticketInfo && item.ticketInfo !== 'N/A' && !isTodo(item.ticketInfo)) {
      const ticketLine = el('p', { class: 'info-line' });
      ticketLine.append(el('strong', { text: 'Tickets ' }));
      ticketLine.append(el('span', {
        class: isTodo(item.ticketInfo || 'TODO') ? 'is-todo' : '',
        text: item.ticketInfo || 'TODO: add lottery / general-sale details.'
      }));
      body.append(ticketLine);
    }

    if (item.specialOffer && !isTodo(item.specialOffer)) {
      const offer = el('div', { class: 'offer' });
      offer.append(el('span', { class: 'offer-label', text: 'Special offer' }));
      offer.append(el('p', { class: 'offer-text', text: item.specialOffer }));
      body.append(offer);
    }

    const actions = el('div', { class: 'card-actions' });
    if (item.officialLink) {
      actions.append(el('a', {
        class: 'btn btn--primary',
        href: item.officialLink,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': 'View details for ' + item.title + ' (opens in a new tab)',
        text: 'View Details ↗'
      }));
    } else {
      actions.append(el('span', { class: 'link-todo', text: 'Official link TODO' }));
    }
    body.append(actions);

    card.append(body);
    return card;
  }

  /* ------------------------------------------------------------------ *
   * Shared DOM helpers
   * ------------------------------------------------------------------ */

  function createCover(imageUrl, title, group, shape) {
    const wrap = el('div', { class: 'cover cover--' + shape + ' ' + groupSlug(group) });
    wrap.append(el('span', { class: 'cover-fallback', 'aria-hidden': 'true', text: groupInitial(group) }));

    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = title + ' artwork';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () { img.remove(); });
      wrap.append(img);
    }
    return wrap;
  }

  function createGroupTag(group) {
    return el('span', { class: 'tag tag--group ' + groupSlug(group), text: group });
  }

  function el(tag, props) {
    const node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        const value = props[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'checked') node.checked = Boolean(value);
        else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    Array.prototype.slice.call(arguments, 2).forEach(function append(child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) { child.forEach(append); return; }
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  function bindEvents() {
    els.cdGroup.addEventListener('change', function () {
      state.filters.cdGroup = els.cdGroup.value;
      renderCds();
    });
    els.cdAlbum.addEventListener('input', debounce(function () {
      state.filters.cdAlbum = els.cdAlbum.value;
      renderCds();
    }, 120));
    els.cdSong.addEventListener('input', debounce(function () {
      state.filters.cdSong = els.cdSong.value;
      renderCds();
    }, 120));
    els.cdSort.addEventListener('change', function () {
      state.filters.cdSort = els.cdSort.value;
      renderCds();
    });
    els.cdReset.addEventListener('click', resetCdFilters);
    els.cdGrid.addEventListener('change', function (event) {
      const input = event.target.closest('input[type="checkbox"][data-cd-id]');
      if (!input) return;
      toggleOwned(input.dataset.cdId, input.checked);
    });

    els.newsType.addEventListener('change', function () {
      state.filters.newsType = els.newsType.value;
      renderNews();
    });
    els.newsGroup.addEventListener('change', function () {
      state.filters.newsGroup = els.newsGroup.value;
      renderNews();
    });
    els.newsQuery.addEventListener('input', debounce(function () {
      state.filters.newsQuery = els.newsQuery.value;
      renderNews();
    }, 120));
    els.newsSort.addEventListener('change', function () {
      state.filters.newsSort = els.newsSort.value;
      renderNews();
    });
    els.newsHidePast.addEventListener('change', function () {
      state.filters.newsHidePast = els.newsHidePast.checked;
      renderNews();
    });
    els.newsReset.addEventListener('click', resetNewsFilters);
  }

  function resetCdFilters() {
    state.filters.cdGroup = ALL;
    state.filters.cdAlbum = '';
    state.filters.cdSong = '';
    state.filters.cdSort = 'date-desc';
    els.cdGroup.value = ALL;
    els.cdAlbum.value = '';
    els.cdSong.value = '';
    els.cdSort.value = 'date-desc';
    renderCds();
  }

  function resetNewsFilters() {
    state.filters.newsType = ALL;
    state.filters.newsGroup = ALL;
    state.filters.newsQuery = '';
    state.filters.newsSort = 'upcoming';
    state.filters.newsHidePast = false;
    els.newsType.value = ALL;
    els.newsGroup.value = ALL;
    els.newsQuery.value = '';
    els.newsSort.value = 'upcoming';
    els.newsHidePast.checked = false;
    renderNews();
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }
})();