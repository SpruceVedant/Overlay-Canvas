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

  // Root overlay (non-blocking) — start HIDDEN
  const root = document.createElement('div');
  Object.assign(root.style, {
    position: 'fixed', inset: 0, zIndex: Z, pointerEvents: 'none',
    display: 'none' // <— start hidden
  });
  document.body.appendChild(root);

  // Canvas (receives input)
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  Object.assign(cvs.style, { position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: 'crosshair' });
  root.appendChild(cvs);

  // Notes layer DOES NOT block clicks; only notes do.
  const notesLayer = document.createElement('div');
  Object.assign(notesLayer.style, { position: 'absolute', inset: 0, pointerEvents: 'none' });
  root.appendChild(notesLayer);

  // Toolbar
  const bar = document.createElement('div');
  bar.setAttribute('data-devcanvas-ui', '');
  Object.assign(bar.style, {
    position:'fixed', top:'12px', left:'50%', transform:'translateX(-50%)',
    background:'rgba(22,22,26,.92)', color:'#fff', font:'12px system-ui, sans-serif',
    padding:'8px 10px', borderRadius:'12px', display:'flex', gap:'8px',
    alignItems:'center', zIndex:Z+1, pointerEvents:'auto', boxShadow:'0 6px 24px rgba(0,0,0,.35)'
  });
  bar.innerHTML = `
    <button data-b="pen">✏️ Pen</button>
    <button data-b="eraser">🧽 Eraser</button>
    <button data-b="rect">▭ Rect</button>
    <button data-b="arrow">➤ Arrow</button>
    <button data-b="note" title="Click to add note. Type to edit. Alt+Drag to move">🗒️ Note</button>
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

  // Toggle FAB
  const fab = document.createElement('div');
  fab.setAttribute('data-devcanvas-ui', '');
  Object.assign(fab.style, {
    position:'fixed', right:'14px', bottom:'14px', width:'16px', height:'16px',
    borderRadius:'50%', background:'#7c5cff', boxShadow:'0 4px 16px rgba(0,0,0,.35)',
    zIndex:Z+2, cursor:'pointer', pointerEvents:'auto', opacity:.7
  });
  fab.title = 'Toggle Dev Canvas (in-page hotkey or extension shortcut)';
  document.body.appendChild(fab);

  // ---------- STATE ----------
  let active = false;// fixed bug
  let tool = 'pen', color = '#ff4757', size = 6;
  let drawing = false, tmpStart=null, tmpRect=null, tmpArrow=null;
  let draggingNote = null, dragOff = {x:0,y:0};

  const strokes = []; const redoStack = []; const notes = [];
  const sizeLabel = () => (bar.querySelector('#sizeLabel').textContent = String(size));

  // ---------- UTILS ----------
  const toast = (msg) => {
    const t = document.createElement('div');
    Object.assign(t.style, {
      position:'fixed', left:'50%', bottom:'40px', transform:'translateX(-50%)',
      background:'rgba(20,20,24,.95)', color:'#fff', padding:'8px 12px', borderRadius:'10px',
      font:'12px system-ui, sans-serif', zIndex:Z+3, pointerEvents:'none'
    });
    t.textContent = msg; document.body.appendChild(t);
    setTimeout(()=>t.remove(), 1100);
  };

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

  // ---------- DRAWING ----------
  const drawStroke = (s) => {
    ctx.save();
    if (s.tool==='pen' || s.tool==='eraser') {
      ctx.globalCompositeOperation = (s.tool==='eraser') ? 'destination-out' : 'source-over';
      ctx.strokeStyle = s.color; ctx.lineWidth = s.size * DPR;
      ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i=1;i<s.points.length;i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
    } else if (s.tool==='rect') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color; ctx.lineWidth = s.size * DPR;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
    } else if (s.tool==='arrow') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color; ctx.lineWidth = s.size * DPR;
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const headLen = 10 * DPR + s.size * DPR * 1.5;
      for (const a of [angle - Math.PI/7, angle + Math.PI/7]) {
        ctx.beginPath(); ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - headLen*Math.cos(a), s.y2 - headLen*Math.sin(a)); ctx.stroke();
      }
    }
    ctx.restore();
  };

  const redraw = () => {
    ctx.clearRect(0,0,cvs.width,cvs.height);
    for (const s of strokes) drawStroke(s);
    if (drawing && tool==='rect' && tmpRect){
      ctx.save(); ctx.setLineDash([8,4]); ctx.strokeStyle = color; ctx.lineWidth = size * DPR;
      ctx.strokeRect(tmpRect.x, tmpRect.y, tmpRect.w, tmpRect.h); ctx.restore();
    }
    if (drawing && tool==='arrow' && tmpArrow){
      ctx.save(); ctx.setLineDash([6,4]); ctx.strokeStyle = color; ctx.lineWidth = size * DPR;
      ctx.beginPath(); ctx.moveTo(tmpArrow.x1, tmpArrow.y1); ctx.lineTo(tmpArrow.x2, tmpArrow.y2); ctx.stroke();
      ctx.restore();
    }
  };

  // ---------- NOTES ----------
  const createNoteEl = (model) => {
    const el = document.createElement('div');
    el.setAttribute('data-devcanvas-note','');
    el.contentEditable = 'true';
    el.textContent = model.text || 'Note…';
    el.title = 'Type to edit • Alt+Drag to move';
    Object.assign(el.style, {
      position:'absolute', minWidth:'120px', maxWidth:'260px',
      padding:'8px 10px', background:'#fff8a8', color:'#222',
      border:'1px solid #e6d36a', borderRadius:'8px', boxShadow:'0 6px 18px rgba(0,0,0,.15)',
      font:'13px system-ui, sans-serif', lineHeight:'1.3',
      pointerEvents:'auto', cursor:'text'
    });

    for (const type of ['keydown','keypress','keyup']) el.addEventListener(type, ev => ev.stopPropagation());
    el.addEventListener('click', ev => ev.stopPropagation());
    el.addEventListener('input', () => model.text = el.innerText);

    el.addEventListener('mousedown', (e) => {
      if (!e.altKey) return;
      draggingNote = { el, model }; el.style.cursor='grabbing';
      const r = el.getBoundingClientRect();
      dragOff.x = e.clientX - r.left; dragOff.y = e.clientY - r.top;
      e.preventDefault(); e.stopPropagation();
    });
    el.addEventListener('mouseup', () => { draggingNote = null; el.style.cursor='text'; });

    notesLayer.appendChild(el);
    model._el = el;
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

    if (tool==='note') {
      addNoteAt(e.clientX, e.clientY);
      toast('Note added. Type to edit. Alt+Drag to move.');
      return;
    }

    drawing = true; redoStack.length = 0;
    tmpStart = pt(e);

    if (tool==='pen' || tool==='eraser') {
      strokes.push({tool, color, size, points:[tmpStart]});
    } else if (tool==='rect') {
      tmpRect = {x: tmpStart.x, y: tmpStart.y, w:0, h:0};
    } else if (tool==='arrow') {
      tmpArrow = {x1: tmpStart.x, y1: tmpStart.y, x2: tmpStart.x, y2: tmpStart.y};
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
    if (!drawing || !active) return;

    if (tool==='pen' || tool==='eraser') {
      const s = strokes[strokes.length-1];
      s.points.push(pt(e));
      drawStroke(s);
    } else if (tool==='rect') {
      const p = pt(e); tmpRect.w = p.x - tmpRect.x; tmpRect.h = p.y - tmpRect.y; redraw();
    } else if (tool==='arrow') {
      const p = pt(e); tmpArrow.x2 = p.x; tmpArrow.y2 = p.y; redraw();
    }
  };

  const onUp = () => {
    if (!drawing) return; drawing = false;
    if (tool==='rect' && tmpRect) {
      let {x,y,w,h} = tmpRect; if (w<0){x+=w; w*=-1;} if (h<0){y+=h; h*=-1;}
      strokes.push({tool:'rect', color, size, x,y,w,h}); tmpRect = null; redraw();
    }
    if (tool==='arrow' && tmpArrow) {
      strokes.push({tool:'arrow', color, size, ...tmpArrow}); tmpArrow = null; redraw();
    }
  };

  const onKey = (e) => {
    // toggle ctrl + d
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='d'){ e.preventDefault(); api.toggle(); }
    if (!active) return;
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z'){ e.preventDefault(); bar.querySelector('[data-b=undo]').click(); }
    if ((e.ctrlKey||e.metaKey) && e.shiftKey && e.key.toLowerCase()==='z'){ e.preventDefault(); bar.querySelector('[data-b=redo]').click(); }
    if (e.key==='Escape'){ api.toggle(false); }
    if (e.key==='['){ size=Math.max(1, size-1); sizeLabel(); }
    if (e.key===']'){ size=Math.min(50, size+1); sizeLabel(); }
    if (e.key==='1') tool='pen';
    if (e.key==='2') tool='eraser';
    if (e.key==='3') tool='rect';
    if (e.key==='4') tool='arrow';
    if (e.key==='5') tool='note';
  };

  // Toolbar handlers
  bar.addEventListener('click', (e)=>{
    const b = e.target.closest('[data-b]'); if(!b) return;
    const id = b.getAttribute('data-b');
    if (id==='pen') tool='pen';
    if (id==='eraser') tool='eraser';
    if (id==='rect') tool='rect';
    if (id==='arrow') tool='arrow';
    if (id==='note') tool='note';
    if (id==='sizeUp'){ size=Math.min(50, size+1); sizeLabel(); }
    if (id==='sizeDown'){ size=Math.max(1, size-1); sizeLabel(); }
    if (id==='undo'){ const s = strokes.pop(); if (s){ redoStack.push(s); redraw(); } }
    if (id==='redo'){ const s = redoStack.pop(); if (s){ strokes.push(s); redraw(); } }
    if (id==='clear'){
      strokes.length=0; redoStack.length=0; ctx.clearRect(0,0,cvs.width,cvs.height);
      notes.length=0; [...notesLayer.children].forEach(c=>c.remove());
    }
    if (id==='save'){ save(); }
    if (id==='export'){ exportPNG(); }
    if (id==='close'){ api.destroy(); }
  });

  bar.querySelector('input[type=color]').addEventListener('input', (e)=>{ color = e.target.value; });


  const save = () => {
    try {
      const modelNotes = notes.map(n=>({xPct:n.xPct,yPct:n.yPct,text:n.text||''}));
      localStorage.setItem(KEY, JSON.stringify({version:4, strokes, notes:modelNotes}));
      toast('Saved for this URL');
    } catch(e){ console.warn(e); toast('Save failed'); }
  };

  const load = () => {
    const raw = localStorage.getItem(KEY); if(!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.strokes) strokes.splice(0, strokes.length, ...parsed.strokes);
      if (parsed?.notes) { notes.splice(0, notes.length, ...parsed.notes); layoutNotes(); }
      redraw();
    } catch(e){ console.warn('load failed', e); }
  };

  const exportPNG = () => {
    const temp = document.createElement('canvas');
    temp.width = cvs.width; temp.height = cvs.height;
    const tctx = temp.getContext('2d');
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


  const api = {
    toggle(force){
      const desired = (typeof force === 'boolean') ? force : !active;
      active = desired;
      root.style.display = active ? 'block' : 'none';
      fab.style.opacity = active ? .7 : 1;
      root.style.pointerEvents = active ? 'auto' : 'none';
      // toast(active ? 'Dev Canvas ON' : 'Dev Canvas OFF'); 
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

  
  window.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);
  fab.addEventListener('click', ()=>api.toggle());

 
  fit(); load(); sizeLabel();

})();
