/**
 * Order model — chuẩn cho mọi broker adapter.
 * LO/ATO/ATC, side BUY/SELL, status lifecycle.
 */

const VALID = {
  side: ['BUY', 'SELL'],
  type: ['LO', 'ATO', 'ATC', 'MP'],
  status: ['pending', 'open', 'partial', 'filled', 'cancelled', 'rejected']
};

function validateOrder(o) {
  const errs = [];
  if (!VALID.side.includes(o.side)) errs.push('side invalid');
  if (!VALID.type.includes(o.type)) errs.push('type invalid');
  if (!o.symbol || typeof o.symbol !== 'string') errs.push('symbol missing');
  if (!Number.isInteger(o.qty) || o.qty <= 0 || o.qty % 100 !== 0)
    errs.push('qty phải lô chẵn 100 > 0');
  if (o.type === 'LO' && (!o.price || o.price <= 0)) errs.push('LO cần price > 0');
  return errs;
}

/**
 * Tạo order object chuẩn từ input.
 */
function createOrder(input) {
  const errs = validateOrder(input);
  if (errs.length) throw new Error('Order invalid: ' + errs.join(', '));
  return {
    id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    symbol: input.symbol.toUpperCase(),
    side: input.side,
    type: input.type,
    qty: input.qty,
    price: input.price || null,
    status: 'pending',
    filledQty: 0,
    fillPrice: null,
    createdAt: new Date().toISOString(),
    filledAt: null,
    brokerOrderId: null
  };
}

module.exports = { createOrder, validateOrder, VALID };
