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
    tr.appendChild(td('num', fmtPrice(c.price)));
    var ch = change(c.change24h);
    tr.appendChild(td('num ' + ch.cls, ch.text));
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

  function load() {
    message('Loading markets', 'Fetching the latest prices.');
    fetch('/api/markets')
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { coins = d; render(); })
      .catch(function () { message('Prices are unavailable', 'Refresh the page in a minute.'); });
  }

  markHeads();
  search.addEventListener('input', render);
  document.getElementById('year').textContent = new Date().getFullYear();
  load();
  setInterval(function () {
    fetch('/api/markets').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { coins = d; render(); } }).catch(function () {});
  }, 60000);
})();
