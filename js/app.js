(function () {
  var body = document.getElementById('rows');
  var search = document.getElementById('search');
  var coins = [];

  function fmtPrice(p) {
    if (p == null) return '—';
    if (p >= 1) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 0.01) return '$' + p.toFixed(4);
    return '$' + p.toFixed(8).replace(/0+$/, '');
  }

  function change(c) {
    if (c == null || Math.abs(c) < 0.005) return { text: '0.00%', cls: 'flat' };
    var up = c > 0;
    return { text: (up ? '+' : '−') + Math.abs(c).toFixed(2) + '%', cls: up ? 'up' : 'down' };
  }

  function td(cls, child) {
    var el = document.createElement('td');
    if (cls) el.className = cls;
    if (typeof child === 'string') el.textContent = child; else if (child) el.appendChild(child);
    return el;
  }

  function row(c) {
    var tr = document.createElement('tr');
    tr.appendChild(td('rank hide-sm', String(c.rank)));
    var box = document.createElement('div'); box.className = 'coin';
    var img = document.createElement('img'); img.src = c.image; img.alt = ''; img.loading = 'lazy';
    var txt = document.createElement('div');
    var n = document.createElement('div'); n.className = 'n'; n.textContent = c.name;
    var s = document.createElement('div'); s.className = 's'; s.textContent = c.symbol;
    txt.appendChild(n); txt.appendChild(s); box.appendChild(img); box.appendChild(txt);
    tr.appendChild(td('', box));
    c._p = td('num', fmtPrice(c.price));
    tr.appendChild(c._p);
    var ch = change(c.change24h);
    c._c = td('num ' + ch.cls, ch.text);
    tr.appendChild(c._c);
    return tr;
  }

  function message(title, text) {
    body.innerHTML = '';
    var tr = document.createElement('tr'), cell = document.createElement('td');
    cell.colSpan = 4; cell.className = 'state';
    var st = document.createElement('strong'); st.textContent = title;
    cell.appendChild(st); cell.appendChild(document.createTextNode(text));
    tr.appendChild(cell); body.appendChild(tr);
  }

  var sort = { key: 'rank', dir: 1 };
  var cols = ['rank', 'name', 'price', 'change24h'];
  var heads = document.querySelectorAll('thead th');

  function sortList(list) {
    var k = sort.key, d = sort.dir;
    return list.slice().sort(function (a, b) {
      var x = a[k], y = b[k];
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return x.localeCompare(y) * d;
      return (x - y) * d;
    });
  }

  function markHeads() {
    heads.forEach(function (th, i) {
      var label = th.getAttribute('data-label') || th.textContent.replace(/[▲▼\s]+$/, '');
      th.setAttribute('data-label', label);
      th.textContent = label + (cols[i] === sort.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');
      th.setAttribute('aria-sort', cols[i] === sort.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
    });
  }

  heads.forEach(function (th, i) {
    th.style.cursor = 'pointer';
    th.addEventListener('click', function () {
      var k = cols[i];
      if (sort.key === k) sort.dir = -sort.dir;
      else { sort.key = k; sort.dir = (k === 'rank' || k === 'name') ? 1 : -1; }
      markHeads();
      render();
    });
  });

  function render() {
    var q = search.value.trim().toLowerCase();
    var list = coins.filter(function (c) {
      return !q || c.name.toLowerCase().indexOf(q) > -1 || c.symbol.toLowerCase().indexOf(q) > -1;
    });
    list = sortList(list);
    if (!list.length) return message('No results', 'Try a different name or symbol.');
    body.innerHTML = '';
    list.forEach(function (c) { body.appendChild(row(c)); });
  }

  // ---- Real-time prices (Binance public stream, runs in the visitor's browser) ----
  var live = { ws: null, map: {}, urls: ['wss://stream.binance.com:443/ws/!miniTicker@arr', 'wss://data-stream.binance.vision/ws/!miniTicker@arr'], i: 0, tries: 0 };
  var dot = document.createElement('span');
  dot.textContent = 'Live';
  dot.style.cssText = 'display:none;margin-left:10px;font-size:13px;font-weight:500;color:#22C55E;vertical-align:middle';
  var h2 = document.querySelector('.section-head h2');
  if (h2) h2.appendChild(dot);

  function buildMap() {
    live.map = {};
    coins.slice().sort(function (a, b) { return a.rank - b.rank; }).forEach(function (c) {
      if (!live.map[c.symbol]) live.map[c.symbol] = c;
    });
  }

  function flash(el, up) {
    if (!el || !el.animate) return;
    el.animate([{ backgroundColor: up ? 'rgba(34,197,94,.28)' : 'rgba(239,68,68,.28)' }, { backgroundColor: 'rgba(0,0,0,0)' }], { duration: 800 });
  }

  function applyTick(t) {
    if (!t.s || t.s.slice(-4) !== 'USDT') return;
    var c = live.map[t.s.slice(0, -4)];
    if (!c) return;
    var p = parseFloat(t.c), o = parseFloat(t.o);
    if (!(p > 0) || !(o > 0)) return;
    var old = c.price;
    c.price = p; c.change24h = (p - o) / o * 100; c.live = true;
    if (c._p && c._p.isConnected) {
      c._p.textContent = fmtPrice(p);
      if (old != null && p !== old) flash(c._p, p > old);
      var ch = change(c.change24h);
      c._c.textContent = ch.text;
      c._c.className = 'num ' + ch.cls;
    }
  }

  function connect() {
    if (live.ws || !coins.length) return;
    var ws;
    try { ws = new WebSocket(live.urls[live.i % live.urls.length]); } catch (e) { return; }
    live.ws = ws;
    ws.onmessage = function (ev) {
      var arr; try { arr = JSON.parse(ev.data); } catch (e) { return; }
      if (!Array.isArray(arr)) return;
      live.tries = 0; dot.style.display = 'inline';
      arr.forEach(applyTick);
    };
    ws.onclose = ws.onerror = function () {
      if (live.ws !== ws) return;
      live.ws = null; dot.style.display = 'none';
      live.i++; live.tries++;
      setTimeout(connect, Math.min(30000, 2000 * live.tries));
    };
  }

  function setCoins(d) {
    var old = {};
    coins.forEach(function (c) { if (c.live) old[c.symbol] = c; });
    d.forEach(function (c) {
      var o = old[c.symbol];
      if (o) { c.price = o.price; c.change24h = o.change24h; c.live = true; }
    });
    coins = d; buildMap(); render(); connect();
  }

  function load() {
    message('Loading markets', 'Fetching the latest prices.');
    fetch('/api/markets')
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(setCoins)
      .catch(function () { message('Prices are unavailable', 'Refresh the page in a minute.'); });
  }

  markHeads();
  search.addEventListener('input', render);
  document.getElementById('year').textContent = new Date().getFullYear();
  load();
  setInterval(function () {
    fetch('/api/markets').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) setCoins(d); }).catch(function () {});
  }, 60000);
})();
