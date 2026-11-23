import { el, int, num } from './format.js';
import { t } from './i18n.js';
import { shortDate } from './time.js';

const REPORT_URL = './data/decision-benchmark.json';

export async function renderDecisionBenchmark(host) {
  let report;
  try {
    const response = await fetch(REPORT_URL, { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    if (response.ok) report = await response.json();
  } catch { /* Giữ phần mô tả khi chưa tải được kết quả. */ }
  if (report?.version !== 1 || !report.station?.name || !Array.isArray(report.rows) || !report.rows.length) return;
  if (report.rows.some((row) => !row?.app)) return;

  const published = report.rows.some(({ app }) => Number.isFinite(app.rate));
  host.querySelector('p').textContent = published
    ? t('Tỷ lệ tính trên các lần ClearHour khuyên đổi giờ và có đủ số đo ở cả hai khung. Các khung gần tương đương được tính riêng.')
    : t`Đang thu thập số đo. Tỷ lệ chỉ hiện khi có ít nhất ${int(report.minScored)} lần đổi đủ số đo trong ít nhất ${int(report.minDays)} ngày.`;
  const list = el('ul', { class: 'benchmark__results' }, ...report.rows.map(({ hours, app, available, scenarios, meanLeadHours }) =>
    el('li', {},
      el('strong', {}, t`Báo trước ${hours} giờ`),
      Number.isFinite(app.rate)
        ? el('span', {}, t`${int(app.better)}/${int(app.scored)} lần đổi giúp giảm bụi (${int(app.rate * 100)}%)`)
        : el('span', {}, app.switches ? t`${int(app.scored)}/${int(app.switches)} lần đổi có đủ số đo` : t('Chưa có lượt đối chiếu')),
      scenarios ? el('small', {}, t`${int(available)}/${int(scenarios)} kịch bản có dự báo để chấm`) : null,
      Number.isFinite(meanLeadHours) ? el('small', {}, t`Bản lưu có sẵn trước giờ định đi trung bình ${num(meanLeadHours)} giờ.`) : null,
    ),
  ));
  host.append(
    list,
    el('p', { class: 'muted small' }, report.from
      ? t`Đối chiếu PM2.5 tại trạm ${report.station.name}. Mốc dữ liệu đến ${shortDate(report.through, true)}.`
      : t`Trạm đối chiếu PM2.5 tại Hà Nội: ${report.station.name}.`),
    el('a', { class: 'small', href: REPORT_URL }, t('Xem số liệu kiểm chứng (JSON)')),
  );
}
