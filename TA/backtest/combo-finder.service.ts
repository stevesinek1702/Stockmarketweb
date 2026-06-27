/**
 * Combo Finder Service — Generate combo chi bao de brute-force backtest
 * Combos = AND cua 2-4 conditions tu cac bucket: RSI, MACD, Volume, ADX, MA, Price Action
 * ADX nhan manh: nhieu combo ADX-based vi day la chi bao xu huong on dinh
 */

import type { Combo, ComboCondition } from './full-backtest.service.js';

interface NamedCondition {
  shortName: string;
  condition: ComboCondition;
  category: string;
}

// ═══════════════════════════════════════════════════
// CONDITION POOLS
// ═══════════════════════════════════════════════════

const RSI_CONDITIONS: NamedCondition[] = [
  { shortName: 'RSI<30',     condition: { indicator: 'rsi', operator: '<', value: 30 }, category: 'rsi' },
  { shortName: 'RSI<40',     condition: { indicator: 'rsi', operator: '<', value: 40 }, category: 'rsi' },
  { shortName: 'RSI<50',     condition: { indicator: 'rsi', operator: '<', value: 50 }, category: 'rsi' },
  { shortName: 'RSI>50',     condition: { indicator: 'rsi', operator: '>', value: 50 }, category: 'rsi' },
  { shortName: 'RSI>60',     condition: { indicator: 'rsi', operator: '>', value: 60 }, category: 'rsi' },
  { shortName: 'RSI>70',     condition: { indicator: 'rsi', operator: '>', value: 70 }, category: 'rsi' },
];

const MACD_CONDITIONS: NamedCondition[] = [
  { shortName: 'MACD hist>0',      condition: { indicator: 'macd_hist', operator: '>', value: 0 }, category: 'macd' },
  { shortName: 'MACD cross up',    condition: { indicator: 'macd_cross_up', operator: '>', value: 0 }, category: 'macd' },
  { shortName: 'MACD hist 3d up',  condition: { indicator: 'macd_hist_rising_3d', operator: '>', value: 0 }, category: 'macd' },
];

const VOLUME_CONDITIONS: NamedCondition[] = [
  { shortName: 'Vol>1.5x',     condition: { indicator: 'volume_ratio', operator: '>', value: 1.5 }, category: 'volume' },
  { shortName: 'Vol>2x',       condition: { indicator: 'volume_ratio', operator: '>', value: 2.0 }, category: 'volume' },
  { shortName: 'Vol>3x',       condition: { indicator: 'volume_ratio', operator: '>', value: 3.0 }, category: 'volume' },
  { shortName: 'Vol 3d up',    condition: { indicator: 'volume_rising_3d', operator: '>', value: 0 }, category: 'volume' },
];

// ADX nhan manh — chi bao xu huong, anh Si quan tam
const ADX_CONDITIONS: NamedCondition[] = [
  { shortName: 'ADX>20',         condition: { indicator: 'adx', operator: '>', value: 20 }, category: 'adx' },
  { shortName: 'ADX>25',         condition: { indicator: 'adx', operator: '>', value: 25 }, category: 'adx' },
  { shortName: 'ADX>30',         condition: { indicator: 'adx', operator: '>', value: 30 }, category: 'adx' },
  { shortName: 'ADX 3d up',      condition: { indicator: 'adx_rising_3d', operator: '>', value: 0 }, category: 'adx' },
  { shortName: 'DI+>DI-',        condition: { indicator: 'di_plus_above_minus', operator: '>', value: 0 }, category: 'adx' },
  { shortName: 'DI diff>10',     condition: { indicator: 'di_plus_strong', operator: '>', value: 10 }, category: 'adx' },
  { shortName: 'DI diff>15',     condition: { indicator: 'di_plus_strong', operator: '>', value: 15 }, category: 'adx' },
];

const MA_ABOVE_CONDITIONS: NamedCondition[] = [
  { shortName: '>MA10',  condition: { indicator: 'price_above_ma', operator: '>', value: 0, period: 10 },  category: 'ma_above' },
  { shortName: '>MA20',  condition: { indicator: 'price_above_ma', operator: '>', value: 0, period: 20 },  category: 'ma_above' },
  { shortName: '>MA50',  condition: { indicator: 'price_above_ma', operator: '>', value: 0, period: 50 },  category: 'ma_above' },
  { shortName: '>MA100', condition: { indicator: 'price_above_ma', operator: '>', value: 0, period: 100 }, category: 'ma_above' },
  { shortName: '>MA150', condition: { indicator: 'price_above_ma', operator: '>', value: 0, period: 150 }, category: 'ma_above' },
  { shortName: '>MA200', condition: { indicator: 'price_above_ma', operator: '>', value: 0, period: 200 }, category: 'ma_above' },
];

