export function Highlight({ text, filter }: { text: string; filter: string }) {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const parts = [];
  let start = 0;
  let index = lower.indexOf(query);
  while (index >= 0) {
    parts.push(
      text.slice(start, index),
      <mark key={index}>{text.slice(index, index + query.length)}</mark>,
    );
    start = index + query.length;
    index = lower.indexOf(query, start);
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}
