(function () {
  'use strict';

  var body = document.getElementById('rows');
  var search = document.getElementById('search');
  var year = document.getElementById('year');

  if (!body) {
    console.error('CoinWave: Missing element with id="rows".');
    return;
  }

  var coins = [];
  var activeFilter = 'all';
  var favorites = loadStorage('coinwave_favorites', []);
  var alerts = loadStorage('coinwave_alerts', []);

  if (!Array.isArray(favorites)) favorites = [];
  if (!Array.isArray(alerts)) alerts = [];

  var sort = {
    key: 'marketCap',
    dir: -1
  };

  var cols = [
    'rank',
    'name',
    'price',
    'volume24h',
    'marketCap',
    'change24h'
  ];

  var heads = document.querySelectorAll('#markets thead th');

  function loadStorage(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('CoinWave: Browser storage unavailable.');
    }
  }

  function number(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmtPrice(value) {
    var p = number(value);

    if (p === null) return '—';

    if (p >= 1) {
      return '$' + p.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }

    if (p >= 0.01) return '$' + p.toFixed(4);

    return '$' + p.toFixed(8).replace(/0+$/, '');
  }

  function fmtCompactUSD(value) {
    var n = number(value);

    if (n === null) return '—';

    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 2
    }).format(n);
  }

  function change(value) {
    var c = number(value);

    if (c === null || Math.abs(c) < 0.005) {
      return { text: '0.00%', cls: 'flat' };
    }

    var up = c > 0;

    return {
      text: (up ? '+' : '−') + Math.abs(c).toFixed(2) + '%',
      cls: up ? 'up' : 'down'
    };
  }

  function td(cls, child) {
    var el = document.createElement('td');

    if (cls) el.className = cls;

    if (typeof child === 'string') {
      el.textContent = child;
    } else if (child) {
      el.appendChild(child);
    }

    return el;
  }

  function isFavorite(symbol) {
    return favorites.indexOf(symbol) !== -1;
  }

  function toast(message) {
    var el = document.getElementById('cw-toast');

    if (!el) {
      el = document.createElement('div');
      el.id = 'cw-toast';
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.classList.add('show');

    clearTimeout(toast.timer);

    toast.timer = setTimeout(function () {
      el.classList.remove('show');
    }, 3200);
  }

  // Add styles for the interactive controls.
  function addStyles() {
    if (document.getElementById('cw-app-styles')) return;

    var style = document.createElement('style');
    style.id = 'cw-app-styles';

    style.textContent = `
      .cw-coin-actions {
        display:flex;
        align-items:center;
        gap:7px;
      }

      .cw-coin-name {
        padding:0;
        border:0;
        background:transparent;
        color:inherit;
        text-align:left;
        cursor:pointer;
        font:inherit;
      }

      .cw-coin-name:hover .n {
        color:#087cf0;
      }

      .cw-star,.cw-alert-btn {
        min-width:29px;
        height:29px;
        padding:0 6px;
        border:1px solid #e5eaf3;
        border-radius:8px;
        background:#fff;
        color:#8490a5;
        cursor:pointer;
        font-size:13px;
      }

      .cw-star.active {
        color:#d69b00;
        background:#fff8df;
        border-color:#ffe18a;
      }

      .cw-alert-btn:hover,.cw-star:hover {
        border-color:#087cf0;
        color:#087cf0;
      }

      .cw-filters {
        display:flex;
        flex-wrap:wrap;
        gap:8px;
        margin:0 0 16px;
      }

      .cw-filter {
        padding:9px 14px;
        border:1px solid #dce4f1;
        border-radius:10px;
        background:#fff;
        color:#64708a;
        font-size:12px;
        font-weight:700;
        cursor:pointer;
      }

      .cw-filter.active {
        color:#fff;
        border-color:#087cf0;
        background:#087cf0;
      }

      #cw-toast {
        position:fixed;
        z-index:9999;
        left:50%;
        bottom:25px;
        width:max-content;
        max-width:calc(100% - 30px);
        padding:13px 18px;
        border-radius:12px;
        color:#fff;
        background:#06133f;
        box-shadow:0 10px 35px #0003;
        font-size:13px;
        font-weight:600;
        opacity:0;
        visibility:hidden;
        transform:translate(-50%,15px);
        transition:.25s ease;
      }

      #cw-toast.show {
        opacity:1;
        visibility:visible;
        transform:translate(-50%,0);
      }

      .cw-alert-count {
        color:#087cf0;
        font-weight:700;
      }

      .cw-coin-name:focus-visible,
      .cw-star:focus-visible,
      .cw-alert-btn:focus-visible,
      .cw-filter:focus-visible {
        outline:3px solid #087cf055;
        outline-offset:2px;
      }

      @media(max-width:600px) {
        .cw-filters {
          overflow-x:auto;
          flex-wrap:nowrap;
          padding-bottom:5px;
        }

        .cw-filter {
          flex-shrink:0;
        }
      }
    `;

    document.head.appendChild(style);
  }

  // Add market filters without changing index.html.
  function createFilters() {
    var marketHead = document.querySelector('#markets .market-head');

    if (!marketHead || document.getElementById('cw-filters')) return;

    var filters = document.createElement('div');
    filters.id = 'cw-filters';
    filters.className = 'cw-filters';

    var options = [
      { id: 'all', label: 'All assets' },
      { id: 'gainers', label: 'Gainers' },
      { id: 'losers', label: 'Losers' },
      { id: 'favorites', label: '★ Watchlist' }
    ];

    options.forEach(function (option) {
      var button = document.createElement('button');

      button.type = 'button';
      button.className = 'cw-filter';
      button.dataset.filter = option.id;
      button.textContent = option.label;

      button.addEventListener('click', function () {
        activeFilter = option.id;
        updateFilters();
        render();
      });

      filters.appendChild(button);
    });

    marketHead.parentNode.insertBefore(
      filters,
      marketHead.nextSibling
    );

    updateFilters();
  }

  function updateFilters() {
    var buttons = document.querySelectorAll('.cw-filter');

    buttons.forEach(function (button) {
      button.classList.toggle(
        'active',
        button.dataset.filter === activeFilter
      );
    });
  }

  // Watchlist.
  function toggleFavorite(symbol) {
    if (isFavorite(symbol)) {
      favorites = favorites.filter(function (s) {
        return s !== symbol;
      });

      toast(symbol + ' removed from your watchlist.');
    } else {
      favorites.push(symbol);
      toast(symbol + ' added to your watchlist.');
    }

    saveStorage('coinwave_favorites', favorites);
    render();
  }

  // Price alerts.
  function setPriceAlert(coin) {
    var current = number(coin.price);

    if (current === null || current <= 0) {
      toast('Current coin price is unavailable.');
      return;
    }

    var answer = window.prompt(
      'Enter your target price in USD for ' +
      coin.name + '.\nCurrent price: ' + fmtPrice(current)
    );

    if (answer === null) return;

    var target = Number(answer);

    if (!Number.isFinite(target) || target <= 0) {
      toast('Please enter a valid positive price.');
      return;
    }

    if (!window.confirm(
      'Set an alert when ' + coin.symbol +
      ' reaches $' + target.toLocaleString('en-US') + '?'
    )) {
      return;
    }

    alerts.push({
      symbol: coin.symbol,
      name: coin.name,
      target: target,
      direction: target >= current ? 'above' : 'below',
      triggered: false,
      created: Date.now()
    });

    saveStorage('coinwave_alerts', alerts);

    toast('Price alert saved for ' + coin.symbol + '.');

    if ('Notification' in window &&
        Notification.permission === 'default') {
      Notification.requestPermission().catch(function () {});
    }
  }

  function checkAlerts(coin) {
    var price = number(coin.price);

    if (price === null) return;

    var changed = false;

    alerts.forEach(function (alert) {
      if (alert.triggered || alert.symbol !== coin.symbol) return;

      var reached =
        (alert.direction === 'above' && price >= alert.target) ||
        (alert.direction === 'below' && price <= alert.target);

      if (!reached) return;

      alert.triggered = true;
      changed = true;

      var messageText =
        coin.name + ' reached your target price of ' +
        fmtPrice(alert.target);

      toast(messageText);

      if ('Notification' in window &&
          Notification.permission === 'granted') {
        try {
          new Notification('CoinWave price alert', {
            body: messageText
          });
        } catch (e) {}
      }
    });

    if (changed) {
      saveStorage('coinwave_alerts', alerts);
    }
  }

  // Update TradingView chart when a coin is selected.
  function selectCoin(coin) {
    var frame = document.querySelector('.chart-frame');

    if (!frame) {
      toast(coin.name + ' selected.');
      return;
    }

    if (!/^[A-Z0-9]{2,15}$/.test(coin.symbol)) {
      toast('This coin does not have a supported chart symbol.');
      return;
    }

    var heading = document.querySelector('.chart-head h3');
    var tag = document.querySelector('#chart .section-title .chart-tag');

    var symbol = 'BINANCE:' + coin.symbol + 'USDT';

    frame.src =
      'https://s.tradingview.com/widgetembed/?symbol=' +
      encodeURIComponent(symbol) +
      '&interval=60&theme=dark&style=1&locale=en' +
      '&toolbarbg=06133f&enable_publishing=false' +
      '&hide_top_toolbar=false&hide_legend=false' +
      '&saveimage=false&calendar=false&hide_volume=false';

    if (heading) {
      heading.textContent = coin.name + ' / USDT';
    }

    if (tag) {
      tag.textContent = coin.symbol + ' / USDT';
    }

    var chart = document.getElementById('chart');

    if (chart) {
      chart.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  }

  // Build each market row.
  function row(c) {
    var tr = document.createElement('tr');

    tr.appendChild(
      td('rank hide-sm', String(c.rank || '—'))
    );

    var box = document.createElement('div');
    box.className = 'coin';

    if (c.image && /^https?:\/\//i.test(c.image)) {
      var img = document.createElement('img');

      img.src = c.image;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = function () {
        this.style.display = 'none';
      };

      box.appendChild(img);
    }

    var actions = document.createElement('div');
    actions.className = 'cw-coin-actions';

    var nameButton = document.createElement('button');
    nameButton.type = 'button';
    nameButton.className = 'cw-coin-name';
    nameButton.title = 'View ' + c.name + ' chart';

    var txt = document.createElement('div');

    var name = document.createElement('div');
    name.className = 'n';
    name.textContent = c.name;

    var symbol = document.createElement('div');
    symbol.className = 's';
    symbol.textContent = c.symbol;

    txt.appendChild(name);
    txt.appendChild(symbol);
    nameButton.appendChild(txt);

    nameButton.addEventListener('click', function () {
      selectCoin(c);
    });

    actions.appendChild(nameButton);

    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'cw-star' +
      (isFavorite(c.symbol) ? ' active' : '');

    star.textContent = isFavorite(c.symbol) ? '★' : '☆';
    star.title = isFavorite(c.symbol)
      ? 'Remove from watchlist'
      : 'Add to watchlist';

    star.setAttribute('aria-label', star.title);

    star.addEventListener('click', function () {
      toggleFavorite(c.symbol);
    });

    actions.appendChild(star);

    var alertButton = document.createElement('button');
    alertButton.type = 'button';
    alertButton.className = 'cw-alert-btn';
    alertButton.textContent = 'Alert';
    alertButton.title = 'Set a price alert';

    alertButton.addEventListener('click', function () {
      setPriceAlert(c);
    });

    actions.appendChild(alertButton);
    box.appendChild(actions);

    tr.appendChild(td('', box));

    c._p = td('num', fmtPrice(c.price));
    tr.appendChild(c._p);

    c._v = td('num', fmtCompactUSD(c.volume24h));
    tr.appendChild(c._v);

    c._m = td('num', fmtCompactUSD(c.marketCap));
    tr.appendChild(c._m);

    var ch = change(c.change24h);

    c._c = td('num ' + ch.cls, ch.text);
    tr.appendChild(c._c);

    return tr;
  }

  function message(title, text) {
    body.replaceChildren();

    var tr = document.createElement('tr');
    var cell = document.createElement('td');

    cell.colSpan = 6;
    cell.className = 'state';

    var strong = document.createElement('strong');
    strong.textContent = title;

    cell.appendChild(strong);
    cell.appendChild(document.createTextNode(' ' + text));

    tr.appendChild(cell);
    body.appendChild(tr);
  }

  function sortList(list) {
    var k = sort.key;
    var d = sort.dir;

    return list.slice().sort(function (a, b) {
      var x = a[k];
      var y = b[k];

      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;

      if (typeof x === 'string') {
        return x.localeCompare(String(y)) * d;
      }

      return (Number(x) - Number(y)) * d;
    });
  }

  function markHeads() {
    heads.forEach(function (th, i) {
      var label = th.getAttribute('data-label') ||
        th.textContent.replace(/[▲▼\s]+$/, '');

      th.setAttribute('data-label', label);

      th.textContent = label +
        (cols[i] === sort.key
          ? (sort.dir === 1 ? ' ▲' : ' ▼')
          : '');

      th.setAttribute(
        'aria-sort',
        cols[i] === sort.key
          ? (sort.dir === 1 ? 'ascending' : 'descending')
          : 'none'
      );

      th.tabIndex = 0;
      th.setAttribute('role', 'button');
    });
  }

  function render() {
    var q = search ? search.value.trim().toLowerCase() : '';

    var list = coins.filter(function (c) {
      var matchesSearch = !q ||
        c.name.toLowerCase().includes(q) ||
        c.symbol.toLowerCase().includes(q);

      var matchesFilter = true;

      if (activeFilter === 'gainers') {
        matchesFilter = number(c.change24h) > 0;
      } else if (activeFilter === 'losers') {
        matchesFilter = number(c.change24h) < 0;
      } else if (activeFilter === 'favorites') {
        matchesFilter = isFavorite(c.symbol);
      }

      return matchesSearch && matchesFilter;
    });

    list = sortList(list);

    if (!list.length) {
      if (!coins.length) {
        message(
          'Data unavailable',
          'Market prices are temporarily unavailable. Please try again shortly.'
        );
      } else if (activeFilter === 'favorites' && !favorites.length) {
        message(
          'Your watchlist is empty',
          'Tap the star beside a coin to add it to your watchlist.'
        );
      } else {
        message(
          'No results',
          'Try a different search or market filter.'
        );
      }

      return;
    }

    body.replaceChildren();

    list.forEach(function (c) {
      body.appendChild(row(c));
    });
  }

  // Sorting.
  heads.forEach(function (th, i) {
    function changeSort() {
      var k = cols[i];

      if (!k) return;

      if (sort.key === k) {
        sort.dir *= -1;
      } else {
        sort.key = k;
        sort.dir = (k === 'rank' || k === 'name') ? 1 : -1;
      }

      markHeads();
      render();
    }

    th.style.cursor = 'pointer';
    th.addEventListener('click', changeSort);

    th.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        changeSort();
      }
    });
  });

  // Live Binance price connection.
  var live = {
    ws: null,
    map: {},
    urls: [
      'wss://stream.binance.com:443/ws/!miniTicker@arr',
      'wss://data-stream.binance.vision/ws/!miniTicker@arr'
    ],
    i: 0,
    tries: 0,
    timer: null
  };

  var dot = document.createElement('span');

  dot.textContent = ' ● Live';
  dot.style.cssText =
    'display:none;margin-left:10px;font-size:13px;' +
    'font-weight:600;color:#22C55E;vertical-align:middle';

  var h2 = document.querySelector(
    '#markets h2'
  ) || document.querySelector('.section-head h2');

  if (h2) h2.appendChild(dot);

  function buildMap() {
    live.map = {};

    coins.forEach(function (c) {
      if (c.symbol) {
        live.map[c.symbol.toUpperCase()] = c;
      }
    });
  }

  function flash(el, up) {
    if (!el || typeof el.animate !== 'function') return;

    try {
      el.animate([
        {
          backgroundColor: up
            ? 'rgba(34,197,94,.28)'
            : 'rgba(239,68,68,.28)'
        },
        {
          backgroundColor: 'transparent'
        }
      ], { duration: 800 });
    } catch (e) {}
  }

  function applyTick(t) {
    if (!t || !t.s || !t.s.endsWith('USDT')) return;

    var symbol = t.s.slice(0, -4).toUpperCase();
    var c = live.map[symbol];

    if (!c) return;

    var p = number(t.c);
    var o = number(t.o);

    if (p === null || o === null || p <= 0 || o <= 0) return;

    var old = number(c.price);

    c.price = p;
    c.change24h = ((p - o) / o) * 100;
    c.live = true;

    if (c._p && c._p.isConnected) {
      c._p.textContent = fmtPrice(p);

      if (old !== null && p !== old) {
        flash(c._p, p > old);
      }

      var ch = change(c.change24h);

      c._c.textContent = ch.text;
      c._c.className = 'num ' + ch.cls;
    }

    checkAlerts(c);
  }

  function scheduleReconnect() {
    if (live.timer) return;

    live.i++;
    live.tries++;

    live.timer = setTimeout(function () {
      live.timer = null;
      connect();
    }, Math.min(30000, 2000 * live.tries));
  }

  function connect() {
    if (
      live.ws ||
      !coins.length ||
      typeof WebSocket === 'undefined'
    ) {
      return;
    }

    var ws;

    try {
      ws = new WebSocket(
        live.urls[live.i % live.urls.length]
      );
    } catch (e) {
      scheduleReconnect();
      return;
    }

    live.ws = ws;

    ws.onopen = function () {
      live.tries = 0;
    };

    ws.onmessage = function (ev) {
      var arr;

      try {
        arr = JSON.parse(ev.data);
      } catch (e) {
        return;
      }

      if (!Array.isArray(arr)) return;

      dot.style.display = 'inline';

      arr.forEach(applyTick);
    };

    ws.onclose = function () {
      if (live.ws !== ws) return;

      live.ws = null;
      dot.style.display = 'none';

      scheduleReconnect();
    };

    ws.onerror = function () {
      try {
        ws.close();
      } catch (e) {}
    };
  }

  function normalizeCoins(data) {
    if (!Array.isArray(data)) {
      if (data && Array.isArray(data.data)) {
        data = data.data;
      } else if (data && Array.isArray(data.markets)) {
        data = data.markets;
      } else {
        throw new Error('Invalid market data format');
      }
    }

    return data.map(function (c, i) {
      return {
        rank: number(c.rank) || i + 1,
        name: String(c.name || 'Unknown'),
        symbol: String(c.symbol || '').toUpperCase(),
        image: c.image || '',
        price: number(c.price),
        volume24h: number(c.volume24h),
        marketCap: number(c.marketCap),
        change24h: number(c.change24h)
      };
    }).filter(function (c) {
      return c.symbol.length > 0;
    });
  }

  function setCoins(data) {
    var old = {};

    coins.forEach(function (c) {
      if (c.live) old[c.symbol] = c;
    });

    var updated = normalizeCoins(data);

    updated.forEach(function (c) {
      var previous = old[c.symbol];

      if (previous) {
        c.price = previous.price;
        c.change24h = previous.change24h;
        c.live = true;
      }

      checkAlerts(c);
    });

    coins = updated;

    buildMap();
    render();
    connect();
  }

  function load() {
    if (!coins.length) {
      message(
        'Loading markets',
        'Fetching the latest cryptocurrency prices...'
      );
    }

    fetch('/api/markets', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) {
          throw new Error('Market request failed: ' + r.status);
        }

        return r.json();
      })
      .then(setCoins)
      .catch(function (e) {
        console.error('CoinWave market error:', e);

        if (!coins.length) {
          message(
            'Data unavailable',
            'Market prices are temporarily unavailable. Please try again shortly.'
          );
        }
      });
  }

  if (search) {
    search.addEventListener('input', render);
  }

  if (year) {
    year.textContent = new Date().getFullYear();
  }

  addStyles();
  createFilters();
  markHeads();
  load();

  // Refresh market data every minute.
  setInterval(function () {
    fetch('/api/markets', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) {
          throw new Error('Market refresh failed: ' + r.status);
        }

        return r.json();
      })
      .then(setCoins)
      .catch(function (e) {
        console.warn('CoinWave market refresh:', e);

        if (!coins.length) {
          message(
            'Data unavailable',
            'Market prices are temporarily unavailable. Please try again shortly.'
          );
        }
      });
  }, 60000);

})();
