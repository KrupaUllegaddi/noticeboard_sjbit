// Connect to our own server's live-update channel
const socket = io();

const noticesDiv = document.getElementById('notices');
const emptyMessage = document.getElementById('empty-message');

function renderNotice(notice) {
  if (emptyMessage) emptyMessage.remove();

  const el = document.createElement('div');
  el.className = 'notice';
  el.dataset.id = notice.id; // remembers which notice this card belongs to

  const time = new Date(notice.timestamp).toLocaleString();
  let mediaHtml = '';

  if (notice.mimetype.startsWith('image/')) {
    mediaHtml = `<img src="/downloads/${notice.filename}" alt="notice image" />`;
  } else if (notice.mimetype === 'application/pdf') {
    // #toolbar=0 hides the download/print bar, #navpanes=0 hides the
    // thumbnail sidebar — both are understood by Chrome/Edge's built-in
    // PDF viewer when added after the file URL like this.
    mediaHtml = `<iframe src="/downloads/${notice.filename}#toolbar=0&navpanes=0"></iframe>`;
  }

  el.innerHTML = `
    <button class="close-btn" title="Remove this notice">&times;</button>
    <div class="meta">${notice.sender} &middot; ${time}</div>
    ${notice.caption ? `<div class="caption">${notice.caption}</div>` : ''}
    ${mediaHtml}
  `;

  // Clicking the close button deletes it from the server, which then
  // tells every open tab (via 'removeNotice') to remove it visually.
  el.querySelector('.close-btn').addEventListener('click', () => {
    fetch(`/api/notices/${notice.id}`, { method: 'DELETE' }).catch((err) =>
      console.error('Failed to delete notice:', err)
    );
  });

  // Newest notice appears first
  noticesDiv.prepend(el);
}

function removeNoticeFromScreen(id) {
  const card = noticesDiv.querySelector(`[data-id="${id}"]`);
  if (card) card.remove();
}

// STEP A: When the page first loads, fetch everything that already exists
fetch('/api/notices')
  .then((res) => res.json())
  .then((notices) => notices.forEach(renderNotice))
  .catch((err) => console.error('Failed to load notices:', err));

// STEP B: From now on, listen for brand-new notices in real time —
// no page refresh needed, ever.
socket.on('newNotice', (notice) => {
  renderNotice(notice);
});

// STEP C: If a notice is deleted (by anyone, on any tab), remove it here too
socket.on('removeNotice', (id) => {
  removeNoticeFromScreen(id);
});