const MA_CROSS_CONDITIONS: NamedCondition[] = [
  { shortName: 'MA10>MA20',  condition: { indicator: 'ma_cross_above', operator: '>', value: 20,  period: 10 }, category: 'ma_cross' },
  { shortName: 'MA20>MA50',  condition: { indicator: 'ma_cross_above', operator: '>', value: 50,  period: 20 }, category: 'ma_cross' },
  { shortName: 'MA10>MA50',  condition: { indicator: 'ma_cross_above', operator: '>', value: 50,  period: 10 }, category: 'ma_cross' },
  { shortName: 'MA50>MA100', condition: { indicator: 'ma_cross_above', operator: '>', value: 100, period: 50 }, category: 'ma_cross' },
  { shortName: 'MA50>MA150', condition: { indicator: 'ma_cross_above', operator: '>', value: 150, period: 50 }, category: 'ma_cross' },
  { shortName: 'MA50>MA200', condition: { indicator: 'ma_cross_above', operator: '>', value: 200, period: 50 }, category: 'ma_cross' },
  { shortName: 'MA stack hoan hao', condition: { indicator: 'ma_stack_perfect', operator: '>', value: 0 }, category: 'ma_stack' },
];

const PRICE_ACTION_CONDITIONS: NamedCondition[] = [
  { shortName: 'Breakout 20D', condition: { indicator: 'breakout_20d_high', operator: '>', value: 0 }, category: 'price_action' },
  { shortName: 'Breakout 50D', condition: { indicator: 'breakout_50d_high', operator: '>', value: 0 }, category: 'price_action' },
  { shortName: 'Gap up 2%',    condition: { indicator: 'gap_up_2pct', operator: '>', value: 0 }, category: 'price_action' },
];

// ═══════════════════════════════════════════════════
// COMBO GENERATOR
// ═══════════════════════════════════════════════════

