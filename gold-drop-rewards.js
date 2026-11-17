// Extract the original SMS, without inventing or repairing a truncated URL.
// Match the reward-code structure rather than requiring an exact sentence.
export function extractGoldDropReward(text = '') {
  const input = String(text);
  const match = /\breward\b[\s\S]{0,35}?\bcode\b\s*(?:(?:is|as)\b\s*)?[:=\-–]?\s*([A-Za-z0-9]{6,32})(?![A-Za-z0-9])/i.exec(input);
  if (!match) return null;
  const startLine = input.lastIndexOf('\n', match.index - 1) + 1;
  const sender = input.slice(startLine, match.index).match(/\[[^\]\r\n]{1,40}\]/);
  const start = sender ? startLine + sender.index : startLine;
  const endLine = input.indexOf('\n', match.index + match[0].length);
  return { code: match[1].toUpperCase(), sms: input.slice(start, endLine < 0 ? input.length : endLine).trim() };
}

export function isNewGoldDropReward(text, baseline = []) {
  const reward = extractGoldDropReward(text);
  if (!reward) return false;
  return !baseline.some(old => extractGoldDropReward(old)?.code === reward.code);
}
