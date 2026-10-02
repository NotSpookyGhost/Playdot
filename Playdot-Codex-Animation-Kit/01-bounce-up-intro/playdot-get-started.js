
// Entrance is handled by CSS and plays once on load. Replay is explicit.
const stage=document.getElementById('stage');
const replay=document.getElementById('replay');
const status=document.getElementById('status');
const preference=matchMedia('(prefers-reduced-motion: reduce)');
function syncMotionPreference(){
 replay.disabled=preference.matches;
 replay.textContent=preference.matches?'Reduced motion':'Replay entrance';
 replay.setAttribute('aria-label',preference.matches?'Animation disabled by reduced-motion preference':'Replay the Playdot entrance');
}
replay.addEventListener('click',()=>{
 if(preference.matches)return;
 stage.querySelector('svg').getAnimations({subtree:true}).forEach(animation=>{animation.currentTime=0;animation.play();});
 status.textContent='Playing the Playdot entrance';
});
preference.addEventListener('change',syncMotionPreference);
syncMotionPreference();
// Optional deterministic export / inspection hook, in milliseconds.
window.playdotSeek=time=>stage.querySelector('svg').getAnimations({subtree:true}).forEach(animation=>{animation.pause();animation.currentTime=time;});
