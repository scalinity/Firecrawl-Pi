// Parse actual native tool results, never arguments, assistant prose or an error.
export function clientProof(client,events){
 const calls=events.flatMap(x=>client==='claude'?(x.message?.content??[]).filter(c=>c.type==='tool_use').map(c=>({id:c.id,name:c.name,server:c.name.startsWith('mcp__fcpi__')?'fcpi':null})):x.item?.type==='mcp_tool_call'?[{id:x.item.id,name:x.item.tool,server:x.item.server,status:x.item.status}]:[]);
 const approved=calls.filter(x=>x.server==='fcpi'&&['mcp__fcpi__firecrawl_scrape','firecrawl_scrape'].includes(x.name));
 const results=events.flatMap(x=>client==='claude'?(x.message?.content??[]).filter(c=>c.type==='tool_result'&&approved.some(a=>a.id===c.tool_use_id)&&!c.is_error).map(c=>c.content):x.item?.type==='mcp_tool_call'&&x.item.server==='fcpi'&&x.item.tool==='firecrawl_scrape'&&x.item.status==='completed'&&!x.item.error?[x.item.result]:[]);
 function usable(x){
  if(typeof x==='string'){try{return usable(JSON.parse(x));}catch{return false;}}
  if(Array.isArray(x))return x.some(usable);
  if(!x||typeof x!=='object'||x.isError||x.is_error||x.error)return false;
  if((x.success===true||x.success===undefined)&&typeof x.data?.markdown==='string')return /^(?:# Static fixture(?:\r?\n|$)|Static fixture\r?\n=+(?:\r?\n|$))/.test(x.data.markdown);
  return usable(x.content)||usable(x.text)||usable(x.structuredContent);
 }
 const forbiddenBuiltin=client==='codex'&&events.some(x=>['command_execution','web_search','file_change','collab_tool_call','image_view'].includes(x.item?.type));
 return {calls: calls.map(({id,...x})=>x),usable:!forbiddenBuiltin&&calls.length===1&&approved.length===1&&results.some(usable)};
}
