const fs = require('fs');

const pages = [
    { file: 'index.html', highlight: 'menuBot' },
    { file: 'bot-tiktok.html', highlight: 'menuTikTok' },
    { file: 'phonefarm.html', highlight: 'menuMirror' },
    { file: 'proxy-finder.html', highlight: 'menuFinder' }
];

pages.forEach(page => {
    let html = fs.readFileSync('public/' + page.file, 'utf8');
    
    // Reset all nav links to gray hover mode
    html = html.replace(/class="text-(cyan|pink|yellow|purple|blue|green)-400 font-bold border-b-2 border-\1-400 pb-1 transition"/g, 'class="text-gray-400 font-bold hover:text-$1-400 hover:border-b-2 hover:border-$1-400 pb-1 transition"');
    
    // Make the target active
    if (page.highlight === 'menuBot') {
        html = html.replace(/<a href="\/index\.html" id="menuBot"\s*class="[^"]+"/g, '<a href="/index.html" id="menuBot" class="text-cyan-400 font-bold border-b-2 border-cyan-400 pb-1 transition"');
    } else if (page.highlight === 'menuTikTok') {
        html = html.replace(/<a href="\/bot-tiktok\.html" id="menuTikTok"\s*class="[^"]+"/g, '<a href="/bot-tiktok.html" id="menuTikTok" class="text-white font-bold border-b-2 border-white pb-1 transition"');
    } else if (page.highlight === 'menuMirror') {
        html = html.replace(/<a href="\/phonefarm\.html" id="menuMirror"\s*class="[^"]+"/g, '<a href="/phonefarm.html" id="menuMirror" class="text-yellow-400 font-bold border-b-2 border-yellow-400 pb-1 transition"');
    } else if (page.highlight === 'menuFinder') {
        html = html.replace(/<a href="\/proxy-finder\.html" id="menuFinder"\s*class="[^"]+"/g, '<a href="/proxy-finder.html" id="menuFinder" class="text-purple-400 font-bold border-b-2 border-purple-400 pb-1 transition"');
    }
    
    fs.writeFileSync('public/' + page.file, html);
});
console.log('Nav highlights fixed.');
