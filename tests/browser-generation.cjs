const {chromium}=require('playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..');
const artifacts=require('node:path').join(root,'test-results');
fs.mkdirSync(artifacts,{recursive:true});
const forgeUrl=process.env.FORGE_URL || 'http://127.0.0.1:7865';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1600,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.stack));
 page.on('console',msg=>{if(msg.type()==='error' && !msg.text().includes('Wake Lock'))console.log('CONSOLE',msg.text().slice(0,400));});
 await page.goto(forgeUrl,{waitUntil:'domcontentloaded',timeout:120000});
 await page.waitForFunction(()=>!!window.forgeLayoutEditor,{timeout:120000});
 await page.getByRole('tab',{name:'txt2img',exact:true}).click();
 await page.waitForTimeout(2500);
 for(const [id,val] of [['txt2img_sampling','Euler'],['txt2img_scheduler','Simple']]){
  const inp=page.locator('#'+id+' input');
  if(await inp.inputValue()!==val){await inp.fill(val);await inp.press('Enter');}
 }
 await page.evaluate(()=>{for(const [id,value] of [['txt2img_steps',8],['txt2img_cfg_scale',1],['txt2img_distilled_cfg_scale',5],['txt2img_seed',12345678],['txt2img_batch_count',1],['txt2img_batch_size',1],['txt2img_neg_prompt','']]){const e=document.querySelector('#'+id+' textarea, #'+id+' input');if(e){e.value=String(value);updateInput(e);}}});
 await page.getByRole('tab',{name:'Forge Layout Editor',exact:true}).click();
 await page.evaluate(d=>window.forgeLayoutEditor.editor.importPrompt(JSON.stringify(d)),JSON.parse(fs.readFileSync(root+'/examples/layout-lab.json','utf8')));
 await page.locator('#forge-layout-loras').fill('');
 const started=Date.now();
 await page.locator('#forge-layout-editor').getByRole('button',{name:'Generate',exact:true}).click();
 await page.waitForFunction(()=>window.forgeLayoutEditor.editor.generating || document.querySelector('#forge-layout-editor .le-toast.le-show.le-bad'),{timeout:20000});
 console.log('Generation started.');
 await page.waitForFunction(()=>!window.forgeLayoutEditor.editor.generating,{timeout:900000});
 const result=await page.evaluate(()=>({status:window.forgeLayoutEditor.editor.genStatusText.textContent,results:window.forgeLayoutEditor.editor.results,toast:window.forgeLayoutEditor.editor.toastEl.textContent,metadata:document.querySelector('#generation_info_txt2img textarea')?.value,nativeError:document.querySelector('#html_info_txt2img')?.textContent}));
 result.elapsedSeconds=(Date.now()-started)/1000;result.errors=errors;
 fs.writeFileSync(artifacts+'/live-generation.json',JSON.stringify(result,null,2));
 console.log('Generation completed in',result.elapsedSeconds,'seconds. Artifacts stay in ignored test-results/.');
 await page.screenshot({path:artifacts+'/editor-result.png',fullPage:true});
 if(result.results.length){const response=await page.request.get(result.results[0].src);fs.writeFileSync(artifacts+'/layout-lab-result.jpg',await response.body());}
 assert.ok(result.results.length,'generation result must return to editor');
 assert.match(result.status,/Done/);
 const info=JSON.parse(result.metadata);assert.equal(info.width,768);assert.equal(info.height,512);assert.equal(info.steps,8);assert.equal(info.cfg_scale,1);assert.equal(info.seed,12345678);
 const submitted=JSON.parse(info.prompt);assert.equal(submitted.bbox_coord_space,'abs_centralized');assert.equal(submitted.items[2].text,'LAYOUT LAB');
 assert.equal(result.results.length,1,'single image must have a single thumbnail');
 assert.equal(info.extra_generation_params.Template,undefined,'Dynamic Prompts must not rewrite layout JSON');
 assert.deepEqual(submitted,await page.evaluate(()=>LayoutEditor.getFormat('moss').exportObject(window.forgeLayoutEditor.editor.model)));
 console.log('PASS layout survives Dynamic Prompts and matches model prompt exactly');
 assert.deepEqual(errors.filter(error=>error.includes('/'+require('node:path').basename(root)+'/javascript/')),[]);
 console.log('PASS native generation, returned image, metadata, seed and dimensions');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
