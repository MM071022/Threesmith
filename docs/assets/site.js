const status = document.createElement('span');
status.setAttribute('role','status'); status.style.cssText='position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)'; document.body.append(status);
document.querySelectorAll('[data-copy]').forEach(button=>{
  let timer;
  button.addEventListener('click',async()=>{
    const code=document.getElementById(button.dataset.copy);clearTimeout(timer);
    try {await navigator.clipboard.writeText(code.textContent);button.textContent='Copied';status.textContent='Command copied to clipboard.';}
    catch {const range=document.createRange();range.selectNodeContents(code);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);button.textContent='Selected';status.textContent='Command selected. Use your keyboard to copy.';}
    timer=setTimeout(()=>{button.textContent='Copy';status.textContent='';},2200);
  });
});
const setups={
  cli:{description:'Start with a diagnosis of the current project.',command:'npx -y threesmith doctor'},
  codex:{description:'Connect the full MCP toolkit to Codex.',command:'codex mcp add threesmith -- npx -y threesmith mcp --tier premium'},
  claude:{description:'Add the marketplace, then install the plugin for tools, hooks, skills and subagents.',command:'/plugin marketplace add laaielichter/Threesmith\n/plugin install threesmith@threesmith'},
  mcp:{description:'Add this server to your client’s MCP configuration. The full guide has the configuration file locations.',command:JSON.stringify({mcpServers:{threesmith:{command:'npx',args:['-y','threesmith','mcp']}}},null,2)}
};
const tabs=[...document.querySelectorAll('[data-setup]')];
function selectSetup(tab){
  tabs.forEach(item=>{const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;});
  document.getElementById('setup-command').textContent=setups[tab.dataset.setup].command;
  document.getElementById('setup-description').textContent=setups[tab.dataset.setup].description;
  document.getElementById('setup-panel').setAttribute('aria-labelledby',tab.id);
  document.querySelector('#setup-panel [data-copy]').textContent='Copy';
}
tabs.forEach((tab,index)=>{
  tab.addEventListener('click',()=>selectSetup(tab));
  tab.addEventListener('keydown',event=>{
    let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;if(event.key==='ArrowLeft')next=(index-1+tabs.length)%tabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=tabs.length-1;
    if(next!==undefined){event.preventDefault();selectSetup(tabs[next]);tabs[next].focus();}
  });
});
const range=document.getElementById('compare-range');
range?.addEventListener('input',()=>{document.querySelector('.image-compare').style.setProperty('--split',`${range.value}%`);range.setAttribute('aria-valuetext',`${range.value}% original scene, ${100-Number(range.value)}% fixed scene`);});
const filters=[...document.querySelectorAll('[data-filter]')];
filters.forEach(button=>button.addEventListener('click',()=>{
  const filter=button.dataset.filter;filters.forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  let count=0;document.querySelectorAll('.model-card').forEach(card=>{card.hidden=filter!=='all'&&card.dataset.category!==filter;if(!card.hidden)count++;});
  document.getElementById('gallery-count').textContent=`${count} model previews`;
}));
