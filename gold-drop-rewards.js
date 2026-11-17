// Parse only the actual SMS text. The OTP bot may truncate a URL; do not
// reconstruct it or infer a reward from OTP verification alone.
export function extractGoldDropReward(text = '') {
  const input = String(text);
  const match = input.match(/(?:\[[^\]\r\n]{1,40}\]\s*)?Success\s*!?\s*Your Reward Code is\s+([A-Za-z0-9]{6,})(?![A-Za-z0-9])[^\r\n]*/i);
  if (!match) return null;
  return { code: match[1].toUpperCase(), sms: match[0].trim() };
}

export function isNewGoldDropReward(text, baseline = []) {
  const reward = extractGoldDropReward(text);
  if (!reward) return false;
  return !baseline.some(old => extractGoldDropReward(old)?.code === reward.code);
}
