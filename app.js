(function () {
  'use strict';

  var rows = document.getElementById('rows');
  var search = document.getElementById('search');
  var latest = [];
  var updatedAt = null;
  var timer = null;

  function money(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1) return '$' + n.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
    if (n >= 0.01) return '$' + n.toFixed(4);
    return '$' + n.toFixed(8).replace(/0+$/, '');
  }

  function changeText(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function cell(row, value, className) {
    var td = document.createElement('td');
    td.textContent = value == null ? '—' : String(value);
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  function openAsset(symbol) {
    if (symbol) location.href = '/asset?symbol=' + encodeURIComponent(symbol);
  }

  function renderTable(list) {
    if (!rows) return;
    rows.textContent = '';
    if (!list.length) {
      var empty = document.createElement('tr');
      var td = cell(empty, 'No matching market assets are available.', 'state');
      td.colSpan = 4;
      rows.appendChild(empty);
      return;
    }
    list.forEach(function (coin, index) {
      var tr = document.createElement('tr');
      tr.className = 'market-row';
      tr.tabIndex = 0;
      tr.setAttribute('role', 'link');
      tr.setAttribute('aria-label', 'Open ' + coin.name + ' details');
      cell(tr, coin.rank || index + 1, 'rank hide-sm');
      var asset = document.createElement('td');
      var wrap = document.createElement('div');
      wrap.className = 'coin';
      if (coin.image) {
        var img = document.createElement('img');
        img.src = coin.image;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = function () { img.style.visibility = 'hidden'; };
        wrap.appendChild(img);
      }
      var names = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'n';
      name.textContent = coin.name || 'Unknown';
      var symbol = document.createElement('div');
      symbol.className = 's';
      symbol.textContent = String(coin.symbol || '').toUpperCase();
      names.append(name, symbol);
      wrap.appendChild(names);
      asset.appendChild(wrap);
      tr.appendChild(asset);
      cell(tr, money(coin.price), 'num');
      var pct = Number(coin.change24h);
      cell(tr, changeText(coin.change24h), 'num ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'));
      tr.addEventListener('click', function () { openAsset(coin.symbol); });
      tr.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openAsset(coin.symbol);
        }
      });
      rows.appendChild(tr);
    });
  }

  function renderMovers() {
    var gainers = document.getElementById('topGainers');
    var losers = document.getElementById('topLosers');
    [gainers, losers].forEach(function (node) { if (node) node.textContent = ''; });
    var valid = latest.filter(function (coin) { return Number.isFinite(Number(coin.change24h)); });
    var up = valid.slice().sort(function (a,b) { return Number(b.change24h)-Number(a.change24h); }).slice(0,5);
    var down = valid.slice().sort(function (a,b) { return Number(a.change24h)-Number(b.change24h); }).slice(0,5);
    function fill(target, items) {
      if (!target) return;
      if (!items.length) { target.textContent = 'Market movement data unavailable.'; return; }
      items.forEach(function (coin) {
        var link = document.createElement('a');
        link.className = 'mover-link';
        link.href = '/asset?symbol=' + encodeURIComponent(coin.symbol || '');
        var identity = document.createElement('span');
        identity.className = 'mover-identity';
        if (coin.image) {
          var img = document.createElement('img');
          img.src = coin.image;
          img.alt = '';
          img.loading = 'lazy';
          identity.appendChild(img);
        } else {
          var icon = document.createElement('span');
          icon.className = 'mover-icon';
          icon.textContent = String(coin.symbol || '').slice(0,4);
          identity.appendChild(icon);
        }
        var info = document.createElement('span');
        var name = document.createElement('span');
        name.className = 'mover-name';
        name.textContent = coin.name || coin.symbol;
        var symbol = document.createElement('span');
        symbol.className = 'mover-symbol';
        symbol.textContent = String(coin.symbol || '').toUpperCase();
        info.append(name,symbol);
        identity.appendChild(info);
        var price = document.createElement('span');
        price.className = 'mover-price';
        price.textContent = money(coin.price);
        var change = document.createElement('span');
        change.className = 'mover-change ' + (Number(coin.change24h) >= 0 ? 'up' : 'down');
        change.textContent = changeText(coin.change24h);
        link.append(identity,price,change);
        target.appendChild(link);
      });
    }
    fill(gainers, up);
    fill(losers, down);
  }

  function renderPopular() {
    var host = document.getElementById('popularAssets');
    if (!host) return;
    host.textContent = '';
    latest.slice(0,8).forEach(function (coin) {
      var link = document.createElement('a');
      link.className = 'asset-card';
      link.href = '/asset?symbol=' + encodeURIComponent(coin.symbol || '');
      var top = document.createElement('div');
      top.className = 'asset-top';
      var identity = document.createElement('div');
      identity.className = 'asset-id';
      if (coin.image) {
        var img = document.createElement('img');
        img.src = coin.image;
        img.alt = '';
        img.loading = 'lazy';
        identity.appendChild(img);
      } else {
        var fallback = document.createElement('span');
        fallback.className = 'asset-fallback';
        fallback.textContent = String(coin.symbol || '').slice(0,4);
        identity.appendChild(fallback);
      }
      var nameWrap = document.createElement('div');
      var name = document.createElement('span');
      name.className = 'asset-name';
      name.textContent = coin.name || 'Digital asset';
      var symbol = document.createElement('span');
      symbol.className = 'asset-symbol';
      symbol.textContent = String(coin.symbol || '').toUpperCase();
      nameWrap.append(name,symbol);
      identity.appendChild(nameWrap);
      var arrow = document.createElement('span');
      arrow.className = 'asset-arrow';
      arrow.textContent = '↗';
      top.append(identity,arrow);
      var price = document.createElement('span');
      price.className = 'asset-price';
      price.textContent = money(coin.price);
      var pct = Number(coin.change24h);
      var movement = document.createElement('span');
      movement.className = 'asset-change ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat');
      movement.textContent = changeText(coin.change24h) + ' (24h)';
      var action = document.createElement('span');
      action.className = 'asset-action';
      action.textContent = 'View asset details →';
      link.append(top,price,movement,action);
      host.appendChild(link);
    });
  }

  function render() {
    var query = search ? search.value.trim().toLowerCase() : '';
    var filtered = latest.filter(function (coin) {
      return !query || String(coin.name || '').toLowerCase().includes(query) ||
        String(coin.symbol || '').toLowerCase().includes(query);
    });
    renderTable(filtered);
    renderMovers();
    renderPopular();
    var stamp = document.getElementById('marketUpdated');
    if (stamp && updatedAt) stamp.textContent = 'Updated ' + updatedAt.toLocaleTimeString();
  }

  function loadMarkets() {
    fetch('/api/markets', { cache: 'no-store', headers: { 'Accept': 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('Market API returned HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) throw new Error('Market API returned invalid data');
        latest = data;
        updatedAt = new Date();
        render();
      })
      .catch(function (error) {
        console.error('CoinWave market load failed:', error);
        if (rows && !latest.length) {
          rows.textContent = '';
          var tr = document.createElement('tr');
          var td = cell(tr, 'Market data is temporarily unavailable. Please retry shortly.', 'state');
          td.colSpan = 4;
          rows.appendChild(tr);
        }
        ['topGainers','topLosers','popularAssets'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el && !el.children.length) el.textContent = 'Market data is temporarily unavailable.';
        });
        var stamp = document.getElementById('marketUpdated');
        if (stamp) stamp.textContent = 'Market update delayed';
      });
  }

  if (search) search.addEventListener('input', render);
  loadMarkets();
  timer = setInterval(function () {
    if (!document.hidden) loadMarkets();
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) loadMarkets();
  });
})();