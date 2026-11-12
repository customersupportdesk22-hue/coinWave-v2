(function () {
  'use strict';

  var body = document.getElementById('rows');
  var search = document.getElementById('search');
  var year = document.getElementById('year');
  var popularTarget = document.getElementById('popularAssets');
  var gainersTarget = document.getElementById('topGainers');
  var losersTarget = document.getElementById('topLosers');
  var updatedTarget = document.getElementById('marketUpdated');
  var featured = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TRX'];
  var cacheKey = 'coinwave.market.snapshot.v1';
  var coins = [];

  if (!body || !search) {
    console.error('CoinWave: market table elements were not found.');
    return;
  }

  function fmtPrice(p) {
    if (p == null || !Number.isFinite(Number(p))) return '—';
    p = Number(p);
    if (p >= 1) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 0.01) return '$' + p.toFixed(4);
    return '$' + p.toFixed(8).replace(/0+$/, '');
  }

  function change(c) {
    if (c == null || !Number.isFinite(Number(c)) || Math.abs(Number(c)) < 0.005) {
      return { text: '0.00%', cls: 'flat' };
    }
    c = Number(c);
    var up = c > 0;
    return { text: (up ? '+' : '−') + Math.abs(c).toFixed(2) + '%', cls: up ? 'up' : 'down' };
  }

  function td(cls, child) {
    var el = document.createElement('td');
    if (cls) el.className = cls;
    if (typeof child === 'string') el.textContent = child;
    else if (child) el.appendChild(child);
    return el;
  }

  function row(c) {
    var tr = document.createElement('tr');
    tr.appendChild(td('rank hide-sm', String(c.rank == null ? '—' : c.rank)));

    var box = document.createElement('div');
    box.className = 'coin';

    var img = document.createElement('img');
    img.src = c.image || '';
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = function () { img.style.visibility = 'hidden'; };

    var txt = document.createElement('div');
    var n = document.createElement('div');
    n.className = 'n';
    n.textContent = c.name || 'Unknown coin';

    var s = document.createElement('div');
    s.className = 's';
    s.textContent = (c.symbol || '').toUpperCase();

    txt.appendChild(n);
    txt.appendChild(s);
    box.appendChild(img);
    box.appendChild(txt);
    tr.appendChild(td('', box));

    c._p = td('num', fmtPrice(c.price));
    tr.appendChild(c._p);

    var ch = change(c.change24h);
    c._c = td('num ' + ch.cls, ch.text);
    tr.appendChild(c._c);

    // Make each market row open the matching asset details page.
    var symbol = String(c.symbol || '').toUpperCase();
    tr.classList.add('market-row');
    tr.tabIndex = 0;
    tr.setAttribute('role', 'link');
    tr.setAttribute('aria-label', 'Open ' + (c.name || symbol) + ' asset details');
    tr.addEventListener('click', function () {
      if (symbol) window.location.href = '/asset?symbol=' + encodeURIComponent(symbol);
    });
    tr.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (symbol) window.location.href = '/asset?symbol=' + encodeURIComponent(symbol);
      }
    });
    return tr;
  }

  function message(title, text) {
    body.innerHTML = '';
    var tr = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'state';

    var st = document.createElement('strong');
    st.textContent = title;
    cell.appendChild(st);
    cell.appendChild(document.createTextNode(text));
    tr.appendChild(cell);
    body.appendChild(tr);
  }

  var sort = { key: 'rank', dir: 1 };
  var cols = ['rank', 'name', 'price', 'change24h'];
  var heads = document.querySelectorAll('thead th');

  function sortList(list) {
    var k = sort.key;
    var d = sort.dir;
    return list.slice().sort(function (a, b) {
      var x = k === 'price' ? a.price : a[k];
      var y = k === 'price' ? b.price : b[k];
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return x.localeCompare(y) * d;
      return (Number(x) - Number(y)) * d;
    });
  }

  function markHeads() {
    heads.forEach(function (th, i) {
      var label = th.getAttribute('data-label') || th.textContent.replace(/[▲▼\s]+$/, '');
      th.setAttribute('data-label', label);
      th.textContent = label + (cols[i] === sort.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');
      th.setAttribute('aria-sort', cols[i] === sort.key
        ? (sort.dir === 1 ? 'ascending' : 'descending')
        : 'none');
      th.tabIndex = 0;
      th.setAttribute('role', 'button');
    });
  }

  function changeSort(i) {
    var k = cols[i];
    if (!k) return;
    if (sort.key === k) sort.dir = -sort.dir;
    else {
      sort.key = k;
      sort.dir = (k === 'rank' || k === 'name') ? 1 : -1;
    }
    markHeads();
    render();
  }

  heads.forEach(function (th, i) {
    th.style.cursor = 'pointer';
    th.addEventListener('click', function () { changeSort(i); });
    th.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        changeSort(i);
      }
    });
  });


  function money(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD',
      minimumFractionDigits: n >= 1 ? 2 : 4,
      maximumFractionDigits: n >= 1 ? 2 : 8
    }).format(n);
  }

  function makeAssetCard(c) {
    var symbol = String(c.symbol || '').toUpperCase();
    var link = document.createElement('a');
    link.className = 'asset-card';
    link.href = '/asset?symbol=' + encodeURIComponent(symbol);
    link.setAttribute('aria-label', 'View ' + (c.name || symbol) + ' details');
    var top = document.createElement('div');
    top.className = 'asset-top';
    var identity = document.createElement('div');
    identity.className = 'asset-id';
    if (c.image) {
      var img = document.createElement('img');
      img.src = c.image;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = function () {
        var fallback = document.createElement('span');
        fallback.className = 'asset-fallback';
        fallback.textContent = symbol.slice(0, 4);
        img.replaceWith(fallback);
      };
      identity.appendChild(img);
    } else {
      var fallback = document.createElement('span');
      fallback.className = 'asset-fallback';
      fallback.textContent = symbol.slice(0, 4);
      identity.appendChild(fallback);
    }
    var names = document.createElement('span');
    var name = document.createElement('span');
    name.className = 'asset-name';
    name.textContent = c.name || symbol;
    var ticker = document.createElement('span');
    ticker.className = 'asset-symbol';
    ticker.textContent = symbol;
    names.appendChild(name);
    names.appendChild(ticker);
    identity.appendChild(names);
    var arrow = document.createElement('span');
    arrow.className = 'asset-arrow';
    arrow.textContent = '↗';
    arrow.setAttribute('aria-hidden', 'true');
    top.appendChild(identity);
    top.appendChild(arrow);
    var price = document.createElement('span');
    price.className = 'asset-price';
    price.textContent = money(c.price);
    var value = Number(c.change24h);
    var changeEl = document.createElement('span');
    changeEl.className = 'asset-change ' + (!Number.isFinite(value) || value === 0 ? 'flat' : value > 0 ? 'up' : 'down');
    changeEl.textContent = Number.isFinite(value) ? (value > 0 ? '+' : '') + value.toFixed(2) + '% · 24h' : '24h change unavailable';
    var action = document.createElement('span');
    action.className = 'asset-action';
    action.textContent = 'Explore asset details →';
    link.append(top, price, changeEl, action);
    return link;
  }

  function renderPopular() {
    if (!popularTarget) return;
    var bySymbol = {};
    coins.forEach(function (c) { bySymbol[String(c.symbol || '').toUpperCase()] = c; });
    var selected = featured.map(function (s) { return bySymbol[s]; }).filter(Boolean);
    popularTarget.replaceChildren();
    if (!selected.length) {
      var empty = document.createElement('div');
      empty.className = 'asset-empty';
      empty.textContent = 'Popular asset information is temporarily unavailable.';
      popularTarget.appendChild(empty);
      return;
    }
    selected.forEach(function (c) { popularTarget.appendChild(makeAssetCard(c)); });
  }

  function renderMovers() {
    if (!gainersTarget || !losersTarget) return;
    var ranked = coins.filter(function (c) {
      return Number.isFinite(Number(c.change24h));
    });
    var gainers = ranked.filter(function (c) { return Number(c.change24h) > 0; })
      .sort(function (a, b) { return Number(b.change24h) - Number(a.change24h); }).slice(0, 5);
    var losers = ranked.filter(function (c) { return Number(c.change24h) < 0; })
      .sort(function (a, b) { return Number(a.change24h) - Number(b.change24h); }).slice(0, 5);

    function fill(target, list, direction) {
      target.replaceChildren();
      if (!list.length) {
        var empty = document.createElement('div');
        empty.className = 'asset-empty';
        empty.textContent = 'No ' + direction + ' available in the current market snapshot.';
        target.appendChild(empty);
        return;
      }
      list.forEach(function (c) {
        var symbol = String(c.symbol || '').toUpperCase();
        var link = document.createElement('a');
        link.className = 'mover-link';
        link.href = '/asset?symbol=' + encodeURIComponent(symbol);
        link.setAttribute('aria-label', 'View ' + (c.name || symbol) + ' market details');
        var identity = document.createElement('span');
        identity.className = 'mover-identity';
        if (c.image) {
          var img = document.createElement('img');
          img.src = c.image;
          img.alt = '';
          img.loading = 'lazy';
          img.onerror = function () {
            var fallback = document.createElement('span');
            fallback.className = 'mover-icon';
            fallback.textContent = symbol.slice(0, 3);
            img.replaceWith(fallback);
          };
          identity.appendChild(img);
        } else {
          var fallback = document.createElement('span');
          fallback.className = 'mover-icon';
          fallback.textContent = symbol.slice(0, 3);
          identity.appendChild(fallback);
        }
        var nameWrap = document.createElement('span');
        var name = document.createElement('span');
        name.className = 'mover-name';
        name.title = c.name || symbol;
        name.textContent = c.name || symbol;
        var ticker = document.createElement('span');
        ticker.className = 'mover-symbol';
        ticker.textContent = symbol;
        nameWrap.append(name, ticker);
        identity.appendChild(nameWrap);
        var price = document.createElement('span');
        price.className = 'mover-price';
        price.setAttribute('aria-label', 'Current price');
        price.textContent = money(c.price);
        var change = document.createElement('span');
        change.className = 'mover-change ' + (Number(c.change24h) >= 0 ? 'up' : 'down');
        change.textContent = (Number(c.change24h) > 0 ? '+' : '') + Number(c.change24h).toFixed(2) + '%';
        link.append(identity, price, change);
        target.appendChild(link);
      });
    }
    fill(gainersTarget, gainers, 'gainers');
    fill(losersTarget, losers, 'losers');
    if (updatedTarget) {
      updatedTarget.textContent = (live.lastTick ? 'Binance ticker updates · ' : 'Market snapshot · ') + new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    }
  }

  function renderAll() {
    render();
    renderPopular();
    renderMovers();
  }

  function saveSnapshot() {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), coins: coins }));
    } catch (e) {}
  }

  function restoreSnapshot() {
    try {
      var raw = sessionStorage.getItem(cacheKey);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      if (!saved || !Array.isArray(saved.coins) || !saved.coins.length) return false;
      if (Date.now() - Number(saved.savedAt || 0) > 10 * 60 * 1000) return false;
      coins = saved.coins;
      buildMap();
      renderAll();
      return true;
    } catch (e) {
      return false;
    }
  }

  function render() {
    var q = search.value.trim().toLowerCase();
    var list = coins.filter(function (c) {
      return !q ||
        String(c.name || '').toLowerCase().indexOf(q) > -1 ||
        String(c.symbol || '').toLowerCase().indexOf(q) > -1;
    });

    list = sortList(list);
    if (!list.length) {
      message(coins.length ? 'No results' : 'No market data', coins.length
        ? 'Try a different name or symbol.'
        : 'Market data has not loaded yet.');
      return;
    }

    body.innerHTML = '';
    list.forEach(function (c) { body.appendChild(row(c)); });
  }

  // Public Binance mini-ticker stream. The backend remains the source
  // for the initial market list and periodic refreshes.
  var live = {
    ws: null,
    map: {},
    urls: [
      'wss://stream.binance.com:443/ws/!miniTicker@arr',
      'wss://data-stream.binance.vision/ws/!miniTicker@arr'
    ],
    i: 0,
    tries: 0,
    lastTick: 0,
    reconnectTimer: null
  };

  var dot = document.createElement('span');
  dot.className = 'live-indicator';
  dot.textContent = '● Live';
  dot.setAttribute('role', 'status');
  dot.setAttribute('aria-live', 'polite');
  dot.hidden = true;

  var h2 = document.querySelector('.section-head h2');
  if (h2) h2.appendChild(dot);

  function buildMap() {
    live.map = {};
    coins.slice().sort(function (a, b) {
      return (Number(a.rank) || 999999) - (Number(b.rank) || 999999);
    }).forEach(function (c) {
      var symbol = String(c.symbol || '').toUpperCase();
      if (symbol && !live.map[symbol]) live.map[symbol] = c;
    });
  }

  function flash(el, up) {
    if (!el || !el.animate) return;
    el.animate([
      { backgroundColor: up ? 'rgba(22,167,101,.24)' : 'rgba(224,68,84,.24)' },
      { backgroundColor: 'rgba(0,0,0,0)' }
    ], { duration: 800 });
  }

  function applyTick(t) {
    if (!t || !t.s || t.s.slice(-4) !== 'USDT') return;
    var c = live.map[t.s.slice(0, -4)];
    if (!c) return;

    var p = parseFloat(t.c);
    var o = parseFloat(t.o);
    if (!(p > 0) || !(o > 0)) return;

    var old = c.price;
    c.price = p;
    c.change24h = (p - o) / o * 100;
    c.live = true;

    if (c._p && c._p.isConnected) {
      c._p.textContent = fmtPrice(p);
      if (old != null && p !== Number(old)) flash(c._p, p > Number(old));
      var ch = change(c.change24h);
      c._c.textContent = ch.text;
      c._c.className = 'num ' + ch.cls;
    }
  }

  function scheduleReconnect() {
    if (live.reconnectTimer) return;
    live.i++;
    live.tries++;
    live.reconnectTimer = setTimeout(function () {
      live.reconnectTimer = null;
      connect();
    }, Math.min(30000, 2000 * live.tries));
  }

  function connect() {
    if (live.ws || !coins.length || !('WebSocket' in window)) return;

    var ws;
    try {
      ws = new WebSocket(live.urls[live.i % live.urls.length]);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    live.ws = ws;

    ws.onopen = function () {
      // Connection is open; the Live label appears after the first valid tick.
    };

    ws.onmessage = function (ev) {
      var arr;
      try { arr = JSON.parse(ev.data); } catch (e) { return; }
      if (!Array.isArray(arr)) return;

      live.tries = 0;
      dot.hidden = false;
      var ticked = false;
      arr.forEach(function (tick) {
        var before = tick && tick.s && live.map[tick.s.slice(0, -4)];
        var prior = before ? before.price : null;
        applyTick(tick);
        if (before && before.price !== prior) ticked = true;
      });
      if (ticked) {
        live.lastTick = Date.now();
        renderMovers();
        renderPopular();
      }
    };

    ws.onclose = function () {
      if (live.ws !== ws) return;
      live.ws = null;
      dot.hidden = true;
      scheduleReconnect();
    };

    ws.onerror = function () {
      try { ws.close(); } catch (e) {}
    };
  }

  function setCoins(d) {
    if (!Array.isArray(d)) throw new Error('Unexpected market response');

    d = d.filter(function (c) {
      return c && typeof c === 'object' && c.symbol;
    }).map(function (c) {
      return Object.assign({}, c);
    });

    coins = d;
    buildMap();
    renderAll();
    saveSnapshot();
    connect();
  }

  function load() {
    fetch('/api/markets')
      .then(function (r) {
        if (!r.ok) throw new Error('Market request failed');
        return r.json();
      })
      .then(setCoins)
      .catch(function () {
        message('Prices are unavailable', 'Check your connection or try refreshing the page.');
      });
  }

  markHeads();
  search.addEventListener('input', render);
  if (year) year.textContent = new Date().getFullYear();
  load();

  // Refresh the market list every minute; live ticker updates prices between refreshes.
  setInterval(function () {
    fetch('/api/markets')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) setCoins(d); })
      .catch(function () {});
  }, 60000);
})();