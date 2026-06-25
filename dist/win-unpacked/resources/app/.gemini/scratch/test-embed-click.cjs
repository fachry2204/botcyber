const fs = require('fs');
const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    console.log('Navigating...');
    await page.goto('https://iniyaitu.blogspot.com/2017/08/video.html', { waitUntil: 'networkidle' }).catch(()=>console.log('goto timeout'));
    
    await page.waitForTimeout(5000);
    
    // Attempt to scroll to load lazy iframes
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(2000);

    const iframes = await page.locator('iframe').all();
    console.log('Iframes found:', iframes.length);
    
    for (let i = 0; i < iframes.length; i++) {
        const src = await iframes[i].getAttribute('src').catch(()=>null);
        console.log('iframe ' + i + ' src:', src);
        
        if (src && src.includes('youtube')) {
            console.log('Found youtube iframe!');
            const frame = iframes[i].contentFrame();
            
            try {
                const playBtn = frame.locator('.ytp-large-play-button, .ytp-play-button').first();
                await playBtn.waitFor({ state: 'attached', timeout: 5000 });
                console.log('Play button is attached!');
                
                if (await playBtn.isVisible()) {
                    console.log('Play button is VISIBLE! Clicking...');
                    await playBtn.click({ force: true });
                    console.log('Clicked!');
                } else {
                    console.log('Play button is NOT visible.');
                }
            } catch (e) {
                console.log('Error locating play btn:', e.message);
            }
        }
    }
    
    await page.screenshot({ path: '.gemini/scratch/embed-test.png' });
    console.log('Screenshot saved.');
    await browser.close();
})();
