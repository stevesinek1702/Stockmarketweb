/**
 * ════════════════════════════════════════════════════════════════════════════
 * VN STOCK - GOOGLE APPS SCRIPT: PHÂN TÍCH NGÀNH (DÒNG TIỀN & HIỆU SUẤT)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mục đích: Tái tạo tính năng "Phân Tích Ngành" của web dashboard ngay trên
 *           Google Sheets. Script TỰ lấy dữ liệu từ Fiintrade rồi vẽ:
 *             1. Bảng + biểu đồ "Dòng Tiền Ròng Theo Ngành" (Dòng tiền lớn =
 *                Tổ chức + Tự doanh + Nước ngoài) — thanh xanh (≥0) / đỏ (<0).
 *             2. "Hiệu Suất Ngành" — heatmap % thay đổi chỉ số của từng ngành
 *                (xanh dương / đỏ âm, đậm nhạt theo độ lớn).
 *
 * NGUỒN DỮ LIỆU: chỉ 1 endpoint công khai của Fiintrade
 *   https://wl-market.fiintrade.vn/SectorIndepth/GetSectorStatisticbyInvestor
 *   → CHỈ cần header "Origin" mang danh nghĩa SSI iBoard là chạy 200.
 *   → KHÔNG cần đăng nhập / token / cookie. (Đã kiểm chứng.)
 *
 * ĐÂY LÀ SCRIPT LẤY DỮ LIỆU ĐỘC LẬP (giống "Code Multi CP.txt" - PHẦN 5),
 * KHÔNG phải bộ nhận POST từ server. Không gọi server, không phụ thuộc gì thêm.
 *
 * CÁCH CÀI ĐẶT:
 *   1. Mở Google Sheet bạn muốn dùng.
 *   2. Menu: Extensions (Tiện ích mở rộng) → Apps Script.
 *   3. Xóa code mẫu, dán TOÀN BỘ file này vào, bấm Save (Lưu 💾).
 *   4. Tải lại (reload) trang Google Sheet.
 *   5. Trên thanh menu sẽ xuất hiện "📊 Phân Tích Ngành" → chọn khoảng thời gian.
 *      (Lần đầu chạy Google sẽ hỏi cấp quyền → Allow/Cho phép.)
 * ════════════════════════════════════════════════════════════════════════════
 */

// ===== CẤU HÌNH ==============================================================

// Header gọi Fiintrade: chỉ cần "origin" = iboard SSI là chạy (KHÔNG cần login).
// Không để br/zstd để UrlFetchApp tự giải nén được nội dung JSON.
var FII_HEADERS = {
  'accept': 'application/json',
  'origin': 'https://iboard.ssi.com.vn',
  'referer': 'https://iboard.ssi.com.vn/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
};

var SHEET_NAME = 'Phân Tích Ngành';   // tên tab sẽ được tạo / ghi đè
var ICB_LEVEL  = 2;                   // 2 = 18 ngành cấp 2 (khớp web dùng level=2)

var POSITIVE_COLOR = '#26a65b';       // xanh (mua ròng / tăng) — khớp màu web
var NEGATIVE_COLOR = '#e84142';       // đỏ (bán ròng / giảm)   — khớp màu web

var HEADER_STYLE = {                  // style cho hàng tiêu đề của bảng
  backgroundColor: '#4472C4',
  fontColor: '#FFFFFF'
};


// ===== MENU ==================================================================

/**
 * Tự chạy khi mở Sheet: tạo menu "📊 Phân Tích Ngành".
 * (Apps Script menu không truyền tham số được → dùng 4 hàm bọc zero-arg.)
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 Phân Tích Ngành')
    .addItem('Hôm nay (1 phiên)', 'chayHomNay')
    .addItem('5 phiên gần nhất', 'chay5Phien')
    .addItem('20 phiên gần nhất', 'chay20Phien')
    .addItem('Từ đầu năm (YTD)', 'chayYTD')
    .addToUi();
}

// 4 hàm bọc: gọi buildSheet_ với timeRange tương ứng (1 / 5 / 20 / 0)
function chayHomNay() { buildSheet_(1); }
function chay5Phien() { buildSheet_(5); }
function chay20Phien() { buildSheet_(20); }
function chayYTD()     { buildSheet_(0); }


// ===== LẤY DỮ LIỆU ===========================================================

/**
 * Gọi endpoint dòng tiền ngành của Fiintrade.
 * @param {number} level icbLevel (1 = 10 ngành · 2 = 18 ngành)
 * @param {number} tr    timeRange (1 · 5 · 20 · 0=YTD)
 * @return {Array|null}  mảng items, hoặc null nếu lỗi HTTP.
 */
