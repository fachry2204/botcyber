const fs = require('fs');
fs.writeFileSync('test-embed.html', '<html><body><iframe width="560" height="315" src="https://www.youtube.com/embed/KDdSfFsyDEA?si=iEq_VyDnZhyLA4vH" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></body></html>');
const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('file:///' + process.cwd().replace(/\\/g, '/') + '/test-embed.html');
    await page.waitForTimeout(3000);
    
    const iframes = await page.locator('iframe').all();
    for (let i = 0; i < iframes.length; i++) {
        const src = await iframes[i].getAttribute('src');
        if (src && src.includes('youtube')) {
            const frame = await iframes[i].contentFrame();
            console.log('Frame exists:', !!frame);
            if (frame) {
                const btn = frame.locator('.ytp-large-play-button');
                console.log('Button count:', await btn.count());
                if (await btn.count() > 0) {
                    console.log('Button isVisible:', await btn.first().isVisible());
                }
            }
        }
    }
    await browser.close();
})();
