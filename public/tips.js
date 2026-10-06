// Rubrique « À savoir » : une notion de trading en quelques lignes, renouvelée toutes les 2 minutes.
(function () {
  const TIPS = [
    ['Lire une bougie', 'Corps = écart entre ouverture et clôture. Mèches = plus haut et plus bas atteints. Verte : clôture au-dessus de l’ouverture.'],
    ['Les mèches', 'Une longue mèche montre un prix rejeté : mèche haute = vendeurs présents, mèche basse = acheteurs présents.'],
    ['Le doji', 'Ouverture ≈ clôture : personne ne l’emporte. Après une longue hausse ou baisse, c’est souvent un signal d’hésitation.'],
    ['Support', 'Niveau où les acheteurs reviennent. Plus il a été testé sans casser, plus il compte — jusqu’au jour où il cède.'],
    ['Résistance', 'Niveau où les vendeurs reviennent. Une résistance cassée devient souvent un support (et inversement).'],
    ['Le range', 'Le prix oscille entre deux bornes. On achète près du bas, on vend près du haut, stop juste de l’autre côté.'],
    ['Fausse cassure', 'Le prix dépasse un niveau puis revient dedans. Attendre la clôture de la bougie évite beaucoup de pièges.'],
    ['Tendance', 'Haussière : sommets et creux de plus en plus hauts. Tant que la structure tient, on cherche des achats sur repli.'],
    ['RSI', 'Mesure la vitesse du mouvement (0 à 100). Au-dessus de 70 : surachat, sous 30 : survente. En forte tendance, il peut y rester.'],
    ['Moyennes mobiles', 'Prix au-dessus de la MM20 et MM20 au-dessus de la MM50 : dynamique haussière. Le croisement inverse signale un essoufflement.'],
    ['Bandes de Bollinger', 'Elles s’écartent quand la volatilité monte et se resserrent avant les gros mouvements. Un resserrement annonce souvent une cassure.'],
    ['Le volume', 'Une cassure avec un gros volume est plus crédible. Sans volume, méfiance : le mouvement peut vite s’essouffler.'],
    ['Le spread', 'Écart entre prix d’achat et de vente. On le paie à chaque entrée : une position démarre toujours légèrement perdante.'],
    ['Le pip', 'Plus petite variation de prix suivie : 0,01 $ sur le pétrole, 0,0001 sur l’EUR/USD. Les SL et TP se comptent en pips.'],
    ['Le lot', '1 lot de pétrole = 100 barils, 1 lot d’EUR/USD = 100 000 €. La taille fixe combien rapporte ou coûte chaque pip.'],
    ['Le levier', 'Il réduit la marge bloquée, pas le risque. Avec ×10, 1 % de mouvement contre vous = 10 % de la mise.'],
    ['La marge', 'Somme bloquée pour tenir une position. Si le compte ne la couvre plus, appel de marge, puis fermeture forcée à 50 %.'],
    ['Stop-loss', 'Il se place là où l’idée de trade devient fausse (sous un support, au-dessus d’une résistance), pas à un chiffre rond au hasard.'],
    ['Take-profit', 'Le placer avant un obstacle (résistance, sommet précédent) plutôt que juste après : le prix l’atteint plus souvent.'],
    ['Ratio gain / risque', 'Avec un ratio de 1 pour 2, on peut perdre 6 trades sur 10 et rester gagnant. Le taux de réussite ne fait pas tout.'],
    ['La règle des 1 %', 'Ne pas risquer plus de 1 à 2 % du capital par trade : 10 pertes d’affilée laissent encore 80 % du compte.'],
    ['Pertes et remontée', 'Perdre 50 % demande +100 % pour revenir à zéro. Protéger le capital passe avant la recherche du gain.'],
    ['Ordre limite', 'Achat sous le cours ou vente au-dessus : exécuté au prix choisi ou mieux, jamais de glissement.'],
    ['Ordre stop', 'Achat au-dessus du cours ou vente en dessous : sert à entrer sur une cassure. Il devient un ordre au marché et peut glisser.'],
    ['Le glissement', 'Écart entre le prix voulu et le prix obtenu. Il grossit avec la taille de l’ordre et quand le marché s’agite.'],
    ['Le carnet d’ordres', 'Il montre les quantités en attente à chaque prix. Un gros « mur » freine souvent le prix, mais il peut être retiré.'],
    ['Chasse aux stops', 'Les stops s’accumulent juste au-delà des sommets et des creux évidents. Le prix va souvent les chercher avant de repartir.'],
    ['Stop au prix d’entrée', 'Une fois en gain, remonter le stop au prix d’entrée rend la position sans risque. Trop tôt, il se fait toucher souvent.'],
    ['Stop suiveur', 'Le stop suit le prix à distance fixe et ne recule jamais. Idéal pour laisser courir une tendance.'],
    ['Clôture partielle', 'Encaisser la moitié au premier objectif sécurise un gain tout en gardant une part pour un mouvement plus long.'],
    ['Ne jamais éloigner son stop', 'Reculer un stop pour « laisser respirer » une position perdante transforme une petite perte en grosse perte.'],
    ['Le surtrading', 'Multiplier les trades multiplie les spreads payés. Les meilleurs traders attendent les configurations claires.'],
    ['Pétrole : le mercredi', 'Les stocks américains (EIA) sortent le mercredi à 16 h 30 : le pétrole peut bouger fortement en quelques minutes.'],
    ['Pétrole : l’OPEP', 'Les décisions de production de l’OPEP+ et les tensions géopolitiques font les plus gros mouvements du baril.'],
    ['L’or', 'Valeur refuge : il monte souvent quand l’inquiétude grimpe ou quand les taux réels baissent.'],
    ['EUR/USD et banques centrales', 'Les décisions de la BCE et de la Fed sur les taux font les plus forts mouvements de l’euro-dollar.'],
    ['L’emploi américain', 'Le rapport NFP, publié le premier vendredi du mois à 14 h 30, secoue le dollar, l’or et les indices.'],
    ['Les sessions', 'Le marché s’agite à l’ouverture de Londres (9 h) et de New York (15 h 30). La nuit asiatique est souvent plus calme.'],
    ['Le bitcoin', 'Il cote 24 h/24 et 7 j/7, avec une volatilité bien plus forte : d’où le levier limité à ×2 pour les particuliers.'],
    ['Fibonacci', 'Après un mouvement, les replis s’arrêtent souvent vers 38,2 %, 50 % ou 61,8 %. À croiser avec un support pour plus de fiabilité.'],
    ['Plusieurs unités de temps', 'Repérer la tendance en 5 minutes, entrer en 1 minute : on trade dans le sens du courant principal.'],
    ['Le plan de trade', 'Avant d’entrer : où est l’entrée, où est le stop, où est l’objectif. Sans ces trois réponses, on n’entre pas.'],
  ];
  const PERIOD = 120000;
  const $ = (id) => document.getElementById(id);
  let idx = 0;
  let timer = 0;
  try { idx = (Number(localStorage.getItem('duel.tip')) || Math.floor(Math.random() * TIPS.length)) % TIPS.length; } catch { /* indisponible */ }

  function show(i) {
    idx = (i + TIPS.length) % TIPS.length;
    try { localStorage.setItem('duel.tip', String((idx + 1) % TIPS.length)); } catch { /* indisponible */ }
    const [title, text] = TIPS[idx];
    $('tipTitle').textContent = title;
    $('tipText').textContent = text;
    $('tipNum').textContent = `${idx + 1} / ${TIPS.length}`;
    const bar = $('tipBar');
    bar.style.animation = 'none';
    void bar.offsetWidth; // relance la barre de progression
    bar.style.animation = `tipProgress ${PERIOD / 1000}s linear`;
    clearTimeout(timer);
    timer = setTimeout(() => show(idx + 1), PERIOD);
  }

  $('tipPrev').onclick = () => show(idx - 1);
  $('tipNext').onclick = () => show(idx + 1);
  show(idx);
})();
