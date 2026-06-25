const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'public', 'index.html');
let html = fs.readFileSync(src, 'utf8');

// Update Navigation Links
html = html.replace(/<a href="#" id="menuBot" class="[^"]*">Bot\s*YouTube<\/a>/, '<a href="/bot-youtube.html" id="menuBot" class="text-cyan-400 font-bold border-b-2 border-cyan-400 pb-1 transition">Bot YouTube</a>');
html = html.replace(/<a href="#" id="menuTikTok"\s*class="[^"]*">Bot\s*TikTok<\/a>/, '<a href="/bot-tiktok.html" id="menuTikTok" class="text-gray-400 font-bold pb-1 hover:text-white hover:border-b-2 hover:border-white transition">Bot TikTok</a>');
html = html.replace(/<a href="#" id="menuMirror"\s*class="[^"]*">📱\s*Phonefarm Mirror<\/a>/, '<a href="/phonefarm.html" id="menuMirror" class="text-gray-400 font-bold pb-1 hover:text-yellow-400 hover:border-b-2 hover:border-yellow-400 transition">📱 Phonefarm Mirror</a>');
html = html.replace(/<a href="#" id="menuFinder"\s*class="[^"]*">🔍\s*Pencari Proxy<\/a>/, '<a href="/proxy-finder.html" id="menuFinder" class="text-purple-400 font-bold pb-1 hover:text-purple-300 hover:border-b-2 hover:border-purple-300 transition">🔍 Pencari Proxy</a>');

// Function to set active menu
function setActiveMenu(htmlStr, activeId) {
    // Reset all to gray
    htmlStr = htmlStr.replace(/class="text-cyan-400 font-bold border-b-2 border-cyan-400 pb-1 transition"/g, 'class="text-gray-400 font-bold pb-1 hover:text-cyan-400 hover:border-b-2 hover:border-cyan-400 transition"');
    
    // Set specific to active (this is simple, we will just let CSS or inline style handle it, or just ignore for now)
    return htmlStr;
}

// We will just write the full HTML to 4 files, but show/hide the correct views using style="display:block" and remove the 'hidden' classes.
// Actually, it's better to remove the HTML code of other views so the file is lighter!
// But regexing HTML div blocks is hard.
// Let's use Cheerio since we installed it!

const cheerio = require('cheerio');

function generatePage(pageName) {
    const $ = cheerio.load(html, { decodeEntities: false });
    
    // Default hiding all
    $('#viewBot').remove();
    $('#viewMirror').remove();
    $('#viewFinder').remove();
    
    if (pageName === 'youtube' || pageName === 'tiktok') {
        // Re-parse from fresh for viewBot
        const $fresh = cheerio.load(html, { decodeEntities: false });
        $('#viewMirror', $fresh.root()).remove();
        $('#viewFinder', $fresh.root()).remove();
        
        $fresh('#viewBot').removeClass('hidden');
        
        if (pageName === 'youtube') {
            $fresh('#formTikTokContainer').remove();
            $fresh('#formYoutubeContainer').removeClass('hidden');
            $fresh('#mainTitle').text('Bot YouTube 🤖');
        } else {
            $fresh('#formYoutubeContainer').remove();
            $fresh('#formTikTokContainer').removeClass('hidden');
            $fresh('#mainTitle').text('Bot TikTok 🎵');
            // Hide youtube stats
            $fresh('#statSuccess').parent().parent().remove(); 
        }
        
        fs.writeFileSync(path.join(__dirname, '..', '..', 'public', `bot-${pageName}.html`), $fresh.html());
    } else if (pageName === 'phonefarm') {
        const $fresh = cheerio.load(html, { decodeEntities: false });
        $('#viewBot', $fresh.root()).remove();
        $('#viewFinder', $fresh.root()).remove();
        $fresh('#viewMirror').removeClass('hidden');
        fs.writeFileSync(path.join(__dirname, '..', '..', 'public', `phonefarm.html`), $fresh.html());
    } else if (pageName === 'proxy') {
        const $fresh = cheerio.load(html, { decodeEntities: false });
        $('#viewBot', $fresh.root()).remove();
        $('#viewMirror', $fresh.root()).remove();
        $fresh('#viewFinder').removeClass('hidden');
        $fresh('#viewFinder').addClass('grid');
        fs.writeFileSync(path.join(__dirname, '..', '..', 'public', `proxy-finder.html`), $fresh.html());
    }
}

generatePage('youtube');
generatePage('tiktok');
generatePage('phonefarm');
generatePage('proxy');

console.log("Pages generated successfully!");
