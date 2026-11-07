// Export the social preview (1280x640) and matching project icons.
import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium, WEBGL_ARGS } from '../dist/check/browser.js';
import { serveStatic } from '../dist/check/server.js';
const repo=resolve(import.meta.dirname,'..');
const server=await serveStatic(repo);
let browser;
try {
  const executablePath=findChromium();
  browser=await chromium.launch({headless:true,args:WEBGL_ARGS,...(executablePath?{executablePath}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:640},deviceScaleFactor:1});
  await page.goto(`${server.url}/scripts/og.html`,{waitUntil:'networkidle'});
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:join(repo,'docs','og.png')});
  await page.screenshot({path:join(repo,'docs','assets','social.jpg'),type:'jpeg',quality:90});
  await page.setViewportSize({width:400,height:400});
  await page.setContent(`<style>body{margin:0;background:transparent}img{width:400px;height:400px;display:block}</style><img src="${server.url}/docs/logo.svg" alt="">`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({path:join(repo,'docs','logo-400.png'),omitBackground:true});
  copyFileSync(join(repo,'docs','logo-400.png'),join(repo,'mcpb','icon.png'));
  copyFileSync(join(repo,'docs','logo-400.png'),join(repo,'plugins','threesmith','.claude-plugin','icon.png'));
  console.log('docs/og.png, docs/assets/social.jpg and project icons');
} finally {await browser?.close();await server.close();}
