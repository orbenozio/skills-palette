// Skills Palette - injected webview script.
// Runs inside the Claude Code panel DOM (appended to webview/index.js by the host
// extension). Wrapped in an IIFE so it never pollutes Claude's globals.
//
// It docks a plug/skills button into the SHARED toolbar div (#orb-tools) in the footer.
// The button is a REAL <a href="vscode://..."> link: a genuine user click on it is
// intercepted by VSCode's built-in webview link handler and routed to env.openExternal
// -> our UriHandler -> open the palette. The link MUST be a real element the user clicks
// directly - a *synthesized* a.click() arrives with event.view === null, so VSCode's
// handler bails and the sandboxed frame self-navigates to the vscode: URI, blanking
// Claude's chat AND never opening the palette. (This was the bug: a <button> that
// synthesized an anchor click.) The status-bar item + command palette are the fallback.
//
// The button is an OPTIMISTIC toggle: it keeps its own lit flag and is the source of
// truth. Each click flips the flag, lights/dims the button, and tells the HOST the
// DESIRED state via the link's ?on=1|0 query - the host obeys it instead of deciding
// for itself, so button and panel stay in lockstep. There's no host->Claude-webview
// channel, so closing the palette tab BY HAND can't dim the button; the next click
// sends on=0, the host sees it's already closed and just clears the stale lit. The ?t
// nonce keeps each openExternal unique so VSCode never coalesces a repeat click.
(function () {
  'use strict';

  if (window.__SKILLS_PALETTE_ACTIVE__) return;
  window.__SKILLS_PALETTE_ACTIVE__ = true;

  // Authority MUST equal the manifest's "<publisher>.<name>" lowercased.
  var BASE_URI = 'vscode://orbenozio.claude-code-skills-palette/open';

  var FOOTER_SEL = '[class*="inputFooter_"]';
  var MODE_BTN_SEL = '[class*="footerButtonPrimary_"]';

  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }

  // Best-effort: discover the current workspace path so the host links into the
  // RIGHT project even across multiple windows. webview/index.js is a single file
  // shared by every VS Code window, so we can't template a path in - we must read
  // it at click time. Claude's sandbox doesn't expose the workspace reliably, so
  // this usually returns null; when it does, the host falls back to the FOCUSED
  // window's workspace (this window - the one the user clicked in), which is correct.
  function discoverWorkspace() {
    try {
      var hints = [
        window.__workspaceFolder,
        window.workspaceFolder,
        (window.acquireVsCodeApi && window.__vscodeState && window.__vscodeState.workspace),
      ];
      for (var i = 0; i < hints.length; i++) {
        if (typeof hints[i] === 'string' && hints[i]) return hints[i];
      }
    } catch (e) {}
    return null;
  }

  // A fresh, unique URI carrying the DESIRED open state (on=1 open, on=0 close). The ?t
  // nonce keeps each openExternal distinct so VSCode never coalesces a repeated click
  // into a no-op. Carries ?ws so the host links into the right project when known.
  function openUri(on) {
    var uri = BASE_URI + '?t=' + Date.now() + '&on=' + (on ? '1' : '0');
    var ws = discoverWorkspace();
    if (ws) uri += '&ws=' + encodeURIComponent(ws);
    return uri;
  }

  // Shared toolbar: reuse #orb-tools if present, else create + dock left of Claude's
  // native mode button (fall back to the footer end). Re-query every call - Claude
  // re-renders the footer and detaches it.
  function ensureToolbar() {
    var existing = document.getElementById('orb-tools');
    if (existing && existing.isConnected) return existing;
    var footer = $(FOOTER_SEL);
    if (!footer) return null;
    var bar = existing || document.createElement('div');
    bar.id = 'orb-tools';
    bar.style.cssText = 'display:inline-flex;align-items:center;gap:2px;';
    var modeBtn = footer.querySelector(MODE_BTN_SEL);
    var modeContainer = modeBtn ? modeBtn.parentElement : null;
    if (modeContainer && modeContainer.parentNode) {
      modeContainer.parentNode.insertBefore(bar, modeContainer);
    } else {
      footer.appendChild(bar);
    }
    return bar;
  }

  function ensureStyle() {
    if (document.getElementById('claude-code-skills-palette-style')) return;
    var st = document.createElement('style');
    st.id = 'claude-code-skills-palette-style';
    st.textContent =
      '#claude-code-skills-palette-btn{display:inline-flex;align-items:center;background:transparent;border:none;cursor:pointer;' +
      'padding:3px 6px;line-height:0;vertical-align:middle;border-radius:6px;text-decoration:none;' +
      'color:#8a8a8a;opacity:.6;transition:color .15s,opacity .15s,background .15s;}' +
      '#claude-code-skills-palette-btn svg{display:block;width:18px;height:18px;}' +
      '#claude-code-skills-palette-btn:hover{opacity:1;color:#6ea8fe;background:rgba(110,168,254,.16);}' +
      '#claude-code-skills-palette-btn.on{opacity:1;color:#6ea8fe;background:rgba(110,168,254,.22);}' +
      '#claude-code-skills-palette-btn:active{transform:scale(.92);}';
    document.head.appendChild(st);
  }

  // Optimistic "lit" state: the palette lives in a separate (host-owned) webview, so
  // there is no host->button channel. The button toggles its own lit class in lockstep
  // with the strict open/close toggle on the host. (Caveat: closing the palette via
  // its editor tab can't notify the button; the next click re-syncs.)
  var paletteOn = false;
  function applyLit() {
    var b = document.getElementById('claude-code-skills-palette-btn');
    if (b) {
      if (paletteOn) b.classList.add('on'); else b.classList.remove('on');
      b.setAttribute('aria-pressed', paletteOn ? 'true' : 'false');
    }
  }

  // Refresh the link's href to a fresh URI carrying the DESIRED next state (the opposite
  // of the current lit flag). Done on pointer/key DOWN - i.e. BEFORE the click - so
  // VSCode's link interceptor reads the right URI for this activation.
  function aimHref() {
    var b = document.getElementById('claude-code-skills-palette-btn');
    if (b) b.setAttribute('href', openUri(!paletteOn));
  }

  function injectButton() {
    if (document.getElementById('claude-code-skills-palette-btn')) {
      var bar0 = ensureToolbar();
      var btn0 = document.getElementById('claude-code-skills-palette-btn');
      if (bar0 && btn0 && btn0.parentNode !== bar0) bar0.appendChild(btn0);
      applyLit(); // keep the lit state through footer re-renders
      return;
    }
    var bar = ensureToolbar();
    if (!bar) return;
    ensureStyle();

    // A REAL anchor - VSCode intercepts a genuine click on it and opens the vscode: URI
    // via openExternal, without the sandboxed frame ever navigating. (A <button> +
    // synthesized a.click() does NOT get intercepted and blanks the chat - see header.)
    var btn = document.createElement('a');
    btn.id = 'claude-code-skills-palette-btn';
    btn.setAttribute('role', 'button');
    btn.href = openUri(!paletteOn);
    btn.title = 'Open Skills Palette - link a skill from your hub to this project';
    btn.setAttribute('aria-label', 'Open Skills Palette');
    // Inline "plug" SVG (stroke via currentColor so it renders deterministically -
    // emoji render grey/inconsistently in the webview). The plug evokes the core
    // action: connecting a skill into the project.
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/>' +
      '<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>';

    // Refresh the href on pointer/key DOWN (fires before the click, so VSCode reads a
    // fresh unique URI) and keep the composer focused. Do NOT preventDefault or
    // stopPropagation on the CLICK - VSCode's handler must receive it to open the link
    // instead of letting the sandboxed frame self-navigate.
    btn.addEventListener('mousedown', function (e) {
      e.preventDefault(); // keep the message composer focused
      aimHref();
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') aimHref();
    });
    // Optimistic toggle, in lockstep with the desired state sent to the host above.
    btn.addEventListener('click', function () {
      paletteOn = !paletteOn;
      applyLit();
    });
    bar.appendChild(btn);
    applyLit(); // re-applied on every re-inject so the lit state survives re-renders
  }

  setInterval(injectButton, 1500);
  injectButton();
})();
