/* Runs before React, the GIS bundles and local-record initialization. */
(() => {
  const boot = document.getElementById('geod-startup-boot');
  if (!boot) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__?.invoke(command, args);
  let resolveReady, finished;
  const state = window.__GEOD_STARTUP__ = {
    ready: new Promise(resolve => { resolveReady = resolve; }), startedAt: 0,
    finish() {
      if (finished) return finished;
      boot.classList.add('startup-boot--leaving');
      finished = new Promise(resolve => setTimeout(() => { boot.remove(); observer.disconnect(); resolve(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180));
      return finished;
    },
  };
  try {
    const language = JSON.parse(localStorage.getItem('geod-agent-language-v1') || '{}').language;
    const english = language === 'en' || language !== 'zh-CN' && !navigator.language.toLowerCase().startsWith('zh');
    if (english) {
      const copy = {welcome:'Welcome to GeoD Agent',description:'Explore geographic data through conversation.',caption:'Imagery · Vector · 3D'};
      for (const element of boot.querySelectorAll('[data-startup-text]')) element.textContent = copy[element.dataset.startupText];
      boot.lang = 'en';
    }
  } catch { /* A preference error cannot prevent the first screen. */ }
  for (const button of boot.querySelectorAll('[data-boot-window]')) button.addEventListener('click', () => { void invoke('plugin:window|' + button.dataset.bootWindow, {label:'main'})?.catch(() => {}); });
  boot.querySelector('.startup-boot-titlebar')?.addEventListener('mousedown', event => { if (event.button === 0 && !event.target.closest('button')) void invoke('plugin:window|start_dragging', {label:'main'})?.catch(() => {}); });
  const observer = new MutationObserver(() => { if (document.querySelector('#root .local-state-recovery')) void state.finish(); });
  observer.observe(document.getElementById('root'), {childList:true,subtree:true});
  // Hidden WebViews can suspend animation frames; the timeout prevents a
  // circular wait between first paint and showing the native window.
  let revealed = false;
  const reveal = async () => {
    if (revealed) return; revealed = true;
    try { await invoke('desktop_boot_ready', {}); } catch { /* Older development binaries remain usable. */ }
    state.startedAt = performance.now(); resolveReady();
  };
  requestAnimationFrame(() => requestAnimationFrame(reveal)); setTimeout(reveal, 80);
})();
