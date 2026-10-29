// SQS consumer: one agent job per message.
import { runJob } from "../jobs/index.mjs";

export async function handler(event) {
  const failures = [];
  for (const record of event.Records ?? []) {
    try {
      await runJob(JSON.parse(record.body));
    } catch (err) {
      console.error("job failed", err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
