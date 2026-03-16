// Tidal ID — Content Script
// Shows a floating "Search Tidal" button when text is selected

let tidalPopupBtn = null;

function removePopup() {
  if (tidalPopupBtn) {
    tidalPopupBtn.remove();
    tidalPopupBtn = null;
  }
}

document.addEventListener('mouseup', (e) => {
  if (tidalPopupBtn && tidalPopupBtn.contains(e.target)) return;

  setTimeout(async () => {
    const { selectionPopup = true } = await chrome.storage.local.get('selectionPopup');
    if (!selectionPopup) return;

    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2) {
      removePopup();
      return;
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    removePopup();

    tidalPopupBtn = document.createElement('button');
    tidalPopupBtn.id = 'tidal-id-popup';
    tidalPopupBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="3" width="20" height="4.5" rx="2.25"/>
        <rect x="2" y="10" width="15" height="4.5" rx="2.25"/>
        <rect x="2" y="17" width="10" height="4.5" rx="2.25"/>
      </svg>
      Search Tidal
    `;

    // Position below and centered on the selection
    const btnEstimatedWidth = 140;
    const x = Math.max(
      window.scrollX + 8,
      Math.min(
        rect.left + window.scrollX + rect.width / 2 - btnEstimatedWidth / 2,
        window.scrollX + document.documentElement.clientWidth - btnEstimatedWidth - 8
      )
    );
    const y = rect.bottom + window.scrollY + 8;

    tidalPopupBtn.style.left = `${x}px`;
    tidalPopupBtn.style.top = `${y}px`;

    const capturedText = text;
    tidalPopupBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      chrome.runtime.sendMessage({ type: 'OPEN_RESULTS', query: capturedText });
      removePopup();
    });

    document.body.appendChild(tidalPopupBtn);
  }, 20);
});

document.addEventListener('mousedown', (e) => {
  if (tidalPopupBtn && !tidalPopupBtn.contains(e.target)) {
    removePopup();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') removePopup();
});
