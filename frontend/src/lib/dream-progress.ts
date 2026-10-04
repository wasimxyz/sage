export function formatDreamProgress(done: number, total: number): string {
  if (total <= 0) {
    return "0% complete";
  }
  const percent = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  return `${percent}% complete`;
}
