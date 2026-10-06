// Couleurs de l'interface, lues dans base.css, pour les dessins du graphique (canvas).
(function () {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  window.Theme = {
    colors() {
      return {
        accent: css('--accent'),
        accentRgb: css('--accent-rgb'),
        amber: css('--amber-rgb'),
        green: css('--green'),
        red: css('--red'),
        greenRgb: css('--green-rgb'),
        redRgb: css('--red-rgb'),
        text: css('--text'),
        strong: css('--strong'),
        muted: css('--muted'),
        border: css('--grid'),
        surface: css('--surface-2'),
        font: css('--font'),
        fontNum: css('--font-num'),
      };
    },
  };
})();
