// UI-only inventory from the owner's anonymized export. Never used by workers.
export const REPORT_FILE = 'firebase-status.txt';
export const REPORT_KEY = 'firebasePresenceReport';
const STATES = ['active', 'inactive', 'unknown'];

export function parsePresenceReport(text) {
  const lines = text.split(/\r\n|[\r\n]/);
  if (lines[0].trim().toLowerCase() !== 'status') {
    return { error: 'Pehli line status honi chahiye. Number, URL ya secret mat bhejo.' };
  }
  const counts = { active: 0, inactive: 0, unknown: 0 };
  for (let i = 1; i < lines.length; i++) {
    const state = lines[i].trim().toLowerCase();
    if (!state) continue;
    if (!STATES.includes(state)) {
      return { error: `Line ${i + 1}: sirf active, inactive ya unknown chalega.` };
    }
    counts[state]++;
  }
  return { counts };
}

export function formatPresenceReport(report) {
  const label = '📱 <b>Active numbers (file report):</b>';
  const date = new Date(Number.isSafeInteger(report?.uploadedAt) ? report.uploadedAt : NaN);
  const validCounts = STATES.every((s) => Number.isSafeInteger(report?.[s]) && report[s] >= 0);
  if (!validCounts || !Number.isFinite(date.getTime())) {
    return `${label} <i>Unknown — koi valid report nahi hai.</i>`;
  }
  const total = report.active + report.inactive + report.unknown;
  const timestamp = date.toISOString().slice(0, 16).replace('T', ' ');
  return `${label} <b>${report.active}</b> / ${total} reported (inactive: ${report.inactive} · unknown: ${report.unknown})\n<i>Uploaded ${timestamp} UTC · live Firebase count nahi hai.</i>`;
}
