// Single-table data access. Two backends:
//  - DynamoDB (default, used in Lambda)
//  - in-memory / JSON file (DB=memory) for local development and tests
//
// Key design (pk / sk):
//   PRODUCT#<id>      META                      product + product card
//   PRODUCT#<id>      SIGNAL#<id>               scored public post / page
//   PRODUCT#<id>      CLUSTER#<id>              pain-point cluster
//   PRODUCT#<id>      INTERMEDIARY#<id>         community / agency / account that gathers the audience
//   PRODUCT#<id>      EXP#<id>                  experiment (with counters)
//   PRODUCT#<id>      EVENT#<ts>#<id>           click / signup / payment event
//   PRODUCT#<id>      JOB#<ts>#<id>             job status log
//   LINK#<slug>       META                      tracking link -> product + experiment
//   BANK#<category>   OUTCOME#<ts>#<id>         anonymised experiment outcome (the traction bank)
//   gsi1: PRODUCTS / <createdAt>  lists products; BANK / <ts> lists all outcomes

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const useMemory = process.env.DB === "memory";

// ---------------- memory backend ----------------
const FILE = process.env.LOCAL_DB_FILE || "";
let mem = new Map();
if (useMemory && FILE && existsSync(FILE)) {
  mem = new Map(Object.entries(JSON.parse(readFileSync(FILE, "utf8"))));
}
function persist() {
  if (!FILE) return;
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(Object.fromEntries(mem)));
}
const k = (pk, sk) => `${pk}\u0000${sk}`;
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

const memory = {
  async put(item) {
    mem.set(k(item.pk, item.sk), clone(item));
    persist();
    return item;
  },
  async get(pk, sk) {
    return clone(mem.get(k(pk, sk)));
  },
  async query(pk, prefix = "", { limit = 1000, reverse = false } = {}) {
    let rows = [...mem.values()].filter((r) => r.pk === pk && r.sk.startsWith(prefix));
    rows.sort((a, b) => (a.sk < b.sk ? -1 : 1));
    if (reverse) rows.reverse();
    return clone(rows.slice(0, limit));
  },
  async queryGsi(gpk, prefix = "", { limit = 1000, reverse = false } = {}) {
    let rows = [...mem.values()].filter((r) => r.gsi1pk === gpk && String(r.gsi1sk ?? "").startsWith(prefix));
    rows.sort((a, b) => (a.gsi1sk < b.gsi1sk ? -1 : 1));
    if (reverse) rows.reverse();
    return clone(rows.slice(0, limit));
  },
  async update(pk, sk, set = {}, add = {}) {
    const cur = mem.get(k(pk, sk)) ?? { pk, sk };
    Object.assign(cur, clone(set));
    for (const [f, n] of Object.entries(add)) cur[f] = (cur[f] ?? 0) + n;
    mem.set(k(pk, sk), cur);
    persist();
    return clone(cur);
  },
  async del(pk, sk) {
    mem.delete(k(pk, sk));
    persist();
  },
  _reset() {
    mem = new Map();
  },
};

// ---------------- DynamoDB backend ----------------
let doc;
async function ddb() {
  if (doc) return doc;
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const lib = await import("@aws-sdk/lib-dynamodb");
  doc = {
    client: lib.DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    }),
    lib,
  };
  return doc;
}
const TABLE = () => process.env.TABLE_NAME;

async function queryAll(params, limit) {
  const { client, lib } = await ddb();
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await client.send(new lib.QueryCommand({ ...params, ExclusiveStartKey }));
    out.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && out.length < limit);
  return out.slice(0, limit);
}

const dynamo = {
  async put(item) {
    const { client, lib } = await ddb();
    await client.send(new lib.PutCommand({ TableName: TABLE(), Item: item }));
    return item;
  },
  async get(pk, sk) {
    const { client, lib } = await ddb();
    const res = await client.send(new lib.GetCommand({ TableName: TABLE(), Key: { pk, sk } }));
    return res.Item;
  },
  async query(pk, prefix = "", { limit = 1000, reverse = false } = {}) {
    return queryAll(
      {
        TableName: TABLE(),
        KeyConditionExpression: prefix ? "pk = :pk AND begins_with(sk, :p)" : "pk = :pk",
        ExpressionAttributeValues: prefix ? { ":pk": pk, ":p": prefix } : { ":pk": pk },
        ScanIndexForward: !reverse,
      },
      limit,
    );
  },
  async queryGsi(gpk, prefix = "", { limit = 1000, reverse = false } = {}) {
    return queryAll(
      {
        TableName: TABLE(),
        IndexName: "gsi1",
        KeyConditionExpression: prefix ? "gsi1pk = :pk AND begins_with(gsi1sk, :p)" : "gsi1pk = :pk",
        ExpressionAttributeValues: prefix ? { ":pk": gpk, ":p": prefix } : { ":pk": gpk },
        ScanIndexForward: !reverse,
      },
      limit,
    );
  },
  async update(pk, sk, set = {}, add = {}) {
    const { client, lib } = await ddb();
    const names = {};
    const values = {};
    const sets = [];
    const adds = [];
    let i = 0;
    for (const [f, v] of Object.entries(set)) {
      names[`#s${i}`] = f;
      values[`:s${i}`] = v;
      sets.push(`#s${i} = :s${i}`);
      i++;
    }
    for (const [f, v] of Object.entries(add)) {
      names[`#a${i}`] = f;
      values[`:a${i}`] = v;
      adds.push(`#a${i} :a${i}`);
      i++;
    }
    const expr = [sets.length ? `SET ${sets.join(", ")}` : "", adds.length ? `ADD ${adds.join(", ")}` : ""]
      .filter(Boolean)
      .join(" ");
    const res = await client.send(
      new lib.UpdateCommand({
        TableName: TABLE(),
        Key: { pk, sk },
        UpdateExpression: expr,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return res.Attributes;
  },
  async del(pk, sk) {
    const { client, lib } = await ddb();
    await client.send(new lib.DeleteCommand({ TableName: TABLE(), Key: { pk, sk } }));
  },
};

export const db = useMemory ? memory : dynamo;

export const id = (n = 10) => {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (const b of bytes) s += a[b % a.length];
  return s;
};
export const now = () => new Date().toISOString();
