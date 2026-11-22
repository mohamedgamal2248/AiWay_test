(()=>{
 const $id=id=>document.getElementById(id);
 const sheet=$id('mobileToolsSheet'),more=$id('composerMoreBtn');
 const openSheet=()=>{if(!sheet)return;sheet.classList.add('open');sheet.setAttribute('aria-hidden','false');more?.setAttribute('aria-expanded','true');syncSheet();setTimeout(()=>$id('mobileToolsClose')?.focus(),30)};
 const closeSheet=()=>{if(!sheet)return;sheet.classList.remove('open');sheet.setAttribute('aria-hidden','true');more?.setAttribute('aria-expanded','false');more?.focus({preventScroll:true})};
 function copyOptions(src,dst){if(!src||!dst)return;const val=src.value;dst.innerHTML=[...src.options].map(o=>`<option value="${String(o.value).replace(/"/g,'&quot;')}">${o.textContent}</option>`).join('');dst.value=val}
 function syncSheet(){
   const ar=document.documentElement.dir==='rtl';
   $id('mobileToolsTitle').textContent=ar?'إرفاق':'Attach';$id('mobileToolsSubtitle').textContent=ar?'صور أو فيديو أو ملفات':'Photos, video or files';
   $id('attachImageLabel').textContent=ar?'صور':'Photos';$id('attachVideoLabel').textContent=ar?'فيديو':'Video';$id('attachFileLabel').textContent=ar?'ملفات':'Files';
   if($id('mobileAllToolsLabel'))$id('mobileAllToolsLabel').textContent=ar?'كل الأدوات':'All tools';$id('mobileAllToolsBtn')?.setAttribute('aria-label',ar?'عرض كل الأدوات':'Show all tools');if($id('mobileAllToolsBtn'))$id('mobileAllToolsBtn').title=ar?'عرض كل الأدوات':'Show all tools';
   $id('mobileToolsClose')?.setAttribute('aria-label',ar?'إغلاق':'Close');more?.setAttribute('aria-label',ar?'إرفاق':'Attach');
 }
 // Each option opens the system picker restricted to that kind; the app's own attachment
 // pipeline (size limits, previews, storage) is unchanged.
 function pick(accept){closeSheet();const input=$id('fileInput');if(!input)return;input.accept=accept;setTimeout(()=>{$id('attachBtn')?.click();setTimeout(()=>{input.accept='*/*'},60000)},20)}
 $id('mobileAllToolsBtn')?.addEventListener('click',()=>typeof openTaskScreen==='function'&&openTaskScreen());
 more?.addEventListener('click',openSheet);$id('mobileToolsClose')?.addEventListener('click',closeSheet);$id('mobileToolsScrim')?.addEventListener('click',closeSheet);
 $id('attachImageAction')?.addEventListener('click',()=>pick('image/*'));
 $id('attachVideoAction')?.addEventListener('click',()=>pick('video/*'));
 $id('attachFileAction')?.addEventListener('click',()=>pick('.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.zip,application/*,text/*'));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sheet?.classList.contains('open'))closeSheet()});
 window.addEventListener('resize',()=>{if(innerWidth>700&&sheet?.classList.contains('open'))closeSheet()});
 setTimeout(syncSheet,250);
})();
