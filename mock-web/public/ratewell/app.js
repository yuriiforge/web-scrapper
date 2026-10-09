// Ratewell client script: loads reviews into #reviews, one page per "Load more" click.
(function () {
  'use strict';

  // FNV-1a 32-bit in hex. Plain JS on purpose: crypto.subtle is unavailable over plain HTTP.
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (parts[i].slice(0, eq) === name) return decodeURIComponent(parts[i].slice(eq + 1));
    }
    return null;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Must match reviewHtml() in src/sites/ratewell.ts.
  function renderReview(r, layoutV2) {
    var rating = typeof r.rating === 'number' ? r.rating : parseInt(String(r.rating), 10);
    var article = el('article', 'review');
    article.setAttribute('data-id', r.id);
    var ratingEl = el('div', 'review-rating', rating + '/5');
    ratingEl.setAttribute('data-rating', String(rating));
    var time = el('time', null, r.created_at.slice(0, 10));
    time.setAttribute('datetime', r.created_at);
    var footer = el('footer');
    footer.append(el('span', 'review-author', r.author), ' ', el('span', 'review-country', r.country), ' ', time);
    article.append(ratingEl, el('h3', 'review-title', r.title), el('p', layoutV2 ? 'rv-text' : 'review-body', r.body), footer);
    return article;
  }

  var container = document.getElementById('reviews');
  var button = document.getElementById('load-more');
  if (!container) return;

  var slug = container.getAttribute('data-slug');
  var nonce = window.__RW && window.__RW.nonce;
  var sid = readCookie('rw_sid');
  var page = 0;
  var loading = false;

  function showError(message) {
    var note = document.getElementById('rw-error') || el('p', null);
    note.id = 'rw-error';
    note.textContent = message;
    container.after(note);
  }

  function loadNext() {
    if (loading) return;
    if (!nonce || !sid) return showError('Could not start a session. Please reload the page.');
    loading = true;
    if (button) button.disabled = true;

    var headers = { 'X-RW-Nonce': nonce, 'X-RW-Token': fnv1a(nonce + ':' + sid), Accept: 'application/json' };
    if (navigator.webdriver) headers['X-RW-Webdriver'] = '1';

    fetch('/ratewell/_data/company/' + encodeURIComponent(slug) + '/reviews?page=' + (page + 1), {
      headers: headers,
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        page += 1;
        var layoutV2 = Array.isArray(data.items);
        var list = layoutV2 ? data.items : data.reviews || [];
        for (var i = 0; i < list.length; i++) container.appendChild(renderReview(list[i], layoutV2));
        if (!data.has_more && button) {
          button.remove();
          button = null;
        }
      })
      .catch(function (err) {
        showError('Could not load reviews (' + err.message + ').');
      })
      .then(function () {
        loading = false;
        if (button) button.disabled = false;
      });
  }

  if (button) button.addEventListener('click', loadNext);
  loadNext();
})();
