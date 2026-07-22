/**
 * VN Settlement rules (T+2.5) — luật thanh toán chứng khoán VN.
 * Mua T0 → tiền+hàng về T+2.5 → bán sớm nhất T+3 (phiên giao dịch).
 *
 * Dùng cho backtest label (#3) + signal gen/risk (#4) + broker exec (#5).
 * Tách riêng để single source of truth.
 */

/**
 * Index ngày bán sớm nhất (tính theo index trong mảng closes).
 * @param {number} entryIdx  index ngày mua (T0)
 * @returns {number} index sớm nhất có thể bán (entryIdx + 3)
 */
function earliestExitIdx(entryIdx) {
  return entryIdx + 3;
}

/**
 * Index ngày thoát thực = entry + skip(T+1,T+2) + holdDays.
 * @param {number} entryIdx
 * @param {number} holdDays  số phiên GIỮ thực (sau khi đã settle)
 * @returns {number}
 */
function exitIdx(entryIdx, holdDays) {
  return entryIdx + 3 + holdDays;
}

/**
 * Giải thích settlement cho UI/log.
 */
function describeSettlement(entryIdx, holdDays) {
  return `Mua T${entryIdx} → settle T${entryIdx + 2}.5 → giữ ${holdDays} phiên → thoát T${exitIdx(entryIdx, holdDays)}`;
}

module.exports = { earliestExitIdx, exitIdx, describeSettlement };
