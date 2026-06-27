/**
 * ════════════════════════════════════════════════════════════════════════════
 * VN STOCK - GOOGLE APPS SCRIPT: NHẬN & GHI LỊCH SỬ LỰC CẦU NGÀNH
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mục đích: Nhận dữ liệu lực cầu ngành (POST JSON) từ server Node.js và ghi vào
 *           Google Sheet, để người dùng dễ đọc / lọc / chia sẻ.
 *
 * CÁCH CÀI ĐẶT:
 *   1. Mở Google Sheet bạn muốn lưu dữ liệu.
 *   2. Menu: Extensions (Tiện ích mở rộng) → Apps Script.
 *   3. Xóa code mẫu, dán TOÀN BỘ file này vào.
 *   4. Bấm Deploy (Triển khai) → New deployment (Triển khai mới).
 *        - Select type: Web app
 *        - Description: VN Stock industry history
 *        - Execute as: Me (chính bạn)
 *        - Who has access: Anyone (Bất kỳ ai)  ← bắt buộc để server gọi được
 *   5. Bấm Deploy → Authorize access → chọn tài khoản → Allow.
 *   6. Copy "Web app URL" (dạng https://script.google.com/macros/s/XXXX/exec)
 *   7. Dán URL đó vào file server/.env:
 *        GSHEET_SYNC_URL=https://script.google.com/macros/s/XXXX/exec
 *        GSHEET_SYNC_TOKEN=mot_chuoi_bi_mat_tuy_chon   (xem phần SECRET_TOKEN bên dưới)
 *
 * Khi sửa code: Deploy → Manage deployments → chọn deployment → Edit (icon bút)
 *               → Version: New version → Deploy. URL giữ nguyên.
 *
 * KIỂM TRA NHANH: mở URL bằng trình duyệt sẽ thấy JSON {status:"ok"} (doGet).
 * ════════════════════════════════════════════════════════════════════════════
 */

// (Tùy chọn) Đặt 1 chuỗi bí mật để chỉ server của bạn ghi được. Để '' nếu không dùng.
// Nếu đặt, phải khớp với GSHEET_SYNC_TOKEN trong server/.env
var SECRET_TOKEN = '';

// Tên 2 sheet (tab) sẽ tự được tạo nếu chưa có
var DAILY_SHEET = 'Daily';        // tổng hợp cuối ngày (1 dòng / ngày / ngành)
var INTRADAY_SHEET = 'Intraday';  // chi tiết theo mốc 15 phút

// Tiêu đề cột
var DAILY_HEADERS = ['Ngày', 'Mã Ngành', 'Tên Ngành', 'Lực Cầu (%)', '% CP > MA10', 'Lực Cầu Thấp', 'Lực Cầu Cao', 'Giờ Thấp', 'Giờ Cao', 'Số CP', 'Vốn Hóa', 'Cập Nhật Lúc'];
var INTRADAY_HEADERS = ['Ngày', 'Mốc Giờ', 'Mã Ngành', 'Tên Ngành', 'Lực Cầu (%)', '% CP > MA10'];


/**
 * Endpoint kiểm tra (mở URL bằng trình duyệt)
 */
function doGet() {
  return _json({ status: 'ok', message: 'VN Stock Apps Script hoạt động bình thường' });
}

