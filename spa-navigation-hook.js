(() => {
  if (window.top !== window.self) return;
  const EVENT = 'avd:history-navigation';
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function' || original.__avdWrapped) continue;
    const wrapped = function(...args) {
      const before = location.href;
      const result = original.apply(this, args);
      if (location.href !== before) document.dispatchEvent(new CustomEvent(EVENT));
      return result;
    };
    Object.defineProperty(wrapped, '__avdWrapped', { value:true });
    history[method] = wrapped;
  }
})();
