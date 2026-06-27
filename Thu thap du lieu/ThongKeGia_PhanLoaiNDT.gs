/**
 * ============================================================================
 *  THỐNG KÊ GIÁ - PHÂN LOẠI NHÀ ĐẦU TƯ  (nguồn: FiinTrade qua wl-technical)
 * ============================================================================
 *  Xuất ra Google Sheet đúng y bảng "Thống kê giá - Phân loại nhà đầu tư"
 *  của FiinTrade, gồm 12 cột:
 *    NGÀY | GIÁ | THAY ĐỔI | % THAY ĐỔI
 *    KL CÁ NHÂN / TỔ CHỨC / TỰ DOANH / NƯỚC NGOÀI  (khớp ròng)
 *    GT CÁ NHÂN / TỔ CHỨC / TỰ DOANH / NƯỚC NGOÀI  (khớp ròng)
 *
 *  CÓ Ô NHẬP ngay trên Sheet:  Mã CK · Tần suất · Từ ngày · Đến ngày
 *  (để trống Từ/Đến  ->  lấy NUM_ROWS phiên gần nhất)
 *
 *  Cơ chế: endpoint gốc wl-technical.fiintrade.vn chỉ cần header
 *          Origin = https://iboard.ssi.com.vn (không cần đăng nhập / token).
 *  Quy ước hiển thị (giống FiinTrade): Giá ×1.000 · KL ×1.000 · GT ×1.000.000
 *
 *  CÁCH DÙNG:
 *    1. Mở Google Sheet > Extensions > Apps Script > dán file này > Lưu.
 *    2. Tải lại Sheet > menu "FiinTrade" > "Tạo ô nhập" (lần đầu).
 *    3. Nhập Mã / Tần suất / Từ ngày / Đến ngày vào các ô.
 *    4. Menu "FiinTrade" > "Cập nhật bảng".
 * ============================================================================
 */

var DEFAULT_NUM_ROWS = 250;   // số phiên lấy khi KHÔNG nhập Từ/Đến
var PAGE_SIZE = 60;           // PageSize hợp lệ của API
var MAX_ROWS = 3000;          // trần an toàn

// Vị trí các ô nhập
var CELL_CODE = 'B1';   // Mã CK
var CELL_FREQ = 'B2';   // Tần suất: Daily | Weekly | Monthly | Yearly
var CELL_FROM = 'D1';   // Từ ngày (để trống = không lọc)
var CELL_TO   = 'D2';   // Đến ngày
var HEADER_ROW = 4;     // dòng tiêu đề bảng
var FIRST_DATA_ROW = 5;

// Scaling hiển thị
var SCALE_PRICE = 1000;
var SCALE_VOL   = 1000;
var SCALE_VAL   = 1000000;

var HEADERS = [
  'NGÀY', 'GIÁ', 'THAY ĐỔI', '% THAY ĐỔI',
  'KL CÁ NHÂN KHỚP RÒNG', 'KL TỔ CHỨC KHỚP RÒNG',
  'KL TỰ DOANH KHỚP RÒNG', 'KL NƯỚC NGOÀI KHỚP RÒNG',
  'GT CÁ NHÂN KHỚP RÒNG', 'GT TỔ CHỨC KHỚP RÒNG',
  'GT TỰ DOANH KHỚP RÒNG', 'GT NƯỚC NGOÀI KHỚP RÒNG'
];

/** Menu */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FiinTrade')
    .addItem('Cập nhật bảng', 'capNhatBang')
    .addItem('Tạo dashboard phân tích', 'taoDashboard')
    .addItem('Tạo ô nhập (lần đầu)', 'taoONhap')
    .addToUi();
}

