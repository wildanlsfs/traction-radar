// Tiny conversion snippet the product owner adds to their app:
//   <script src="https://<api>/t.js" defer></script>
//   ...after signup:  TractionRadar.signup()
//   ...after payment: TractionRadar.payment(29000, "order-123")
// It remembers the ?tr=<slug> from the tracking link (first-party localStorage, 30 days) and reports
// only the slug + event type. No cookies, no personal data.
export const SNIPPET = (apiBase) => `(function(){
  var API=${JSON.stringify(apiBase)};var K="tr_slug";
  try{var q=new URLSearchParams(location.search).get("tr");if(q){localStorage.setItem(K,JSON.stringify({s:q,t:Date.now()}));}}catch(e){}
  function slug(){try{var v=JSON.parse(localStorage.getItem(K)||"null");if(v&&Date.now()-v.t<2592e6)return v.s;}catch(e){}return null;}
  function send(ev,value,eventId){var s=slug();if(!s)return false;
    var body=JSON.stringify({slug:s,event:ev,value:value||0,eventId:eventId||undefined});
    if(navigator.sendBeacon){return navigator.sendBeacon(API+"/e",new Blob([body],{type:"text/plain"}));}
    fetch(API+"/e",{method:"POST",body:body,keepalive:true,headers:{"content-type":"text/plain"}});return true;}
  window.TractionRadar={signup:function(id){return send("signup",0,id)},payment:function(v,id){return send("payment",v,id)},slug:slug};
})();`;
