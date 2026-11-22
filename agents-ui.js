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
 window.AIWAY_CORE_TASKS=['pi-app-builder','general-agent','image-agent'];

 const COPY={
  'all-models':{ar:['AiWay','',''],en:['AiWay','','']},
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
 const HINT={'pi-app-builder':['صف تطبيقك…','Describe your app…'],'general-agent':['اسأل أو أرفق ملفًا…','Ask or attach a file…'],'image-agent':['صف الصورة…','Describe the image…'],'all-models':['اسأل أي شيء…','Ask anything…']};
 const _ctx=updateTaskContext;
 updateTaskContext=function(){const r=_ctx.apply(this,arguments);const h=HINT[activeTask];if(h&&$('prompt'))$('prompt').placeholder=t(h[0],h[1]);return r};
 const _loadModels=loadModels;
 loadModels=async function(){const r=await _loadModels.apply(this,arguments);applyCopy();if($('taskScreen')?.classList.contains('open'))renderTaskScreen();updateTaskContext();return r};

 // Agent-specific starter prompts (the legacy defaults were generic business prompts).
 const STARTERS={
  'pi-app-builder':{ar:[['متجر ملصقات بدفع Pi','اعمل لي متجر ملصقات بسيط بدفع Pi، مناسب للموبايل.'],['صفحة لنشاطي التجاري','اعمل صفحة هبوط لنشاطي مع تسجيل دخول Pi ونموذج تواصل.'],['أضف دفع Pi لموقعي','اكتب لي كود الدفع بـ Pi للعميل والخادم (approve و complete).']],en:[['Sticker shop with Pi checkout','Build a simple sticker shop with Pi checkout, mobile first.'],['Landing page for my business','Build a landing page for my business with Pi sign-in and a contact form.'],['Add Pi payments to my site','Write the Pi payment code for client and server (approve and complete).']]},
  'general-agent':{ar:[['لخّص ملف PDF','لخّص الملف المرفق في صفحة واحدة بصيغة PDF.'],['حوّل الجداول إلى Excel','استخرج الجداول من الملف المرفق في ملف Excel.'],['اعمل عرضًا تقديميًا','اعمل عرض PowerPoint من 8 شرائح عن الموضوع التالي: ']],en:[['Summarize a PDF','Summarize the attached file on one page as a PDF.'],['Tables to Excel','Extract the tables from the attached file into an Excel workbook.'],['Make a presentation','Create an 8-slide PowerPoint about: ']]},
  'image-agent':{ar:[['شعار بسيط','اعمل شعارًا بسيطًا ومسطحًا لمتجر قهوة باللون الأخضر.'],['صورة غلاف 16:9','اعمل صورة غلاف 16:9 لمنصة ذكاء اصطناعي، ألوان داكنة مع لمسات ليمونية.'],['عدّل صورتي','أرفق صورة ثم اكتب التعديل المطلوب، مثل: غيّر الخلفية إلى غابة.']],en:[['Simple logo','Create a simple flat logo for a coffee shop in green.'],['16:9 cover image','Create a 16:9 cover image for an AI platform, dark tones with lime accents.'],['Edit my image','Attach an image and describe the change, e.g. change the background to a forest.']]}
 };
 const _suggestions=taskSuggestions;
 taskSuggestions=function(){const s=STARTERS[activeTask];return s?(AR()?s.ar:s.en):_suggestions.apply(this,arguments)};

 // ---- live status while an agent works --------------------------------------
 const SV=d=>`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
 const STATUS_ICON={
  search:SV('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  write:SV('<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/><path d="M14.5 6.5l3 3"/>'),
  check:SV('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M8.5 12l2.5 2.5L15.5 10"/>'),
  box:SV('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5L12 12l8-4.5M12 12v9"/>'),
  read:SV('<path d="M4 5.5C6.5 4 9.5 4 12 5.5 14.5 4 17.5 4 20 5.5V19c-2.5-1.5-5.5-1.5-8 0-2.5-1.5-5.5-1.5-8 0z"/><path d="M12 5.5V19"/>'),
  scan:SV('<path d="M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16"/><circle cx="11.5" cy="11.5" r="3"/><path d="M14 14l2.5 2.5"/>'),
  pdf:SV('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M8.5 15.5h7M8.5 12.5h4"/>'),
  doc:SV('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M8.5 12h7M8.5 15h7M8.5 18h4"/>'),
  table:SV('<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M4 14.5h16M10 5v14"/>'),
  slides:SV('<rect x="3.5" y="4.5" width="17" height="11" rx="2"/><path d="M12 15.5V20M8 20h8M8 9.5l2.5 2 3-3.5 2 2"/>'),
  image:SV('<rect x="4" y="4.5" width="16" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17.5l4.5-4.5 3 3 2.5-2.5 4 4"/>'),
  gear:SV('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>'),
  think:SV('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" stroke-width="1.5"/>'),
  done:SV('<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.8 2.8L16.2 9.5"/>')
 };
 const STEP={
  web_search:['يبحث في الويب','Searching the web','search'],
  write_file:['يكتب الملفات','Writing files','write'],edit_file:['يعدّل الملفات','Editing files','write'],
  validate_project:['يفحص المشروع','Validating the project','check'],package_project:['يجهّز ملف ZIP','Packaging the ZIP','box'],
  read_file:['يقرأ الملف','Reading the file','read'],search_in_file:['يبحث داخل الملفات','Searching the files','scan'],
  create_pdf:['ينشئ ملف PDF','Creating the PDF','pdf'],create_docx:['ينشئ مستند Word','Creating the Word file','doc'],
  create_xlsx:['ينشئ ملف Excel','Creating the Excel file','table'],create_pptx:['ينشئ العرض التقديمي','Creating the presentation','slides'],
  create_text_file:['ينشئ الملف','Creating the file','doc'],generate_image:['يولّد الصور','Generating images','image'],edit_image:['يعدّل الصورة','Editing the image','image']
 };
 function setStatus(text,icon){
  const m=history.at(-1);if(!m||m.role!=='assistant')return;
  m.agentStatus=text;
  const bubble=document.querySelector('.streaming-msg .bubble');if(!bubble)return;
  let el=bubble.querySelector('.agent-status');
  if(!text){el?.remove();return}
  if(!el){el=document.createElement('div');el.className='agent-status';el.setAttribute('role','status');bubble.appendChild(el)}
  el.innerHTML=`<span class="agent-status-ic">${STATUS_ICON[icon]||STATUS_ICON.gear}</span><span>${esc2(text)}</span>`;
 }
 window.aiwayAgentEvent=function(d){
  if(d.type==='agent_tool'&&d.phase==='start'){const s=STEP[d.tool];s?setStatus(t(s[0],s[1]),s[2]):setStatus(t('يعمل على طلبك','Working on it'),'gear')}
  else if(d.type==='agent_tool'&&d.phase==='end')setStatus(t('يفكّر في الخطوة التالية','Planning the next step'),'think');
  else if(d.type==='artifact'&&d.artifact)setStatus(t('تم تجهيز: ','Ready: ')+d.artifact.name,'done');
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

 // Cost receipt: an expandable breakdown whose lines add up to the charged amount.
 const LINE_LABEL={ai:['عمل الذكاء الاصطناعي','AI work'],search:['بحث الويب','Web search'],images:['الصور','Images']};
 function receiptMarkup(r){
  const num=v=>Number(v||0).toLocaleString('en-US');
  const lines=r.lines.map(l=>{const [ar,en]=LINE_LABEL[l.key]||[l.key,l.key];const extra=l.key==='ai'&&l.steps?` · ${l.steps} ${t('خطوات','steps')}`:l.count?` × ${l.count}`:'';return `<li><span>${esc2(t(ar,en))}${extra}</span><b>${num(l.tokens)}</b></li>`}).join('');
  const secs=r.elapsedMs?` · ${Math.max(1,Math.round(r.elapsedMs/1000))}${t('ث','s')}`:'';
  return `<details class="receipt"><summary><b>${num(r.total)}</b> ${t('توكن خُصمت','tokens charged')} <i aria-hidden="true">▾</i></summary><ul>${lines}<li class="receipt-total"><span>${t('الإجمالي','Total')}</span><b>${num(r.total)}</b></li></ul><div class="receipt-foot">${t('مدخلات','Input')} ${num(r.inputTokens)} · ${t('مخرجات','Output')} ${num(r.outputTokens)}${secs}</div></details>`;
 }

 // Hidden models: keep the token cost, drop the model name.
 modelExecutionMarkup=function(m){
  if(m.role!=='assistant')return '';
  const charged=Number(m.chargedTokens??m.token_usage?.chargedTokens);
  const web=Boolean(m.usedWebSearch??m.token_usage?.webSearch)||Number(m.token_usage?.webSearches)>0;
  const parts=[];
  const receipt=m.receipt||m.token_usage?.receipt;
  if(receipt&&Array.isArray(receipt.lines)&&receipt.lines.length)parts.push(receiptMarkup(receipt));
  else if(Number.isFinite(charged))parts.push(`<span><b>${charged.toLocaleString('en-US')}</b> ${I18N[lang].tokensUsed}</span>`);
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


/* Minimal "thinking" indicator: a pulsing orb, one shimmering line and step dots. */
progressMarkup=function(m){
  const l=progressLanguage(m),t=I18N[l],stage=m?.streamStage||'analyzing';
  const stages=[['analyzing',t.analyzing],...(m?.usedWebSearch?[['searching',t.searching]]:[]),['writing',t.writing]];
  const current=Math.max(0,stages.findIndex(x=>x[0]===stage));
  const dots=stages.map((x,n)=>`<b class="${n<current?'done':n===current?'active':''}"></b>`).join('');
  return `<div class="aw-think" role="status" aria-live="polite"><span class="aw-orb" aria-hidden="true"><i></i></span><span class="aw-think-text">${stages[current]?.[1]||t.thinking}</span><span class="aw-steps" aria-hidden="true">${dots}</span></div>`;
};