/** Tạo khu vực ô nhập ở đầu sheet (xóa sạch sheet cũ rồi dựng form rõ ràng) */
function taoONhap() {
  var sheet = SpreadsheetApp.getActiveSheet();
  sheet.clear();
  sheet.clearNotes();
  sheet.getRange(1, 1, 5, 12).clearDataValidations();

  // Nhãn + ô nhập
  sheet.getRange('A1').setValue('Mã CK:').setFontWeight('bold');
  sheet.getRange('A2').setValue('Tần suất:').setFontWeight('bold');
  sheet.getRange('C1').setValue('Từ ngày:').setFontWeight('bold');
  sheet.getRange('C2').setValue('Đến ngày:').setFontWeight('bold');

  sheet.getRange(CELL_CODE).setValue('CTG');
  // Dropdown (mũi tên xổ xuống) cho Tần suất - 4 lựa chọn giống FiinTrade
  var ruleFreq = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Daily', 'Weekly', 'Monthly', 'Yearly'], true)
    .setAllowInvalid(false)
    .setHelpText('Daily (ngày) · Weekly (tuần) · Monthly (tháng) · Yearly (năm)')
    .build();
  sheet.getRange(CELL_FREQ).setValue('Daily').setDataValidation(ruleFreq);
  sheet.getRange(CELL_FROM).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(CELL_TO).setNumberFormat('yyyy-mm-dd');

  // Date-picker (hiện biểu tượng lịch) cho ô Từ/Đến; vẫn cho để trống
  var ruleDate = SpreadsheetApp.newDataValidation()
    .requireDate()
    .setAllowInvalid(true)
    .setHelpText('Nhập ngày dạng năm-tháng-ngày, ví dụ: 2026-05-01 (hoặc bấm biểu tượng lịch). Để trống = 250 phiên gần nhất.')
    .build();
  sheet.getRange(CELL_FROM).setDataValidation(ruleDate);
  sheet.getRange(CELL_TO).setDataValidation(ruleDate);

  // Làm nổi bật các ô nhập (nền vàng nhạt + viền)
  var inputs = sheet.getRangeList([CELL_CODE, CELL_FREQ, CELL_FROM, CELL_TO]);
  inputs.setBackground('#fff7cc');
  inputs.setBorder(true, true, true, true, false, false);

  sheet.getRange('E1:L1').merge()
       .setValue('◄ Nhập Mã + Tần suất + (tuỳ chọn) Từ/Đến rồi bấm menu  FiinTrade ▸ Cập nhật bảng')
       .setFontColor('#b45309').setFontWeight('bold');
  sheet.getRange('E2:L2').merge()
       .setValue('Ngày dạng năm-tháng-ngày, VD: 2026-05-01.  Để trống Từ/Đến = lấy '
                 + DEFAULT_NUM_ROWS + ' phiên gần nhất.  Giá ×1.000 · KL ×1.000 · GT ×1.000.000')
       .setFontColor('#6b7280');

  datColRong_(sheet);
  SpreadsheetApp.getActiveSpreadsheet().toast('Đã tạo ô nhập (A/B/C/D dòng 1-2). Điền rồi bấm FiinTrade ▸ Cập nhật bảng.', 'FiinTrade', 8);
}

function num_(v) { return (v === null || v === undefined || v === '') ? 0 : Number(v); }

/** Đưa giá trị ô ngày về chuỗi yyyy-MM-dd (hoặc '' nếu trống) */
function fmtDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim();
}

/**
 * Lấy dữ liệu GetPriceData, tự phân trang.
 * - Nếu có fromDate & toDate: thêm From/To, phân trang tới khi đủ totalCount.
 * - Nếu không: lấy numRows phiên gần nhất.
 */
