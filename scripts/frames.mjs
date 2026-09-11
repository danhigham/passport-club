#!/usr/bin/env node
/**
 * Frame-integrity check.
 *
 * Plays the game in a real browser and samples the canvas every frame, watching
 * the balance of land to ocean. The globe moves smoothly, so a large jump
 * between consecutive frames means a frame was drawn wrong.
 *
 * This exists because of a bug that nothing else could see. d3's clipping is
 * spherical: to draw a shape it asks whether that shape contains the centre of
 * the view. For a ring that has collapsed to a point or a line the answer is
 * arbitrary, and when it comes back "yes" the clipper concludes the shape
 * covers the whole visible hemisphere and fills the entire disc -- painting the
 * oceans in the colour of the land for a single frame. Simplification creates
 * such rings from small islands. Every static check passed: the rings were
 * valid GeoJSON, correctly wound, and enclosed no area worth mentioning.
 *
 *   node scripts/frames.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = Number(process.env.PORT || 4371), O=`http://localhost:${PORT}`;
const DEV = process.env.DEV === '1';
const srv = DEV
  ? spawn('npx',['vite','--port',String(PORT),'--strictPort'],{stdio:'ignore'})
  : spawn('npx',['vite','preview','--port',String(PORT),'--strictPort'],{stdio:'ignore'});
for(let i=0;i<100;i++){try{if((await fetch(O)).ok)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const b=await chromium.launch({headless:true, executablePath:process.env.HOME+'/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'});
const p=await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
p.on('pageerror', e=>console.log('PAGEERROR:', String(e).slice(0,160)));

const install = () => p.evaluate(() => {
  if (window.__fz) { window.__fz.stop = true; }
  const src = document.querySelector('canvas.globe-canvas');
  const off = document.createElement('canvas'); off.width=96; off.height=68;
  const octx = off.getContext('2d',{willReadFrequently:true});
  const st = { frames:0, bad:[], stop:false }; window.__fz = st;
  const tick = () => {
    const api = window.__passportClub;
    if (api && src.width) {
      octx.drawImage(src,0,0,off.width,off.height);
      const d = octx.getImageData(0,0,off.width,off.height).data;
      let land=0, sea=0;
      for (let i=0;i<d.length;i+=4){
        const r=d[i],g=d[i+1],bl=d[i+2];
        if (r>195 && g>180 && bl>140 && bl<230) land++;
        else if (bl>r+25 && bl>70) sea++;
      }
      const tot=land+sea; st.frames++;
      if (tot>300) {
        const frac = land/tot;
        // Any single-frame lurch in the land/ocean balance. The globe moves
        // smoothly, so a big jump between consecutive frames means something
        // was drawn wrong -- an inverted fill, or land vanishing entirely.
        if (st.prev !== undefined && Math.abs(frac - st.prev) > 0.3) {
          st.bad.push({ from:+st.prev.toFixed(2), to:+frac.toFixed(2),
                        zoom:+api.camera.zoom.toFixed(2),
                        center:api.camera.center.map(n=>+n.toFixed(1)),
                        animating:api.animating });
        }
        st.prev = frac;
      }
    }
    if (!st.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const modes = [
  ['Countries','.chip','Whole world'],
  ['Continents',null,null],
  ['Cities','.chip','Whole world'],
  ['States & Counties','.chip.tall','United States'],
  ['Countries','.chip','Europe'],
];
let totalFrames=0, allBad=[];
for (const [mode, sel, text] of modes) {
  await p.goto(O+'/?e2e=1'); await p.locator('.setup').waitFor();
  await p.locator('.big-card',{hasText:mode}).first().click();
  if (sel) await p.locator(sel,{hasText:text}).first().click();
  await p.locator('.start-button').click();
  await p.locator('.globe-stage').waitFor();
  await p.waitForFunction(()=>window.__passportClub?.camera!=null,null,{timeout:20000});
  await install();
  const box=await p.locator('.globe-stage').boundingBox();
  const cx=box.x+box.width/2, cy=box.y+box.height/2;

  for (let round=0; round<3; round++) {
    await p.mouse.move(cx,cy); await p.mouse.down();
    for (let i=1;i<=40;i++) await p.mouse.move(cx+Math.sin(i/4)*280, cy+Math.cos(i/6)*130);
    await p.mouse.up();
    for (let i=0;i<10;i++){ await p.mouse.wheel(0,-140); await p.waitForTimeout(10); }
    for (let i=0;i<10;i++){ await p.mouse.wheel(0, 140); await p.waitForTimeout(10); }
    await p.locator('.map-controls button[aria-label="Reset the view"]').click();
    await p.waitForTimeout(700);
    const h=await p.evaluate(()=>window.__passportClub);
    if (h?.target && h.status==='guessing') {
      await p.locator('.ghost-button',{hasText:'Hint'}).click().catch(()=>{});
      await p.waitForTimeout(900);
      await p.evaluate(pt=>window.__passportClub.faceTo(pt), h.target.point);
      await p.waitForTimeout(100);
      const xy=await p.evaluate(pt=>window.__passportClub.project(pt), h.target.point);
      if (xy) await p.mouse.click(box.x+xy[0], box.y+xy[1]);
      await p.waitForTimeout(2000);
    }
  }
  const res=await p.evaluate(()=>{window.__fz.stop=true; return {n:window.__fz.frames, bad:window.__fz.bad};});
  totalFrames+=res.n; allBad.push(...res.bad.map(x=>({mode,...x})));
  console.log(`${(mode+' '+(text||'')).padEnd(34)} ${String(res.n).padStart(5)} frames, bad ${res.bad.length}`);
}
console.log(`\nTOTAL ${totalFrames} frames, ${allBad.length} bad`);
for (const x of allBad.slice(0,8)) console.log('  ', JSON.stringify(x));
await b.close(); srv.kill('SIGTERM');
console.log(allBad.length ? '\nFRAME INTEGRITY FAILED\n' : '\nAll frames intact.\n');
process.exit(allBad.length ? 1 : 0);
