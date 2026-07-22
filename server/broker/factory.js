/**
 * Broker factory — trả adapter theo BROKER_MODE env.
 * Mặc định 'paper' (safe). Live cần explicit env.
 */
let _instance = null;

function getBroker() {
  if (_instance) return _instance;
  const mode = process.env.BROKER_MODE || 'paper';
  switch (mode) {
    case 'ssi':
      const { SSIBroker } = require('./ssi');
      _instance = new SSIBroker();
      break;
    case 'dnse':
      const { DNSEBroker } = require('./dnse');
      _instance = new DNSEBroker();
      break;
    case 'paper':
    default:
      const { PaperBroker } = require('./paper');
      _instance = new PaperBroker();
      break;
  }
  console.log(`🏦 [broker] mode=${_instance.mode} (${mode})`);
  return _instance;
}

/** Test hook: reset singleton (cho unit test). */
function _reset() { _instance = null; }

function currentMode() { return process.env.BROKER_MODE || 'paper'; }

module.exports = { getBroker, currentMode, _reset };