function layDuLieu_(code, frequency, fromDate, toDate, numRows) {
  var useRange = (fromDate && toDate);
  var out = [];
  var page = 1;
  while (true) {
    var url = 'https://wl-technical.fiintrade.vn/PriceData/GetPriceData'
            + '?Code=' + encodeURIComponent(code)
            + '&Frequently=' + encodeURIComponent(frequency)
            + '&Page=' + page
            + '&PageSize=' + PAGE_SIZE
            + '&language=vi';
    if (useRange) url += '&From=' + fromDate + '&To=' + toDate;

    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'Origin': 'https://iboard.ssi.com.vn', 'Accept': 'application/json' },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Lỗi HTTP ' + res.getResponseCode() + ' - ' + res.getContentText().slice(0, 200));
    }
    var data = JSON.parse(res.getContentText());
    var items = data.items || [];
    out = out.concat(items);

    var limit = useRange ? (data.totalCount || out.length) : numRows;
    if (limit > MAX_ROWS) limit = MAX_ROWS;
    if (items.length < PAGE_SIZE || out.length >= limit) break;
    page++;
    if (page > Math.ceil(MAX_ROWS / PAGE_SIZE)) break;
  }
  if (!useRange && out.length > numRows) out = out.slice(0, numRows);
  return out;
}

/** Item gốc -> 1 dòng 12 cột (đã test khớp ảnh FiinTrade) */
function dungDong_(r) {
  // Cá nhân, Tự doanh, Nước ngoài: lấy trực tiếp field khớp ròng (Buy - Sell)
  var klCN = (num_(r.localIndividualBuyMatchVolume)        - num_(r.localIndividualSellMatchVolume))        / SCALE_VOL;
  var klTD = (num_(r.proprietaryTotalMatchBuyTradeVolume)  - num_(r.proprietaryTotalMatchSellTradeVolume))  / SCALE_VOL;
  var klNN = (num_(r.foreignBuyVolumeMatched)              - num_(r.foreignSellVolumeMatched))              / SCALE_VOL;
  var gtCN = (num_(r.localIndividualBuyMatchValue)         - num_(r.localIndividualSellMatchValue))         / SCALE_VAL;
  var gtTD = (num_(r.proprietaryTotalMatchBuyTradeValue)   - num_(r.proprietaryTotalMatchSellTradeValue))   / SCALE_VAL;
  var gtNN = (num_(r.foreignBuyValueMatched)               - num_(r.foreignSellValueMatched))               / SCALE_VAL;
  // Tổ chức = phần còn lại (thị trường khớp lệnh zero-sum: 4 nhóm cộng = 0).
  // (field localInstitutional* của FiinTrade đã GỘP cả tự doanh nên không dùng trực tiếp)
  var klTC = -(klCN + klTD + klNN);
  var gtTC = -(gtCN + gtTD + gtNN);
  var ngay = r.tradingDate ? r.tradingDate.toString().slice(0, 10) : '';
  return [ngay, num_(r.closeValue)/SCALE_PRICE, num_(r.valueChange)/SCALE_PRICE,
          num_(r.percentValueChange), klCN, klTC, klTD, klNN, gtCN, gtTC, gtTD, gtNN];
} 

