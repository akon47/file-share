// Applies the saved (or system) theme before the first paint so there is no flash of the wrong theme.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('fs.theme');
  } catch {
    // storage blocked: fall back to the system setting
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (theme === 'dark') document.documentElement.classList.add('dark-theme');
})();
