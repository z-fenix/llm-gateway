import { writeFile } from "node:fs/promises";

const [url = "http://127.0.0.1:5174/", output, width = "1440", height = "1000", action = ""] = process.argv.slice(2);
const target = await fetch(`http://127.0.0.1:9226/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" }).then(r => r.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let seq = 0;
const pending = new Map();
const errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (!message.id) return;
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}
try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  for (let i = 0; i < 50; i++) {
    if (await evaluate("document.readyState === 'complete' && !!document.querySelector('h1, [role=alert], [role=status]')")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await evaluate("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");
  await new Promise(resolve => setTimeout(resolve, 500));
  if (action) { console.log("ACTION", JSON.stringify(await evaluate(action))); await new Promise(resolve => setTimeout(resolve, 500)); }
  const report = await evaluate(`({url:location.href,width:innerWidth,height:innerHeight,h1:[...document.querySelectorAll('h1')].map(n=>n.textContent),overflow:document.documentElement.scrollWidth>innerWidth,mainOverflow:document.querySelector('main')?.scrollWidth>document.querySelector('main')?.clientWidth,dialogOverflow:[...document.querySelectorAll('[role=dialog]')].some(n=>n.scrollWidth>n.clientWidth),dialogs:[...document.querySelectorAll('[role=dialog]')].map(n=>n.textContent.slice(0,100)),text:document.querySelector('main')?.innerText.slice(0,1800)})`);
  console.log(JSON.stringify({ ...report, errors }, null, 2));
  if (output) {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(output, Buffer.from(data, "base64"));
    console.log(`Screenshot: ${output}`);
  }
} finally {
  socket.close();
  await fetch(`http://127.0.0.1:9226/json/close/${target.id}`);
}
