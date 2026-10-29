// Job queue: SQS in AWS, in-process in local memory mode.
import { db, id, now } from "./db.mjs";

export async function enqueue(job) {
  const jobId = job.jobId ?? id(12);
  const full = { ...job, jobId, enqueuedAt: now() };
  if (job.productId) {
    await db.put({
      pk: `PRODUCT#${job.productId}`,
      sk: `JOB#${full.enqueuedAt}#${jobId}`,
      type: "job",
      jobId,
      jobType: job.type,
      status: "queued",
      createdAt: full.enqueuedAt,
    });
  }
  if (!process.env.QUEUE_URL) {
    // Local: run after the current request returns.
    const { runJob } = await import("../jobs/index.mjs");
    setTimeout(() => runJob(full).catch((e) => console.error("job failed", job.type, e)), 10);
    return full;
  }
  const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");
  await new SQSClient({}).send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(full) }));
  return full;
}
