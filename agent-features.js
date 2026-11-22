/* AiWay agent features: per-run cost cap, Continue, live project preview, Pi app templates
   and the Library. Loaded after agents-ui.js (shares its globals and helpers). */
(()=>{
 const AR=()=>typeof lang!=='undefined'&&lang==='ar';
 const t=(ar,en)=>AR()?ar:en;
 const q=id=>document.getElementById(id);
 const esc2=s=>typeof esc==='function'?esc(s):String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const AGENT_IDS=['pi-app-builder','general-agent','image-agent'];
 const isAgent=()=>typeof activeTask!=='undefined'&&AGENT_IDS.includes(activeTask);
 const store={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}}};
 const authHeaders=()=>({'Content-Type':'application/json',Authorization:`Bearer ${auth.token}`,'X-UI-Language':lang});
 const post=async body=>{const r=await fetch('/api/chat',{method:'POST',headers:authHeaders(),body:JSON.stringify(body)});if(!r.ok)throw friendlyClientError(await r.json().catch(()=>({})),t('تعذر إكمال الطلب','Could not complete the request'));return r.json()};

 // ---- per-run cost cap: no longer shown in the composer (the server still honours runCapTokens). ----
 window.aiwayRunCap=0;
 function renderCapRow(){q('runCapRow')?.remove()}
 try{localStorage.removeItem('aiway_run_cap')}catch{}

 // ---- Pi app templates -----------------------------------------------------------
 window.aiwayTemplate='';
 function templateName(id){const tpl=(window.aiwayTemplates||[]).find(x=>x.id===id);return tpl?(AR()?tpl.name_ar:tpl.name_en):id}
 function templatesMarkup(){
  const list=window.aiwayTemplates||[];if(!list.length)return '';
  return `<div class="template-gallery"><div class="template-head">${t('ابدأ من قالب جاهز','Start from a template')}</div><div class="template-grid">${list.map(x=>`<button type="button" class="template-card${window.aiwayTemplate===x.id?' on':''}" data-template="${esc2(x.id)}"><b>${esc2(AR()?x.name_ar:x.name_en)}</b><small>${esc2(AR()?x.description_ar:x.description_en)}</small></button>`).join('')}</div></div>`;
 }
 const _welcome=welcome;
 welcome=function(){const html=_welcome.apply(this,arguments);return activeTask==='pi-app-builder'?html.replace('<div class="suggestions">',templatesMarkup()+'<div class="suggestions">'):html};
 function renderTemplateChip(){
  const zone=document.querySelector('.composer-zone');if(!zone)return;
  let chip=q('templateChip');
  if(!window.aiwayTemplate||activeTask!=='pi-app-builder'){chip?.remove();return}
  if(!chip){chip=document.createElement('div');chip.id='templateChip';chip.className='template-chip';const row=q('runCapRow');zone.insertBefore(chip,row?row.nextSibling:zone.firstChild)}
  chip.innerHTML=`<span>${t('القالب','Template')}: <b>${esc2(templateName(window.aiwayTemplate))}</b></span><button type="button" data-template-clear aria-label="${t('إزالة القالب','Remove template')}">×</button>`;
 }
 document.addEventListener('click',e=>{
  const card=e.target.closest('[data-template]');
  if(card){
   const id=card.dataset.template,tpl=(window.aiwayTemplates||[]).find(x=>x.id===id);if(!tpl)return;
   window.aiwayTemplate=id;
   const p=q('prompt');if(p){p.value=AR()?tpl.example_ar:tpl.example_en;if(typeof autoSize==='function')autoSize();p.focus()}
   renderTemplateChip();document.querySelectorAll('.template-card').forEach(c=>c.classList.toggle('on',c.dataset.template===id));return;
  }
  if(e.target.closest('[data-template-clear]')){window.aiwayTemplate='';renderTemplateChip();document.querySelectorAll('.template-card.on').forEach(c=>c.classList.remove('on'))}
 });
 // A template is used once: after a finished run the next message starts plain.
 window.aiwayAgentDone=()=>{if(window.aiwayTemplate){window.aiwayTemplate='';renderTemplateChip()}};

 // ---- Continue a stopped run -----------------------------------------------------
 const STOP_TEXT={time:['وصل الوقت المخصص للتشغيلة','The run reached its time limit'],steps:['وصل الحد الأقصى للخطوات','The run reached its step limit'],cost:['وصل الحد الأقصى للتكلفة','The run reached its cost limit']};
 function continueMarkup(m,i){
  if(m?.role!=='assistant')return '';
  const stop=m.stopReason||m.token_usage?.stopReason;
  const agent=m.agentId||m.token_usage?.agentId;
  if(!agent||!STOP_TEXT[stop]||i!==history.length-1||streaming)return '';
  const [ar,en]=STOP_TEXT[stop];
  return `<div class="continue-run" role="status"><span>${t(ar,en)}. ${t('الشغل المنتهي محفوظ.','Finished work is saved.')}</span><button type="button" class="btn primary" data-agent-continue="${i}">${t('أكمل من حيث توقفت','Continue where you stopped')}</button></div>`;
 }
 document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-agent-continue]');if(!b||streaming)return;
  const p=q('prompt');if(!p)return;
  p.value=t('أكمل من حيث توقفت وأنهِ ما تبقى من العمل.','Continue where you stopped and finish the remaining work.');
  if(typeof autoSize==='function')autoSize();
  await sendMessage();
 });

 // ---- Live preview -------------------------------------------------------------------
 async function openPreview(messageId,artifactId,name){
  try{
   const d=await post({action:'prepare-preview',messageId,artifactId});
   const frame=q('previewFrame'),modal=q('previewModal');if(!frame||!modal||!d?.url)return;
   q('previewTitle').textContent=name||d.name||t('معاينة','Preview');
   frame.removeAttribute('srcdoc');frame.src=d.url;
   modal.classList.add('open');ensurePreviewTools(frame);
  }catch(err){toast(friendlyClientError(err,t('تعذر فتح المعاينة','Could not open the preview')).message)}
 }
 function ensurePreviewTools(frame){
  const bar=document.querySelector('#previewModal .preview-toolbar');if(!bar||bar.querySelector('[data-preview-tools]'))return;
  const tools=document.createElement('span');tools.dataset.previewTools='1';tools.className='preview-tools';
  tools.innerHTML=`<button type="button" class="icon-btn" data-preview-reload aria-label="${t('تحديث','Reload')}" title="${t('تحديث','Reload')}">↻</button><button type="button" class="icon-btn" data-preview-full aria-label="${t('ملء الشاشة','Fullscreen')}" title="${t('ملء الشاشة','Fullscreen')}">⤢</button>`;
  bar.insertBefore(tools,bar.querySelector('#closePreview'));
  tools.addEventListener('click',e=>{
   if(e.target.closest('[data-preview-reload]')){const s=frame.src;frame.src='about:blank';setTimeout(()=>{frame.src=s},30)}
   if(e.target.closest('[data-preview-full]'))q('previewModal').classList.toggle('preview-full');
  });
  q('closePreview')?.addEventListener('click',()=>{frame.src='about:blank';q('previewModal').classList.remove('preview-full')});
 }
 const previewable=a=>a&&(a.kind==='project'||/\.(zip|html?|pdf|docx|xlsx|pptx|txt|md|csv|tsv|json|xml|css|js|py|sql|ya?ml)$/i.test(a.name||''));
 document.addEventListener('click',e=>{
  const b=e.target.closest('[data-artifact-preview]');if(!b)return;
  const [i,id]=b.dataset.artifactPreview.split(':');const m=history[Number(i)];
  const a=(m?.artifacts||m?.token_usage?.artifacts||[]).find(x=>x.id===id);
  if(m?.id)window.aiwayFileViewer?window.aiwayFileViewer.open({messageId:m.id,artifactId:id,name:a?.name}):openPreview(m.id,id,a?.name);else toast(t('احفظ المحادثة ثم حاول مرة أخرى','Save the conversation and try again'));
 });

 // Add a Preview button to project cards by decorating the rendered cards after each render.
 function decorateArtifacts(){
  document.querySelectorAll('.artifact-card [data-artifact-download]').forEach(btn=>{
   const actions=btn.parentElement;if(!actions||actions.querySelector('[data-artifact-preview]'))return;
   const [i,id]=btn.dataset.artifactDownload.split(':');
   const m=history[Number(i)];const a=(m?.artifacts||m?.token_usage?.artifacts||[]).find(x=>x.id===id);
   if(!previewable(a))return;
   const pv=document.createElement('button');pv.type='button';pv.className='file-preview';pv.dataset.artifactPreview=`${i}:${id}`;pv.textContent=t('معاينة','Preview');
   actions.insertBefore(pv,btn);
  });
 }

 // ---- hook into rendering --------------------------------------------------------------
 const _files=generatedFilesMarkup;
 generatedFilesMarkup=function(m,i){return _files(m,i)+continueMarkup(m,i)};
 const _render=render;
 render=function(){const r=_render.apply(this,arguments);try{decorateArtifacts();renderCapRow();renderTemplateChip()}catch{}return r};
 const _ctx=updateTaskContext;
 updateTaskContext=function(){const r=_ctx.apply(this,arguments);try{renderCapRow();renderTemplateChip()}catch{}return r};
 const _load=loadModels;
 loadModels=async function(){const r=await _load.apply(this,arguments);try{renderCapRow()}catch{}return r};

 // ---- Library -------------------------------------------------------------------------------
 let libraryFilter='all',libraryItems=[];
 function ensureLibraryUi(){
  if(!q('libraryBtn')){
   const anchor=q('newChatBtn');
   if(anchor){const b=document.createElement('button');b.id='libraryBtn';b.type='button';b.className='btn soft wide library-btn';anchor.insertAdjacentElement('afterend',b);b.addEventListener('click',openLibrary)}
  }
  const b=q('libraryBtn');if(b)b.innerHTML=`<span aria-hidden="true">▤</span><span>${t('المكتبة','Library')}</span>`;
  if(!q('libraryModal')){
   const o=document.createElement('div');o.className='overlay';o.id='libraryModal';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.setAttribute('aria-labelledby','libraryTitle');
   o.innerHTML=`<div class="modal library-modal" tabindex="-1"><div class="modal-head"><h2 id="libraryTitle"></h2><button class="icon-btn" id="closeLibrary" type="button" aria-label="Close">×</button></div><div class="library-tabs" role="tablist" id="libraryTabs"></div><div class="library-list" id="libraryList" aria-live="polite"></div></div>`;
   document.body.appendChild(o);
   q('closeLibrary').addEventListener('click',()=>o.classList.remove('open'));
   o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open')});
   q('libraryTabs').addEventListener('click',e=>{const tab=e.target.closest('[data-lib-tab]');if(tab){libraryFilter=tab.dataset.libTab;renderLibrary()}});
   q('libraryList').addEventListener('click',onLibraryClick);
  }
 }
 const AGENT_LABEL={'pi-app-builder':['منشئ تطبيقات Pi','Pi App Builder'],'general-agent':['الوكيل العام','General Agent'],'image-agent':['وكيل الصور','Image Agent']};
 const kindOf=i=>i.kind==='project'?'projects':/^image\//.test(i.mime)?'images':'documents';
 function fmtSize(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB'}
 function fmtDate(iso){try{return new Date(iso).toLocaleDateString(AR()?'ar-EG':'en-US',{month:'short',day:'numeric'})}catch{return ''}}
 function renderLibrary(){
  q('libraryTitle').textContent=t('المكتبة','Library');
  const tabs=[['all',t('الكل','All')],['projects',t('مشاريع','Projects')],['documents',t('مستندات','Documents')],['images',t('صور','Images')]];
  q('libraryTabs').innerHTML=tabs.map(([k,l])=>`<button type="button" role="tab" class="library-tab${libraryFilter===k?' on':''}" aria-selected="${libraryFilter===k}" data-lib-tab="${k}">${l}</button>`).join('');
  const rows=libraryItems.filter(i=>libraryFilter==='all'||kindOf(i)===libraryFilter);
  q('libraryList').innerHTML=rows.length?rows.map(i=>{
   const [ar,en]=AGENT_LABEL[i.agentId]||['',''];
   return `<article class="library-item" data-msg="${esc2(i.messageId)}" data-art="${esc2(i.id)}" data-conv="${esc2(i.conversationId)}"><div class="library-main"><b>${esc2(i.name)}</b><small>${esc2([t(ar,en),fmtDate(i.createdAt),fmtSize(i.size||0),i.conversationTitle].filter(Boolean).join(' · '))}</small></div><div class="library-actions">${i.previewable?`<button type="button" class="file-preview" data-lib-preview>${t('معاينة','Preview')}</button>`:''}<button type="button" class="file-download" data-lib-download>${t('تنزيل','Download')}</button><button type="button" class="mini-btn" data-lib-open>${t('فتح المحادثة','Open chat')}</button></div></article>`;
  }).join(''):`<div class="library-empty">${t('لا توجد ملفات بعد. ما تنشئه الوكلاء يظهر هنا.','No files yet. What your agents create shows up here.')}</div>`;
 }
 async function openLibrary(){
  if(!auth?.token){return typeof login==='function'?login():undefined}
  ensureLibraryUi();q('libraryModal').classList.add('open');
  if(typeof closeMenu==='function')closeMenu();
  q('libraryList').innerHTML=`<div class="library-empty">${t('جارٍ التحميل…','Loading…')}</div>`;
  try{libraryItems=(await post({action:'library'})).items||[];renderLibrary()}
  catch(err){q('libraryList').innerHTML=`<div class="library-empty">${esc2(friendlyClientError(err,t('تعذر تحميل المكتبة','Could not load the library')).message)}</div>`}
 }
 async function downloadById(messageId,artifactId){
  try{
   const d=await post({action:'prepare-artifact',messageId,artifactId});
   const a=document.createElement('a');a.href=d.url;a.rel='noopener';a.style.display='none';document.body.appendChild(a);a.click();setTimeout(()=>a.remove(),1500);
  }catch(err){toast(friendlyClientError(err,t('تعذر تنزيل الملف','Could not download the file')).message)}
 }
 function onLibraryClick(e){
  const row=e.target.closest('.library-item');if(!row)return;
  const {msg,art,conv}=row.dataset;
  if(e.target.closest('[data-lib-download]'))return downloadById(msg,art);
  if(e.target.closest('[data-lib-preview]')){q('libraryModal').classList.remove('open');return window.aiwayFileViewer?window.aiwayFileViewer.open({messageId:msg,artifactId:art,name:row.querySelector('b')?.textContent}):openPreview(msg,art,row.querySelector('b')?.textContent)}
  if(e.target.closest('[data-lib-open]')){q('libraryModal').classList.remove('open');if(typeof closeTaskScreen==='function')closeTaskScreen();return openChat(conv)}
 }
 ensureLibraryUi();
 const _lang=typeof updateIntroLanguage==='function'?updateIntroLanguage:null;
 if(_lang)updateIntroLanguage=function(){const r=_lang.apply(this,arguments);try{ensureLibraryUi();renderCapRow();renderTemplateChip()}catch{}return r};
 window.aiwayFeatures={openLibrary,openPreview,renderCapRow,downloadById};
})();
