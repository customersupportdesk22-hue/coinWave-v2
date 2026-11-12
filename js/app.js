
(function () {
  'use strict';

  var body = document.getElementById('rows');
  var search = document.getElementById('search');
  var year = document.getElementById('year');
  var coins = [];
  var refreshTimer = null;

  if (!body || !search) {
    console.error('CoinWave: market table elements were not found.');
    return;
  }

  var assetSymbols = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TRX'];

  function number(value) {
    var n = Number(value);
    return value == null || value === '' || !Number.isFinite(n) ? null : n;
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

  function fmtCompact(value) {
    var n = number(value);
    if (n === null) return '—';
    if (Math.abs(n) >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
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

  function td(cls, content) {
    var el = document.createElement('td');
    if (cls) el.className = cls;
    if (typeof content === 'string') el.textContent = content;
    else if (content) el.appendChild(content);
    return el;
  }

  function row(coin) {
    var tr = document.createElement('tr');
    tr.appendChild(td('rank hide-sm', String(coin.rank == null ? '—' : coin.rank)));

    var box = document.createElement('div');
    box.className = 'coin';

    var img = document.createElement('img');
    img.src = coin.image || '';
    img.alt = (coin.name || 'Coin') + ' logo';
    img.loading = 'lazy';
    img.onerror = function () {
      img.style.visibility = 'hidden';
    };

    var txt = document.createElement('div');
    var name = document.createElement('div');
    name.className = 'n';
    name.textContent = coin.name || 'Unknown coin';

    var symbol = document.createElement('div');
    symbol.className = 's';
    symbol.textContent = String(coin.symbol || '').toUpperCase();

    txt.appendChild(name);
    txt.appendChild(symbol);
    box.appendChild(img);
    box.appendChild(txt);

    var assetCell = td('', box);
    assetCell.classList.add('asset-name-cell');
    tr.appendChild(assetCell);

    coin._p = td('num', fmtPrice(coin.price));
    tr.appendChild(coin._p);

    var ch = change(coin.change24h);
    coin._c = td('num ' + ch.cls, ch.text);
    tr.appendChild(coin._c);

    coin._v = td('num', fmtCompact(coin.volume24h));
    tr.appendChild(coin._v);

    coin._m = td('num', fmtCompact(coin.marketCap));
    tr.appendChild(coin._m);

    tr.setAttribute('data-asset-symbol', String(coin.symbol || '').toUpperCase());
    tr.tabIndex = 0;
    tr.style.cursor = 'pointer';

    tr.addEventListener('click', function () {
      openAsset(coin.symbol);
    });

    tr.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') openAsset(coin.symbol);
    });

    return tr;
  }

  function message(title, description) {
    body.innerHTML = '';

    var tr = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'state';

    var strong = document.createElement('strong');
    strong.textContent = title;

    cell.appendChild(strong);
    cell.appendChild(document.createTextNode(description));
    tr.appendChild(cell);
    body.appendChild(tr);
  }

  var sort = { key: 'rank', dir: 1 };
  var columns = ['rank', 'name', 'price', 'change24h', 'volume24h', 'marketCap'];
  var heads = document.querySelectorAll('thead th');

  function sortList(list) {
    var key = sort.key;
    var direction = sort.dir;

    return list.slice().sort(function (a, b) {
      var x = a[key];
      var y = b[key];

      if (x == null) return 1;
      if (y == null) return -1;

      if (typeof x === 'string') {
        return x.localeCompare(y) * direction;
      }

      return (Number(x) - Number(y)) * direction;
    });
  }

  function markHeads() {
    heads.forEach(function (th, index) {
      var label = th.getAttribute('data-label') ||
        th.textContent.replace(/[▲▼\s]+$/, '');

      th.setAttribute('data-label', label);
      th.textContent = label +
        (columns[index] === sort.key
          ? (sort.dir === 1 ? ' ▲' : ' ▼')
          : '');

      th.setAttribute(
        'aria-sort',
        columns[index] === sort.key
          ? (sort.dir === 1 ? 'ascending' : 'descending')
          : 'none'
      );

      th.tabIndex = 0;
      th.setAttribute('role', 'button');
      th.style.cursor = 'pointer';
    });
  }

  function changeSort(index) {
    var key = columns[index];
    if (!key) return;

    if (sort.key === key) {
      sort.dir *= -1;
    } else {
      sort.key = key;
      sort.dir = (key === 'rank' || key === 'name') ? 1 : -1;
    }

    markHeads();
    render();
  }

  heads.forEach(function (th, index) {
    th.addEventListener('click', function () {
      changeSort(index);
    });

    th.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        changeSort(index);
      }
    });
  });

  function render() {
    var query = search.value.trim().toLowerCase();

    var list = coins.filter(function (coin) {
      return !query ||
        String(coin.name || '').toLowerCase().includes(query) ||
        String(coin.symbol || '').toLowerCase().includes(query);
    });

    list = sortList(list);

    if (!list.length) {
      message(
        coins.length ? 'No results found' : 'No market data',
        coins.length
          ? 'Try another asset name or symbol.'
          : 'Market data has not loaded yet.'
      );
      return;
    }

    body.innerHTML = '';
    list.forEach(function (coin) {
      body.appendChild(row(coin));
    });
  }

  // --------------------------------------------------
  // ASSET DETAILS AND CUSTOMER ACTIONS
  // --------------------------------------------------

  var modal = null;

  function createModal() {
    if (modal) return modal;

    var style = document.createElement('style');
    style.textContent = `
      .cw-modal-backdrop {
        position:fixed; inset:0; z-index:99999;
        background:rgba(5,13,32,.72);
        display:flex; align-items:center; justify-content:center;
        padding:18px; overflow-y:auto;
      }
      .cw-modal {
        width:100%; max-width:440px; background:#fff;
        color:#101a35; border-radius:18px; padding:22px;
        box-shadow:0 20px 70px rgba(0,0,0,.3);
        position:relative; font-family:inherit;
      }
      .cw-modal-close {
        position:absolute; right:15px; top:12px;
        border:0; background:#edf2fa; border-radius:50%;
        width:34px; height:34px; font-size:21px; cursor:pointer;
      }
      .cw-modal-heading {display:flex;align-items:center;gap:12px;margin:12px 0 20px}
      .cw-modal-heading img {width:42px;height:42px;object-fit:contain}
      .cw-modal-heading h3 {margin:0;font-size:20px}
      .cw-modal-heading small {color:#68758f}
      .cw-modal-stats {display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .cw-modal-stat {background:#f2f6fc;border-radius:11px;padding:13px}
      .cw-modal-stat span {display:block;color:#68758f;font-size:12px;margin-bottom:6px}
      .cw-modal-stat strong {font-size:15px;overflow-wrap:anywhere}
      .cw-modal-actions {display:flex;gap:10px;margin-top:20px}
      .cw-modal-actions a {
        flex:1;text-align:center;text-decoration:none;padding:13px 8px;
        border-radius:10px;font-weight:700;color:#fff;background:#087cf0;
      }
      .cw-modal-actions a.sell {background:#14213d}
      .cw-modal-change.up {color:#16a765}
      .cw-modal-change.down {color:#df4454}
    `;
    document.head.appendChild(style);

    modal = document.createElement('div');
    modal.className = 'cw-modal-backdrop';
    modal.hidden = true;
    modal.setAttribute('role', 'presentation');

    modal.innerHTML = `
      <section class="cw-modal" role="dialog" aria-modal="true"
        aria-labelledby="cw-modal-title">
        <button type="button" class="cw-modal-close"
          aria-label="Close asset details">&times;</button>
        <div class="cw-modal-heading">
          <img id="cw-asset-image" alt="">
          <div>
            <h3 id="cw-modal-title">Asset</h3>
            <small id="cw-asset-symbol"></small>
          </div>
        </div>
        <div class="cw-modal-stats">
          <div class="cw-modal-stat"><span>Current price</span><strong id="cw-asset-price">—</strong></div>
          <div class="cw-modal-stat"><span>24h change</span><strong id="cw-asset-change">—</strong></div>
          <div class="cw-modal-stat"><span>24h volume</span><strong id="cw-asset-volume">—</strong></div>
          <div class="cw-modal-stat"><span>Market cap</span><strong id="cw-asset-cap">—</strong></div>
          <div class="cw-modal-stat"><span>Market rank</span><strong id="cw-asset-rank">—</strong></div>
        </div>
        <div class="cw-modal-actions">
          <a id="cw-buy-link" href="/login?side=buy">Buy</a>
          <a id="cw-sell-link" class="sell" href="/login?side=sell">Sell</a>
        </div>
      </section>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.cw-modal-close').addEventListener('click', closeAsset);

    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeAsset();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modal.hidden) closeAsset();
    });

    return modal;
  }

  function openAsset(symbol) {
    symbol = String(symbol || '').toUpperCase();
    var coin = coins.find(function (item) {
      return String(item.symbol || '').toUpperCase() === symbol;
    });

    if (!coin) {
      coin = {
        symbol: symbol,
        name: symbol,
        price: null,
        change24h: null,
        volume24h: null,
        marketCap: null,
        rank: null
      };
    }

    createModal();

    document.getElementById('cw-modal-title').textContent = coin.name || symbol;
    document.getElementById('cw-asset-symbol').textContent = symbol;

    var image = document.getElementById('cw-asset-image');
    image.src = coin.image || '';
    image.alt = (coin.name || symbol) + ' logo';
    image.hidden = !coin.image;

    document.getElementById('cw-asset-price').textContent = fmtPrice(coin.price);

    var changeValue = change(coin.change24h);
    var changeEl = document.getElementById('cw-asset-change');
    changeEl.textContent = changeValue.text;
    changeEl.className = 'cw-modal-change ' + changeValue.cls;

    document.getElementById('cw-asset-volume').textContent = fmtCompact(coin.volume24h);
    document.getElementById('cw-asset-cap').textContent = fmtCompact(coin.marketCap);
    document.getElementById('cw-asset-rank').textContent =
      coin.rank == null ? '—' : '#' + coin.rank;

    document.getElementById('cw-buy-link').href =
      '/login?asset=' + encodeURIComponent(symbol) + '&side=buy';

    document.getElementById('cw-sell-link').href =
      '/login?asset=' + encodeURIComponent(symbol) + '&side=sell';

    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeAsset() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  // Bind popular asset cards and buttons already present in the homepage.
  document.querySelectorAll(
    '.asset-card, .popular-asset, [data-asset-symbol], [data-asset]'
  ).forEach(function (element) {
    if (element.closest('tr')) return;

    var symbol = element.getAttribute('data-asset-symbol') ||
      element.getAttribute('data-asset');

    if (!symbol) {
      var symbolNode = element.querySelector(
        '[data-symbol], .asset-symbol, .symbol'
      );
      if (symbolNode) symbol = symbolNode.textContent;
    }

    if (!symbol) return;

    symbol = symbol.trim().toUpperCase();
    if (!assetSymbols.includes(symbol)) return;

    element.style.cursor = 'pointer';

    element.addEventListener('click', function (event) {
      if (event.target.closest('a')) return;
      if (event.target.closest('button')) {
        event.preventDefault();
      }
      openAsset(symbol);
    });
  });

  // --------------------------------------------------
  // LIVE MARKET DATA
  // --------------------------------------------------

  var live = {
    ws: null,
    map: {},
    urls: [
      'wss://stream.binance.com:443/ws/!miniTicker@arr',
      'wss://data-stream.binance.vision/ws/!miniTicker@arr'
    ],
    index: 0,
    tries: 0,
    reconnectTimer: null
  };

  var liveDot = document.createElement('span');
  liveDot.className = 'live-indicator';
  liveDot.textContent = ' ● Live';
  liveDot.setAttribute('role', 'status');
  liveDot.setAttribute('aria-live', 'polite');
  liveDot.hidden = true;

  var heading = document.querySelector('.section-head h2');
  if (heading) heading.appendChild(liveDot);

  function buildMap() {
    live.map = {};

    coins.slice().sort(function (a, b) {
      return (Number(a.rank) || 999999) - (Number(b.rank) || 999999);
    }).forEach(function (coin) {
      var symbol = String(coin.symbol || '').toUpperCase();
      if (symbol && !live.map[symbol]) live.map[symbol] = coin;
    });
  }

  function flash(element, up) {
    if (!element || !element.animate) return;

    element.animate([
      { backgroundColor: up ? 'rgba(22,167,101,.24)' : 'rgba(224,68,84,.24)' },
      { backgroundColor: 'rgba(0,0,0,0)' }
    ], { duration: 800 });
  }

  function applyTick(tick) {
    if (!tick || !tick.s || tick.s.slice(-4) !== 'USDT') return;

    var coin = live.map[tick.s.slice(0, -4)];
    if (!coin) return;

    var price = parseFloat(tick.c);
    var open = parseFloat(tick.o);
    if (!(price > 0) || !(open > 0)) return;

    var previous = coin.price;
    coin.price = price;
    coin.change24h = ((price - open) / open) * 100;
    coin.live = true;

    if (coin._p && coin._p.isConnected) {
      coin._p.textContent = fmtPrice(price);
      if (previous != null && price !== Number(previous)) {
        flash(coin._p, price > Number(previous));
      }

      var updatedChange = change(coin.change24h);
      coin._c.textContent = updatedChange.text;
      coin._c.className = 'num ' + updatedChange.cls;
    }

    if (modal && !modal.hidden &&
        document.getElementById('cw-asset-symbol').textContent ===
        String(coin.symbol).toUpperCase()) {
      document.getElementById('cw-asset-price').textContent = fmtPrice(coin.price);

      var modalChange = change(coin.change24h);
      var modalChangeEl = document.getElementById('cw-asset-change');
      modalChangeEl.textContent = modalChange.text;
      modalChangeEl.className = 'cw-modal-change ' + modalChange.cls;
    }
  }

  function scheduleReconnect() {
    if (live.reconnectTimer) return;

    live.index++;
    live.tries++;

    live.reconnectTimer = setTimeout(function () {
      live.reconnectTimer = null;
      connect();
    }, Math.min(30000, 2000 * live.tries));
  }

  function connect() {
    if (live.ws || !coins.length || !('WebSocket' in window)) return;

    var socket;

    try {
      socket = new WebSocket(live.urls[live.index % live.urls.length]);
    } catch (error) {
      scheduleReconnect();
      return;
    }

    live.ws = socket;

    socket.onmessage = function (event) {
      var data;

      try {
        data = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (!Array.isArray(data)) return;

      live.tries = 0;
      liveDot.hidden = false;
      data.forEach(applyTick);
    };

    socket.onclose = function () {
      if (live.ws !== socket) return;

      live.ws = null;
      liveDot.hidden = true;
      scheduleReconnect();
    };

    socket.onerror = function () {
      try {
        socket.close();
      } catch (error) {}
    };
  }

  function setCoins(data) {
    if (!Array.isArray(data)) {
      throw new Error('Unexpected market response');
    }

    var previousLive = {};

    coins.forEach(function (coin) {
      if (coin.live) {
        previousLive[String(coin.symbol || '').toUpperCase()] = coin;
      }
    });

    coins = data.filter(function (coin) {
      return coin && typeof coin === 'object' && coin.symbol;
    }).map(function (coin) {
      var item = Object.assign({}, coin);
      var previous = previousLive[String(item.symbol).toUpperCase()];

      if (previous) {
        item.price = previous.price;
        item.change24h = previous.change24h;
        item.live = true;
      }

      item.volume24h = number(item.volume24h);
      item.marketCap = number(item.marketCap);

      return item;
    });

    buildMap();
    render();
    connect();
  }

  function load() {
    message('Loading markets', 'Fetching the latest market information.');

    fetch('/api/markets')
      .then(function (response) {
        if (!response.ok) throw new Error('Market request failed');
        return response.json();
      })
      .then(setCoins)
      .catch(function () {
        message(
          'Prices are unavailable',
          'Check your connection or try refreshing the page.'
        );
      });
  }

  markHeads();
  search.addEventListener('input', render);

  if (year) year.textContent = new Date().getFullYear();

  load();

  refreshTimer = setInterval(function () {
    fetch('/api/markets')
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (data) {
        if (data) setCoins(data);
      })
      .catch(function () {});
  }, 60000);

  window.addEventListener('beforeunload', function () {
    if (refreshTimer) clearInterval(refreshTimer);
    if (live.reconnectTimer) clearTimeout(live.reconnectTimer);
    if (live.ws) live.ws.close();
  });

})();
