// Only fetch the Telegram-provided download link. It can contain the bot token:
// never put the link, download errors or response bodies in user-facing errors.
export async function readTextDocument(ctx, { maxBytes, fetchImpl = fetch }) {
  const tooLarge = { error: `File ${maxBytes / 1024} KiB limit se badi hai.` };
  const doc = ctx.message.document;
  if (doc.file_size > maxBytes) return tooLarge;
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetchImpl(String(link), { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!res.ok || Number(res.headers.get('content-length')) > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return res.ok ? tooLarge : { error: `Telegram file download fail hua (HTTP ${res.status}).` };
    }
    if (!res.body) return { error: 'File khaali hai.' };
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > maxBytes) return tooLarge;
      chunks.push(chunk);
    }
    if (!size) return { error: 'File khaali hai.' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)) };
    } catch {
      return { error: 'File valid UTF-8 text nahi hai.' };
    }
  } catch {
    return { error: 'Telegram se file padh nahi paaya.' };
  }
}
