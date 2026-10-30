// SQS consumer: one agent job per message.
import { runJob, failJob } from "../jobs/index.mjs";

export async function handler(event, context) {
  const failures = [];
  for (const record of event.Records ?? []) {
    const job = JSON.parse(record.body);
    // Mark the job failed shortly before Lambda's hard timeout, so the dashboard never shows a job stuck "running".
    const left = context?.getRemainingTimeInMillis?.() ?? 900_000;
    let timer;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("ran out of time; partial results were kept where possible")), Math.max(5_000, left - 25_000));
    });
    try {
      await Promise.race([runJob(job), watchdog]);
    } catch (err) {
      console.error("job failed", err);
      if (/ran out of time/.test(err.message)) await failJob(job, err).catch(() => {});
      else failures.push({ itemIdentifier: record.messageId });
    } finally {
      clearTimeout(timer);
    }
  }
  return { batchItemFailures: failures };
}
