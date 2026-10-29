// Daily: judge every product that has running experiments (verdict + traction bank update).
import { db } from "../lib/db.mjs";
import { enqueue } from "../lib/queue.mjs";

export async function handler() {
  const products = await db.queryGsi("PRODUCTS");
  let queued = 0;
  for (const p of products) {
    const exps = await db.query(`PRODUCT#${p.id}`, "EXP#");
    if (exps.some((e) => e.status === "running")) {
      await enqueue({ type: "measure", productId: p.id });
      queued++;
    }
  }
  return { queued };
}
