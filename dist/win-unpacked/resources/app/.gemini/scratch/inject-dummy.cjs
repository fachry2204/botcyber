const fs = require('fs');

const ids = 'logs,successLogs,failedLogs,botForm,startBtn,stopBtn,clearDataBtn,statusBadge,tabLogs,tabSuccess,tabFailed,viewBot,viewFinder,viewMirror,menuBot,menuFinder,menuMirror,finderForm,btnFind,btnStopFind,btnDownload,finderLogs,goodProxyCount,finderStatus,menuTikTok,formYoutubeContainer,formTikTokContainer,mainTitle,trafficSource,directInputGroup,searchInputGroup,embedInputGroup,ttMode,ttLiveGroup,ttUploadGroup,ttPhonefarmGroup,ttUaGroup,ttPfDeviceId,adbStatusText,refreshAdbBtn,tabAll,tabActiveBots,allLogs,activeBotsLogs,statVideoTotal,statVideoSuccess,statVideoFailed,screenshotModal,closeScreenshotBtn,screenshotImg,screenshotTitle,screenshotLoading,btnScanMirror,mirrorGrid,checkSyncAll,searchMirror,zoomSliderMirror,statUaTotal,statUaDesktop,statUaMobile,sysUaTotalBar,sysUaDesktopBar,sysUaMobileBar,cpuVal,cpuBar,ramVal,ramBar,netRx,netTx,proxySource,proxyFile,ttProxySource,ttProxyFile,tabFinder,tabChecker,finderFormContainer,checkerFormContainer,checkerForm,checkProxyList,proxyType,findCountry,findCount,repeatBot,repeatBotOptions,checkWhoer,recoUrl,recoDuration,embedWebUrl,videoUrl,searchKeyword,searchVideoId,headlessMode,browserCount,watchDurationMin,watchDurationMax,userAgentMode,tabDelay,randomVideoUrl,tiktokForm,ttStartBtn,ttStopBtn,ttFilePath,ttPfFilePath,ttLiveUrl,ttLike,ttShare,ttTap,ttTapCount,ttSong,ttCaption,ttPfSong,ttPfCaption,ttUserAgentMode,ttAccountFile,ttHeadless,ttBrowserCount'.split(',');

const dummyHtml = '\n<!-- DUMMY ELEMENTS TO PREVENT JS CRASHES -->\n<div style="display:none;">\n' + ids.map(id => '<input type="text" id="' + id + '" />').join('\n') + '\n</div>\n';

['index.html', 'bot-tiktok.html', 'phonefarm.html', 'proxy-finder.html'].forEach(file => {
    let content = fs.readFileSync('public/' + file, 'utf8');
    
    // Also remove the old JS logic that shows/hides views via navigation
    content = content.replace(/menuBot\.addEventListener[\s\S]*?menuFinder\.addEventListener[^\}]+}\);/g, '');
    
    // Prevent adding multiple times
    if (!content.includes('DUMMY ELEMENTS TO PREVENT JS CRASHES')) {
        content = content.replace('</body>', dummyHtml + '</body>');
    }
    
    fs.writeFileSync('public/' + file, content);
});
console.log('Dummy elements injected successfully.');
