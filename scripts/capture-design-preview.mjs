import { chromium } from 'playwright';
import { buildUserFallback } from '../src/app/rbac/menuModel.js';
import { mkdirSync, writeFileSync } from 'node:fs';
const label = process.argv[2] || 'before';
const base = process.env.UI_PREVIEW_URL || 'http://127.0.0.1:4179';
const out = `artifacts/redesign/${label}`; mkdirSync(out,{recursive:true});
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const roles = [
  {code:'superadmin',name:'超级管理员',level:100,privileged:true,perms:['api:rbac-admin','api:rbac-grant-admin']},
  {code:'admin',name:'管理员',level:80,privileged:true,perms:['api:rbac-admin']},
  {code:'svip',name:'SVIP',level:60,perms:[]}, {code:'vip',name:'VIP',level:40,perms:[]},
  {code:'auction',name:'竞价看板',level:20,perms:[]}, {code:'user',name:'普通用户',level:10,isVirtual:true,perms:[]},
  {code:'guest',name:'游客',level:0,isVirtual:true,perms:[]},
];
const menus = buildUserFallback({isAdmin:true}).menus.map(m=>({...m, enabled:true}));
const state={...buildUserFallback({isAdmin:true}),username:'设计预览',roles:[roles[0]],topRole:roles[0],perms:[...buildUserFallback({isAdmin:true}).perms,'api:rbac-admin','api:rbac-grant-admin'],permVersion:'design-fixture-v1',source:'fixture'};
const users=Array.from({length:24},(_,i)=>({id:`preview-user-${String(i+1).padStart(3,'0')}`, username:`示例用户 ${String(i+1).padStart(2,'0')}`, roles:i<3?[roles[i]]:[],createdAt:'2026-10-01T08:00:00Z',lastActiveAt:'2026-10-23T12:00:00Z'}));
const context=await browser.newContext({viewport:{width:390,height:844}});
await context.addInitScript(({state})=>{
  localStorage.setItem('aiDcaCloudSyncSession',JSON.stringify({userId:'design-preview',username:'设计预览',accessToken:'fixture-not-a-real-token',isAdmin:true,roles:state.roles}));
  localStorage.setItem('aiDcaRbacMenus_v1',JSON.stringify({key:'user:design-preview',state}));
},{state});
const page=await context.newPage(); let writes=0; const blockedWriteRequests=[]; const errors=[]; const layoutChecks=[]; const stateChecks=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url()),path=url.pathname;
 if (path.startsWith('/api/')) {
  if(!['GET','HEAD','OPTIONS'].includes(req.method())) { blockedWriteRequests.push({method:req.method(),path}); return route.fulfill({json:{ok:true}}); }
  let data={ok:true,items:[],accounts:[],events:[],users:[],rows:[]};
  if(path.endsWith('/auth/me')||path.endsWith('/auth/menus')) data={...state,user:{id:'design-preview',username:'设计预览'},rbac:state};
  else if(path.includes('/admin/roles')) data={roles};
  else if(path.includes('/admin/permissions')) data={permissions:state.perms.map(code=>({code,kind:code.startsWith('api:')?'api':'menu',description:code}))};
  else if(path.includes('/admin/menus')) data={menus};
  else if(path.includes('/admin/users')) data={users:users.filter(u=>!url.searchParams.get('q')||u.username.includes(url.searchParams.get('q')))};
  else if(path.includes('/admin/audit')) data={events:[],items:[]};
  else if(path.includes('/analytics/guests')) data={guests:[]};
  else if(path.includes('/account')) data={ok:true,accounts:[],data:null,items:[]};
  else if(path.endsWith('/status')) data={configured:{bark:false,webWs:false},setup:{}};
  return route.fulfill({json:data});
 }
 if(url.origin===base) return route.continue();
 return route.abort();
});
await page.goto(base+'/index.html?tab=adminRbac');
await page.waitForTimeout(2200);
await page.evaluate(()=>{const el=document.createElement('div');el.id='preview-fixture-label';el.textContent='设计预览 · 以下用户为测试数据';Object.assign(el.style,{position:'fixed',bottom:'0',left:'0',right:'0',zIndex:'9999',padding:'5px',background:'#1e293b',color:'white',fontSize:'10px',textAlign:'center'});document.body.append(el)});
console.log((await page.locator('body').innerText()).slice(0,1500));
await page.screenshot({path:`${out}/admin-rbac-mobile.png`,fullPage:false});
layoutChecks.push(await page.evaluate(()=>({screen:'admin-mobile',width:innerWidth,documentWidth:document.documentElement.scrollWidth})));
const active=await page.locator('a').filter({hasText:/用户24/}).first().evaluate(e=>({text:e.textContent,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor})).catch(()=>null);
await page.setViewportSize({width:1440,height:1000});layoutChecks.push(await page.evaluate(()=>({screen:'admin-desktop',width:innerWidth,documentWidth:document.documentElement.scrollWidth})));await page.screenshot({path:`${out}/admin-rbac-desktop.png`,fullPage:false});

