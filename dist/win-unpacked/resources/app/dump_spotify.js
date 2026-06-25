const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({headless: true});
    const page = await browser.newPage();
    await page.goto('https://accounts.spotify.com/en/login');
    await page.waitForSelector('#username');
    await page.fill('#username', 'test@example.com');
    await page.click('button[data-testid="login-button"]');
    await page.waitForTimeout(3000);
    const html = await page.content();
    const fs = require('fs');
    fs.writeFileSync('spotify_login_step2.html', html);
    await browser.close();
})();
