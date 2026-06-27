# Requirements Document

## Introduction

Hiện tại lực cầu (demand strength) và %CP>MA10 của các ngành được tính real-time mỗi lần gọi API `/api/industry-stats` và không được lưu lại. Vì vậy người dùng không thể đánh giá xu hướng lực cầu của một ngành qua thời gian (hôm trước, tuần trước, tháng trước).

Tính năng này bổ sung cơ chế lưu snapshot lực cầu ngành theo mô hình hybrid: file JSON local trên server là nguồn dữ liệu chính (nhanh, ổn định), đồng thời đồng bộ một bản sao lên Google Sheet qua Google Apps Script Web App để người dùng dễ đọc và chia sẻ. Dữ liệu có hai tầng: snapshot intraday theo mốc 15 phút trong phiên, và snapshot tổng hợp cuối ngày kèm giá trị min/max lực cầu trong ngày. Mọi giá trị lưu dưới dạng số để dễ xử lý. Kèm theo là các API và giao diện để xem thay đổi lực cầu so với phiên trước, xem biểu đồ lịch sử lực cầu của một ngành (cả intraday lẫn nhiều ngày), và so sánh nhanh xu hướng tăng/giảm lực cầu của toàn bộ ngành. Tính năng tích hợp vào panel "Chuyển Động Ngành" có sẵn trên Dashboard, tận dụng API và cấu trúc dữ liệu hiện tại.

## Glossary

- **Lực cầu (demand strength)**: tỷ lệ `TotalActiveBuyVolume / TotalVolume × 100` của ngành, đơn vị %. Lưu dưới dạng **số (number)**, không phải chuỗi.
- **%CP>MA10**: phần trăm số cổ phiếu trong ngành có giá trên đường MA10. Lưu dưới dạng **số**.
- **Mốc 15 phút (15-min slot)**: thời điểm chuẩn hóa trong phiên giao dịch (vd 09:15, 09:30, 09:45, ... 14:45), dùng làm khóa cho snapshot intraday.
- **Snapshot intraday**: bản ghi lực cầu + %CP>MA10 của tất cả ngành tại một mốc 15 phút trong ngày.
- **Daily min/max lực cầu**: giá trị lực cầu thấp nhất và cao nhất của một ngành ghi nhận trong toàn bộ một ngày giao dịch.
- **Snapshot cuối ngày (daily close)**: bản ghi tổng hợp cuối ngày gồm lực cầu lúc đóng cửa + min + max của ngày.
- **Phiên gần nhất trước đó (previous session)**: ngày giao dịch có snapshot gần nhất trước ngày hôm nay.
- **ICB2**: mã ngành cấp 2 (vd 8300 = Ngân hàng) dùng làm khóa định danh ngành.
- **JSON local**: file `server/data/industry-history.json` trên server, là nguồn dữ liệu chính (source of truth).
- **Apps Script Web App**: một Google Apps Script gắn với Google Sheet, deploy thành web app có URL nhận request POST để ghi dữ liệu vào Sheet.
- **Đồng bộ hybrid**: cơ chế ghi dữ liệu vào JSON local trước, sau đó đẩy bản sao lên Google Sheet; nếu Sheet lỗi thì JSON local vẫn nguyên vẹn.

## Requirements

### Requirement 1: Lưu snapshot lực cầu ngành theo mốc 15 phút và cuối ngày

**User Story:** Là một nhà đầu tư, tôi muốn hệ thống tự động lưu lại lực cầu của các ngành theo mốc 15 phút và tổng hợp cuối ngày, để sau này có dữ liệu lịch sử chi tiết mà đánh giá.

#### Acceptance Criteria