export function generateCombos(): Combo[] {
  const combos: Combo[] = [];

  // ─── 1. Single indicator (baseline) ───
  for (const c of [...RSI_CONDITIONS, ...MACD_CONDITIONS, ...VOLUME_CONDITIONS, ...ADX_CONDITIONS]) {
    combos.push(buildCombo([c]));
  }
  for (const c of MA_ABOVE_CONDITIONS) combos.push(buildCombo([c]));
  for (const c of MA_CROSS_CONDITIONS) combos.push(buildCombo([c]));
  for (const c of PRICE_ACTION_CONDITIONS) combos.push(buildCombo([c]));

  // ─── 2. Oversold reversal (RSI + MACD) ───
  combos.push(buildCombo([RSI_CONDITIONS[0], MACD_CONDITIONS[1]]));
  combos.push(buildCombo([RSI_CONDITIONS[0], MACD_CONDITIONS[2]]));
  combos.push(buildCombo([RSI_CONDITIONS[1], MACD_CONDITIONS[1]]));
  combos.push(buildCombo([RSI_CONDITIONS[1], MACD_CONDITIONS[0]]));

  // ─── 3. Volume confirmation ───
  combos.push(buildCombo([VOLUME_CONDITIONS[0], MACD_CONDITIONS[1]]));
  combos.push(buildCombo([VOLUME_CONDITIONS[1], MACD_CONDITIONS[1]]));
  combos.push(buildCombo([VOLUME_CONDITIONS[1], RSI_CONDITIONS[0]]));
  combos.push(buildCombo([VOLUME_CONDITIONS[3], MACD_CONDITIONS[2]]));

  // ─── 4. ADX trend strength (NHAN MANH theo yeu cau anh Si) ───
  combos.push(buildCombo([ADX_CONDITIONS[0], ADX_CONDITIONS[4]]));   // ADX>20 + DI+>DI-
  combos.push(buildCombo([ADX_CONDITIONS[1], ADX_CONDITIONS[4]]));   // ADX>25 + DI+>DI-
  combos.push(buildCombo([ADX_CONDITIONS[2], ADX_CONDITIONS[4]]));   // ADX>30 + DI+>DI-
  combos.push(buildCombo([ADX_CONDITIONS[1], ADX_CONDITIONS[5]]));   // ADX>25 + DI diff>10
  combos.push(buildCombo([ADX_CONDITIONS[2], ADX_CONDITIONS[6]]));   // ADX>30 + DI diff>15
  combos.push(buildCombo([ADX_CONDITIONS[3], ADX_CONDITIONS[4]]));   // ADX 3d up + DI+>DI-
  combos.push(buildCombo([ADX_CONDITIONS[3], ADX_CONDITIONS[5]]));   // ADX 3d up + DI diff>10

  // ─── 5. ADX + Price action ───
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[2], ADX_CONDITIONS[1]]));      // >MA50 + ADX>25
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[2], ADX_CONDITIONS[2]]));      // >MA50 + ADX>30
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[4], ADX_CONDITIONS[1]]));      // >MA150 + ADX>25
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], ADX_CONDITIONS[1]]));      // >MA200 + ADX>25
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], ADX_CONDITIONS[2]]));      // >MA200 + ADX>30
  combos.push(buildCombo([MA_CROSS_CONDITIONS[2], ADX_CONDITIONS[1]]));      // MA10>MA50 + ADX>25
  combos.push(buildCombo([MA_CROSS_CONDITIONS[6], ADX_CONDITIONS[1]]));      // Stack + ADX>25
  combos.push(buildCombo([MA_CROSS_CONDITIONS[6], MACD_CONDITIONS[1]]));     // Stack + MACD cross

  // ─── 6. ADX + Volume ───
  combos.push(buildCombo([ADX_CONDITIONS[1], VOLUME_CONDITIONS[0]]));        // ADX>25 + Vol>1.5
  combos.push(buildCombo([ADX_CONDITIONS[2], VOLUME_CONDITIONS[1]]));        // ADX>30 + Vol>2
  combos.push(buildCombo([ADX_CONDITIONS[4], VOLUME_CONDITIONS[1]]));        // DI+>DI- + Vol>2
  combos.push(buildCombo([ADX_CONDITIONS[5], VOLUME_CONDITIONS[0]]));        // DI diff>10 + Vol>1.5

  // ─── 7. ADX + MACD ───
  combos.push(buildCombo([ADX_CONDITIONS[1], MACD_CONDITIONS[0]]));          // ADX>25 + MACD>0
  combos.push(buildCombo([ADX_CONDITIONS[1], MACD_CONDITIONS[1]]));          // ADX>25 + MACD cross
  combos.push(buildCombo([ADX_CONDITIONS[3], MACD_CONDITIONS[0]]));          // ADX 3d up + MACD>0

  // ─── 8. 3-condition confluence ───
  combos.push(buildCombo([RSI_CONDITIONS[0], MACD_CONDITIONS[1], VOLUME_CONDITIONS[0]]));
  combos.push(buildCombo([RSI_CONDITIONS[0], MACD_CONDITIONS[1], VOLUME_CONDITIONS[1]]));
  combos.push(buildCombo([RSI_CONDITIONS[1], MACD_CONDITIONS[1], VOLUME_CONDITIONS[0]]));
  combos.push(buildCombo([RSI_CONDITIONS[1], MACD_CONDITIONS[0], VOLUME_CONDITIONS[0]]));
  combos.push(buildCombo([RSI_CONDITIONS[3], MACD_CONDITIONS[0], MA_ABOVE_CONDITIONS[2]]));

  // ─── 9. ADX 3-confluence (NHAN MANH) ───
  combos.push(buildCombo([ADX_CONDITIONS[1], ADX_CONDITIONS[4], MACD_CONDITIONS[0]]));        // ADX>25 + DI+>DI- + MACD>0
  combos.push(buildCombo([ADX_CONDITIONS[2], ADX_CONDITIONS[4], MA_ABOVE_CONDITIONS[2]]));    // ADX>30 + DI+>DI- + >MA50
  combos.push(buildCombo([ADX_CONDITIONS[1], ADX_CONDITIONS[5], MACD_CONDITIONS[1]]));        // ADX>25 + DI diff>10 + MACD cross
  combos.push(buildCombo([ADX_CONDITIONS[2], ADX_CONDITIONS[4], VOLUME_CONDITIONS[0]]));      // ADX>30 + DI+>DI- + Vol>1.5
  combos.push(buildCombo([ADX_CONDITIONS[3], ADX_CONDITIONS[5], MA_ABOVE_CONDITIONS[2]]));    // ADX 3d up + DI diff>10 + >MA50

  // ─── 10. Trend + momentum ───
  combos.push(buildCombo([MA_CROSS_CONDITIONS[6], MACD_CONDITIONS[1], VOLUME_CONDITIONS[0]]));
  combos.push(buildCombo([MA_CROSS_CONDITIONS[6], RSI_CONDITIONS[3], VOLUME_CONDITIONS[0]]));
  combos.push(buildCombo([MA_CROSS_CONDITIONS[6], ADX_CONDITIONS[1], ADX_CONDITIONS[4]]));
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[2], MACD_CONDITIONS[1], VOLUME_CONDITIONS[0]]));

  // ─── 11. Breakout patterns ───
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[0], VOLUME_CONDITIONS[1]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[0], VOLUME_CONDITIONS[2]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[0], MACD_CONDITIONS[0]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[0], MA_ABOVE_CONDITIONS[2]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[0], ADX_CONDITIONS[1]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[0], ADX_CONDITIONS[2]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[1], VOLUME_CONDITIONS[1]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[1], ADX_CONDITIONS[1]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[2], VOLUME_CONDITIONS[1]]));

  // ─── 12. 4-condition full stack ───
  combos.push(buildCombo([RSI_CONDITIONS[0], MACD_CONDITIONS[1], VOLUME_CONDITIONS[1], MA_ABOVE_CONDITIONS[2]]));
  combos.push(buildCombo([RSI_CONDITIONS[1], MACD_CONDITIONS[1], VOLUME_CONDITIONS[0], MA_CROSS_CONDITIONS[6]]));
  combos.push(buildCombo([PRICE_ACTION_CONDITIONS[0], VOLUME_CONDITIONS[1], MACD_CONDITIONS[0], MA_ABOVE_CONDITIONS[2]]));
  combos.push(buildCombo([MA_CROSS_CONDITIONS[6], ADX_CONDITIONS[1], MACD_CONDITIONS[0], VOLUME_CONDITIONS[0]]));
  combos.push(buildCombo([MA_CROSS_CONDITIONS[6], ADX_CONDITIONS[2], ADX_CONDITIONS[4], MACD_CONDITIONS[0]]));   // 4-stack ADX
  combos.push(buildCombo([RSI_CONDITIONS[0], ADX_CONDITIONS[3], VOLUME_CONDITIONS[1], MACD_CONDITIONS[1]]));     // RSI<30 + ADX 3d up + Vol>2 + MACD cross

  // ─── 13. Strong momentum ───
  combos.push(buildCombo([RSI_CONDITIONS[4], ADX_CONDITIONS[1], MA_ABOVE_CONDITIONS[2]]));
  combos.push(buildCombo([RSI_CONDITIONS[4], ADX_CONDITIONS[2], MA_CROSS_CONDITIONS[6]]));
  combos.push(buildCombo([RSI_CONDITIONS[4], MACD_CONDITIONS[2], VOLUME_CONDITIONS[0]]));
  combos.push(buildCombo([RSI_CONDITIONS[4], ADX_CONDITIONS[5], MA_ABOVE_CONDITIONS[2]]));   // RSI>60 + DI diff>10 + >MA50

  // ─── 14. Long-term trend filter ───
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], MACD_CONDITIONS[1]]));
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], RSI_CONDITIONS[0]]));
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], RSI_CONDITIONS[1]]));
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], MA_CROSS_CONDITIONS[2]]));
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[4], MA_ABOVE_CONDITIONS[5]]));
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], MA_CROSS_CONDITIONS[5]]));
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], ADX_CONDITIONS[1]]));
  combos.push(buildCombo([MA_ABOVE_CONDITIONS[5], ADX_CONDITIONS[1], ADX_CONDITIONS[4]]));   // >MA200 + ADX>25 + DI+>DI-

  // ─── 15. Mean reversion ───
  combos.push(buildCombo([RSI_CONDITIONS[0], MA_ABOVE_CONDITIONS[5]]));
  combos.push(buildCombo([RSI_CONDITIONS[1], MA_ABOVE_CONDITIONS[4]]));
  combos.push(buildCombo([RSI_CONDITIONS[1], MA_ABOVE_CONDITIONS[2], MACD_CONDITIONS[1]]));
  combos.push(buildCombo([RSI_CONDITIONS[1], MA_ABOVE_CONDITIONS[5], ADX_CONDITIONS[0]]));   // RSI<40 + >MA200 + ADX>20

  // De-dupe
  const seen = new Set<string>();
  const unique: Combo[] = [];
  for (const c of combos) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    unique.push(c);
  }

  console.log(`[ComboFinder] Generated ${unique.length} unique combos (ADX-focused)`);
  return unique;
}

function buildCombo(conds: NamedCondition[]): Combo {
  return {
    name: conds.map(c => c.shortName).join(' + '),
    conditions: conds.map(c => c.condition),
  };
}
