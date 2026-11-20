const api = window.bubble;
const box = document.getElementById('bubble');
const tail = document.getElementById('tail');
const PAGE_SIDE = 2; // Matches the page padding in bubble.css.
const PAGE_END = 10;

function applyPlace(place) {
  box.classList.toggle('below', place.side === 'below');
  tail.style.left = `${place.tailX - PAGE_SIDE}px`;
}

// Measure first, so the main process can size and place the window to fit.
api.onText(async (text) => {
  document.getElementById('text').textContent = text;
  const { width, height } = box.getBoundingClientRect();
  applyPlace(await api.size(Math.ceil(width) + PAGE_SIDE * 2, Math.ceil(height) + PAGE_END * 2));
  api.show();
});

api.onPlace(applyPlace);
box.addEventListener('click', () => api.click());
