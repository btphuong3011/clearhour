// Chỉ số chất lượng không khí Việt Nam (VN_AQI) theo Quyết định 1459/QĐ-TCMT (12/11/2019)
// của Tổng cục Môi trường. Bảng 2: giá trị BPi (µg/m³) cho PM2.5 và PM10.

const BREAKPOINTS = {
  pm2_5: [
    [0, 0],
    [25, 50],
    [50, 100],
    [80, 150],
    [150, 200],
    [250, 300],
    [350, 400],
    [500, 500],
  ],
  pm10: [
    [0, 0],
    [50, 50],
    [150, 100],
    [250, 150],
    [350, 200],
    [420, 300],
    [500, 400],
    [600, 500],
  ],
};

// Bảng 1 (khoảng giá trị, tên mức, màu chuẩn RGB) + Bảng 5 (khuyến nghị hoạt động).
// `color` là màu chuẩn của QĐ 1459; `display` được chỉnh độ đậm để dễ đọc trên màn hình.
export const LEVELS = [
  {
    id: 'good',
    max: 50,
    label: 'Tốt',
    color: 'rgb(0,228,0)',
    display: '#2fb94a',
    ink: '#0b2e14',
    advice: {
      normal: 'Thoải mái hoạt động ngoài trời.',
      sensitive: 'Thoải mái hoạt động ngoài trời.',
    },
  },
  {
    id: 'moderate',
    max: 100,
    label: 'Trung bình',
    color: 'rgb(255,255,0)',
    display: '#f2c200',
    ink: '#3a2f00',
    advice: {
      normal: 'Thoải mái hoạt động ngoài trời.',
      sensitive: 'Vẫn có thể ra ngoài, nhưng hãy để ý các dấu hiệu như ho hoặc khó thở.',
    },
  },
  {
    id: 'poor',
    max: 150,
    label: 'Kém',
    color: 'rgb(255,126,0)',
    display: '#ff7e00',
    ink: '#3d1d00',
    advice: {
      normal: 'Nếu thấy cay mắt, ho hoặc đau họng, nên bớt thời gian ở ngoài trời. Học sinh nên rút ngắn giờ tập thể dục.',
      sensitive: 'Nên giảm vận động mạnh và rút ngắn thời gian ngoài trời. Người bị hen có thể cần dùng thuốc thường xuyên hơn.',
    },
  },
  {
    id: 'unhealthy',
    max: 200,
    label: 'Xấu',
    color: 'rgb(255,0,0)',
    display: '#e5262b',
    ink: '#ffffff',
    advice: {
      normal: 'Giảm vận động mạnh ngoài trời, tránh tập luyện kéo dài, nghỉ ngơi trong nhà nhiều hơn.',
      sensitive: 'Nên ở trong nhà và hạn chế vận động mạnh. Nếu bắt buộc ra ngoài, hãy đeo khẩu trang đạt chuẩn (N95/KN95).',
    },
  },
  {
    id: 'very-unhealthy',
    max: 300,
    label: 'Rất xấu',
    color: 'rgb(143,63,151)',
    display: '#8f3f97',
    ink: '#ffffff',
    advice: {
      normal: 'Hạn chế tối đa ra ngoài, chuyển mọi hoạt động vào trong nhà. Nếu phải ra ngoài, đeo khẩu trang đạt chuẩn.',
      sensitive: 'Ở trong nhà và hạn chế vận động mạnh.',
    },
  },
  {
    id: 'hazardous',
    max: Infinity,
    label: 'Nguy hại',
    color: 'rgb(126,0,35)',
    display: '#7e0023',
    ink: '#ffffff',
    advice: {
      normal: 'Mọi người nên ở trong nhà, đóng kín cửa. Nếu phải ra ngoài, đeo khẩu trang đạt chuẩn.',
      sensitive: 'Mọi người nên ở trong nhà, đóng kín cửa. Nếu phải ra ngoài, đeo khẩu trang đạt chuẩn.',
    },
  },
];

/** Nội suy tuyến tính trên bảng BPi (Công thức 1/2 của QĐ 1459). */
export function aqiFromConcentration(c, pollutant = 'pm2_5') {
  if (c == null || Number.isNaN(c)) return null;
  const table = BREAKPOINTS[pollutant];
  if (!table) throw new Error(`Không hỗ trợ thông số ${pollutant}`);
  if (c <= 0) return 0;
  const last = table[table.length - 1];
  if (c >= last[0]) return last[1];
  for (let i = 0; i < table.length - 1; i++) {
    const [bpLo, iLo] = table[i];
    const [bpHi, iHi] = table[i + 1];
    if (c <= bpHi) {
      return Math.round(((iHi - iLo) / (bpHi - bpLo)) * (c - bpLo) + iLo);
    }
  }
  return last[1];
}

/**
 * Giá trị Nowcast từ tối đa 12 giá trị trung bình 1 giờ, c[0] là giờ hiện tại.
 * w* = Cmin/Cmax; nếu w* ≤ 0,5 thì lấy w = 0,5, ngược lại w = w*.
 * Cần ít nhất 2 trong 3 giờ gần nhất có dữ liệu.
 */
export function nowcast(values) {
  const c = values.slice(0, 12);
  const recent = c.slice(0, 3).filter((v) => v != null && !Number.isNaN(v));
  if (recent.length < 2) return null;
  const present = c.filter((v) => v != null && !Number.isNaN(v));
  const cMax = Math.max(...present);
  const cMin = Math.min(...present);
  const wStar = cMax === 0 ? 1 : cMin / cMax;
  const w = wStar <= 0.5 ? 0.5 : wStar;
  let num = 0;
  let den = 0;
  c.forEach((v, i) => {
    if (v == null || Number.isNaN(v)) return;
    const weight = w ** i;
    num += weight * v;
    den += weight;
  });
  return den === 0 ? null : num / den;
}

export function levelForAqi(aqi) {
  if (aqi == null) return null;
  return LEVELS.find((l) => aqi <= l.max);
}

export function levelForPm25(c) {
  return levelForAqi(aqiFromConcentration(c, 'pm2_5'));
}

/** VN_AQI cuối cùng là giá trị lớn nhất trong các AQI thành phần. */
export function combinedAqi({ pm2_5, pm10 }) {
  const parts = [aqiFromConcentration(pm2_5, 'pm2_5'), aqiFromConcentration(pm10, 'pm10')].filter(
    (v) => v != null,
  );
  return parts.length ? Math.max(...parts) : null;
}

// Hướng dẫn chất lượng không khí của WHO (2021): PM2.5 trung bình 24 giờ 15 µg/m³, trung bình năm 5 µg/m³.
export const WHO_PM25_24H = 15;

// Berkeley Earth: hít thở không khí có PM2.5 trung bình 22 µg/m³ trong 24 giờ
// tương đương hút khoảng 1 điếu thuốc lá về tác hại sức khỏe.
export const PM25_PER_CIGARETTE_DAY = 22;

export function cigarettesPerDay(dailyMeanPm25) {
  if (dailyMeanPm25 == null) return null;
  return dailyMeanPm25 / PM25_PER_CIGARETTE_DAY;
}
