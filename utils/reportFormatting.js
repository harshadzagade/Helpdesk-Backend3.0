const stripHtml = (value) => {
  if (!value) return '';

  return String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
};

const durationMinutes = (start, end) => {
  if (!start || !end) return null;

  const diff = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(diff) || diff < 0) return null;

  return Math.round(diff / 60000);
};

const durationLabel = (minutes) => {
  if (minutes === null || minutes === undefined || minutes === '') return '';

  const totalMinutes = Number(minutes);
  if (!Number.isFinite(totalMinutes)) return '';
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return remainingMinutes > 0 ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`;
};

module.exports = {
  stripHtml,
  durationMinutes,
  durationLabel,
};
