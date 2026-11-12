
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

  // Default: highest market capitalization first.
  var sort = {
    key: 'marketCap',
    dir: -1
  };

  // Six columns in index.html.
  var cols = [
    'rank',
    'name',
    'price',
    'volume24h',
    'marketCap',
    'change24h'
  ];

  var heads = document.querySelectorAll('thead th');

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
      return {
        text: '0.00%',
        cls: 'flat'
      };
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

  function row(c) {
    var tr = document.createElement('tr');

    tr.appendChild(
      td('rank hide-sm', String(c.rank || '—'))
    );

    // Coin logo, name and symbol.
    var box = document.createElement('div');
    box.className = 'coin';

    if (c.image) {
      var img = document.createElement('img');

      img.src = c.image;
      img.alt = '';
      img.loading = 'lazy';

      img.onerror = function () {
        this.style.display = 'none';
      };

      box.appendChild(img);
    }

    var txt = document.createElement('div');

    var n = document.createElement('div');
    n.className = 'n';
    n.textContent = c.name;

    var s = document.createElement('div');
    s.className = 's';
    s.textContent = c.symbol;

    txt.appendChild(n);
    txt.appendChild(s);
    box.appendChild(txt);

    tr.appendChild(td('', box));

    // Price.
    c._p = td('num', fmtPrice(c.price));
    tr.appendChild(c._p);

    // 24-hour volume.
    c._v = td('num', fmtCompactUSD(c.volume24h));
    tr.appendChild(c._v);

    // Market capitalization.
    c._m = td('num', fmtCompactUSD(c.marketCap));
    tr.appendChild(c._m);

    // 24-hour change.
    var ch = change(c.change24h);

    c._c = td('num ' + ch.cls, ch.text);
    tr.appendChild(c._c);

    return tr;
  }

  // Loading and error messages.
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

  // Sort the displayed coins.
  function sortList(list) {
    var k = sort.key;
    var d = sort.dir;

    return list.slice().sort(function (a, b) {
      var x = a[k];
      var y = b[k];

      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;

      if (typeof x === 'string') {
        return x.localeCompare(String(y)) * d;
      }

      return (Number(x) - Number(y)) * d;
    });
  }

  // Update heading arrows and accessibility.
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

  // Render the market table.
  function render() {
    var q = search
      ? search.value.trim().toLowerCase()
      : '';

    var list = coins.filter(function (c) {
      return !q ||
        c.name.toLowerCase().includes(q) ||
        c.symbol.toLowerCase().includes(q);
    });

    list = sortList(list);

    if (!list.length) {
      if (coins.length) {
        message(
          'No results',
          'Try a different name or symbol.'
        );
      } else {
        message(
          'Data unavailable',
          'Market prices are temporarily unavailable. Please try again shortly.'
        );
      }

      return;
    }

    body.replaceChildren();

    list.forEach(function (c) {
      body.appendChild(row(c));
    });
  }

  // Enable sorting on all six headings.
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

  var h2 = document.querySelector('.section-head h2');

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
      ], {
        duration: 800
      });
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

  // Normalize the server market response.
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
      if (c.live) {
        old[c.symbol] = c;
      }
    });

    var updated = normalizeCoins(data);

    updated.forEach(function (c) {
      var previous = old[c.symbol];

      if (previous) {
        c.price = previous.price;
        c.change24h = previous.change24h;
        c.live = true;
      }
    });

    coins = updated;

    buildMap();
    render();
    connect();
  }

  // Load market data and show a friendly fallback.
  function load() {
    if (!coins.length) {
      message(
        'Loading markets',
        'Fetching the latest cryptocurrency prices...'
      );
    }

    fetch('/api/markets', {
      cache: 'no-store'
    })
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

  // Automatic copyright year.
  if (year) {
    year.textContent = new Date().getFullYear();
  }

  // Set market-cap sorting before the first render.
  markHeads();
  load();

  // Refresh server market data every 60 seconds.
  setInterval(function () {
    fetch('/api/markets', {
      cache: 'no-store'
    })
      .then(function (r) {
        if (!r.ok) {
          throw new Error('Market refresh failed: ' + r.status);
        }

        return r.json();
      })
      .then(setCoins)
      .catch(function (e) {
        console.warn('CoinWave market refresh:', e);

        // Keep existing successful data visible.
        // Show the error only when no data has ever loaded.
        if (!coins.length) {
          message(
            'Data unavailable',
            'Market prices are temporarily unavailable. Please try again shortly.'
          );
        }
      });
  }, 60000);

})();
