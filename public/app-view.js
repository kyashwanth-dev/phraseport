// app-view.js - moved from inline script in view.html
const form = document.getElementById('accessForm');
const out = document.getElementById('items');
const keyInput = document.getElementById('keyphrase');
const passInput = document.getElementById('passcode');

function showToast(message, type = 'info', timeout = 2200) {
  const toasts = document.getElementById('toasts');
  if (!toasts) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toasts.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px) scale(.98)';
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// restrict passcode to digits only
if (passInput) passInput.addEventListener('input', () => {
  passInput.value = passInput.value.replace(/\D/g, '').slice(0,4);
});

// prefill from query params if present
(function prefillFromQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    const k = params.get('keyphrase');
    const p = params.get('passcode');
    if (k) keyInput.value = k;
    if (p) passInput.value = p.slice(0,4);
    if (k && p) form.dispatchEvent(new Event('submit'));
  } catch (e) {}
})();

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const keyphrase = keyInput.value.trim();
    const passcode = passInput.value.trim();
    if (!/^\d{4}$/.test(passcode)) {
      out.innerHTML = '<p style="color:crimson">Passcode must be a 4-digit number.</p>';
      return;
    }
    out.innerHTML = '<div class="card">Loading…</div>';
    const res = await fetch(`/api/items?keyphrase=${encodeURIComponent(keyphrase)}&passcode=${encodeURIComponent(passcode)}`);
    const json = await res.json();
    if (!json.items || json.items.length === 0) {
      out.innerHTML = '<p>No items found for those credentials.</p>';
      return;
    }
    out.innerHTML = json.items.map(it => {
      const thumb = it.thumbnailUrl ? `<img src="${it.thumbnailUrl}" class="thumb" alt="thumb">` : '';
      const details = `
        <div class="item">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="display:flex;gap:12px;align-items:center">
              ${thumb}
              <div>
                <strong style="color:#fff">${it.title}</strong>
                <div class="meta">${it.type} • ${new Date(it.createdAt).toLocaleString()}</div>
              </div>
            </div>
            <div><a href="#" data-id="${it.id}">Open</a></div>
          </div>
          <div id="item-${it.id}" class="preview"></div>
        </div>`;
      return details;
    }).join('');

    // attach click handlers
    Array.from(document.querySelectorAll('a[data-id]')).forEach(a => {
      a.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const id = a.getAttribute('data-id');
        const res = await fetch(`/api/item/${id}?keyphrase=${encodeURIComponent(keyphrase)}&passcode=${encodeURIComponent(passcode)}`);
        const j = await res.json();
        const container = document.getElementById('item-' + id);
        container.innerHTML = '';
        if (j.type === 'file') {
          if (j.downloadUrl && j.title) {
            // if preview url available, server will provide via /api/item
            const ext = j.title.split('.').pop().toLowerCase();
            if (['png','jpg','jpeg','gif','webp','bmp'].includes(ext)) {
              const img = document.createElement('img');
              img.src = j.downloadUrl;
              img.className = 'thumb';
              container.appendChild(img);
              const dl = document.createElement('div');
              dl.innerHTML = `<a href="${j.downloadUrl}" target="_blank">Download ${j.title}</a>`;
              container.appendChild(dl);
            } else if (['mp4','webm','ogg','mov'].includes(ext)) {
              const v = document.createElement('video');
              v.src = j.downloadUrl;
              v.controls = true;
              v.className = 'thumb';
              container.appendChild(v);
            } else if (['mp3','wav','m4a'].includes(ext)) {
              const a = document.createElement('audio');
              a.src = j.downloadUrl;
              a.controls = true;
              container.appendChild(a);
            } else {
              container.innerHTML = `<a href="${j.downloadUrl}" target="_blank">Download ${j.title}</a>`;
            }
          }
        } else {
          container.innerHTML = `<pre>${j.text || ''}</pre>`;
        }
      });
    });
  });
}
