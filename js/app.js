
(function () {
  'use strict';

  // =========================================================
  // COINWAVE TRADE — COMPLETE CUSTOMER FRONTEND
  // Markets, live prices, asset navigation, watchlist, alerts
  // =========================================================

  var STORAGE = {
    watchlist: 'coinwave_watchlist_v1',
    alerts: 'coinwave_price_alerts_v1'
  };

  var coins = [];
  var activeView = 'all';
  var sort = { key: 'rank', dir: 1 };
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

  var watchlist = readStorage(STORAGE.watchlist, []);
  var alerts = readStorage(STORAGE.alerts, []);

  var body = document.getElementById('rows');
  var search = document.getElementById('search');
  var year = document.getElementById('year');

  function readStorage(key, fallback) {
    try {
      var value = JSON.parse(localStorage.getItem(key));
      return Array.isArray(value) ? value : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('CoinWave: browser storage unavailable.', e);
      return false;
    }
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[c];
    });
  }

  function fmtPrice(value) {
    var p = Number(value);
    if (!Number.isFinite(p)) return '—';

    if (p >= 1000) {
      return '$' + p.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }

    if (p >= 1) return '$' + p.toFixed(2);
    if (p >= 0.01) return '$' + p.toFixed(4);

    return '$' + p.toFixed(8).replace(/0+$/, '');
  }

  function fmtCompact(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';

    return '$' + new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 2
    }).format(n);
  }

  function change(value) {
    var n = Number(value);

    if (!Number.isFinite(n) || Math.abs(n) < 0.005) {
      return { text: '0.00%', cls: 'flat' };
    }

    return {
      text: (n > 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%',
      cls: n > 0 ? 'up' : 'down'
    };
  }

  function getCoin(symbol) {
    symbol = String(symbol || '').toUpperCase();
    return coins.find(function (coin) {
      return String(coin.symbol || '').toUpperCase() === symbol;
    });
  }

  function assetURL(symbol) {
    return '/asset?symbol=' + encodeURIComponent(
      String(symbol || '').toUpperCase()
    );
  }

  function openAsset(symbol) {
    if (!symbol) return;
    window.location.href = assetURL(symbol);
  }

  function isWatched(symbol) {
    return watchlist.indexOf(String(symbol).toUpperCase()) !== -1;
  }

  function toggleWatchlist(symbol) {
    symbol = String(symbol || '').toUpperCase();
    if (!symbol) return;

    if (isWatched(symbol)) {
      watchlist = watchlist.filter(function (item) {
        return item !== symbol;
      });
      notify('Removed ' + symbol + ' from your watchlist.');
    } else {
      watchlist.push(symbol);
      notify(symbol + ' added to your watchlist.');
    }

    saveStorage(STORAGE.watchlist, watchlist);
    updateToolCounts();
    render();
    renderWatchlist();
  }

  function notify(message) {
    var box = document.getElementById('cwNotice');
    if (!box) return;

    box.textContent = message;
    box.hidden = false;

    clearTimeout(box._timer);
    box._timer = setTimeout(function () {
      box.hidden = true;
    }, 3200);
  }

  // =========================================================
  // FEATURE STYLES
  // =========================================================

  function installStyles() {
    if (document.getElementById('cwAppStyles')) return;

    var style = document.createElement('style');
    style.id = 'cwAppStyles';
    style.textContent = `
      .cw-tools{margin:18px 0 20px;padding:16px;background:var(--surface,#fff);
        border:1px solid var(--line,#e1e8f4);border-radius:16px}
      .cw-tool-menu{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:15px}
      .cw-tool-tab{border:1px solid var(--line,#e1e8f4);background:var(--surface-2,#edf4ff);
        color:var(--text,#101a35);border-radius:10px;padding:10px 14px;
        font-weight:700;cursor:pointer;font-size:13px}
      .cw-tool-tab.active{background:var(--accent,#087cf0);border-color:var(--accent,#087cf0);color:#fff}
      .cw-count{display:inline-flex;margin-left:5px;min-width:19px;height:19px;
        border-radius:20px;align-items:center;justify-content:center;
        background:#ffffff30;font-size:11px}
      .cw-tool-panel{display:none}
      .cw-tool-panel.active{display:block}
      .cw-panel-title{font-size:16px;font-weight:800;margin:0 0 6px}
      .cw-panel-sub{font-size:12px;color:var(--muted,#68758f);margin:0 0 14px}
      .cw-watch-row,.cw-alert-row{display:flex;align-items:center;justify-content:space-between;
        gap:12px;padding:12px 0;border-top:1px solid var(--line,#e1e8f4)}
      .cw-watch-name{font-weight:800;font-size:13px}
      .cw-watch-meta{font-size:11px;color:var(--muted,#68758f);margin-top:3px}
      .cw-watch-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      .cw-small-btn{border:1px solid var(--line,#e1e8f4);background:var(--surface,#fff);
        color:var(--text,#101a35);padding:7px 10px;border-radius:8px;
        cursor:pointer;font-weight:700;font-size:11px}
      .cw-small-btn:hover{border-color:var(--accent,#087cf0);color:var(--accent,#087cf0)}
      .cw-star{border:0;background:transparent;color:#8995a9;font-size:19px;
        cursor:pointer;padding:4px 7px}
      .cw-star.active{color:#e6a700}
      .cw-alert-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
        gap:10px;align-items:end;margin-bottom:15px}
      .cw-field label{display:block;font-size:11px;font-weight:700;margin-bottom:6px}
      .cw-field input,.cw-field select{width:100%;min-height:41px;border:1px solid var(--line,#e1e8f4);
        border-radius:9px;padding:8px 10px;background:var(--surface,#fff);
        color:var(--text,#101a35);box-sizing:border-box}
      .cw-primary-btn{border:0;border-radius:9px;background:var(--accent,#087cf0);
        color:white;font-weight:800;padding:11px 14px;min-height:41px;cursor:pointer}
      .cw-empty{padding:17px 10px;text-align:center;color:var(--muted,#68758f);
        font-size:13px;border-top:1px solid var(--line,#e1e8f4)}
      .cw-state{padding:25px;text-align:center;color:var(--muted,#68758f)}
      .cw-market-asset{display:flex;align-items:center;gap:9px;min-width:145px}
      .cw-market-asset img{width:29px;height:29px;border-radius:50%;object-fit:contain}
      .cw-market-asset .cw-name{font-weight:800}
      .cw-market-asset .cw-symbol{font-size:11px;color:var(--muted,#68758f)}
      .cw-market-asset a{color:inherit;text-decoration:none}
      .cw-market-asset a:hover{color:var(--accent,#087cf0)}
      .cw-market-row{cursor:pointer}
      .cw-market-row .cw-star{cursor:pointer}
      .cw-market-row .cw-star:hover{transform:scale(1.12)}
      #cwNotice{position:fixed;z-index:9999;bottom:20px;left:50%;
        transform:translateX(-50%);background:#10213f;color:#fff;
        border-radius:10px;padding:12px 17px;font-size:13px;
        box-shadow:0 8px 30px #0002;max-width:90%;text-align:center}
      .cw-live{font-size:11px;color:#16a765;margin-left:9px;font-weight:800}
      .cw-triggered{color:#16a765;font-weight:800}
      @media(max-width:650px){
        .cw-alert-form{grid-template-columns:1fr 1fr}
        .cw-alert-form .cw-field:last-of-type{grid-column:1/-1}
        .cw-tools{padding:12px}
        .cw-tool-tab{padding:9px 10px;font-size:12px}
        .cw-watch-row,.cw-alert-row{align-items:flex-start}
      }
      @media(max-width:390px){.cw-alert-form{grid-template-columns:1fr}}
    `;

    document.head.appendChild(style);

    var notice = document.createElement('div');
    notice.id = 'cwNotice';
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    document.body.appendChild(notice);
  }

  // =========================================================
  // ASSET MENU: MARKETS / WATCHLIST / PRICE ALERTS
  // =========================================================

  function installAssetMenu() {
    if (!body || document.getElementById('cwTools')) return;

    var marketSection = body.closest('section') ||
      document.getElementById('markets') ||
      body.parentElement;

    var tools = document.createElement('section');
    tools.className = 'cw-tools';
    tools.id = 'cwTools';

    tools.innerHTML = `
      <div class="cw-tool-menu" role="tablist" aria-label="Asset tools">
        <button type="button" class="cw-tool-tab active" data-cw-view="all">
          All assets
        </button>
        <button type="button" class="cw-tool-tab" data-cw-view="watchlist">
          Watchlist <span class="cw-count" id="cwWatchCount">0</span>
        </button>
        <button type="button" class="cw-tool-tab" data-cw-view="alerts">
          Price alerts <span class="cw-count" id="cwAlertCount">0</span>
        </button>
      </div>

      <div class="cw-tool-panel" id="cwWatchPanel">
        <h3 class="cw-panel-title">Your watchlist</h3>
        <p class="cw-panel-sub">Keep your preferred digital assets together.</p>
        <div id="cwWatchRows"></div>
      </div>

      <div class="cw-tool-panel" id="cwAlertPanel">
        <h3 class="cw-panel-title">Price alerts</h3>
        <p class="cw-panel-sub">Set a target price and get notified when a live market price reaches it.</p>

        <form id="cwAlertForm" class="cw-alert-form">
          <div class="cw-field">
            <label for="cwAlertAsset">Digital asset</label>
            <select id="cwAlertAsset" required>
              <option value="">Choose asset</option>
            </select>
          </div>
          <div class="cw-field">
            <label for="cwAlertDirection">Alert condition</label>
            <select id="cwAlertDirection" required>
              <option value="above">Price rises above</option>
              <option value="below">Price falls below</option>
            </select>
          </div>
          <div class="cw-field">
            <label for="cwAlertPrice">Target price (USD)</label>
            <input id="cwAlertPrice" type="number" min="0.00000001"
              step="any" placeholder="Enter target price" required>
          </div>
          <button class="cw-primary-btn" type="submit">Create alert</button>
        </form>

        <div id="cwAlertRows"></div>
      </div>
    `;

    var tableCard = body.closest('.table-card') || body.parentElement;
    if (tableCard && tableCard.parentNode) {
      tableCard.parentNode.insertBefore(tools, tableCard);
    } else {
      marketSection.appendChild(tools);
    }

    tools.querySelectorAll('[data-cw-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        activeView = button.getAttribute('data-cw-view');

        tools.querySelectorAll('.cw-tool-tab').forEach(function (tab) {
          tab.classList.toggle('active', tab === button);
        });

        tools.querySelectorAll('.cw-tool-panel').forEach(function (panel) {
          panel.classList.remove('active');
        });

        if (activeView === 'watchlist') {
          document.getElementById('cwWatchPanel').classList.add('active');
          renderWatchlist();
        } else if (activeView === 'alerts') {
          document.getElementById('cwAlertPanel').classList.add('active');
          renderAlerts();
        }

        render();
      });
    });

    document.getElementById('cwAlertForm').addEventListener('submit', createAlert);
    updateToolCounts();
  }

  function updateToolCounts() {
    var watchCount = document.getElementById('cwWatchCount');
    var alertCount = document.getElementById('cwAlertCount');

    if (watchCount) watchCount.textContent = watchlist.length;
    if (alertCount) alertCount.textContent = alerts.filter(function (a) {
      return !a.triggered;
    }).length;
  }

  // =========================================================
  // MARKET TABLE — SIX DATA COLUMNS
  // =========================================================

  function ensureMarketHeaders() {
    if (!body) return;

    var table = body.closest('table');
    if (!table) return;

    var head = table.querySelector('thead');
    if (!head) {
      head = document.createElement('thead');
      table.insertBefore(head, table.firstChild);
    }

    var row = head.querySelector('tr');
    if (!row) {
      row = document.createElement('tr');
      head.appendChild(row);
    }

    var labels = [
      ['rank', '#'],
      ['name', 'Asset'],
      ['price', 'Price'],
      ['change24h', '24h Change'],
      ['volume24h', '24h Volume'],
      ['marketCap', 'Market Cap']
    ];

    row.innerHTML = '';

    labels.forEach(function (item, index) {
      var th = document.createElement('th');
      th.textContent = item[1];
      th.setAttribute('data-sort-key', item[0]);
      th.setAttribute('aria-sort', 'none');
      th.tabIndex = 0;
      th.setAttribute('role', 'button');

      if (index === 0) th.className = 'hide-sm';
      if (index > 1) th.classList.add('num');

      th.style.cursor = 'pointer';

      th.addEventListener('click', function () {
        changeSort(item[0]);
      });

      th.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          changeSort(item[0]);
        }
      });

      row.appendChild(th);
    });

    table.style.minWidth = '900px';
  }

  function changeSort(key) {
    if (sort.key === key) {
      sort.dir *= -1;
    } else {
      sort.key = key;
      sort.dir = ['rank', 'name'].indexOf(key) !== -1 ? 1 : -1;
    }

    updateSortHeaders();
    render();
  }

  function updateSortHeaders() {
    document.querySelectorAll('thead th[data-sort-key]').forEach(function (th) {
      var key = th.getAttribute('data-sort-key');
      var original = th.textContent.replace(/[▲▼]\s*$/, '');
      th.textContent = original +
        (key === sort.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');

      th.setAttribute('aria-sort', key === sort.key
        ? (sort.dir === 1 ? 'ascending' : 'descending')
        : 'none');
    });
  }

  function sortCoins(list) {
    return list.slice().sort(function (a, b) {
      var x = a[sort.key];
      var y = b[sort.key];

      if (sort.key === 'name') {
        return String(x || '').localeCompare(String(y || '')) * sort.dir;
      }

      x = Number(x);
      y = Number(y);

      if (!Number.isFinite(x)) return 1;
      if (!Number.isFinite(y)) return -1;

      return (x - y) * sort.dir;
    });
  }

  function createCell(className, value) {
    var td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = value == null ? '—' : String(value);
    return td;
  }

  function row(coin) {
    var tr = document.createElement('tr');
    tr.className = 'cw-market-row';

    tr.appendChild(createCell('rank hide-sm', coin.rank));

    var assetCell = document.createElement('td');
    var assetBox = document.createElement('div');
    assetBox.className = 'cw-market-asset';

    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'cw-star' + (
      isWatched(coin.symbol) ? ' active' : ''
    );
    star.textContent = isWatched(coin.symbol) ? '★' : '☆';
    star.title = isWatched(coin.symbol)
      ? 'Remove from watchlist'
      : 'Add to watchlist';
    star.setAttribute('aria-label', star.title);

    star.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleWatchlist(coin.symbol);
    });

    var image = document.createElement('img');
    image.src = coin.image || '';
    image.alt = coin.name || coin.symbol || 'Asset';
    image.loading = 'lazy';
    image.onerror = function () {
      image.style.display = 'none';
    };

    var info = document.createElement('div');
    var name = document.createElement('div');
    name.className = 'cw-name';
    name.textContent = coin.name || 'Unknown asset';

    var symbol = document.createElement('div');
    symbol.className = 'cw-symbol';
    symbol.textContent = String(coin.symbol || '').toUpperCase();

    info.appendChild(name);
    info.appendChild(symbol);

    assetBox.appendChild(star);
    assetBox.appendChild(image);
    assetBox.appendChild(info);
    assetCell.appendChild(assetBox);

    assetCell.addEventListener('click', function () {
      openAsset(coin.symbol);
    });

    tr.appendChild(assetCell);

    var priceCell = createCell('num', fmtPrice(coin.price));
    var changeData = change(coin.change24h);
    var changeCell = createCell(
      'num ' + changeData.cls,
      changeData.text
    );

    tr.appendChild(priceCell);
    tr.appendChild(changeCell);
    tr.appendChild(createCell('num', fmtCompact(coin.volume24h)));
    tr.appendChild(createCell('num', fmtCompact(coin.marketCap)));

    return tr;
  }

  function message(title, description) {
    if (!body) return;

    body.innerHTML = '';
    var tr = document.createElement('tr');
    var cell = document.createElement('td');

    cell.colSpan = 6;
    cell.className = 'cw-state';

    var strong = document.createElement('strong');
    strong.textContent = title;

    cell.appendChild(strong);
    cell.appendChild(document.createElement('br'));
    cell.appendChild(document.createTextNode(description || ''));

    tr.appendChild(cell);
    body.appendChild(tr);
  }

  function render() {
    if (!body) return;

    var query = search ? search.value.trim().toLowerCase() : '';

    var list = coins.filter(function (coin) {
      var matchesSearch = !query ||
        String(coin.name || '').toLowerCase().includes(query) ||
        String(coin.symbol || '').toLowerCase().includes(query);

      var matchesView = activeView !== 'watchlist' ||
        isWatched(coin.symbol);

      return matchesSearch && matchesView;
    });

    list = sortCoins(list);

    if (!list.length) {
      if (activeView === 'watchlist') {
        message('Your watchlist is empty', 'Use the star beside an asset to add it.');
      } else {
        message(
          coins.length ? 'No matching assets' : 'Market data unavailable',
          coins.length
            ? 'Try another asset name or symbol.'
            : 'Check your connection and refresh the page.'
        );
      }
      return;
    }

    body.innerHTML = '';

    list.forEach(function (coin) {
      body.appendChild(row(coin));
    });
  }

  // =========================================================
  // WATCHLIST
  // =========================================================

  function renderWatchlist() {
    var container = document.getElementById('cwWatchRows');
    if (!container) return;

    container.innerHTML = '';

    if (!watchlist.length) {
      container.innerHTML =
        '<div class="cw-empty">Your watchlist is empty. Star an asset in Markets to save it here.</div>';
      return;
    }

    watchlist.forEach(function (symbol) {
      var coin = getCoin(symbol);
      var item = document.createElement('div');
      item.className = 'cw-watch-row';

      var left = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'cw-watch-name';
      name.textContent = coin ? coin.name + ' (' + symbol + ')' : symbol;

      var meta = document.createElement('div');
      meta.className = 'cw-watch-meta';
      meta.textContent = coin
        ? 'Current price: ' + fmtPrice(coin.price)
        : 'Waiting for market data';

      left.appendChild(name);
      left.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'cw-watch-actions';

      var view = document.createElement('button');
      view.type = 'button';
      view.className = 'cw-small-btn';
      view.textContent = 'View asset';
      view.addEventListener('click', function () {
        openAsset(symbol);
      });

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cw-small-btn';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        toggleWatchlist(symbol);
      });

      actions.appendChild(view);
      actions.appendChild(remove);

      item.appendChild(left);
      item.appendChild(actions);
      container.appendChild(item);
    });
  }

  // =========================================================
  // PRICE ALERTS
  // =========================================================

  function populateAlertAssets() {
    var select = document.getElementById('cwAlertAsset');
    if (!select) return;

    var previous = select.value;
    select.innerHTML = '<option value="">Choose asset</option>';

    coins.forEach(function (coin) {
      var option = document.createElement('option');
      option.value = String(coin.symbol).toUpperCase();
      option.textContent = coin.name + ' (' +
        String(coin.symbol).toUpperCase() + ')';
      select.appendChild(option);
    });

    if (previous && getCoin(previous)) select.value = previous;
  }

  function createAlert(event) {
    event.preventDefault();

    var symbol = document.getElementById('cwAlertAsset').value;
    var direction = document.getElementById('cwAlertDirection').value;
    var target = Number(document.getElementById('cwAlertPrice').value);

    if (!symbol || !getCoin(symbol)) {
      notify('Choose a valid digital asset.');
      return;
    }

    if (!Number.isFinite(target) || target <= 0) {
      notify('Enter a valid target price.');
      return;
    }

    var alertItem = {
      id: 'cw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      symbol: symbol,
      direction: direction,
      target: target,
      triggered: false,
      createdAt: new Date().toISOString()
    };

    alerts.unshift(alertItem);
    saveStorage(STORAGE.alerts, alerts);

    document.getElementById('cwAlertPrice').value = '';

    updateToolCounts();
    renderAlerts();

    notify('Price alert created for ' + symbol + '.');
    checkAlerts();
  }

  function deleteAlert(id) {
    alerts = alerts.filter(function (item) {
      return item.id !== id;
    });

    saveStorage(STORAGE.alerts, alerts);
    updateToolCounts();
    renderAlerts();
  }

  function renderAlerts() {
    var container = document.getElementById('cwAlertRows');
    if (!container) return;

    container.innerHTML = '';

    if (!alerts.length) {
      container.innerHTML =
        '<div class="cw-empty">No price alerts yet. Create an alert above to monitor an asset price.</div>';
      return;
    }

    alerts.forEach(function (item) {
      var coin = getCoin(item.symbol);
      var row = document.createElement('div');
      row.className = 'cw-alert-row';

      var left = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'cw-watch-name';
      name.textContent = item.symbol + ' — ' +
        (item.direction === 'above' ? 'Above' : 'Below') +
        ' ' + fmtPrice(item.target);

      var meta = document.createElement('div');
      meta.className = 'cw-watch-meta';

      var current = coin ? fmtPrice(coin.price) : 'Waiting for price';

      meta.textContent = 'Current price: ' + current;

      if (item.triggered) {
        meta.className += ' cw-triggered';
        meta.textContent += ' · Triggered';
      }

      left.appendChild(name);
      left.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'cw-watch-actions';

      if (item.triggered) {
        var status = document.createElement('span');
        status.className = 'cw-triggered';
        status.textContent = 'Triggered';
        actions.appendChild(status);
      }

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cw-small-btn';
      remove.textContent = 'Delete';
      remove.addEventListener('click', function () {
        deleteAlert(item.id);
      });

      actions.appendChild(remove);
      row.appendChild(left);
      row.appendChild(actions);
      container.appendChild(row);
    });
  }

  function checkAlerts() {
    var changed = false;

    alerts.forEach(function (item) {
      if (item.triggered) return;

      var coin = getCoin(item.symbol);
      if (!coin) return;

      var price = Number(coin.price);
      if (!Number.isFinite(price) || price <= 0) return;

      var reached = item.direction === 'above'
        ? price >= Number(item.target)
        : price <= Number(item.target);

      if (!reached) return;

      item.triggered = true;
      item.triggeredAt = new Date().toISOString();
      changed = true;

      var messageText = item.symbol + ' has reached ' +
        fmtPrice(price) + ' (' +
        (item.direction === 'above' ? 'above' : 'below') +
        ' your target).';

      notify(messageText);

      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification('CoinWave price alert', {
            body: messageText
          });
        } catch (e) {}
      }
    });

    if (changed) {
      saveStorage(STORAGE.alerts, alerts);
      updateToolCounts();
      renderAlerts();
    }
  }

  // =========================================================
  // POPULAR ASSET CARDS AND ASSET MENU LINKS
  // =========================================================

  function bindAssetNavigation() {
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      var card = target.closest('[data-asset-symbol]');
      if (!card) return;

      var symbol = card.getAttribute('data-asset-symbol');
      if (!symbol) return;

      event.preventDefault();
      openAsset(symbol);
    });
  }

  // =========================================================
  // DISCOVER CARDS — DEDICATED PAGES
  // =========================================================

  function bindDiscoverNavigation() {
    var routes = {
      'explore-markets': '/discover/markets',
      'buy-sell-crypto': '/discover/buy-sell',
      'security-protection': '/discover/security',
      'transaction-process': '/discover/transactions',
      'fast-transactions': '/discover/transactions',
      'account-verification': '/discover/account',
      'customer-support': '/discover/support'
    };

    document.querySelectorAll('.discover-card').forEach(function (card) {
      var text = (card.textContent || '').toLowerCase();
      var slug = '';

      if (text.includes('explore markets')) slug = 'explore-markets';
      else if (text.includes('buy') && text.includes('sell')) slug = 'buy-sell-crypto';
      else if (text.includes('security')) slug = 'security-protection';
      else if (text.includes('transaction') || text.includes('fast')) slug = 'transaction-process';
      else if (text.includes('account') || text.includes('verification')) slug = 'account-verification';
      else if (text.includes('support')) slug = 'customer-support';

      if (!slug || !routes[slug]) return;

      card.setAttribute('href', routes[slug]);
      card.setAttribute('aria-label', card.getAttribute('aria-label') || card.textContent.trim());

      if (card.tagName !== 'A') {
        card.setAttribute('role', 'link');
        card.setAttribute('tabindex', '0');
        card.addEventListener('click', function () {
          window.location.href = routes[slug];
        });
        card.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            window.location.href = routes[slug];
          }
        });
      }
    });
  }

  // =========================================================
  // LIVE BINANCE MARKET STREAM
  // =========================================================

  function buildMap() {
    live.map = {};

    coins.forEach(function (coin) {
      var symbol = String(coin.symbol || '').toUpperCase();
      if (symbol) live.map[symbol] = coin;
    });
  }

  function flash(element, up) {
    if (!element || !element.animate) return;

    element.animate([
      { backgroundColor: up
        ? 'rgba(22,167,101,.24)'
        : 'rgba(224,68,84,.24)' },
      { backgroundColor: 'rgba(0,0,0,0)' }
    ], { duration: 800 });
  }

  function applyTick(ticker) {
    if (!ticker || !ticker.s ||
        ticker.s.slice(-4) !== 'USDT') return;

    var coin = live.map[ticker.s.slice(0, -4)];
    if (!coin) return;

    var price = parseFloat(ticker.c);
    var open = parseFloat(ticker.o);

    if (!(price > 0) || !(open > 0)) return;

    var previous = Number(coin.price);
    coin.price = price;
    coin.change24h = ((price - open) / open) * 100;
    coin.live = true;

    if (previous !== price) {
      flash(null, price > previous);
    }
  }

  function scheduleReconnect() {
    if (live.reconnectTimer) return;

    live.tries++;
    live.index++;

    var delay = Math.min(30000, 2000 * live.tries);

    live.reconnectTimer = setTimeout(function () {
      live.reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (live.ws || !coins.length || !('WebSocket' in window)) return;

    var socket;

    try {
      socket = new WebSocket(
        live.urls[live.index % live.urls.length]
      );
    } catch (error) {
      scheduleReconnect();
      return;
    }

    live.ws = socket;

    socket.onopen = function () {
      live.tries = 0;
    };

    socket.onmessage = function (event) {
      var tickers;

      try {
        tickers = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (!Array.isArray(tickers)) return;

      live.tries = 0;

      tickers.forEach(applyTick);

      render();
      renderWatchlist();
      renderAlerts();
      checkAlerts();
    };

    socket.onclose = function () {
      if (live.ws !== socket) return;

      live.ws = null;
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
      throw new Error('Unexpected market response.');
    }

    var previous = {};

    coins.forEach(function (coin) {
      if (coin.live) {
        previous[String(coin.symbol).toUpperCase()] = coin;
      }
    });

    coins = data.filter(function (coin) {
      return coin && typeof coin === 'object' && coin.symbol;
    }).map(function (coin) {
      var item = Object.assign({}, coin);
      var old = previous[String(item.symbol).toUpperCase()];

      if (old) {
        item.price = old.price;
        item.change24h = old.change24h;
        item.live = true;
      }

      return item;
    });

    buildMap();
    populateAlertAssets();
    render();
    renderWatchlist();
    renderAlerts();
    connect();
    checkAlerts();
  }

  // =========================================================
  // MARKET DATA LOADING AND REFRESH
  // =========================================================

  function loadMarkets() {
    if (body) {
      message('Loading markets', 'Fetching the latest market prices.');
    }

    fetch('/api/markets', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Market request failed.');
        }
        return response.json();
      })
      .then(setCoins)
      .catch(function (error) {
        console.error('CoinWave market loading error:', error);

        if (body && !coins.length) {
          message(
            'Prices are unavailable',
            'Check your connection and try again.'
          );
        }
      });
  }

  function startMarketRefresh() {
    setInterval(function () {
      fetch('/api/markets', {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      })
        .then(function (response) {
          return response.ok ? response.json() : null;
        })
        .then(function (data) {
          if (data) setCoins(data);
        })
        .catch(function () {});
    }, 60000);
  }

  // =========================================================
  // ASSET DETAIL PAGE SUPPORT
  // =========================================================

  function initAssetDetail() {
    var params = new URLSearchParams(window.location.search);
    var symbol = String(params.get('symbol') || '').toUpperCase();

    if (!symbol || !window.location.pathname.startsWith('/asset')) return;

    document.querySelectorAll('[data-asset-symbol]').forEach(function (element) {
      element.addEventListener('click', function () {
        openAsset(element.getAttribute('data-asset-symbol'));
      });
    });

    fetch('/api/markets', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Market request failed');
        return response.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) return;

        var coin = data.find(function (item) {
          return String(item.symbol).toUpperCase() === symbol;
        });

        if (!coin) return;

        document.querySelectorAll('[data-asset-name]').forEach(function (el) {
          el.textContent = coin.name;
        });

        document.querySelectorAll('[data-asset-symbol-value]').forEach(function (el) {
          el.textContent = symbol;
        });

        document.querySelectorAll('[data-asset-price]').forEach(function (el) {
          el.textContent = fmtPrice(coin.price);
        });

        document.querySelectorAll('[data-asset-change]').forEach(function (el) {
          var result = change(coin.change24h);
          el.textContent = result.text;
          el.classList.add(result.cls);
        });

        document.querySelectorAll('[data-asset-volume]').forEach(function (el) {
          el.textContent = fmtCompact(coin.volume24h);
        });

        document.querySelectorAll('[data-asset-market-cap]').forEach(function (el) {
          el.textContent = fmtCompact(coin.marketCap);
        });

        document.querySelectorAll('[data-asset-image]').forEach(function (el) {
          if (el.tagName === 'IMG') {
            el.src = coin.image || '';
            el.alt = coin.name;
          }
        });

        document.title = coin.name + ' (' + symbol + ') | CoinWave';

        document.querySelectorAll('[data-trade-side]').forEach(function (button) {
          button.addEventListener('click', function () {
            var side = button.getAttribute('data-trade-side');
            if (side !== 'buy' && side !== 'sell') return;

            window.location.href = '/login?asset=' +
              encodeURIComponent(symbol) +
              '&side=' + encodeURIComponent(side);
          });
        });

        var watchButton = document.getElementById('cwDetailWatch');
        if (watchButton) {
          function syncWatchButton() {
            watchButton.textContent = isWatched(symbol)
              ? '★ In watchlist'
              : '☆ Add to watchlist';
          }

          syncWatchButton();

          watchButton.addEventListener('click', function () {
            toggleWatchlist(symbol);
            syncWatchButton();
          });
        }
      })
      .catch(function (error) {
        console.error('CoinWave asset detail error:', error);
      });
  }

  // =========================================================
  // INITIALIZATION
  // =========================================================

  function init() {
    installStyles();
    bindAssetNavigation();
    bindDiscoverNavigation();
    initAssetDetail();

    if (year) {
      year.textContent = new Date().getFullYear();
    }

    if (body && search) {
      ensureMarketHeaders();
      installAssetMenu();

      if (search) {
        search.addEventListener('input', render);
      }

      updateToolCounts();
      loadMarkets();
      startMarketRefresh();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
