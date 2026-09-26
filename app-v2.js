const phases=["Compressed liquid","Saturated liquid","Saturated mixture","Saturated vapor","Superheated vapor"];
const $=id=>document.getElementById(id);
const ERAU_EMAIL_RE=/^[^\s@]+@my\.erau\.edu$/i;
let activeCase=null,officialCaseNumber=null,quizMode="official",officialSubmitted=false,practiceAttempt=0,currentDisplayName="",failedAttempts=0;

function hash(text){let h=2166136261;for(const ch of text.trim().toLowerCase()){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function assignmentKey(email){return `thermo-infinity:${email}`}
function completionKey(email){return `thermo-infinity:complete:${email}`}
function assignCase(email){const key=assignmentKey(email);let n=Number(localStorage.getItem(key));if(!n||n<1||n>THERMO_CASES.length){n=(hash(email)%THERMO_CASES.length)+1;localStorage.setItem(key,String(n))}return THERMO_CASES[n-1]}
async function api(payload){if(!THERMO_QUIZ_API)return null;const response=await fetch(THERMO_QUIZ_API,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify(payload)});if(!response.ok)throw new Error("The assignment service is temporarily unavailable.");const data=await response.json();if(!data.ok)throw new Error(data.error||"The assignment service returned an error.");return data}

function normalizeEmail(raw){return String(raw||"").trim().toLowerCase()}
function isValidErauEmail(email){return ERAU_EMAIL_RE.test(email)}

function currentSectionValue(){const select=$('courseSection');if(!select)return "";if(select.value==="Other section")return $('otherSection').value.trim();return select.value}

function setupSectionToggle(){const select=$('courseSection'),wrap=$('otherSectionWrap'),other=$('otherSection');select.addEventListener('change',()=>{const isOther=select.value==="Other section";wrap.hidden=!isOther;other.required=isOther;if(!isOther){other.value="";other.setAttribute('aria-invalid','false');$('otherSectionError').textContent=""}$('sectionError').textContent="";select.setAttribute('aria-invalid','false')})}

function validateIdentityForm(){let valid=true;
  const firstName=$('firstName').value.trim();
  const lastName=$('lastName').value.trim();
  $('firstName').setAttribute('aria-invalid',firstName?'false':'true');
  $('lastName').setAttribute('aria-invalid',lastName?'false':'true');
  if(!firstName)valid=false;
  if(!lastName)valid=false;

  const email=normalizeEmail($('erauEmail').value);
  const emailError=$('emailError');
  if(!email||!isValidErauEmail(email)){
    emailError.textContent="Enter your ERAU student email ending in @my.erau.edu.";
    $('erauEmail').setAttribute('aria-invalid','true');
    valid=false;
  } else {
    emailError.textContent="";
    $('erauEmail').setAttribute('aria-invalid','false');
  }

  const sectionSelect=$('courseSection');
  const sectionError=$('sectionError');
  if(!sectionSelect.value){
    sectionError.textContent="Select your course section.";
    sectionSelect.setAttribute('aria-invalid','true');
    valid=false;
  } else {
    sectionError.textContent="";
    sectionSelect.setAttribute('aria-invalid','false');
  }

  if(sectionSelect.value==="Other section"){
    const other=$('otherSection');
    const otherError=$('otherSectionError');
    if(!other.value.trim()){
      otherError.textContent="Enter your section.";
      other.setAttribute('aria-invalid','true');
      valid=false;
    } else {
      otherError.textContent="";
      other.setAttribute('aria-invalid','false');
    }
  }
  return valid;
}

function setMode(mode){quizMode=mode;const practice=mode==="practice";$('modeBadge').textContent=practice?"Practice mode":"Official assignment";$('modeBadge').classList.toggle('practice',practice);$('checkButton').textContent=practice?"Check practice case":"Submit official case"}

/* ---------------------------------------------------------------------
   Diagram geometry
   All coordinates are in the SVG's local viewBox ("0 0 430 260"). The
   dome is a schematic mountain shape (wide base, narrowing to a single
   "critical point" at the top) built from ONE function, domeX(y,side),
   so the drawn outline and the region-detection logic can never disagree
   with each other.
--------------------------------------------------------------------- */
const PLOT_LEFT=56, PLOT_RIGHT=404, PLOT_TOP=34, PLOT_BOTTOM=214;
const APEX_X=230, APEX_Y=60, DOME_BASE_Y=PLOT_BOTTOM;
const DOME_LEFT_BASE_X=114, DOME_RIGHT_BASE_X=346;
const DOME_SHAPE_EXPONENT=0.55;
const BOUNDARY_TOLERANCE_PX=16;
const ISOTHERM_Y=96, ISOBAR_Y=168;
const ARROW_STEP=6, ARROW_STEP_BIG=24;

function clamp(v,min,max){return Math.max(min,Math.min(max,v))}

/** The single source of truth for the dome's shape: the x position of the
 *  left ("saturated liquid") or right ("saturated vapor") boundary at a
 *  given plot-space y. Used both to draw the dome and to grade clicks. */
function domeX(y,side){
  const yy=clamp(y,APEX_Y,DOME_BASE_Y);
  const t=(DOME_BASE_Y-yy)/(DOME_BASE_Y-APEX_Y);
  const k=Math.pow(t,DOME_SHAPE_EXPONENT);
  const baseX=side==='left'?DOME_LEFT_BASE_X:DOME_RIGHT_BASE_X;
  return baseX+(APEX_X-baseX)*k;
}

function domeOutlinePoints(side,steps=24){
  const pts=[];
  for(let i=0;i<=steps;i++){
    const y=DOME_BASE_Y-(DOME_BASE_Y-APEX_Y)*(i/steps);
    pts.push([domeX(y,side),y]);
  }
  return pts;
}
function pathFromPoints(pts){return 'M'+pts.map(p=>p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' L')}

/** Classify a plot-space (x,y) point into one of the five phase regions,
 *  using a forgiving tolerance band around each saturation boundary
 *  instead of requiring exact-pixel placement. */
function classifyRegion(x,y){
  if(y<=APEX_Y) return x<APEX_X?'Compressed liquid':'Superheated vapor';
  const leftX=domeX(y,'left'), rightX=domeX(y,'right');
  if(x<leftX-BOUNDARY_TOLERANCE_PX) return 'Compressed liquid';
  if(x<leftX+BOUNDARY_TOLERANCE_PX) return 'Saturated liquid';
  if(x<rightX-BOUNDARY_TOLERANCE_PX) return 'Saturated mixture';
  if(x<rightX+BOUNDARY_TOLERANCE_PX) return 'Saturated vapor';
  return 'Superheated vapor';
}

/** A representative (x,y) for a region, used when a student answers via
 *  the dropdown instead of placing a point -- it visibly places a marker
 *  that classifies back to the same region it was chosen from. */
function representativeMarkerPosition(region){
  const y=(APEX_Y+DOME_BASE_Y)/2;
  const leftX=domeX(y,'left'), rightX=domeX(y,'right');
  if(region==='Compressed liquid') return {x:Math.max(PLOT_LEFT+10,leftX-40),y};
  if(region==='Saturated liquid') return {x:leftX,y};
  if(region==='Saturated mixture') return {x:(leftX+rightX)/2,y};
  if(region==='Saturated vapor') return {x:rightX,y};
  return {x:Math.min(PLOT_RIGHT-10,rightX+40),y};
}

/** Reads the case's "given" (and "extra") text to decide which schematic
 *  guide line(s) to draw. Presence-only (not magnitude) is used, since the
 *  lines are conceptual, not-to-scale guides. */
function parseGivenFlags(given){
  return {hasP:/(^|,)\s*p\s*=/i.test(given||''), hasT:/(^|,)\s*T\s*=/i.test(given||'')};
}
/** Parses a quality value written as "x = 60%" or "x ~= 0.6" (given text
 *  uses the ASCII-safe "x ~" form only in comments here; real cases use
 *  "x ≈" / "x =") from either the given or extra field. Returns a 0-1
 *  fraction, or null if nothing safely parseable was found. */
function parseQuality(given,extra){
  const text=`${given||''} ${extra||''}`;
  const m=text.match(/x\s*[≈=]\s*([\d.]+)\s*(%)?/i);
  if(!m) return null;
  let val=parseFloat(m[1]);
  if(!Number.isFinite(val)) return null;
  if(m[2]||val>1) val=val/100;
  if(val<0||val>1) return null;
  return val;
}

function regionPhrase(region){
  return ({
    'Compressed liquid':'the compressed-liquid region',
    'Saturated liquid':'the saturated-liquid boundary',
    'Saturated mixture':'the two-phase region',
    'Saturated vapor':'the saturated-vapor boundary',
    'Superheated vapor':'the superheated-vapor region'
  })[region]||'an unrecognized region';
}
function correctPhaseGuidancePhrase(phase){
  return ({
    'Compressed liquid':'a compressed liquid state',
    'Saturated liquid':'the saturated-liquid boundary',
    'Saturated mixture':'a saturated mixture',
    'Saturated vapor':'the saturated-vapor boundary',
    'Superheated vapor':'a superheated vapor state'
  })[phase]||'the correct region';
}
function regionLabelForGuide(region){
  return ({
    'Compressed liquid':'compressed-liquid region',
    'Saturated liquid':'saturated-liquid boundary',
    'Saturated mixture':'two-phase region',
    'Saturated vapor':'saturated-vapor boundary',
    'Superheated vapor':'superheated-vapor region'
  })[region]||'correct region';
}

function guideLineSVG(y,{bend,label}){
  const leftX=domeX(y,'left'), rightX=domeX(y,'right');
  let bendMarks='';
  if(bend){
    bendMarks=`<path d="M${(leftX-26).toFixed(1)} ${(y+16).toFixed(1)} L${(leftX-6).toFixed(1)} ${(y-2).toFixed(1)}" stroke="#173d65" stroke-width="1.6" fill="none"/>`+
      `<path d="M${(rightX+6).toFixed(1)} ${(y-2).toFixed(1)} L${(rightX+26).toFixed(1)} ${(y+16).toFixed(1)}" stroke="#173d65" stroke-width="1.6" fill="none"/>`;
  }
  return `<g class="guide-line"><path d="M${PLOT_LEFT} ${y} L${PLOT_RIGHT} ${y}" stroke="#173d65" stroke-width="1.6" stroke-dasharray="6 5" fill="none" opacity=".8"/>${bendMarks}<text x="${PLOT_LEFT+4}" y="${y-6}" font-size="10.5" fill="#173d65" font-style="italic">${label}</text></g>`;
}

function buildDiagramMarkup(kind){
  const yAxisLabel=kind==='tv'?'T':'P';
  const flags=parseGivenFlags(activeCase.given);
  const guides=[];
  if(kind==='tv'){
    if(flags.hasT) guides.push(guideLineSVG(ISOTHERM_Y,{bend:false,label:'schematic isotherm (T given)'}));
    if(flags.hasP) guides.push(guideLineSVG(ISOBAR_Y,{bend:true,label:'schematic isobar (p given)'}));
  } else {
    if(flags.hasP) guides.push(guideLineSVG(ISOBAR_Y,{bend:false,label:'schematic isobar (p given)'}));
    if(flags.hasT) guides.push(guideLineSVG(ISOTHERM_Y,{bend:true,label:'schematic isotherm (T given)'}));
  }
  const leftPts=domeOutlinePoints('left');
  const rightPts=domeOutlinePoints('right');
  const domeFillD=pathFromPoints(leftPts.concat(rightPts.slice().reverse()))+' Z';
  const title=kind==='tv'?'Temperature versus specific volume schematic diagram':'Pressure versus specific volume schematic diagram';
  const desc=kind==='tv'
    ?'A mountain-shaped saturation dome on temperature versus specific volume axes. The region left of the dome is compressed liquid, the region inside the dome is the two-phase saturated mixture, and the region right of the dome is superheated vapor. The left boundary is the saturated-liquid line and the right boundary, drawn dashed, is the saturated-vapor line.'
    :'A mountain-shaped saturation dome on pressure versus specific volume axes. The region left of the dome is compressed liquid, the region inside the dome is the two-phase saturated mixture, and the region right of the dome is superheated vapor. The left boundary is the saturated-liquid line and the right boundary, drawn dashed, is the saturated-vapor line.';
  return `<title>${title}</title><desc>${desc}</desc>`+
    `<rect width="430" height="260" fill="#fff"/>`+
    `<defs><pattern id="hatch-${kind}" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="7" stroke="#123b69" stroke-width="1" opacity=".22"/></pattern></defs>`+
    `<g stroke="#dbe3ec" stroke-width="1"><path d="M${PLOT_LEFT} ${PLOT_TOP-14}V${PLOT_BOTTOM}H${PLOT_RIGHT}" fill="none" stroke="#173d65" stroke-width="2"/><path d="M${PLOT_LEFT} ${(PLOT_TOP+PLOT_BOTTOM)/2}H${PLOT_RIGHT}"/></g>`+
    `<path d="${domeFillD}" fill="url(#hatch-${kind})" stroke="none"/>`+
    `<path d="${pathFromPoints(leftPts)}" fill="none" stroke="#0f2f52" stroke-width="2.4"/>`+
    `<path d="${pathFromPoints(rightPts)}" fill="none" stroke="#0f2f52" stroke-width="2.4" stroke-dasharray="7 4"/>`+
    `<circle cx="${APEX_X}" cy="${APEX_Y}" r="3.2" fill="#0f2f52"/>`+
    `<text x="${APEX_X+7}" y="${APEX_Y-6}" font-size="10" fill="#48607c">critical point</text>`+
    guides.join('')+
    `<text x="16" y="${PLOT_TOP-2}" fill="#071f3d" font-weight="700" font-size="15">${yAxisLabel}</text>`+
    `<text x="${PLOT_RIGHT-2}" y="${PLOT_BOTTOM+30}" fill="#071f3d" font-weight="700" font-size="15" text-anchor="end">v</text>`+
    `<text x="${((PLOT_LEFT+DOME_LEFT_BASE_X)/2-6).toFixed(1)}" y="${PLOT_BOTTOM-96}" fill="#173d65" font-size="12" font-weight="600" text-anchor="middle">Compressed liquid</text>`+
    `<text x="${APEX_X}" y="${DOME_BASE_Y-14}" fill="#173d65" font-size="12" font-weight="700" text-anchor="middle">Two-phase region</text>`+
    `<text x="${(PLOT_RIGHT-4).toFixed(1)}" y="${PLOT_BOTTOM-96}" fill="#173d65" font-size="12" font-weight="600" text-anchor="end">Superheated vapor</text>`+
    `<text x="${DOME_LEFT_BASE_X-6}" y="${DOME_BASE_Y+16}" fill="#173d65" font-size="10.5" text-anchor="middle">Saturated liquid</text>`+
    `<text x="${DOME_RIGHT_BASE_X+6}" y="${DOME_BASE_Y+16}" fill="#173d65" font-size="10.5" text-anchor="middle">Saturated vapor</text>`+
    `<g class="region-highlight" id="${kind}Highlight"></g>`+
    `<g class="marker" id="${kind}Marker"></g>`;
}

function drawDiagram(svg,kind){
  svg.setAttribute('viewBox','0 0 430 260');
  svg.innerHTML=buildDiagramMarkup(kind);
  svg.onclick=handlePointerPlace;
  svg.onkeydown=handleKeyPlace;
}

function drawMarker(kind,x,y){
  const g=document.getElementById(`${kind}Marker`);
  if(!g) return;
  g.innerHTML=(x==null)?'':`<circle cx="${x}" cy="${y}" r="7" fill="#ffca05" stroke="#071f3d" stroke-width="2.5"/><circle cx="${x}" cy="${y}" r="13" fill="none" stroke="#ffca05" stroke-width="1.5" opacity=".5"/>`;
}

function updateStatus(kind,region){
  const label=kind==='tv'?'T–v':'P–v';
  const p=$(kind+'Status');
  if(!p) return;
  p.textContent=region?`Your ${label} point is currently in ${regionPhrase(region)}.`:`No point placed yet for the ${label} diagram.`;
}

function setDiagramPoint(kind,x,y,method){
  const svg=$(kind+'Diagram');
  if(!svg) return;
  const cx=clamp(x,PLOT_LEFT+2,PLOT_RIGHT-2), cy=clamp(y,PLOT_TOP+2,PLOT_BOTTOM);
  svg.dataset.x=cx; svg.dataset.y=cy; svg.dataset.method=method;
  drawMarker(kind,cx,cy);
  const region=classifyRegion(cx,cy);
  const select=$(kind+'RegionSelect');
  if(select&&select.value!==region) select.value=region;
  updateStatus(kind,region);
}

function clearDiagramPoint(kind){
  const svg=$(kind+'Diagram');
  if(!svg) return;
  delete svg.dataset.x; delete svg.dataset.y; delete svg.dataset.method;
  drawMarker(kind,null);
  const select=$(kind+'RegionSelect');
  if(select) select.value='';
  updateStatus(kind,null);
  clearHighlight(kind);
}

function handlePointerPlace(e){
  if($('checkButton').disabled) return;
  const svg=e.currentTarget;
  const kind=svg.id==='tvDiagram'?'tv':'pv';
  const pt=svg.createSVGPoint();
  pt.x=e.clientX; pt.y=e.clientY;
  const p=pt.matrixTransform(svg.getScreenCTM().inverse());
  setDiagramPoint(kind,p.x,p.y,'point');
  svg.focus();
}

function handleKeyPlace(e){
  if($('checkButton').disabled) return;
  const svg=e.currentTarget;
  const kind=svg.id==='tvDiagram'?'tv':'pv';
  const arrowKeys=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
  if(arrowKeys.includes(e.key)){
    e.preventDefault();
    let x=Number(svg.dataset.x), y=Number(svg.dataset.y);
    if(!Number.isFinite(x)||!Number.isFinite(y)){x=APEX_X;y=(APEX_Y+DOME_BASE_Y)/2;}
    const step=e.shiftKey?ARROW_STEP_BIG:ARROW_STEP;
    if(e.key==='ArrowUp') y-=step;
    if(e.key==='ArrowDown') y+=step;
    if(e.key==='ArrowLeft') x-=step;
    if(e.key==='ArrowRight') x+=step;
    setDiagramPoint(kind,x,y,'point');
  } else if(e.key===' '||e.key==='Enter'){
    e.preventDefault();
    if(svg.dataset.x!==undefined) updateStatus(kind,classifyRegion(Number(svg.dataset.x),Number(svg.dataset.y)));
  }
}

function handleRegionSelect(kind){
  const select=$(kind+'RegionSelect');
  const region=select.value;
  if(!region) return;
  const pos=representativeMarkerPosition(region);
  setDiagramPoint(kind,pos.x,pos.y,'dropdown');
}

function clearHighlight(kind){
  const g=$(`${kind}Highlight`);
  if(g) g.innerHTML='';
}
function showStrongerGuide(kind){
  const region=activeCase.phase;
  const g=$(`${kind}Highlight`);
  if(!g) return;
  let shapeD='';
  if(region==='Compressed liquid'){
    shapeD=pathFromPoints(domeOutlinePoints('left').concat([[PLOT_LEFT,APEX_Y],[PLOT_LEFT,DOME_BASE_Y]]))+' Z';
  } else if(region==='Superheated vapor'){
    shapeD=pathFromPoints(domeOutlinePoints('right').concat([[PLOT_RIGHT,APEX_Y],[PLOT_RIGHT,DOME_BASE_Y]]))+' Z';
  } else if(region==='Saturated mixture'){
    shapeD=pathFromPoints(domeOutlinePoints('left').concat(domeOutlinePoints('right').slice().reverse()))+' Z';
  }
  let boundaryStroke='';
  if(region==='Saturated liquid') boundaryStroke=`<path d="${pathFromPoints(domeOutlinePoints('left'))}" fill="none" stroke="#ffca05" stroke-width="5" opacity=".85"/>`;
  if(region==='Saturated vapor') boundaryStroke=`<path d="${pathFromPoints(domeOutlinePoints('right'))}" fill="none" stroke="#ffca05" stroke-width="5" opacity=".85"/>`;
  const fill=shapeD?`<path d="${shapeD}" fill="rgba(255,202,5,.28)" stroke="#173d65" stroke-width="1"/>`:'';
  g.innerHTML=`${fill}${boundaryStroke}<text x="${APEX_X}" y="${APEX_Y+18}" text-anchor="middle" font-size="11" font-weight="700" fill="#173d65">Focus here: ${regionLabelForGuide(region)}</text>`;
}

/** Reads a diagram's current placement (from a click, keyboard move, or
 *  dropdown choice -- all three write to the same dataset) and grades it
 *  against the active case's phase, with an optional quality-based check
 *  for two-phase mixture cases. */
function diagramOutcome(kind){
  const svg=$(kind+'Diagram');
  if(!svg||svg.dataset.x===undefined) return {placed:false,regionCorrect:false};
  const x=Number(svg.dataset.x), y=Number(svg.dataset.y);
  const detectedRegion=classifyRegion(x,y);
  const regionCorrect=detectedRegion===activeCase.phase;
  let qualityPlacementCorrect=null;
  if(activeCase.phase==='Saturated mixture'&&detectedRegion==='Saturated mixture'){
    const q=parseQuality(activeCase.given,activeCase.extra);
    if(q!==null){
      const leftX=domeX(y,'left'), rightX=domeX(y,'right');
      const domeWidth=rightX-leftX;
      const expectedX=leftX+q*domeWidth;
      const tol=Math.max(domeWidth*0.35,20);
      qualityPlacementCorrect=Math.abs(x-expectedX)<=tol;
    }
  }
  return {placed:true,x,y,detectedRegion,regionCorrect,selectedMethod:svg.dataset.method||'point',qualityPlacementCorrect};
}

function diagramFeedback(label,outcome){
  if(!outcome.placed) return `${label} diagram: place a point or choose a region to check this diagram.`;
  if(outcome.regionCorrect) return `${label} diagram: correctly placed in ${regionPhrase(outcome.detectedRegion)}.`;
  return `${label} diagram: your point is currently in ${regionPhrase(outcome.detectedRegion)}. Recheck the location of ${correctPhaseGuidancePhrase(activeCase.phase)}.`;
}

function resetResponses(){
  document.querySelectorAll('input[name="phase"]').forEach(input=>{input.checked=false;input.disabled=false});
  activeCase.find.forEach((_,i)=>{const input=$(`prop${i}`);if(input){input.value="";input.disabled=false}});
  clearDiagramPoint('tv'); clearDiagramPoint('pv');
  failedAttempts=0;
  const guideWrap=$('strongerGuideWrap'), guideButton=$('strongerGuideButton');
  if(guideWrap) guideWrap.hidden=true;
  if(guideButton){guideButton.disabled=false;guideButton.textContent='Show stronger diagram guide'}
  $('results').hidden=true;
  $('phaseHint').hidden=true;
  $('checkButton').disabled=false;
}

function renderCase(c,name,mode=quizMode){activeCase=c;setMode(mode);$('workspace').classList.remove('is-submitted');$('practicePanel').hidden=true;$('caseNumber').textContent=c.id;$('fluid').textContent=c.fluid;$('given').textContent=c.given;$('find').textContent=c.find.map(p=>p.symbol).join(', ');$('assignmentNote').textContent=mode==="official"?`Assigned to ${name}. This is your protected official Case ${c.id}.`:`Practice for ${name}. Case ${c.id} does not change your official Case ${officialCaseNumber}.`;$('phaseOptions').innerHTML=phases.map((p,i)=>`<div class="phase-choice"><input id="phase${i}" type="radio" name="phase" value="${p}"><label for="phase${i}">${p}</label></div>`).join('');$('propertyInputs').innerHTML=c.find.map((p,i)=>`<div class="property-field"><label for="prop${i}">${p.symbol}</label><div class="input-row"><input id="prop${i}" type="number" inputmode="decimal" step="any" aria-describedby="unit${i}"><span class="unit" id="unit${i}">${p.unit}</span></div></div>`).join('');drawDiagram($('tvDiagram'),'tv');drawDiagram($('pvDiagram'),'pv');resetResponses()}

function showCompletedOfficial(name){officialSubmitted=true;setMode("official");$('workspace').classList.add('is-submitted');$('practicePanel').hidden=false;$('assignmentNote').textContent=`${name}'s official Case ${officialCaseNumber} has been submitted.`;$('results').hidden=true;$('practicePanel').scrollIntoView({behavior:'smooth',block:'center'})}
function practiceCase(kind){let next;if(kind==="next")next=(activeCase?.id||officialCaseNumber)%THERMO_CASES.length+1;else{do{next=Math.floor(Math.random()*THERMO_CASES.length)+1}while(next===activeCase?.id&&THERMO_CASES.length>1)}practiceAttempt+=1;renderCase(THERMO_CASES[next-1],currentDisplayName,"practice");$('workspace').scrollIntoView({behavior:'smooth'})}

function setupDiagramControls(){
  $('tvRegionSelect').addEventListener('change',()=>handleRegionSelect('tv'));
  $('pvRegionSelect').addEventListener('change',()=>handleRegionSelect('pv'));
  $('tvReset').addEventListener('click',()=>clearDiagramPoint('tv'));
  $('pvReset').addEventListener('click',()=>clearDiagramPoint('pv'));
  $('strongerGuideButton').addEventListener('click',e=>{
    showStrongerGuide('tv'); showStrongerGuide('pv');
    e.target.disabled=true; e.target.textContent='Stronger guide shown';
  });
}

setupSectionToggle();
setupDiagramControls();

$('identityForm').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!validateIdentityForm()){
    const firstInvalid=document.querySelector('#identityForm [aria-invalid="true"]');
    if(firstInvalid)firstInvalid.focus();
    return;
  }
  const firstName=$('firstName').value.trim();
  const lastName=$('lastName').value.trim();
  const email=normalizeEmail($('erauEmail').value);
  $('erauEmail').value=email;
  const section=currentSectionValue();
  const name=`${firstName} ${lastName}`.trim();
  currentDisplayName=name;
  const button=e.submitter;
  button.disabled=true;button.textContent="Retrieving…";
  try{
    const remote=await api({action:"assign",firstName,lastName,email,section});
    const c=remote?THERMO_CASES[remote.caseNumber-1]:assignCase(email);
    officialCaseNumber=c.id;
    localStorage.setItem(assignmentKey(email),String(c.id));
    officialSubmitted=Boolean(remote?.officialSubmitted)||localStorage.getItem(completionKey(email))==="1";
    renderCase(c,name,"official");
    $('welcome').hidden=true;$('workspace').hidden=false;
    if(officialSubmitted)showCompletedOfficial(name);else $('workspace').scrollIntoView({behavior:'smooth'})
  }catch(error){alert(error.message)}
  finally{button.disabled=false;button.textContent="Assign my case"}
});
$('hintButton').addEventListener('click',()=>{const hints={"Compressed liquid":"Compare the given state with saturation conditions. Is the temperature below saturation at the stated pressure?","Saturated liquid":"Look for a quality of zero or a property equal to the saturated-liquid value.","Saturated mixture":"Check whether the given specific property falls between its saturated-liquid and saturated-vapor values.","Saturated vapor":"Look for a quality of one or a property equal to the saturated-vapor value.","Superheated vapor":"Compare the temperature with saturation temperature at the stated pressure. Is it higher?"};$('phaseHint').textContent=hints[activeCase.phase];$('phaseHint').hidden=false});
$('checkButton').addEventListener('click',async()=>{
  if(!activeCase)return;
  const chosen=document.querySelector('input[name="phase"]:checked')?.value;
  const phaseOK=chosen===activeCase.phase;
  const checks=activeCase.find.map((p,i)=>{const raw=$(`prop${i}`).value;const entered=raw===""?NaN:Number(raw);const tol=Math.max(Math.abs(p.value)*p.tolerancePercent/100,0.00001);return {p,entered,ok:Number.isFinite(entered)&&Math.abs(entered-p.value)<=tol}});
  const tvOutcome=diagramOutcome('tv'), pvOutcome=diagramOutcome('pv');
  const diagramsOK=tvOutcome.placed&&pvOutcome.placed&&tvOutcome.regionCorrect&&pvOutcome.regionCorrect;
  const all=Boolean(phaseOK&&checks.every(x=>x.ok)&&diagramsOK);
  const r=$('results');
  r.className=`results${all?' success':''}`;
  r.innerHTML=`<h2>${all?'State resolved':'Review your state'}</h2><ul class="result-list"><li class="${phaseOK?'correct':'incorrect'}">Phase: ${phaseOK?'correct':'recheck your saturation comparison'}</li>${checks.map(x=>`<li class="${x.ok?'correct':'incorrect'}">${x.p.symbol}: ${x.ok?'within the accepted table range':'check the table value and units'}</li>`).join('')}<li class="${tvOutcome.placed&&tvOutcome.regionCorrect?'correct':'incorrect'}">${diagramFeedback('T–v',tvOutcome)}</li><li class="${pvOutcome.placed&&pvOutcome.regionCorrect?'correct':'incorrect'}">${diagramFeedback('P–v',pvOutcome)}</li></ul>${all?`<p><strong>${quizMode==="official"?'Official case complete.':'Practice case complete.'}</strong>${activeCase.extra?' '+activeCase.extra+'.':''}</p>`:'<p>Revise only the marked items, then check again.</p>'}`;
  r.hidden=false;
  r.scrollIntoView({behavior:'smooth',block:'nearest'});
  if(!all){
    failedAttempts+=1;
    const threshold=quizMode==='practice'?1:2;
    if(failedAttempts>=threshold){const w=$('strongerGuideWrap');if(w)w.hidden=false;}
  }
  const email=normalizeEmail($('erauEmail').value);
  const diagramPayload=o=>o.placed?{x:o.x,y:o.y,detectedRegion:o.detectedRegion,selectedMethod:o.selectedMethod,regionCorrect:o.regionCorrect,qualityPlacementCorrect:o.qualityPlacementCorrect}:{x:null,y:null,detectedRegion:null,selectedMethod:null,regionCorrect:false,qualityPlacementCorrect:null};
  const payload={action:"submit",mode:quizMode,firstName:$('firstName').value.trim(),lastName:$('lastName').value.trim(),email,section:currentSectionValue(),caseNumber:activeCase.id,attemptNumber:quizMode==="practice"?practiceAttempt:1,phase:chosen||"",answers:checks.map(x=>({symbol:x.p.symbol,value:Number.isFinite(x.entered)?x.entered:null,correct:x.ok})),phaseCorrect:phaseOK,diagramsPlaced:Boolean(tvOutcome.placed&&pvOutcome.placed),complete:all,tv:diagramPayload(tvOutcome),pv:diagramPayload(pvOutcome)};
  try{await api(payload)}catch(error){r.insertAdjacentHTML('beforeend',`<p class="incorrect">Your work was checked, but it was not recorded. ${error.message}</p>`);return}
  if(all&&quizMode==="official"){localStorage.setItem(completionKey(payload.email),"1");setTimeout(()=>showCompletedOfficial(currentDisplayName),550)}
  else if(all&&quizMode==="practice"){$('practicePanel').hidden=false;$('practicePanel').querySelector('.eyebrow').textContent="Practice case complete";$('practicePanel').querySelector('h2').textContent="Choose another case"}
});
$('randomPractice').addEventListener('click',()=>practiceCase("random"));
$('nextPractice').addEventListener('click',()=>practiceCase("next"));
$('startOver').addEventListener('click',()=>location.reload());
