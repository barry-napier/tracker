const { electron, chrome, node } = window.tracker.versions;
document.getElementById('versions').textContent =
  `Electron ${electron} · Chromium ${chrome} · Node ${node}`;
