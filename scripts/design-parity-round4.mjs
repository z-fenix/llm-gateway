import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const out = process.env.EDGE_AUDIT_OUTPUT || root + "/docs/changes/2026-11-13-validation-followup/edge";
await mkdir(out + "/screenshots", { recursive: true });
const inline = [
  { role: "user", content: "验证同条 Gemini 记录中的工具调用" },
  { role: "assistant", content: "工具已完成", blocks: [
    { type: "thinking", text: "读取合成文件" },
    { type: "tool_call", id: "inline-1", name: "read_file", input: { path: "synthetic.ts" } },
    { type: "tool_result", id: "inline-1", output: "inline tool result", status: "success" },
    { type: "text", text: "## 完成\n\n```ts\nconst fixture = true;\n```" },
  ] },
  { role: "user", content: "不需要工具的第二轮" },
  { role: "assistant", content: "直接回复" },
];
const helpers = `
const wait=async(f)=>{for(let i=0;i<100;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,80));}throw Error('Missing expected UI: '+f.toString());};
const button=name=>[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===name||n.getAttribute('aria-label')===name);
const click=async(name)=>{(await wait(()=>button(name))).click();await new Promise(r=>setTimeout(r,80));};
const input=(selector,value)=>{const n=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}));};
const theme=async(dark)=>{await click('主题设置');await click(dark?'深色':'浅色');document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));};
const useMessages=messages=>{if(!window.__DESIGN_PREVIEW__)throw Error('Refusing to override a real backend');const invoke=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=async(cmd,args)=>cmd==='get_session_messages'?messages:invoke(cmd,args);};
const openSession=async()=>{(await wait(()=>document.querySelector('[aria-label="会话列表"] button'))).click();await wait(()=>document.querySelector('[data-session-reader]'));};
const processButton=()=>[...document.querySelectorAll('button')].find(n=>n.textContent.includes('执行过程'));
const toolButton=name=>[...document.querySelectorAll('button')].find(n=>n.textContent.includes(name)&&n.hasAttribute('aria-controls'));
`;
const cases=[];
for(const width of [1440,1024,768,390]) for(const dark of [false,true]) {
  const suffix=(dark?'dark':'light')+'-'+width;
  cases.push({name:'inline-tools-'+suffix,width,dark,route:'/logs?tab=sessions',code:`useMessages(${JSON.stringify(inline)});await openSession();processButton().click();const tool=await wait(()=>toolButton('read_file'));if([...document.querySelectorAll('button')].filter(n=>n.textContent.includes('read_file')&&n.hasAttribute('aria-controls')).length!==1||document.querySelector('[data-session-reader]').textContent.includes('工具输出'))throw Error('Inline call/result were not paired');tool.click();await wait(()=>document.querySelector('[aria-label="会话消息"]').textContent.includes('inline tool result'));if(!tool.textContent.includes('完成'))throw Error('Paired status missing');return {paired:true,status:tool.textContent,steps:processButton().textContent};`});
  cases.push({name:'fold-virtual-'+suffix,width,dark,params:'state=long',route:'/logs?tab=sessions',code:`await openSession();processButton().click();const tool=await wait(()=>toolButton('Read'));tool.click();await wait(()=>document.querySelector('[aria-label="会话消息"]').textContent.includes('long-output-'));processButton().click();await wait(()=>!toolButton('Read'));processButton().click();await wait(()=>toolButton('Read')?.getAttribute('aria-expanded')==='true');await click('跳到底部');await wait(()=>!toolButton('Read'));await click('轮次目录');(await wait(()=>[...document.querySelectorAll('button')].find(n=>/^1\\. /.test(n.textContent.trim())))).click();await wait(()=>toolButton('Read')?.getAttribute('aria-expanded')==='true');if(button('轮次目录').getAttribute('data-state')==='open')button('轮次目录').click();if(!document.querySelector('[aria-label="会话消息"]').textContent.includes('long-output-'))throw Error('Expanded tool result was lost');return {expanded:true,virtualRows:document.querySelectorAll('[data-row]').length};`});
  cases.push({name:'tools-outline-'+suffix,width,dark,route:'/logs?tab=sessions',code:`useMessages(${JSON.stringify(inline)});await openSession();await click('工具');await wait(()=>toolButton('read_file'));if(processButton().getAttribute('aria-expanded')!=='true')throw Error('False collapsed state');processButton().click();await wait(()=>!toolButton('read_file'));processButton().click();await wait(()=>toolButton('read_file'));await click('轮次目录');const hidden=await wait(()=>[...document.querySelectorAll('button')].find(n=>/^2\\. /.test(n.textContent.trim())));if(!hidden.disabled)throw Error('Filtered-out turn can navigate to wrong row');return {hiddenTurnDisabled:true,expanded:processButton().getAttribute('aria-expanded')};`});
  cases.push({name:'clipboard-denied-'+suffix,width,dark,route:'/logs?tab=sessions',code:`useMessages(${JSON.stringify(inline)});await openSession();window.clipboardAttempts=0;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{window.clipboardAttempts++;throw Error('synthetic clipboard denial');}}});await click('复制代码');await wait(()=>document.body.textContent.includes('复制失败，请检查剪贴板权限'));if(button('复制代码').querySelector('.lucide-check'))throw Error('Failed copy shown as successful');return {attempts:window.clipboardAttempts,incorrectSuccess:false};`});
  for(const variant of ['add','delete']) cases.push({name:'models-inflight-'+variant+'-'+suffix,width,dark,route:'/channels',code:`await click('新建渠道');await wait(()=>document.querySelector('[role=dialog]'));if(!window.__DESIGN_PREVIEW__)throw Error('Refusing real backend mutation');const invoke=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=(cmd,args)=>cmd==='list_channel_models'?new Promise(resolve=>{window.releaseModels=()=>resolve(['new-upstream']);}):invoke(cmd,args);${variant==='add'?"await click('删除模型');":""}await click('获取模型列表');await wait(()=>window.releaseModels);${variant==='add'?"await click('添加模型');input('input[role=combobox]','manual-local');await wait(()=>document.querySelector('input[role=combobox]').value==='manual-local');":"await click('删除模型');"}window.releaseModels();const option=await wait(()=>[...document.querySelectorAll('[role=option]')].find(n=>n.textContent==='new-upstream'));const inputElement=document.querySelector('input[role=combobox]');${variant==='add'?"if(inputElement.value!=='manual-local')throw Error('Manual model overwritten');":"await wait(()=>document.activeElement===inputElement);"}const preserved=inputElement.value;option.click();await wait(()=>inputElement.value==='new-upstream');return {preserved,selected:inputElement.value,mode:'${variant}'};`});
}
const results=process.env.RETRY_ONLY?JSON.parse(await readFile(out+'/acceptance.json','utf8')):[];
for(const c of cases) {
  if(process.env.CASE_FILTER&&!new RegExp(process.env.CASE_FILTER).test(c.name))continue;
  const prior=results.findIndex(r=>r.name===c.name);
  if(process.env.RETRY_ONLY&&prior>=0&&!results[prior].failed)continue;
  if(prior>=0)results.splice(prior,1);
  try {
    const action=`(async()=>{${helpers}await theme(${c.dark});${c.code}})()`;
    const url='http://127.0.0.1:5177/'+(c.params?'?'+c.params:'')+'#'+c.route;
    const {stdout}=await run(process.execPath,[root+'/scripts/design-audit.mjs',url,out+'/screenshots/'+c.name+'.png',String(c.width),'1000',action],{timeout:45000,maxBuffer:3e6});
    const report=JSON.parse(stdout.slice(stdout.indexOf('\n{')+1,stdout.lastIndexOf('\n}')+2));
    const interaction=JSON.parse(stdout.split('\n').find(l=>l.startsWith('ACTION ')).slice(7));
    const failed=!!(report.errors.length||report.overflow||report.mainOverflow||report.dialogOverflow);
    results.push({name:c.name,...report,interaction,failed});console.log(c.name,failed?'FAIL':'PASS');
  } catch(error) {results.push({name:c.name,failed:true,error:String(error),detail:error.stderr?.slice(-1800)});console.log(c.name,'ERROR');}
  await writeFile(out+'/acceptance.json',JSON.stringify(results,null,2));
}
const failed=results.filter(r=>r.failed).map(r=>r.name);
console.log(JSON.stringify({total:results.length,failed}));if(failed.length)process.exitCode=1;
