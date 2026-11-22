/* AiWay file viewer: preview PDF, Word, Excel, PowerPoint, images and text files inside the
   app (no download needed). PDFs render with the self-hosted pdf.js (canvas, works in the
   Pi Browser WebView); Office files arrive from the server as a tiny sanitised HTML subset. */
(()=>{
 const AR=()=>typeof lang!=='undefined'&&lang==='ar';
 const t=(ar,en)=>AR()?ar:en;
 const q=id=>document.getElementById(id);
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const PDFJS='/vendor/pdfjs/pdf.min.js?v=3.11.174',WORKER='/vendor/pdfjs/pdf.worker.min.js?v=3.11.174';
 const ICON={
  close:'<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  download:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  file:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>'
 };
 let scriptPromise=null,token=0,current=null;
 const loadPdfJs=()=>scriptPromise||(scriptPromise=new Promise((resolve,reject)=>{
  if(window.pdfjsLib)return resolve(window.pdfjsLib);
  const s=document.createElement('script');s.src=PDFJS;
  s.onload=()=>{window.pdfjsLib.GlobalWorkerOptions.workerSrc=WORKER;resolve(window.pdfjsLib)};
  s.onerror=()=>{scriptPromise=null;reject(new Error('pdfjs'))};
  document.head.appendChild(s);
 }));
 const authHeaders=()=>({'Content-Type':'application/json',Authorization:`Bearer ${auth.token}`,'X-UI-Language':lang});
 async function request(body){
  const r=await fetch('/api/chat',{method:'POST',headers:authHeaders(),body:JSON.stringify(body)});
  if(!r.ok)throw friendlyClientError(await r.json().catch(()=>({})),t('تعذر فتح الملف','Could not open the file'));
  return r.json();
 }
 function ensureModal(){
  if(q('filePreviewModal'))return;
  const o=document.createElement('div');o.className='overlay';o.id='filePreviewModal';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.setAttribute('aria-labelledby','filePreviewTitle');
  o.innerHTML=`<div class="modal file-viewer" tabindex="-1"><div class="file-viewer-head"><span class="file-viewer-icon">${ICON.file}</span><b id="filePreviewTitle"></b><button type="button" class="icon-btn" id="filePreviewDownload">${ICON.download}</button><button type="button" class="icon-btn" id="closeFilePreview" aria-label="Close">${ICON.close}</button></div><div class="file-viewer-body" id="filePreviewBody" aria-live="polite"></div></div>`;
  document.body.appendChild(o);
  q('closeFilePreview').addEventListener('click',close);
  o.addEventListener('click',e=>{if(e.target===o)close()});
  q('filePreviewDownload').addEventListener('click',()=>{if(current)window.aiwayFeatures?.downloadById?.(current.messageId,current.artifactId)});
 }
 function close(){token++;q('filePreviewModal')?.classList.remove('open');const b=q('filePreviewBody');if(b)b.innerHTML='';current=null}
 const state=(msg,loading)=>`<div class="file-viewer-state">${loading?'<span class="aw-orb" aria-hidden="true"><i></i></span>':''}<span>${esc(msg)}</span></div>`;

 async function renderPdf(body,url,my){
  const lib=await loadPdfJs();
  const bytes=new Uint8Array(await (await fetch(url)).arrayBuffer());
  if(my!==token)return;
  const pdf=await lib.getDocument({data:bytes,isEvalSupported:false}).promise;
  if(my!==token)return;
  const total=pdf.numPages,shown=Math.min(total,80);
  body.innerHTML=`<div class="pdf-count">${shown} / ${total} ${t('صفحة','pages')}</div><div class="pdf-pages"></div>`;
  const wrap=body.querySelector('.pdf-pages');
  const first=await pdf.getPage(1),base=first.getViewport({scale:1});
  const width=()=>Math.max(220,Math.min(wrap.clientWidth||body.clientWidth-24,900));
  const holders=[];
  for(let n=1;n<=shown;n++){
   const h=document.createElement('div');h.className='pdf-page';h.dataset.page=String(n);
   h.style.aspectRatio=`${base.width} / ${base.height}`;wrap.appendChild(h);holders.push(h);
  }
  const draw=async h=>{
   if(h.dataset.done||my!==token)return;h.dataset.done='1';
   const page=await pdf.getPage(Number(h.dataset.page));
   const w=width(),scale=w/page.getViewport({scale:1}).width,dpr=Math.min(2,window.devicePixelRatio||1);
   const vp=page.getViewport({scale:scale*dpr});
   const c=document.createElement('canvas');c.width=Math.floor(vp.width);c.height=Math.floor(vp.height);
   c.style.width='100%';c.style.height='auto';
   h.style.aspectRatio=`${vp.width} / ${vp.height}`;
   await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
   if(my===token){h.appendChild(c);h.classList.add('ready')}
  };
  if('IntersectionObserver' in window){
   const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){io.unobserve(e.target);draw(e.target)}}),{root:body,rootMargin:'600px 0px'});
   holders.forEach(h=>io.observe(h));
  }else for(const h of holders)await draw(h);
 }

 async function open({messageId,artifactId,name}){
  if(!auth?.token)return;
  ensureModal();
  const my=++token;current={messageId,artifactId};
  q('filePreviewTitle').textContent=name||t('معاينة','Preview');
  q('filePreviewDownload').setAttribute('aria-label',t('تنزيل','Download'));q('filePreviewDownload').title=t('تنزيل','Download');
  const body=q('filePreviewBody');body.scrollTop=0;
  body.innerHTML=state(t('جارٍ فتح الملف…','Opening the file…'),true);
  q('filePreviewModal').classList.add('open');
  try{
   const d=await request({action:'file-preview',messageId,artifactId});
   if(my!==token)return;
   if(d.kind==='project'){close();return window.aiwayFeatures?.openPreview?.(messageId,artifactId,name)}
   if(d.kind==='pdf')return await renderPdf(body,d.url,my);
   if(d.kind==='image'){body.innerHTML=`<div class="file-viewer-image"><img alt="${esc(name)}" src="${esc(d.url)}"></div>`;return}
   if(d.kind==='html'){body.innerHTML=`<article class="file-doc" dir="auto">${d.html||''}</article>`;return}
   if(d.kind==='text'){body.innerHTML=`<pre class="file-text" dir="auto">${esc(d.text)}</pre>`;return}
   body.innerHTML=state(d.kind==='toolarge'?t('الملف كبير للمعاينة. نزّله لفتحه.','This file is too large to preview. Download it to open it.'):t('لا تتوفر معاينة لهذا النوع. نزّل الملف لفتحه.','No preview for this file type. Download it to open it.'));
  }catch(err){
   if(my!==token)return;
   body.innerHTML=state(friendlyClientError(err,t('تعذر فتح الملف','Could not open the file')).message);
  }
 }
 window.aiwayFileViewer={open,close};
})();
