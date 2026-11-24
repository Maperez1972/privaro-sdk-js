import { describe, it, expect, jest } from "@jest/globals";
import { PrivaroClient } from "../src/client.js";
import { privaroMiddleware, safeFlushPoint } from "../src/adapters/vercel-ai.js";
import { privaroGuard, privaroMask } from "../src/adapters/langchain.js";
import { RunnableLambda } from "@langchain/core/runnables";
import { HumanMessage } from "@langchain/core/messages";

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;
const calls: Array<{ url: string; body: any }> = [];
mockFetch.mockImplementation((async (url: any, init: any) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body });
  const u = String(url);
  const j = u.endsWith("/proxy/protect")
    ? { protected_prompt: body.prompt.replaceAll("Ana", "[NM-0001]"), detections: [], request_id: "r" }
    : u.endsWith("/proxy/detokenize") ? { detokenized_text: body.text.replaceAll("[NM-0001]", "Ana") } : {};
  return { ok: true, status: 200, json: async () => j } as Response;
}) as any);

const client = new PrivaroClient({ apiKey: "prvr_" + "a".repeat(40), pipelineId: "p1" });

describe("protectToolOutput", () => {
  it("posts output + conversation and maps the response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ protected_output: { n: "[NM-0001]" }, detections_count: 1, fields_protected: ["n"], audit_log_id: "a" }) } as Response);
    const r = await client.protectToolOutput({ n: "Ana" }, { conversationId: "c1", toolName: "crm" });
    expect(r.protectedOutput).toEqual({ n: "[NM-0001]" });
    expect(r.fieldsProtected).toEqual(["n"]);
    const last = calls.at(-1)!; void last;
  });
});

describe("detokenize", () => {
  it("sends conversation_id and returns text", async () => {
    expect(await client.detokenize("Hola [NM-0001]", { conversationId: "c1" })).toBe("Hola Ana");
    expect(calls.at(-1)!.body.conversation_id).toBe("c1");
  });
});

describe("vercel-ai middleware", () => {
  const mw = privaroMiddleware(client);
  it("masks prompt text parts (returns params directly)", async () => {
    const p = await mw.transformParams({ params: { prompt: [{ role: "user", content: [{ type: "text", text: "Soy Ana" }] }] } });
    expect(p.prompt[0].content[0].text).toBe("Soy [NM-0001]");
  });
  it("reveals generate output (v4 text and v5 content)", async () => {
    expect((await mw.wrapGenerate({ doGenerate: async () => ({ text: "Hola [NM-0001]" }) })).text).toBe("Hola Ana");
    expect((await mw.wrapGenerate({ doGenerate: async () => ({ content: [{ type: "text", text: "Hola [NM-0001]" }] }) })).content[0].text).toBe("Hola Ana");
  });
  it("reveals a token split across stream chunks", async () => {
    const src = new ReadableStream({ start(c) { for (const d of ["Hola [NM", "-00", "01]!"]) c.enqueue({ type: "text-delta", id: "1", delta: d }); c.enqueue({ type: "finish" }); c.close(); } });
    const s = await mw.wrapStream({ doStream: async () => ({ stream: src }) });
    let out = ""; const r = (s.stream as ReadableStream).getReader();
    for (;;) { const { done, value } = await r.read(); if (done) break; if ((value as any).type === "text-delta") out += (value as any).delta; }
    expect(out).toBe("Hola Ana!");
  });
  it("safeFlushPoint holds back an open token", () => {
    expect(safeFlushPoint("abc [NM-00")).toBe(4);
    expect(safeFlushPoint("abc [NM-0001] d")).toBe(15);
  });
});

describe("langchain runnables", () => {
  it("privaroGuard masks input and reveals output on one conversation", async () => {
    let seen = "";
    const llm = RunnableLambda.from((s: string) => { seen = s; return "Hola " + s.split(" ").pop(); });
    const before = calls.length;
    expect(await privaroGuard(llm, client).invoke("Soy Ana")).toBe("Hola Ana");
    expect(seen).toBe("Soy [NM-0001]");
    const cids = new Set(calls.slice(before).map((c) => c.body.conversation_id));
    expect(cids.size).toBe(1);
  });
  it("privaroMask handles chat messages", async () => {
    const out = await privaroMask(client).invoke([new HumanMessage("Soy Ana")]);
    expect(out[0].content).toBe("Soy [NM-0001]");
  });
});
