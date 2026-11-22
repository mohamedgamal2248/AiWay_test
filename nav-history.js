/* AiWay in-app Back navigation.
   Inside Pi Browser (an Android WebView) the system Back button / swipe pops the browser
   history. The app is a single page with no history entries of its own, so Back used to
   leave the site. This module keeps ONE sentinel history entry above the page and, on every
   Back, closes the top-most layer instead:
     dialog -> modal -> mobile sheet -> drawer -> chat (up to the tool picker) -> picker (press
     Back twice to exit).
   Chrome ignores history entries pushed without a user gesture, so the sentinel is pushed
   on the first pointer/key interaction. */
(()=>{
 const $=id=>document.getElementById(id);
 const AR=()=>document.documentElement.dir==='rtl'||(typeof lang!=='undefined'&&lang==='ar');
 const isOpen=el=>Boolean(el&&(el.classList.contains('open')||el.classList.contains('show'))&&el.getAttribute('aria-hidden')!=='true');
 const click=id=>{const el=$(id);if(el){el.click();return true}return false};
 let armed=false,armTimer=0;

 // Closes the top-most open layer. Returns true if something was closed.
 function closeTopLayer(){
  if(isOpen($('aiwayDialogOverlay'))&&click('aiwayDialogCancel'))return true;
  if(isOpen($('imagePreviewModal'))){click('closeImagePreview');return true}
  const closers={piSigninModal:'cancelPiSignin',previewModal:'closePreview',supportModal:'closeSupport',payModal:'closePay'};
  for(const [overlay,closer] of Object.entries(closers)){
   if(isOpen($(overlay))){
    // A payment in flight must not be dismissed by Back; the app itself keeps it open.
    if($(overlay).classList.contains('payment-busy'))return true;
    if(!click(closer))$(overlay).classList.remove('open');
    return true;
   }
  }
  if(isOpen($('commandPalette'))){$('commandPalette').classList.remove('open');return true}
  if(isOpen($('mobileToolsSheet'))){click('mobileToolsScrim');return true}
  if(isOpen($('desktopPreviewPane'))&&click('desktopPreviewClose'))return true;
  if($('sidebar')?.classList.contains('open')){typeof closeMenu==='function'?closeMenu():$('backdrop')?.click();return true}
  return false;
 }
 const pickerOpen=()=>Boolean($('taskScreen')?.classList.contains('open'));
 const landingOpen=()=>Boolean($('introScreen')&&document.body.contains($('introScreen'))&&!$('introScreen').classList.contains('hide'));
 // NOTE: bare `history` / `activeTask` below are the app's own globals (message array, current
 // tool) declared with top-level `let` in app.js; browser history is always `window.history`.
 function goUp(){
  if(landingOpen())return false;
  if(!pickerOpen()){
   if(typeof openTaskScreen==='function'){openTaskScreen();return true}
   return false;
  }
  // Picker was opened from a chat: Back returns to that chat.
  if(typeof activeTask!=='undefined'&&activeTask&&Array.isArray(history)&&history.length&&typeof closeTaskScreen==='function'){closeTaskScreen();return true}
  return false;
 }

 function toast2(text){
  if(typeof toast==='function')toast(text);
 }

 function onPop(){
  if(closeTopLayer()||goUp()){pushSentinel();return}
  // Root (landing or tool picker): first Back warns, a second Back within 2.5s exits.
  if(!armed){
   armed=true;toast2(AR()?'اضغط رجوع مرة أخرى للخروج':'Press Back again to exit');
   clearTimeout(armTimer);armTimer=setTimeout(()=>{armed=false},2500);
   pushSentinel();
   return;
  }
  clearTimeout(armTimer);armed=false;
  // Let the browser leave: we are on the base entry now, so one more Back exits the app.
  window.removeEventListener('popstate',onPop);
  try{window.history.back()}catch{}
  setTimeout(()=>{try{window.close()}catch{}},120);
 }

 let pushed=false;
 function pushSentinel(){
  try{window.history.pushState({aiway:'sentinel',t:Date.now()},'',window.location.href);pushed=true}catch{}
 }
 function arm(){
  if(pushed)return;
  try{window.history.replaceState({aiway:'base'},'',window.location.href)}catch{}
  pushSentinel();
  window.addEventListener('popstate',onPop);
 }
 // The first user gesture installs the sentinel (history entries without one are skipped).
 const events=['pointerdown','keydown','touchstart'];
 const once=()=>{events.forEach(e=>window.removeEventListener(e,once,true));arm()};
 events.forEach(e=>window.addEventListener(e,once,{capture:true,passive:true}));

 // Test hook / diagnostics.
 window.aiwayNav={closeTopLayer,goUp,state:()=>({armed,pushed,pickerOpen:pickerOpen(),landing:landingOpen()})};
})();
