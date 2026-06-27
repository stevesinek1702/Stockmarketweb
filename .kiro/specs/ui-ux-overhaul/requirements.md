# Requirements Document

## Introduction

Tài liệu này mô tả yêu cầu cho dự án "Nâng cấp & Hoàn thiện Giao diện/Trải nghiệm người dùng" (UI/UX Overhaul) của ứng dụng web phân tích thị trường chứng khoán Việt Nam (VN Stock Market). Mục tiêu là hoàn thiện và đánh bóng giao diện hiện có để đạt mức chuyên nghiệp và đẹp mắt nhất có thể, đồng thời giữ nguyên toàn bộ chức năng nghiệp vụ đang hoạt động.

Ứng dụng hiện tại dùng HTML/CSS/JS thuần, Chart.js cho biểu đồ, Gridstack.js cho bảng điều khiển kéo-thả, font Inter + Space Grotesk, giao diện tối (dark theme) và toàn bộ nội dung bằng tiếng Việt. Ứng dụng gồm 7 tab: Dashboard, Bảng Giá, Bộ Lọc CP, Phân Tích Ngành, Breakout, CP Tiềm Năng, Tin Tức.

Phạm vi nâng cấp tập trung vào 5 nhóm mục tiêu:
1. Tích hợp TradingView Lightweight Charts cho biểu đồ nến/khối lượng/đường xu hướng chuyên nghiệp (song song với Chart.js hiện có).
2. Chuẩn hóa hệ thống thiết kế (design system): bảng màu, khoảng cách, kiểu chữ nhất quán dựa trên biến CSS sẵn có.
3. Bổ sung trạng thái tải dạng khung xương (skeleton loading) thay cho chữ "Đang tải...".
4. Đánh bóng dark theme và bổ sung micro-interaction (hover, transition).
5. Cải thiện responsive cho điện thoại và máy tính bảng.

Tài liệu này chỉ mô tả YÊU CẦU (cái gì cần đạt), không mô tả giải pháp kỹ thuật chi tiết (sẽ nằm trong tài liệu Design).

## Glossary

- **Hệ_Thống**: Toàn bộ ứng dụng web VN Stock Market (frontend) sau khi nâng cấp UI/UX.
- **Design_System**: Tập hợp các quy ước thiết kế gồm bảng màu, thang khoảng cách (spacing scale), thang kiểu chữ (typography scale), bo góc, đổ bóng và chuyển động, được định nghĩa tập trung bằng biến CSS (CSS custom properties) trong tệp `css/style.css`.
- **CSS_Variable**: Biến CSS (CSS custom property dạng `--ten-bien`) định nghĩa trong khối `:root` của `css/style.css`, dùng làm nguồn giá trị duy nhất cho màu, khoảng cách, kiểu chữ.
- **TradingView_Chart**: Thành phần biểu đồ dùng thư viện TradingView Lightweight Charts để hiển thị biểu đồ nến (candlestick), khối lượng (volume) và đường xu hướng (trendline) của một mã cổ phiếu.
- **Chart_Modal**: Cửa sổ pop-up (modal) hiển thị biểu đồ chi tiết của một mã cổ phiếu, đã tồn tại trong HTML với id `tv-modal`.
- **Skeleton_Loader**: Thành phần giao diện hiển thị khung xương dạng khối/đường mờ nhấp nháy (shimmer) trong lúc dữ liệu đang được tải, thay cho dòng chữ tĩnh "Đang tải...".
- **Loading_State**: Trạng thái của một vùng giao diện khi dữ liệu tương ứng đang được tải về (chưa có dữ liệu hiển thị).
- **Error_State**: Trạng thái của một vùng giao diện khi việc tải dữ liệu thất bại.
- **Empty_State**: Trạng thái của một vùng giao diện khi tải dữ liệu thành công nhưng không có dữ liệu để hiển thị.
- **Data_Panel**: Một vùng hiển thị dữ liệu trong Hệ_Thống (ví dụ: thẻ chỉ số, bảng dữ liệu, danh sách top cổ phiếu, lưới tin tức).
- **Micro_Interaction**: Hiệu ứng phản hồi trực quan nhỏ khi người dùng tương tác (hover, focus, nhấn, chuyển tab), thực hiện qua transition/animation CSS.
- **Breakpoint**: Ngưỡng chiều rộng màn hình (tính bằng px) tại đó bố cục giao diện thay đổi để phù hợp thiết bị.
- **Mobile_Layout**: Bố cục dành cho màn hình có chiều rộng ≤ 480px.
- **Tablet_Layout**: Bố cục dành cho màn hình có chiều rộng từ 481px đến 1024px.
- **Desktop_Layout**: Bố cục dành cho màn hình có chiều rộng > 1024px.
- **Reduced_Motion**: Tùy chọn hệ điều hành `prefers-reduced-motion: reduce` cho biết người dùng muốn giảm chuyển động.
- **Theme_Token**: Một giá trị thiết kế nguyên tử (màu, khoảng cách, kích thước chữ) được tham chiếu qua CSS_Variable.