1. WHEN endpoint `/api/industry-stats` tính toán xong dữ liệu ngành THEN hệ thống SHALL lưu một snapshot intraday cho mốc 15 phút hiện tại vào file JSON local `server/data/industry-history.json`, gồm `{code, name, lucCau, percentAboveMA10, stockCount, marketCap}` cho từng ngành, với tất cả giá trị số là kiểu number.
2. WHEN ghi snapshot intraday THEN hệ thống SHALL chuẩn hóa thời điểm về mốc 15 phút gần nhất, ví dụ 09:37 làm tròn về 09:30, và dùng mốc đó làm khóa; nếu trong cùng mốc có nhiều lần gọi thì ghi đè bằng giá trị mới nhất.
3. WHEN có snapshot mới trong ngày THEN hệ thống SHALL cập nhật giá trị lực cầu thấp nhất và cao nhất trong ngày cho từng ngành, lưu kèm thời điểm đạt min/max.
4. WHEN kết thúc cập nhật trong ngày THEN hệ thống SHALL lưu một bản ghi tổng hợp cuối ngày gồm `{code, name, lucCau (giá trị mới nhất), percentAboveMA10, minLucCau, maxLucCau, minTime, maxTime, stockCount, marketCap}` theo khóa ngày `YYYY-MM-DD` giờ Việt Nam UTC+7.
5. WHEN dữ liệu intraday của một ngày vượt quá 5 ngày gần nhất THEN hệ thống SHALL chỉ giữ chi tiết intraday cho 5 ngày gần nhất, các ngày cũ hơn chỉ giữ bản ghi tổng hợp cuối ngày.
6. WHEN số ngày lưu trữ tổng hợp vượt quá 180 ngày THEN hệ thống SHALL xóa các ngày cũ nhất để giữ tối đa 180 ngày gần nhất.
7. IF việc đọc hoặc ghi file lịch sử thất bại THEN hệ thống SHALL ghi log lỗi và tiếp tục trả về dữ liệu industry-stats bình thường, lỗi lưu lịch sử KHÔNG được làm hỏng response chính.
8. WHEN dữ liệu industry-stats rỗng hoặc không hợp lệ THEN hệ thống SHALL bỏ qua việc lưu snapshot.
9. IF thời điểm gọi API nằm ngoài giờ giao dịch 09:00 đến 15:00 giờ Việt Nam THEN hệ thống MAY bỏ qua việc tạo mốc intraday mới nhưng vẫn giữ bản ghi tổng hợp cuối ngày của phiên gần nhất.

### Requirement 2: API truy xuất lịch sử lực cầu

**User Story:** Là frontend, tôi muốn có API để lấy dữ liệu lịch sử lực cầu cả theo ngày lẫn theo mốc 15 phút, để hiển thị delta, min/max và biểu đồ.

#### Acceptance Criteria

1. WHEN client gọi `GET /api/industry-history` THEN hệ thống SHALL trả về `{success: true, data: {<date>: {<code>: {lucCau, percentAboveMA10, minLucCau, maxLucCau, ...}}}}` chứa toàn bộ lịch sử tổng hợp cuối ngày đã lưu, mọi giá trị là number.
2. WHEN client gọi `GET /api/industry-history?days=N` THEN hệ thống SHALL chỉ trả về N ngày gần nhất.
3. WHEN client gọi `GET /api/industry-history?code=<icb2>` THEN hệ thống SHALL trả về chuỗi thời gian theo ngày `[{date, lucCau, percentAboveMA10, minLucCau, maxLucCau}]` của riêng ngành đó, sắp xếp theo ngày tăng dần.
4. WHEN client gọi `GET /api/industry-history?code=<icb2>&intraday=<YYYY-MM-DD>` THEN hệ thống SHALL trả về chuỗi intraday theo mốc 15 phút `[{time, lucCau, percentAboveMA10}]` của ngành đó trong ngày chỉ định, sắp xếp theo thời gian tăng dần.
5. WHEN client gọi `GET /api/industry-history/previous` THEN hệ thống SHALL trả về snapshot tổng hợp của phiên gần nhất trước hôm nay để tính delta, kèm ngày của phiên đó.
6. IF chưa có dữ liệu lịch sử nào THEN hệ thống SHALL trả về `{success: true, data: {}}` thay vì lỗi.

### Requirement 3: Hiển thị delta và min/max lực cầu trong bảng ngành

