# TA — Technical Analysis Library

Code lọc tín hiệu kỹ thuật + CP tiềm năng, tách riêng để dùng cho dự án Web.

## Cấu trúc

```
TA/
├── scanners/                    # Bộ lọc CP tiềm năng (chạy hàng ngày)
│   ├── rs-scanner.service.ts    # RS Breakout — CP mạnh hơn thị trường
│   ├── macd-scanner.service.ts  # MACD Crossover — tín hiệu momentum
│   ├── potential-scanner.service.ts  # CP tiềm năng tổng hợp
│   ├── trendline-scanner.service.ts  # Break trendline
│   └── ath-scanner.ts           # All-Time High scanner
│
├── indicators/                  # Hàm tính chỉ báo kỹ thuật
│   ├── historical-backtester.service.ts  # calcSMA, calcEMA, calcRSI, calcMACDHistogram, calcVolumeRatio, fetchHistoricalPrices
│   └── blind-backtest.service.ts         # calcBollingerBands, calcADX, calcDMI
│
├── backtest/                    # Full Historical Backtest Engine
│   ├── full-backtest.service.ts # Engine chính: fetch 5 năm, loop mỗi ngày, check signal
│   └── combo-finder.service.ts  # Generate ~110 combo chỉ báo (RSI, MACD, ADX, MA, Volume...)
│
└── tools/                       # Phân tích CP chi tiết (dùng cho chat/web)
    ├── analyzeStock.ts          # Phân tích toàn diện 1 CP (kỹ thuật + cơ bản + tin tức)
    ├── chartPatterns.ts         # Nhận diện mô hình chart (VCP, Cup&Handle, Stage...)
    └── chartVision.ts           # Chart analysis bằng AI vision
```

## Chỉ báo kỹ thuật có sẵn

| Indicator | File | Hàm |
|---|---|---|
| SMA (mọi period) | `indicators/historical-backtester.service.ts` | `calcSMA(prices, period)` |
| EMA | same | `calcEMA(prices, period)` |
| RSI(14) | same | `calcRSI(prices, period)` |
| MACD(12,26,9) | same | `calcMACDHistogram(prices)` |
| Volume Ratio | same | `calcVolumeRatio(volumes, index)` |
| Bollinger Bands | `indicators/blind-backtest.service.ts` | `calcBollingerBands(closes, period, stddev)` |
| ADX(14) | same | `calcADX(data, period)` |
| DMI (+DI, -DI) | same | `calcDMI(data, period)` |

## Data Source

- **Fireant API** (miễn phí, không cần auth):
  - `https://www.fireant.vn/api/Data/Markets/HistoricalQuotes?symbol=FPT&startDate=2020-01-01&endDate=2026-05-20`
  - `https://www.fireant.vn/api/Data/Markets/Quotes?symbols=FPT` (realtime intraday)

## Combo Backtest (đã test 5 năm, 106 CP VN100)

Top 3 combo tốt nhất (sau phí 0.3%, hold T+5→T+10):
1. **RSI<40 + MACD cross up + Vol>1.5x** → win 60.6%, avg P&L +4.01%
2. **>MA200 + RSI<30** → win 54.4%, avg P&L +1.63%
3. **ADX>30 + Vol>2x** → win 48.7%, avg P&L +0.93%

## Tech Stack

- Runtime: Bun (TypeScript)
- Không dependency ngoài (pure math, fetch API)
- Có thể port sang Node.js/Deno dễ dàng (chỉ cần đổi import)