## Requirements

### Requirement 1: Tích hợp biểu đồ TradingView Lightweight Charts

**User Story:** Là một nhà đầu tư, tôi muốn xem biểu đồ nến chuyên nghiệp với khối lượng và đường xu hướng cho từng mã cổ phiếu, để tôi có thể phân tích kỹ thuật trực tiếp trên ứng dụng.

#### Acceptance Criteria

1. WHEN người dùng kích hoạt xem biểu đồ chi tiết của một mã cổ phiếu, THE Hệ_Thống SHALL hiển thị TradingView_Chart dạng nến (candlestick) cho mã cổ phiếu đó trong Chart_Modal.
2. WHEN TradingView_Chart được hiển thị, THE Hệ_Thống SHALL hiển thị một dải khối lượng (volume) gắn với cùng trục thời gian của biểu đồ nến.
3. WHERE dữ liệu đường xu hướng (trendline) của mã cổ phiếu có sẵn, THE TradingView_Chart SHALL vẽ đường xu hướng đó chồng lên biểu đồ nến.
4. WHILE Chart_Modal đang mở, THE Hệ_Thống SHALL tiếp tục hiển thị các biểu đồ Chart.js hiện có ở các vùng khác mà không thay thế chúng.
5. IF dữ liệu biểu đồ của mã cổ phiếu không tải được, THEN THE Hệ_Thống SHALL hiển thị thông báo lỗi bằng tiếng Việt bên trong Chart_Modal.
6. WHEN kích thước cửa sổ trình duyệt hoặc Chart_Modal thay đổi, THE TradingView_Chart SHALL điều chỉnh kích thước để vừa khít vùng chứa.
7. THE TradingView_Chart SHALL sử dụng bảng màu của Design_System cho màu nền, lưới, nến tăng và nến giảm.
8. WHEN người dùng đóng Chart_Modal, THE Hệ_Thống SHALL giải phóng tài nguyên của TradingView_Chart để tránh rò rỉ bộ nhớ.

### Requirement 2: Chuẩn hóa hệ thống thiết kế (Design System)

**User Story:** Là người dùng, tôi muốn giao diện có màu sắc, khoảng cách và kiểu chữ nhất quán trên mọi tab, để trải nghiệm trông chuyên nghiệp và liền mạch.

#### Acceptance Criteria

