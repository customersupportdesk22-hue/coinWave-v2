
(function () {
  'use strict';

  // --------------------------------------------------
  // COINWAVE MARKET APPLICATION
  // Compatible with the existing homepage:
  // #rows, #search, #year and /api/markets
  // --------------------------------------------------

  var body = document.getElementById('rows');
  var search = document.getElementById('search');
  var year = document.getElementById('year');

  if (!body || !search) {
    console.error('CoinWave: Required market table elements are missing.');
    return;
  }

  var coins = [];
  var loading = false;
  var destroyed = false;
  var refreshTimer = null;

  var favorites = readStorage('coinwave_favorites', []);
  var alerts = readStorage('coinwave_alerts', []);

  if (!Array.isArray(favorites)) favorites = [];
  if (!Array.isArray(alerts)) alerts = [];

  var activeFilter = 'all';
  var sort = { key: 'rank', dir: 1 };

  var columns = ['rank', 'name', 'price', 'change24h'];
  var heads = document.querySelectorAll('#markets thead th');

  // --------------------------------------------------
  // STORAGE
  // --------------------------------------------------

  function readStorage(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function saveStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn('CoinWave: Could not save browser data.');
    }
  }

  // --------------------------------------------------
  // FORMATTING
  // --------------------------------------------------

  function numeric(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    var result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function fmtPrice(value) {
    var price = numeric(value);

    if (price === null) return '—';

    if (price >= 1) {
      return '$' + price.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }

    if (price >= 0.01) {
      return '$' + price.toFixed(4);
    }

    return '$' + price.toFixed(8).replace(/0+$/, '');
  }

  function formatChange(value) {
    var amount = numeric(value);

    if (amount === null || Math.abs(amount) < 0.005) {
      return { text: '0.00%', cls: 'flat' };
    }

    var positive = amount > 0;

    return {
      text: (positive ? '+' : '−') +
        Math.abs(amount).toFixed(2) + '%',
      cls: positive ? 'up' : 'down'
    };
  }

  function makeCell(className, content) {
    var cell = document.createElement('td');

    if (className) cell.className = className;

    if (typeof content === 'string') {
      cell.textContent = content;
    } else if (content) {
      cell.appendChild(content);
    }

    return cell;
  }

  // --------------------------------------------------
  // NOTIFICATIONS AND TOASTS
  // --------------------------------------------------

  function toast(message) {
    var element = document.getElementById('cw-toast');

    if (!element) {
      element = document.createElement('div');
      element.id = 'cw-toast';
      element.setAttribute('role', 'status');
      element.setAttribute('aria-live', 'polite');

      element.style.cssText =
        'position:fixed;z-index:9999;left:50%;bottom:24px;' +
        'transform:translate(-50%,15px);padding:13px 18px;' +
        'max-width:calc(100% - 30px);border-radius:11px;' +
        'background:#06133f;color:#fff;font-size:13px;' +
        'font-weight:600;box-shadow:0 8px 30px #0003;' +
        'opacity:0;visibility:hidden;transition:.2s ease;';

      document.body.appendChild(element);
    }

    element.textContent = message;
    element.style.opacity = '1';
    element.style.visibility = 'visible';
    element.style.transform = 'translate(-50%,0)';

    clearTimeout(toast.timer);

    toast.timer = setTimeout(function () {
      element.style.opacity = '0';
      element.style.visibility = 'hidden';
      element.style.transform = 'translate(-50%,15px)';
    }, 3000);
  }

  // --------------------------------------------------
  // FAVORITES / WATCHLIST
  // --------------------------------------------------

  function isFavorite(symbol) {
    return favorites.indexOf(symbol) !== -1;
  }

  function toggleFavorite(symbol) {
    if (isFavorite(symbol)) {
      favorites = favorites.filter(function (item) {
        return item !== symbol;
      });

      toast(symbol + ' removed from your watchlist.');
    } else {
      favorites.push(symbol);
      toast(symbol + ' added to your watchlist.');
    }

    saveStorage('coinwave_favorites', favorites);
    render();
  }

  // --------------------------------------------------
  // PRICE ALERTS
  // --------------------------------------------------

  function setPriceAlert(coin) {
    var currentPrice = numeric(coin.price);

    if (currentPrice === null || currentPrice <= 0) {
      toast('The current price is unavailable.');
      return;
    }

    var answer = window.prompt(
      'Enter your target price in USD for ' +
      coin.name + '. Current price: ' + fmtPrice(currentPrice)
    );

    if (answer === null) return;

    var target = Number(answer);

    if (!Number.isFinite(target) || target <= 0) {
      toast('Enter a valid price greater than zero.');
      return;
    }

    if (!window.confirm(
      'Create a price alert for ' + coin.symbol +
      ' at ' + fmtPrice(target) + '?'
    )) {
      return;
    }

    alerts.push({
      symbol: coin.symbol,
      name: coin.name,
      target: target,
      direction: target >= currentPrice ? 'above' : 'below',
      triggered: false,
      created: Date.now()
    });

    saveStorage('coinwave_alerts', alerts);

    if (
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      Notification.requestPermission().catch(function () {});
    }

    toast('Price alert created for ' + coin.symbol + '.');
  }

  function checkAlerts(coin) {
    var price = numeric(coin.price);

    if (price === null) return;

    var updated = false;

    alerts.forEach(function (alert) {
      if (alert.triggered || alert.symbol !== coin.symbol) return;

      var reached =
        (alert.direction === 'above' && price >= alert.target) ||
        (alert.direction === 'below' && price <= alert.target);

      if (!reached) return;

      alert.triggered = true;
      updated = true;

      var message =
        coin.name + ' reached ' + fmtPrice(alert.target);

      toast(message);

      if (
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        try {
          new Notification('CoinWave price alert', {
            body: message
          });
        } catch (error) {}
      }
    });

    if (updated) {
      saveStorage('coinwave_alerts', alerts);
    }
  }

  // --------------------------------------------------
  // MARKET FILTERS
  // --------------------------------------------------

  function addStyles() {
    if (document.getElementById('cw-market-styles')) return;

    var style = document.createElement('style');
    style.id = 'cw-market-styles';

    style.textContent = `
      .cw-filters {
        display:flex;
        flex-wrap:wrap;
        gap:8px;
        margin:0 0 15px;
      }

      .cw-filter {
        padding:8px 13px;
        border:1px solid #dce4f1;
        border-radius:9px;
        background:#fff;
        color:#64708a;
        font-size:12px;
        font-weight:700;
        cursor:pointer;
      }

      .cw-filter.active {
        color:#fff;
        background:#087cf0;
        border-color:#087cf0;
      }

      .cw-actions {
        display:flex;
        align-items:center;
        gap:6px;
      }

      .cw-action {
        min-width:29px;
        height:29px;
        padding:0 6px;
        border:1px solid #e1e8f4;
        border-radius:7px;
        background:#fff;
        color:#68758f;
        font-size:12px;
        cursor:pointer;
      }

      .cw-action:hover {
        border-color:#087cf0;
        color:#087cf0;
      }

      .cw-action.favorite {
        color:#c18b00;
        background:#fff8df;
        border-color:#ffe18a;
      }

      .cw-live {
        display:inline-flex;
        align-items:center;
        gap:6px;
        margin-left:10px;
        color:#16a765;
        font-size:11px;
        font-weight:700;
      }

      .cw-live::before {
        content:"";
        width:7px;
        height:7px;
        border-radius:50%;
        background:currentColor;
      }

      .cw-live.offline {
        color:#d97706;
      }

      .cw-coin-name {
        padding:0;
        border:0;
        background:transparent;
        color:inherit;
        font:inherit;
        text-align:left;
        cursor:pointer;
      }

      .cw-coin-name:hover .n {
        color:#087cf0;
      }

      .cw-filter:focus-visible,
      .cw-action:focus-visible,
      .cw-coin-name:focus-visible {
        outline:3px solid #087cf055;
        outline-offset:2px;
      }

      @media(max-width:640px) {
        .cw-filters {
          flex-wrap:nowrap;
          overflow-x:auto;
          padding-bottom:5px;
        }

        .cw-filter {
          flex-shrink:0;
        }

        .cw-actions {
          gap:4px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function createFilters() {
    var section = document.querySelector('#markets .section-head');

    if (!section || document.getElementById('cw-filters')) return;

    var filters = document.createElement('div');
    filters.id = 'cw-filters';
    filters.className = 'cw-filters';

    [
      { id: 'all', label: 'All assets' },
      { id: 'gainers', label: 'Gainers' },
      { id: 'losers', label: 'Losers' },
      { id: 'favorites', label: '★ Watchlist' }
    ].forEach(function (option) {
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

    section.insertAdjacentElement('afterend', filters);
    updateFilters();
  }

  function updateFilters() {
    document.querySelectorAll('.cw-filter').forEach(function (button) {
      var selected = button.dataset.filter === activeFilter;

      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  // --------------------------------------------------
  // MARKET TABLE ROWS
  // --------------------------------------------------

  function createRow(coin) {
    var tr = document.createElement('tr');

    tr.appendChild(makeCell(
      'rank hide-sm',
      String(coin.rank == null ? '—' : coin.rank)
    ));

    var box = document.createElement('div');
    box.className = 'coin';

    if (coin.image && /^https?:\/\//i.test(coin.image)) {
      var image = document.createElement('img');

      image.src = coin.image;
      image.alt = coin.name + ' logo';
      image.loading = 'lazy';

      image.onerror = function () {
        image.style.visibility = 'hidden';
      };

      box.appendChild(image);
    }

    var nameButton = document.createElement('button');
    nameButton.type = 'button';
    nameButton.className = 'cw-coin-name';
    nameButton.title = coin.name;

    var text = document.createElement('div');

    var name = document.createElement('div');
    name.className = 'n';
    name.textContent = coin.name || 'Unknown coin';

    var symbol = document.createElement('div');
    symbol.className = 's';
    symbol.textContent = coin.symbol;

    text.appendChild(name);
    text.appendChild(symbol);
    nameButton.appendChild(text);
    box.appendChild(nameButton);

    tr.appendChild(makeCell('', box));

    coin._priceCell = makeCell('num', fmtPrice(coin.price));
    tr.appendChild(coin._priceCell);

    var formatted = formatChange(coin.change24h);

    coin._changeCell = makeCell(
      'num ' + formatted.cls,
      formatted.text
    );

    tr.appendChild(coin._changeCell);

    var actionCell = document.createElement('td');
    actionCell.className = 'cw-actions';

    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'cw-action' +
      (isFavorite(coin.symbol) ? ' favorite' : '');
    star.textContent = isFavorite(coin.symbol) ? '★' : '☆';
    star.title = isFavorite(coin.symbol)
      ? 'Remove from watchlist'
      : 'Add to watchlist';

    star.setAttribute('aria-label', star.title);

    star.addEventListener('click', function () {
      toggleFavorite(coin.symbol);
    });

    var alertButton = document.createElement('button');
    alertButton.type = 'button';
    alertButton.className = 'cw-action';
    alertButton.textContent = 'Alert';
    alertButton.title = 'Create price alert';

    alertButton.addEventListener('click', function () {
      setPriceAlert(coin);
    });

    actionCell.appendChild(star);
    actionCell.appendChild(alertButton);
    tr.appendChild(actionCell);

    return tr;
  }

  // --------------------------------------------------
  // TABLE MESSAGES
  // --------------------------------------------------

  function showMessage(title, description) {
    body.replaceChildren();

    var tr = document.createElement('tr');
    var cell = document.createElement('td');

    cell.colSpan = Math.max(4, heads.length);
    cell.className = 'state';

    var strong = document.createElement('strong');
    strong.textContent = title;

    cell.appendChild(strong);
    cell.appendChild(document.createTextNode(description));

    tr.appendChild(cell);
    body.appendChild(tr);
  }

  // --------------------------------------------------
  // SORTING
  // --------------------------------------------------

  function sortCoins(list) {
    return list.slice().sort(function (a, b) {
      var x = a[sort.key];
      var y = b[sort.key];

      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;

      if (typeof x === 'string') {
        return x.localeCompare(String(y)) * sort.dir;
      }

      return (Number(x) - Number(y)) * sort.dir;
    });
  }

  function updateHeadings() {
    heads.forEach(function (th, index) {
      var key = columns[index];

      var label = th.getAttribute('data-label') ||
        th.textContent.replace(/[▲▼\s]+$/, '');

      th.setAttribute('data-label', label);

      th.textContent = label +
        (key === sort.key
          ? (sort.dir === 1 ? ' ▲' : ' ▼')
          : '');

      th.setAttribute(
        'aria-sort',
        key === sort.key
          ? (sort.dir === 1 ? 'ascending' : 'descending')
          : 'none'
      );
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

    updateHeadings();
    render();
  }

  heads.forEach(function (th, index) {
    th.style.cursor = 'pointer';
    th.tabIndex = 0;

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

  // --------------------------------------------------
  // RENDER MARKETS
  // --------------------------------------------------

  function render() {
    var query = search.value.trim().toLowerCase();

    var list = coins.filter(function (coin) {
      var matchesSearch =
        !query ||
        String(coin.name).toLowerCase().includes(query) ||
        String(coin.symbol).toLowerCase().includes(query);

      var matchesFilter = true;

      if (activeFilter === 'gainers') {
        matchesFilter = numeric(coin.change24h) > 0;
      } else if (activeFilter === 'losers') {
        matchesFilter = numeric(coin.change24h) < 0;
      } else if (activeFilter === 'favorites') {
        matchesFilter = isFavorite(coin.symbol);
      }

      return matchesSearch && matchesFilter;
    });

    list = sortCoins(list);

    if (!list.length) {
      if (!coins.length) {
        showMessage(
          'Market data unavailable',
          'Prices could not be loaded. Please try again shortly.'
        );
      } else if (activeFilter === 'favorites' && !favorites.length) {
        showMessage(
          'Your watchlist is empty',
          'Use the star beside a coin to add it to your watchlist.'
        );
      } else {
        showMessage(
          'No matching coins',
          'Try another search or market filter.'
        );
      }

      return;
    }

    body.replaceChildren();

    list.forEach(function (coin) {
      body.appendChild(createRow(coin));
    });
  }

  search.addEventListener('input', render);

  // --------------------------------------------------
  // LIVE MARKET STATUS
  // --------------------------------------------------

  var liveStatus = document.createElement('span');

  liveStatus.className = 'cw-live offline';
  liveStatus.textContent = 'Connecting';
  liveStatus.setAttribute('role', 'status');
  liveStatus.setAttribute('aria-live', 'polite');

  var marketHeading =
    document.querySelector('#markets .section-head h2');

  if (marketHeading) {
    marketHeading.appendChild(liveStatus);
  }

  function setLiveStatus(connected) {
    liveStatus.textContent = connected
      ? 'Live prices'
      : 'Connecting';

    liveStatus.classList.toggle('offline', !connected);
  }

  // --------------------------------------------------
  // BINANCE LIVE PRICE STREAM
  // --------------------------------------------------

  var live = {
    socket: null,
    map: {},
    urls: [
      'wss://stream.binance.com:443/ws/!miniTicker@arr',
      'wss://data-stream.binance.vision/ws/!miniTicker@arr'
    ],
    serverIndex: 0,
    attempts: 0,
    reconnectTimer: null
  };

  function buildCoinMap() {
    live.map = {};

    coins.forEach(function (coin) {
      live.map[coin.symbol.toUpperCase()] = coin;
    });
  }

  function flashPrice(element, positive) {
    if (!element || typeof element.animate !== 'function') return;

    try {
      element.animate([
        {
          backgroundColor: positive
            ? 'rgba(22,167,101,.25)'
            : 'rgba(224,68,84,.25)'
        },
        { backgroundColor: 'transparent' }
      ], { duration: 800 });
    } catch (error) {}
  }

  function applyLiveTick(tick) {
    if (!tick || !tick.s || tick.s.slice(-4) !== 'USDT') return;

    var symbol = tick.s.slice(0, -4).toUpperCase();
    var coin = live.map[symbol];

    if (!coin) return;

    var price = numeric(tick.c);
    var opening = numeric(tick.o);

    if (price === null || opening === null || price <= 0 || opening <= 0) {
      return;
    }

    var previous = numeric(coin.price);

    coin.price = price;
    coin.change24h = ((price - opening) / opening) * 100;
    coin.live = true;

    if (coin._priceCell && coin._priceCell.isConnected) {
      coin._priceCell.textContent = fmtPrice(price);

      if (previous !== null && previous !== price) {
        flashPrice(coin._priceCell, price > previous);
      }

      var formatted = formatChange(coin.change24h);

      coin._changeCell.textContent = formatted.text;
      coin._changeCell.className = 'num ' + formatted.cls;
    }

    checkAlerts(coin);
  }

  function scheduleReconnect() {
    if (destroyed || live.reconnectTimer) return;

    live.serverIndex++;
    live.attempts++;

    var delay = Math.min(30000, 2000 * live.attempts);

    live.reconnectTimer = setTimeout(function () {
      live.reconnectTimer = null;
      connectLivePrices();
    }, delay);
  }

  function connectLivePrices() {
    if (
      destroyed ||
      live.socket ||
      !coins.length ||
      typeof WebSocket === 'undefined'
    ) {
      return;
    }

    var socket;

    try {
      socket = new WebSocket(
        live.urls[live.serverIndex % live.urls.length]
      );
    } catch (error) {
      scheduleReconnect();
      return;
    }

    live.socket = socket;

    socket.onopen = function () {
      setLiveStatus(false);
    };

    socket.onmessage = function (event) {
      var data;

      try {
        data = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (!Array.isArray(data)) return;

      live.attempts = 0;
      setLiveStatus(true);

      data.forEach(applyLiveTick);
    };

    socket.onclose = function () {
      if (live.socket !== socket) return;

      live.socket = null;
      setLiveStatus(false);
      scheduleReconnect();
    };

    socket.onerror = function () {
      try {
        socket.close();
      } catch (error) {}
    };
  }

  // --------------------------------------------------
  // NORMALIZE BACKEND MARKET RESPONSE
  // --------------------------------------------------

  function normalizeMarkets(data) {
    if (!Array.isArray(data)) {
      if (data && Array.isArray(data.data)) {
        data = data.data;
      } else if (data && Array.isArray(data.markets)) {
        data = data.markets;
      } else {
        throw new Error('Invalid market response.');
      }
    }

    return data.map(function (coin, index) {
      return {
        rank: numeric(coin.rank) || index + 1,
        name: String(coin.name || 'Unknown coin'),
        symbol: String(coin.symbol || '').toUpperCase(),
        image: coin.image || '',
        price: numeric(coin.price),
        change24h: numeric(coin.change24h)
      };
    }).filter(function (coin) {
      return coin.symbol.length > 0;
    });
  }

  function updateMarkets(data) {
    var previousLive = {};

    coins.forEach(function (coin) {
      if (coin.live) {
        previousLive[coin.symbol] = coin;
      }
    });

    var updated = normalizeMarkets(data);

    updated.forEach(function (coin) {
      var previous = previousLive[coin.symbol];

      if (previous) {
        coin.price = previous.price;
        coin.change24h = previous.change24h;
        coin.live = true;
      }

      checkAlerts(coin);
    });

    coins = updated;

    buildCoinMap();
    updateHeadings();
    render();

    if (!live.socket) {
      connectLivePrices();
    }
  }

  // --------------------------------------------------
  // BACKEND MARKET API
  // --------------------------------------------------

  function loadMarkets() {
    if (loading || destroyed) return;

    loading = true;

    if (!coins.length) {
      showMessage(
        'Loading markets',
        'Fetching the latest cryptocurrency prices.'
      );
    }

    fetch('/api/markets', {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Market API returned ' + response.status);
        }

        return response.json();
      })
      .then(updateMarkets)
      .catch(function (error) {
        console.error('CoinWave market loading error:', error);

        // Keep previously loaded market data visible if refresh fails.
        if (!coins.length) {
          showMessage(
            'Prices are temporarily unavailable',
            'Check your connection and try refreshing the page.'
          );
        }
      })
      .finally(function () {
        loading = false;
      });
  }

  // --------------------------------------------------
  // INITIALIZE
  // --------------------------------------------------

  addStyles();
  createFilters();
  updateHeadings();

  if (year) {
    year.textContent = new Date().getFullYear();
  }

  loadMarkets();

  // Refresh backend market data every minute.
  refreshTimer = setInterval(loadMarkets, 60000);

  // Clean up when leaving the page.
  window.addEventListener('pagehide', function () {
    destroyed = true;

    if (refreshTimer) {
      clearInterval(refreshTimer);
    }

    if (live.reconnectTimer) {
      clearTimeout(live.reconnectTimer);
    }

    if (live.socket) {
      try {
        live.socket.close();
      } catch (error) {}

      live.socket = null;
    }
  });

})();
