(() => {
  if (window.__devCanvas && window.__devCanvas.toggle) {
    chrome.runtime?.onMessage?.addListener((msg, _s, sendResponse) => {
      if (msg?.type === "DEV_CANVAS_PING") sendResponse("pong");
      if (msg?.type === "DEV_CANVAS_TOGGLE") window.__devCanvas.toggle();
    });
    return;
  }

  const DPR = Math.max(1, Math.min(2, devicePixelRatio || 1));
  const KEY = 'devcanvas@' + location.origin + location.pathname;
  const Z = 2147483000;

  // ---------- DOM ----------
  const root = document.createElement('div');
  Object.assign(root.style, { position:'fixed', inset:0, zIndex:Z, pointerEvents:'none', display:'none' });
  document.body.appendChild(root);

  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  Object.assign(cvs.style, { position:'absolute', inset:0, pointerEvents:'auto', cursor:'default' });
  root.appendChild(cvs);

  const notesLayer = document.createElement('div');
  Object.assign(notesLayer.style, { position:'absolute', inset:0, pointerEvents:'none' });
  root.appendChild(notesLayer);

  const bar = document.createElement('div');
  bar.setAttribute('data-devcanvas-ui','');
  Object.assign(bar.style, {
    position:'fixed', top:'12px', left:'50%', transform:'translateX(-50%)',
    background:'rgba(22,22,26,.92)', color:'#fff', font:'12px system-ui, sans-serif',
    padding:'8px 10px', borderRadius:'12px', display:'flex', gap:'8px',
    alignItems:'center', zIndex:Z+1, pointerEvents:'auto', boxShadow:'0 6px 24px rgba(0,0,0,.35)'
  });
  bar.innerHTML = `
    <button data-b="select">🖱 Select</button>
    <button data-b="pen">✏️ Pen</button>
    <button data-b="eraser">🧽 Eraser</button>
    <button data-b="rect">▭ Rect</button>
    <button data-b="arrow">➤ Arrow</button>
    <button data-b="note" title="Click to add note. Drag with Select (or Alt+Drag)">🗒️ Note</button>
    <span style="width:1px;height:18px;background:#444;margin:0 2px"></span>
    <button data-b="sizeDown">−</button>
    <span id="sizeLabel" style="min-width:30px;text-align:center">6</span>
    <button data-b="sizeUp">+</button>
    <input data-b="color" type="color" value="#ff4757" style="width:28px;height:22px;border:none;background:transparent">
    <span style="width:1px;height:18px;background:#444;margin:0 2px"></span>
    <button data-b="undo">↶</button>
    <button data-b="redo">↷</button>
    <button data-b="clear">🗑️</button>
    <button data-b="save">💾</button>
    <button data-b="export">📤</button>
    <button data-b="close">✖</button>
  `;
  [...bar.querySelectorAll('button')].forEach(b=>{
    Object.assign(b.style,{ background:'#2b2f36', color:'#fff', border:'1px solid #3b3f46',
      padding:'6px 8px', borderRadius:'8px', cursor:'pointer' });
    b.onmouseenter=()=>b.style.background='#3a3f47';
    b.onmouseleave=()=>b.style.background='#2b2f36';
  });
  root.appendChild(bar);

  const fab = document.createElement('div');
  fab.setAttribute('data-devcanvas-ui','');
  Object.assign(fab.style, {
    position:'fixed', right:'14px', bottom:'14px', width:'16px', height:'16px',
    borderRadius:'50%', background:'#7c5cff', boxShadow:'0 4px 16px rgba(0,0,0,.35)',
    zIndex:Z+2, cursor:'pointer', pointerEvents:'auto', opacity:.7
  });
  fab.title = 'Toggle Dev Canvas';
  document.body.appendChild(fab);

  // ---------- STATE ----------
  let active = false;
  let tool = 'select';
  let color = '#ff4757', size = 6;

  const items = [];
  const redoStack = [];
  const notes = []; 
  const selection = new Set();

  let drawing = false, tmpStart=null, tmpRect=null, tmpArrow=null;
  let draggingNote = null, dragOff = {x:0,y:0};
  let draggingSel = false, dragSelStart = null;

  const sizeLabel = () => (bar.querySelector('#sizeLabel').textContent = String(size));

  // ---------- HELPERS ----------
  const uid = () => Math.random().toString(36).slice(2,9);

  function updateCursors() {
    if (tool === 'select') cvs.style.cursor = 'default';
    else if (tool === 'pen' || tool === 'eraser' || tool === 'rect' || tool === 'arrow' || tool === 'note')
      cvs.style.cursor = 'crosshair';
    notes.forEach(n => { if (n._el) n._el.style.cursor = (tool==='select') ? 'move' : 'text'; });
  }

  const fit = () => {
    const w = Math.floor(innerWidth * DPR), h = Math.floor(innerHeight * DPR);
    cvs.width = w; cvs.height = h;
    cvs.style.width = innerWidth + 'px';
    cvs.style.height = innerHeight + 'px';
    ctx.lineCap='round'; ctx.lineJoin='round';
    redraw(); layoutNotes();
  };

  const pt = (e) => {
    const b = cvs.getBoundingClientRect();
    return { x:(e.clientX-b.left)*DPR, y:(e.clientY-b.top)*DPR };
  };

  
  function bbox(it){
    if (it.type==='rect'){
      const x = Math.min(it.x, it.x+it.w), y = Math.min(it.y, it.y+it.h);
      const w = Math.abs(it.w), h = Math.abs(it.h);
      return {x,y,w,h};
    }
    if (it.type==='arrow'){
      const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2);
      const w = Math.abs(it.x2-it.x1), h = Math.abs(it.y2-it.y1);
      return {x,y,w,h};
    }
    if (it.type==='pen'){
      let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
      it.points.forEach(p=>{minx=Math.min(minx,p.x); miny=Math.min(miny,p.y); maxx=Math.max(maxx,p.x); maxy=Math.max(maxy,p.y);});
      return {x:minx,y:miny,w:maxx-minx,h:maxy-miny};
    }
    return {x:0,y:0,w:0,h:0};
  }

  const distToSeg = (px,py,x1,y1,x2,y2) => {
    const dx=x2-x1, dy=y2-y1;
    if (dx===0 && dy===0) return Math.hypot(px-x1,py-y1);
    const t = Math.max(0, Math.min(1, ((px-x1)*dx+(py-y1)*dy)/(dx*dx+dy*dy)));
    const x = x1 + t*dx, y = y1 + t*dy;
    return Math.hypot(px-x, py-y);
  };

  function hitTest(it, x, y){
    const tol = Math.max(6, it.size*DPR*1.5);
    if (it.type==='rect'){
      const r = bbox(it);
      return x>=r.x-tol && x<=r.x+r.w+tol && y>=r.y-tol && y<=r.y+r.h+tol;
    }
    if (it.type==='arrow'){
      const d = distToSeg(x,y,it.x1,it.y1,it.x2,it.y2);
      return d <= tol;
    }
    if (it.type==='pen'){
      const pts = it.points;
      for (let i=1;i<pts.length;i++){
        if (distToSeg(x,y,pts[i-1].x,pts[i-1].y,pts[i].x,pts[i].y) <= tol) return true;
      }
      return false;
    }
    return false;
  }

  function topHit(x,y){
    for (let i=items.length-1;i>=0;i--){
      if (hitTest(items[i], x,y)) return items[i];
    }
    return null;
  }

  // ---------- RENDER ----------
  function drawItem(it){
    ctx.save();
    if (it.type==='pen'){
      ctx.globalCompositeOperation = (it.eraser) ? 'destination-out' : 'source-over';
      ctx.strokeStyle = it.color; ctx.lineWidth = it.size * DPR;
      ctx.beginPath(); ctx.moveTo(it.points[0].x, it.points[0].y);
      for (let i=1;i<it.points.length;i++) ctx.lineTo(it.points[i].x, it.points[i].y);
      ctx.stroke();
    } else if (it.type==='rect'){
      ctx.strokeStyle = it.color; ctx.lineWidth = it.size * DPR;
      ctx.strokeRect(it.x, it.y, it.w, it.h);
    } else if (it.type==='arrow'){
      ctx.strokeStyle = it.color; ctx.lineWidth = it.size * DPR;
      ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke();
      const angle = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
      const headLen = 10 * DPR + it.size * DPR * 1.5;
      for (const a of [angle - Math.PI/7, angle + Math.PI/7]) {
        ctx.beginPath(); ctx.moveTo(it.x2, it.y2);
        ctx.lineTo(it.x2 - headLen*Math.cos(a), it.y2 - headLen*Math.sin(a)); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawSelection(){
    if (selection.size===0) return;
    ctx.save();
    ctx.setLineDash([6,4]);
    ctx.lineWidth = 1 * DPR;
    ctx.strokeStyle = '#6aa0ff';
    selection.forEach(id=>{
      const it = items.find(o=>o.id===id); if(!it) return;
      const r = bbox(it);
      ctx.strokeRect(r.x-4, r.y-4, r.w+8, r.h+8);
    });
    ctx.restore();
  }

  function redraw(){
    ctx.clearRect(0,0,cvs.width,cvs.height);
    for (const it of items) drawItem(it);
    if (drawing && tool==='rect' && tmpRect){
      ctx.save(); ctx.setLineDash([8,4]); ctx.strokeStyle = color; ctx.lineWidth = size * DPR;
      ctx.strokeRect(tmpRect.x, tmpRect.y, tmpRect.w, tmpRect.h); ctx.restore();
    }
    if (drawing && tool==='arrow' && tmpArrow){
      ctx.save(); ctx.setLineDash([6,4]); ctx.strokeStyle = color; ctx.lineWidth = size * DPR;
      ctx.beginPath(); ctx.moveTo(tmpArrow.x1, tmpArrow.y1); ctx.lineTo(tmpArrow.x2, tmpArrow.y2); ctx.stroke();
      ctx.restore();
    }
    drawSelection();
  }

  // ---------- NOTES ----------
  const createNoteEl = (model) => {
    const el = document.createElement('div');
    el.setAttribute('data-devcanvas-note','');
    el.contentEditable = 'true';
    el.textContent = model.text || 'Note…';
    el.title = 'Type to edit • Drag with Select (or Alt+Drag)';
    Object.assign(el.style, {
      position:'absolute', minWidth:'120px', maxWidth:'260px',
      padding:'8px 10px', background:'#fff8a8', color:'#222',
      border:'1px solid #e6d36a', borderRadius:'8px', boxShadow:'0 6px 18px rgba(0,0,0,.15)',
      font:'13px system-ui, sans-serif', lineHeight:'1.3',
      pointerEvents:'auto', cursor:(tool==='select')?'move':'text'
    });
    for (const type of ['keydown','keypress','keyup']) el.addEventListener(type, ev => ev.stopPropagation());
    el.addEventListener('click', ev => ev.stopPropagation());
    el.addEventListener('input', () => model.text = el.innerText);
    el.addEventListener('mousedown', (e) => {
      const canDrag = (tool==='select') || e.altKey;
      if (!canDrag) return;
      draggingNote = { el, model };
      el.style.cursor='grabbing';
      const r = el.getBoundingClientRect();
      dragOff.x = e.clientX - r.left; dragOff.y = e.clientY - r.top;
      e.preventDefault(); e.stopPropagation();
    });
    el.addEventListener('mouseup', () => { draggingNote = null; el.style.cursor=(tool==='select')?'move':'text'; });
    notesLayer.appendChild(el);
    model._el = el;
    updateCursors();
    return el;
  };

  const layoutNotes = () => {
    for (const n of notes) {
      const el = n._el || createNoteEl(n);
      el.style.left = (n.xPct * innerWidth) + 'px';
      el.style.top  = (n.yPct * innerHeight) + 'px';
    }
  };

  const addNoteAt = (clientX, clientY) => {
    const xPct = clientX / innerWidth, yPct = clientY / innerHeight;
    const m = { xPct, yPct, text: 'Note…' };
    notes.push(m);
    const el = createNoteEl(m);
    layoutNotes();
    setTimeout(()=>el.focus(), 0);
  };

  // ---------- EVENTS ----------
  const onDown = (e) => {
    if (!active || e.button!==0) return;
    if (e.target.closest('[data-devcanvas-ui]')) return;

    if (e.target.closest('[data-devcanvas-note]')) return;

    const p = pt(e);

    if (tool==='select'){
      const hit = topHit(p.x, p.y);
      if (hit){
        if (!e.shiftKey && !selection.has(hit.id)) { selection.clear(); }
        selection.add(hit.id);
     
        dragSelStart = { x:p.x, y:p.y, start: items.filter(it=>selection.has(it.id)).map(it=>({id:it.id, snapshot: structuredClone(it)})) };
        draggingSel = true;
        redraw();
      } else {
        selection.clear();
        redraw();
      }
      return;
    }

    // NOTE TOOL
    if (tool==='note') {
      addNoteAt(e.clientX, e.clientY);
      return;
    }

    // DRAWING TOOLS
    drawing = true; redoStack.length = 0; selection.clear();
    tmpStart = p;

    if (tool==='pen' || tool==='eraser') {
      items.push({ id:uid(), type:'pen', color, size, eraser:(tool==='eraser'), points:[p] });
    } else if (tool==='rect') {
      tmpRect = { x:p.x, y:p.y, w:0, h:0 };
    } else if (tool==='arrow') {
      tmpArrow = { x1:p.x, y1:p.y, x2:p.x, y2:p.y };
    }
  };

  const onMove = (e) => {
    if (draggingNote) {
      const {el, model} = draggingNote;
      const left = e.clientX - dragOff.x;
      const top  = e.clientY - dragOff.y;
      el.style.left = left + 'px'; el.style.top = top + 'px';
      model.xPct = left / innerWidth; model.yPct = top / innerHeight;
      return;
    }

    if (draggingSel && dragSelStart){
      const p = pt(e); const dx = p.x - dragSelStart.x; const dy = p.y - dragSelStart.y;
      for (const {id, snapshot} of dragSelStart.start){
        const it = items.find(o=>o.id===id); if(!it) continue;
        if (it.type==='rect'){ it.x = snapshot.x + dx; it.y = snapshot.y + dy; }
        if (it.type==='arrow'){ it.x1 = snapshot.x1 + dx; it.y1 = snapshot.y1 + dy; it.x2 = snapshot.x2 + dx; it.y2 = snapshot.y2 + dy; }
        if (it.type==='pen'){ it.points = snapshot.points.map(pt=>({x:pt.x+dx, y:pt.y+dy})); }
      }
      redraw();
      return;
    }

    if (!drawing || !active) return;

    const p = pt(e);
    if (tool==='pen' || tool==='eraser') {
      const it = items[items.length-1];
      it.points.push(p);
      drawItem(it);
      drawSelection(); 
    } else if (tool==='rect') {
      tmpRect.w = p.x - tmpRect.x; tmpRect.h = p.y - tmpRect.y; redraw();
    } else if (tool==='arrow') {
      tmpArrow.x2 = p.x; tmpArrow.y2 = p.y; redraw();
    }
  };

  const onUp = () => {
    if (draggingSel){ draggingSel=false; dragSelStart=null; return; }
    if (!drawing) return; drawing = false;

    if (tool==='rect' && tmpRect) {
      const it = { id:uid(), type:'rect', color, size, x:tmpRect.x, y:tmpRect.y, w:tmpRect.w, h:tmpRect.h };
      items.push(it); tmpRect=null; redraw();
    }
    if (tool==='arrow' && tmpArrow) {
      const it = { id:uid(), type:'arrow', color, size, ...tmpArrow };
      items.push(it); tmpArrow=null; redraw();
    }
  };

  const onKey = (e) => {

    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='d'){ e.preventDefault(); api.toggle(); }

    // tool hotkeys
    const k = e.key.toLowerCase();
    if (k==='s'){ tool='select'; updateCursors(); }
    if (k==='1'){ tool='pen';    updateCursors(); }
    if (k==='2'){ tool='eraser'; updateCursors(); }
    if (k==='3'){ tool='rect';   updateCursors(); }
    if (k==='4'){ tool='arrow';  updateCursors(); }
    if (k==='5'){ tool='note';   updateCursors(); }

    // selection ops
    if (k==='escape'){ selection.clear(); redraw(); }
    if ((k==='delete' || k==='backspace') && active){
      if (selection.size>0){
        for (const id of [...selection]) {
          const idx = items.findIndex(i=>i.id===id);
          if (idx>=0) items.splice(idx,1);
        }
        selection.clear(); redraw();
        e.preventDefault();
      }
    }

    if (!active) return;
    if ((e.ctrlKey||e.metaKey) && k==='z'){ e.preventDefault(); }
    if ((e.ctrlKey||e.metaKey) && e.shiftKey && k==='z'){ e.preventDefault(); /* redo */ }
    if (k==='['){ size=Math.max(1, size-1); sizeLabel(); }
    if (k===']'){ size=Math.min(50, size+1); sizeLabel(); }
  };

  // ---------- TOOLBAR ----------
  bar.addEventListener('click', (e)=>{
    const b = e.target.closest('[data-b]'); if(!b) return;
    const id = b.getAttribute('data-b');
    if (id==='select'){ tool='select'; updateCursors(); return; }
    if (id==='pen')   { tool='pen';    updateCursors(); return; }
    if (id==='eraser'){ tool='eraser'; updateCursors(); return; }
    if (id==='rect')  { tool='rect';   updateCursors(); return; }
    if (id==='arrow') { tool='arrow';  updateCursors(); return; }
    if (id==='note')  { tool='note';   updateCursors(); return; }

    if (id==='sizeUp'){ size=Math.min(50, size+1); sizeLabel(); }
    if (id==='sizeDown'){ size=Math.max(1, size-1); sizeLabel(); }
    if (id==='undo'){ }
    if (id==='redo'){ }
    if (id==='clear'){
      items.length=0; ctx.clearRect(0,0,cvs.width,cvs.height);
      notes.length=0; [...notesLayer.children].forEach(c=>c.remove());
      selection.clear();
    }
    if (id==='save'){ save(); }
    if (id==='export'){ exportPNG(); }
    if (id==='close'){ api.destroy(); }
  });

  bar.querySelector('input[type=color]').addEventListener('input', (e)=>{ color = e.target.value; });

  // ---------- PERSISTENCE ----------
  const save = () => {
    try {
      const modelNotes = notes.map(n=>({xPct:n.xPct,yPct:n.yPct,text:n.text||''}));
      const payload = { version: 6, items, notes:modelNotes };
      localStorage.setItem(KEY, JSON.stringify(payload));
      toast('Saved for this URL');
    } catch(e){ console.warn(e); toast('Save failed'); }
  };

  const load = () => {
    const raw = localStorage.getItem(KEY); if(!raw) return;
    try {
      const parsed = JSON.parse(raw);
     
      if (parsed?.strokes && !parsed.items){
        parsed.items = parsed.strokes.map(s=>{
          if (s.tool==='rect') return { id:uid(), type:'rect', color:s.color, size:s.size, x:s.x, y:s.y, w:s.w, h:s.h };
          if (s.tool==='arrow') return { id:uid(), type:'arrow', color:s.color, size:s.size, x1:s.x1, y1:s.y1, x2:s.x2, y2:s.y2 };
          if (s.tool==='pen' || s.tool==='eraser') return { id:uid(), type:'pen', color:s.color, size:s.size, eraser:(s.tool==='eraser'), points:s.points };
          return null;
        }).filter(Boolean);
      }
      if (parsed?.items) { items.splice(0, items.length, ...parsed.items); }
      if (parsed?.notes) {
        notes.splice(0, notes.length, ...parsed.notes);
        layoutNotes();
      }
      redraw();
    } catch(e){ console.warn('load failed', e); }
  };

  const exportPNG = () => {
    const temp = document.createElement('canvas');
    temp.width = cvs.width; temp.height = cvs.height;
    const tctx = temp.getContext('2d');
    items.forEach(drawItem.bind({ctx:tctx}) || drawItem);
    tctx.drawImage(cvs, 0, 0); 
    tctx.font = `${13*DPR}px system-ui`;
    for (const n of notes) {
      const x = n.xPct * innerWidth * DPR;
      const y = n.yPct * innerHeight * DPR;
      const pad = 8 * DPR; const text = (n.text||'').split('\n');
      let w = 120 * DPR; let h = (text.length*18 + 12) * DPR;
      tctx.fillStyle = '#fff8a8'; tctx.strokeStyle='#e6d36a'; tctx.lineWidth = 1 * DPR;
      tctx.fillRect(x, y, w, h); tctx.strokeRect(x, y, w, h);
      tctx.fillStyle = '#222';
      text.forEach((line,i)=> tctx.fillText(line, x+pad, y+pad + i*18*DPR));
    }
    const a = document.createElement('a'); a.download = 'dev-canvas.png'; a.href = temp.toDataURL('image/png'); a.click();
  };

  // ---------- API + messaging ----------
  const api = {
    toggle(force){
      const desired = (typeof force === 'boolean') ? force : !active;
      active = desired;
      root.style.display = active ? 'block' : 'none';
      fab.style.opacity = active ? .7 : 1;
      root.style.pointerEvents = active ? 'auto' : 'none';
      updateCursors();
      redraw();
    },
    destroy(){
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', fit);
      root.remove(); fab.remove();
      delete window.__devCanvas;
    }
  };
  window.__devCanvas = api;

  chrome.runtime?.onMessage?.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "DEV_CANVAS_PING") sendResponse("pong");
    if (msg?.type === "DEV_CANVAS_TOGGLE") api.toggle();
  });

  // ---------- BINDINGS ----------
  window.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);
  fab.addEventListener('click', ()=>api.toggle());

 
  fit(); load(); sizeLabel(); updateCursors();
})();
