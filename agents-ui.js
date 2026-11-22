/* AiWay agents UI: agent cards, live progress, file/image artifact cards.
   Loaded after app.js (shares its globals: lang, history, auth, TASKS, TASK_ICONS...). */
(()=>{
 const ICON={
  builder:`<svg viewBox="0 0 48 48" fill="none"><rect x="6" y="9" width="36" height="30" rx="6" stroke="currentColor" stroke-width="3"/><path d="m19 20-5 5 5 5M29 20l5 5-5 5M26 17l-4 16" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  general:`<svg viewBox="0 0 48 48" fill="none"><path d="M14 6h14l10 10v24a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M28 6v10h10M17 25h14M17 31h14M17 37h8" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  file:`<svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  zip:`<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v3m0 2v3m0 2v3m-2 3h4v-3h-4v3Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
 };
 const AR=()=>typeof lang!=='undefined'&&lang==='ar';
 const t=(ar,en)=>AR()?ar:en;
 const esc2=s=>typeof esc==='function'?esc(s):String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

 // Icons are registered up front so loadModels() keeps them instead of the default sparkles.
 TASK_ICONS['pi-app-builder']=ICON.builder;
 TASK_ICONS['general-agent']=ICON.general;
 TASK_ICONS['image-agent']=TASK_ICONS.image;
 window.AIWAY_CORE_TASKS=['pi-app-builder','general-agent','image-agent','writing'];

 const COPY={
  'all-models':{ar:['شات AiWay','اسأل أي سؤال، ابحث في الويب وأرفق ملفات.','شات ذكي عام'],en:['AiWay Chat','Ask anything, search the web and attach files.','General smart chat']},
  'pi-app-builder':{ar:['منشئ تطبيقات Pi','يبحث ويكتب ملفات المشروع كاملة ثم يسلّمك ZIP جاهزًا للتنزيل.','HTML وCSS وJS وPi SDK'],en:['Pi App Builder','Researches, writes the full project and hands you a ready ZIP.','HTML, CSS, JS and Pi SDK']},
  'general-agent':{ar:['الوكيل العام','ابحث واقرأ ملفاتك وأنشئ PDF وWord وExcel وPowerPoint.','بحث + ملفات + مستندات'],en:['General Agent','Research, read your files and create PDF, Word, Excel and PowerPoint.','Search + files + documents']},
  'image-agent':{ar:['وكيل الصور','يحسّن وصفك ويولّد صورًا أو يعدّل صورك.','توليد وتعديل الصور'],en:['Image Agent','Improves your prompt, generates images or edits yours.','Generate and edit images']}
 };
 function applyCopy(){
  for(const [id,c] of Object.entries(COPY)){
   TASKS[id]={...(TASKS[id]||{}),ar:c.ar,en:c.en};
  }
 }
 applyCopy();
 const HINT={'pi-app-builder':['صف تطبيق Pi الذي تريد بناءه...','Describe the Pi app you want to build...'],'general-agent':['اسأل، أرفق ملفات، أو اطلب PDF/Word/Excel/PowerPoint...','Ask, attach files, or request a PDF / Word / Excel / PowerPoint...'],'image-agent':['صف الصورة التي تريدها، أو أرفق صورة لتعديلها...','Describe the image you want, or attach one to edit...'],'all-models':['اسأل أي شيء...','Ask anything...']};
 const _ctx=updateTaskContext;
 updateTaskContext=function(){const r=_ctx.apply(this,arguments);const h=HINT[activeTask];if(h&&$('prompt'))$('prompt').placeholder=t(h[0],h[1]);return r};
 const _loadModels=loadModels;
 loadModels=async function(){const r=await _loadModels.apply(this,arguments);applyCopy();if($('taskScreen')?.classList.contains('open'))renderTaskScreen();updateTaskContext();return r};

 // ---- live status while an agent works --------------------------------------
 const STEP={
  web_search:['🔎 يبحث في الويب','🔎 Searching the web'],
  write_file:['✍️ يكتب الملفات','✍️ Writing files'],edit_file:['✍️ يعدّل الملفات','✍️ Editing files'],
  validate_project:['✅ يفحص المشروع','✅ Validating the project'],package_project:['📦 يجهّز ملف ZIP','📦 Packaging the ZIP'],
  read_file:['📖 يقرأ الملف','📖 Reading the file'],search_in_file:['🔍 يبحث داخل الملفات','🔍 Searching the files'],
  create_pdf:['📄 ينشئ ملف PDF','📄 Creating the PDF'],create_docx:['📝 ينشئ مستند Word','📝 Creating the Word file'],
  create_xlsx:['📊 ينشئ ملف Excel','📊 Creating the Excel file'],create_pptx:['📽️ ينشئ العرض التقديمي','📽️ Creating the presentation'],
  create_text_file:['📄 ينشئ الملف','📄 Creating the file'],generate_image:['🎨 يولّد الصور','🎨 Generating images'],edit_image:['🎨 يعدّل الصورة','🎨 Editing the image']
 };
 function setStatus(text){
  const m=history.at(-1);if(!m||m.role!=='assistant')return;
  m.agentStatus=text;
  const bubble=document.querySelector('.streaming-msg .bubble');if(!bubble)return;
  let el=bubble.querySelector('.agent-status');
  if(!text){el?.remove();return}
  if(!el){el=document.createElement('div');el.className='agent-status';el.setAttribute('role','status');bubble.appendChild(el)}
  el.innerHTML=`<span class="agent-status-dot"></span><span>${esc2(text)}</span>`;
 }
 window.aiwayAgentEvent=function(d){
  if(d.type==='agent_tool'&&d.phase==='start'){const s=STEP[d.tool];setStatus(s?t(s[0],s[1]):t('⚙️ يعمل على طلبك','⚙️ Working on it'))}
  else if(d.type==='agent_tool'&&d.phase==='end')setStatus(t('⏳ يفكّر في الخطوة التالية','⏳ Planning the next step'));
  else if(d.type==='artifact'&&d.artifact)setStatus(t('✅ تم تجهيز: ','✅ Ready: ')+d.artifact.name);
 };

 // ---- artifact cards ----------------------------------------------------------
 const size=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
 const kindLabel=a=>a.kind==='project'?t('مشروع كامل (ZIP)','Full project (ZIP)'):/pdf/.test(a.mime)?'PDF':/word/.test(a.mime)?'Word':/sheet/.test(a.mime)?'Excel':/presentation/.test(a.mime)?'PowerPoint':/^image\//.test(a.mime)?t('صورة','Image'):t('ملف','File');
 function artifacts(m){return m?.role==='assistant'?(m.artifacts||m.token_usage?.artifacts||[]):[]}
 function artifactCardsMarkup(m,i){
  const list=artifacts(m);if(!list.length)return '';
  const images=list.filter(a=>/^image\//.test(a.mime)),files=list.filter(a=>!/^image\//.test(a.mime));
  const imgs=images.length?`<div class="artifact-images">${images.map(a=>`<figure class="artifact-image"><img alt="${esc2(a.name)}" ${a.url?`src="${esc2(a.url)}"`:''} data-artifact-view="${i}:${esc2(a.id)}" loading="lazy"><figcaption><span>${esc2(a.name)}</span><button type="button" class="file-download" data-artifact-download="${i}:${esc2(a.id)}">${t('تنزيل','Download')}</button></figcaption></figure>`).join('')}</div>`:'';
  const cards=files.map(a=>`<div class="file-card artifact-card"><span class="artifact-icon">${a.kind==='project'?ICON.zip:ICON.file}</span><div class="file-card-info"><b>${esc2(a.name)}</b><small>${esc2(kindLabel(a))} · ${size(a.size||0)}</small></div><div class="file-card-actions"><button type="button" class="file-download" data-artifact-download="${i}:${esc2(a.id)}">${t('تنزيل','Download')}</button></div></div>`).join('');
  return `<div class="artifact-list">${imgs}${cards}</div>`;
 }
 const _files=generatedFilesMarkup;
 generatedFilesMarkup=function(m,i){return _files(m,i)+artifactCardsMarkup(m,i)};

 // Hidden models: keep the token cost, drop the model name.
 modelExecutionMarkup=function(m){
  if(m.role!=='assistant')return '';
  const charged=Number(m.chargedTokens??m.token_usage?.chargedTokens);
  const web=Boolean(m.usedWebSearch??m.token_usage?.webSearch)||Number(m.token_usage?.webSearches)>0;
  const parts=[];
  if(Number.isFinite(charged))parts.push(`<span><b>${charged.toLocaleString('en-US')}</b> ${I18N[lang].tokensUsed}</span>`);
  if(web)parts.push(`<span class="web-search-meta" role="img" aria-label="${t('تم استخدام بحث الويب','Web search was used')}">${ICONS.globe}</span>`);
  const stop=m.token_usage?.stopReason;
  if(stop&&stop!=='complete')parts.push(`<span class="agent-limit-note">${stop==='time'?t('توقف عند حد الوقت','Stopped at the time limit'):stop==='cost'?t('توقف عند حد الرصيد المحجوز','Stopped at the reserved balance'):t('توقف عند حد الخطوات','Stopped at the step limit')}</span>`);
  return parts.length?`<div class="message-meta">${parts.join('<span class="meta-dot">•</span>')}</div>`:'';
 };

 async function downloadArtifact(i,id){
  const m=history[i];
  if(!m?.id||!auth?.token)return toast(t('احفظ المحادثة ثم حاول مرة أخرى','Save the conversation and try again'));
  try{
   const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth.token}`,'X-UI-Language':lang},body:JSON.stringify({action:'prepare-artifact',messageId:m.id,artifactId:id})});
   if(!r.ok)throw friendlyClientError(await r.json().catch(()=>({})),t('تعذر تجهيز التنزيل','Could not prepare the download'));
   const d=await r.json();if(!d?.url)throw makeUiError(t('لم يتم إنشاء رابط التنزيل','Download link was not created'),'DOWNLOAD_FAILED');
   // Same navigation pattern as chat file downloads: Pi Browser handles an attachment
   // response from a plain link far better than a blob: URL.
   const a=document.createElement('a');a.href=d.url;a.rel='noopener';a.style.display='none';document.body.appendChild(a);a.click();setTimeout(()=>a.remove(),1500);
  }catch(e){toast(friendlyClientError(e,t('تعذر تنزيل الملف','Could not download the file')).message)}
 }
 document.getElementById('messages')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-artifact-download]');if(b){const [i,id]=b.dataset.artifactDownload.split(':');downloadArtifact(Number(i),id);return}
  const img=e.target.closest('img[data-artifact-view]');if(img){const [i,id]=img.dataset.artifactView.split(':');downloadArtifact(Number(i),id)}
 });

 // Images of older messages have no preview URL yet: fetch short-lived ones on demand.
 const pending=new Set();
 async function hydrateImages(){
  if(!auth?.token)return;
  const byMessage=new Map();
  document.querySelectorAll('img[data-artifact-view]:not([src])').forEach(img=>{const [i]=img.dataset.artifactView.split(':');const m=history[Number(i)];if(m?.id&&!pending.has(m.id)){(byMessage.get(m.id)||byMessage.set(m.id,[]).get(m.id)).push(img)}});
  for(const [messageId,imgs] of byMessage){
   pending.add(messageId);
   try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth.token}`,'X-UI-Language':lang},body:JSON.stringify({action:'prepare-artifact-views',messageId})});
    if(!r.ok)continue;const {urls}=await r.json();
    imgs.forEach(img=>{const id=img.dataset.artifactView.split(':')[1];if(urls?.[id])img.src=urls[id]});
   }catch{}finally{pending.delete(messageId)}
  }
 }
 const _render=render;
 render=function(){const r=_render.apply(this,arguments);try{hydrateImages()}catch{}return r};
})();