**User Story:** Là nhà đầu tư, khi xem bảng "Chuyển Động Ngành", tôi muốn thấy lực cầu hôm nay thay đổi bao nhiêu so với phiên trước và biên độ thấp/cao trong ngày, để biết ngành nào đang tăng hoặc giảm sức mua.

#### Acceptance Criteria

1. WHEN người dùng bật chế độ Bảng trong panel "Chuyển Động Ngành" THEN hệ thống SHALL hiển thị thêm cột "Δ Lực Cầu" thể hiện chênh lệch lực cầu so với phiên gần nhất trước đó.
2. WHEN dữ liệu min/max trong ngày có sẵn THEN bảng SHALL hiển thị thêm cột "Thấp/Cao" thể hiện lực cầu thấp nhất và cao nhất trong ngày của ngành, ví dụ `41.2 / 58.7`.
3. WHEN delta dương THEN ô SHALL hiển thị màu xanh với dấu cộng ví dụ `+3.2%`, và WHEN delta âm THEN hiển thị màu đỏ ví dụ `-1.8%`.
4. IF không có dữ liệu phiên trước cho ngành đó THEN ô delta SHALL hiển thị `--`; IF không có dữ liệu min/max THEN ô Thấp/Cao SHALL hiển thị `--`.
5. WHEN người dùng sắp xếp bảng theo cột "Δ Lực Cầu" THEN hệ thống SHALL sắp xếp đúng theo giá trị delta dạng số.

### Requirement 4: Biểu đồ lịch sử lực cầu của một ngành

**User Story:** Là nhà đầu tư, tôi muốn click vào một ngành và xem biểu đồ lực cầu của nó theo mốc 15 phút trong ngày hoặc theo nhiều ngày, để đánh giá xu hướng phiên, tuần và tháng.

#### Acceptance Criteria

1. WHEN người dùng mở modal danh sách CP của một ngành bằng cách click dòng hoặc bubble THEN modal SHALL có thêm khu vực biểu đồ đường thể hiện lực cầu và %CP>MA10 của ngành đó theo thời gian.
2. WHEN người dùng chọn chế độ Trong ngày THEN biểu đồ SHALL vẽ chuỗi intraday theo mốc 15 phút của phiên gần nhất; WHEN chọn chế độ Nhiều ngày 7, 30 hoặc tất cả THEN biểu đồ SHALL vẽ chuỗi lực cầu cuối ngày theo các ngày tương ứng.
3. WHEN ở chế độ nhiều ngày và có dữ liệu min/max THEN biểu đồ SHALL có thể hiển thị dải min đến max của mỗi ngày để thấy biên độ dao động.
4. WHEN có ít nhất 2 điểm dữ liệu THEN hệ thống SHALL vẽ biểu đồ đường, và WHEN có ít hơn 2 điểm THEN hệ thống SHALL hiển thị thông báo chưa đủ dữ liệu lịch sử cần ít nhất 2 điểm.
5. WHEN biểu đồ hiển thị THEN trục Y lực cầu SHALL có mốc min 30% và max 70% nhất quán với các chart lực cầu khác trong dự án.

### Requirement 5: Không ảnh hưởng hiệu năng và tính năng hiện có

**User Story:** Là người dùng, tôi muốn tính năng mới không làm chậm hoặc hỏng dashboard đang chạy.

#### Acceptance Criteria

1. WHEN snapshot được lưu vào JSON local THEN thao tác ghi file SHALL chạy nhanh với file nhỏ dưới 1MB; việc đồng bộ Google Sheet SHALL chạy bất đồng bộ tách biệt và KHÔNG chặn response chính.
2. WHEN tính năng lịch sử gặp lỗi THEN panel "Chuyển Động Ngành" và bubble chart hiện có SHALL vẫn hoạt động bình thường.
3. WHEN file `industry-history.json` chưa tồn tại THEN hệ thống SHALL tự tạo mới mà không báo lỗi.
4. WHEN client gọi các API `/api/industry-history` THEN hệ thống SHALL cache kết quả khoảng 30 giây để tránh đọc file liên tục.