function fetchSector_(level, tr) {
  var url = 'https://wl-market.fiintrade.vn/SectorIndepth/GetSectorStatisticbyInvestor'
          + '?icbLevel=' + level + '&timeRange=' + tr + '&language=vi';
  var res = UrlFetchApp.fetch(url, { method: 'get', headers: FII_HEADERS, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log('Lỗi API ngành (timeRange=' + tr + '): HTTP ' + res.getResponseCode());
    return null;
  }
  var data = JSON.parse(res.getContentText());
  return (data && data.items) || [];
}


// ===== XỬ LÝ DỮ LIỆU =========================================================

/**
 * Chuyển items thô → mảng dòng đã tính toán, sắp theo Dòng Tiền Lớn giảm dần.
 * Quy đổi VND → tỷ đồng (÷1e9). Khớp đúng logic web getSectorFlow().
 */
function processItems_(items) {
  var rows = items.map(function (it) {
    var caNhanRaw    = (it.netIndividualMatchValue  || 0) / 1e9;  // Cá nhân
    var toChucRaw    = (it.netInstitutionMatchValue || 0) / 1e9;  // Tổ chức trong nước
    var tuDoanhRaw   = (it.netProprietaryMatchValue || 0) / 1e9;  // Tự doanh
    var nuocNgoaiRaw = (it.netForeignMatchValue     || 0) / 1e9;  // Nước ngoài
    // "Dòng tiền lớn" = Tổ chức + Tự doanh + Nước ngoài
    var netSmart = toChucRaw + tuDoanhRaw + nuocNgoaiRaw;
    return {
      code: it.icbCode,
      name: cleanName_(it.icbName),
      closeIndex: round1_(it.closeIndex),
      percentChange: round1_((it.percentIndexChange || 0) * 100), // đã ×100: 5.6 = +5.6%
      caNhan: round1_(caNhanRaw),
      toChuc: round1_(toChucRaw),
      tuDoanh: round1_(tuDoanhRaw),
      nuocNgoai: round1_(nuocNgoaiRaw),
      netSmart: round1_(netSmart)
    };
  });
  // Sắp theo Dòng Tiền Lớn giảm dần (khớp thứ tự thanh trên web)
  rows.sort(function (a, b) { return b.netSmart - a.netSmart; });
  return rows;
}

/** Bỏ hậu tố " L1"/" L2" trong tên ngành ICB (vd "Ngân hàng L2" → "Ngân hàng"). */
function cleanName_(name) {
  return String(name || '').replace(/\s*L\d+\s*$/i, '').trim();
}

/** Làm tròn 1 chữ số thập phân. */
function round1_(x) {
  return Math.round((x || 0) * 10) / 10;
}

/** Nhãn khoảng thời gian cho tiêu đề / toast. */
function sectorLabel_(tr) {
  if (tr === 1)  return 'Hôm nay';
  if (tr === 5)  return '5 phiên';
  if (tr === 20) return '20 phiên';
  if (tr === 0)  return 'Từ đầu năm (YTD)';
  return String(tr) + ' phiên';
}


// ===== DỰNG BẢNG + BIỂU ĐỒ ===================================================

/**
 * Hàm chính: tải dữ liệu ngành theo timeRange rồi dựng bảng, biểu đồ, heatmap.
 * @param {number} tr timeRange (1 / 5 / 20 / 0=YTD)
 */
function buildSheet_(tr) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    ss.toast('Đang tải dữ liệu ngành: ' + sectorLabel_(tr) + ' ...', 'Phân Tích Ngành', -1);

    // a. Lấy dữ liệu
    var items = fetchSector_(ICB_LEVEL, tr);
    if (!items || items.length === 0) {
      SpreadsheetApp.getUi().alert('Không tải được dữ liệu ngành.');
      return;
    }

    // b. Xử lý
    var rows = processItems_(items);
    var n = rows.length;
    var fromDate = items[0].fromDate ? String(items[0].fromDate).slice(0, 10) : '';
    var toDate   = items[0].toDate   ? String(items[0].toDate).slice(0, 10)   : '';
    var label = sectorLabel_(tr);

    // c. Lấy / tạo sheet, dọn sạch nội dung, biểu đồ và định dạng cũ
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (sheet) { sheet.clear(); removeCharts_(sheet); }
    else { sheet = ss.insertSheet(SHEET_NAME); }
    sheet.clearConditionalFormatRules();

    // d. Dòng tiêu đề (gộp ô)
    var titleRow = 1;
    sheet.getRange(titleRow, 1, 1, 8).merge()
      .setValue('PHÂN TÍCH DÒNG TIỀN NGÀNH · ' + label + ' · ' + fromDate + ' → ' + toDate + ' · đơn vị: tỷ đồng')
      .setFontWeight('bold').setFontSize(12)
      .setBackground('#d9e1f2').setHorizontalAlignment('center');

    // e. BẢNG CHÍNH
    var hdrRow = titleRow + 1;
    var header = ['Ngành', 'Chỉ Số', '% Thay Đổi', 'Cá Nhân', 'Tổ Chức', 'Tự Doanh', 'Nước Ngoài', 'Dòng Tiền Lớn'];
    sheet.getRange(hdrRow, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground(HEADER_STYLE.backgroundColor)
      .setFontColor(HEADER_STYLE.fontColor).setHorizontalAlignment('center');

    var dataRow = hdrRow + 1;
    var table = rows.map(function (r) {
      return [r.name, r.closeIndex, r.percentChange, r.caNhan, r.toChuc, r.tuDoanh, r.nuocNgoai, r.netSmart];
    });
    sheet.getRange(dataRow, 1, n, header.length).setValues(table);

    // Định dạng số
    sheet.getRange(dataRow, 2, n, 1).setNumberFormat('#,##0.0');   // Chỉ Số
    sheet.getRange(dataRow, 3, n, 1).setNumberFormat('0.00"%"');   // % Thay Đổi (giá trị đã là %, vd 5.6)
    sheet.getRange(dataRow, 4, n, 5).setNumberFormat('#,##0.0');   // 5 cột tiền (Cá Nhân..Dòng Tiền Lớn)

    // Tô màu chữ xanh (>0) / đỏ (<0) cho cột % và 5 cột tiền
    var pctRange   = sheet.getRange(dataRow, 3, n, 1);
    var moneyRange = sheet.getRange(dataRow, 4, n, 5);
    applyPosNeg_(sheet, [pctRange, moneyRange]);

    // f. BIỂU ĐỒ THANH NGANG — Dòng Tiền Lớn (xanh nếu ≥0, đỏ nếu <0).
    //    Google chart 1 màu / series → tách 2 cột phụ để có xanh + đỏ.
    var HELP_COL = 10;  // cột J = Mua ròng, K = Bán ròng (nằm cạnh bảng, để làm dữ liệu biểu đồ)
    sheet.getRange(hdrRow, HELP_COL, 1, 2).setValues([['Mua ròng', 'Bán ròng']])
      .setFontWeight('bold').setFontColor('#999999');
    var helper = rows.map(function (r) {
      return [ (r.netSmart >= 0 ? r.netSmart : ''), (r.netSmart < 0 ? r.netSmart : '') ];
    });
    sheet.getRange(dataRow, HELP_COL, n, 2).setValues(helper);
    sheet.getRange(dataRow, HELP_COL, n, 2).setNumberFormat('#,##0.0');

    var chart = sheet.newChart()
      .setChartType(Charts.ChartType.BAR)                          // BAR = thanh ngang
      .addRange(sheet.getRange(hdrRow, 1, n + 1, 1))               // trục: tên Ngành (kèm header)
      .addRange(sheet.getRange(hdrRow, HELP_COL, n + 1, 2))        // 2 series: Mua ròng / Bán ròng
      .setMergeStrategy(Charts.ChartMergeStrategy.MERGE_COLUMNS)
      .setNumHeaders(1)
      .setPosition(hdrRow, 13, 0, 0)                               // thả bên phải bảng (cột M)
      .setOption('title', 'Dòng tiền ròng theo ngành (Tổ chức + Tự doanh + Nước ngoài) · tỷ')
      .setOption('height', Math.max(360, 24 * n + 140))
      .setOption('width', 760)
      .setOption('legend', { position: 'top' })
      .setOption('colors', [POSITIVE_COLOR, NEGATIVE_COLOR])       // xanh cho Mua ròng, đỏ cho Bán ròng
      .build();
    sheet.insertChart(chart);

    // g. HEATMAP "🔥 Hiệu Suất Ngành" — vài dòng dưới bảng chính, sắp theo % giảm dần.
    var heatTitleRow = dataRow + n + 2;
    sheet.getRange(heatTitleRow, 1, 1, 3).merge()
      .setValue('🔥 Hiệu Suất Ngành (% thay đổi chỉ số)')
      .setFontWeight('bold').setFontSize(12)
      .setBackground('#d9e1f2').setHorizontalAlignment('center');

    var heatHdrRow = heatTitleRow + 1;
    sheet.getRange(heatHdrRow, 1, 1, 3).setValues([['Ngành', '% Thay Đổi', 'Chỉ Số']])
      .setFontWeight('bold').setBackground(HEADER_STYLE.backgroundColor)
      .setFontColor(HEADER_STYLE.fontColor).setHorizontalAlignment('center');

    var heatRows = rows.slice()
      .sort(function (a, b) { return b.percentChange - a.percentChange; })
      .map(function (r) { return [r.name, r.percentChange, r.closeIndex]; });
    var heatDataRow = heatHdrRow + 1;
    sheet.getRange(heatDataRow, 1, heatRows.length, 3).setValues(heatRows);
    sheet.getRange(heatDataRow, 2, heatRows.length, 1).setNumberFormat('0.00"%"');
    sheet.getRange(heatDataRow, 3, heatRows.length, 1).setNumberFormat('#,##0.0');

    // Gradient nền: -3% đỏ → 0 trắng → +3% xanh (mô phỏng ô heatmap của web)
    var heatPctRange = sheet.getRange(heatDataRow, 2, heatRows.length, 1);
    var gradRules = sheet.getConditionalFormatRules();
    gradRules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue(NEGATIVE_COLOR, SpreadsheetApp.InterpolationType.NUMBER, '-3')
      .setGradientMidpointWithValue('#ffffff', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMaxpointWithValue(POSITIVE_COLOR, SpreadsheetApp.InterpolationType.NUMBER, '3')
      .setRanges([heatPctRange])
      .build());
    sheet.setConditionalFormatRules(gradRules);

    // h. Hoàn thiện: đóng băng tiêu đề + header, chỉnh độ rộng cột
    sheet.setFrozenRows(hdrRow);          // giữ dòng tiêu đề + hàng header
    sheet.setColumnWidth(1, 210);         // cột Ngành rộng
    sheet.setColumnWidths(2, 7, 100);     // cột 2..8
    ss.toast('Hoàn tất: ' + n + ' ngành · ' + label + '.', 'Phân Tích Ngành', 6);

  } catch (err) {
    SpreadsheetApp.getUi().alert('Lỗi khi tạo bảng Phân Tích Ngành:\n' + err);
  }
}


// ===== TIỆN ÍCH ==============================================================

/** Tô màu chữ xanh (>0) / đỏ (<0) cho các range truyền vào. */
function applyPosNeg_(sheet, ranges) {
  var rules = sheet.getConditionalFormatRules();
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(0).setFontColor(POSITIVE_COLOR).setRanges(ranges).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0).setFontColor(NEGATIVE_COLOR).setRanges(ranges).build());
  sheet.setConditionalFormatRules(rules);
}

/** Xóa toàn bộ biểu đồ đang có trên sheet. */
function removeCharts_(sheet) {
  var charts = sheet.getCharts();
  for (var i = 0; i < charts.length; i++) {
    sheet.removeChart(charts[i]);
  }
}
