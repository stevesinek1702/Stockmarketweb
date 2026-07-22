const { forwardReturn, isWin } = require('./label');
const { backtest, backtestSynthetic, aggregateMetrics } = require('./engine');
const { optimizeWeights, loadWeights, DEFAULT_WEIGHTS } = require('./optimize');
module.exports = { forwardReturn, isWin, backtest, backtestSynthetic, aggregateMetrics,
                   optimizeWeights, loadWeights, DEFAULT_WEIGHTS };