/** Hàm chính */
function capNhatBang() {
  var sheet = SpreadsheetApp.getActiveSheet();

  // Đọc ô nhập (nếu chưa có thì tạo)
  if (!sheet.getRange(CELL_CODE).getValue()) { taoONhap(); }
  var code = String(sheet.getRange(CELL_CODE).getValue() || '').trim().toUpperCase();
  var freq = String(sheet.getRange(CELL_FREQ).getValue() || 'Daily').trim() || 'Daily';
  var fromD = fmtDate_(sheet.getRange(CELL_FROM).getValue());
  var toD   = fmtDate_(sheet.getRange(CELL_TO).getValue());
  if (!code) { SpreadsheetApp.getUi().alert('Vui lòng nhập Mã CK ở ô ' + CELL_CODE); return; }

  // Xoá vùng bảng cũ (từ HEADER_ROW xuống), giữ nguyên ô nhập
  var lastRow = sheet.getMaxRows();
  if (lastRow >= HEADER_ROW) {
    sheet.getRange(HEADER_ROW, 1, lastRow - HEADER_ROW + 1, HEADERS.length).clear();
  }

  var items = layDuLieu_(code, freq, fromD, toD, DEFAULT_NUM_ROWS);
  if (items.length === 0) {
    sheet.getRange(HEADER_ROW, 1).setValue('Không có dữ liệu cho mã ' + code);
    return;
  }

  // Header
  sheet.getRange(HEADER_ROW, 1, 1, HEADERS.length).setValues([HEADERS])
       .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff')
       .setHorizontalAlignment('center').setWrap(true);

  // Dữ liệu
  var rows = items.map(dungDong_);
  sheet.getRange(FIRST_DATA_ROW, 1, rows.length, HEADERS.length).setValues(rows);

  // Định dạng
  sheet.getRange(FIRST_DATA_ROW, 1, rows.length, 1).setNumberFormat('@');        // NGÀY text
  sheet.getRange(FIRST_DATA_ROW, 2, rows.length, 2).setNumberFormat('#,##0.00'); // GIÁ, THAY ĐỔI
  sheet.getRange(FIRST_DATA_ROW, 4, rows.length, 1).setNumberFormat('0.00%');    // %
  sheet.getRange(FIRST_DATA_ROW, 5, rows.length, 8).setNumberFormat('#,##0.00'); // KL + GT
  toMau_(sheet, FIRST_DATA_ROW, rows);
  sheet.setFrozenRows(HEADER_ROW);
  datColRong_(sheet);   // đặt độ rộng cột cố định (tránh autoResize làm phình cột)

  var msg = 'Đã cập nhật ' + rows.length + ' dòng · ' + code + ' (' + freq + ')'
          + (fromD && toD ? ' · ' + fromD + ' → ' + toD : '');
  SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'FiinTrade', 6);
}

/** Tô màu xanh (dương) / đỏ (âm) cho các cột số */
function toMau_(sheet, firstDataRow, rows) {
  var cols = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // THAY ĐỔI, %, KL x4, GT x4
  for (var i = 0; i < cols.length; i++) {
    var col = cols[i], colors = [];
    for (var r = 0; r < rows.length; r++) {
      var v = Number(rows[r][col - 1]) || 0;
      colors.push([v > 0 ? '#16a34a' : (v < 0 ? '#dc2626' : '#374151')]);
    }
    sheet.getRange(firstDataRow, col, rows.length, 1).setFontColors(colors);
  }
}

/** Đặt độ rộng cột cố định, gọn gàng (không dùng autoResize để tránh phình cột do ô gộp) */
function datColRong_(sheet) {
  sheet.setColumnWidth(1, 95);    // NGÀY
  sheet.setColumnWidth(2, 70);    // GIÁ
  sheet.setColumnWidth(3, 80);    // THAY ĐỔI
  sheet.setColumnWidth(4, 80);    // % THAY ĐỔI
  sheet.setColumnWidths(5, 8, 115); // 8 cột KL + GT
}


/* ============================================================================
 *  DASHBOARD PHÂN TÍCH DÒNG TIỀN 4 NHÓM NĐT
 *  Đọc Mã/Tần suất/Từ-Đến từ ô nhập (sheet hiện hành), tự lấy dữ liệu,
 *  tính GT ròng theo ngày + lũy kế, vẽ biểu đồ trên sheet "Dashboard NĐT".
 * ============================================================================ */

var DASH_SHEET = 'Dashboard NĐT';
var DASH_CALC  = '_DB_NDT_calc';   // sheet phụ chứa số liệu cho biểu đồ

function taoDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = SpreadsheetApp.getActiveSheet();

  var code = String(src.getRange(CELL_CODE).getValue() || '').trim().toUpperCase();
  var freq = String(src.getRange(CELL_FREQ).getValue() || 'Daily').trim() || 'Daily';
  var fromD = fmtDate_(src.getRange(CELL_FROM).getValue());
  var toD   = fmtDate_(src.getRange(CELL_TO).getValue());
  if (!code) { SpreadsheetApp.getUi().alert('Chưa có Mã CK. Hãy chạy "Tạo ô nhập" và nhập mã trước.'); return; }

  var items = layDuLieu_(code, freq, fromD, toD, DEFAULT_NUM_ROWS);
  if (items.length === 0) { SpreadsheetApp.getUi().alert('Không có dữ liệu cho ' + code); return; }

  // API trả mới->cũ; đảo lại cũ->mới để lũy kế đúng chiều thời gian
  items = items.slice().reverse();

  // Tính số liệu: Ngày | Giá | Lũy kế CN/TC/TD/NN | GT ròng ngày CN/TC/TD/NN
  var cum = [0, 0, 0, 0];
  var data = [];
  for (var i = 0; i < items.length; i++) {
    var r = items[i];
    var gtCN = (num_(r.localIndividualBuyMatchValue)        - num_(r.localIndividualSellMatchValue))        / SCALE_VAL;
    var gtTD = (num_(r.proprietaryTotalMatchBuyTradeValue)  - num_(r.proprietaryTotalMatchSellTradeValue))  / SCALE_VAL;
    var gtNN = (num_(r.foreignBuyValueMatched)              - num_(r.foreignSellValueMatched))              / SCALE_VAL;
    var gtTC = -(gtCN + gtTD + gtNN);
    cum[0] += gtCN; cum[1] += gtTC; cum[2] += gtTD; cum[3] += gtNN;
    var ngay = r.tradingDate ? r.tradingDate.toString().slice(0, 10) : '';
    data.push([ngay, num_(r.closeValue) / SCALE_PRICE,
               cum[0], cum[1], cum[2], cum[3],
               gtCN, gtTC, gtTD, gtNN]);
  }

  // ----- Ghi sheet phụ -----
  var calc = ss.getSheetByName(DASH_CALC) || ss.insertSheet(DASH_CALC);
  calc.clear();
  var calcHdr = ['Ngày', 'Giá',
                 'Lũy kế Cá nhân', 'Lũy kế Tổ chức', 'Lũy kế Tự doanh', 'Lũy kế Nước ngoài',
                 'Ròng Cá nhân', 'Ròng Tổ chức', 'Ròng Tự doanh', 'Ròng Nước ngoài'];
  calc.getRange(1, 1, 1, calcHdr.length).setValues([calcHdr]);
  calc.getRange(2, 1, data.length, calcHdr.length).setValues(data);
  var n = data.length;

  // Khối phụ (liền mạch) cho biểu đồ cột theo ngày: 60 phiên gần nhất
  var k = Math.min(n, 60);
  var recent = data.slice(n - k);   // k dòng cuối (gần nhất), thứ tự cũ->mới
  var blk = [['Ngày', 'Ròng Cá nhân', 'Ròng Tổ chức', 'Ròng Tự doanh', 'Ròng Nước ngoài']];
  for (var j = 0; j < recent.length; j++) {
    blk.push([recent[j][0], recent[j][6], recent[j][7], recent[j][8], recent[j][9]]);
  }
  calc.getRange(1, 12, blk.length, 5).setValues(blk);  // cột L:P
  calc.hideSheet();  // ẩn sheet phụ cho gọn

  // ----- Sheet dashboard -----
  var dash = ss.getSheetByName(DASH_SHEET) || ss.insertSheet(DASH_SHEET);
  dash.clear();
  dash.getCharts().forEach(function (c) { dash.removeChart(c); });

  // Tiêu đề + KPI
  var sumCN = cum[0], sumTC = cum[1], sumTD = cum[2], sumNN = cum[3];
  dash.getRange('A1').setValue('DASHBOARD DÒNG TIỀN NĐT · ' + code + ' (' + freq + ')'
      + (fromD && toD ? ' · ' + fromD + ' → ' + toD : ' · ' + n + ' phiên'))
      .setFontSize(14).setFontWeight('bold');

  var kpi = [
    ['Nhóm', 'GT ròng lũy kế (tỷ)', 'Trạng thái'],
    ['Cá nhân',   (sumCN / 1000), sumCN >= 0 ? 'Mua ròng' : 'Bán ròng'],
    ['Tổ chức',   (sumTC / 1000), sumTC >= 0 ? 'Mua ròng' : 'Bán ròng'],
    ['Tự doanh',  (sumTD / 1000), sumTD >= 0 ? 'Mua ròng' : 'Bán ròng'],
    ['Nước ngoài',(sumNN / 1000), sumNN >= 0 ? 'Mua ròng' : 'Bán ròng']
  ];
  dash.getRange(3, 1, 1, 3).setValues([['TỔNG KẾT KỲ (đơn vị: tỷ đồng)', '', '']]).setFontWeight('bold');
  dash.getRange(4, 1, kpi.length, 3).setValues(kpi);
  dash.getRange(4, 1, 1, 3).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  dash.getRange(5, 2, 4, 1).setNumberFormat('#,##0.00');
  // tô màu trạng thái
  for (var k = 0; k < 4; k++) {
    var val = kpi[k + 1][1];
    dash.getRange(5 + k, 2, 1, 2).setFontColor(val >= 0 ? '#16a34a' : '#dc2626');
  }
  dash.setColumnWidth(1, 110); dash.setColumnWidth(2, 150); dash.setColumnWidth(3, 110);

  // ----- Biểu đồ 1: Giá + GT ròng lũy kế theo nhóm (line, 2 trục) -----
  var rngCum = calc.getRange(1, 1, n + 1, 6);   // A:F = Ngày, Giá, 4 lũy kế
  var chart1 = dash.newChart()
    .asLineChart()
    .addRange(rngCum)
    .setNumHeaders(1)
    .setOption('title', 'Giá vs GT ròng LŨY KẾ theo nhóm NĐT (' + code + ')')
    .setOption('height', 380).setOption('width', 760)
    .setOption('series', {
      0: { targetAxisIndex: 0, lineWidth: 3, color: '#111827' },   // Giá
      1: { targetAxisIndex: 1, color: '#dc2626' },                 // Cá nhân
      2: { targetAxisIndex: 1, color: '#2563eb' },                 // Tổ chức
      3: { targetAxisIndex: 1, color: '#f59e0b' },                 // Tự doanh
      4: { targetAxisIndex: 1, color: '#16a34a' }                  // Nước ngoài
    })
    .setOption('vAxes', { 0: { title: 'Giá (×1.000)' }, 1: { title: 'GT ròng lũy kế (triệu)' } })
    .setOption('legend', { position: 'bottom' })
    .setPosition(3, 5, 0, 0)
    .build();
  dash.insertChart(chart1);

  // ----- Biểu đồ 2: GT khớp ròng theo NGÀY (cột, 4 nhóm) - 60 phiên gần nhất -----
  var chart2 = dash.newChart()
    .asColumnChart()
    .addRange(calc.getRange(1, 12, k + 1, 5))   // khối liền mạch L:P (Ngày + 4 nhóm)
    .setNumHeaders(1)
    .setOption('title', 'GT khớp ròng theo NGÀY - ' + k + ' phiên gần nhất (triệu)')
    .setOption('height', 380).setOption('width', 760)
    .setOption('isStacked', false)
    .setOption('colors', ['#dc2626', '#2563eb', '#f59e0b', '#16a34a'])
    .setOption('legend', { position: 'bottom' })
    .setPosition(24, 5, 0, 0)
    .build();
  dash.insertChart(chart2);

  ss.setActiveSheet(dash);
  ss.toast('Đã tạo dashboard cho ' + code + ' (' + n + ' phiên).', 'FiinTrade', 6);
}
