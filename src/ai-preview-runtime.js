(() => {
  const assets = new URL('assets/', document.currentScript.src);

  function bundleUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, document.baseURI);
      return url.origin === assets.origin && url.pathname.startsWith(assets.pathname) ? url : null;
    } catch {
      return null;
    }
  }

  function report(kind, error) {
    window.parent.postMessage({
      type: 'hostfy-preview-error',
      kind,
      error: String(error).slice(0, 1000),
    }, '*');
  }

  window.addEventListener('error', event => {
    // CDN, extensões e outros scripts podem falhar com o app funcionando.
    if (event.target instanceof HTMLScriptElement && event.target.type === 'module') {
      const bundle = bundleUrl(event.target.src);
      if (bundle) report('load', 'Falha ao carregar ' + bundle.pathname.split('/').pop() + '.');
    } else if (event.message && bundleUrl(event.filename)) {
      report('runtime', event.message);
    }
  }, true);

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    if (typeof reason?.stack === 'string' && reason.stack.includes(assets.href)) {
      report('runtime', reason.message || reason);
    }
  });
})();
