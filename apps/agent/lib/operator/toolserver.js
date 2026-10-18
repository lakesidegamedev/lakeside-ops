"use strict";
// Loopback MCP endpoint that exposes the broker's tools to a headless Claude
// Code session. Each activation gets its own unguessable path bound to one job,
// its tool list and its abort signal; nothing else is reachable through it.
const http = require("node:http");
const crypto = require("node:crypto");
const {calculationInputSchema,prepareStructuredSubmission}=require("./structured-submission");
const { redactSecrets } = require("../text");

function createToolServer({ broker, normalizeImage, port = 0 }) {
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
    const route = /^\/mcp\/([a-f0-9]{48})(\/completion)?$/.exec(req.url || "");
    const token = route?.[1];
    const session = token && sessions.get(token);
    if (!session) return send(404, { error: "unknown session" });
    if (route[2]) {
      if (req.method !== "GET") return send(405, { error: "GET only" });
      res.setHeader("Cache-Control", "no-store");
      if (session.completion) return send(200, session.completion);
      session.waiters.add(res);
      res.once("close", () => session.waiters.delete(res));
      return;
    }
    if (req.method !== "POST") return send(405, { error: "POST only" });
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 2e6) return send(413, { error: "too large" }); }
    let msg; try { msg = JSON.parse(raw); } catch { return send(400, { error: "invalid json" }); }
    if (msg.id === undefined) return send(202);
    const ok = (result) => send(200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") return ok({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "keir", version: "1.0.0" } });
    if (msg.method === "ping") return ok({});
    if (msg.method === "tools/list") return ok({ tools: session.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    if (msg.method !== "tools/call") return send(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    let { name, arguments: input = {} } = msg.params || {};
    const indirect = name === "call_tool" && session.deferred;
    if (indirect) {
      const target = session.deferred.availableTools.find(t => t.name === input?.name);
      if (!target || !session.tools.some(t => t.name === "call_tool")) return ok({ isError: true, content: [{ type: "text", text: "Tool is outside this conversation's original grant" }] });
      try { require("./broker").validateArguments(input.args, target.input_schema); }
      catch (error) { return ok({ isError: true, content: [{ type: "text", text: error.message }] }); }
      name = target.name; input = input.args;
    }
    if (!(indirect ? session.deferred.availableTools : session.tools).some((t) => t.name === name)) return ok({ isError: true, content: [{ type: "text", text: `tool ${name} is not available in this task` }] });
    const finishingCall=name === "finish" || name === "submit_result" || name === "retry_result" || name === "finish_patch" || name === "edit_verify" && input.complete === true;
    if (session.completion || session.finishing || finishingCall && session.pending) return ok({ isError: true, content: [{ type: "text", text: "Activation is finished or another tool is still running; finish only after all tool results are verified." }] });
    session.pending++;
    if (finishingCall) session.finishing = true;
    try {
      if(name==='finish'&&session.job.resultSchema&&input.state==='done')throw new Error('Complete this structured task with submit_result and its required result object. Use finish only for waiting, blocked or dismissed work.');
      const submission=name==='submit_result'||name==='retry_result';
      let submissionInput=input;
      if(name==='retry_result'){
        const draft=session.submissionDraft;
        if(!draft||input.draftId!==draft.id)throw Error('No matching result draft in this activation; submit the complete result with submit_result');
        if(input.calculations===undefined)throw Error('retry_result requires corrected calculations');
        submissionInput={result:draft.result,summary:draft.summary,calculations:input.calculations};
      }else if(submission&&input.result!==undefined)delete session.submissionDraft;
      if(submission&&submissionInput.result===undefined)throw new Error('submit_result requires result matching the advertised task schema'+(session.job.resultSchema?.required?.length?'; required fields: '+session.job.resultSchema.required.join(', '):''));
      const prepared=submission?await prepareStructuredSubmission(session.job,submissionInput,{allowCalculations:session.tools.some(tool=>tool.name==='calculate'),calculate:async steps=>(await broker.tool(session.job,'calculate',{steps},session.signal)).steps}):null;
      const deliverable=prepared?.result??input.result,summary=prepared?.summary??input.summary;
      const submissionSummary=(typeof summary==='string'&&summary.trim()?summary:typeof deliverable?.answer==='string'&&deliverable.answer.trim()?deliverable.answer:'Structured result submitted.').slice(0,4000);
      const effectiveInput=submission?{state:'done',result:deliverable,summary:submissionSummary}:input;
      if (session.signal?.aborted) throw new Error("activation aborted");
      let result;
      if (name === "load_context" && session.deferred) {
        require("./broker").validateArguments(input, session.tools.find(t => t.name === "load_context").input_schema);
        const callId = require("./toolactivity").start(session.job, "load_context", input);
        try { result = await session.deferred.load(input); require("./toolactivity").finish(session.job, callId, true, 0); }
        catch (error) { require("./toolactivity").finish(session.job, callId, false, 0); throw error; }
      } else result = await broker.tool(session.job, submission?'finish':name, effectiveInput, session.signal);
      const images = result?.image ? [result.image] : result?._images || [];
      const safe = result && typeof result === "object" ? { ...result } : result;
      if (safe && typeof safe === "object") { delete safe._images; delete safe.image; }
      const content = [{ type: "text", text: redactSecrets(JSON.stringify(safe ?? null)).slice(0, 22000) }];
      for (const source of images) {
        try { const img = normalizeImage(source); content.push({ type: "image", data: img.data, mimeType: img.media_type }); }
        catch (e) { content.push({ type: "text", text: e.message }); }
      }
      session.calls++;
      const finished=(name === "finish" || submission) && typeof result?.state === "string" ? {state:result.state,summary:effectiveInput.summary} : (name === "finish_patch" || name === "edit_verify" && input.complete === true) && session.job.codingContract?.allowCompleteOnPass === true && session.job.state === "done" && result?.finished?.state === "done" ? result.finished : null;
      if (finished) {
        delete session.submissionDraft;
        session.completion = { version: 1, state: finished.state, summary: redactSecrets(String(finished.summary || "")).slice(0, 4000), resultDigest: session.job.resultReceipt?.sha256, validationDigest:session.job.validationReceipt?.digest, acceptedAt: Date.now(), toolCalls: session.calls };
        if(prepared?.calculations&&finished.state==='done'&&session.job.resultReceipt?.sha256){
          session.completion.calculations=prepared.calculations;
          session.completion.calculationDigest=crypto.createHash('sha256').update(JSON.stringify({resultDigest:session.job.resultReceipt.sha256,calculations:prepared.calculations})).digest('hex');
        }
        for (const waiter of session.waiters) { waiter.writeHead(200, { "Content-Type": "application/json" }); waiter.end(JSON.stringify(session.completion)); }
        session.waiters.clear();
      }
      return ok({ content });
    } catch (e) {
      return ok({ isError: true, content: [{ type: "text", text: redactSecrets((()=>{
        const canRetry=session.tools.some(tool=>tool.name==='retry_result')&&input.calculations!==undefined;
        const draft=name==='retry_result'?session.submissionDraft:name==='submit_result'&&input.result!==undefined?{id:crypto.randomBytes(16).toString('hex'),result:input.result,summary:input.summary}:null;
        if(canRetry&&draft&&(name!=='retry_result'||input.draftId===draft.id)){
          session.submissionDraft=draft;
          return JSON.stringify({error:e.message,draftId:draft.id,retry:'Use retry_result with this draftId and corrected calculations; the complete report is retained. To change report text, send a new submit_result instead.'});
        }
        return e.message;
      })()) }] });
    } finally {
      session.pending--;
      if (finishingCall) session.finishing = false;
    }
  });
  const ready = new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
  server.unref();
  async function open(job, tools, signal, deferred = null) {
    const calculationSteps=tools.find(tool=>tool.name==='calculate')?.input_schema?.properties?.steps;
    if (job.resultSchema&&tools.some(tool=>tool.name==='finish')) tools = tools.filter(tool=>tool.name!=='submit_result').flatMap(tool => {
      if(tool.name!=='finish')return[tool];
      const properties={...tool.input_schema?.properties};delete properties.result;
      return[{...tool,description:'Report that this structured task is waiting, blocked or dismissed. To complete it, use submit_result with the full required deliverable. Never invent a result to clear a blocker.',
        input_schema:{...tool.input_schema,properties:{...properties,state:{type:'string',enum:['waiting','blocked','dismissed']}},required:(tool.input_schema?.required||[]).filter(name=>name!=='result')}},
        {name:'submit_result',description:(calculationSteps?'Optional calculations evaluate 1-32 evidence-backed steps and insert results in this same call, avoiding a separate calculate/read/copy round trip. Use numeric field values \"$calc.id\" and text placeholders {{calc.id}} or {{calc.id:2}} for 0-10 display decimals. Expressions use the calculate grammar and prior $id steps. Every rendered value still passes the original result schema and completion guards. This verifies arithmetic only, not formula selection, narrative or recommendations. ':'')+'Submit the required structured deliverable and request completion. All normal finish, validation, pending-question and approval guards apply. Failure leaves the task open. The report is persisted; a separate duplicate summary is optional. Verify arithmetic and citations against gathered evidence. Recommend only changes justified by that evidence, checking them against currently successful cases. Keep the report concise: explain each derivation once instead of repeating it across fields.',
          input_schema:{type:'object',properties:{result:calculationSteps?calculationInputSchema(job.resultSchema):job.resultSchema,summary:{type:'string',maxLength:4000},...(calculationSteps?{calculations:calculationSteps}:{})},required:['result'],additionalProperties:false}},...(calculationSteps?[{name:'retry_result',description:'Retry a previously rejected calculated report using its returned draftId and corrected calculations. The full report and summary are retained for this activation; do not resend them. Keep every calculation ID referenced by the retained report. A new submit_result replaces the previous draft. The original result schema, calculator authority, completion and approval guards still apply. No draft can be reused after accepted completion or in another activation.',input_schema:{type:'object',properties:{draftId:{type:'string',pattern:'^[a-f0-9]{32}$'},calculations:calculationSteps},required:['draftId','calculations'],additionalProperties:false}}]:[])];
    });
    const token = crypto.randomBytes(24).toString("hex");
    const session = { job, tools, signal, deferred, calls: 0, pending: 0, finishing: false, waiters: new Set() };
    sessions.set(token, session);
    const url = `http://127.0.0.1:${await ready}/mcp/${token}`;
    return { url, completionUrl: url + "/completion", tools, session, close: () => { sessions.delete(token); for (const waiter of session.waiters) { waiter.writeHead(410); waiter.end(); } session.waiters.clear(); } };
  }
  return { open, close: () => server.close() };
}
module.exports = { createToolServer };
