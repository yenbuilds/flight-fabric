// Real-world recording time, displayed in the viewing device's local timezone.
// Simulator clocks are separate values and must not use this conversion.
export function formatRecordedDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const offset = `UTC${offsetMinutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${offset}`;
}