1. THE Design_System SHALL định nghĩa toàn bộ Theme_Token về màu sắc, khoảng cách, kiểu chữ, bo góc và đổ bóng dưới dạng CSS_Variable trong khối `:root` của `css/style.css`.
2. WHERE một thành phần giao diện cần giá trị màu, khoảng cách hoặc kích thước chữ, THE thành phần đó SHALL tham chiếu Theme_Token qua CSS_Variable thay vì dùng giá trị cố định nội tuyến (hard-coded).
3. THE Design_System SHALL định nghĩa thang kiểu chữ gồm các cấp kích thước rời rạc cho tiêu đề, văn bản nội dung và nhãn phụ.
4. THE Hệ_Thống SHALL áp dụng font hiển thị Space Grotesk cho các tiêu đề và font Inter cho văn bản nội dung.
5. THE Hệ_Thống SHALL hiển thị mọi giá trị số liệu tài chính bằng chữ số đẳng khoảng (tabular figures) để các chữ số thẳng cột.
6. WHERE một màu thể hiện trạng thái tăng giá, THE Hệ_Thống SHALL dùng token màu xanh của Design_System; WHERE một màu thể hiện trạng thái giảm giá, THE Hệ_Thống SHALL dùng token màu đỏ của Design_System.
7. THE Hệ_Thống SHALL áp dụng cùng một bộ Theme_Token về khoảng cách và bo góc cho các loại thẻ (card) tương đương trên tất cả 7 tab.

### Requirement 3: Trạng thái tải dạng khung xương (Skeleton Loading)

**User Story:** Là người dùng, tôi muốn thấy khung xương nội dung khi dữ liệu đang tải thay vì dòng chữ "Đang tải...", để cảm nhận ứng dụng phản hồi nhanh và mượt mà.

#### Acceptance Criteria

1. WHILE một Data_Panel đang ở Loading_State, THE Hệ_Thống SHALL hiển thị Skeleton_Loader có hình dạng tương ứng với cấu trúc nội dung sẽ xuất hiện (bảng, danh sách, thẻ hoặc biểu đồ).
2. WHEN dữ liệu của một Data_Panel tải về thành công, THE Hệ_Thống SHALL thay thế Skeleton_Loader bằng nội dung dữ liệu thực.
3. WHILE Skeleton_Loader đang hiển thị, THE Skeleton_Loader SHALL thể hiện hiệu ứng nhấp nháy (shimmer) để báo hiệu đang tải.
4. THE Hệ_Thống SHALL thay thế các dòng chữ tĩnh "Đang tải..." và "Đang tải dữ liệu..." hiện có trong các bảng và danh sách bằng Skeleton_Loader.
5. IF việc tải dữ liệu của một Data_Panel thất bại, THEN THE Hệ_Thống SHALL chuyển Data_Panel đó sang Error_State với thông báo lỗi bằng tiếng Việt và một hành động thử lại.
6. WHEN việc tải dữ liệu của một Data_Panel hoàn tất nhưng không có dữ liệu, THE Hệ_Thống SHALL hiển thị Empty_State với thông báo bằng tiếng Việt thay cho Skeleton_Loader.
7. WHERE Reduced_Motion được bật, THE Skeleton_Loader SHALL hiển thị ở trạng thái tĩnh không có hiệu ứng nhấp nháy.

### Requirement 4: Đánh bóng dark theme và micro-interaction

**User Story:** Là người dùng, tôi muốn giao diện tối có chiều sâu và phản hồi tinh tế khi tương tác, để trải nghiệm sử dụng cảm thấy cao cấp và sống động.

#### Acceptance Criteria

1. WHEN con trỏ chuột di vào một phần tử tương tác (thẻ, nút, hàng bảng, mục danh sách có thể nhấp), THE Hệ_Thống SHALL áp dụng Micro_Interaction phản hồi trực quan trong khoảng thời gian từ 0.15s đến 0.3s.
2. WHEN người dùng chuyển giữa các tab, THE Hệ_Thống SHALL áp dụng hiệu ứng chuyển cảnh cho nội dung tab được kích hoạt.
3. WHEN một phần tử nhập liệu (input, select) nhận focus, THE Hệ_Thống SHALL hiển thị dấu hiệu focus rõ ràng dùng token màu nhấn của Design_System.
4. THE Hệ_Thống SHALL áp dụng thang đổ bóng (shadow) và phân lớp nền của Design_System để tạo chiều sâu thị giác giữa nền, thẻ và các thành phần nổi.
5. WHERE Reduced_Motion được bật, THE Hệ_Thống SHALL vô hiệu hóa hoàn toàn mọi hiệu ứng chuyển động không thiết yếu.
6. THE Hệ_Thống SHALL duy trì tỷ lệ tương phản giữa văn bản nội dung và nền nền tối đạt tối thiểu 4.5:1.
7. WHEN một hành động chạy ngầm đang diễn ra (làm mới dữ liệu, quét tín hiệu), THE Hệ_Thống SHALL hiển thị chỉ báo trạng thái trực quan cho hành động đó.

