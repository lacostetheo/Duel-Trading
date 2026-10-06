// "Did you know" panel: one market concept in a few lines, refreshed every two minutes.
(function () {
  const TIPS = [
    ['Reading a candle', 'Body = gap between open and close. Wicks = highest and lowest prices traded. Green: the close is above the open.'],
    ['Wicks', 'A long wick shows a rejected price: an upper wick means sellers stepped in, a lower wick means buyers did.'],
    ['The doji', 'Open ≈ close: nobody wins. After a long rally or sell-off, it often signals indecision.'],
    ['Support', 'A level where buyers come back. The more often it holds, the more it matters — until the day it breaks.'],
    ['Resistance', 'A level where sellers come back. A broken resistance often turns into support (and vice versa).'],
    ['Ranges', 'The price swings between two bounds. Buy near the bottom, sell near the top, with a stop just beyond the other side.'],
    ['False breakouts', 'The price pierces a level and comes straight back. Waiting for the candle to close avoids many traps.'],
    ['Trends', 'Uptrend: higher highs and higher lows. As long as that structure holds, look for buys on pullbacks.'],
    ['RSI', 'Measures the speed of a move (0 to 100). Above 70: overbought, below 30: oversold. In a strong trend it can stay there.'],
    ['Moving averages', 'Price above the 20 MA and the 20 above the 50: bullish momentum. The opposite cross signals a slowdown.'],
    ['Bollinger Bands', 'They widen as volatility rises and squeeze before big moves. A squeeze often precedes a breakout.'],
    ['Volume', 'A breakout on heavy volume is more credible. Without volume, be careful: the move can fade quickly.'],
    ['The spread', 'The gap between bid and ask. You pay it on every entry: a new position always starts slightly in the red.'],
    ['Pips', 'The smallest tracked price step: $0.01 on oil, 0.0001 on EUR/USD. Stops and targets are measured in pips.'],
    ['Lots', '1 lot of oil = 100 barrels, 1 lot of EUR/USD = €100,000. Size sets how much each pip earns or costs.'],
    ['Leverage', 'It reduces the margin you lock up, not the risk. At ×10, a 1% move against you costs 10% of the margin.'],
    ['Margin', 'The amount locked to hold a position. When equity no longer covers it: margin call, then forced liquidation at 50%.'],
    ['Stop-loss placement', 'Place it where your trade idea is proven wrong (below support, above resistance), not at a random round number.'],
    ['Take-profit placement', 'Set it just before an obstacle (resistance, previous high) rather than just after: it gets hit more often.'],
    ['Reward / risk', 'With a 1:2 ratio you can lose 6 trades out of 10 and still make money. Win rate is not everything.'],
    ['The 1% rule', 'Risk no more than 1–2% of your equity per trade: ten losses in a row still leave 80% of the account.'],
    ['Losses compound', 'Losing 50% takes a +100% gain to break even. Protecting capital comes before chasing returns.'],
    ['Limit orders', 'Buy below or sell above the market: filled at your price or better, never with slippage.'],
    ['Stop orders', 'Buy above or sell below the market to enter on a breakout. They become market orders and can slip.'],
    ['Slippage', 'The gap between the price you wanted and the price you got. It grows with order size and when markets move fast.'],
    ['The order book', 'It shows resting quantities at each price. A big “wall” often slows the price down, but it can be pulled.'],
    ['Stop hunts', 'Stops cluster just beyond obvious highs and lows. Price often sweeps them before reversing.'],
    ['Stop to entry', 'Once in profit, moving the stop to your entry makes the trade risk-free. Too early and it gets hit often.'],
    ['Trailing stops', 'The stop follows the price at a fixed distance and never moves back. Ideal for riding a trend.'],
    ['Partial closes', 'Banking half at the first target locks in a gain while keeping a share for a bigger move.'],
    ['Never widen a stop', 'Moving a stop further away to “give it room” turns a small loss into a large one.'],
    ['Overtrading', 'More trades means more spreads paid. The best traders wait for clear setups.'],
    ['Oil on Wednesdays', 'US crude inventories (EIA) are released on Wednesdays at 10:30 am New York time: oil can move sharply within minutes.'],
    ['Oil and OPEC', 'OPEC+ production decisions and geopolitical tensions drive the biggest moves in crude.'],
    ['Gold', 'A safe haven: it often rises when fear increases or when real interest rates fall.'],
    ['EUR/USD and central banks', 'ECB and Fed rate decisions drive the biggest moves in the euro-dollar.'],
    ['US jobs report', 'Nonfarm payrolls, released on the first Friday of the month, shake the dollar, gold and stock indices.'],
    ['Trading sessions', 'Markets wake up at the London (8 am) and New York (9:30 am) opens. The Asian session is often quieter.'],
    ['Bitcoin', 'It trades 24/7 with much higher volatility: hence leverage capped at ×2 for retail traders in Europe.'],
    ['Fibonacci', 'After a move, pullbacks often stall around 38.2%, 50% or 61.8%. Combine with a support level for confirmation.'],
    ['Multiple timeframes', 'Read the trend on 5 minutes, enter on 1 minute: you trade with the main current.'],
    ['The trade plan', 'Before entering: where is the entry, where is the stop, where is the target? Without all three, stay out.'],
  ];
  const PERIOD = 120000;
  const $ = (id) => document.getElementById(id);
  let idx = 0;
  let timer = 0;
  try { idx = (Number(localStorage.getItem('duel.tip')) || Math.floor(Math.random() * TIPS.length)) % TIPS.length; } catch { /* storage unavailable */ }

  function show(i) {
    idx = (i + TIPS.length) % TIPS.length;
    try { localStorage.setItem('duel.tip', String((idx + 1) % TIPS.length)); } catch { /* storage unavailable */ }
    const [title, text] = TIPS[idx];
    $('tipTitle').textContent = title;
    $('tipText').textContent = text;
    $('tipNum').textContent = `${idx + 1} / ${TIPS.length}`;
    const bar = $('tipBar');
    bar.style.animation = 'none';
    void bar.offsetWidth; // restart the progress bar
    bar.style.animation = `tipProgress ${PERIOD / 1000}s linear`;
    clearTimeout(timer);
    timer = setTimeout(() => show(idx + 1), PERIOD);
  }

  $('tipPrev').onclick = () => show(idx - 1);
  $('tipNext').onclick = () => show(idx + 1);
  show(idx);
})();
