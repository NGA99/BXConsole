/**
 * Shared behaviour for the A -> B -> C test pages.
 *
 * Each page can open the next one in a real window and can install the agent
 * into itself. Installing in B or C is the interesting case: the agent walks
 * window.opener upwards, so the windows above join the same session and the
 * console shows them as tabs of one run.
 *
 * Everything here is test scaffolding; the agent itself does the real work.
 */
/**
 * The agent's handle is named by the run's `mark` (default __wv), so it is
 * found by shape rather than by name.
 */
function findAgent(win) {
  const w = win || window;
  try {
    return Object.keys(w)
      .map((k) => w[k])
      .find((v) => v && typeof v === 'object' && v.sessionId && v.tabId);
  } catch {
    return undefined; // cross-origin
  }
}

(function () {
  const step = document.body.dataset.step;
  const next = document.body.dataset.next || '';
  const relay = new URLSearchParams(location.search).get('relay') || 'http://localhost:7331';

  document.title = `${step} — chain test`;
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<h1>${step}</h1>
     <p class="who">This window is <b>${step}</b> of the chain.</p>
     <div class="row">
       ${next ? `<button id="open-next">${next.replace('chain-', '').replace('.html', '').toUpperCase()}  window</button>` : '<span class="muted">End of the chain.</span>'}
       <button id="install">Install the agent here</button>
     </div>
     <div class="row">
       <button id="log">console.log</button>
       <button id="net">fetch</button>
       <button id="err">Throw an error</button>
     </div>
     <pre id="state">checking…</pre>`,
  );

  const stateEl = document.getElementById('state');

  function render() {
    const b = findAgent();
    let openerInfo = 'none (top-level window, or the opener link was cut)';
    try {
      const op = window.opener;
      if (op && !op.closed) {
        const oa = findAgent(op);
        openerInfo = oa ? `agent present · tab ${oa.tabId}` : 'no agent';
      }
    } catch {
      openerInfo = 'cross-origin, cannot read it';
    }
    stateEl.textContent = [
      `page        ${location.pathname.split('/').pop()}`,
      `agent       ${b ? 'installed' : 'none'}`,
      `session     ${b ? b.sessionId : '-'}`,
      `this window ${b ? b.tabId : '-'}`,
      `opened by   ${openerInfo}`,
      `relay       ${relay}`,
    ].join('\n');
  }

  const openNext = document.getElementById('open-next');
  if (openNext) {
    openNext.onclick = () => {
      // A plain window.open from a click: the new window keeps its opener, which
      // is what lets the agent climb back up later.
      const w = window.open(next + location.search, '_blank');
      if (!w) stateEl.textContent = 'The popup was blocked. Allow popups for this site.';
    };
  }

  document.getElementById('install').onclick = async (ev) => {
    const btn = ev.currentTarget;
    if (findAgent()) return;
    btn.disabled = true;
    btn.textContent = 'installing…';
    try {
      await import(`${relay}/agent.js?name=chain`);
    } catch (err) {
      stateEl.textContent = `Could not load the agent: ${err}\nCheck that the relay is running at ${relay}.`;
      btn.disabled = false;
      btn.textContent = 'Install the agent here';
      return;
    }
    btn.textContent = 'installed';
  };

  document.getElementById('log').onclick = () => console.log(`logged from ${step}`, { at: Date.now() });
  document.getElementById('net').onclick = () => fetch(`./data.json?from=${step}`).catch(() => {});
  document.getElementById('err').onclick = () => {
    throw new Error(`thrown from ${step}`);
  };

  render();
  setInterval(render, 500);
})();