if(label==='after') {
 await page.setViewportSize({width:390,height:844});
 await page.locator('a[href="#matrix"]').click(); await page.waitForTimeout(200);
 await page.screenshot({path:`${out}/permission-matrix-mobile.png`});
 await page.locator('a[href="#users"]').click(); await page.waitForTimeout(100);
 await page.getByText('示例用户 01',{exact:true}).click(); await page.waitForTimeout(100);
 await page.screenshot({path:`${out}/user-drawer-mobile.png`});
 await page.keyboard.press('Escape');
 // Keyboard navigation must switch tabs without changing authorization data.
 await page.locator('a[href="#users"]').focus(); await page.keyboard.press('ArrowRight');
 const keyboardSelected=await page.locator('[role="tab"][aria-selected="true"]').getAttribute('href');
 if(keyboardSelected!=='#guests') throw new Error('Arrow navigation failed');
 await page.locator('a[href="#users"]').click();
 await page.evaluate(()=>{document.documentElement.classList.add('dark');window.scrollTo(0,0)}); await page.waitForTimeout(200); console.log('DARK',await page.locator('a[data-active=true], .ui-filter').evaluateAll(els=>els.slice(0,4).map(e=>({text:e.textContent,classes:e.className,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,primary:getComputedStyle(e).getPropertyValue('--ds-primary')}))));
 await page.mouse.move(1, 1); await page.waitForTimeout(500);
 await page.screenshot({path:`${out}/admin-rbac-dark-mobile.png`});
 await page.evaluate(()=>document.documentElement.classList.remove('dark'));
 for(const tab of ['home','markets','holdings','tradePlans']) {
   await page.goto(base+'/index.html?tab='+tab); await page.waitForTimeout(800);
   await page.screenshot({path:`${out}/${tab}-mobile.png`});layoutChecks.push(await page.evaluate(t=>({screen:t+'-mobile',width:innerWidth,documentWidth:document.documentElement.scrollWidth}),tab));
 }

 await page.evaluate(()=>{
 const el=document.createElement('section');el.id='design-states';Object.assign(el.style,{position:'fixed',inset:'0',zIndex:'10000',padding:'28px 20px',background:'var(--ds-canvas)',color:'var(--ds-ink)',overflow:'auto'});
 el.innerHTML=`<p style="font-size:11px;letter-spacing:.1em;color:var(--ds-muted)">AI-DCA / 统一界面规范</p><h1 style="font-size:26px;font-weight:700;margin:8px 0">清晰的操作，明确的状态</h1><p style="font-size:13px;color:var(--ds-muted);margin-bottom:24px">靛紫用于主要动作，浅色用于筛选，红色仅用于危险操作。</p><div class="ui-card" style="padding:20px;display:grid;gap:18px"><div><p style="font-size:12px;margin-bottom:8px">主要操作</p><button id="state-primary" class="ui-button ui-button--primary">保存更改</button></div><div><p style="font-size:12px;margin-bottom:8px">次要操作 / 轻量操作</p><button id="state-secondary" class="ui-button ui-button--secondary">取消</button> <button class="ui-button ui-button--subtle">查看详情</button></div><div><p style="font-size:12px;margin-bottom:8px">选中 / 未选中</p><button id="state-filter" class="ui-filter" aria-pressed="true">全部 24</button> <button class="ui-filter" aria-pressed="false">管理员 1</button></div><div><p style="font-size:12px;margin-bottom:8px">危险操作</p><button id="state-danger" class="ui-button ui-button--danger">撤销角色</button></div><div><p style="font-size:12px;margin-bottom:8px">禁用 / 处理中</p><button id="state-disabled" class="ui-button ui-button--primary" disabled>确认授予</button> <button class="ui-button ui-button--primary" disabled data-loading="true" aria-busy="true">正在保存…</button></div><div><p style="font-size:12px;margin-bottom:8px">键盘焦点</p><button id="state-focus" class="ui-button ui-button--secondary">继续查看</button></div></div><p style="font-size:11px;color:var(--ds-muted);margin-top:18px">设计预览 · 此页按钮不连接任何业务接口</p>`;
 document.body.append(el);
 });
 for(const id of ['primary','secondary','filter','danger','disabled']) stateChecks.push(await page.locator('#state-'+id).evaluate(e=>({id:e.id,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,opacity:getComputedStyle(e).opacity})));
 await page.locator('#state-primary').hover();stateChecks.push(await page.locator('#state-primary').evaluate(e=>({id:'primary-hover',color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor})));
 await page.locator('#state-danger').focus(); await page.keyboard.press('Tab'); if(!await page.locator('#state-focus').evaluate(e=>e.matches(':focus-visible')))throw new Error('Missing keyboard focus indicator'); await page.screenshot({path:`${out}/interaction-states-mobile.png`});
}
const luminance=c=>{const rgb=c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
for(const item of [active,...stateChecks.filter(s=>s.id!=='state-disabled')].filter(Boolean)){const a=luminance(item.color),b=luminance(item.background);item.contrast=+(Math.max(a,b)+.05).toFixed(8)/(Math.min(a,b)+.05);if(item.contrast<4.5)throw new Error('Contrast below AA: '+JSON.stringify(item));}
if(layoutChecks.some(c=>c.documentWidth>c.width))throw new Error('Horizontal viewport overflow');
writeFileSync(`${out}/observations.json`,JSON.stringify({active,errors,writes,blockedWriteRequests,layoutChecks,stateChecks},null,2));
console.log(JSON.stringify({active,errors,writes,blockedWriteRequests,layoutChecks,stateChecks}));
await browser.close();