### Requirement 6: Bảng số liệu so sánh lực cầu đa mốc thời gian

**User Story:** Là nhà đầu tư, tôi muốn xem một bảng số liệu so sánh lực cầu của từng ngành tại nhiều mốc thời gian cạnh nhau, để nhận ra ngay ngành nào đang cải thiện hoặc suy yếu lực cầu qua thời gian.

#### Acceptance Criteria

1. WHEN người dùng mở chế độ so sánh trong panel "Chuyển Động Ngành" THEN hệ thống SHALL hiển thị một bảng với mỗi dòng là một ngành và các cột số liệu lực cầu tại các mốc: Hôm nay, Hôm qua, Tuần trước khoảng 5 phiên, Tháng trước khoảng 20 phiên.
2. WHEN một mốc thời gian có dữ liệu THEN ô SHALL hiển thị giá trị lực cầu dạng số phần trăm một chữ số thập phân ví dụ `61.1%`, và WHEN mốc đó không có dữ liệu THEN ô SHALL hiển thị `--`.
3. WHEN giá trị lực cầu của một mốc cao hơn mốc liền trước nó THEN ô SHALL được tô màu xanh, và WHEN thấp hơn THEN tô màu đỏ, để thể hiện xu hướng.
4. WHEN người dùng click vào tiêu đề một cột mốc thời gian THEN hệ thống SHALL sắp xếp bảng theo giá trị lực cầu của cột đó.
5. WHEN hệ thống chọn dữ liệu cho từng mốc THEN nó SHALL lấy snapshot của ngày giao dịch gần nhất tại hoặc trước mốc thời gian mục tiêu, dựa trên dữ liệu lịch sử đã lưu.
6. IF chưa đủ dữ liệu lịch sử cho một mốc THEN cột tương ứng SHALL hiển thị `--` mà không gây lỗi bảng.

### Requirement 7: Đồng bộ dữ liệu lên Google Sheet qua Apps Script

**User Story:** Là nhà đầu tư, tôi muốn dữ liệu lực cầu được đẩy lên một Google Sheet do tôi cung cấp, để tôi dễ đọc, lọc và chia sẻ mà không cần truy cập server.

#### Acceptance Criteria

1. WHEN người vận hành cấu hình một URL Apps Script Web App trong biến môi trường ví dụ `GSHEET_SYNC_URL` THEN hệ thống SHALL bật chức năng đồng bộ Google Sheet; WHEN biến này trống THEN hệ thống SHALL bỏ qua đồng bộ và chỉ dùng JSON local.
2. WHEN một snapshot mới được ghi vào JSON local thành công THEN hệ thống SHALL gửi request POST chứa dữ liệu snapshot dạng JSON tới URL Apps Script để ghi vào Google Sheet.
3. WHEN gửi dữ liệu lên Apps Script THEN hệ thống SHALL gom dữ liệu của tất cả ngành trong một lần gửi (batch) thay vì gửi từng ngành riêng lẻ, để tránh vượt quá quota ghi của Google.
4. IF request đồng bộ Google Sheet thất bại hoặc quá thời gian chờ THEN hệ thống SHALL ghi log lỗi và KHÔNG làm ảnh hưởng tới JSON local hay response của `/api/industry-stats`.
5. WHEN đồng bộ Google Sheet THEN thao tác gửi SHALL chạy bất đồng bộ không chặn (fire-and-forget) để không làm chậm response chính.
6. WHEN ghi vào Google Sheet THEN Apps Script SHALL lưu mỗi bản ghi theo cấu trúc cột rõ ràng gồm ngày, thời điểm mốc, mã ngành, tên ngành, lực cầu, %CP>MA10, lực cầu thấp nhất, lực cầu cao nhất, để người dùng đọc trực tiếp trên Sheet.
7. WHEN server khởi động lại THEN dữ liệu đã đồng bộ trên Google Sheet SHALL không bị mất hay ghi đè toàn bộ; Apps Script SHALL chỉ thêm hoặc cập nhật bản ghi theo khóa ngày và mốc thời gian.
