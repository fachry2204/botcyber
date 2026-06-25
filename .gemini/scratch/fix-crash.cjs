const fs = require('fs');

const polyfill = `
        // POLYFILL TO PREVENT JS CRASHES ON MISSING ELEMENTS
        const origGetElementById = document.getElementById;
        document.getElementById = function(id) {
            let el = origGetElementById.call(document, id);
            if (!el) {
                el = document.createElement('div');
                el.value = '';
                el.checked = false;
            }
            return el;
        };
`;

['index.html', 'bot-tiktok.html', 'phonefarm.html', 'proxy-finder.html'].forEach(file => {
    let content = fs.readFileSync('public/' + file, 'utf8');
    
    // Remove the old dummy block
    content = content.replace(/<!-- DUMMY ELEMENTS TO PREVENT JS CRASHES -->[\s\S]*?<\/div>\n/, '');
    
    // If the polyfill is not already there, inject it right after <script>
    if (!content.includes('origGetElementById')) {
        content = content.replace(/<script>/, '<script>\n' + polyfill);
    }
    
    fs.writeFileSync('public/' + file, content);
});
console.log('Polyfill injected and dummy HTML removed.');