/**
 * Endpoint chính: nhận POST JSON từ server Node.js
 *
 * Payload mong đợi:
 * {
 *   "token": "...",                 // (tùy chọn) khớp SECRET_TOKEN
 *   "type": "intraday" | "daily",   // loại snapshot
 *   "date": "2026-06-01",           // ngày YYYY-MM-DD
 *   "time": "09:30",                // mốc giờ (chỉ dùng cho intraday)
 *   "industries": [
 *     { "code":"8300","name":"Ngân hàng","lucCau":53.2,"percentAboveMA10":49,
 *       "minLucCau":41.2,"maxLucCau":58.7,"minTime":"11:30","maxTime":"14:15",
 *       "stockCount":18,"marketCap":1234000000000 }
 *   ]
 * }
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return _json({ success: false, error: 'No POST data' });
    }

    var body = JSON.parse(e.postData.contents);

    // Kiểm tra token nếu có cấu hình
    if (SECRET_TOKEN && body.token !== SECRET_TOKEN) {
      return _json({ success: false, error: 'Unauthorized' });
    }

    var type = body.type || 'daily';
    var date = body.date;
    var industries = body.industries || [];

    if (!date || !industries.length) {
      return _json({ success: false, error: 'Missing date or industries' });
    }

    // Khóa chống ghi trùng khi nhiều request đến gần nhau
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (type === 'intraday') {
        _writeIntraday(date, body.time || '', industries);
      } else {
        _writeDaily(date, industries);
      }
    } finally {
      lock.releaseLock();
    }

    return _json({ success: true, type: type, date: date, count: industries.length });
  } catch (err) {
    return _json({ success: false, error: String(err) });
  }
}


/**
 * Ghi/cập nhật bản tổng hợp cuối ngày.
 * Upsert theo khóa (Ngày + Mã Ngành): có rồi thì cập nhật dòng, chưa có thì thêm.
 */
function _writeDaily(date, industries) {
  var sheet = _getSheet(DAILY_SHEET, DAILY_HEADERS);
  var data = sheet.getDataRange().getValues(); // gồm cả header ở dòng 0

  // Lập map khóa -> số dòng (1-based, +1 cho header)
  var rowIndex = {};
  for (var r = 1; r < data.length; r++) {
    var key = data[r][0] + '|' + data[r][1]; // Ngày|Mã
    rowIndex[key] = r + 1;
  }

  var now = _nowStr();
  var toAppend = [];

  industries.forEach(function (ind) {
    var row = [
      date,
      ind.code || '',
      ind.name || '',
      _num(ind.lucCau),
      _num(ind.percentAboveMA10),
      _num(ind.minLucCau),
      _num(ind.maxLucCau),
      ind.minTime || '',
      ind.maxTime || '',
      _num(ind.stockCount),
      _num(ind.marketCap),
      now
    ];
    var key = date + '|' + (ind.code || '');
    if (rowIndex[key]) {
      // Cập nhật dòng đã có
      sheet.getRange(rowIndex[key], 1, 1, row.length).setValues([row]);
    } else {
      toAppend.push(row);
    }
  });

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
  }
}


/**
 * Ghi/cập nhật chi tiết intraday theo mốc 15 phút.
 * Upsert theo khóa (Ngày + Mốc Giờ + Mã Ngành).
 */
function _writeIntraday(date, time, industries) {
  var sheet = _getSheet(INTRADAY_SHEET, INTRADAY_HEADERS);
  var data = sheet.getDataRange().getValues();

  var rowIndex = {};
  for (var r = 1; r < data.length; r++) {
    var key = data[r][0] + '|' + data[r][1] + '|' + data[r][2]; // Ngày|Giờ|Mã
    rowIndex[key] = r + 1;
  }

  var toAppend = [];
  industries.forEach(function (ind) {
    var row = [
      date,
      time,
      ind.code || '',
      ind.name || '',
      _num(ind.lucCau),
      _num(ind.percentAboveMA10)
    ];
    var key = date + '|' + time + '|' + (ind.code || '');
    if (rowIndex[key]) {
      sheet.getRange(rowIndex[key], 1, 1, row.length).setValues([row]);
    } else {
      toAppend.push(row);
    }
  });

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
  }
}


// ── Tiện ích ────────────────────────────────────────────────────────────────

/** Lấy sheet theo tên, tạo mới + ghi header nếu chưa có */
function _getSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

/** Ép về số, trả 0 nếu không hợp lệ */
function _num(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** Thời điểm hiện tại theo giờ VN dạng chuỗi */
function _nowStr() {
  return Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd HH:mm:ss');
}

/** Trả về response JSON */
function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