### Requirement 5: Cải thiện responsive cho điện thoại và máy tính bảng

**User Story:** Là người dùng dùng điện thoại hoặc máy tính bảng, tôi muốn ứng dụng hiển thị gọn gàng và dùng được trên màn hình nhỏ, để tôi có thể theo dõi thị trường mọi lúc mọi nơi.

#### Acceptance Criteria

1. WHILE Hệ_Thống hiển thị trên Mobile_Layout, THE Hệ_Thống SHALL sắp xếp các thẻ tổng quan và lưới dashboard thành một cột dọc.
2. WHILE Hệ_Thống hiển thị trên Tablet_Layout, THE Hệ_Thống SHALL sắp xếp các thẻ tổng quan và lưới dashboard tối đa hai cột.
3. WHILE Hệ_Thống hiển thị trên Mobile_Layout, THE thanh điều hướng (navigation) gồm 7 tab SHALL hiển thị ở dạng cho phép truy cập mọi tab mà không tràn ra ngoài chiều rộng màn hình.
4. WHEN một bảng dữ liệu rộng hơn chiều rộng màn hình, THE Hệ_Thống SHALL cho phép cuộn ngang bảng đó mà không làm tràn bố cục trang.
5. WHILE Hệ_Thống hiển thị trên Mobile_Layout, THE Hệ_Thống SHALL bảo đảm mọi phần tử tương tác chính có vùng chạm tối thiểu 44x44 pixel.
6. WHEN chiều rộng màn hình vượt qua một Breakpoint, THE Hệ_Thống SHALL chuyển sang bố cục tương ứng mà không gây mất nội dung hoặc chồng lấp phần tử.
7. WHILE Hệ_Thống hiển thị trên Mobile_Layout, THE TradingView_Chart và các biểu đồ Chart.js SHALL co giãn vừa khít chiều rộng vùng chứa.

### Requirement 6: Bảo toàn chức năng nghiệp vụ hiện có

**User Story:** Là người dùng hiện tại, tôi muốn mọi tính năng đang hoạt động vẫn giữ nguyên sau khi nâng cấp giao diện, để tôi không bị mất bất kỳ khả năng phân tích nào.

#### Acceptance Criteria

1. WHEN quá trình nâng cấp UI/UX hoàn tất, THE Hệ_Thống SHALL giữ nguyên đầy đủ 7 tab: Dashboard, Bảng Giá, Bộ Lọc CP, Phân Tích Ngành, Breakout, CP Tiềm Năng và Tin Tức.
2. THE Hệ_Thống SHALL giữ nguyên khả năng kéo-thả, thay đổi kích thước, thu gọn và ẩn panel của bảng điều khiển Gridstack trên tab Dashboard.
3. THE Hệ_Thống SHALL giữ nguyên các chức năng lọc, sắp xếp và tìm kiếm cổ phiếu hiện có trên tab Bảng Giá và Bộ Lọc CP.
4. WHEN dữ liệu thị trường được làm mới tự động theo chu kỳ, THE Hệ_Thống SHALL tiếp tục cập nhật các Data_Panel như hành vi hiện tại.
5. THE Hệ_Thống SHALL giữ nguyên việc lưu và khôi phục thiết lập người dùng trong localStorage (bố cục lưới, bộ lọc đã lưu, thiết lập bảng giá).
