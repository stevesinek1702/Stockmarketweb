/**
 * Regression preservation test — Task 11 (Feature: ui-ux-overhaul)
 *
 * The UI/UX overhaul is an explicitly NON-BREAKING, incremental enhancement.
 * Requirement 6 demands that the existing business functionality survive the
 * overhaul untouched. This test guards against accidental removal of the
 * stable structural / behavioural anchors during the cosmetic work.
 *
 * Strategy: the node test environment has no DOM, so we read the relevant
 * source files as text and assert that the load-bearing markers are still
 * present. These are intentionally robust substring/structure checks (not
 * brittle exact-formatting checks) so they only fail on a genuine regression.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve the repo root from this test file: js/__tests__/ -> js/ -> root
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const indexHtml = read('index.html');
const appJs = read('js/app.js');
const gridJs = read('js/grid-manager.js');

describe('Req 6.1 — 7 tabs and their data-tab values are preserved', () => {
  // The seven tabs of the application, in the order declared in the nav.
  const EXPECTED_TABS = [
    'dashboard',
    'price-board',
    'stock-filter',
    'industry',
    'breakout',
    'potential-stocks',
    'news',
  ];

  it('declares exactly the 7 expected data-tab buttons in the nav', () => {
    const found = [...indexHtml.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
    expect(found).toEqual(EXPECTED_TABS);
  });

  it.each(EXPECTED_TABS)('keeps a nav button with data-tab="%s"', (tab) => {
    expect(indexHtml).toContain(`data-tab="${tab}"`);
  });
});

describe('Req 6.2 — Gridstack drag/drop/resize structure is intact', () => {
  it('still loads the Gridstack library in index.html', () => {
    expect(indexHtml).toMatch(/gridstack[^"']*\.js/i);
  });

  it('grid-manager still initializes GridStack', () => {
    expect(gridJs).toContain('GridStack.init');
    // Guard against the integration being silently disabled.
    expect(gridJs).toContain("typeof GridStack === 'undefined'");
  });

  it('grid-manager still builds the .grid-stack / .grid-stack-item structure', () => {
    expect(gridJs).toContain("className = 'grid-stack'");
    expect(gridJs).toContain("className = 'grid-stack-item'");
    expect(gridJs).toContain("className = 'grid-stack-item-content'");
  });

  it('persists collapse/hide state keys (drag/resize/collapse/hide preserved)', () => {
    expect(gridJs).toContain("LAYOUT_KEY = 'vnstock_gridstack_layout_v1'");
    expect(gridJs).toContain("STATE_KEY = 'vnstock_gridstack_state_v1'");
  });
});

describe('Req 6.3 — filter / sort / search handlers remain intact', () => {
  it('keeps the price-board search input wiring (stock-search)', () => {
    expect(indexHtml).toContain('id="stock-search"');
    expect(appJs).toContain("getElementById('stock-search')");
  });

  it('keeps sortable column handling via data-sort', () => {
    expect(appJs).toContain("getAttribute('data-sort')");
  });

  it('keeps the price-board filter clearing handler', () => {
    expect(appJs).toContain('function clearAllPriceFilters');
  });

  it('keeps the stock-filter tab handlers (run + add condition)', () => {
    expect(appJs).toContain('function runStockFilter');
    expect(appJs).toContain('function addFilterCondition');
    expect(appJs).toContain('window.runStockFilter = runStockFilter');
  });

  it('openTradingViewModal still exists and now delegates to TVChart', () => {
    expect(appJs).toContain('function openTradingViewModal');
    expect(appJs).toContain('window.openTradingViewModal = openTradingViewModal');
    // The overhaul replaced the iframe widget with the Lightweight Charts module.
    expect(appJs).toMatch(/window\.TVChart\s*&&/);
    expect(appJs).toContain('window.TVChart.open(symbol, exchange)');
  });
});

describe('Req 6.4 / 6.5 — auto-refresh and localStorage keys are untouched', () => {
  it('keeps the price-board settings localStorage key', () => {
    expect(appJs).toContain("SAVED_SETTINGS_KEY = 'vnstock_priceboard_settings'");
  });

  it('keeps all three documented localStorage keys somewhere in the JS source', () => {
    const combined = appJs + gridJs;
    for (const key of [
      'vnstock_gridstack_layout_v1',
      'vnstock_gridstack_state_v1',
      'vnstock_priceboard_settings',
    ]) {
      expect(combined).toContain(key);
    }
  });

  it('still reads/writes the saved price-board settings (restore on load)', () => {
    expect(appJs).toContain('localStorage.getItem(SAVED_SETTINGS_KEY)');
  });
});
