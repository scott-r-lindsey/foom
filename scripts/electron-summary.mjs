// Sum file summaries: the final runner summary counts an empty file as a pass.
export default async function* summary(source) {
  let passed = 0;
  for await (const event of source) {
    if (event.type !== "test:summary") continue;
    if (event.data.file !== undefined) passed += event.data.counts.passed;
    else yield `${JSON.stringify({ passed })}\n`;
  }
}
